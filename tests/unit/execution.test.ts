import { readFileSync } from "node:fs";
import { EventBus, RuntimeFlags, parseStrategyConfig } from "@whale-sniper/core";
import { InMemoryPositionRepository, InMemoryRiskStateRepository } from "@whale-sniper/db";
import { LiveExecutionAdapter, LiveTradingDisabledError, PaperExecutionAdapter, RiskEngine, selectExecutionAdapterKind } from "@whale-sniper/execution";
import { describe, expect, it } from "vitest";

const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8")));

function env(overrides: Partial<Record<string, any>> = {}) {
  return {
    DATABASE_URL: "",
    FEED_PROVIDER: "mock" as const,
    HELIUS_API_KEY: "",
    SOLANA_RPC_URL: "",
    SOLANA_WS_URL: "",
    TOKEN_DATA_PROVIDER: "mock" as const,
    SOLSCAN_API_KEY: "",
    WALLET_RELATIONSHIP_SOURCE: "mock" as const,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    LIVE_TRADING_ENABLED: false,
    HOT_WALLET_KEYPAIR_PATH: "",
    HOT_WALLET_MAX_BALANCE_USD: 0,
    LOG_LEVEL: "info" as const,
    HEALTH_PORT: 3001,
    ...overrides,
  };
}

describe("execution adapter selection", () => {
  it("defaults to paper when live trading is disabled", () => {
    expect(selectExecutionAdapterKind(env())).toBe("paper");
  });

  it("stays on paper if live is enabled but wallet config is missing", () => {
    expect(selectExecutionAdapterKind(env({ LIVE_TRADING_ENABLED: true }))).toBe("paper");
  });

  it("only selects live when fully configured", () => {
    expect(
      selectExecutionAdapterKind(
        env({ LIVE_TRADING_ENABLED: true, HOT_WALLET_KEYPAIR_PATH: "/tmp/key.json", HOT_WALLET_MAX_BALANCE_USD: 100 }),
      ),
    ).toBe("live");
  });

  it("refuses to construct LiveExecutionAdapter when disabled", () => {
    expect(() => new LiveExecutionAdapter(env())).toThrow(LiveTradingDisabledError);
  });

  it("LiveExecutionAdapter.submitOrder is not implemented even when constructible", async () => {
    const adapter = new LiveExecutionAdapter(
      env({ LIVE_TRADING_ENABLED: true, HOT_WALLET_KEYPAIR_PATH: "/tmp/key.json", HOT_WALLET_MAX_BALANCE_USD: 100 }),
    );
    await expect(adapter.submitOrder({ tokenMint: "T", side: "BUY", usdValue: 100, quotePriceUsd: 1, liquidityUsd: 10000 })).rejects.toThrow(
      "not implemented",
    );
  });
});

describe("PaperExecutionAdapter", () => {
  it("fills a buy order with a realistic price and fee", async () => {
    const adapter = new PaperExecutionAdapter(config);
    const result = await adapter.submitOrder({ tokenMint: "T", side: "BUY", usdValue: 500, quotePriceUsd: 1, liquidityUsd: 50000 });
    expect(result.success).toBe(true);
    expect(result.filledPriceUsd).toBeGreaterThan(1);
    expect(result.tokenAmount).toBeGreaterThan(0);
    expect(result.feesUsd).toBeGreaterThan(0);
  });
});

