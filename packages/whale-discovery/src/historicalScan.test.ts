import { readFileSync } from "node:fs";
import { parseStrategyConfig } from "@whale-sniper/core";
import { describe, expect, it } from "vitest";
import { scanHistoricalWallets, type HistoricalToken, type HistoricalTrade } from "./historicalScan.js";
import { parseCoin, parseTrade, PumpFunHistoryClient, tokenFromTrades } from "./pumpFunHistory.js";

const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../../config/strategy.json", import.meta.url), "utf-8")));

let seq = 0;
function trade(wallet: string, tokenMint: string, side: "BUY" | "SELL", timestampSec: number, usdValue: number, priceUsd: number): HistoricalTrade {
  seq += 1;
  return { txSignature: `tx${seq}`, orderKey: String(seq).padStart(8, "0"), timestampSec, wallet, tokenMint, side, tokenAmount: usdValue / priceUsd, usdValue, priceUsd, venue: "pump" };
}

function token(mint: string, createdAtSec: number, creator?: string): HistoricalToken {
  return { mint, createdAtSec, creator, graduated: false, athMarketCapUsd: 50_000 };
}

/** A wallet that buys $3k early on `n` tokens and sells each at 2x a few minutes later. */
function winningWhale(wallet: string, n: number, t0 = 1_000_000) {
  const tokens: HistoricalToken[] = [];
  const trades: HistoricalTrade[] = [];
  for (let i = 0; i < n; i++) {
    const mint = `${wallet}-T${i}`;
    const launch = t0 + i * 1_000;
    tokens.push(token(mint, launch));
    trades.push(trade(wallet, mint, "BUY", launch + 20, 3_000, 1));
    trades.push(trade(wallet, mint, "SELL", launch + 400, 6_000, 2));
  }
  return { tokens, trades };
}

describe("scanHistoricalWallets", () => {
  it("qualifies a consistently profitable, early, large wallet through the shipped hard gate", () => {
    const { tokens, trades } = winningWhale("WHALE", 20);
    const result = scanHistoricalWallets(tokens, trades, { config });
    const whale = result.candidates.find((c) => c.wallet === "WHALE")!;

    expect(whale.stats.tradeCount).toBe(20);
    expect(whale.stats.earlyEntryFrequency).toBe(1); // bought 20s after real launch
    expect(whale.score.passedHardGate).toBe(true);
    expect(whale.copyable).toBe(true);
    expect(whale.medianHoldSeconds).toBe(380);
    expect(result.candidates[0].wallet).toBe("WHALE");
  });

  it("measures earliness from the token's real launch time, not the first trade observed", () => {
    // Bought 10 minutes after launch, but is the first trade in the data.
    const tokens = [token("T", 1_000)];
    const trades = [trade("W", "T", "BUY", 1_600, 3_000, 1), trade("W", "T", "SELL", 1_700, 6_000, 2)];
    const [w] = scanHistoricalWallets(tokens, trades, { config }).candidates;
    expect(w.stats.earlyEntryFrequency).toBe(0);
  });

  it("marks sub-30s flippers, one-token wallets and deployers as not copyable", () => {
    const tokens = [token("A", 0, "DEV"), token("B", 0), token("C", 0)];
    const trades = [
      ...["A", "B", "C"].flatMap((m) => [trade("BOT", m, "BUY", 10, 3_000, 1), trade("BOT", m, "SELL", 13, 3_300, 1.1)]),
      trade("ONE", "A", "BUY", 10, 3_000, 1),
      trade("ONE", "A", "SELL", 500, 6_000, 2),
      ...["A", "B", "C"].flatMap((m) => [trade("DEV", m, "BUY", 5, 3_000, 1), trade("DEV", m, "SELL", 600, 6_000, 2)]),
    ];
    const byWallet = new Map(scanHistoricalWallets(tokens, trades, { config }).candidates.map((c) => [c.wallet, c]));
    expect(byWallet.get("BOT")!.copyabilityIssues.join()).toMatch(/too fast/);
    expect(byWallet.get("ONE")!.copyabilityIssues.join()).toMatch(/only 1 token/);
    expect(byWallet.get("DEV")!.copyabilityIssues.join()).toMatch(/deployer/);
  });

  it("charges rug exposure only for sells after the collapse, not for exiting before it", () => {
    const tokens = [token("R", 0)];
    const trades = [
      trade("EARLY", "R", "BUY", 10, 3_000, 1),
      trade("LATE", "R", "BUY", 11, 3_000, 1),
      trade("EARLY", "R", "SELL", 60, 9_000, 3), // sells near the top
      trade("DUMPER", "R", "SELL", 70, 100, 0.2), // price collapses below 25% of the 3.0 peak
      trade("LATE", "R", "SELL", 80, 600, 0.2),
    ];
    const result = scanHistoricalWallets(tokens, trades, { config });
    const byWallet = new Map(result.candidates.map((c) => [c.wallet, c]));
    expect(result.ruggedTokens).toBe(1);
    expect(byWallet.get("EARLY")!.stats.rugExposureCount).toBe(0);
    expect(byWallet.get("LATE")!.stats.rugExposureCount).toBe(1);
  });
});

