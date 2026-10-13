import {
  type Clock,
  type CreatorRegistry,
  type EventBus,
  type NormalizedTradeEvent,
  type Position,
  type RuggedTokenRegistry,
  type StrategyConfig,
  type TokenFirstSeenIndex,
} from "@whale-sniper/core";
import type { ClusterDetector } from "@whale-sniper/cluster-detect";
import type { Repositories } from "@whale-sniper/db";
import type { ExecutionPipeline, RiskEngine } from "@whale-sniper/execution";
import type { MetricsStore } from "@whale-sniper/monitoring";
import type { PositionManager } from "@whale-sniper/position-mgmt";
import { computeSignal } from "@whale-sniper/signal-engine";
import type { CreatorRegistryUpdater, TokenStatsCollector } from "@whale-sniper/token-intel";
import { scoreTokenRisk } from "@whale-sniper/token-intel";
import { scoreWallet, type WalletStatsUpdater, type WatchlistIndex } from "@whale-sniper/wallet-intel";
import type { WhaleDiscoveryEngine } from "@whale-sniper/whale-discovery";
import type { WhaleExitMonitor } from "@whale-sniper/whale-exit";

export interface OrchestratorDeps {
  bus: EventBus;
  clock: Clock;
  config: StrategyConfig;
  repos: Repositories;
  watchlistIndex: WatchlistIndex;
  tokenFirstSeen: TokenFirstSeenIndex;
  ruggedRegistry: RuggedTokenRegistry;
  walletStatsUpdater: WalletStatsUpdater;
  tokenStatsCollector: TokenStatsCollector;
  clusterDetector: ClusterDetector;
  executionPipeline: ExecutionPipeline;
  riskEngine: RiskEngine;
  positionManager: PositionManager;
  whaleExitMonitor: WhaleExitMonitor;
  metrics: MetricsStore;
  creatorRegistry: CreatorRegistry;
  creatorRegistryUpdater: CreatorRegistryUpdater;
  whaleDiscoveryEngine: WhaleDiscoveryEngine;
}

/**
 * The single canonical whale-buy -> intelligence -> signal -> entry gate ->
 * execution -> position tracking pipeline. Used unmodified by both the live
 * app (apps/sniper-runner, real-time-driven) and the backtest replay engine
 * (SimulatedClock-driven) - this is what "replay reuses live pipeline code"
 * means concretely: there is exactly one implementation of this logic.
 */
