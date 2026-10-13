/**
 * Historical whale discovery: finds wallets whose recent pump.fun trading
 * clears the SAME hard gate (config/strategy.json walletGate, via
 * scoreWallet) that a watchlist whale must clear, using trade history
 * instead of waiting for the live feed to observe 15+ round trips.
 *
 *   npx tsx scripts/discover-whales.ts                       # report only
 *   npx tsx scripts/discover-whales.ts --feed-minutes 10 --min-ath 20000
 *   npx tsx scripts/discover-whales.ts --source api          # universe from pump.fun's coins API
 *   npx tsx scripts/discover-whales.ts --include-cache       # also score every history cached by earlier runs
 *   npx tsx scripts/discover-whales.ts --apply               # add to watchlist as "pending"
 *
 * --apply adds wallets that pass the gate AND look copyable to
 * config/watchlist.json with status "pending": they are not traded until an
 * operator approves them (Telegram /approve), the same review step
 * WhaleDiscoveryEngine uses. Existing entries are left untouched.
 *
 * Coverage caveat: a wallet's record covers only its trades on the scanned
 * tokens (recent launches + recently traded tokens), not its full history.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, EventBus, loadEnvFile, parseStrategyConfig, resolveSolanaRpcEndpoint } from "@whale-sniper/core";
import { FeedManager, HeliusFeedProvider, LiveSolUsdPrice } from "@whale-sniper/feed";
import {
  PumpFunHistoryClient,
  scanHistoricalWallets,
  setRateLimitListener,
  tokenFromTrades,
  type HistoricalToken,
  type HistoricalTrade,
  type WalletCandidate,
} from "@whale-sniper/whale-discovery";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : "feed";
const feedMinutes = arg("--feed-minutes", 5);
const minFeedTrades = arg("--min-feed-trades", 10);
const minAth = arg("--min-ath", 10_000);
const maxTokens = arg("--max-tokens", 400);
const maxPages = arg("--max-pages", 30);
const concurrency = arg("--concurrency", 4);
const apply = process.argv.includes("--apply");
const cacheHours = arg("--cache-hours", 6);
const cacheDir = path.join(REPO_ROOT, ".cache", "pump-trades");
// Score over every history cached by earlier runs too, not just this run's
// tokens - with pump.fun serving ~20 requests/minute, repeated runs are how
// a universe large enough to show multi-week track records accumulates.
const includeCache = process.argv.includes("--include-cache");
const outPath = path.join(REPO_ROOT, "config", "discovered-whales.json");

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function row(c: WalletCandidate): string {
  const s = c.stats;
  return [
    c.wallet,
    `score ${c.score.whaleScore.toFixed(1)}`,
    `${s.tradeCount} trades/${c.distinctTokens} tokens`,
    `win ${(s.winRate * 100).toFixed(0)}%`,
    `pnl $${s.realizedPnlUsd.toFixed(0)}`,
    `avgROI ${s.avgRoiPct.toFixed(0)}%`,
    `avgBuy $${s.avgWhaleBuySizeUsd.toFixed(0)}`,
    `early ${(s.earlyEntryFrequency * 100).toFixed(0)}%`,
    `hold ${c.medianHoldSeconds === undefined ? "-" : `${Math.round(c.medianHoldSeconds)}s`}`,
  ].join("  ");
}

/** Tokens trading on the live pump.fun feed right now, busiest (by USD
 * volume) first. Outcome-agnostic like the coins API, and not subject to
 * its aggressive rate limiting. */
async function mintsFromLiveFeed(minutes: number): Promise<string[]> {
  loadEnvFile();
  const endpoint = resolveSolanaRpcEndpoint({
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? "" : "https://api.mainnet-beta.solana.com"),
    SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? "",
    HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? "",
  })!;
  const bus = new EventBus();
  const activity = new Map<string, { trades: number; usd: number }>();
  bus.on("trade.normalized", (e) => {
    const a = activity.get(e.tokenMint) ?? { trades: 0, usd: 0 };
    a.trades += 1;
    a.usd += e.usdValue;
    activity.set(e.tokenMint, a);
  });
  const feed = new FeedManager(
    new HeliusFeedProvider({ apiKey: process.env.HELIUS_API_KEY ?? "", rpcUrl: endpoint.httpUrl, wsUrl: endpoint.wsUrl, solUsdPrice: new LiveSolUsdPrice() }),
    bus,
    createLogger("discover-whales", "warn"),
  );
  await feed.start();
  await new Promise((r) => setTimeout(r, minutes * 60_000));
  await feed.stop();
  console.log(`  ${feed.health().eventsReceived} live trades across ${activity.size} tokens`);
  return [...activity]
    .filter(([, a]) => a.trades >= minFeedTrades)
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(([mint]) => mint);
}

