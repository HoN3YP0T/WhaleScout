import {
  EventBus,
  RuggedTokenRegistry,
  SimulatedClock,
  TokenFirstSeenIndex,
  type DexName,
  type NormalizedTradeEvent,
  type StrategyConfig,
  type TradeSide,
  type WalletScoreBreakdown,
  type WalletStats,
} from "@whale-sniper/core";
import { InMemoryWalletRepository } from "@whale-sniper/db";
import { WalletStatsUpdater, scoreWallet } from "@whale-sniper/wallet-intel";

/** A token in the scan universe, with its true launch time - not the time
 * this process first saw a trade, which is what live stats have to use. */
export interface HistoricalToken {
  mint: string;
  createdAtSec: number;
  creator?: string;
  graduated: boolean;
  athMarketCapUsd: number;
  /** True when only the newest part of the token's history was fetched. */
  truncated?: boolean;
}

export interface HistoricalTrade {
  txSignature: string;
  /** Stable intra-second ordering key (slot + index), compared as a string. */
  orderKey: string;
  timestampSec: number;
  wallet: string;
  tokenMint: string;
  side: TradeSide;
  tokenAmount: number;
  /** USD value at the time of the trade. */
  usdValue: number;
  priceUsd: number;
  venue: string;
}

export interface HistoricalScanOptions {
  config: StrategyConfig;
  /** A token counts as rugged from the first trade whose price is below
   * this fraction of its running peak - time-correct, so a wallet that sold
   * before the collapse is not charged with rug exposure. */
  rugPriceDropRatio?: number;
  /** Below this median hold, a wallet's edge is speed: the live feed sees a
   * trade ~1.5-2s after the block, so it cannot be followed. */
  minCopyableHoldSeconds?: number;
  /** A record built on a couple of tokens is one lucky (or rigged) trade. */
  minDistinctTokens?: number;
}

export interface WalletCandidate {
  wallet: string;
  stats: WalletStats;
  score: WalletScoreBreakdown;
  distinctTokens: number;
  roundTripTokens: number;
  medianHoldSeconds?: number;
  /** Tokens in the universe this wallet deployed itself. */
  createdTokens: number;
  copyable: boolean;
  copyabilityIssues: string[];
}

export interface HistoricalScanResult {
  tradesReplayed: number;
  walletsSeen: number;
  ruggedTokens: number;
  candidates: WalletCandidate[];
}

const DEFAULT_RUG_PRICE_DROP_RATIO = 0.25;
const DEFAULT_MIN_COPYABLE_HOLD_SECONDS = 30;
const DEFAULT_MIN_DISTINCT_TOKENS = 3;

