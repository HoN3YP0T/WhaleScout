import { readFileSync } from "node:fs";
import {
  EventBus,
  RealClock,
  RpcRefreshGovernor,
  RuntimeFlags,
  createLogger,
  loadEnv,
  parseStrategyConfig,
  resolveSolanaRpcEndpoint,
  type SolanaRpcEndpoint,
  type AppEnv,
  type IFeedProvider,
  type Logger,
  type StrategyConfig,
} from "@whale-sniper/core";
import {
  SolanaRpcWalletRelationshipSource,
  type WalletRelationshipSource,
} from "@whale-sniper/cluster-detect";
import { RecentEventLog, handleDashboardRequest } from "@whale-sniper/dashboard";
import { createRepositories, type Repositories, type WatchlistEntry } from "@whale-sniper/db";
import { FeedManager, HeliusFeedProvider, MockFeedProvider, allScenarios, type ScenarioResult } from "@whale-sniper/feed";
import { AlertManager, MetricsStore, startHealthServer } from "@whale-sniper/monitoring";
import { buildOrchestrator, type SniperOrchestrator } from "@whale-sniper/orchestrator";
import { TelegramBot } from "@whale-sniper/telegram-bot";
import {
  CompositeTokenMetadataProvider,
  DexScreenerTokenMetadataProvider,
  SolscanTokenMetadataProvider,
  type ITokenMetadataProvider,
} from "@whale-sniper/token-intel";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");

export interface AppContext {
  env: AppEnv;
  config: StrategyConfig;
  bus: EventBus;
  repos: Repositories;
  runtimeFlags: RuntimeFlags;
  orchestrator: SniperOrchestrator;
  metrics: MetricsStore;
  feedManager: FeedManager;
  telegramBot: TelegramBot;
  alertManager: AlertManager;
  logger: Logger;
  eventLog: RecentEventLog;
}

function loadStrategyConfig(): StrategyConfig {
  const raw = readFileSync(path.join(REPO_ROOT, "config", "strategy.json"), "utf-8");
  return parseStrategyConfig(JSON.parse(raw));
}

/**
 * Single choke point for feed provider selection - mirrors the pattern
 * `selectExecutionAdapterKind()` uses for live trading. `FEED_PROVIDER=helius`
 * is refused outright (never silently downgraded to mock) when
 * HELIUS_API_KEY is unset, so a misconfigured deploy fails loudly at boot
 * instead of quietly running against mock data while believing it's live.
 */
function buildFeedProvider(env: AppEnv, rpc: SolanaRpcEndpoint | undefined, scenarios: ScenarioResult[]): IFeedProvider {
  if (env.FEED_PROVIDER === "helius") {
    if (!rpc) {
      throw new Error(
        'FEED_PROVIDER=helius requires HELIUS_API_KEY (or SOLANA_RPC_URL) to be set - refusing to start rather than silently falling back to the mock feed. Set one in .env, or set FEED_PROVIDER=mock.',
      );
    }
    return new HeliusFeedProvider({ apiKey: env.HELIUS_API_KEY, rpcUrl: rpc.httpUrl, wsUrl: rpc.wsUrl });
  }
  return new MockFeedProvider(
    scenarios.flatMap((s) => s.events),
    { playback: "paced", paceMs: 25 },
  );
}

/**
 * Single choke point for token-data provider selection - mirrors
 * `buildFeedProvider()`'s fail-fast pattern above. `TOKEN_DATA_PROVIDER=solscan`
 * is refused outright (never silently downgraded to mock/dexscreener) when
 * SOLSCAN_API_KEY is unset, and `dexscreener+rpc` likewise when
 * HELIUS_API_KEY is unset, so a misconfigured deploy fails loudly at boot
 * instead of quietly running against a different provider than intended.
 * Returns undefined for "mock" - buildOrchestrator() falls back to
 * MockTokenMetadataProvider (with the mock scenarios' deterministic
 * overrides) in that case, exactly as it always has.
 */
