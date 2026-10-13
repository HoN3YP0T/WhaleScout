import { readFileSync } from "node:fs";
import { EventBus, RuggedTokenRegistry, SimulatedClock, TokenFirstSeenIndex, parseStrategyConfig, type NormalizedTradeEvent } from "@whale-sniper/core";
import { ClusterDetector, MockWalletRelationshipSource } from "@whale-sniper/cluster-detect";
import { InMemoryClusterRepository, InMemoryTokenRepository } from "@whale-sniper/db";
import { MockTokenMetadataProvider, TokenStatsCollector } from "@whale-sniper/token-intel";
import { describe, expect, it } from "vitest";

const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8")));

function trade(tokenMint: string, blockTime: number, wallet = "W"): NormalizedTradeEvent {
  return {
    id: `${tokenMint}-${blockTime}-${wallet}`,
    wallet,
    tokenMint,
    side: "BUY",
    tokenAmount: 100,
    usdValue: 100,
    priceUsd: 1,
    dex: "pumpfun",
    pool: "P",
    slot: blockTime,
    blockTime,
    txSignature: `tx-${tokenMint}-${blockTime}-${wallet}`,
    timestamps: { rawReceivedAt: 0 },
  };
}

describe("live-feed memory bounds", () => {
  it("ClusterDetector forgets trades older than an hour and tokens that stopped trading", async () => {
    const bus = new EventBus();
    const detector = new ClusterDetector(bus, new InMemoryClusterRepository(), new InMemoryTokenRepository(), new MockWalletRelationshipSource(), new RuggedTokenRegistry(), config);
    detector.start();

    bus.emit("trade.normalized", trade("DEAD", 1_000));
    bus.emit("trade.normalized", trade("LIVE", 1_000, "A"));
    expect(detector.trackedTokenCount()).toBe(2);

    // Two hours later only LIVE trades again.
    bus.emit("trade.normalized", trade("LIVE", 8_200, "B"));
    expect(detector.trackedTokenCount()).toBe(1);

    // LIVE's own 2h-old trade is gone too: no timing edge can link A and B.
    bus.emit("trade.normalized", trade("LIVE", 8_201, "A"));
    const clusters = await detector.detectForToken("LIVE");
    expect(clusters.flatMap((c) => c.members)).not.toContain("DEAD");
    expect(await detector.detectForToken("DEAD")).toEqual([]);
  });

  it("TokenStatsCollector evicts accumulators for tokens idle longer than the stats window", () => {
    const bus = new EventBus();
    const collector = new TokenStatsCollector(bus, new InMemoryTokenRepository(), new MockTokenMetadataProvider(), new TokenFirstSeenIndex(), new RuggedTokenRegistry(), new SimulatedClock(0));
    collector.start();

    bus.emit("trade.normalized", trade("DEAD", 1_000));
    bus.emit("trade.normalized", trade("LIVE", 1_000));
    expect(collector.trackedTokenCount()).toBe(2);

    bus.emit("trade.normalized", trade("LIVE", 8_200));
    expect(collector.trackedTokenCount()).toBe(1);
    expect(collector.getStats("DEAD")).toBeUndefined();
    expect(collector.getStats("LIVE")?.uniqueBuyers1h).toBe(1);
  });

  it("re-detecting a token's cluster overwrites it instead of storing a new copy", async () => {
    const bus = new EventBus();
    const repo = new InMemoryClusterRepository();
    const detector = new ClusterDetector(bus, repo, new InMemoryTokenRepository(), new MockWalletRelationshipSource(), new RuggedTokenRegistry(), config);
    detector.start();
    bus.emit("trade.normalized", trade("T", 1_000, "A"));
    bus.emit("trade.normalized", trade("T", 1_001, "B"));

    const first = await detector.detectForToken("T");
    const second = await detector.detectForToken("T");
    expect(first).toHaveLength(1);
    expect(second[0].clusterId).toBe(first[0].clusterId);
    expect(await repo.getCluster(first[0].clusterId)).toBeDefined();
    expect((repo as unknown as { clusters: Map<string, unknown> }).clusters.size).toBe(1);
  });

  it("InMemoryClusterRepository keeps only the most recently written clusters", async () => {
    const repo = new InMemoryClusterRepository(2);
    const cluster = (id: string) => ({
      clusterId: id,
      members: ["A", "B"],
      edges: [],
      flags: { concentratedOwnership: false, coordinatedBuying: false, immediateLargeSelling: false, creatorAssociatedWallets: false, suspiciousLiquidityBehavior: false },
      manipulationPenalty: 0,
      computedAt: 0,
    });
    await repo.upsertCluster(cluster("c1"));
    await repo.upsertCluster(cluster("c2"));
    await repo.upsertCluster(cluster("c1")); // refreshed - now newest
    await repo.upsertCluster(cluster("c3"));
    expect(await repo.getCluster("c2")).toBeUndefined();
    expect(await repo.getCluster("c1")).toBeDefined();
    expect(await repo.getCluster("c3")).toBeDefined();
  });
});

describe("minCoordinatedTokens", () => {
  const buy = (tokenMint: string, blockTime: number, wallet: string) => ({ ...trade(tokenMint, blockTime, wallet), side: "BUY" as const });

  it("ignores a one-off same-second co-buy, but clusters a pair that co-buys across tokens", async () => {
    const cfg = structuredClone(config);
    cfg.clusterThresholds.minCoordinatedTokens = 2;
    const bus = new EventBus();
    const detector = new ClusterDetector(bus, new InMemoryClusterRepository(), new InMemoryTokenRepository(), new MockWalletRelationshipSource(), new RuggedTokenRegistry(), cfg);
    detector.start();

    // A and B co-buy token X in the same second: on its own, just a busy token.
    bus.emit("trade.normalized", buy("X", 1_000, "A"));
    bus.emit("trade.normalized", buy("X", 1_000, "B"));
    expect(await detector.detectForToken("X")).toEqual([]);

    // The same pair co-buys a second token: now it's a pattern.
    bus.emit("trade.normalized", buy("Y", 1_100, "A"));
    bus.emit("trade.normalized", buy("Y", 1_102, "B"));
    const clusters = await detector.detectForToken("Y");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual(["A", "B"]);
  });

  it("defaults to the original behaviour (any single co-buy counts)", async () => {
    const bus = new EventBus();
    const detector = new ClusterDetector(bus, new InMemoryClusterRepository(), new InMemoryTokenRepository(), new MockWalletRelationshipSource(), new RuggedTokenRegistry(), config);
    detector.start();
    bus.emit("trade.normalized", buy("X", 1_000, "A"));
    bus.emit("trade.normalized", buy("X", 1_000, "B"));
    expect(await detector.detectForToken("X")).toHaveLength(1);
  });
});
