import { createHash } from "node:crypto";
import type { NormalizedTradeEvent } from "@whale-sniper/core";
import type { Context, Logs } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { HeliusFeedProvider, type ConnectionLike } from "./HeliusFeedProvider.js";
import { PUMP_FUN_PROGRAM_ID } from "./pumpFunDecoder.js";

const MINT = "So11111111111111111111111111111111111111112";
const USER = "Vote111111111111111111111111111111111111111";

function encodeFixtureLog(): string {
  const buf = Buffer.alloc(8 + 121);
  // Anchor event discriminator: sha256("event:TradeEvent")[0..8].
  createHash("sha256").update("event:TradeEvent").digest().copy(buf, 0, 0, 8);
  let offset = 8;
  Buffer.from(bs58.decode(MINT)).copy(buf, offset);
  offset += 32;
  buf.writeBigUInt64LE(1_000_000_000n, offset); // 1 SOL
  offset += 8;
  buf.writeBigUInt64LE(20_000_000_000n, offset); // 20,000 tokens
  offset += 8;
  buf.writeUInt8(1, offset); // isBuy
  offset += 1;
  Buffer.from(bs58.decode(USER)).copy(buf, offset);
  offset += 32;
  buf.writeBigInt64LE(1_700_000_000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(30_000_000_000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(1_000_000_000_000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(10_000_000_000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(500_000_000_000n, offset);
  return `Program data: ${buf.toString("base64")}`;
}

/** Fake standing in for `@solana/web3.js`'s `Connection`, so this test never
 * opens a real WebSocket - HeliusFeedProvider only depends on the narrow
 * `ConnectionLike` surface, injected via `connectionFactory`. */
class FakeConnection implements ConnectionLike {
  private handler: ((logs: Logs, ctx: Context) => void) | undefined;
  removed = false;

  onLogs(_filter: unknown, callback: (logs: Logs, ctx: Context) => void): number {
    this.handler = callback;
    return 42;
  }

  async removeOnLogsListener(_id: number): Promise<void> {
    this.removed = true;
  }

  emit(logs: { signature: string; err: unknown; logs: string[] }, slot = 999): void {
    this.handler?.(logs as Logs, { slot } as Context);
  }
}

describe("HeliusFeedProvider", () => {
  it("throws immediately if constructed without an apiKey", () => {
    expect(() => new HeliusFeedProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("connects via the injected connection factory and decodes pump.fun trade logs", async () => {
    let capturedProgramId: unknown;
    const fake = new FakeConnection();
    const provider = new HeliusFeedProvider({
      apiKey: "test-key",
      solUsdPrice: 100,
      connectionFactory: (_wsUrl, _httpUrl) => fake,
    });

    const received: NormalizedTradeEvent[] = [];
    provider.onEvent((e) => received.push(e));

    await provider.connect();
    expect(provider.health().connected).toBe(true);

    fake.emit({ signature: "sig1", err: null, logs: [encodeFixtureLog()] }, 12345);

    expect(received).toHaveLength(1);
    expect(received[0].dex).toBe("pumpfun");
    expect(received[0].tokenMint).toBe(MINT);
    expect(received[0].wallet).toBe(USER);
    expect(received[0].usdValue).toBeCloseTo(100, 6);
    expect(received[0].slot).toBe(12345);
    expect(provider.health().eventsReceived).toBe(1);

    await provider.disconnect();
    expect(fake.removed).toBe(true);
    expect(provider.health().connected).toBe(false);
  });

  it("does not emit a trade event for logs with no decodable TradeEvent", async () => {
    const fake = new FakeConnection();
    const provider = new HeliusFeedProvider({ apiKey: "test-key", solUsdPrice: 100, connectionFactory: () => fake });
    const received: NormalizedTradeEvent[] = [];
    provider.onEvent((e) => received.push(e));

    await provider.connect();
    fake.emit({ signature: "sig2", err: null, logs: ["Program log: unrelated"] });

    expect(received).toHaveLength(0);
    expect(provider.health().eventsReceived).toBe(0);
  });

  it("routes decode failures to error handlers, not event handlers", async () => {
    const fake = new FakeConnection();
    const provider = new HeliusFeedProvider({ apiKey: "test-key", solUsdPrice: 100, connectionFactory: () => fake });
    const events: NormalizedTradeEvent[] = [];
    const errors: Error[] = [];
    provider.onEvent((e) => events.push(e));
    provider.onError((err) => errors.push(err));

    await provider.connect();
    // A failed tx (err set) - decodePumpFunTradeLog returns null for this,
    // which is a normal no-op, not an error path.
    fake.emit({ signature: "sig3", err: { InstructionError: [0, "x"] }, logs: [encodeFixtureLog()] });

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("uses the pump.fun program id by default", async () => {
    let seenFilter: unknown;
    const fake = new FakeConnection();
    const captured: ConnectionLike = {
      onLogs: (filter, cb) => {
        seenFilter = filter;
        return fake.onLogs(filter, cb);
      },
      removeOnLogsListener: (id) => fake.removeOnLogsListener(id),
    };
    const provider = new HeliusFeedProvider({ apiKey: "test-key", solUsdPrice: 100, connectionFactory: () => captured });
    await provider.connect();
    expect(String(seenFilter)).toBe(PUMP_FUN_PROGRAM_ID);
  });
});
