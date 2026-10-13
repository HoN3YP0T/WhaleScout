import { readFileSync } from "node:fs";
import { EventBus, parseStrategyConfig, type Signal, type TokenStats } from "@whale-sniper/core";
import { InMemoryPositionRepository } from "@whale-sniper/db";
import { openPaperPosition } from "@whale-sniper/paper-trading";
import { PositionManager } from "@whale-sniper/position-mgmt";
import { describe, expect, it } from "vitest";

const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8")));

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

function setup() {
  const bus = new EventBus();
  const repo = new InMemoryPositionRepository();
  const manager = new PositionManager(bus, repo, config);
  const position = openPaperPosition(signal(), "W", "tx1", tokenStats(), 1000, 1, config);
  return { bus, repo, manager, position };
}

describe("position state machine", () => {
  it("emits position.closed (not position.updated) when a take-profit rung sells the remainder", async () => {
    const ladderConfig = structuredClone(config);
    ladderConfig.position.takeProfitLadder = [
      { triggerPct: 10, sellFraction: 0.5 },
      { triggerPct: 20, sellFraction: 0.5 },
    ];
    const bus = new EventBus();
    const manager = new PositionManager(bus, new InMemoryPositionRepository(), ladderConfig);
    const position = openPaperPosition(signal(), "W", "tx1", tokenStats(), 1000, 1, ladderConfig);
    const closed: string[] = [];
    bus.on("position.closed", ({ reason }) => closed.push(reason));

    await manager.onPriceTick(position, position.entryPriceUsd * 1.25, 50000, position.openedAt + 1000);

    expect(position.status).toBe("CLOSED");
    expect(position.exitReason).toBe("TAKE_PROFIT");
    expect(closed).toEqual(["TAKE_PROFIT"]);
  });

  it("fires the first take-profit ladder rung when price crosses its trigger", async () => {
    const { manager, position } = setup();
    const targetPrice = position.entryPriceUsd * (1 + config.position.takeProfitLadder[0].triggerPct / 100 + 0.001);
    await manager.onPriceTick(position, targetPrice, 50000, position.openedAt + 1000);
    expect(position.takeProfitLevels[0].filled).toBe(true);
    expect(position.remainingTokenAmount).toBeLessThan(position.tokenAmount);
    expect(position.status).toBe("OPEN");
  });

  it("fires every take-profit rung in order on a single large price jump", async () => {
    const { manager, position } = setup();
    const lastTrigger = config.position.takeProfitLadder[config.position.takeProfitLadder.length - 1].triggerPct;
    const bigPrice = position.entryPriceUsd * (1 + (lastTrigger + 20) / 100);
    await manager.onPriceTick(position, bigPrice, 50000, position.openedAt + 1000);
    expect(position.takeProfitLevels.every((l) => l.filled)).toBe(true);
  });

  it("activates and follows a trailing stop above the activation threshold", async () => {
    const { manager, position } = setup();
    const activationPrice = position.entryPriceUsd * (1 + (config.position.trailingActivationPct + 5) / 100);
    await manager.onPriceTick(position, activationPrice, 50000, position.openedAt + 1000);
    expect(position.trailingActive).toBe(true);
    const firstStop = position.trailingStopPriceUsd!;

    const higherPrice = activationPrice * 1.2;
    await manager.onPriceTick(position, higherPrice, 50000, position.openedAt + 2000);
    expect(position.trailingStopPriceUsd!).toBeGreaterThan(firstStop);
  });

  it("exits via trailing stop once price falls back through it", async () => {
    const { manager, position } = setup();
    const activationPrice = position.entryPriceUsd * (1 + (config.position.trailingActivationPct + 5) / 100);
    await manager.onPriceTick(position, activationPrice, 50000, position.openedAt + 1000);
    expect(position.trailingActive).toBe(true);

    const stopPrice = position.trailingStopPriceUsd! - 0.0001;
    await manager.onPriceTick(position, stopPrice, 50000, position.openedAt + 2000);
    expect(position.status).toBe("CLOSED");
    expect(position.exitReason).toBe("TRAILING_STOP");
  });

  it("exits via stop loss when price falls below the initial stop before trailing activates", async () => {
    const { manager, position } = setup();
    const stopPrice = position.stopLossPriceUsd - 0.0001;
    await manager.onPriceTick(position, stopPrice, 50000, position.openedAt + 1000);
    expect(position.status).toBe("CLOSED");
    expect(position.exitReason).toBe("STOP_LOSS");
  });

  it("forces an exit once max hold time elapses regardless of price", async () => {
    const { manager, position } = setup();
    const now = position.openedAt + config.position.maxHoldTimeSeconds * 1000 + 1000;
    await manager.onPriceTick(position, position.entryPriceUsd * 1.05, 50000, now);
    expect(position.status).toBe("CLOSED");
    expect(position.exitReason).toBe("MAX_HOLD_TIME");
  });
});
