import { Connection, PublicKey } from "@solana/web3.js";
import { heliusEndpoint, RpcRefreshGovernor, resolveRpcRefreshBudget, type RpcRefreshBudget } from "@whale-sniper/core";
import { DexScreenerTokenMetadataProvider } from "./dexScreenerTokenMetadataProvider.js";
import { conservativeUnknownSeed, type ITokenMetadataProvider, type TokenMetadataSeed } from "./tokenMetadataProvider.js";

/**
 * ---------------------------------------------------------------------
 * HONESTY NOTE (matching the standard `HeliusFeedProvider` and
 * `SolscanTokenMetadataProvider` set for their own unverified judgment
 * calls): the three JSON-RPC methods this provider calls
 * (`getParsedAccountInfo` against an SPL-Token mint, `getTokenLargestAccounts`,
 * `getTokenSupply`) are standard, well-documented Solana RPC, and the
 * parsed SPL-Token mint layout (`mintAuthority`/`freezeAuthority`, null when
 * revoked) is part of the node's own `jsonParsed` encoding rather than
 * something this repo guesses at. But this build has no reachable Helius
 * endpoint to test against - the sandbox it was written in blocks outbound
 * connections to Helius entirely - so every behaviour below is verified
 * only against injected fakes (`SolanaRpcLike`), never a live response. The
 * parts most worth re-checking with a real key: that `getParsedAccountInfo`
 * on a pump.fun mint really returns `parsed.info` in the shape
 * `ParsedMintAccountInfo` describes (it should - that is the node's parser,
 * not Helius's), and that Helius's free tier tolerates this provider's
 * request rate (see `RpcRefreshBudget` for the throttle and its reasoning).
 * Mapping is defensive throughout: a shape mismatch or an RPC failure
 * degrades to the same `conservativeUnknownSeed()` fallback the other
 * adapters use, and never throws into the hot trade path.
 * ---------------------------------------------------------------------
 */

/**
 * Narrow surface of a Solana JSON-RPC client this provider needs - three
 * methods, plain-data returns, mint addresses as strings. Mirrors why
 * `HeliusFeedProvider` defines `ConnectionLike`: tests inject a fake instead
 * of opening a real connection, and the `@solana/web3.js`-specific types
 * (`PublicKey`, `RpcResponseAndContext`, the `ParsedAccountData | Buffer`
 * union) stay confined to `Web3SolanaRpcClient` below.
 */
export interface SolanaRpcLike {
  /** Parsed SPL-Token mint account, or undefined when the account does not
   * exist / is not a parseable token mint. */
  getParsedMintAccount(mint: string): Promise<ParsedMintAccountInfo | undefined>;
  /** Up to the 20 largest token accounts for the mint, `amount` in raw
   * (pre-decimal) base units as a decimal string. */
  getTokenLargestAccounts(mint: string): Promise<TokenAccountBalanceLike[]>;
  /** Total supply in the same raw base units, so decimals cancel out of the
   * concentration ratio entirely. */
  getTokenSupply(mint: string): Promise<TokenAmountLike | undefined>;
}

/** The fields of the node's `jsonParsed` SPL-Token mint `parsed.info` that
 * matter here. Both authorities are null exactly when revoked. */
