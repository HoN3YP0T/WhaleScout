import type { EventBus, NormalizedTradeEvent, Position, StrategyConfig } from "@whale-sniper/core";
import type { PositionManager } from "@whale-sniper/position-mgmt";
import { evaluateWhaleExitTier, type IndependentFlags, type WhaleExitTier } from "./whaleExitTier.js";

interface TrackedWhale {
  position: Position;
  wallet: string;
  tokenMint: string;
  entryTokenAmount: number;
  cumulativeSoldTokenAmount: number;
  sellTxCount: number;
  /** Highest tier already acted on. Each tier's exit runs once: without
   * this, every further whale sell while still in REDUCE would sell
   * reduceSellFraction of what's left again. */
  actedTier: WhaleExitTier;
}

const TIER_RANK: Record<WhaleExitTier, number> = { NONE: 0, WARN: 1, REDUCE: 2, EMERGENCY: 3 };

const NO_FLAGS: IndependentFlags = {
  multipleExits: false,
  coordinatedClusterSelling: false,
  liquidityDeteriorating: false,
  volumeReversal: false,
};

/** Watches the triggering whale of every open position for post-entry
 * selling and drives the tiered WARN/REDUCE/EMERGENCY response. Independent
 * red flags (cluster co-selling, liquidity deterioration, volume reversal)
 * are supplied by an injected callback so this package stays decoupled
 * from cluster-detect/token-intel while still reacting to their findings
 * when wiring supplies one. */
export class WhaleExitMonitor {
  private tracked = new Map<string, TrackedWhale>(); // keyed by positionId

  constructor(
    private readonly bus: EventBus,
    private readonly positionManager: PositionManager,
    private readonly config: StrategyConfig,
    private readonly getIndependentFlags: (positionId: string) => IndependentFlags = () => NO_FLAGS,
    private readonly getLiquidityUsd: (tokenMint: string) => number = () => 20000,
  ) {}

  start(): () => void {
    return this.bus.on("trade.normalized", (event) => {
      return this.handle(event);
    });
  }

  /** Call once a position is opened, using the *triggering* trade's own
   * token amount as the whale's baseline holding to measure sell-off
   * against - deliberately independent of our own (much smaller) position
   * size. */
  track(position: Position, triggeringTradeTokenAmount: number): void {
    this.tracked.set(position.positionId, {
      position,
      wallet: position.whaleState.wallet,
      tokenMint: position.tokenMint,
      entryTokenAmount: triggeringTradeTokenAmount,
      cumulativeSoldTokenAmount: 0,
      sellTxCount: 0,
      actedTier: "NONE",
    });
  }

  untrack(positionId: string): void {
    this.tracked.delete(positionId);
  }

  private async handle(event: NormalizedTradeEvent): Promise<void> {
    if (event.side !== "SELL") return;

    for (const state of this.tracked.values()) {
      if (state.wallet !== event.wallet || state.tokenMint !== event.tokenMint) continue;
      if (state.position.status === "CLOSED") {
        this.tracked.delete(state.position.positionId);
        continue;
      }

      state.cumulativeSoldTokenAmount += event.tokenAmount;
      state.sellTxCount += 1;
      const cumulativeSoldFraction = state.entryTokenAmount > 0 ? Math.min(1, state.cumulativeSoldTokenAmount / state.entryTokenAmount) : 0;

      const flags = this.getIndependentFlags(state.position.positionId);
      const withMultiExit: IndependentFlags = { ...flags, multipleExits: flags.multipleExits || state.sellTxCount >= 3 };

      const { tier, reasons } = evaluateWhaleExitTier({ cumulativeSoldFraction, flags: withMultiExit }, this.config.whaleExit);

      state.position.whaleState.cumulativeSoldFraction = cumulativeSoldFraction;
      state.position.whaleState.tier = tier;
      state.position.whaleState.lastCheckedAt = Date.now();

      if (TIER_RANK[tier] <= TIER_RANK[state.actedTier]) continue;
      state.actedTier = tier;

      this.bus.emit("whale.exit-detected", { wallet: event.wallet, tokenMint: event.tokenMint, pctSold: cumulativeSoldFraction });

      const liquidityUsd = this.getLiquidityUsd(state.tokenMint);
      if (tier === "REDUCE") {
        await this.positionManager.forceExit(state.position, event.priceUsd, this.config.whaleExit.reduceSellFraction, liquidityUsd, "WHALE_EXIT_EMERGENCY");
      } else if (tier === "EMERGENCY") {
        await this.positionManager.forceExit(state.position, event.priceUsd, 1, liquidityUsd, "WHALE_EXIT_EMERGENCY");
      }
      // WARN reasons are surfaced via the whale.exit-detected event above;
      // telegram-bot notifies on it without any position action.
      void reasons;
    }
  }
}