function buildTokenMetadataProvider(
  env: AppEnv,
  rpc: SolanaRpcEndpoint | undefined,
  governor: RpcRefreshGovernor,
): ITokenMetadataProvider | undefined {
  if (env.TOKEN_DATA_PROVIDER === "solscan") {
    if (!env.SOLSCAN_API_KEY) {
      throw new Error(
        'TOKEN_DATA_PROVIDER=solscan requires SOLSCAN_API_KEY to be set - refusing to start rather than silently falling back to mock/dexscreener data. Set SOLSCAN_API_KEY in .env, or set TOKEN_DATA_PROVIDER=mock or dexscreener.',
      );
    }
    return new SolscanTokenMetadataProvider(env.SOLSCAN_API_KEY);
  }
  if (env.TOKEN_DATA_PROVIDER === "dexscreener+rpc") {
    if (!rpc) {
      throw new Error(
        'TOKEN_DATA_PROVIDER=dexscreener+rpc requires HELIUS_API_KEY (or SOLANA_RPC_URL) to be set - it reads holder concentration and mint/freeze authority state over Solana RPC, and refuses to start rather than silently falling back to the conservative "unknown = risky" defaults that impose a 35-point token-risk floor. Set HELIUS_API_KEY in .env, or set TOKEN_DATA_PROVIDER=mock, dexscreener or solscan.',
      );
    }
    return new CompositeTokenMetadataProvider({ apiKey: env.HELIUS_API_KEY, rpcUrl: rpc.httpUrl, refreshGovernor: governor });
  }
  if (env.TOKEN_DATA_PROVIDER === "dexscreener") {
    return new DexScreenerTokenMetadataProvider();
  }
  return undefined;
}

/**
 * Single choke point for wallet-relationship-source selection - same
 * fail-fast pattern as the two above. This is the difference between
 * cluster detection running on two of its four edge detectors and on all
 * four: `MockWalletRelationshipSource`'s funder/creator maps are only ever
 * populated by scenario setup, so in production `commonFunderEdges`
 * (weight .9) and `sharedCreatorEdges` (weight 1.0) - the two decisive
 * signals against the 0.5 merge threshold - return nothing, and the
 * `creatorAssociatedWallets` flag (which whale-discovery uses to
 * auto-reject wash-trading candidates) can never fire.
 *
 * Returns undefined for "mock" so buildOrchestrator() falls back to the
 * mock exactly as it always has.
 */
function buildWalletRelationshipSource(
  env: AppEnv,
  rpc: SolanaRpcEndpoint | undefined,
  governor: RpcRefreshGovernor,
): WalletRelationshipSource | undefined {
  if (env.WALLET_RELATIONSHIP_SOURCE === "solana-rpc") {
    if (!rpc) {
      throw new Error(
        'WALLET_RELATIONSHIP_SOURCE=solana-rpc requires HELIUS_API_KEY (or SOLANA_RPC_URL) to be set - it derives wallet funding and token-deployer relationships from on-chain history, and refuses to start rather than silently falling back to MockWalletRelationshipSource, whose common-funder and shared-creator edge detectors return nothing in production. Set HELIUS_API_KEY in .env, or set WALLET_RELATIONSHIP_SOURCE=mock.',
      );
    }
    return new SolanaRpcWalletRelationshipSource({ apiKey: env.HELIUS_API_KEY, rpcUrl: rpc.httpUrl, refreshGovernor: governor });
  }
  return undefined;
}

function loadWatchlist(): WatchlistEntry[] {
  const raw = readFileSync(path.join(REPO_ROOT, "config", "watchlist.json"), "utf-8");
  return (JSON.parse(raw) as { wallets: WatchlistEntry[] }).wallets;
}

