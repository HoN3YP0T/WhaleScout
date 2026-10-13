import { InMemoryWatchlistRepository, PrismaRiskStateRepository, PrismaWatchlistRepository } from "@whale-sniper/db";
import { describe, expect, it } from "vitest";

/** Records every model call in order; upserts echo back a plausible row. */
function recordingPrisma() {
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const model = (name: string) => ({
    upsert: async (args: any) => {
      calls.push({ model: name, method: "upsert", args });
      return {
        dailyLossUsd: 0,
        dailyLossResetAt: new Date(0),
        consecutiveLosses: 0,
        cooldownUntil: null,
        killSwitchActive: false,
      };
    },
  });
  return { calls, prisma: { wallet: model("wallet"), watchlist: model("watchlist"), riskState: model("riskState") } };
}

describe("PrismaWatchlistRepository", () => {
  it("creates the Wallet row the watchlist foreign key needs before writing the entry", async () => {
    const { calls, prisma } = recordingPrisma();
    const repo = new PrismaWatchlistRepository(prisma);

    await repo.add({ address: "W1", label: "whale" });
    await repo.updateStatus("W2", "pending");

    expect(calls.map((c) => c.model)).toEqual(["wallet", "watchlist", "wallet", "watchlist"]);
    expect(calls[0].args.where).toEqual({ address: "W1" });
    expect(calls[2].args.where).toEqual({ address: "W2" });
  });

  it("does not overwrite an existing entry's status when re-seeding", async () => {
    const { calls, prisma } = recordingPrisma();
    await new PrismaWatchlistRepository(prisma).add({ address: "W1", label: "whale" });
    const upsert = calls.find((c) => c.model === "watchlist")!.args;
    expect(upsert.update).not.toHaveProperty("status");
    expect(upsert.update).not.toHaveProperty("source");
    expect(upsert.create.status).toBe("active");
  });
});

describe("InMemoryWatchlistRepository", () => {
  it("keeps a rejected status when the same wallet is re-added from config", async () => {
    const repo = new InMemoryWatchlistRepository();
    await repo.add({ address: "W1", label: "whale" });
    await repo.updateStatus("W1", "rejected");
    await repo.add({ address: "W1", label: "whale (renamed)" });

    const [entry] = await repo.load();
    expect(entry.status).toBe("rejected");
    expect(entry.label).toBe("whale (renamed)");
  });
});

describe("PrismaRiskStateRepository", () => {
  it("persists dailyLossResetAt so the daily-loss window can roll over", async () => {
    const { calls, prisma } = recordingPrisma();
    await new PrismaRiskStateRepository(prisma).update({ dailyLossUsd: 0, dailyLossResetAt: 1_000_000 });
    expect(calls[0].args.update.dailyLossResetAt).toEqual(new Date(1_000_000));
  });
});
