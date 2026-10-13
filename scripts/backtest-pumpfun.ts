/**
 * Backtest on REAL pump.fun history: replays the trade histories cached by
 * scripts/discover-whales.ts (.cache/pump-trades) through the unmodified
 * live pipeline (runReplay -> buildOrchestrator), PAPER execution, a
 * SimulatedClock, and prints a profit report per strategy variant.
 *
 *   npx tsx scripts/backtest-pumpfun.ts                 # all variants
 *   npx tsx scripts/backtest-pumpfun.ts --only baseline
 *
 * How the replay stands in for live inputs (all no-lookahead):
 * - Whales: none are pre-selected (that would be lookahead - the cached
 *   data is what discovery itself scored). walletDiscovery runs with
 *   autoPromote, so a wallet becomes tradeable only once its OWN replayed
 *   history has cleared config/strategy.json's walletGate.
 * - Liquidity: derived per trade from the trade's price. On the bonding
 *   curve price fixes the virtual reserves exactly (vSol * vTok = 30 SOL *
 *   1.073B tokens, verified against live events), so real SOL reserves =
 *   sqrt(k * priceSol) - 30. On PumpSwap the same constant-product identity
 *   is applied to the pool seeded at graduation (~85 SOL / ~206.9M tokens),
 *   which ignores later LP adds/removes.
 * - Token metadata: pump.fun mints have mint and freeze authority revoked
 *   (verified live); top-10 holder concentration is unknown historically and
 *   is an ASSUMPTION (--top10, default 0.5).
 * - SOL/USD: trades carry USD at trade time; liquidity uses --sol (107).
 *
 * Venue modes: "curve" replays only bonding-curve trades - what the live
 * feed sees today - so positions in tokens that graduate get no further
 * price ticks. "all" adds PumpSwap (and older AMM) trades.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrategyConfig, type NormalizedTradeEvent, type Position, type RawFeedEvent, type StrategyConfig } from "@whale-sniper/core";
import { buildReport, runReplay } from "@whale-sniper/backtest";
import type { DecodableTradePayload } from "@whale-sniper/feed";
import type { ITokenMetadataProvider, TokenMetadataSeed } from "@whale-sniper/token-intel";
import { venueToDex, type HistoricalTrade } from "@whale-sniper/whale-discovery";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const SOL_USD = arg("--sol", 107);
const TOP10 = arg("--top10", 0.5);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const recording = process.argv.includes("--recording") ? process.argv[process.argv.indexOf("--recording") + 1] : undefined;

const CURVE_K = 30 * 1_073_000_000; // virtual SOL x virtual tokens
const CURVE_VIRTUAL_SOL = 30;
const AMM_K = 85 * 206_900_000; // pool seeded at graduation

function poolLiquidityUsd(t: HistoricalTrade): number | undefined {
  const priceSol = t.priceUsd / SOL_USD;
  if (!(priceSol > 0)) return undefined;
  if (t.venue === "pump") return 2 * Math.max(0, Math.sqrt(CURVE_K * priceSol) - CURVE_VIRTUAL_SOL) * SOL_USD;
  if (t.venue === "pump_amm") return 2 * Math.sqrt(AMM_K * priceSol) * SOL_USD;
  return undefined;
}

class PumpFunHistoricalMetadata implements ITokenMetadataProvider {
  constructor(private readonly top10: number) {}
  get(): TokenMetadataSeed {
    // Liquidity comes from each trade (poolLiquidityUsd), which wins over this.
    return { liquidityUsd: 0, marketCapUsd: 0, holderCount: 0, top10HolderPct: this.top10, mintAuthorityRevoked: true, freezeAuthorityRevoked: true };
  }
}

function loadTrades(): HistoricalTrade[] {
  const dir = path.join(REPO_ROOT, ".cache", "pump-trades");
  const trades = readdirSync(dir).flatMap((f) => (JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as { trades: HistoricalTrade[] }).trades);
  const seen = new Set<string>();
  return trades
    .filter((t) => {
      const key = `${t.txSignature}:${t.orderKey}:${t.wallet}:${t.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestampSec - b.timestampSec || (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

/** A feed recording (scripts/record-feed.ts): the exact events the bot saw,
 * with on-chain liquidity. "latest" picks the newest recording. */
