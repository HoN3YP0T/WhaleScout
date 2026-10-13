import { newId, type NormalizedTradeEvent } from "@whale-sniper/core";
import bs58 from "bs58";
import type { DecodableTradePayload } from "./txDecoder.js";

/** pump.fun's bonding-curve program on mainnet. Every buy/sell against a
 * pre-migration token is an instruction on this program. */
export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const LAMPORTS_PER_SOL = 1_000_000_000;
// pump.fun-launched SPL tokens use 6 decimals, same as most Solana memecoins.
const PUMP_TOKEN_DECIMALS = 6;
const PUMP_TOKEN_UNITS = 10 ** PUMP_TOKEN_DECIMALS;

// Byte layout of pump.fun's Anchor "TradeEvent", as self-CPI-logged via
// `Program data: <base64>` on every buy/sell, per the program's public IDL
// (not captured live - this build has no Helius API key).
//
// Identified by its Anchor event discriminator, which is not a guess:
// Anchor defines it as sha256("event:TradeEvent")[0..8], and that matches
// the value in pump.fun's published IDL. Matching it is what keeps other
// events the program emits (CreateEvent, CompleteEvent, ...) from being
// misparsed as trades.
//
// The decoder reads the original 121-byte field prefix and accepts a
// LONGER payload: pump.fun has appended fields to TradeEvent since launch
// (fee recipient/amounts, creator fee, ...). Anchor/Borsh appends new
// fields at the end, so the prefix offsets are stable, whereas an
// exact-length check would silently reject every current trade.
const TRADE_EVENT_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const TRADE_EVENT_DISCRIMINATOR_LEN = TRADE_EVENT_DISCRIMINATOR.length;
const TRADE_EVENT_BODY_LEN = 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8 + 8 + 8; // 121 bytes
const TRADE_EVENT_MIN_LEN = TRADE_EVENT_DISCRIMINATOR_LEN + TRADE_EVENT_BODY_LEN;