async function main(): Promise<void> {
  const config = parseStrategyConfig(JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "strategy.json"), "utf-8")));
  const client = new PumpFunHistoryClient();
  setRateLimitListener((host, waitMs) => console.log(`  rate limited by ${host}; waiting ${Math.round(waitMs / 1000)}s`));

  let mints: string[];
  let apiTokens = new Map<string, HistoricalToken>();
  if (source === "api") {
    console.log(`Fetching token universe from pump.fun's coins API (ATH market cap >= $${minAth})...`);
    const listed = await client.fetchUniverse({ recentLaunches: true, recentlyTraded: true, minAthMarketCapUsd: minAth, maxTokens });
    apiTokens = new Map(listed.map((t) => [t.mint, t]));
    mints = listed.map((t) => t.mint);
  } else {
    console.log(`Watching the live pump.fun feed for ${feedMinutes} min to pick tokens (>= ${minFeedTrades} trades)...`);
    mints = (await mintsFromLiveFeed(feedMinutes)).slice(0, maxTokens);
  }
  console.log(`  ${mints.length} candidate tokens`);

  console.log(`Fetching trade histories (up to ${maxPages * 100} trades per token)...`);
  let done = 0;
  const failures: string[] = [];
  // pump.fun serves ~20 requests/minute, so a scan of a few hundred tokens
  // takes tens of minutes; cached histories make reruns and resumes cheap.
  mkdirSync(cacheDir, { recursive: true });
  const startedAt = Date.now();
  const histories = await pool(mints, concurrency, async (mint) => {
    const cachePath = path.join(cacheDir, `${mint}.json`);
    try {
      if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < cacheHours * 3_600_000) {
        return { mint, ...(JSON.parse(readFileSync(cachePath, "utf-8")) as { trades: HistoricalTrade[]; truncated: boolean }) };
      }
      const history = await client.fetchTrades(mint, maxPages);
      writeFileSync(cachePath, JSON.stringify(history));
      return { mint, ...history };
    } catch (err) {
      failures.push(`${mint}: ${err instanceof Error ? err.message : String(err)}`);
      return { mint, trades: [] as HistoricalTrade[], truncated: false };
    } finally {
      done += 1;
      if (done % 10 === 0 || done === mints.length) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        const etaMin = (elapsedMin / done) * (mints.length - done);
        console.log(`  ${done}/${mints.length} tokens (${elapsedMin.toFixed(1)} min elapsed, ~${etaMin.toFixed(0)} min left)`);
      }
    }
  });
  if (includeCache) {
    const fetched = new Set(histories.map((h) => h.mint));
    for (const file of readdirSync(cacheDir)) {
      const mint = file.replace(/\.json$/, "");
      if (fetched.has(mint)) continue;
      histories.push({ mint, ...(JSON.parse(readFileSync(path.join(cacheDir, file), "utf-8")) as { trades: HistoricalTrade[]; truncated: boolean }) });
    }
    console.log(`  + ${histories.length - fetched.size} token histories from earlier runs (--include-cache)`);
  }
  // Coins-API metadata when we have it; otherwise derived from the history.
  const tokens = histories
    .map((h) => {
      const token = apiTokens.get(h.mint) ?? tokenFromTrades(h.mint, h.trades, h.truncated);
      token.truncated = h.truncated;
      return token;
    })
    .filter((t) => t.athMarketCapUsd >= minAth);
  const keep = new Set(tokens.map((t) => t.mint));
  const trades = histories.filter((h) => keep.has(h.mint)).flatMap((h) => h.trades);
  console.log(
    `  ${tokens.length} tokens with ATH >= $${minAth} (${tokens.filter((t) => t.graduated).length} graduated, ` +
      `${tokens.filter((t) => t.truncated).length} truncated); ${trades.length} trades; ${failures.length} failed`,
  );

  const result = scanHistoricalWallets(tokens, trades, { config });
  const passed = result.candidates.filter((c) => c.score.passedHardGate);
  const recommended = passed.filter((c) => c.copyable);
  // Closest copyable wallets to qualifying: fewest failed gate conditions,
  // then highest realized PnL.
  const nearMisses = result.candidates
    .filter((c) => !c.score.passedHardGate && c.copyable)
    .sort((a, b) => a.score.gateFailureReasons.length - b.score.gateFailureReasons.length || b.stats.realizedPnlUsd - a.stats.realizedPnlUsd)
    .slice(0, 15);

  console.log(`\n${result.walletsSeen} wallets traded these tokens; ${result.candidates.length} closed at least one round trip; ${result.ruggedTokens} tokens rugged.`);
  console.log(`${passed.length} pass the shipped hard gate; ${recommended.length} of those look copyable.`);
  // Which conditions the population fails - the calibration view: a
  // condition almost no wallet meets is a threshold the market doesn't match.
  const g = config.walletGate;
  const all = result.candidates;
  const share = (pred: (c: WalletCandidate) => boolean) => `${all.filter(pred).length}/${all.length}`;
  console.log("Wallets meeting each gate condition on its own:");
  console.log({
    [`tradeCount >= ${g.minTradeCount}`]: share((c) => c.stats.tradeCount >= g.minTradeCount),
    [`winRate >= ${g.minWinRate}`]: share((c) => c.stats.winRate >= g.minWinRate),
    [`realizedPnl >= $${g.minRealizedPnlUsd}`]: share((c) => c.stats.realizedPnlUsd >= g.minRealizedPnlUsd),
    [`avgRoi >= ${g.minAvgRoiPct}%`]: share((c) => c.stats.avgRoiPct >= g.minAvgRoiPct),
    [`avgBuy >= $${g.minWhaleBuySizeUsd}`]: share((c) => c.stats.avgWhaleBuySizeUsd >= g.minWhaleBuySizeUsd),
    [`maxDrawdown <= ${g.maxDrawdownPct}%`]: share((c) => c.stats.maxDrawdownPct <= g.maxDrawdownPct),
    [`earlyEntry >= ${g.minEarlyEntryFrequency}`]: share((c) => c.stats.earlyEntryFrequency >= g.minEarlyEntryFrequency),
    [`rugExposure <= ${g.maxRugExposureCount}`]: share((c) => c.stats.rugExposureCount <= g.maxRugExposureCount),
    [`whaleScore >= ${g.minWhaleScore}`]: share((c) => c.score.whaleScore >= g.minWhaleScore),
    copyable: share((c) => c.copyable),
  });
  console.log("");
  console.log("=== Recommended (pass gate, copyable) ===");
  for (const c of recommended) console.log(row(c));
  console.log("\n=== Pass gate but NOT copyable ===");
  for (const c of passed.filter((c) => !c.copyable).slice(0, 15)) console.log(`${row(c)}\n    -> ${c.copyabilityIssues.join("; ")}`);
  console.log("\n=== Closest to qualifying (copyable, fewest failed conditions) ===");
  for (const c of nearMisses) console.log(`${row(c)}\n    -> ${c.score.gateFailureReasons.join("; ")}`);

  const generatedAt = new Date().toISOString();
  const serialize = (c: WalletCandidate) => ({
    address: c.wallet,
    whaleScore: Number(c.score.whaleScore.toFixed(2)),
    passedHardGate: c.score.passedHardGate,
    gateFailureReasons: c.score.gateFailureReasons,
    copyable: c.copyable,
    copyabilityIssues: c.copyabilityIssues,
    distinctTokens: c.distinctTokens,
    medianHoldSeconds: c.medianHoldSeconds,
    stats: c.stats,
  });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt,
        universe: { source, tokens: tokens.length, trades: trades.length, minAthMarketCapUsd: minAth, truncatedTokens: tokens.filter((t) => t.truncated).length },
        recommended: recommended.map(serialize),
        passedButNotCopyable: passed.filter((c) => !c.copyable).map(serialize),
        nearMisses: nearMisses.map(serialize),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath)}`);

  if (apply) {
    const watchlistPath = path.join(REPO_ROOT, "config", "watchlist.json");
    const watchlist = JSON.parse(readFileSync(watchlistPath, "utf-8")) as { wallets: Array<Record<string, unknown>> };
    const existing = new Set(watchlist.wallets.map((w) => w.address));
    const added = recommended.filter((c) => !existing.has(c.wallet));
    for (const c of added) {
      watchlist.wallets.push({
        address: c.wallet,
        label: `discovered-${generatedAt.slice(0, 10)}`,
        notes: `historical scan: score ${c.score.whaleScore.toFixed(1)}, ${c.stats.tradeCount} trades over ${c.distinctTokens} tokens, win ${(c.stats.winRate * 100).toFixed(0)}%, pnl $${c.stats.realizedPnlUsd.toFixed(0)}`,
        status: "pending",
        source: "auto-discovered",
      });
    }
    writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2) + "\n");
    console.log(`Added ${added.length} wallet(s) to config/watchlist.json as "pending" (approve with Telegram /approve).`);
  }
}

main().catch((err) => {
  console.error("whale discovery failed:", err);
  process.exit(1);
});
