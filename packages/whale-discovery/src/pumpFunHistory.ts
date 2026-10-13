import type { HistoricalToken, HistoricalTrade } from "./historicalScan.js";

/**
 * Reads pump.fun's public (unauthenticated, undocumented) web APIs - the
 * ones its own site uses - for the historical whale scan:
 *
 * - `frontend-api-v3.pump.fun/coins` lists tokens (launch time, creator,
 *   all-time-high market cap, graduation). Offset paging stops at roughly
 *   the 1,000 most recent results per sort order.
 * - `swap-api.pump.fun/v2/coins/:mint/trades` returns a token's trades
 *   newest first, 100 per page, with the trader, USD value at the time, and
 *   venue (`pump` bonding curve or `pump_amm` after graduation).
 *
 * Shapes were checked against live responses (2026-10). Being undocumented,
 * they can change without notice; every field is parsed defensively and a
 * malformed row is skipped rather than guessed at.
 */

const COINS_URL = "https://frontend-api-v3.pump.fun/coins";
const TRADES_URL = "https://swap-api.pump.fun/v2/coins";
const COINS_PAGE_SIZE = 50;
const TRADES_PAGE_SIZE = 100;
/** The coins endpoint stops returning results past this offset. */
const MAX_COINS_OFFSET = 1_000;

export type FetchJson = (url: string) => Promise<unknown>;

/** Per-host wait-until times learned from x-ratelimit-* headers. The two
 * hosts budget very differently (coins: 60/min, trades: 1,000/window), so
 * the client spends each budget to zero and then waits for that host's
 * reset instead of pacing everything to the slower one. */
const blockedUntil = new Map<string, number>();
/** Optional hook so a CLI can show why it is waiting. */
let onRateLimited: ((host: string, waitMs: number) => void) | undefined;
export function setRateLimitListener(listener: ((host: string, waitMs: number) => void) | undefined): void {
  onRateLimited = listener;
}
const lastRequestAt = new Map<string, number>();
const MAX_WAIT_MS = 65_000;
/** Minimum spacing per host, measured (2026-10). Both APIs advertise far
 * more than they serve: the coins API claims 60/min, the trades API ~1,000
 * per window (its x-ratelimit-remaining is per backend node), but each
 * enforces roughly 20 requests per minute per client in front of that,
 * answering bursts with 429s. One request every ~3s ran clean (40/40). */
const MIN_INTERVAL_MS: Record<string, number> = {
  "frontend-api-v3.pump.fun": 3_100,
  "swap-api.pump.fun": 3_100,
};

function resetWaitMs(res: Response, attempt = 0): number {
  const seconds = Number(res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset"));
  const hinted = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  // Never less than an escalating floor: a 429 can arrive without headers.
  return Math.min(MAX_WAIT_MS, Math.max(hinted, 5_000 * 2 ** attempt));
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt += 1) {
    const spacing = (lastRequestAt.get(host) ?? 0) + (MIN_INTERVAL_MS[host] ?? 0) - Date.now();
    const wait = Math.max(spacing, (blockedUntil.get(host) ?? 0) - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt.set(host, Date.now());

    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (res.headers.get("x-ratelimit-remaining") === "0") blockedUntil.set(host, Date.now() + resetWaitMs(res));
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < 5) {
      const backoff = resetWaitMs(res, attempt);
      onRateLimited?.(host, backoff);
      blockedUntil.set(host, Date.now() + backoff);
      continue;
    }
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`${res.status} from ${host}${new URL(url).pathname}`);
  }
}

interface RawCoin {
  mint?: string;
  created_timestamp?: number;
  creator?: string;
  complete?: boolean;
  ath_market_cap?: number;
  usd_market_cap?: number;
}

interface RawTrade {
  slotIndexId?: string;
  tx?: string;
  timestamp?: string;
  userAddress?: string;
  type?: string;
  program?: string;
  amountUsd?: string;
  baseAmount?: string;
  priceUsd?: string;
  fillPriceUsd?: string;
}

export function parseCoin(raw: RawCoin): HistoricalToken | undefined {
  if (!raw.mint || typeof raw.created_timestamp !== "number") return undefined;
  return {
    mint: raw.mint,
    createdAtSec: Math.floor(raw.created_timestamp / 1000),
    creator: raw.creator,
    graduated: raw.complete === true,
    athMarketCapUsd: Math.max(raw.ath_market_cap ?? 0, raw.usd_market_cap ?? 0),
  };
}

export function parseTrade(raw: RawTrade, tokenMint: string): HistoricalTrade | undefined {
  const side = raw.type === "buy" ? "BUY" : raw.type === "sell" ? "SELL" : undefined;
  const timestampMs = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  const tokenAmount = Number(raw.baseAmount);
  const usdValue = Number(raw.amountUsd);
  const priceUsd = Number(raw.fillPriceUsd ?? raw.priceUsd);
  if (!side || !raw.tx || !raw.userAddress || !Number.isFinite(timestampMs)) return undefined;
  if (!(tokenAmount > 0) || !Number.isFinite(usdValue) || !(priceUsd > 0)) return undefined;
  return {
    txSignature: raw.tx,
    orderKey: raw.slotIndexId ?? "",
    timestampSec: Math.floor(timestampMs / 1000),
    wallet: raw.userAddress,
    tokenMint,
    side,
    tokenAmount,
    usdValue,
    priceUsd,
    venue: raw.program ?? "unknown",
  };
}

