import type { ClusterEdge, NormalizedTradeEvent } from "@whale-sniper/core";

export const TIMING_CORRELATION_WINDOW_SECONDS = 15;
const CO_BUY_MIN_SHARED_TOKENS = 2;

/** Wallets whose BUYs on the same token land within a tight time window -
 * a strong live-tell of coordinated/bot-driven buying, derivable purely
 * from the trade stream. */
export function timingCorrelationEdges(trades: NormalizedTradeEvent[]): ClusterEdge[] {
  const buys = trades.filter((t) => t.side === "BUY").sort((a, b) => a.blockTime - b.blockTime);
  const edges: ClusterEdge[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < buys.length; i++) {
    for (let j = i + 1; j < buys.length; j++) {
      if (buys[j].blockTime - buys[i].blockTime > TIMING_CORRELATION_WINDOW_SECONDS) break;
      if (buys[i].wallet === buys[j].wallet) continue;
      const key = [buys[i].wallet, buys[j].wallet].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const deltaSeconds = buys[j].blockTime - buys[i].blockTime;
      const weight = 1 - deltaSeconds / TIMING_CORRELATION_WINDOW_SECONDS;
      edges.push({ a: buys[i].wallet, b: buys[j].wallet, reason: "timing-correlation", weight });
    }
  }
  return edges;
}

/** Wallets that repeatedly show up buying the same set of tokens together
 * across a wallet's full history - a slower-burning but reliable tell of an
 * operating group. `tradesByToken` groups a candidate wallet set's trades
 * across multiple tokens so shared participation can be counted. */
export function repeatedCoBuyEdges(tradesByToken: Map<string, NormalizedTradeEvent[]>): ClusterEdge[] {
  const walletTokens = new Map<string, Set<string>>();
  for (const [tokenMint, trades] of tradesByToken) {
    for (const t of trades.filter((tr) => tr.side === "BUY")) {
      const set = walletTokens.get(t.wallet) ?? new Set<string>();
      set.add(tokenMint);
      walletTokens.set(t.wallet, set);
    }
  }

  const wallets = [...walletTokens.keys()];
  const edges: ClusterEdge[] = [];
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const a = walletTokens.get(wallets[i])!;
      const b = walletTokens.get(wallets[j])!;
      const shared = [...a].filter((t) => b.has(t)).length;
      if (shared >= CO_BUY_MIN_SHARED_TOKENS) {
        const weight = Math.min(1, shared / 4);
        edges.push({ a: wallets[i], b: wallets[j], reason: "repeated-co-buy", weight });
      }
    }
  }
  return edges;
}
