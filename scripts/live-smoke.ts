/**
 * Live end-to-end smoke test: real pump.fun trades from Solana mainnet
 * through the full pipeline (stats -> discovery -> scoring -> signal ->
 * entry gate -> PAPER execution -> position management -> whale exit),
 * then a report.
 *
 * The shipped config is built to trade only proven whales, which a few
 * minutes of fresh observation can never establish (a wallet needs 15
 * observed round trips, $5k realized PnL, ...), and config/watchlist.json
 * holds placeholder addresses. So this run enables whale discovery with
 * auto-promotion and relaxes the wallet/entry thresholds - it exercises
 * every stage on real data; it says nothing about strategy quality.
 * Execution is always paper.
 *
 *   npx tsx scripts/live-smoke.ts                 # 3 minutes, public mainnet RPC
 *   npx tsx scripts/live-smoke.ts --minutes 10
 *   SOLANA_RPC_URL=... or HELIUS_API_KEY=... to use your own endpoint
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventBus,
  RealClock,
  RuntimeFlags,
  loadEnvFile,
  parseStrategyConfig,
  resolveSolanaRpcEndpoint,
  type NormalizedTradeEvent,
} from "@whale-sniper/core";
import { createInMemoryRepositories } from "@whale-sniper/db";
import { FeedManager, HeliusFeedProvider, LiveSolUsdPrice } from "@whale-sniper/feed";
import { buildOrchestrator } from "@whale-sniper/orchestrator";
import { DexScreenerTokenMetadataProvider } from "@whale-sniper/token-intel";
import { createLogger } from "@whale-sniper/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function countBy<T>(items: T[], key: (t: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

loadEnvFile();
const minutes = arg("--minutes", 3);
const endpoint = resolveSolanaRpcEndpoint({
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? "" : PUBLIC_MAINNET_RPC),
  SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? "",
  HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? "",
})!;

const config = parseStrategyConfig(JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "strategy.json"), "utf-8")));
config.walletDiscovery = { enabled: true, autoPromote: true };
Object.assign(config.walletGate, {
  minTradeCount: 1,
  minWinRate: 0,
  minRealizedPnlUsd: -1e9,
  minAvgRoiPct: -1e9,
  minWhaleBuySizeUsd: 50,
  maxDrawdownPct: 1e9,
  minEarlyEntryFrequency: 0,
  maxRugExposureCount: 1000,
  minWhaleScore: 0,
});
Object.assign(config.entryGate, { minSignalScore: 30, minIndependentBuyers: 2, minBuyingMomentumUsd5m: 0 });
Object.assign(config.tokenThresholds, { minAgeSeconds: 0, maxTokenRiskScore: 100, minLiquidityUsd: 1000 });

async function main(): Promise<void> {
  const listenerErrors: string[] = [];
  const bus = new EventBus((event, err) => listenerErrors.push(`${event}: ${err instanceof Error ? err.message : String(err)}`));
  const repos = createInMemoryRepositories();
  const solPrice = new LiveSolUsdPrice();
  const built = buildOrchestrator({
    bus,
    clock: new RealClock(),
    config,
    repos,
    runtimeFlags: new RuntimeFlags(),
    watchlist: [],
    tokenMetadataProvider: new DexScreenerTokenMetadataProvider(),
  });

  const trades: Array<Pick<NormalizedTradeEvent, "wallet" | "tokenMint" | "side" | "usdValue"> & { lagMs: number }> = [];
  bus.on("trade.normalized", (e) =>
    trades.push({ wallet: e.wallet, tokenMint: e.tokenMint, side: e.side, usdValue: e.usdValue, lagMs: (e.timestamps.decodedAt ?? 0) - e.blockTime * 1000 }),
  );
  const rejections: string[] = [];
  bus.on("signal.rejected", ({ reason }) => rejections.push(reason));
  let promoted = 0;
  bus.on("wallet.discovery-promoted", () => (promoted += 1));
  const closeReasons: string[] = [];
  bus.on("position.closed", ({ reason }) => closeReasons.push(reason));

  built.orchestrator.start();
  const feed = new FeedManager(
    new HeliusFeedProvider({ apiKey: process.env.HELIUS_API_KEY ?? "", rpcUrl: endpoint.httpUrl, wsUrl: endpoint.wsUrl, solUsdPrice: solPrice }),
    bus,
    createLogger("live-smoke", "warn"),
  );
  console.log(`Live smoke: ${minutes} min on ${endpoint.label} (paper execution, relaxed gates)...`);
  await feed.start();
  console.log(`SOL/USD ${solPrice.current()} (${solPrice.isLive() ? "live" : `FALLBACK: ${solPrice.lastError}`})`);

  const progress = setInterval(() => {
    const m = built.metrics.snapshot();
    console.log(`  trades=${trades.length} promoted=${promoted} signals=${m.signalsGenerated} opened=${m.openPositions + m.closedPositions} closed=${m.closedPositions}`);
  }, 30_000);
  await new Promise((r) => setTimeout(r, minutes * 60_000));
  clearInterval(progress);
  await feed.stop();
  built.orchestrator.stop();
  await new Promise((r) => setTimeout(r, 500));

  const m = built.metrics.snapshot();
  const positions = await repos.position.allPositions();
  const closed = positions.filter((p) => p.status === "CLOSED");
  const lags = trades.map((t) => t.lagMs).sort((a, b) => a - b);
  const risk = await repos.riskState.get();
  const normalizeReason = (r: string) => r.replace(/-?\$?[\d.]+%?s?/g, "#").split("; ")[0];

  console.log("\n=== Feed ===");
  console.log({
    trades: trades.length,
    perSecond: Number((trades.length / (minutes * 60)).toFixed(1)),
    buys: trades.filter((t) => t.side === "BUY").length,
    uniqueWallets: new Set(trades.map((t) => t.wallet)).size,
    uniqueTokens: new Set(trades.map((t) => t.tokenMint)).size,
    ingestLagMsP50: lags[Math.floor(lags.length / 2)],
    ingestLagMsP95: lags[Math.floor(lags.length * 0.95)],
    feedHealth: feed.health(),
    solUsd: solPrice.current(),
  });
  console.log("\n=== Pipeline ===");
  console.log({ walletsPromoted: promoted, signalsGenerated: m.signalsGenerated, signalsRejected: m.signalsRejected, ordersSubmitted: m.ordersSubmitted, ordersFailed: m.ordersFailed });
  console.log("top rejection reasons:", countBy(rejections, normalizeReason).slice(0, 8));
  console.log("\n=== Paper positions ===");
  console.log({
    opened: positions.length,
    stillOpen: positions.length - closed.length,
    closed: closed.length,
    exitReasons: Object.fromEntries(countBy(closeReasons, (r) => r)),
    realizedPnlUsd: Number(closed.reduce((s, p) => s + p.realizedPnlUsd, 0).toFixed(2)),
    riskState: risk,
  });
  for (const p of positions.slice(0, 5)) {
    console.log(
      `  ${p.tokenMint.slice(0, 6)}.. ${p.status} entry $${p.entryUsdValue.toFixed(0)} @ ${p.entryPriceUsd.toExponential(3)} ` +
        `now ${p.currentPriceUsd.toExponential(3)} pnl $${p.realizedPnlUsd.toFixed(2)} ${p.exitReason ?? ""}`,
    );
  }
  console.log("\n=== Health ===");
  console.log({ listenerErrors: listenerErrors.length, rssMb: Math.round(process.memoryUsage().rss / 1e6), stageLatencyP50Ms: Object.fromEntries(Object.entries(m.latencyMsByStage).map(([k, v]) => [k, v.p50])) });
  for (const e of listenerErrors.slice(0, 5)) console.log("  listener error:", e);
  process.exit(listenerErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("live smoke failed", err);
  process.exit(1);
});
