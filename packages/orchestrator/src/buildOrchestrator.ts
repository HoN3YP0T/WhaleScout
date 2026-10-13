import type { Clock, EventBus, RuntimeFlags, StrategyConfig } from "@whale-sniper/core";
import { CreatorRegistry, RuggedTokenRegistry, TokenFirstSeenIndex } from "@whale-sniper/core";
import { ClusterDetector, MockWalletRelationshipSource, type WalletRelationshipSource } from "@whale-sniper/cluster-detect";
import type { Repositories, WatchlistEntry } from "@whale-sniper/db";
import { ExecutionPipeline, PaperExecutionAdapter, RiskEngine, type IExecutionAdapter } from "@whale-sniper/execution";
import { MetricsStore } from "@whale-sniper/monitoring";
import { PositionManager } from "@whale-sniper/position-mgmt";
import {
  CreatorRegistryUpdater,
  MockTokenMetadataProvider,
  TokenStatsCollector,
  type ITokenMetadataProvider,
  type TokenMetadataSeed,
} from "@whale-sniper/token-intel";
import { WalletStatsUpdater, WatchlistIndex } from "@whale-sniper/wallet-intel";
import { WhaleDiscoveryEngine } from "@whale-sniper/whale-discovery";
import { WhaleExitMonitor } from "@whale-sniper/whale-exit";
import { SniperOrchestrator } from "./SniperOrchestrator.js";

export interface BuildOrchestratorOptions {
  bus: EventBus;
  clock: Clock;
  config: StrategyConfig;
  repos: Repositories;
  runtimeFlags: RuntimeFlags;
  watchlist: WatchlistEntry[];
  executionAdapter?: IExecutionAdapter;
  tokenMetadataOverrides?: Array<{ tokenMint: string; metadata: TokenMetadataSeed }>;
  /** Overrides the default MockTokenMetadataProvider - e.g. a
   * DexScreenerTokenMetadataProvider when TOKEN_DATA_PROVIDER=dexscreener.
   * When set, `tokenMetadataOverrides` is ignored (it only makes sense for
   * the mock's deterministic per-mint seeding). */
  tokenMetadataProvider?: ITokenMetadataProvider;
  /** Overrides the default MockWalletRelationshipSource - e.g. a
   * SolanaRpcWalletRelationshipSource when
   * WALLET_RELATIONSHIP_SOURCE=solana-rpc. The mock's funder/creator maps
   * are only ever populated by scenario setup, so on the default path
   * cluster-detect's common-funder (weight .9) and shared-creator
   * (weight 1.0) edge detectors contribute nothing. */
  relationshipSource?: WalletRelationshipSource;
}

export interface BuiltOrchestrator {
  orchestrator: SniperOrchestrator;
  metrics: MetricsStore;
  tokenMetadataProvider: ITokenMetadataProvider;
  relationshipSource: WalletRelationshipSource;
  riskEngine: RiskEngine;
  /** Exposed so the composition root (wiring.ts) can hydrate it from
   * `repos.creatorReputation` at boot, before `orchestrator.start()` is
   * called - see buildAppContext(). */
  creatorRegistry: CreatorRegistry;
  /** Exposed so telegram-bot's /approve and /reject commands can update
   * the live in-process watchlist (the same object WhaleDiscoveryEngine
   * upserts into) immediately, not just the persisted repository. */
  watchlistIndex: WatchlistIndex;
}

/** Single place that assembles every sub-package into a SniperOrchestrator.
 * Both apps/sniper-runner (live) and backtest/replayEngine call this so
 * there is exactly one wiring path, not a live one and a parallel
 * backtest-only one. */
export function buildOrchestrator(options: BuildOrchestratorOptions): BuiltOrchestrator {
  const { bus, clock, config, repos, runtimeFlags } = options;

  const tokenFirstSeen = new TokenFirstSeenIndex();
  const ruggedRegistry = new RuggedTokenRegistry();
  const watchlistIndex = new WatchlistIndex();
  watchlistIndex.load(options.watchlist);

  const walletStatsUpdater = new WalletStatsUpdater(bus, repos.wallet, tokenFirstSeen, ruggedRegistry, clock);

  let tokenMetadataProvider: ITokenMetadataProvider;
  if (options.tokenMetadataProvider) {
    tokenMetadataProvider = options.tokenMetadataProvider;
  } else {
    const mockProvider = new MockTokenMetadataProvider();
    for (const override of options.tokenMetadataOverrides ?? []) {
      mockProvider.setOverride(override.tokenMint, override.metadata);
    }
    tokenMetadataProvider = mockProvider;
  }
  const tokenStatsCollector = new TokenStatsCollector(bus, repos.token, tokenMetadataProvider, tokenFirstSeen, ruggedRegistry, clock);

  const creatorRegistry = new CreatorRegistry();
  const creatorRegistryUpdater = new CreatorRegistryUpdater(bus, repos.token, creatorRegistry, ruggedRegistry, repos.creatorReputation);

  const relationshipSource = options.relationshipSource ?? new MockWalletRelationshipSource();
  const clusterDetector = new ClusterDetector(bus, repos.cluster, repos.token, relationshipSource, ruggedRegistry, config);

  // Every component that stamps or compares times reads the same clock, so
  // backtests (SimulatedClock) don't mix fixture time with wall-clock time.
  const now = () => clock.now();
  const riskEngine = new RiskEngine(repos.riskState, runtimeFlags, now);
  const executionAdapter = options.executionAdapter ?? new PaperExecutionAdapter(config);
  const executionPipeline = new ExecutionPipeline(executionAdapter, riskEngine, repos.position, bus, config, now);

  const positionManager = new PositionManager(bus, repos.position, config, now);
  const whaleExitMonitor = new WhaleExitMonitor(bus, positionManager, config);

  const whaleDiscoveryEngine = new WhaleDiscoveryEngine({
    bus,
    config,
    watchlistIndex,
    watchlistRepo: repos.watchlist,
    walletStatsSource: walletStatsUpdater,
    clusterSource: clusterDetector,
    relationshipSource,
  });

  const metrics = new MetricsStore();

  const orchestrator = new SniperOrchestrator({
    bus,
    clock,
    config,
    repos,
    watchlistIndex,
    tokenFirstSeen,
    ruggedRegistry,
    walletStatsUpdater,
    tokenStatsCollector,
    clusterDetector,
    executionPipeline,
    riskEngine,
    positionManager,
    whaleExitMonitor,
    metrics,
    creatorRegistry,
    creatorRegistryUpdater,
    whaleDiscoveryEngine,
  });

  return { orchestrator, metrics, tokenMetadataProvider, relationshipSource, riskEngine, creatorRegistry, watchlistIndex };
}
