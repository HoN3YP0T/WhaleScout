import { newId, type EventBus, type Position, type Signal, type StrategyConfig, type TokenStats } from "@whale-sniper/core";
import type { IPositionRepository } from "@whale-sniper/db";
import { simulateFill, type FillResult } from "./fillSimulator.js";

/** Builds a fresh Position from an already-executed entry fill. Shared by
 * openPaperPosition (which simulates the fill itself) and execution's
 * paperExecutionAdapter/executionPipeline (which already has a fill result
 * from IExecutionAdapter.submitOrder and must not re-simulate it). */
export function buildPositionFromFill(
  signal: Signal,
  triggeringWallet: string,
  triggeringTxSignature: string,
  tradeSizeUsd: number,
  fill: FillResult,
  config: StrategyConfig,
  /** Pipeline time (a SimulatedClock in backtests). Position-management
   * compares this against the same clock for max-hold, so it must not be
   * wall-clock when the pipeline isn't. */
  nowMs: number = Date.now(),
): Position {
  const entryPriceUsd = fill.filledPriceUsd;
  const tokenAmount = fill.tokenAmount;
  const stopLossPriceUsd = entryPriceUsd * (1 - config.position.initialStopLossPct / 100);

  return {
    positionId: newId("pos"),
    tokenMint: signal.tokenMint,
    signalId: signal.signalId,
    status: "OPEN",
    entryPriceUsd,
    entryUsdValue: tradeSizeUsd,
    tokenAmount,
    remainingTokenAmount: tokenAmount,
    currentPriceUsd: entryPriceUsd,
    highWaterMarkPriceUsd: entryPriceUsd,
    lowWaterMarkPriceUsd: entryPriceUsd,
    stopLossPriceUsd,
    trailingActive: false,
    takeProfitLevels: config.position.takeProfitLadder.map((l) => ({
      triggerPct: l.triggerPct,
      sellFraction: l.sellFraction,
      filled: false,
    })),
    whaleState: {
      wallet: triggeringWallet,
      entryTxSignature: triggeringTxSignature,
      cumulativeSoldFraction: 0,
      tier: "NONE",
      lastCheckedAt: nowMs,
    },
    realizedPnlUsd: -fill.feesUsd,
    unrealizedPnlUsd: 0,
    mfePct: 0,
    maePct: 0,
    feesUsd: fill.feesUsd,
    openedAt: nowMs,
  };
}

export function openPaperPosition(
  signal: Signal,
  triggeringWallet: string,
  triggeringTxSignature: string,
  tokenStats: TokenStats,
  tradeSizeUsd: number,
  quotePriceUsd: number,
  config: StrategyConfig,
): Position {
  const fill = simulateFill(
    { side: "BUY", usdValue: tradeSizeUsd, quotePriceUsd, liquidityUsd: tokenStats.liquidityUsd },
    config.execution,
  );
  return buildPositionFromFill(signal, triggeringWallet, triggeringTxSignature, tradeSizeUsd, fill, config);
}

export interface ExitResult {
  position: Position;
  soldTokenAmount: number;
  proceedsUsd: number;
  feesUsd: number;
}

/** Applies a (possibly partial) exit fill to a position in place, updating
 * realized/unrealized PnL, remaining size, and MFE/MAE. */
export function applyPaperExit(
  position: Position,
  currentQuotePriceUsd: number,
  sellFraction: number,
  liquidityUsd: number,
  config: StrategyConfig,
  exitReason: Position["exitReason"],
  nowMs: number = Date.now(),
): ExitResult {
  const sellTokenAmount = position.remainingTokenAmount * sellFraction;
  const grossUsdValue = sellTokenAmount * currentQuotePriceUsd;

  const fill = simulateFill({ side: "SELL", usdValue: grossUsdValue, quotePriceUsd: currentQuotePriceUsd, liquidityUsd }, config.execution);
  const proceedsUsd = fill.tokenAmount > 0 ? sellTokenAmount * fill.filledPriceUsd : 0;

  const costBasisPerToken = position.entryUsdValue / position.tokenAmount;
  const costBasisUsd = sellTokenAmount * costBasisPerToken;

  position.remainingTokenAmount -= sellTokenAmount;
  position.realizedPnlUsd += proceedsUsd - costBasisUsd - fill.feesUsd;
  position.feesUsd += fill.feesUsd;

  const fullyClosed = position.remainingTokenAmount <= position.tokenAmount * 1e-6;
  if (fullyClosed) {
    position.status = "CLOSED";
    position.closedAt = nowMs;
    position.exitReason = exitReason;
    position.remainingTokenAmount = 0;
    position.unrealizedPnlUsd = 0;
  }

  return { position, soldTokenAmount: sellTokenAmount, proceedsUsd, feesUsd: fill.feesUsd };
}

/** Marks price movement into a position without necessarily exiting -
 * updates high/low water marks and MFE/MAE, used on every price tick. */
export function markPositionPrice(position: Position, priceUsd: number): void {
  position.currentPriceUsd = priceUsd;
  position.highWaterMarkPriceUsd = Math.max(position.highWaterMarkPriceUsd, priceUsd);
  position.lowWaterMarkPriceUsd = Math.min(position.lowWaterMarkPriceUsd, priceUsd);

  const costBasisPerToken = position.entryUsdValue / position.tokenAmount;
  position.unrealizedPnlUsd = position.remainingTokenAmount * (priceUsd - costBasisPerToken);

  const roiPct = ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
  position.mfePct = Math.max(position.mfePct, roiPct);
  position.maePct = Math.min(position.maePct, roiPct);
}

/** Thin persistence + event-emitting wrapper around the pure functions
 * above, for callers (wiring, backtest replay) that want logging for free. */
export class PaperTradeEngine {
  constructor(
    private readonly bus: EventBus,
    private readonly repo: IPositionRepository,
  ) {}

  async open(
    signal: Signal,
    triggeringWallet: string,
    triggeringTxSignature: string,
    tokenStats: TokenStats,
    tradeSizeUsd: number,
    quotePriceUsd: number,
    config: StrategyConfig,
  ): Promise<Position> {
    const position = openPaperPosition(signal, triggeringWallet, triggeringTxSignature, tokenStats, tradeSizeUsd, quotePriceUsd, config);
    await this.repo.savePosition(position);
    this.bus.emit("position.opened", { positionId: position.positionId, tokenMint: position.tokenMint });
    return position;
  }

  async exit(
    position: Position,
    currentQuotePriceUsd: number,
    sellFraction: number,
    liquidityUsd: number,
    config: StrategyConfig,
    exitReason: Position["exitReason"],
  ): Promise<ExitResult> {
    const result = applyPaperExit(position, currentQuotePriceUsd, sellFraction, liquidityUsd, config, exitReason);
    await this.repo.savePosition(result.position);
    if (result.position.status === "CLOSED") {
      this.bus.emit("position.closed", { positionId: result.position.positionId, reason: exitReason ?? "MANUAL" });
    } else {
      this.bus.emit("position.updated", { positionId: result.position.positionId });
    }
    return result;
  }
}
