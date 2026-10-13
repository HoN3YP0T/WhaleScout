import { describe, expect, it } from "vitest";
import { LiveSolUsdPrice, solUsdFromDexScreener } from "./solUsdPrice.js";

const SOL = "So11111111111111111111111111111111111111112";
const pair = (quote: string, price: string, liq: number, base = SOL) => ({
  baseToken: { address: base },
  quoteToken: { symbol: quote },
  priceUsd: price,
  liquidity: { usd: liq },
});

describe("solUsdFromDexScreener", () => {
  it("takes the deepest SOL/stablecoin pool and ignores other quotes and reversed pairs", () => {
    const raw = {
      pairs: [
        pair("USDC", "106.80", 5_000_000),
        pair("USDC", "106.88", 28_000_000),
        pair("BONK", "999", 90_000_000),
        pair("USDC", "0.009", 50_000_000, "SomeOtherToken"),
      ],
    };
    expect(solUsdFromDexScreener(raw)).toBe(106.88);
  });

  it("returns undefined for an empty or implausible response", () => {
    expect(solUsdFromDexScreener({ pairs: null })).toBeUndefined();
    expect(solUsdFromDexScreener({ pairs: [pair("USDC", "0", 1)] })).toBeUndefined();
    expect(solUsdFromDexScreener({ pairs: [pair("USDC", "not-a-number", 1)] })).toBeUndefined();
  });
});

describe("LiveSolUsdPrice", () => {
  it("uses the fallback until a quote lands, then keeps the last good quote through failures", async () => {
    let fail = true;
    const source = new LiveSolUsdPrice({
      fallbackPrice: 150,
      fetchJson: async () => {
        if (fail) throw new Error("network down");
        return { pairs: [pair("USDC", "106.88", 1_000_000)] };
      },
    });
    await source.refresh();
    expect(source.current()).toBe(150);
    expect(source.isLive()).toBe(false);
    expect(source.lastError).toBe("network down");

    fail = false;
    await source.refresh();
    expect(source.current()).toBe(106.88);

    fail = true;
    await source.refresh();
    expect(source.current()).toBe(106.88);
    source.stop();
  });
});
