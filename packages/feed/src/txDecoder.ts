import { newId, type DexName, type NormalizedTradeEvent, type RawFeedEvent, type TradeSide } from "@whale-sniper/core";

/** Shape a mock (or, later, a real decoded-instruction) provider emits before
 * normalization. A real adapter's decoder would parse Raydium/Orca/Pumpfun
 * instruction data into this same shape. */
export interface DecodableTradePayload {
  wallet: string;
  tokenMint: string;
  side: TradeSide;
  tokenAmount: number;
  usdValue: number;
  priceUsd: number;
  dex: DexName;
  pool: string;
  /** See NormalizedTradeEvent.poolLiquidityUsd. */
  poolLiquidityUsd?: number;
}

export function decodeTradeEvent(raw: RawFeedEvent, nowFn: () => number = Date.now): NormalizedTradeEvent {
  const payload = raw.raw as DecodableTradePayload;
  const decodedAt = nowFn();
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
    slot: raw.slot,
    blockTime: raw.blockTime,
    txSignature: raw.txSignature,
    poolLiquidityUsd: payload.poolLiquidityUsd,
    timestamps: {
      rawReceivedAt: raw.receivedAt,
      decodedAt,
    },
  };
}
