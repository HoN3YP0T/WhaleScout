import { CreatorRegistry, EventBus, RuggedTokenRegistry, SimulatedClock, TokenFirstSeenIndex } from "@whale-sniper/core";
import { InMemoryTokenRepository } from "@whale-sniper/db";
import { describe, expect, it } from "vitest";
import { CreatorRegistryUpdater } from "./creatorRegistryUpdater.js";
import { conservativeUnknownSeed, type ITokenMetadataProvider } from "./tokenMetadataProvider.js";
import { TokenStatsCollector } from "./tokenStatsCollector.js";

function baseStats(overrides: Partial<Parameters<InMemoryTokenRepository["upsertStats"]>[0]> = {}) {
  return {
    tokenMint: "T1",
    createdAt: 1000,
    liquidityUsd: 5000,
    marketCapUsd: 10000,
    holderCount: 50,
    top10HolderPct: 0.3,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    uniqueBuyers1h: 5,
    uniqueSellers1h: 1,
    buyVolumeUsd5m: 100,
    sellVolumeUsd5m: 10,
    buyVolumeUsd1h: 100,
    sellVolumeUsd1h: 10,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("CreatorRegistryUpdater", () => {
  it("does nothing when a token's creatorAddress is unknown", async () => {
    const bus = new EventBus();
    const tokenRepo = new InMemoryTokenRepository();
    const creatorRegistry = new CreatorRegistry();
    const ruggedRegistry = new RuggedTokenRegistry();
    await tokenRepo.upsertStats(baseStats({ creatorAddress: undefined }));

    const updater = new CreatorRegistryUpdater(bus, tokenRepo, creatorRegistry, ruggedRegistry);
    updater.start();
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    await flush();

    expect(creatorRegistry.getReputation("C1")).toBeUndefined();
  });

  it("records a token observed exactly once per token even across repeated events", async () => {
    const bus = new EventBus();
    const tokenRepo = new InMemoryTokenRepository();
    const creatorRegistry = new CreatorRegistry();
    const ruggedRegistry = new RuggedTokenRegistry();
    await tokenRepo.upsertStats(baseStats({ creatorAddress: "C1" }));

    const updater = new CreatorRegistryUpdater(bus, tokenRepo, creatorRegistry, ruggedRegistry);
    updater.start();
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    await flush();

    expect(creatorRegistry.getReputation("C1")?.tokensCreated).toBe(1);
  });

  it("records a rug against the creator exactly once, only after RuggedTokenRegistry flags it, without touching rug-detection logic itself", async () => {
    const bus = new EventBus();
    const tokenRepo = new InMemoryTokenRepository();
    const creatorRegistry = new CreatorRegistry();
    const ruggedRegistry = new RuggedTokenRegistry();
    await tokenRepo.upsertStats(baseStats({ creatorAddress: "C1" }));

    const updater = new CreatorRegistryUpdater(bus, tokenRepo, creatorRegistry, ruggedRegistry);
    updater.start();

    bus.emit("token.stats-updated", { tokenMint: "T1" });
    await flush();
    expect(creatorRegistry.getReputation("C1")?.tokensRugged).toBe(0);

    ruggedRegistry.flag("T1");
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    await flush();

    expect(creatorRegistry.getReputation("C1")?.tokensRugged).toBe(1);
    expect(creatorRegistry.getReputation("C1")?.tokensCreated).toBe(1);
  });

  it("tracks separate creators independently across multiple tokens", async () => {
    const bus = new EventBus();
    const tokenRepo = new InMemoryTokenRepository();
    const creatorRegistry = new CreatorRegistry();
    const ruggedRegistry = new RuggedTokenRegistry();
    await tokenRepo.upsertStats(baseStats({ tokenMint: "T1", creatorAddress: "C1" }));
    await tokenRepo.upsertStats(baseStats({ tokenMint: "T2", creatorAddress: "C1" }));
    await tokenRepo.upsertStats(baseStats({ tokenMint: "T3", creatorAddress: "C2" }));

    const updater = new CreatorRegistryUpdater(bus, tokenRepo, creatorRegistry, ruggedRegistry);
    updater.start();
    bus.emit("token.stats-updated", { tokenMint: "T1" });
    bus.emit("token.stats-updated", { tokenMint: "T2" });
    bus.emit("token.stats-updated", { tokenMint: "T3" });
    await flush();

    expect(creatorRegistry.getReputation("C1")?.tokensCreated).toBe(2);
    expect(creatorRegistry.getReputation("C2")?.tokensCreated).toBe(1);
  });
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TokenStatsCollector -> CreatorRegistryUpdater", () => {
  it("carries the provider's creator fields onto TokenStats so the creator registry actually learns", async () => {
    const bus = new EventBus();
    const tokenRepo = new InMemoryTokenRepository();
    const creatorRegistry = new CreatorRegistry();
    const ruggedRegistry = new RuggedTokenRegistry();
    const provider: ITokenMetadataProvider = {
      get: () => ({ ...conservativeUnknownSeed(), liquidityUsd: 5000, creatorAddress: "C1", creatorTokenLaunchCount: 7 }),
    };
    const collector = new TokenStatsCollector(bus, tokenRepo, provider, new TokenFirstSeenIndex(), ruggedRegistry, new SimulatedClock(0));
    collector.start();
    new CreatorRegistryUpdater(bus, tokenRepo, creatorRegistry, ruggedRegistry).start();

    bus.emit("trade.normalized", {
      id: "e1",
      wallet: "W",
      tokenMint: "T1",
      side: "BUY",
      tokenAmount: 100,
      usdValue: 100,
      priceUsd: 1,
      dex: "pumpfun",
      pool: "P",
      slot: 1,
      blockTime: 1000,
      txSignature: "tx1",
      timestamps: { rawReceivedAt: 0 },
    });
    await flush();

    expect(collector.getStats("T1")?.creatorAddress).toBe("C1");
    expect(collector.getStats("T1")?.creatorTokenLaunchCount).toBe(7);
    expect(creatorRegistry.getReputation("C1")?.tokensCreated).toBe(1);
  });
});