export interface PumpFunTradeEvent {
  mint: string;
  solAmountLamports: bigint;
  tokenAmountRaw: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number; // unix seconds
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

/** Minimal shape of what `Connection.onLogs` hands back for a pump.fun
 * program subscription - matches @solana/web3.js's `Logs` type plus the
 * slot from its `Context`, kept narrow here so the decoder has no
 * dependency on web3.js itself and fixtures stay plain objects. */
export interface PumpFunLogsNotification {
  signature: string;
  err: unknown;
  logs: string[];
}

const PROGRAM_DATA_PREFIX = "Program data: ";

/** Pulls every `Program data: <base64>` payload out of a log set - pump.fun
 * (like any Anchor program using `emit!`) self-CPI-logs each event this way,
 * and a single transaction's logs can contain more than one. */
function extractProgramDataPayloads(logs: string[]): Buffer[] {
  const payloads: Buffer[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    try {
      payloads.push(Buffer.from(b64, "base64"));
    } catch {
      // malformed base64 - ignore this line, keep scanning others
    }
  }
  return payloads;
}

function decodeTradeEventBuffer(buf: Buffer): PumpFunTradeEvent | null {
  if (buf.length < TRADE_EVENT_MIN_LEN) return null;
  if (!buf.subarray(0, TRADE_EVENT_DISCRIMINATOR_LEN).equals(TRADE_EVENT_DISCRIMINATOR)) return null;

  let offset = TRADE_EVENT_DISCRIMINATOR_LEN;
  const mint = bs58.encode(buf.subarray(offset, offset + 32));
  offset += 32;
  const solAmountLamports = buf.readBigUInt64LE(offset);
  offset += 8;
  const tokenAmountRaw = buf.readBigUInt64LE(offset);
  offset += 8;
  const isBuyByte = buf.readUInt8(offset);
  offset += 1;
  const user = bs58.encode(buf.subarray(offset, offset + 32));
  offset += 32;
  const timestamp = Number(buf.readBigInt64LE(offset));
  offset += 8;
  const virtualSolReserves = buf.readBigUInt64LE(offset);
  offset += 8;
  const virtualTokenReserves = buf.readBigUInt64LE(offset);
  offset += 8;
  const realSolReserves = buf.readBigUInt64LE(offset);
  offset += 8;
  const realTokenReserves = buf.readBigUInt64LE(offset);
  offset += 8;

  if (isBuyByte !== 0 && isBuyByte !== 1) return null;
  if (solAmountLamports <= 0n || tokenAmountRaw <= 0n) return null;

  return {
    mint,
    solAmountLamports,
    tokenAmountRaw,
    isBuy: isBuyByte === 1,
    user,
    timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
  };
}

/** Best-effort decode of a pump.fun TradeEvent out of one transaction's
 * logs. Returns null (never throws) for logs that don't contain a
 * recognizable trade event - a failed tx, an unrelated instruction on the
 * same program, or a log shape this decoder doesn't understand. */
export function decodePumpFunTradeLog(notification: PumpFunLogsNotification): PumpFunTradeEvent | null {
  return decodePumpFunTradeLogs(notification)[0] ?? null;
}

/** Every trade event in one transaction's logs, in log order. A single
 * transaction can buy/sell several times (bundlers, multi-hop routers);
 * taking only the first undercounts that wallet's volume. */
export function decodePumpFunTradeLogs(notification: PumpFunLogsNotification): PumpFunTradeEvent[] {
  if (notification.err) return [];
  const trades: PumpFunTradeEvent[] = [];
  for (const payload of extractProgramDataPayloads(notification.logs)) {
    const decoded = decodeTradeEventBuffer(payload);
    if (decoded) trades.push(decoded);
  }
  return trades;
}

export interface PumpFunToNormalizedOptions {
  /** SOL/USD at the time of the trade - see `SolUsdPriceSource`. */
  solUsdPrice: number;
  slot: number;
  txSignature: string;
  receivedAt: number; // ms epoch
  nowFn?: () => number;
}

/** Maps a decoded pump.fun trade into the same `NormalizedTradeEvent` shape
 * every other feed provider produces, reusing the mock feed's payload
 * contract (`DecodableTradePayload`) so downstream code never needs to know
 * which provider a trade came from. */
export function pumpFunTradeToNormalizedEvent(
  trade: PumpFunTradeEvent,
  options: PumpFunToNormalizedOptions,
): NormalizedTradeEvent {
  const solAmount = Number(trade.solAmountLamports) / LAMPORTS_PER_SOL;
  const tokenAmount = Number(trade.tokenAmountRaw) / PUMP_TOKEN_UNITS;
  const usdValue = solAmount * options.solUsdPrice;
  const priceUsd = tokenAmount > 0 ? usdValue / tokenAmount : 0;
  // The curve's real SOL reserves after this trade are the SOL a seller can
  // actually exit into. Valued two-sided, the usual AMM liquidity
  // convention. DexScreener reports no liquidity at all for bonding-curve
  // pairs, so without this every pump.fun token reads as $0 liquidity.
  const poolLiquidityUsd = 2 * (Number(trade.realSolReserves) / LAMPORTS_PER_SOL) * options.solUsdPrice;

  const payload: DecodableTradePayload = {
    wallet: trade.user,
    tokenMint: trade.mint,
    side: trade.isBuy ? "BUY" : "SELL",
    tokenAmount,
    usdValue,
    priceUsd,
    dex: "pumpfun",
    // pump.fun trades happen against the token's bonding curve, not a
    // separate AMM pool address - synthesize a stable pool id from the mint
    // so downstream code (which just treats `pool` as an opaque string) has
    // something consistent to key on.
    pool: `${trade.mint}-bonding-curve`,
  };

  const nowFn = options.nowFn ?? Date.now;
  return {
    id: newId("trade"),
    wallet: payload.wallet,
    tokenMint: payload.tokenMint,
    side: payload.side,
    tokenAmount: payload.tokenAmount,
    usdValue: payload.usdValue,
    priceUsd: payload.priceUsd,
    dex: payload.dex,
    pool: payload.pool,
    slot: options.slot,
    blockTime: trade.timestamp,
    txSignature: options.txSignature,
    poolLiquidityUsd,
    timestamps: {
      rawReceivedAt: options.receivedAt,
      decodedAt: nowFn(),
    },
  };
}