describe("RiskEngine", () => {
  it("vetoes a trade above the max trade size", async () => {
    const engine = new RiskEngine(new InMemoryRiskStateRepository(), new RuntimeFlags());
    const veto = await engine.evaluate(
      {
        tradeSizeUsd: config.risk.maxTradeSizeUsd * 2,
        tokenMint: "T",
        estimatedSlippagePct: 1,
        estimatedTxCostUsd: 1,
        openPositionsCount: 0,
        totalExposureUsd: 0,
        perTokenExposureUsd: 0,
        perClusterExposureUsd: 0,
      },
      config,
    );
    expect(veto.vetoed).toBe(true);
  });

  it("vetoes any trade once the kill switch is active", async () => {
    const flags = new RuntimeFlags();
    flags.kill();
    const engine = new RiskEngine(new InMemoryRiskStateRepository(), flags);
    const veto = await engine.evaluate(
      {
        tradeSizeUsd: 10,
        tokenMint: "T",
        estimatedSlippagePct: 1,
        estimatedTxCostUsd: 1,
        openPositionsCount: 0,
        totalExposureUsd: 0,
        perTokenExposureUsd: 0,
        perClusterExposureUsd: 0,
      },
      config,
    );
    expect(veto.vetoed).toBe(true);
    expect(veto.reason).toContain("kill switch");
  });

  it("passes a small, well within-limits trade", async () => {
    const engine = new RiskEngine(new InMemoryRiskStateRepository(), new RuntimeFlags());
    const veto = await engine.evaluate(
      {
        tradeSizeUsd: 200,
        tokenMint: "T",
        estimatedSlippagePct: 1,
        estimatedTxCostUsd: 1,
        openPositionsCount: 0,
        totalExposureUsd: 0,
        perTokenExposureUsd: 0,
        perClusterExposureUsd: 0,
      },
      config,
    );
    expect(veto.vetoed).toBe(false);
  });
});

describe("RiskEngine.recordTradeResult", () => {
  it("counts every loss when several closes are recorded concurrently", async () => {
    const repo = new InMemoryRiskStateRepository();
    const engine = new RiskEngine(repo, new RuntimeFlags());
    await Promise.all([engine.recordTradeResult(-10, config), engine.recordTradeResult(-20, config), engine.recordTradeResult(-30, config)]);
    const state = await repo.get();
    expect(state.consecutiveLosses).toBe(3);
    expect(state.dailyLossUsd).toBe(60);
  });
});

describe("RiskEngine circuit breakers recover", () => {
  const input = {
    tradeSizeUsd: 100,
    tokenMint: "T",
    estimatedSlippagePct: 1,
    estimatedTxCostUsd: 1,
    openPositionsCount: 0,
    totalExposureUsd: 0,
    perTokenExposureUsd: 0,
    perClusterExposureUsd: 0,
  };

  it("pauses after max consecutive losses, then trades again without needing a win", async () => {
    let now = 1_000_000_000;
    const repo = new InMemoryRiskStateRepository();
    const engine = new RiskEngine(repo, new RuntimeFlags(), () => now);
    for (let i = 0; i < config.risk.maxConsecutiveLosses; i++) await engine.recordTradeResult(-10, config);

    expect((await engine.evaluate(input, config)).vetoed).toBe(true);
    now += config.risk.consecutiveLossPauseSeconds * 1000 + 1;
    expect((await engine.evaluate(input, config)).vetoed).toBe(false);
    expect((await repo.get()).consecutiveLosses).toBe(0);
  });

  it("lets the daily loss limit expire after 24h even though no trade has closed since", async () => {
    let now = Date.now();
    const repo = new InMemoryRiskStateRepository();
    await repo.update({ dailyLossUsd: config.risk.maxDailyLossUsd, dailyLossResetAt: now });
    const engine = new RiskEngine(repo, new RuntimeFlags(), () => now);

    expect((await engine.evaluate(input, config)).reason).toMatch(/daily loss/);
    now += 24 * 60 * 60 * 1000 + 1;
    expect((await engine.evaluate(input, config)).vetoed).toBe(false);
  });
});

describe("EventBus sanity for execution", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = new EventBus();
    let received: unknown;
    bus.on("signal.rejected", (payload) => (received = payload));
    bus.emit("signal.rejected", { tokenMint: "T", reason: "test" });
    expect(received).toEqual({ tokenMint: "T", reason: "test" });
  });
});
