import type { EventBus, NormalizedTradeEvent, RuggedTokenRegistry, StrategyConfig, WalletCluster } from "@whale-sniper/core";
import type { IClusterRepository, ITokenRepository } from "@whale-sniper/db";
import { buildClusters } from "./clusterGraph.js";
import { repeatedCoBuyEdges, timingCorrelationEdges } from "./edgeDetectors.js";
import { evaluateClusterFlags } from "./flagEvaluator.js";
import type { WalletRelationshipSource } from "./walletRelationshipSource.js";

/** Buffers trades per token from the live stream and, on demand (called at
 * the signal engine's cluster-check stage), builds the wallet relationship
 * graph for that token and merges it into clusters with manipulation
 * flags. */
/** How much per-token trade history is kept. Every detector here looks at
 * seconds-scale windows (timing correlation 15s, immediate selling 30s) or
 * the token's recent buy volume; an hour covers all of them, and without a
 * bound a live pump.fun feed (~4M trades/day) exhausts memory. */
const TRADE_RETENTION_SECONDS = 60 * 60;
/** How often (in feed time) to evict tokens that have stopped trading. */
const IDLE_SWEEP_INTERVAL_SECONDS = 60;
/** Edges kept when persisting a cluster (strongest first). On a busy
 * pump.fun token the timing-correlation graph is near-complete - ~1k edges
 * per cluster measured live - which is noise in an audit trail and was the
 * bulk of the repository's memory. Callers still get every edge. */
const MAX_PERSISTED_EDGES = 100;

export class ClusterDetector {
  private tradesByToken = new Map<string, NormalizedTradeEvent[]>();
  private lastSweepBlockTime = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly bus: EventBus,
    private readonly clusterRepo: IClusterRepository,
    private readonly tokenRepo: ITokenRepository,
    private readonly relationshipSource: WalletRelationshipSource,
    private readonly ruggedRegistry: RuggedTokenRegistry,
    private readonly config: StrategyConfig,
  ) {}

  start(): () => void {
    return this.bus.on("trade.normalized", (event) => {
      const cutoff = event.blockTime - TRADE_RETENTION_SECONDS;
      let arr = this.tradesByToken.get(event.tokenMint) ?? [];
      if (arr.length > 0 && arr[0].blockTime < cutoff) arr = arr.filter((t) => t.blockTime >= cutoff);
      arr.push(event);
      this.tradesByToken.set(event.tokenMint, arr);
      this.evictIdleTokens(event.blockTime);
    });
  }

  /** Drops tokens with no trade inside the retention window - most
   * pump.fun tokens stop trading within minutes and would otherwise be kept
   * forever, since the per-token prune above only runs on a new trade. */
  private evictIdleTokens(nowBlockTime: number): void {
    if (nowBlockTime - this.lastSweepBlockTime < IDLE_SWEEP_INTERVAL_SECONDS) return;
    this.lastSweepBlockTime = nowBlockTime;
    const cutoff = nowBlockTime - TRADE_RETENTION_SECONDS;
    for (const [mint, trades] of this.tradesByToken) {
      if (trades[trades.length - 1].blockTime < cutoff) this.tradesByToken.delete(mint);
    }
  }

  /** Test/diagnostic helper: how many tokens currently have buffered trades. */
  trackedTokenCount(): number {
    return this.tradesByToken.size;
  }

  async detectForToken(tokenMint: string): Promise<WalletCluster[]> {
    const trades = this.tradesByToken.get(tokenMint) ?? [];
    if (trades.length === 0) return [];

    const wallets = [...new Set(trades.map((t) => t.wallet))];
    const edges = [
      ...timingCorrelationEdges(trades),
      ...repeatedCoBuyEdges(this.buildCoBuyGrouping(wallets, tokenMint)),
      ...this.relationshipSource.commonFunderEdges(wallets),
      ...this.relationshipSource.sharedCreatorEdges(tokenMint, wallets),
    ];

    const clusters = buildClusters(edges, this.config.clusterThresholds.edgeMergeThreshold, tokenMint);
    const tokenStats = await this.tokenRepo.getStats(tokenMint);

    const evaluated: WalletCluster[] = [];
    for (const cluster of clusters) {
      const { flags, manipulationPenalty } = evaluateClusterFlags({
        cluster,
        tokenMint,
        trades,
        tokenStats,
        relationshipSource: this.relationshipSource,
        tokenIsRugged: this.ruggedRegistry.isRugged(tokenMint),
        manipulationPenaltyCap: this.config.clusterThresholds.manipulationPenaltyCap,
      });
      const full: WalletCluster = { ...cluster, flags, manipulationPenalty };
      evaluated.push(full);
      const persistedEdges =
        full.edges.length > MAX_PERSISTED_EDGES ? [...full.edges].sort((a, b) => b.weight - a.weight).slice(0, MAX_PERSISTED_EDGES) : full.edges;
      await this.clusterRepo.upsertCluster({ ...full, edges: persistedEdges });
      this.bus.emit("cluster.detected", { clusterId: full.clusterId, members: full.members });
    }
    return evaluated;
  }

  /** Only this token's trades are on hand for repeated-co-buy detection in
   * the live path (cross-token history lives in wallet-intel); this keeps
   * the detector self-contained while still catching same-token repeat
   * patterns (e.g. re-entries) as a lighter-weight signal. */
  private buildCoBuyGrouping(_wallets: string[], tokenMint: string): Map<string, NormalizedTradeEvent[]> {
    return new Map([[tokenMint, this.tradesByToken.get(tokenMint) ?? []]]);
  }
}
