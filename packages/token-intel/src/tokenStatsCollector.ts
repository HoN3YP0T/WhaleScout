import type {
  Clock,
  EventBus,
  NormalizedTradeEvent,
  RuggedTokenRegistry,
  TokenFirstSeenIndex,
  TokenStats,
} from "@whale-sniper/core";
import type { ITokenRepository } from "@whale-sniper/db";
import type { ITokenMetadataProvider, TokenMetadataSeed } from "./tokenMetadataProvider.js";

interface WindowedTrade {
  blockTime: number;
  side: "BUY" | "SELL";
  usdValue: number;
  wallet: string;
}

interface TokenAccumulator {
  tokenMint: string;
  trades: WindowedTrade[]; // pruned to the last hour on every update
  peakLiquidityUsd: number;
  lastBlockTime: number;
  /** Latest liquidity reported on-chain by a trade on this token (see
   * NormalizedTradeEvent.poolLiquidityUsd), from the newest-blockTime trade. */
  observedLiquidityUsd?: number;
  observedLiquidityBlockTime?: number;
}

const ONE_HOUR = 3600;
const FIVE_MIN = 300;
// A liquidity crash of this magnitude relative to the peak observed flags
// the token as rugged for wallet-intel's rug-exposure counting.
const RUG_LIQUIDITY_DROP_RATIO = 0.5;
// Accumulators idle for longer than the stats window hold nothing but
// expired trades (the window is only pruned on that token's next trade), so
// they are evicted - see evictIdleTokens(). Checked once a minute of feed time.
const IDLE_SWEEP_INTERVAL_SECONDS = 60;

function newAccumulator(tokenMint: string): TokenAccumulator {
  return { tokenMint, trades: [], peakLiquidityUsd: 0, lastBlockTime: 0 };
}

/**
 * Derives rolling buy/sell volume and unique-buyer/seller counts directly
 * from the trade stream (no external dependency needed for those), and
 * combines them with mocked external metadata (liquidity, holders,
 * authorities) that the stream alone can't provide.
 */
