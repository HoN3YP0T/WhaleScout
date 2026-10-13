import { readFileSync } from "node:fs";
import { EventBus, RealClock, RuntimeFlags, createLogger, parseStrategyConfig, type RawFeedEvent, type StrategyConfig } from "@whale-sniper/core";
import { createInMemoryRepositories } from "@whale-sniper/db";
import { FeedManager, MockFeedProvider, decodeTradeEvent, normalWhaleBuyScenario, type DecodableTradePayload } from "@whale-sniper/feed";
import type { IExecutionAdapter } from "@whale-sniper/execution";
import { buildOrchestrator } from "@whale-sniper/orchestrator";
import { describe, expect, it } from "vitest";

const baseConfig = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8")));
const watchlist = JSON.parse(readFileSync(new URL("../../config/watchlist.json", import.meta.url), "utf-8")).wallets;
const logger = createLogger("test", "silent");

async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function run(config: StrategyConfig, events: RawFeedEvent[], scenario = normalWhaleBuyScenario(), executionAdapter?: IExecutionAdapter) {
  const bus = new EventBus();
  const repos = createInMemoryRepositories();
  const built = buildOrchestrator({
    bus,
    clock: new RealClock(),
    config,
    repos,
    runtimeFlags: new RuntimeFlags(),
    watchlist,
    tokenMetadataOverrides: [{ tokenMint: scenario.tokenMint, metadata: scenario.tokenMetadata }],
    executionAdapter,
  });
  built.orchestrator.start();
  await new FeedManager(new MockFeedProvider(events, { playback: "instant" }), bus, logger).start();
  await flush();
  return { repos, built, bus };
}

function payload(e: RawFeedEvent): DecodableTradePayload {
  return e.raw as DecodableTradePayload;
}

describe("SniperOrchestrator risk limits", () => {
  it("does not let two back-to-back whale buys both slip under maxOpenPositions", async () => {
    const scenario = normalWhaleBuyScenario();
    const config = structuredClone(baseConfig);
    config.risk.maxOpenPositions = 1;

    // Duplicate every whale BUY on the scenario token right after itself, as
    // a second transaction - both are handled concurrently off the same
    // synchronous replay.
    const events: RawFeedEvent[] = [];
    for (const e of scenario.events) {
      events.push(e);
      const p = payload(e);
      if (p.wallet === scenario.whaleWallet && p.tokenMint === scenario.tokenMint && p.side === "BUY") {
        events.push({ ...e, txSignature: `${e.txSignature}_dup` });
      }
    }

    const { repos } = await run(config, events, scenario);
    const opened = (await repos.position.allPositions()).filter((p) => p.tokenMint === scenario.tokenMint);
    expect(opened.length).toBe(1);
  });

  it("records a losing close in the risk engine, so consecutive-loss and cooldown limits can trip", async () => {
    const scenario = normalWhaleBuyScenario();
    const { repos, bus } = await run(baseConfig, scenario.events, scenario);
    const [position] = (await repos.position.getOpenPositions()).filter((p) => p.tokenMint === scenario.tokenMint);
    expect(position, "scenario should open a position").toBeDefined();

    // Crash the price well through the initial stop loss.
    const last = scenario.events[scenario.events.length - 1];
    const crash: RawFeedEvent = {
      ...last,
      txSignature: "crashTx",
      blockTime: last.blockTime + 5,
      raw: { ...payload(last), wallet: "SomeoneElse111", side: "SELL", priceUsd: position.entryPriceUsd * 0.5 },
    };
    bus.emit("trade.normalized", decodeTradeEvent(crash));
    await flush();

    const closed = (await repos.position.allPositions()).filter((p) => p.tokenMint === scenario.tokenMint && p.status === "CLOSED");
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[0].realizedPnlUsd).toBeLessThan(0);

    const state = await repos.riskState.get();
    expect(state.consecutiveLosses).toBe(closed.length);
    expect(state.dailyLossUsd).toBeGreaterThan(0);
    expect(state.cooldownUntil).toBeGreaterThan(0);
  });

  it("turns an execution adapter that throws into a failed order instead of an unhandled rejection", async () => {
    const scenario = normalWhaleBuyScenario();
    const throwing: IExecutionAdapter = {
      name: "throwing",
      submitOrder: async () => {
        throw new Error("rpc unavailable");
      },
    };
    const { repos, built, bus } = await run(baseConfig, [], scenario, throwing);
    const rejections: string[] = [];
    bus.on("signal.rejected", ({ reason }) => rejections.push(reason));
    for (const e of scenario.events) bus.emit("trade.normalized", decodeTradeEvent(e));
    await flush();

    expect(await repos.position.allPositions()).toHaveLength(0);
    expect(rejections.some((r) => r.includes("rpc unavailable"))).toBe(true);
    const metrics = built.metrics.snapshot();
    expect(metrics.ordersFailed).toBeGreaterThan(0);
    expect(metrics.ordersFailed).toBe(metrics.ordersSubmitted);
  });
});
