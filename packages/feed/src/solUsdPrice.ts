/** Where a feed gets SOL/USD to convert lamport amounts into USD. */
export interface SolUsdPriceSource {
  /** Latest price; never blocks. */
  current(): number;
  /** Called by the feed on connect/disconnect. */
  start?(): Promise<void>;
  stop?(): void;
}

export class StaticSolUsdPrice implements SolUsdPriceSource {
  constructor(private readonly price: number) {}
  current(): number {
    return this.price;
  }
}

/** Last-resort price when no live quote has ever been fetched. */
export const FALLBACK_SOL_USD_PRICE = 150;

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const DEXSCREENER_SOL_URL = `https://api.dexscreener.com/latest/dex/tokens/${WRAPPED_SOL_MINT}`;
const STABLE_QUOTES = new Set(["USDC", "USDT"]);
// Bounds outside which a quote is treated as garbage rather than a price.
const MIN_PLAUSIBLE_PRICE = 1;
const MAX_PLAUSIBLE_PRICE = 100_000;

interface DexScreenerSolPair {
  baseToken?: { address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** SOL/USD from the deepest SOL/USDC-or-USDT pool DexScreener lists, or
 * undefined when the response has no usable pair. */
export function solUsdFromDexScreener(raw: unknown): number | undefined {
  const pairs = ((raw as { pairs?: DexScreenerSolPair[] | null })?.pairs ?? []).filter(
    (p) => p.baseToken?.address === WRAPPED_SOL_MINT && STABLE_QUOTES.has(p.quoteToken?.symbol ?? ""),
  );
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const price = Number(pairs[0]?.priceUsd);
  return Number.isFinite(price) && price >= MIN_PLAUSIBLE_PRICE && price <= MAX_PLAUSIBLE_PRICE ? price : undefined;
}

export interface LiveSolUsdPriceOptions {
  refreshMs?: number;
  fallbackPrice?: number;
  fetchJson?: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`SOL price request failed: ${res.status}`);
  return res.json();
}

/**
 * Live SOL/USD, refreshed in the background from DexScreener (no key).
 * Every USD figure on the pump.fun feed - whale buy size, position size,
 * PnL - is lamports x this price, so a stale constant skews all of them by
 * however far SOL has moved. A failed refresh keeps the last good quote;
 * before the first success, `fallbackPrice` is used.
 */
export class LiveSolUsdPrice implements SolUsdPriceSource {
  private price: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly refreshMs: number;
  private readonly fallbackPrice: number;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  lastError: string | undefined;

  constructor(options: LiveSolUsdPriceOptions = {}) {
    this.refreshMs = options.refreshMs ?? 60_000;
    this.fallbackPrice = options.fallbackPrice ?? FALLBACK_SOL_USD_PRICE;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
  }

  current(): number {
    return this.price ?? this.fallbackPrice;
  }

  /** True once at least one live quote has been fetched. */
  isLive(): boolean {
    return this.price !== undefined;
  }

  /** Fetches a first quote (so the first trades aren't priced at the
   * fallback), then refreshes every `refreshMs`. Never throws. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      const price = solUsdFromDexScreener(await this.fetchJson(DEXSCREENER_SOL_URL));
      if (price === undefined) throw new Error("no usable SOL/USD pair in response");
      this.price = price;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
