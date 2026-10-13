import { Connection, PublicKey } from "@solana/web3.js";
import {
  heliusEndpoint,
  RpcRefreshGovernor,
  resolveRpcRefreshBudget,
  type ClusterEdge,
  type RpcRefreshBudget,
} from "@whale-sniper/core";
import type { WalletRelationshipSource } from "./walletRelationshipSource.js";

/**
 * ---------------------------------------------------------------------
 * HONESTY NOTE (same standard `HeliusFeedProvider` and
 * `solanaRpcTokenMetadataProvider.ts` set for their own unverified judgment
 * calls): this build cannot reach Helius at all - the sandbox it was
 * written in blocks outbound connections to it - so every behaviour here is
 * verified against injected `SolanaHistoryRpcLike` fakes only, never a live
 * response. The two JSON-RPC methods used (`getSignaturesForAddress`,
 * `getParsedTransaction`) are standard and well documented, but the risky
 * assumptions are about the *shape and content* of what comes back:
 *
 * 1. FEE PAYER = `accountKeys[0]`. Solana's message format defines index 0
 *    of the account keys as the fee payer and first required signer, and
 *    web3.js preserves that order in `transaction.message.accountKeys`. This
 *    is a protocol-level guarantee, not a Helius detail, but it has not been
 *    observed against a real response here. For a pump.fun mint the fee
 *    payer of the mint's earliest transaction is taken as the deployer; if
 *    a launchpad ever pays fees on a creator's behalf, that attribution
 *    becomes "the launchpad", not "the creator" - see
 *    `deployerFromTransaction`.
 * 2. FUNDER via LAMPORT DELTAS, not parsed instructions. The funder is read
 *    as the account with the largest lamport *decrease* in the wallet's
 *    earliest transaction, given the wallet's own balance increased. This
 *    deliberately avoids matching on `parsed.type === "transfer"` shapes
 *    (System vs. `transferWithSeed` vs. a CPI from a program, all of which
 *    look different in `jsonParsed` output and some of which do not appear
 *    as top-level instructions at all); `meta.preBalances`/`postBalances`
 *    are positional arrays over the same `accountKeys` and capture the net
 *    effect whatever produced it. The known wrinkle is that the fee payer
 *    also loses lamports to fees, so on an unusual first transaction the
 *    "largest decrease" could be a fee payer rather than a funder - hence
 *    `MIN_FUNDING_LAMPORTS`, which ignores decreases too small to be a real
 *    funding transfer.
 * 3. PAGINATION REACHES THE TRUE EARLIEST SIGNATURE only if the endpoint
 *    returns a full page whenever more history exists and honours `before`.
 *    That is the documented contract; a provider that silently truncates
 *    deep history would make an old wallet's "earliest" transaction wrong.
 *    `maxSignaturePages` bounds the cost either way and records the result
 *    as unknown rather than guessing - and unknown is safe by construction
 *    (see `relationshipDataKnown`).
 *
 * Nothing here throws into the hot path: every lookup runs in the
 * background, and a failure leaves no cache entry so reads keep answering
 * "unknown".
 * ---------------------------------------------------------------------
 */

/** Newest-first signature page entry. Only the signature is needed - the
 * ordering guarantee does the rest. */
export interface SignatureInfoLike {
  signature: string;
}

/** A transaction reduced to exactly what deployer/funder attribution needs.
 * `accountKeys` is in message order (index 0 = fee payer / first signer),
 * and the two balance arrays are positional over it. */
export interface TransactionLike {
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
}

/**
 * Narrow surface of a Solana JSON-RPC client this source needs - a sibling
 * of `token-intel`'s `SolanaRpcLike` (three token-account methods) rather
 * than an extension of it, so neither package has to depend on the other
 * and each keeps exactly the seam its tests inject. The
 * `@solana/web3.js`-specific types stay confined to
 * `Web3SolanaHistoryRpcClient` below.
 */
export interface SolanaHistoryRpcLike {
  /** Signatures touching `address`, newest first, at most `limit`, starting
   * strictly before `before` when given. A page shorter than `limit` means
   * the history ends there. */
  getSignaturesForAddress(address: string, options: { limit: number; before?: string }): Promise<SignatureInfoLike[]>;
  getTransaction(signature: string): Promise<TransactionLike | undefined>;
}

/** Max signatures per page - the JSON-RPC maximum, so the fewest calls per
 * unit of history walked. */
const SIGNATURE_PAGE_SIZE = 1000;