function loadRecording(spec: string): RawFeedEvent[] {
  const dir = path.join(REPO_ROOT, ".cache", "feed-recordings");
  const file = spec === "latest" ? path.join(dir, readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().at(-1)!) : path.resolve(spec);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const events: NormalizedTradeEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as NormalizedTradeEvent);
    } catch {
      // a recording still being written can end in a partial line
    }
  }
  return events.map((e) => {
    const payload: DecodableTradePayload = {
      wallet: e.wallet,
      tokenMint: e.tokenMint,
      side: e.side,
      tokenAmount: e.tokenAmount,
      usdValue: e.usdValue,
      priceUsd: e.priceUsd,
      dex: e.dex,
      pool: e.pool,
      poolLiquidityUsd: e.poolLiquidityUsd,
    };
    return { provider: "recording", txSignature: e.txSignature, slot: e.slot, blockTime: e.blockTime, raw: payload, receivedAt: e.timestamps.rawReceivedAt };
  });
}

function toEvents(trades: HistoricalTrade[], venues: "curve" | "all"): RawFeedEvent[] {
  return trades
    .filter((t) => venues === "all" || t.venue === "pump")
    .map((t) => {
      const payload: DecodableTradePayload = {
        wallet: t.wallet,
        tokenMint: t.tokenMint,
        side: t.side,
        tokenAmount: t.tokenAmount,
        usdValue: t.usdValue,
        priceUsd: t.priceUsd,
        dex: venueToDex(t.venue),
        pool: t.tokenMint,
        poolLiquidityUsd: poolLiquidityUsd(t),
      };
      return { provider: "pumpfun-history", txSignature: t.txSignature, slot: 0, blockTime: t.timestampSec, raw: payload, receivedAt: t.timestampSec * 1000 };
    });
}

interface Variant {
  name: string;
  venues: "curve" | "all";
  apply: (c: StrategyConfig) => void;
}

const REAL_FEE_PCT = 1.25; // measured live: 0.95% protocol + 0.30% creator

/** minCoordinatedTokens: 2 - see clusterThresholdsSchema. Every
 * improvement experiment below builds on it, because without it the
 * cluster check rejects every discovered whale and nothing trades. */
const coord2 = (c: StrategyConfig) => (c.clusterThresholds.minCoordinatedTokens = 2);
const on = (...fs: Array<(c: StrategyConfig) => void>) => (c: StrategyConfig) => fs.forEach((f) => f(c));

/** Any wallet with one closed round trip becomes followable: removes the
 * whale-quality filter so every other stage (min buy size, entry gate,
 * token risk, risk engine, exits) is tested on far more entries. */
const openGate = (c: StrategyConfig) =>
  Object.assign(c.walletGate, {
    minTradeCount: 1,
    minWinRate: 0,
    minRealizedPnlUsd: -1e9,
    minAvgRoiPct: -1e9,
    maxDrawdownPct: 1e9,
    maxRugExposureCount: 1e6,
    minWhaleScore: 0,
  });

/** Entry gate without its two unreachable knobs (min signal score, max
 * token risk); liquidity, age, buyer, momentum and cluster-flag checks stay. */
const openEntry = (c: StrategyConfig) => Object.assign(c.entryGate, { minSignalScore: 0 }) && Object.assign(c.tokenThresholds, { maxTokenRiskScore: 100 });
/** No consecutive-loss halt / daily loss stop / cooldown, so the raw edge of
 * every eligible entry is measured. */
const noHalt = (c: StrategyConfig) => Object.assign(c.risk, { maxConsecutiveLosses: 1_000_000, maxDailyLossUsd: 1e12, cooldownSecondsAfterLoss: 0 });
const edge = on(coord2, openGate, openEntry, noHalt);

