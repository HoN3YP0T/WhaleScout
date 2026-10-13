import {
  computeStageLatencies,
  type EventBus,
  type EventTimestamps,
  type NormalizedTradeEvent,
  type Position,
  type Signal,
  type StrategyConfig,
  type TokenRiskScore,
  type TokenStats,
  type WalletCluster,
  type WalletScoreBreakdown,
} from "@whale-sniper/core";
import type { IPositionRepository } from "@whale-sniper/db";
import { buildPositionFromFill, estimateSlippagePct } from "@whale-sniper/paper-trading";
import { evaluateEntryGate } from "@whale-sniper/signal-engine";
import type { IExecutionAdapter, OrderResult } from "./IExecutionAdapter.js";
import type { RiskEngine } from "./riskEngine.js";

export interface EntryExecutionInput {
  tradeEvent: NormalizedTradeEvent;
  walletScore: WalletScoreBreakdown;
  tokenRisk: TokenRiskScore;
  tokenStats: TokenStats;
  signal: Signal;
  cluster?: WalletCluster;
  openPositionsCount: number;
  totalExposureUsd: number;
  perTokenExposureUsd: number;
  perClusterExposureUsd: number;
}

export interface EntryExecutionResult {
  passed: boolean;
  reasons: string[];
  position?: Position;
  timestamps: EventTimestamps;
  latencyMs: Record<string, number>;
  /** True when the entry passed every gate and an order was submitted but
   * did not fill (adapter error or failed result) - as opposed to a gate /
   * risk-veto rejection, which never reaches submission. */
  orderFailed?: boolean;
}

/**
 * The hot path from "risk-check" through "confirm": builds and submits the
 * order, applies the entry gate (which folds in the risk engine's veto),
 * and on success turns the fill into a Position. Deliberately does not
 * touch the database itself beyond persisting the resulting position -
 * all the DB-heavy intelligence gathering (wallet/token/cluster scoring)
 * has already happened upstream, by the time this runs.
 */
export class ExecutionPipeline {
  constructor(
    private readonly adapter: IExecutionAdapter,
    private readonly riskEngine: RiskEngine,
    private readonly positionRepo: IPositionRepository,
    private readonly bus: EventBus,
    private readonly config: StrategyConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async executeEntry(input: EntryExecutionInput): Promise<EntryExecutionResult> {
    const timestamps: EventTimestamps = { ...input.tradeEvent.timestamps };
    const tradeSizeUsd = Math.min(this.config.risk.maxTradeSizeUsd, input.tokenStats.liquidityUsd * 0.05);
    const estimatedSlippagePct = estimateSlippagePct(tradeSizeUsd, input.tokenStats.liquidityUsd, this.config.execution);

    const riskVeto = await this.riskEngine.evaluate(
      {
        tradeSizeUsd,
        tokenMint: input.tradeEvent.tokenMint,
        clusterId: input.cluster?.clusterId,
        estimatedSlippagePct,
        estimatedTxCostUsd: this.config.execution.mockGasUsd,
        openPositionsCount: input.openPositionsCount,
        totalExposureUsd: input.totalExposureUsd,
        perTokenExposureUsd: input.perTokenExposureUsd,
        perClusterExposureUsd: input.perClusterExposureUsd,
      },
      this.config,
    );
    timestamps.riskCheckedAt = this.now();

    const gateResult = evaluateEntryGate(
      {
        walletScore: input.walletScore,
        tokenRisk: input.tokenRisk,
        tokenStats: input.tokenStats,
        signal: input.signal,
        cluster: input.cluster,
        estimatedSlippagePct,
        riskEngineVeto: riskVeto,
        dex: input.tradeEvent.dex,
        tokenAgeSeconds: Math.max(0, input.tradeEvent.blockTime - input.tokenStats.createdAt),
      },
      this.config,
    );

    if (!gateResult.passed) {
      this.bus.emit("signal.rejected", { tokenMint: input.tradeEvent.tokenMint, reason: gateResult.reasons.join("; ") });
      return { passed: false, reasons: gateResult.reasons, timestamps, latencyMs: computeStageLatencies(timestamps) };
    }

    timestamps.orderBuiltAt = this.now();
    let orderResult: OrderResult;
    try {
      orderResult = await this.adapter.submitOrder({
        tokenMint: input.tradeEvent.tokenMint,
        side: "BUY",
        usdValue: tradeSizeUsd,
        quotePriceUsd: input.tradeEvent.priceUsd,
        liquidityUsd: input.tokenStats.liquidityUsd,
      });
    } catch (err) {
      // A live adapter's RPC/signing failure must surface as a failed order,
      // not as an exception that unwinds the whole pipeline.
      const reason = `order submission threw: ${err instanceof Error ? err.message : String(err)}`;
      this.bus.emit("signal.rejected", { tokenMint: input.tradeEvent.tokenMint, reason });
      return { passed: false, reasons: [reason], timestamps, latencyMs: computeStageLatencies(timestamps), orderFailed: true };
    }
    timestamps.filledAt = orderResult.submittedAt;
    timestamps.confirmedAt = orderResult.confirmedAt;

    if (!orderResult.success) {
      const reason = orderResult.error ?? "order execution failed";
      this.bus.emit("signal.rejected", { tokenMint: input.tradeEvent.tokenMint, reason });
      return { passed: false, reasons: [reason], timestamps, latencyMs: computeStageLatencies(timestamps), orderFailed: true };
    }

    const position = buildPositionFromFill(
      input.signal,
      input.tradeEvent.wallet,
      input.tradeEvent.txSignature,
      tradeSizeUsd,
      {
        filledPriceUsd: orderResult.filledPriceUsd,
        slippagePct: orderResult.slippagePct,
        feesUsd: orderResult.feesUsd,
        filledUsdValue: tradeSizeUsd,
        tokenAmount: orderResult.tokenAmount,
      },
      this.config,
      this.now(),
    );

    await this.positionRepo.savePosition(position);
    this.bus.emit("position.opened", { positionId: position.positionId, tokenMint: position.tokenMint });

    return { passed: true, reasons: [], position, timestamps, latencyMs: computeStageLatencies(timestamps) };
  }
}