/**
 * Pagination cap. `getSignaturesForAddress` only walks backwards, so
 * reaching a wallet's *earliest* signature costs one call per 1000
 * signatures of its entire lifetime - unbounded for an old, busy address.
 * Four pages (4000 signatures) covers any plausible memecoin trading wallet
 * while capping one lookup at 5 RPC calls (4 pages + 1 transaction fetch).
 * Beyond the cap the lookup records *unknown*, never a guess from the
 * oldest signature seen so far: that signature is some mid-life trade, and
 * the "funder" derived from it would be a counterparty, i.e. a fabricated
 * relationship that could merge two unrelated wallets at weight 0.9.
 * Unknown is safe - it only means an edge is missed, and
 * `WhaleDiscoveryEngine` defers instead of promoting on it.
 */
const DEFAULT_MAX_SIGNATURE_PAGES = 4;

/** Lamport decreases below this (0.001 SOL) are treated as fees/rent noise
 * rather than a funding transfer. */
const MIN_FUNDING_LAMPORTS = 1_000_000;

const MAX_SUPPORTED_TRANSACTION_VERSION = 1;

const COMMON_FUNDER_WEIGHT = 0.9;
const SHARED_CREATOR_WEIGHT = 1;

function defaultRpcFactory(httpUrl: string): SolanaHistoryRpcLike {
  // No built-in 429 retry - the shared governor's cooldown is the retry
  // policy (see solanaRpcTokenMetadataProvider.ts's defaultRpcFactory).
  return new Web3SolanaHistoryRpcClient(new Connection(httpUrl, { commitment: "confirmed", disableRetryOnRateLimit: true }));
}

/** Thin `SolanaHistoryRpcLike` adapter over `@solana/web3.js`'s
 * `Connection` - the only place in this file that knows web3.js types. */
export class Web3SolanaHistoryRpcClient implements SolanaHistoryRpcLike {
  constructor(private readonly connection: Connection) {}

  async getSignaturesForAddress(address: string, options: { limit: number; before?: string }): Promise<SignatureInfoLike[]> {
    const res = await this.connection.getSignaturesForAddress(new PublicKey(address), {
      limit: options.limit,
      before: options.before,
    });
    return res.map((s) => ({ signature: s.signature }));
  }

  async getTransaction(signature: string): Promise<TransactionLike | undefined> {
    // maxSupportedTransactionVersion is required or versioned transactions
    // come back as an error rather than as data - and mainnet now carries
    // v1 transactions, which a cap of 0 rejects outright (seen live). Only
    // jsonParsed output is read here, so the node does the message parsing
    // and this client needs no knowledge of the v1 format.
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION as 0,
    });
    if (!tx?.meta) return undefined;
    return {
      accountKeys: tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
      preBalances: tx.meta.preBalances ?? [],
      postBalances: tx.meta.postBalances ?? [],
    };
  }
}

/** Fee payer / first signer of a transaction. */
export function deployerFromTransaction(tx: TransactionLike): string | undefined {
  return tx.accountKeys[0];
}

/**
 * The account that funded `wallet` in this transaction: the largest lamport
 * decrease among the other accounts, provided the wallet itself gained
 * lamports. Returns undefined when the transaction is not a funding of this
 * wallet at all - a conclusive "no funder here", distinct from a failed
 * lookup.
 */
export function funderFromTransaction(tx: TransactionLike, wallet: string): string | undefined {
  const walletIndex = tx.accountKeys.indexOf(wallet);
  if (walletIndex < 0) return undefined;
  const delta = (i: number) => (tx.postBalances[i] ?? 0) - (tx.preBalances[i] ?? 0);
  if (delta(walletIndex) <= 0) return undefined;

  let funder: string | undefined;
  let largestDecrease = 0;
  for (let i = 0; i < tx.accountKeys.length; i += 1) {
    if (i === walletIndex) continue;
    const decrease = -delta(i);
    if (decrease > largestDecrease) {
      largestDecrease = decrease;
      funder = tx.accountKeys[i];
    }
  }
  return largestDecrease >= MIN_FUNDING_LAMPORTS ? funder : undefined;
}

export interface SolanaRpcWalletRelationshipSourceOptions {
  /** Required - `wiring.ts` refuses to select this source at all when
   * HELIUS_API_KEY is unset, and the constructor refuses too (two-layer
   * fail-fast, same contract as `HeliusFeedProvider` and
   * `CompositeTokenMetadataProvider`). */
  apiKey: string;
  /** Use this RPC endpoint instead of Helius (SOLANA_RPC_URL). When set,
   * `apiKey` may be empty. */
  rpcUrl?: string;
  /** DI seam for tests: skips opening a real connection to Helius. */
  rpcFactory?: (httpUrl: string) => SolanaHistoryRpcLike;
  /** Pass the governor shared with `CompositeTokenMetadataProvider` so the
   * operator's single Helius rate limit is spent once across both. */
  refreshGovernor?: RpcRefreshGovernor;
  refreshBudget?: Partial<RpcRefreshBudget>;
  maxSignaturePages?: number;
  now?: () => number;
}