function venueToDex(venue: string): DexName {
  // pump.fun's own AMM (post-graduation) has no DexName of its own; nothing
  // in wallet stats depends on the venue.
  return venue === "pump" ? "pumpfun" : "unknown";
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Scores every wallet in a set of historical trades with the SAME code the
 * live pipeline uses: trades are replayed in time order through
 * `WalletStatsUpdater` (a SimulatedClock, token ages from real launch
 * times) and each wallet is judged by `scoreWallet`'s unmodified hard gate.
 *
 * The result is only as complete as the token universe: a wallet's stats
 * cover its trades on these tokens, not its whole history.
 */
export function scanHistoricalWallets(
  tokens: HistoricalToken[],
  trades: HistoricalTrade[],
  options: HistoricalScanOptions,
): HistoricalScanResult {
  const rugRatio = options.rugPriceDropRatio ?? DEFAULT_RUG_PRICE_DROP_RATIO;
  const minHold = options.minCopyableHoldSeconds ?? DEFAULT_MIN_COPYABLE_HOLD_SECONDS;
  const minTokens = options.minDistinctTokens ?? DEFAULT_MIN_DISTINCT_TOKENS;

  const bus = new EventBus();
  const clock = new SimulatedClock(0);
  const firstSeen = new TokenFirstSeenIndex();
  const rugged = new RuggedTokenRegistry();
  const updater = new WalletStatsUpdater(bus, new InMemoryWalletRepository(), firstSeen, rugged, clock);
  updater.start();

  const creators = new Map<string, number>();
  for (const token of tokens) {
    firstSeen.record(token.mint, token.createdAtSec);
    if (token.creator) creators.set(token.creator, (creators.get(token.creator) ?? 0) + 1);
  }

  const sorted = [...trades].sort(
    (a, b) => a.timestampSec - b.timestampSec || (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0),
  );

  const peakPrice = new Map<string, number>();
  // wallet -> token -> first buy / last sell time, for hold durations.
  const holds = new Map<string, Map<string, { firstBuy?: number; lastSell?: number }>>();

  for (const t of sorted) {
    if (!(t.tokenAmount > 0) || !Number.isFinite(t.usdValue) || !Number.isFinite(t.priceUsd)) continue;
    clock.advanceTo(t.timestampSec * 1000);
    const event: NormalizedTradeEvent = {
      id: t.txSignature,
      wallet: t.wallet,
      tokenMint: t.tokenMint,
      side: t.side,
      tokenAmount: t.tokenAmount,
      usdValue: t.usdValue,
      priceUsd: t.priceUsd,
      dex: venueToDex(t.venue),
      pool: t.tokenMint,
      slot: 0,
      blockTime: t.timestampSec,
      txSignature: t.txSignature,
      timestamps: { rawReceivedAt: t.timestampSec * 1000 },
    };
    bus.emit("trade.normalized", event);

    // Rug flag after the trade, matching the live order (wallet stats see a
    // trade before token-intel can flag the collapse it causes).
    const peak = Math.max(peakPrice.get(t.tokenMint) ?? 0, t.priceUsd);
    peakPrice.set(t.tokenMint, peak);
    if (peak > 0 && t.priceUsd < peak * rugRatio) rugged.flag(t.tokenMint);

    let perToken = holds.get(t.wallet);
    if (!perToken) holds.set(t.wallet, (perToken = new Map()));
    const h = perToken.get(t.tokenMint) ?? {};
    if (t.side === "BUY") h.firstBuy ??= t.timestampSec;
    else if (h.firstBuy !== undefined) h.lastSell = t.timestampSec;
    perToken.set(t.tokenMint, h);
  }

  const candidates: WalletCandidate[] = [];
  for (const [wallet, perToken] of holds) {
    const stats = updater.getStats(wallet);
    if (!stats || stats.tradeCount === 0) continue;
    const holdDurations = [...perToken.values()]
      .filter((h) => h.firstBuy !== undefined && h.lastSell !== undefined)
      .map((h) => h.lastSell! - h.firstBuy!);
    const medianHoldSeconds = median(holdDurations);
    const createdTokens = creators.get(wallet) ?? 0;

    const copyabilityIssues: string[] = [];
    if (medianHoldSeconds !== undefined && medianHoldSeconds < minHold) {
      copyabilityIssues.push(`median hold ${medianHoldSeconds}s < ${minHold}s (too fast to follow)`);
    }
    if (perToken.size < minTokens) copyabilityIssues.push(`traded only ${perToken.size} token(s) < ${minTokens}`);
    if (createdTokens > 0) copyabilityIssues.push(`deployer of ${createdTokens} token(s) in the universe`);

    candidates.push({
      wallet,
      stats,
      score: scoreWallet(stats, options.config),
      distinctTokens: perToken.size,
      roundTripTokens: holdDurations.length,
      medianHoldSeconds,
      createdTokens,
      copyable: copyabilityIssues.length === 0,
      copyabilityIssues,
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.score.passedHardGate) - Number(a.score.passedHardGate) ||
      Number(b.copyable) - Number(a.copyable) ||
      b.score.whaleScore - a.score.whaleScore,
  );

  return { tradesReplayed: sorted.length, walletsSeen: holds.size, ruggedTokens: [...peakPrice.keys()].filter((m) => rugged.isRugged(m)).length, candidates };
}
