import { createHash } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  decodePumpFunTradeLog,
  pumpFunTradeToNormalizedEvent,
  type PumpFunLogsNotification,
} from "./pumpFunDecoder.js";

/**
 * Hand-built fixture standing in for a real pump.fun `TradeEvent` log, since
 * this build has no HELIUS_API_KEY to capture one live against. The byte
 * layout matches pump.fun's public IDL as best understood (see the comment
 * in pumpFunDecoder.ts) - if that layout is wrong, this fixture and the
 * decoder are wrong together, which is the best this test suite can do
 * without a real credential.
 */
function encodeTradeEventFixture(fields: {
  mint: string;
  user: string;
  solAmountLamports: bigint;
  tokenAmountRaw: bigint;
  isBuy: boolean;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}, trailingBytes = 0): Buffer {
  const buf = Buffer.alloc(8 + 121 + trailingBytes);
  TRADE_EVENT_DISCRIMINATOR.copy(buf, 0);
  let offset = 8;
  Buffer.from(bs58.decode(fields.mint)).copy(buf, offset);
  offset += 32;
  buf.writeBigUInt64LE(fields.solAmountLamports, offset);
  offset += 8;
  buf.writeBigUInt64LE(fields.tokenAmountRaw, offset);
  offset += 8;
  buf.writeUInt8(fields.isBuy ? 1 : 0, offset);
  offset += 1;
  Buffer.from(bs58.decode(fields.user)).copy(buf, offset);
  offset += 32;
  buf.writeBigInt64LE(BigInt(fields.timestamp), offset);
  offset += 8;
  buf.writeBigUInt64LE(fields.virtualSolReserves, offset);
  offset += 8;
  buf.writeBigUInt64LE(fields.virtualTokenReserves, offset);
  offset += 8;
  buf.writeBigUInt64LE(fields.realSolReserves, offset);
  offset += 8;
  buf.writeBigUInt64LE(fields.realTokenReserves, offset);
  offset += 8;
  return buf;
}

const MINT = "So11111111111111111111111111111111111111112";
const USER = "Vote111111111111111111111111111111111111111";

// sha256("event:TradeEvent")[0..8] - Anchor's event discriminator.
const TRADE_EVENT_DISCRIMINATOR = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

function fixtureNotification(
  overrides: Partial<Parameters<typeof encodeTradeEventFixture>[0]> = {},
  trailingBytes = 0,
): PumpFunLogsNotification {
  const fields = {
    mint: MINT,
    user: USER,
    solAmountLamports: 2_000_000_000n, // 2 SOL
    tokenAmountRaw: 40_000_000_000n, // 40,000 tokens @ 6 decimals
    isBuy: true,
    timestamp: 1_700_000_500,
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_000_000_000_000n,
    realSolReserves: 10_000_000_000n,
    realTokenReserves: 500_000_000_000n,
    ...overrides,
  };
  const buf = encodeTradeEventFixture(fields, trailingBytes);
  return {
    signature: "fixtureSig1",
    err: null,
    logs: [
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
      "Program log: Instruction: Buy",
      `Program data: ${buf.toString("base64")}`,
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
    ],
  };
}

describe("decodePumpFunTradeLog", () => {
  it("decodes a well-formed buy TradeEvent", () => {
    const decoded = decodePumpFunTradeLog(fixtureNotification());
    expect(decoded).not.toBeNull();
    expect(decoded?.mint).toBe(MINT);
    expect(decoded?.user).toBe(USER);
    expect(decoded?.isBuy).toBe(true);
    expect(decoded?.solAmountLamports).toBe(2_000_000_000n);
    expect(decoded?.tokenAmountRaw).toBe(40_000_000_000n);
    expect(decoded?.timestamp).toBe(1_700_000_500);
  });

  it("decodes a sell TradeEvent", () => {
    const decoded = decodePumpFunTradeLog(fixtureNotification({ isBuy: false }));
    expect(decoded?.isBuy).toBe(false);
  });

  it("returns null for a failed transaction", () => {
    const notification = fixtureNotification();
    notification.err = { InstructionError: [0, "Custom"] };
    expect(decodePumpFunTradeLog(notification)).toBeNull();
  });

  it("returns null when there is no Program data log line", () => {
    const notification: PumpFunLogsNotification = {
      signature: "sig",
      err: null,
      logs: ["Program log: Instruction: Buy", "Program 6EF8... success"],
    };
    expect(decodePumpFunTradeLog(notification)).toBeNull();
  });

  it("returns null for a malformed / wrong-length payload", () => {
    const notification: PumpFunLogsNotification = {
      signature: "sig",
      err: null,
      logs: [`Program data: ${Buffer.from("too short").toString("base64")}`],
    };
    expect(decodePumpFunTradeLog(notification)).toBeNull();
  });

  it("decodes a TradeEvent carrying fields appended after the original layout", () => {
    // Current pump.fun TradeEvents append fee/creator-fee fields after the
    // original 121-byte body.
    const decoded = decodePumpFunTradeLog(fixtureNotification({}, 96));
    expect(decoded?.mint).toBe(MINT);
    expect(decoded?.solAmountLamports).toBe(2_000_000_000n);
  });

  it("rejects a correctly sized payload whose discriminator is not TradeEvent's", () => {
    const notification = fixtureNotification();
    const line = notification.logs.find((l) => l.startsWith("Program data: "))!;
    const buf = Buffer.from(line.slice("Program data: ".length), "base64");
    buf.write("dscrmntr", 0, "utf-8");
    notification.logs = [`Program data: ${buf.toString("base64")}`];
    expect(decodePumpFunTradeLog(notification)).toBeNull();
  });

  it("ignores unrelated Program data lines and finds the real one among several", () => {
    const notification = fixtureNotification();
    notification.logs = [
      `Program data: ${Buffer.from("unrelated-cpi-event").toString("base64")}`,
      ...notification.logs,
    ];
    const decoded = decodePumpFunTradeLog(notification);
    expect(decoded).not.toBeNull();
    expect(decoded?.mint).toBe(MINT);
  });
});

describe("pumpFunTradeToNormalizedEvent", () => {
  it("maps a decoded buy into the shared NormalizedTradeEvent shape", () => {
    const decoded = decodePumpFunTradeLog(fixtureNotification());
    if (!decoded) throw new Error("fixture failed to decode");

    const normalized = pumpFunTradeToNormalizedEvent(decoded, {
      solUsdPrice: 150,
      slot: 123456,
      txSignature: "fixtureSig1",
      receivedAt: 1_700_000_500_123,
      nowFn: () => 1_700_000_500_456,
    });

    expect(normalized.dex).toBe("pumpfun");
    expect(normalized.side).toBe("BUY");
    expect(normalized.wallet).toBe(USER);
    expect(normalized.tokenMint).toBe(MINT);
    expect(normalized.tokenAmount).toBeCloseTo(40_000, 6);
    expect(normalized.usdValue).toBeCloseTo(2 * 150, 6);
    expect(normalized.priceUsd).toBeCloseTo((2 * 150) / 40_000, 6);
    expect(normalized.pool).toBe(`${MINT}-bonding-curve`);
    expect(normalized.slot).toBe(123456);
    expect(normalized.txSignature).toBe("fixtureSig1");
    expect(normalized.blockTime).toBe(1_700_000_500);
    expect(normalized.timestamps.rawReceivedAt).toBe(1_700_000_500_123);
    expect(normalized.timestamps.decodedAt).toBe(1_700_000_500_456);
  });
});