/**
 * Real, RPC-backed `WalletRelationshipSource`: derives the two relationship
 * edge kinds cluster detection cannot get from a trade stream from on-chain
 * history instead of from a mock's explicitly-registered fixtures.
 *
 * - a wallet's ORIGINAL FUNDER, from the earliest transaction in its
 *   signature history. Two wallets sharing one -> `common-funder` edge at
 *   weight 0.9.
 * - a mint's DEPLOYER, from the fee payer of the mint's earliest (creation)
 *   transaction. Wallets that are the deployer, or are funded by it, are
 *   creator-associated -> `shared-creator` edges at weight 1.0 and the
 *   `creatorAssociatedWallets` cluster flag.
 *
 * Creator-association reuses the same funder cache rather than a second
 * lookup path, so adding it costs no extra RPC calls.
 *
 * CACHED PERMANENTLY, WITH NO TTL - the one large efficiency win this has
 * over `CompositeTokenMetadataProvider`'s 20s TTL. A wallet's original
 * funder and a token's deployer are *immutable*: they are properties of a
 * transaction that already happened and can never be superseded. Holder
 * concentration and liquidity change minute to minute; "who first sent this
 * address SOL" does not. So one successful lookup per address is the whole
 * lifetime cost, and a re-lookup could only ever return the same answer.
 * Failed lookups are the only thing retried, governed by the shared
 * `RpcRefreshGovernor`'s per-key cooldown.
 *
 * Reads are synchronous and never block: they answer from cache and, on a
 * miss, schedule a throttled background lookup. Until that lands the answer
 * is "unknown", which means no edge (a cluster may be missed) and - via
 * `relationshipDataKnown` - a deferred rather than granted auto-promotion
 * in `WhaleDiscoveryEngine`.
 */
export class SolanaRpcWalletRelationshipSource implements WalletRelationshipSource {
  private readonly rpc: SolanaHistoryRpcLike;
  private readonly governor: RpcRefreshGovernor;
  private readonly maxSignaturePages: number;

  // `null` = looked up conclusively, no funder/deployer attributable (e.g.
  // the earliest transaction is not a funding of this wallet). Distinct from
  // an absent key, which means "not looked up yet" and is what drives both
  // the background lookup and the fail-closed deferral.
  private readonly funders = new Map<string, string | null>();
  private readonly deployers = new Map<string, string | null>();

  constructor(options: SolanaRpcWalletRelationshipSourceOptions) {
    if (!options.apiKey && !options.rpcUrl) {
      // Defense in depth - wiring.ts already refuses to select this source
      // without a key, but the class must never silently proceed
      // unauthenticated if constructed some other way.
      throw new Error("SolanaRpcWalletRelationshipSource requires a non-empty apiKey (HELIUS_API_KEY) or an rpcUrl (SOLANA_RPC_URL)");
    }
    const rpcFactory = options.rpcFactory ?? defaultRpcFactory;
    this.rpc = rpcFactory(options.rpcUrl ?? heliusEndpoint(options.apiKey).httpUrl);
    this.governor =
      options.refreshGovernor ??
      new RpcRefreshGovernor(resolveRpcRefreshBudget(options.refreshBudget), options.now ?? Date.now);
    this.maxSignaturePages = options.maxSignaturePages ?? DEFAULT_MAX_SIGNATURE_PAGES;
  }

  isCreatorAssociated(tokenMint: string, wallet: string): boolean {
    const deployer = this.deployerOf(tokenMint);
    if (!deployer) return false;
    if (wallet === deployer) return true;
    return this.funderOf(wallet) === deployer;
  }

  commonFunderEdges(wallets: string[]): ClusterEdge[] {
    const edges: ClusterEdge[] = [];
    for (let i = 0; i < wallets.length; i += 1) {
      for (let j = i + 1; j < wallets.length; j += 1) {
        const fa = this.funderOf(wallets[i]);
        const fb = this.funderOf(wallets[j]);
        if (fa && fb && fa === fb) {
          edges.push({ a: wallets[i], b: wallets[j], reason: "common-funder", weight: COMMON_FUNDER_WEIGHT });
        }
      }
    }
    return edges;
  }