/** pump.fun mints a fixed 1B-token supply; the trades API reports UI amounts. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

/**
 * Token metadata derived from its trade history alone, for when the token
 * universe comes from somewhere other than the coins API (e.g. the live
 * feed). With the full history, the first trade is the deployer's buy in
 * the creation transaction, so it gives the launch time and creator. With a
 * truncated history neither is known: launch time is then set to 0, so no
 * buy on that token can count as an early entry - the conservative reading.
 */
export function tokenFromTrades(mint: string, trades: HistoricalTrade[], truncated: boolean): HistoricalToken {
  const first = trades[0];
  const peakPrice = trades.reduce((m, t) => Math.max(m, t.priceUsd), 0);
  return {
    mint,
    createdAtSec: !truncated && first ? first.timestampSec : 0,
    creator: !truncated && first?.side === "BUY" ? first.wallet : undefined,
    graduated: trades.some((t) => t.venue === "pump_amm"),
    athMarketCapUsd: peakPrice * PUMP_TOTAL_SUPPLY,
    truncated,
  };
}

export interface UniverseOptions {
  /** Tokens launched recently (newest ~1,000 launches at most). */
  recentLaunches: boolean;
  /** Tokens with the most recent trades, whatever their age. */
  recentlyTraded: boolean;
  /** Skip tokens that never got traction - most launches never trade. */
  minAthMarketCapUsd: number;
  maxTokens: number;
}

export class PumpFunHistoryClient {
  constructor(private readonly fetchJson: FetchJson = defaultFetchJson) {}

  /** Pages through one sort order. A failure after some pages have
   * arrived returns what was collected: a throttled coins API (it throttles
   * hard after bursts) should shrink the universe, not abort the scan. */
  private async listCoins(sort: string): Promise<HistoricalToken[]> {
    const out: HistoricalToken[] = [];
    for (let offset = 0; offset < MAX_COINS_OFFSET; offset += COINS_PAGE_SIZE) {
      let page: unknown;
      try {
        page = await this.fetchJson(`${COINS_URL}?offset=${offset}&limit=${COINS_PAGE_SIZE}&sort=${sort}&order=DESC&includeNsfw=true`);
      } catch (err) {
        if (out.length === 0) throw err;
        break;
      }
      if (!Array.isArray(page) || page.length === 0) break;
      for (const raw of page as RawCoin[]) {
        const coin = parseCoin(raw);
        if (coin) out.push(coin);
      }
    }
    return out;
  }

  /** Deduplicated universe, highest all-time-high market cap first. Neither
   * source selects on outcome (rugs are included), so wallet records built
   * from it are not inflated by sampling only winners. */
  async fetchUniverse(options: UniverseOptions): Promise<HistoricalToken[]> {
    const byMint = new Map<string, HistoricalToken>();
    const sources = [
      ...(options.recentLaunches ? ["created_timestamp"] : []),
      ...(options.recentlyTraded ? ["last_trade_timestamp"] : []),
    ];
    let lastError: unknown;
    for (const sort of sources) {
      try {
        for (const coin of await this.listCoins(sort)) {
          if (coin.athMarketCapUsd >= options.minAthMarketCapUsd) byMint.set(coin.mint, coin);
        }
      } catch (err) {
        lastError = err; // one sort order failing still leaves the other
      }
    }
    if (byMint.size === 0 && lastError !== undefined) throw lastError;
    return [...byMint.values()].sort((a, b) => b.athMarketCapUsd - a.athMarketCapUsd).slice(0, options.maxTokens);
  }

  /** A token's trades, oldest first. Paging runs newest-to-oldest, so a
   * token with more than `maxPages` pages is truncated to its most recent
   * trades (its launch is missing) - reported via `truncated`. */
  async fetchTrades(tokenMint: string, maxPages: number): Promise<{ trades: HistoricalTrade[]; truncated: boolean }> {
    const trades: HistoricalTrade[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const url = `${TRADES_URL}/${tokenMint}/trades?limit=${TRADES_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = (await this.fetchJson(url)) as { trades?: RawTrade[]; pagination?: { nextCursor?: string; hasMore?: boolean } };
      for (const raw of body.trades ?? []) {
        const trade = parseTrade(raw, tokenMint);
        if (trade) trades.push(trade);
      }
      if (!body.pagination?.hasMore || !body.pagination.nextCursor) return { trades: trades.reverse(), truncated: false };
      cursor = body.pagination.nextCursor;
    }
    return { trades: trades.reverse(), truncated: true };
  }
}
