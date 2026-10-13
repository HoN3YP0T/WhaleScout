import { EventBus, RuntimeFlags, createLogger } from "@whale-sniper/core";
import { InMemoryPositionRepository, InMemorySignalRepository, InMemoryWatchlistRepository } from "@whale-sniper/db";
import {
  formatEntry,
  formatExit,
  formatWhaleAutoPromoted,
  formatWhaleCandidateDiscovered,
  formatWhaleDetected,
  isAuthorizedChat,
  isValidWalletAddress,
  TelegramBot,
} from "@whale-sniper/telegram-bot";
import { describe, expect, it } from "vitest";
import type { Position, Signal } from "@whale-sniper/core";

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "p1",
    tokenMint: "TokenMintAddress1111111111111111111111111",
    signalId: "s1",
    status: "OPEN",
    entryPriceUsd: 1,
    entryUsdValue: 1000,
    tokenAmount: 1000,
    remainingTokenAmount: 1000,
    currentPriceUsd: 1,
    highWaterMarkPriceUsd: 1,
    lowWaterMarkPriceUsd: 1,
    stopLossPriceUsd: 0.8,
    trailingActive: false,
    takeProfitLevels: [],
    whaleState: { wallet: "W", entryTxSignature: "tx1", cumulativeSoldFraction: 0, tier: "NONE", lastCheckedAt: Date.now() },
    realizedPnlUsd: 50,
    unrealizedPnlUsd: 0,
    mfePct: 10,
    maePct: -2,
    feesUsd: 1,
    openedAt: Date.now(),
    ...overrides,
  };
}

function signal(): Signal {
  return {
    signalId: "s1",
    tokenMint: "TokenMintAddress1111111111111111111111111",
    triggeringWallet: "W",
    triggeringTxSignature: "tx1",
    components: { whaleQuality: 80, tokenQuality: 80, liquidity: 80, buyingMomentum: 80, independentBuyers: 80, earlyEntryQuality: 80, manipulationPenalty: 0 },
    score: 80,
    generatedAt: Date.now(),
  };
}

describe("notification templates", () => {
  it("formats a whale-detected notification with the wallet score and truncated addresses", () => {
    const msg = formatWhaleDetected("WhaLe1111111111111111111111111111111111111", "TokenMintAddress1111111111111111111111111", 4000, 85);
    expect(msg).toContain("Whale buy detected");
    expect(msg).toContain("85");
    expect(msg).toContain("$4000");
  });

  it("formats an entry notification", () => {
    const msg = formatEntry(position(), signal());
    expect(msg).toContain("Entered position");
    expect(msg).toContain("80.0");
  });

  it("formats a winning exit with a green marker and a losing exit with a red one", () => {
    const win = formatExit(position({ realizedPnlUsd: 120, exitReason: "TAKE_PROFIT" }));
    const loss = formatExit(position({ realizedPnlUsd: -80, exitReason: "STOP_LOSS" }));
    expect(win).toContain("🟢");
    expect(loss).toContain("🔴");
  });
});

describe("TelegramBot", () => {
  it("does not start (and does not throw) when no token is configured", async () => {
    const bot = new TelegramBot({
      token: "",
      chatId: "",
      bus: new EventBus(),
      positionRepo: new InMemoryPositionRepository(),
      signalRepo: new InMemorySignalRepository(),
      watchlistRepo: new InMemoryWatchlistRepository(),
      runtimeFlags: new RuntimeFlags(),
      logger: createLogger("test", "silent"),
    });
    await expect(bot.start()).resolves.toBeUndefined();
  });
});

describe("telegram command authorization", () => {
  it("only authorizes the configured chat, and nobody when none is configured", () => {
    expect(isAuthorizedChat("12345", 12345)).toBe(true);
    expect(isAuthorizedChat("-100777", "-100777")).toBe(true);
    expect(isAuthorizedChat("12345", 99999)).toBe(false);
    expect(isAuthorizedChat("12345", undefined)).toBe(false);
    expect(isAuthorizedChat("", 12345)).toBe(false);
  });

  it("validates /approve and /reject addresses as base58 Solana public keys", () => {
    expect(isValidWalletAddress("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")).toBe(true);
    expect(isValidWalletAddress("<script>alert(1)</script>")).toBe(false);
    expect(isValidWalletAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBe(false);
    expect(isValidWalletAddress("short")).toBe(false);
  });
});

describe("whale-discovery notification templates", () => {
  it("formats a whale-candidate-discovered notification with approve/reject hints", () => {
    const msg = formatWhaleCandidateDiscovered("WhaLe1111111111111111111111111111111111111", 72);
    expect(msg).toContain("WHALE CANDIDATE DISCOVERED");
    expect(msg).toContain("72");
    expect(msg).toContain("/approve");
    expect(msg).toContain("/reject");
  });

  it("formats an auto-promoted notification", () => {
    const msg = formatWhaleAutoPromoted("WhaLe1111111111111111111111111111111111111", 91);
    expect(msg).toContain("AUTO-PROMOTED");
    expect(msg).toContain("91");
  });
});
