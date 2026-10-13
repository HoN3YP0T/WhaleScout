/**
 * Records the live pump.fun feed - exactly the NormalizedTradeEvents the bot
 * would see, including on-chain pool liquidity - to a JSONL file, for
 * backtesting on real data (scripts/backtest-pumpfun.ts --recording).
 *
 *   npx tsx scripts/record-feed.ts --minutes 90
 *
 * Uses SOLANA_RPC_URL / HELIUS_API_KEY when set, else the public mainnet RPC.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus, createLogger, loadEnvFile, resolveSolanaRpcEndpoint } from "@whale-sniper/core";
import { FeedManager, HeliusFeedProvider, LiveSolUsdPrice } from "@whale-sniper/feed";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const i = process.argv.indexOf("--minutes");
const minutes = i === -1 ? 60 : Number(process.argv[i + 1]);

loadEnvFile();
const endpoint = resolveSolanaRpcEndpoint({
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? "" : "https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? "",
  HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? "",
})!;

async function main(): Promise<void> {
  const dir = path.join(REPO_ROOT, ".cache", "feed-recordings");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const out = createWriteStream(file);
  const bus = new EventBus();
  let n = 0;
  bus.on("trade.normalized", (e) => {
    out.write(JSON.stringify(e) + "\n");
    n += 1;
  });
  const price = new LiveSolUsdPrice();
  const feed = new FeedManager(
    new HeliusFeedProvider({ apiKey: process.env.HELIUS_API_KEY ?? "", rpcUrl: endpoint.httpUrl, wsUrl: endpoint.wsUrl, solUsdPrice: price }),
    bus,
    createLogger("record-feed", "warn"),
  );
  await feed.start();
  console.log(`Recording ${endpoint.label} for ${minutes} min -> ${path.relative(REPO_ROOT, file)} (SOL $${price.current()})`);
  const progress = setInterval(() => console.log(`  ${n} trades`), 5 * 60_000);
  await new Promise((r) => setTimeout(r, minutes * 60_000));
  clearInterval(progress);
  await feed.stop();
  await new Promise<void>((r) => out.end(r));
  console.log(`Done: ${n} trades`);
  process.exit(0);
}

main().catch((err) => {
  console.error("recording failed:", err);
  process.exit(1);
});