export interface ParsedMintAccountInfo {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

export interface TokenAccountBalanceLike {
  address?: string;
  amount?: string;
}

export interface TokenAmountLike {
  amount?: string;
}

/** Concentration is defined over the top 10 holders, matching
 * `TokenStats.top10HolderPct` and `concentrationRiskComponent`, even though
 * `getTokenLargestAccounts` returns up to 20. */
const TOP_N_HOLDERS = 10;

// Same 20s TTL DexScreener's and Solscan's adapters use, for the same
// reason: a real sniper looks up the same fresh mint many times in a few
// seconds as trades roll in, and one refresh here costs three RPC calls.
const DEFAULT_CACHE_TTL_MS = 20_000;

/**
 * Rate-limit governor for background refreshes - lifted to
 * `@whale-sniper/core` and re-exported here, because `cluster-detect`'s
 * `SolanaRpcWalletRelationshipSource` hits the same Helius endpoint on the
 * same key and must spend the same quota rather than a second one of its
 * own. See `RpcRefreshGovernor` for the throttle's reasoning.
 *
 * The numbers still matter here: one refresh = 3 RPC calls (mint account +
 * largest accounts + supply), and a busy pump.fun feed touches far more
 * distinct mints than a 20s TTL alone can absorb - every previously-unseen
 * mint is a guaranteed cache miss. Batching the three calls into one
 * JSON-RPC batch request would cut round-trips but not credit consumption
 * (providers meter per method call), so it is deliberately not done here -
 * the throttle is the thing that protects the quota.
 */
export { DEFAULT_RPC_REFRESH_BUDGET, type RpcRefreshBudget } from "@whale-sniper/core";

/** The subset of `TokenMetadataSeed` that Solana RPC can actually answer.
 * Liquidity and market cap are absent by construction - pricing a pool
 * requires DEX state, which is exactly why this is a composite provider and
 * not a drop-in replacement for DexScreener. */
export interface RpcTokenFacts {
  holderCount: number;
  top10HolderPct: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}

function defaultRpcFactory(httpUrl: string): SolanaRpcLike {
  // No built-in 429 retry: these are background refreshes, and the shared
  // RpcRefreshGovernor's per-key cooldown is the retry policy. web3.js's own
  // retry would hold a governor slot through its backoff and log every 429.
  return new Web3SolanaRpcClient(new Connection(httpUrl, { commitment: "confirmed", disableRetryOnRateLimit: true }));
}

/** Thin `SolanaRpcLike` adapter over `@solana/web3.js`'s `Connection` -
 * the only place in this file that knows about web3.js types. */
export class Web3SolanaRpcClient implements SolanaRpcLike {
  constructor(private readonly connection: Connection) {}

  async getParsedMintAccount(mint: string): Promise<ParsedMintAccountInfo | undefined> {
    const res = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const data = res.value?.data;
    if (!data || data instanceof Buffer || !("parsed" in data)) return undefined;
    const parsed = data.parsed as { info?: unknown } | undefined;
    const info = parsed?.info as ParsedMintAccountInfo | undefined;
    return info ?? undefined;
  }

  async getTokenLargestAccounts(mint: string): Promise<TokenAccountBalanceLike[]> {
    const res = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
    return (res.value ?? []).map((a) => ({ address: a.address?.toBase58(), amount: a.amount }));
  }

  async getTokenSupply(mint: string): Promise<TokenAmountLike | undefined> {
    const res = await this.connection.getTokenSupply(new PublicKey(mint));
    return res.value ?? undefined;
  }
}

function parseRawAmount(amount: string | undefined): bigint | undefined {
  if (amount === undefined || amount === "") return undefined;
  if (!/^\d+$/.test(amount)) return undefined;
  return BigInt(amount);
}

/**
 * Top-10 concentration from raw base-unit balances. Uses bigint for the sum
 * because a 9-decimal mint with a 1e9 supply overflows double precision,
 * then converts only the final ratio to a number.
 */
export function top10ConcentrationFrom(
  largest: TokenAccountBalanceLike[],
  supplyRaw: string | undefined,
): number | undefined {
  const supply = parseRawAmount(supplyRaw);
  if (supply === undefined || supply === 0n) return undefined;

  const balances = largest
    .map((a) => parseRawAmount(a.amount))
    .filter((b): b is bigint => b !== undefined)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, TOP_N_HOLDERS);
  if (balances.length === 0) return undefined;

  const top = balances.reduce((acc, b) => acc + b, 0n);
  // Scale before dividing so integer division doesn't floor the ratio to 0.
  const scaled = Number((top * 1_000_000n) / supply) / 1_000_000;
  return Math.max(0, Math.min(1, scaled));
}

/**
 * Holder count is a *lower bound*, not the true total: `getTokenLargestAccounts`
 * returns at most 20 accounts, and there is no cheap standard-RPC way to
 * count every holder of a mint (that needs a full `getProgramAccounts` scan
 * or an indexer). Reporting the observed non-empty accounts is honest and
 * strictly better than the conservative `0`, and nothing scores on it -
 * `holderCount` is persisted and displayed only; concentration, which *is*
 * scored (`concentrationRiskComponent`), comes from the balances themselves
 * and is exact.
 */
function holderCountFrom(largest: TokenAccountBalanceLike[]): number {
  return largest.filter((a) => {
    const raw = parseRawAmount(a.amount);
    return raw !== undefined && raw > 0n;
  }).length;
}

interface RpcCacheEntry {
  facts: RpcTokenFacts;
  fetchedAt: number;
}