  sharedCreatorEdges(tokenMint: string, wallets: string[]): ClusterEdge[] {
    const linked = wallets.filter((w) => this.isCreatorAssociated(tokenMint, w));
    const edges: ClusterEdge[] = [];
    for (let i = 0; i < linked.length; i += 1) {
      for (let j = i + 1; j < linked.length; j += 1) {
        edges.push({ a: linked[i], b: linked[j], reason: "shared-creator", weight: SHARED_CREATOR_WEIGHT });
      }
    }
    return edges;
  }

  relationshipDataKnown(tokenMint: string, wallet: string): boolean {
    // Both halves are required: knowing the deployer without knowing the
    // wallet's funder cannot rule out "funded by the deployer", which is
    // precisely the wash-trade shape.
    const deployerKnown = this.deployers.has(tokenMint);
    const funderKnown = this.funders.has(wallet);
    if (!deployerKnown) this.scheduleDeployerLookup(tokenMint);
    if (!funderKnown) this.scheduleFunderLookup(wallet);
    return deployerKnown && funderKnown;
  }

  /** Exposed for callers (or tests) that want to await the real lookups
   * instead of accepting "unknown" on a cold cache. Bypasses the throttle
   * deliberately - it is an explicit request, not feed-driven background
   * traffic. Not used on the hot path. */
  async prefetch(tokenMint: string, wallets: string[]): Promise<void> {
    await Promise.all([this.lookupDeployer(tokenMint), ...wallets.map((w) => this.lookupFunder(w))]);
  }

  private funderOf(wallet: string): string | undefined {
    const cached = this.funders.get(wallet);
    if (cached === undefined) {
      this.scheduleFunderLookup(wallet);
      return undefined;
    }
    return cached ?? undefined;
  }

  private deployerOf(tokenMint: string): string | undefined {
    const cached = this.deployers.get(tokenMint);
    if (cached === undefined) {
      this.scheduleDeployerLookup(tokenMint);
      return undefined;
    }
    return cached ?? undefined;
  }

  private scheduleFunderLookup(wallet: string): void {
    // Namespaced governor keys so a wallet that is also a mint (or vice
    // versa) does not share one cooldown slot with itself.
    this.governor.tryStart(`funder:${wallet}`, () => this.lookupFunder(wallet));
  }

  private scheduleDeployerLookup(tokenMint: string): void {
    this.governor.tryStart(`deployer:${tokenMint}`, () => this.lookupDeployer(tokenMint));
  }

  private async lookupFunder(wallet: string): Promise<void> {
    if (this.funders.has(wallet)) return;
    const tx = await this.earliestTransaction(wallet);
    // No cache write on failure: the governor's per-key cooldown, not a
    // poisoned cache entry, is what stops a failing address from being
    // retried on every read.
    if (tx === undefined) return;
    this.funders.set(wallet, funderFromTransaction(tx, wallet) ?? null);
  }

  private async lookupDeployer(tokenMint: string): Promise<void> {
    if (this.deployers.has(tokenMint)) return;
    const tx = await this.earliestTransaction(tokenMint);
    if (tx === undefined) return;
    this.deployers.set(tokenMint, deployerFromTransaction(tx) ?? null);
  }

  /**
   * Walks `getSignaturesForAddress` backwards to the earliest available
   * signature and fetches that transaction. Returns undefined for any
   * inconclusive outcome - RPC failure, no history at all, or the
   * pagination cap being hit before the history ended - all of which must
   * read as "unknown", not as an answer.
   */
  private async earliestTransaction(address: string): Promise<TransactionLike | undefined> {
    try {
      let before: string | undefined;
      let earliest: string | undefined;
      for (let page = 0; page < this.maxSignaturePages; page += 1) {
        const sigs = await this.rpc.getSignaturesForAddress(address, { limit: SIGNATURE_PAGE_SIZE, before });
        if (sigs.length === 0) {
          // Empty page right after a full one: the history was an exact
          // multiple of the page size and the previous page's last
          // signature is genuinely the first. With no prior page, the
          // address simply has no history.
          return earliest === undefined ? undefined : await this.rpc.getTransaction(earliest);
        }
        earliest = sigs[sigs.length - 1].signature;
        if (sigs.length < SIGNATURE_PAGE_SIZE) {
          // Short page = history ends here, so `earliest` is genuinely the
          // first signature of this address.
          return await this.rpc.getTransaction(earliest);
        }
        before = earliest;
      }
      return undefined; // cap hit - deliberately unknown
    } catch {
      return undefined;
    }
  }
}
