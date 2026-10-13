import { readFileSync } from "node:fs";
import { EventBus, parseStrategyConfig, type NormalizedTradeEvent, type Signal, type TokenStats } from "@whale-sniper/core";
import { InMemoryPositionRepository } from "@whale-sniper/db";
import { openPaperPosition } from "@whale-sniper/paper-trading";
import { PositionManager } from "@whale-sniper/position-mgmt";
import { evaluateWhaleExitTier, WhaleExitMonitor } from "@whale-sniper/whale-exit";
import { describe, expect, it } from "vitest";

const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8")));

describe("evaluateWhaleExitTier", () => {
  const noFlags = { multipleExits: false, coordinatedClusterSelling: false, liquidityDeteriorating: false, volumeReversal: false };

  it("stays NONE below the warn threshold", () => {
    const result = evaluateWhaleExitTier({ cumulativeSoldFraction: 0.05, flags: noFlags }, config.whaleExit);
    expect(result.tier).toBe("NONE");
  });

  it("reaches WARN at the warn threshold", () => {
    const result = evaluateWhaleExitTier({ cumulativeSoldFraction: 0.15, flags: noFlags }, config.whaleExit);
    expect(result.tier).toBe("WARN");
  });

  it("reaches REDUCE at the reduce threshold", () => {
    const result = evaluateWhaleExitTier({ cumulativeSoldFraction: 0.35, flags: noFlags }, config.whaleExit);
    expect(result.tier).toBe("REDUCE");
  });

  it("reaches EMERGENCY at the emergency threshold", () => {
    const result = evaluateWhaleExitTier({ cumulativeSoldFraction: 0.65, flags: noFlags }, config.whaleExit);
    expect(result.tier).toBe("EMERGENCY");
  });

  it("escalates to EMERGENCY on coordinated cluster selling even with a low sold fraction", () => {
    const result = evaluateWhaleExitTier(
      { cumulativeSoldFraction: 0.02, flags: { ...noFlags, coordinatedClusterSelling: true } },
      config.whaleExit,
    );
    expect(result.tier).toBe("EMERGENCY");
  });

  it("escalates to REDUCE on liquidity deterioration even with a low sold fraction", () => {
    const result = evaluateWhaleExitTier({ cumulativeSoldFraction: 0.02, flags: { ...noFlags, liquidityDeteriorating: true } }, config.whaleExit);
    expect(result.tier).toBe("REDUCE");
  });
});

function tokenStats(): TokenStats {
  return {
    tokenMint: "T",
    createdAt: 0,
    liquidityUsd: 50000,
    marketCapUsd: 200000,
    holderCount: 100,
    top10HolderPct: 0.3,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    uniqueBuyers1h: 10,
    uniqueSellers1h: 2,
    buyVolumeUsd5m: 3000,
    sellVolumeUsd5m: 200,
    buyVolumeUsd1h: 10000,
    sellVolumeUsd1h: 1000,
    updatedAt: Date.now(),
  };
}

function signal(): Signal {
  return {
    signalId: "s1",
    tokenMint: "T",
    triggeringWallet: "W",
    triggeringTxSignature: "tx1",
    components: {
      whaleQuality: 80,
      tokenQuality: 80,
      liquidity: 80,
      buyingMomentum: 80,
      independentBuyers: 80,
      earlyEntryQuality: 80,
      manipulationPenalty: 0,
    },
    score: 80,
    generatedAt: Date.now(),
  };
}

function sellEvent(wallet: string, tokenAmount: number, priceUsd = 1): NormalizedTradeEvent {
  return {
    id: `sell-${Math.random()}`,
    wallet,
    tokenMint: "T",
    side: "SELL",
    tokenAmount,
    usdValue: tokenAmount * priceUsd,
    priceUsd,
    dex: "raydium",
    pool: "T-pool",
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    txSignature: `sig-${Math.random()}`,
    timestamps: { rawReceivedAt: Date.now() },
  };
}

describe("WhaleExitMonitor end-to-end tiers", () => {
  it("drives a full emergency exit once the whale dumps past the emergency threshold", async () => {
    const bus = new EventBus();
    const repo = new InMemoryPositionRepository();
    const manager = new PositionManager(bus, repo, config);
    const position = openPaperPosition(signal(), "W", "tx1", tokenStats(), 1000, 1, config);
    const monitor = new WhaleExitMonitor(bus, manager, config);

    const whaleEntryTokenAmount = 10000;
    monitor.track(position, whaleEntryTokenAmount);
    monitor.start();

    let detected = false;
    bus.on("whale.exit-detected", () => (detected = true));

    bus.emit("trade.normalized", sellEvent("W", whaleEntryTokenAmount * 0.7));

    expect(detected).toBe(true);
    expect(position.status).toBe("CLOSED");
    expect(position.exitReason).toBe("WHALE_EXIT_EMERGENCY");
  });

  it("applies a REDUCE exit once, not again on every further whale sell within the same tier", async () => {
    const bus = new EventBus();
    const manager = new PositionManager(bus, new InMemoryPositionRepository(), config);
    const position = openPaperPosition(signal(), "W", "tx1", tokenStats(), 1000, 1, config);
    const monitor = new WhaleExitMonitor(bus, manager, config);
    monitor.track(position, 10000);
    monitor.start();

    bus.emit("trade.normalized", sellEvent("W", 3500)); // 35% -> REDUCE
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterFirst = position.remainingTokenAmount;
    expect(afterFirst).toBeCloseTo(position.tokenAmount * (1 - config.whaleExit.reduceSellFraction));

    bus.emit("trade.normalized", sellEvent("W", 500)); // 40% -> still REDUCE
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(position.remainingTokenAmount).toBe(afterFirst);
    expect(position.status).toBe("OPEN");
  });

  it("does not touch the position for a small whale sell below the warn threshold", async () => {
    const bus = new EventBus();
    const repo = new InMemoryPositionRepository();
    const manager = new PositionManager(bus, repo, config);
    const position = openPaperPosition(signal(), "W", "tx1", tokenStats(), 1000, 1, config);
    const monitor = new WhaleExitMonitor(bus, manager, config);

    monitor.track(position, 10000);
    monitor.start();
    bus.emit("trade.normalized", sellEvent("W", 200)); // 2%

    expect(position.status).toBe("OPEN");
    expect(position.whaleState.tier).toBe("NONE");
  });
});