export class TokenStatsCollector {
  private accumulators = new Map<string, TokenAccumulator>();
  private lastSweepBlockTime = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly bus: EventBus,
    private readonly repo: ITokenRepository,
    private readonly metadata: ITokenMetadataProvider,
    private readonly tokenFirstSeen: TokenFirstSeenIndex,
    private readonly ruggedRegistry: RuggedTokenRegistry,
    private readonly clock: Clock,
  ) {}

  start(): () => void {
    return this.bus.on("trade.normalized", (event) => {
      return this.handle(event);
    });
  }

  /** Stats "as of" the last trade actually observed for this token - using
   * that trade's own blockTime rather than the wall clock, so results stay
   * correct whether driven by a live feed or a backtest replay with
   * synthetic historical timestamps. */
  getStats(tokenMint: string): TokenStats | undefined {
    const acc = this.accumulators.get(tokenMint);
    if (!acc) return undefined;
    return this.buildStats(acc, acc.lastBlockTime);
  }

  /** Test/diagnostic helper: how many tokens currently have accumulators. */
  trackedTokenCount(): number {
    return this.accumulators.size;
  }

  /** Evicts tokens with no trade in the last hour. Their rolling stats are
   * all zero by then; the last persisted TokenStats stays in the repository,
   * and a rug flag stays in RuggedTokenRegistry. The cost of eviction is that
   * a token reviving after an hour of silence starts a fresh liquidity peak. */
  private evictIdleTokens(nowBlockTime: number): void {
    if (nowBlockTime - this.lastSweepBlockTime < IDLE_SWEEP_INTERVAL_SECONDS) return;
    this.lastSweepBlockTime = nowBlockTime;
    for (const [mint, acc] of this.accumulators) {
      if (acc.lastBlockTime < nowBlockTime - ONE_HOUR) this.accumulators.delete(mint);
    }
  }

  private async handle(event: NormalizedTradeEvent): Promise<void> {
    this.evictIdleTokens(event.blockTime);
    let acc = this.accumulators.get(event.tokenMint);
    if (!acc) {
      acc = newAccumulator(event.tokenMint);
      this.accumulators.set(event.tokenMint, acc);
    }

    acc.trades.push({ blockTime: event.blockTime, side: event.side, usdValue: event.usdValue, wallet: event.wallet });
    acc.trades = acc.trades.filter((t) => t.blockTime >= event.blockTime - ONE_HOUR);
    acc.lastBlockTime = Math.max(acc.lastBlockTime, event.blockTime);
    if (
      event.poolLiquidityUsd !== undefined &&
      Number.isFinite(event.poolLiquidityUsd) &&
      event.blockTime >= (acc.observedLiquidityBlockTime ?? Number.NEGATIVE_INFINITY)
    ) {
      acc.observedLiquidityUsd = event.poolLiquidityUsd;
      acc.observedLiquidityBlockTime = event.blockTime;
    }

    const liquidityUsd = this.liquidityOf(acc, this.metadata.get(event.tokenMint));
    acc.peakLiquidityUsd = Math.max(acc.peakLiquidityUsd, liquidityUsd);
    if (acc.peakLiquidityUsd > 0 && liquidityUsd / acc.peakLiquidityUsd < RUG_LIQUIDITY_DROP_RATIO) {
      this.ruggedRegistry.flag(event.tokenMint);
    }

    const stats = this.buildStats(acc, event.blockTime);
    await this.repo.upsertStats(stats);
    this.bus.emit("token.stats-updated", { tokenMint: event.tokenMint });
  }

  /** On-chain liquidity from the trade stream wins over the metadata
   * provider's: it is per-trade fresh, and for bonding-curve tokens the
   * provider (DexScreener) has none at all. */
  private liquidityOf(acc: TokenAccumulator, meta: TokenMetadataSeed): number {
    return acc.observedLiquidityUsd ?? meta.liquidityUsd;
  }

  private buildStats(acc: TokenAccumulator, asOfBlockTime: number): TokenStats {
    const meta = this.metadata.get(acc.tokenMint);
    const firstSeen = this.tokenFirstSeen.get(acc.tokenMint) ?? asOfBlockTime;

    const within = (seconds: number) => acc.trades.filter((t) => t.blockTime >= asOfBlockTime - seconds);
    const last1h = within(ONE_HOUR);
    const last5m = within(FIVE_MIN);

    const uniqueBuyers1h = new Set(last1h.filter((t) => t.side === "BUY").map((t) => t.wallet)).size;
    const uniqueSellers1h = new Set(last1h.filter((t) => t.side === "SELL").map((t) => t.wallet)).size;
    const buyVolumeUsd5m = last5m.filter((t) => t.side === "BUY").reduce((s, t) => s + t.usdValue, 0);
    const sellVolumeUsd5m = last5m.filter((t) => t.side === "SELL").reduce((s, t) => s + t.usdValue, 0);
    const buyVolumeUsd1h = last1h.filter((t) => t.side === "BUY").reduce((s, t) => s + t.usdValue, 0);
    const sellVolumeUsd1h = last1h.filter((t) => t.side === "SELL").reduce((s, t) => s + t.usdValue, 0);

    return {
      tokenMint: acc.tokenMint,
      createdAt: firstSeen,
      liquidityUsd: this.liquidityOf(acc, meta),
      marketCapUsd: meta.marketCapUsd,
      holderCount: meta.holderCount,
      top10HolderPct: meta.top10HolderPct,
      mintAuthorityRevoked: meta.mintAuthorityRevoked,
      freezeAuthorityRevoked: meta.freezeAuthorityRevoked,
      // Carried through so CreatorRegistryUpdater and creatorRiskComponent
      // (both of which read TokenStats, not the provider) can see them.
      creatorAddress: meta.creatorAddress,
      creatorTokenLaunchCount: meta.creatorTokenLaunchCount,
      uniqueBuyers1h,
      uniqueSellers1h,
      buyVolumeUsd5m,
      sellVolumeUsd5m,
      buyVolumeUsd1h,
      sellVolumeUsd1h,
      updatedAt: this.clock.now(),
    };
  }
}