export interface CompositeTokenMetadataProviderOptions {
  /** Required - `wiring.ts` refuses to construct this provider at all when
   * HELIUS_API_KEY is unset, and the constructor refuses too (two-layer
   * fail-fast, same contract as `HeliusFeedProvider`). */
  apiKey: string;
  /** Use this RPC endpoint instead of Helius (SOLANA_RPC_URL). When set,
   * `apiKey` may be empty. */
  rpcUrl?: string;
  /** DI seam for tests: skips opening a real connection to Helius. Defaults
   * to a `Web3SolanaRpcClient` over Helius's standard RPC endpoint. */
  rpcFactory?: (httpUrl: string) => SolanaRpcLike;
  /** DI seam for tests: the DexScreener half of the merge. Defaults to a
   * real `DexScreenerTokenMetadataProvider` (reused wholesale - its
   * liquidity/market-cap fetching, cache, TTL and failure semantics are not
   * reimplemented here). */
  dexScreener?: ITokenMetadataProvider;
  cacheTtlMs?: number;
  refreshBudget?: Partial<RpcRefreshBudget>;
  /** Pass a governor shared with other Helius-backed providers (see
   * `buildOrchestrator`) so one operator rate limit is spent once across
   * all of them. Defaults to a private governor built from
   * `refreshBudget`. */
  refreshGovernor?: RpcRefreshGovernor;
  now?: () => number;
}

/**
 * The recommended real-data `ITokenMetadataProvider`: DexScreener for the
 * two fields only a DEX can answer, standard Solana RPC for the four it
 * cannot.
 *
 * Why composite rather than an RPC-only provider: Solana RPC has no concept
 * of pool pricing, so an RPC-only provider would report `liquidityUsd: 0`,
 * which maxes out `liquidityRiskComponent` *and* fails
 * `tokenThresholds.minLiquidityUsd` in `entryGate.ts` outright. DexScreener
 * alone has the mirror-image problem: it cannot supply holder concentration
 * or mint/freeze authority state, so `conservativeUnknownSeed()` pins
 * `concentrationRisk` and `authorityRisk` to their maxima and imposes a
 * ~35-point floor on every token's risk score - above which realistic
 * pump.fun tokens no longer fit under `maxTokenRiskScore`. Merging the two
 * sources field-by-field is the only combination that answers all six
 * fields, and it needs no paid API.
 *
 * Field ownership:
 * - `liquidityUsd`, `marketCapUsd` <- DexScreener
 * - `holderCount`, `top10HolderPct`, `mintAuthorityRevoked`,
 *   `freezeAuthorityRevoked` <- Solana RPC
 * - `creatorAddress`, `creatorTokenLaunchCount` <- left undefined. Standard
 *   RPC cannot cheaply answer either (deployer attribution needs a
 *   transaction-history scan back to the mint's first signature), and
 *   `creatorRiskComponent` treats undefined as neutral 0 by design, so
 *   omitting them costs nothing rather than fabricating risk.
 *
 * The two sources degrade strictly independently, because they are two
 * separate caches: DexScreener's own provider already serves last-known-good
 * or conservative liquidity on its own failures, and the RPC cache here does
 * the same for its four fields. An outage on one side never blanks the
 * other.
 *
 * Like the other real adapters, `get()` is synchronous and never blocks on
 * I/O: it returns cached-or-conservative immediately and kicks off a
 * throttled, de-duplicated background refresh (see `RpcRefreshBudget`).
 */
export class CompositeTokenMetadataProvider implements ITokenMetadataProvider {
  private readonly rpc: SolanaRpcLike;
  private readonly dexScreener: ITokenMetadataProvider;
  private readonly cacheTtlMs: number;
  private readonly governor: RpcRefreshGovernor;
  private readonly now: () => number;

  private readonly cache = new Map<string, RpcCacheEntry>();

  constructor(options: CompositeTokenMetadataProviderOptions) {
    if (!options.apiKey && !options.rpcUrl) {
      // Defense in depth - wiring.ts already refuses to construct this
      // without an endpoint, but the class itself must never silently
      // proceed unauthenticated if constructed some other way.
      throw new Error("CompositeTokenMetadataProvider requires a non-empty apiKey (HELIUS_API_KEY) or an rpcUrl (SOLANA_RPC_URL)");
    }
    const rpcFactory = options.rpcFactory ?? defaultRpcFactory;
    this.rpc = rpcFactory(options.rpcUrl ?? heliusEndpoint(options.apiKey).httpUrl);
    this.dexScreener = options.dexScreener ?? new DexScreenerTokenMetadataProvider();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.governor =
      options.refreshGovernor ?? new RpcRefreshGovernor(resolveRpcRefreshBudget(options.refreshBudget), this.now);
  }