export class SniperOrchestrator {
  private openPositionsByToken = new Map<string, Position[]>();
  /** Every position opened this session that has not reported closed yet -
   * lets the position.closed handler find the Position (with its final PnL)
   * from the event's id alone. */
  private openPositionsById = new Map<string, Position>();
  private unsubscribers: Array<() => void> = [];
  /** Tail of the entry critical section - see runEntryExclusive(). */
  private entryQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OrchestratorDeps) {}

  start(): void {
    this.unsubscribers.push(
      this.deps.walletStatsUpdater.start(),
      this.deps.tokenStatsCollector.start(),
      this.deps.creatorRegistryUpdater.start(),
      this.deps.clusterDetector.start(),
      this.deps.whaleExitMonitor.start(),
      this.deps.whaleDiscoveryEngine.start(),
      this.deps.metrics.start(this.deps.bus),
      this.deps.bus.on("trade.normalized", (event) => this.handle(event)),
      this.deps.bus.on("position.closed", ({ positionId }) => this.onPositionClosed(positionId)),
    );
  }

  /** Feeds every closed trade's result into the risk engine (daily loss,
   * consecutive losses, post-loss cooldown) and into metrics (realized PnL /
   * drawdown alerts). Without this, those limits never trip. */
  private async onPositionClosed(positionId: string): Promise<void> {
    const position = this.openPositionsById.get(positionId);
    if (!position) return;
    this.openPositionsById.delete(positionId);
    this.deps.metrics.recordRealizedPnl(position.realizedPnlUsd);
    await this.deps.riskEngine.recordTradeResult(position.realizedPnlUsd, this.deps.config);
  }

  /**
   * Runs `fn` only after every previously queued entry decision has finished.
   * handle() runs concurrently for every trade (each is a separate bus
   * callback with several awaits), so without this two whale buys arriving
   * together would both read exposure before either position was tracked and
   * both pass maxOpenPositions / max*ExposureUsd - including two entries on
   * the same token from one whale's back-to-back buys.
   */
  private runEntryExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.entryQueue.then(fn, fn);
    this.entryQueue = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
  }

  private trackPosition(position: Position): void {
    this.openPositionsById.set(position.positionId, position);
    const arr = this.openPositionsByToken.get(position.tokenMint) ?? [];
    arr.push(position);
    this.openPositionsByToken.set(position.tokenMint, arr);
  }

  private pruneClosedPositions(tokenMint: string): void {
    const arr = this.openPositionsByToken.get(tokenMint);
    if (!arr) return;
    this.openPositionsByToken.set(tokenMint, arr.filter((p) => p.status === "OPEN"));
  }

  private openExposure(): { openPositionsCount: number; totalExposureUsd: number; perTokenExposureUsd: (tokenMint: string) => number } {
    let count = 0;
    let total = 0;
    const perToken = new Map<string, number>();
    for (const [tokenMint, positions] of this.openPositionsByToken) {
      for (const p of positions) {
        if (p.status !== "OPEN") continue;
        count += 1;
        const value = p.remainingTokenAmount * p.currentPriceUsd;
        total += value;
        perToken.set(tokenMint, (perToken.get(tokenMint) ?? 0) + value);
      }
    }
    return { openPositionsCount: count, totalExposureUsd: total, perTokenExposureUsd: (t) => perToken.get(t) ?? 0 };
  }

  private async handle(event: NormalizedTradeEvent): Promise<void> {
    // Drive open positions on this token off every trade tick, whale or not.
    const openHere = this.openPositionsByToken.get(event.tokenMint) ?? [];
    for (const position of openHere) {
      if (position.status !== "OPEN") continue;
      const tokenStats = await this.deps.repos.token.getStats(event.tokenMint);
      await this.deps.positionManager.onPriceTick(position, event.priceUsd, tokenStats?.liquidityUsd ?? 10000, this.deps.clock.now());
    }
    this.pruneClosedPositions(event.tokenMint);

    if (event.side !== "BUY") return;
    if (!this.deps.watchlistIndex.isWatched(event.wallet)) return;
    if (event.usdValue < this.deps.config.walletGate.minWhaleBuySizeUsd) return;

    event.timestamps.walletMatchedAt = this.deps.clock.now();

    const walletStats = this.deps.walletStatsUpdater.getStats(event.wallet);
    if (!walletStats) return; // no history yet - can't score

    event.timestamps.tokenLookupAt = this.deps.clock.now();
    const tokenStats = this.deps.tokenStatsCollector.getStats(event.tokenMint);
    if (!tokenStats) return;

    event.timestamps.clusterCheckAt = this.deps.clock.now();
    const clusters = await this.deps.clusterDetector.detectForToken(event.tokenMint);
    const cluster = clusters.find((c) => c.members.includes(event.wallet));

    event.timestamps.scoredAt = this.deps.clock.now();
    const walletScore = scoreWallet(walletStats, this.deps.config);
    await this.deps.repos.wallet.upsertScore(walletScore);
    const creatorReputation = tokenStats.creatorAddress
      ? this.deps.creatorRegistry.getReputation(tokenStats.creatorAddress)
      : undefined;
    const tokenRisk = scoreTokenRisk(tokenStats, this.deps.config, event.blockTime, creatorReputation);
    await this.deps.repos.token.upsertRiskScore(tokenRisk);

    this.deps.bus.emit("whale.detected", {
      wallet: event.wallet,
      tokenMint: event.tokenMint,
      usdValue: event.usdValue,
      whaleScore: walletScore.whaleScore,
    });

    event.timestamps.signalAt = this.deps.clock.now();
    const signal = computeSignal(
      {
        triggeringTrade: event,
        walletScore,
        tokenRisk,
        tokenStats,
        tokenFirstSeenBlockTime: this.deps.tokenFirstSeen.get(event.tokenMint) ?? event.blockTime,
        cluster,
      },
      this.deps.config,
    );
    await this.deps.repos.signal.saveSignal(signal);
    this.deps.metrics.recordSignalGenerated();
    this.deps.bus.emit("signal.generated", { signalId: signal.signalId, tokenMint: signal.tokenMint, score: signal.score });

    await this.runEntryExclusive(async () => {
      // Exposure is read and the resulting position tracked inside one
      // exclusive section, so the next entry always sees this one.
      const exposure = this.openExposure();
      const clusterExposureUsd = cluster
        ? [...this.openPositionsByToken.values()]
            .flat()
            .filter((p) => p.status === "OPEN" && cluster.members.includes(p.whaleState.wallet))
            .reduce((s, p) => s + p.remainingTokenAmount * p.currentPriceUsd, 0)
        : 0;

      const result = await this.deps.executionPipeline.executeEntry({
        tradeEvent: event,
        walletScore,
        tokenRisk,
        tokenStats,
        signal,
        cluster,
        openPositionsCount: exposure.openPositionsCount,
        totalExposureUsd: exposure.totalExposureUsd,
        perTokenExposureUsd: exposure.perTokenExposureUsd(event.tokenMint),
        perClusterExposureUsd: clusterExposureUsd,
      });

      this.deps.metrics.recordLatencies(result.latencyMs);

      if (!result.passed) {
        // Entry gate / risk veto rejections never reached order submission -
        // metrics.start() already counts them via signal.rejected. Only a
        // submitted order that failed to fill is an order failure.
        if (result.orderFailed) {
          this.deps.metrics.recordOrderSubmitted();
          this.deps.metrics.recordOrderFailed();
        }
        return;
      }

      this.deps.metrics.recordOrderSubmitted();
      this.deps.metrics.recordOrderConfirmed();
      if (result.position) {
        this.trackPosition(result.position);
        this.deps.whaleExitMonitor.track(result.position, event.tokenAmount);
      }
    });
  }
}