describe("pump.fun API parsing", () => {
  it("parses a live-shaped trade row and rejects malformed ones", () => {
    const raw = {
      slotIndexId: "0004564578130008740000",
      tx: "sig",
      timestamp: "2026-10-13T13:25:30.000Z",
      userAddress: "Wallet",
      type: "sell",
      program: "pump",
      amountUsd: "5.25",
      baseAmount: "1754297.207304",
      priceUsd: "0.0000029934",
      fillPriceUsd: "0.0000029983",
    };
    expect(parseTrade(raw, "Mint")).toMatchObject({
      side: "SELL",
      wallet: "Wallet",
      tokenMint: "Mint",
      timestampSec: Date.parse("2026-10-13T13:25:30.000Z") / 1000,
      usdValue: 5.25,
      priceUsd: 0.0000029983,
      venue: "pump",
    });
    expect(parseTrade({ ...raw, type: "transfer" }, "Mint")).toBeUndefined();
    expect(parseTrade({ ...raw, baseAmount: "0" }, "Mint")).toBeUndefined();
    expect(parseTrade({ ...raw, amountUsd: "NaN" }, "Mint")).toBeUndefined();
  });

  it("parses a coin row, using the larger of ATH and current market cap", () => {
    expect(parseCoin({ mint: "M", created_timestamp: 1_791_309_202_000, creator: "C", complete: true, ath_market_cap: 0, usd_market_cap: 5_499 })).toEqual({
      mint: "M",
      createdAtSec: 1_791_309_202,
      creator: "C",
      graduated: true,
      athMarketCapUsd: 5_499,
    });
    expect(parseCoin({ creator: "C" })).toBeUndefined();
  });

  it("pages a token's trades with the cursor and returns them oldest first", async () => {
    const pages: Record<string, unknown> = {
      first: { trades: [{ tx: "t3", timestamp: "2026-10-13T00:00:03Z", userAddress: "W", type: "buy", amountUsd: "1", baseAmount: "1", priceUsd: "1" }], pagination: { hasMore: true, nextCursor: "c1" } },
      c1: { trades: [{ tx: "t1", timestamp: "2026-10-13T00:00:01Z", userAddress: "W", type: "buy", amountUsd: "1", baseAmount: "1", priceUsd: "1" }], pagination: { hasMore: false } },
    };
    const client = new PumpFunHistoryClient(async (url) => pages[new URL(url).searchParams.get("cursor") ?? "first"]);
    const { trades, truncated } = await client.fetchTrades("M", 10);
    expect(trades.map((t) => t.txSignature)).toEqual(["t1", "t3"]);
    expect(truncated).toBe(false);

    const capped = await client.fetchTrades("M", 1);
    expect(capped.truncated).toBe(true);
  });

  it("derives launch, creator, ATH and graduation from a full history, and stays conservative when truncated", () => {
    const trades = [
      { ...trade("DEV", "M", "BUY", 1_000, 100, 0.000004), venue: "pump" },
      { ...trade("W", "M", "BUY", 1_050, 3_000, 0.00002), venue: "pump" },
      { ...trade("W", "M", "SELL", 2_000, 6_000, 0.00004), venue: "pump_amm" },
    ];
    expect(tokenFromTrades("M", trades, false)).toEqual({
      mint: "M",
      createdAtSec: 1_000,
      creator: "DEV",
      graduated: true,
      athMarketCapUsd: 40_000,
      truncated: false,
    });
    const partial = tokenFromTrades("M", trades.slice(1), true);
    expect(partial.createdAtSec).toBe(0);
    expect(partial.creator).toBeUndefined();
  });

  it("keeps the coins it already listed when the coins API starts throttling", async () => {
    const coin = (mint: string) => ({ mint, created_timestamp: 1_000_000, ath_market_cap: 50_000 });
    const client = new PumpFunHistoryClient(async (url) => {
      const u = new URL(url);
      if (u.searchParams.get("sort") === "created_timestamp") throw new Error("429 from frontend-api-v3.pump.fun/coins");
      if (u.searchParams.get("offset") === "0") return [coin("A"), coin("B")];
      throw new Error("429 from frontend-api-v3.pump.fun/coins");
    });
    const universe = await client.fetchUniverse({ recentLaunches: true, recentlyTraded: true, minAthMarketCapUsd: 10_000, maxTokens: 10 });
    expect(universe.map((t) => t.mint).sort()).toEqual(["A", "B"]);

    const dead = new PumpFunHistoryClient(async () => {
      throw new Error("429");
    });
    await expect(dead.fetchUniverse({ recentLaunches: true, recentlyTraded: true, minAthMarketCapUsd: 0, maxTokens: 10 })).rejects.toThrow("429");
  });
});