const VARIANTS: Variant[] = [
  { name: "edge", venues: "curve", apply: edge },
  { name: "edge+risk-halts", venues: "curve", apply: on(coord2, openGate, openEntry) },
  { name: "edge+fee-0.25%", venues: "curve", apply: on(edge, (c) => (c.execution.dexFeePct = 0.25)) },
  { name: "edge+all-venues", venues: "all", apply: on(edge, (c) => c.tokenThresholds.allowedDexes.push("pumpswap")) },
  { name: "edge+stop-10%", venues: "curve", apply: on(edge, (c) => (c.position.initialStopLossPct = 10)) },
  { name: "edge+stop-35%", venues: "curve", apply: on(edge, (c) => (c.position.initialStopLossPct = 35)) },
  { name: "edge+hold-10m", venues: "curve", apply: on(edge, (c) => (c.position.maxHoldTimeSeconds = 600)) },
  {
    name: "edge+fast-tp",
    venues: "curve",
    apply: on(edge, (c) => {
      c.position.takeProfitLadder = [
        { triggerPct: 15, sellFraction: 0.4 },
        { triggerPct: 35, sellFraction: 0.3 },
        { triggerPct: 75, sellFraction: 0.3 },
      ];
      c.position.trailingActivationPct = 15;
      c.position.trailingTrailPct = 10;
    }),
  },
  { name: "edge+min-buy-$1000", venues: "curve", apply: on(edge, (c) => (c.walletGate.minWhaleBuySizeUsd = 1000)) },
  { name: "edge+liq>=$8k", venues: "curve", apply: on(edge, (c) => (c.tokenThresholds.minLiquidityUsd = 8000)) },
  { name: "open-gate", venues: "curve", apply: on(coord2, openGate) },
  { name: "open-gate+all-venues", venues: "all", apply: on(coord2, openGate, (c) => c.tokenThresholds.allowedDexes.push("pumpswap")) },
  { name: "baseline", venues: "curve", apply: () => {} },
  { name: "coord2", venues: "curve", apply: coord2 },
  { name: "coord2+fee-0.25%", venues: "curve", apply: on(coord2, (c) => (c.execution.dexFeePct = 0.25)) },
  { name: "coord2+all-venues", venues: "all", apply: on(coord2, (c) => c.tokenThresholds.allowedDexes.push("pumpswap")) },
  { name: "coord2+stop-10%", venues: "curve", apply: on(coord2, (c) => (c.position.initialStopLossPct = 10)) },
  { name: "coord2+stop-35%", venues: "curve", apply: on(coord2, (c) => (c.position.initialStopLossPct = 35)) },
  { name: "coord2+hold-30m", venues: "curve", apply: on(coord2, (c) => (c.position.maxHoldTimeSeconds = 1800)) },
  {
    name: "coord2+fast-tp",
    venues: "curve",
    apply: on(coord2, (c) => {
      c.position.takeProfitLadder = [
        { triggerPct: 15, sellFraction: 0.4 },
        { triggerPct: 35, sellFraction: 0.3 },
        { triggerPct: 75, sellFraction: 0.3 },
      ];
      c.position.trailingActivationPct = 15;
      c.position.trailingTrailPct = 10;
    }),
  },
  { name: "coord2+signal>=75", venues: "curve", apply: on(coord2, (c) => (c.entryGate.minSignalScore = 75)) },
  { name: "coord2+signal>=55", venues: "curve", apply: on(coord2, (c) => (c.entryGate.minSignalScore = 55)) },
  {
    name: "coord2+strict-whales",
    venues: "curve",
    apply: on(coord2, (c) => Object.assign(c.walletGate, { minTradeCount: 10, minRealizedPnlUsd: 1000, minWinRate: 0.6 })),
  },
];

interface VariantResult {
  name: string;
  opened: number;
  closed: number;
  stillOpen: number;
  winRate: number;
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
  profitFactor: number;
  maxDrawdownPct: number;
  feesUsd: number;
  investedUsd: number;
  returnOnCapitalPct: number;
  firstHalfUsd: number;
  secondHalfUsd: number;
  exitReasons: Record<string, number>;
  medianHoldMin?: number;
  promoted: number;
  signals: number;
  positions: Position[];
}

function pnlOf(p: Position): number {
  return p.realizedPnlUsd + (p.status === "OPEN" ? p.unrealizedPnlUsd : 0);
}