  get(tokenMint: string): TokenMetadataSeed {
    const fallback = conservativeUnknownSeed();
    // Delegating rather than reading a shared cache is what makes the two
    // sources fail independently: each call re-asks DexScreener's provider,
    // which serves its own cached-or-conservative value and schedules its
    // own refresh, untouched by anything happening on the RPC side.
    const dex = this.dexScreener.get(tokenMint);
    const facts = this.rpcFacts(tokenMint);

    return {
      liquidityUsd: dex.liquidityUsd,
      marketCapUsd: dex.marketCapUsd,
      holderCount: facts?.holderCount ?? fallback.holderCount,
      top10HolderPct: facts?.top10HolderPct ?? fallback.top10HolderPct,
      mintAuthorityRevoked: facts?.mintAuthorityRevoked ?? fallback.mintAuthorityRevoked,
      freezeAuthorityRevoked: facts?.freezeAuthorityRevoked ?? fallback.freezeAuthorityRevoked,
    };
  }

  /** Exposed for callers (or tests) that want to await a first real fetch
   * instead of accepting the conservative fallback on a cold cache. Bypasses
   * the refresh throttle deliberately - it is an explicit, un-batched
   * request, not feed-driven background traffic. Not used by
   * `TokenStatsCollector`, which only ever calls `get()`. */
  async prefetch(tokenMint: string): Promise<void> {
    const dexPrefetch =
      this.dexScreener instanceof DexScreenerTokenMetadataProvider
        ? this.dexScreener.prefetch(tokenMint)
        : Promise.resolve();
    await Promise.all([dexPrefetch, this.refreshNow(tokenMint)]);
  }

  private rpcFacts(tokenMint: string): RpcTokenFacts | undefined {
    const cached = this.cache.get(tokenMint);
    const stale = !cached || this.now() - cached.fetchedAt > this.cacheTtlMs;
    if (stale) this.triggerRefresh(tokenMint);
    return cached?.facts;
  }

  private triggerRefresh(tokenMint: string): void {
    // The retry cooldown only guards mints with *no* cache entry - i.e. ones
    // whose refresh has never succeeded. A mint that has a (merely stale)
    // entry is already rate-limited by the TTL.
    this.governor.tryStart(tokenMint, () => this.refreshNow(tokenMint), { skipRetryCooldown: this.cache.has(tokenMint) });
  }

  private async refreshNow(tokenMint: string): Promise<void> {
    try {
      // All three in parallel: they are independent reads and the latency of
      // a refresh is three serial round-trips otherwise. Promise.all means
      // one failing method fails the whole refresh, which is intended - a
      // half-read seed (authorities known, concentration not) would silently
      // mix real and worst-case data into one score.
      const [mintAccount, largest, supply] = await Promise.all([
        this.rpc.getParsedMintAccount(tokenMint),
        this.rpc.getTokenLargestAccounts(tokenMint),
        this.rpc.getTokenSupply(tokenMint),
      ]);

      const concentration = top10ConcentrationFrom(largest ?? [], supply?.amount);
      if (mintAccount === undefined || concentration === undefined) {
        // Not a parseable mint, or no usable supply/balances - leave the
        // cache alone so get() keeps serving the conservative fallback
        // rather than caching a half-truth as if it were measured.
        return;
      }

      const fallback = conservativeUnknownSeed();
      this.cache.set(tokenMint, {
        facts: {
          holderCount: holderCountFrom(largest ?? []),
          top10HolderPct: concentration,
          // null authority = revoked, which is the *safe* end of
          // authorityRiskComponent. `undefined` (field absent from a
          // malformed response) is not the same claim as null, so it falls
          // back to the conservative "not revoked" reading instead.
          mintAuthorityRevoked:
            mintAccount.mintAuthority === null ? true : mintAccount.mintAuthority === undefined ? fallback.mintAuthorityRevoked : false,
          freezeAuthorityRevoked:
            mintAccount.freezeAuthority === null
              ? true
              : mintAccount.freezeAuthority === undefined
                ? fallback.freezeAuthorityRevoked
                : false,
        },
        fetchedAt: this.now(),
      });
    } catch {
      // Leave the existing cache entry (if any) in place - a transient RPC
      // failure shouldn't wipe the last known-good reading, and get()
      // already has a conservative fallback for the never-fetched case.
      // Crucially it also leaves DexScreener's liquidity/market-cap
      // untouched, since that lives in a different provider entirely.
    }
  }
}
