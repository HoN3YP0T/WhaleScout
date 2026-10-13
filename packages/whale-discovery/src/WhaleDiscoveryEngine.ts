import type { EventBus, StrategyConfig, WalletCluster, WalletStats } from "@whale-sniper/core";
import type { IWatchlistRepository } from "@whale-sniper/db";
import { scoreWallet, type WatchlistIndex } from "@whale-sniper/wallet-intel";

/** Narrow seam over `WalletStatsUpdater` - only the one method this engine
 * needs, so tests can supply a fake without constructing the full
 * accumulator machinery. A real `WalletStatsUpdater` instance satisfies
 * this structurally. */
export interface WalletStatsSource {
  getStats(wallet: string): WalletStats | undefined;
}

/** Narrow seam over `ClusterDetector` - only `detectForToken`, the method
 * already used at `SniperOrchestrator`'s cluster-check stage. A real
 * `ClusterDetector` instance satisfies this structurally. */
export interface ClusterSource {
  detectForToken(tokenMint: string): Promise<WalletCluster[]>;
}

/** Narrow seam over `WalletRelationshipSource` - only the one method this
 * engine needs. A real `MockWalletRelationshipSource` or
 * `SolanaRpcWalletRelationshipSource` satisfies it structurally. */
export interface RelationshipWarmthSource {
  relationshipDataKnown(tokenMint: string, wallet: string): boolean;
}

export interface WhaleDiscoveryEngineDeps {
  bus: EventBus;
  config: StrategyConfig;
  watchlistIndex: WatchlistIndex;
  watchlistRepo: IWatchlistRepository;
  walletStatsSource: WalletStatsSource;
  clusterSource: ClusterSource;
  /** Optional: when supplied, auto-promotion is deferred for a wallet whose
   * funder/deployer relationships have not been resolved yet (see
   * `handle()`). Omitted means "relationship data is ground truth", which
   * is exactly right for `MockWalletRelationshipSource` and keeps the
   * default wiring's behaviour unchanged. */
  relationshipSource?: RelationshipWarmthSource;
}

const CLUSTER_REJECT_REASON = "cluster flagged: creatorAssociatedWallets or coordinatedBuying";

/**
 * Whale auto-discovery: watches every wallet's trade activity (not just
 * watchlisted ones - see `wallet.stats-updated`, emitted for every trade
 * regardless of watchlist status) for a never-before-seen wallet that
 * clears the EXACT SAME hard gate a manually curated `config/watchlist.json`
 * entry has to clear - `scoreWallet()` (and the `evaluateHardGate()` it
 * calls internally) from `walletScoring.ts`, reused BYTE-FOR-BYTE
 * UNCHANGED. A wallet that clears the gate is then checked against
 * `ClusterDetector`'s manipulation flags for the token that triggered this
 * evaluation; a wallet in a cluster flagged `creatorAssociatedWallets` or
 * `coordinatedBuying` is auto-rejected regardless of its score. A candidate
 * whose relationship data has not been resolved yet is DEFERRED rather than
 * promoted - see the fail-closed comment in `handle()`.
 *
 * Off by default (`config.walletDiscovery.enabled === false`) - `start()`
 * is a no-op subscriber in that case, so nothing about the existing
 * manual-watchlist-only path changes unless an operator opts in. Sits at
 * the same composition level as `whale-exit`: composes wallet-intel +
 * cluster-detect (via the narrow `WalletStatsSource`/`ClusterSource` seams
 * above) + db, without forcing those packages to depend on each other.
 */
export class WhaleDiscoveryEngine {
  constructor(private readonly deps: WhaleDiscoveryEngineDeps) {}

  start(): () => void {
    if (!this.deps.config.walletDiscovery.enabled) {
      return () => {};
    }
    return this.deps.bus.on("wallet.stats-updated", (event) => {
      return this.handle(event.wallet, event.tokenMint);
    });
  }

  private async handle(wallet: string, tokenMint: string): Promise<void> {
    // A wallet with ANY existing status - active (already on the
    // watchlist, manually or previously auto-promoted), pending (already a
    // candidate awaiting review), or rejected (already disqualified) - is
    // never re-processed or re-notified. Only a wallet with no entry at
    // all is a fresh candidate.
    if (this.deps.watchlistIndex.statusOf(wallet) !== undefined) return;

    const stats = this.deps.walletStatsSource.getStats(wallet);
    if (!stats) return;

    const score = scoreWallet(stats, this.deps.config);
    if (!score.passedHardGate) return; // hasn't cleared the bar yet - stays unstatused, re-evaluated on its next trade

    // FAIL CLOSED ON UNKNOWN. The cluster flags below are derived from
    // relationship data that a network-backed source serves from cache and
    // warms in the background, so the first trades from an unseen wallet
    // arrive before its funder/deployer lookups land. To the edge detectors
    // "not yet checked" and "clean" are the same thing (no data -> no edge,
    // so at worst a cluster is missed). Here they must not be: promoting a
    // wallet onto the tradeable watchlist because "no manipulation was
    // found" when nothing had been looked up yet is exactly the wash-trade
    // trap this check exists to prevent. So the candidate is left
    // unstatused and re-evaluated on its next trade, by which time the
    // lookups this very call scheduled have usually landed. Deferring is
    // free: the wallet is not tradeable while unstatused either way.
    if (this.deps.relationshipSource && !this.deps.relationshipSource.relationshipDataKnown(tokenMint, wallet)) return;

    const clusters = await this.deps.clusterSource.detectForToken(tokenMint);
    const cluster = clusters.find((c) => c.members.includes(wallet));
    const clusterFlagged = cluster ? cluster.flags.creatorAssociatedWallets || cluster.flags.coordinatedBuying : false;

    if (clusterFlagged) {
      await this.setStatus(wallet, "rejected", CLUSTER_REJECT_REASON);
      return;
    }

    if (this.deps.config.walletDiscovery.autoPromote) {
      await this.setStatus(wallet, "active", "auto-promoted by WhaleDiscoveryEngine");
      this.deps.bus.emit("wallet.discovery-promoted", { wallet, whaleScore: score.whaleScore });
    } else {
      await this.setStatus(wallet, "pending", "auto-discovered candidate awaiting review");
      this.deps.bus.emit("wallet.discovery-candidate", { wallet, whaleScore: score.whaleScore });
    }
  }

  private async setStatus(wallet: string, status: "active" | "pending" | "rejected", notes: string): Promise<void> {
    this.deps.watchlistIndex.upsert({ address: wallet, status, source: "auto-discovered", notes });
    await this.deps.watchlistRepo.updateStatus(wallet, status, notes);
  }
}