async function runVariant(v: Variant, base: StrategyConfig, eventsFor: (venues: Variant["venues"]) => RawFeedEvent[], splitSec: number): Promise<VariantResult> {
  const config = structuredClone(base);
  config.walletDiscovery = { enabled: true, autoPromote: true };
  config.execution.dexFeePct = REAL_FEE_PCT;
  v.apply(config);
  const events = eventsFor(v.venues);
  const rejections = new Map<string, number>();
  const promotedAt = new Map<string, number>();
  let whaleBuysAfterPromotion = 0;
  let whaleBuysBigEnough = 0;
  const replay = await runReplay(events, {
    config,
    watchlist: [],
    tokenMetadataProvider: new PumpFunHistoricalMetadata(TOP10),
    settleRoundsPerEvent: 1,
    observe: (bus) => {
      bus.on("signal.rejected", ({ reason }) => {
        if (process.env.BT_CONDS) {
          const conds = reason.split("; ").map((r) => r.replace(/-?\$?[\d.]+%?s?/g, "#").replace(/ max #| min #/, ""));
          const k = conds.length === 1 ? `ONLY ${conds[0]}` : `${conds.length} conditions incl. ${conds[0]}`;
          rejections.set(k, (rejections.get(k) ?? 0) + 1);
          for (const c of conds) rejections.set(`  any: ${c}`, (rejections.get(`  any: ${c}`) ?? 0) + 1);
          return;
        }
        // First reason, numbers stripped, so identical causes group together.
        const key = process.env.BT_RAW ? reason : reason.split("; ")[0].replace(/-?\$?[\d.]+%?s?/g, "#");
        rejections.set(key, (rejections.get(key) ?? 0) + 1);
      });
      bus.on("wallet.discovery-promoted", ({ wallet }) => promotedAt.set(wallet, 0));
      bus.on("trade.normalized", (e) => {
        if (e.side !== "BUY" || !promotedAt.has(e.wallet)) return;
        whaleBuysAfterPromotion += 1;
        if (e.usdValue >= config.walletGate.minWhaleBuySizeUsd) whaleBuysBigEnough += 1;
      });
    },
  });
  if (process.env.BT_DEBUG) {
    console.log(`  [debug ${v.name}] whale buys after promotion: ${whaleBuysAfterPromotion} (>= $${config.walletGate.minWhaleBuySizeUsd}: ${whaleBuysBigEnough})`);
    console.log(`  [debug ${v.name}] rejections:`, [...rejections].sort((a, b) => b[1] - a[1]).slice(0, 20));
  }
  const positions = replay.positions;
  const report = buildReport(positions, replay.signals);
  const closed = positions.filter((p) => p.status === "CLOSED");
  const open = positions.filter((p) => p.status === "OPEN");
  const exitReasons: Record<string, number> = {};
  for (const p of closed) exitReasons[p.exitReason ?? "?"] = (exitReasons[p.exitReason ?? "?"] ?? 0) + 1;
  const holds = closed.map((p) => ((p.closedAt ?? 0) - p.openedAt) / 60_000).sort((a, b) => a - b);
  const realizedUsd = positions.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const unrealizedUsd = open.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const investedUsd = positions.reduce((s, p) => s + p.entryUsdValue, 0);
  const promoted = (await replay.repos.watchlist.listByStatus("active")).length;
  const rejected = (await replay.repos.watchlist.listByStatus("rejected")).length;
  if (process.env.BT_DEBUG) console.log(`  [debug ${v.name}] events ${events.length}, promoted ${promoted}, cluster-rejected ${rejected}`);
  return {
    name: v.name,
    opened: positions.length,
    closed: closed.length,
    stillOpen: open.length,
    winRate: report.winRate,
    realizedUsd,
    unrealizedUsd,
    totalUsd: realizedUsd + unrealizedUsd,
    profitFactor: report.profitFactor,
    maxDrawdownPct: report.maxDrawdownPct,
    feesUsd: positions.reduce((s, p) => s + p.feesUsd, 0),
    investedUsd,
    returnOnCapitalPct: investedUsd > 0 ? ((realizedUsd + unrealizedUsd) / investedUsd) * 100 : 0,
    firstHalfUsd: positions.filter((p) => p.openedAt < splitSec * 1000).reduce((s, p) => s + pnlOf(p), 0),
    secondHalfUsd: positions.filter((p) => p.openedAt >= splitSec * 1000).reduce((s, p) => s + pnlOf(p), 0),
    exitReasons,
    medianHoldMin: holds.length ? holds[Math.floor(holds.length / 2)] : undefined,
    promoted,
    signals: replay.signals.length,
    positions,
  };
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

async function main(): Promise<void> {
  const base = parseStrategyConfig(JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "strategy.json"), "utf-8")));
  let eventsFor: (venues: Variant["venues"]) => RawFeedEvent[];
  let splitSec: number;
  if (recording) {
    const recorded = loadRecording(recording);
    eventsFor = () => recorded;
    splitSec = recorded[Math.floor(recorded.length / 2)].blockTime;
    console.log(
      `Data: feed recording, ${recorded.length} real bonding-curve trades, ${new Set(recorded.map((e) => (e.raw as DecodableTradePayload).tokenMint)).size} tokens, ` +
        `${new Date(recorded[0].blockTime * 1000).toISOString()} .. ${new Date(recorded[recorded.length - 1].blockTime * 1000).toISOString()}`,
    );
  } else {
    const trades = loadTrades();
    const curve = trades.filter((t) => t.venue === "pump");
    splitSec = curve[Math.floor(curve.length / 2)].timestampSec;
    eventsFor = (venues) => toEvents(trades, venues);
    console.log(
      `Data: ${trades.length} real trades (${curve.length} bonding-curve), ${new Set(trades.map((t) => t.tokenMint)).size} tokens, ` +
        `${new Date(trades[0].timestampSec * 1000).toISOString()} .. ${new Date(trades[trades.length - 1].timestampSec * 1000).toISOString()}`,
    );
  }
  console.log(`Halves split at ${new Date(splitSec * 1000).toISOString()} (median bonding-curve trade). Fee ${REAL_FEE_PCT}%/trade unless noted; top10 assumption ${TOP10}.\n`);

  const results: VariantResult[] = [];
  for (const v of VARIANTS.filter((x) => !only || x.name === only)) {
    const t0 = Date.now();
    if (recording && v.venues === "all") continue; // a recording is bonding-curve only
    const r = await runVariant(v, base, eventsFor, splitSec);
    results.push(r);
    console.log(
      `${r.name.padEnd(18)} opened ${String(r.opened).padStart(3)} (open ${r.stillOpen})  win ${(r.winRate * 100).toFixed(0).padStart(3)}%  ` +
        `total ${usd(r.totalUsd).padStart(10)} on ${usd(r.investedUsd)} (${r.returnOnCapitalPct.toFixed(1)}%)  PF ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf"}  ` +
        `fees ${usd(r.feesUsd)}  halves ${usd(r.firstHalfUsd)} / ${usd(r.secondHalfUsd)}  exits ${JSON.stringify(r.exitReasons)}  ` +
        `whales ${r.promoted}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`,
    );
  }

  const baseline = results.find((r) => r.name === "coord2") ?? results.find((r) => r.name === "baseline");
  if (baseline) {
    console.log(`\n${baseline.name} trades:`);
    for (const p of baseline.positions.sort((a, b) => a.openedAt - b.openedAt)) {
      console.log(
        `  ${new Date(p.openedAt).toISOString().slice(5, 16)} ${p.tokenMint.slice(0, 6)}.. whale ${p.whaleState.wallet.slice(0, 6)}.. ` +
          `in ${usd(p.entryUsdValue)} -> ${p.status === "OPEN" ? "OPEN" : p.exitReason} after ${(((p.closedAt ?? p.openedAt) - p.openedAt) / 60_000).toFixed(1)}m  ` +
          `pnl ${usd(pnlOf(p))} (fees ${usd(p.feesUsd)}, mfe ${p.mfePct.toFixed(0)}%, mae ${p.maePct.toFixed(0)}%)`,
      );
    }
  }

  const out = path.join(REPO_ROOT, ".cache", "backtest-pumpfun.json");
  writeFileSync(out, JSON.stringify(results.map(({ positions, ...r }) => ({ ...r, positions: positions.map((p) => ({ ...p })) })), null, 2));
  console.log(`\nWrote ${path.relative(REPO_ROOT, out)}`);
}

main().catch((err) => {
  console.error("backtest failed:", err);
  process.exit(1);
});