export async function buildAppContext(): Promise<AppContext> {
  const env = loadEnv();
  const logger = createLogger("sniper-runner", env.LOG_LEVEL);
  const config = loadStrategyConfig();
  const watchlist = loadWatchlist();

  const bus = new EventBus();
  const runtimeFlags = new RuntimeFlags();
  const clock = new RealClock();
  const repos = await createRepositories(logger);

  for (const entry of watchlist) {
    await repos.watchlist.add(entry);
  }
  // Trade off the persisted watchlist, not just the config file: it also
  // carries wallets approved/auto-promoted (or rejected) in earlier runs,
  // which the config file knows nothing about.
  const persistedWatchlist = await repos.watchlist.load();

  const scenarios = allScenarios();
  const tokenMetadataOverrides = scenarios.map((s) => ({ tokenMint: s.tokenMint, metadata: s.tokenMetadata }));
  // One governor shared by every Helius-backed provider: token metadata and
  // wallet relationships hit the same endpoint on the same HELIUS_API_KEY,
  // so the operator's rate limit has to be spent once between them rather
  // than twice over.
  const rpcRefreshGovernor = new RpcRefreshGovernor();
  const rpcEndpoint = resolveSolanaRpcEndpoint(env);
  const tokenMetadataProvider = buildTokenMetadataProvider(env, rpcEndpoint, rpcRefreshGovernor);
  const relationshipSource = buildWalletRelationshipSource(env, rpcEndpoint, rpcRefreshGovernor);

  const built = buildOrchestrator({
    bus,
    clock,
    config,
    repos,
    runtimeFlags,
    watchlist: persistedWatchlist,
    tokenMetadataOverrides,
    tokenMetadataProvider,
    relationshipSource,
  });

  // Hydrate creator reputation from persistence before the orchestrator (and
  // therefore CreatorRegistryUpdater) starts, so reputation built up in a
  // previous run keeps informing creatorRiskComponent() from the first
  // trade of this run rather than starting cold every restart.
  const creatorReputations = await repos.creatorReputation.loadAll();
  built.creatorRegistry.hydrate(creatorReputations);

  const feedProvider = buildFeedProvider(env, rpcEndpoint, scenarios);
  const feedManager = new FeedManager(feedProvider, bus, logger);

  const telegramBot = new TelegramBot({
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    bus,
    positionRepo: repos.position,
    signalRepo: repos.signal,
    watchlistRepo: repos.watchlist,
    watchlistIndex: built.watchlistIndex,
    runtimeFlags,
    logger,
  });

  const alertManager = new AlertManager((message) => {
    logger.warn({}, message);
    void telegramBot.notify(message);
  });

  // Ring buffer for the dashboard's live signal feed - rejected signals
  // are never persisted anywhere else (see RecentEventLog's doc comment),
  // so this subscribes to the same bus events MetricsStore already does.
  const eventLog = new RecentEventLog();
  eventLog.start(bus);

  return {
    env,
    config,
    bus,
    repos,
    runtimeFlags,
    orchestrator: built.orchestrator,
    metrics: built.metrics,
    feedManager,
    telegramBot,
    alertManager,
    logger,
    eventLog,
  };
}

export async function startApp(ctx: AppContext): Promise<{ stop: () => Promise<void> }> {
  ctx.orchestrator.start();
  await ctx.telegramBot.start();
  const healthServer = startHealthServer(ctx.env.HEALTH_PORT, ctx.metrics, (req, res) =>
    handleDashboardRequest(req, res, { repos: ctx.repos, metrics: ctx.metrics, eventLog: ctx.eventLog }),
  );

  try {
    await ctx.feedManager.start();
  } catch (err) {
    ctx.logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      `feed provider "${ctx.env.FEED_PROVIDER}" failed to start`,
    );
    if (ctx.env.FEED_PROVIDER === "helius") {
      ctx.logger.warn({}, "HeliusFeedProvider failed to connect - check HELIUS_API_KEY and network access, or set FEED_PROVIDER=mock");
    }
  }

  const alertInterval = setInterval(() => {
    // Feed counters live on the provider; MetricsStore only hears the
    // connect/disconnect events, so without this /metrics and the
    // dashboard show 0 events received however busy the feed is.
    ctx.metrics.recordFeedHealth(ctx.feedManager.health());
    ctx.alertManager.check(ctx.metrics.snapshot());
  }, 10_000);

  // Heartbeat: a live feed otherwise runs silently unless a watched wallet
  // trades, which is indistinguishable from a dead feed in the logs.
  let lastEvents = 0;
  const heartbeatInterval = setInterval(() => {
    const feed = ctx.feedManager.health();
    const snapshot = ctx.metrics.snapshot();
    ctx.logger.info(
      {
        feedConnected: feed.connected,
        eventsLastMinute: feed.eventsReceived - lastEvents,
        eventsTotal: feed.eventsReceived,
        feedErrors: feed.errorsReceived,
        signalsGenerated: snapshot.signalsGenerated,
        signalsRejected: snapshot.signalsRejected,
        openPositions: snapshot.openPositions,
        realizedPnlUsd: Number(snapshot.realizedPnlUsd.toFixed(2)),
      },
      "heartbeat",
    );
    lastEvents = feed.eventsReceived;
  }, 60_000);

  return {
    stop: async () => {
      clearInterval(alertInterval);
      clearInterval(heartbeatInterval);
      await ctx.feedManager.stop();
      await ctx.telegramBot.stop();
      ctx.orchestrator.stop();
      healthServer.close();
    },
  };
}
