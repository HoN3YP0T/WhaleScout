import type { RuntimeFlags, StrategyConfig } from "@whale-sniper/core";
import type { IRiskStateRepository } from "@whale-sniper/db";

export interface RiskCheckInput {
  tradeSizeUsd: number;
  tokenMint: string;
  clusterId?: string;
  estimatedSlippagePct: number;
  estimatedTxCostUsd: number;
  openPositionsCount: number;
  totalExposureUsd: number;
  perTokenExposureUsd: number;
  perClusterExposureUsd: number;
}

export interface RiskVeto {
  vetoed: boolean;
  reason?: string;
}

/**
 * Independent of the signal score - can veto any trade on its own grounds.
 * Wired as a hard gate right before order build, and also fed into
 * entryGate as `riskEngineVeto` so a single EntryGateResult carries every
 * failure reason.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export class RiskEngine {
  /** Tail of queued recordTradeResult() calls - see there. */
  private resultQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repo: IRiskStateRepository,
    private readonly runtimeFlags: RuntimeFlags,
    /** Pipeline time, so cooldowns and the daily-loss window run on the
     * replay's SimulatedClock in backtests rather than wall-clock. */
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(input: RiskCheckInput, config: StrategyConfig): Promise<RiskVeto> {
    if (this.runtimeFlags.killed) return { vetoed: true, reason: "kill switch active" };
    if (this.runtimeFlags.paused) return { vetoed: true, reason: "trading paused" };

    const r = config.risk;
    const state = await this.repo.get();

    if (state.killSwitchActive) return { vetoed: true, reason: "risk engine kill switch active" };
    if (state.cooldownUntil && this.now() < state.cooldownUntil) {
      return { vetoed: true, reason: `cooldown active until ${new Date(state.cooldownUntil).toISOString()}` };
    }
    // The window has to roll over here too: the reset in applyTradeResult()
    // only runs after a trade, and once this limit trips there are none.
    const dailyLossUsd = this.now() - state.dailyLossResetAt > DAY_MS ? 0 : state.dailyLossUsd;
    if (dailyLossUsd >= r.maxDailyLossUsd) {
      return { vetoed: true, reason: `daily loss $${dailyLossUsd.toFixed(0)} >= max $${r.maxDailyLossUsd}` };
    }
    if (input.tradeSizeUsd > r.maxTradeSizeUsd) {
      return { vetoed: true, reason: `trade size $${input.tradeSizeUsd} > max $${r.maxTradeSizeUsd}` };
    }
    if (input.openPositionsCount >= r.maxOpenPositions) {
      return { vetoed: true, reason: `open positions ${input.openPositionsCount} >= max ${r.maxOpenPositions}` };
    }
    if (input.totalExposureUsd + input.tradeSizeUsd > r.maxTotalExposureUsd) {
      return { vetoed: true, reason: `total exposure would exceed max $${r.maxTotalExposureUsd}` };
    }
    if (input.perTokenExposureUsd + input.tradeSizeUsd > r.maxPerTokenExposureUsd) {
      return { vetoed: true, reason: `per-token exposure would exceed max $${r.maxPerTokenExposureUsd}` };
    }
    if (input.clusterId && input.perClusterExposureUsd + input.tradeSizeUsd > r.maxPerClusterExposureUsd) {
      return { vetoed: true, reason: `per-cluster exposure would exceed max $${r.maxPerClusterExposureUsd}` };
    }
    if (input.estimatedSlippagePct > r.maxSlippagePct) {
      return { vetoed: true, reason: `estimated slippage ${input.estimatedSlippagePct.toFixed(2)}% > max ${r.maxSlippagePct}%` };
    }
    if (input.estimatedTxCostUsd > r.maxTxCostUsd) {
      return { vetoed: true, reason: `estimated tx cost $${input.estimatedTxCostUsd.toFixed(2)} > max $${r.maxTxCostUsd}` };
    }

    return { vetoed: false };
  }

  /** Called after every closed trade to update the rolling risk state
   * (daily loss, consecutive losses, cooldown). */
  recordTradeResult(pnlUsd: number, config: StrategyConfig): Promise<void> {
    // Read-modify-write on shared state: two positions closing concurrently
    // would otherwise both read the same counters and one loss would be lost.
    const run = this.resultQueue.then(() => this.applyTradeResult(pnlUsd, config));
    this.resultQueue = run.catch(() => undefined);
    return run;
  }

  private async applyTradeResult(pnlUsd: number, config: StrategyConfig): Promise<void> {
    const state = await this.repo.get();
    const now = this.now();

    const resetDaily = now - state.dailyLossResetAt > DAY_MS;
    const dailyLossUsd = (resetDaily ? 0 : state.dailyLossUsd) + Math.max(0, -pnlUsd);
    let consecutiveLosses = pnlUsd < 0 ? state.consecutiveLosses + 1 : 0;
    let cooldownUntil = pnlUsd < 0 ? now + config.risk.cooldownSecondsAfterLoss * 1000 : state.cooldownUntil;
    if (consecutiveLosses >= config.risk.maxConsecutiveLosses) {
      // Circuit breaker: pause, then start counting afresh. Leaving the
      // streak at the max would veto every trade, and only a winning trade
      // could ever clear it.
      cooldownUntil = Math.max(cooldownUntil ?? 0, now + (config.risk.consecutiveLossPauseSeconds ?? 3600) * 1000);
      consecutiveLosses = 0;
    }

    await this.repo.update({
      dailyLossUsd,
      dailyLossResetAt: resetDaily ? now : state.dailyLossResetAt,
      consecutiveLosses,
      cooldownUntil,
    });
  }

  async killSwitch(active: boolean): Promise<void> {
    await this.repo.update({ killSwitchActive: active });
  }
}
