/**
 * Live feed diagnostic. Connects to Helius, subscribes to pump.fun, and
 * reports what actually decodes.
 *
 * Exists because `pumpFunDecoder.ts`'s TradeEvent byte layout was written
 * from pump.fun's public IDL and never checked against a real transaction -
 * there was no API key available when it was built. A silently-wrong layout
 * looks identical to "the market is quiet": zero trades, no errors. This
 * separates those two cases before you trust the feed with a strategy.
 *
 *   HELIUS_API_KEY=... npx tsx scripts/verify-feed.ts
 *   HELIUS_API_KEY=... npx tsx scripts/verify-feed.ts --seconds 60
 */

import { loadEnvFile, resolveSolanaRpcEndpoint } from "@whale-sniper/core";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodePumpFunTradeLog,
  PUMP_FUN_PROGRAM_ID,
  pumpFunTradeToNormalizedEvent,
} from "../packages/feed/src/pumpFunDecoder.js";

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const parsed = Number(process.argv[i + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

loadEnvFile();
const endpoint = resolveSolanaRpcEndpoint({
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "",
  SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? "",
  HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? "",
});
const seconds = arg("--seconds", 30);
const sampleLimit = arg("--samples", 3);
/* Only affects the USD figure printed in samples, not whether decoding works. */
const SOL_USD_PRICE = arg("--sol-price", 150);

if (!endpoint) {
  console.error("Neither HELIUS_API_KEY nor SOLANA_RPC_URL is set (checked .env and the environment).\n");
  console.error("  Put HELIUS_API_KEY=your-key in .env, or:");
  console.error("  SOLANA_RPC_URL=https://api.mainnet-beta.solana.com npm run verify:feed");
  process.exit(1);
}

const httpUrl = endpoint.httpUrl;
const wsUrl = endpoint.wsUrl;

const stats = {
  notifications: 0,
  withProgramData: 0,
  decoded: 0,
  decodeFailed: 0,
  buys: 0,
  sells: 0,
};
const samples: string[] = [];
const failedSamples: string[] = [];

async function main(): Promise<void> {
  console.log(`Connecting to ${endpoint!.label}, watching pump.fun (${PUMP_FUN_PROGRAM_ID}) for ${seconds}s...\n`);

  const connection = new Connection(httpUrl, { commitment: "confirmed", wsEndpoint: wsUrl });

  // Prove the key and the HTTP endpoint work before blaming the decoder for
  // an empty result: a bad key fails here, loudly, instead of looking quiet.
  const slot = await connection.getSlot();
  console.log(`RPC reachable. Current slot: ${slot.toLocaleString()}\n`);

  const subId = connection.onLogs(
    new PublicKey(PUMP_FUN_PROGRAM_ID),
    (logs) => {
      stats.notifications += 1;
      if (logs.err) return;

      const hasProgramData = logs.logs.some((l) => l.startsWith("Program data:"));
      if (!hasProgramData) return;
      stats.withProgramData += 1;

      const trade = decodePumpFunTradeLog({ signature: logs.signature, err: logs.err, logs: logs.logs });
      if (!trade) {
        stats.decodeFailed += 1;
        if (failedSamples.length < sampleLimit) {
          const line = logs.logs.find((l) => l.startsWith("Program data:")) ?? "";
          failedSamples.push(`${logs.signature}\n    ${line.slice(0, 180)}`);
        }
        return;
      }

      stats.decoded += 1;
      if (trade.isBuy) stats.buys += 1;
      else stats.sells += 1;

      if (samples.length < sampleLimit) {
        const normalized = pumpFunTradeToNormalizedEvent(trade, {
          solUsdPrice: SOL_USD_PRICE,
          slot: 0,
          txSignature: logs.signature,
          receivedAt: Date.now(),
        });
        samples.push(
          [
            `  ${normalized.side} ${normalized.tokenMint}`,
            `    wallet:  ${normalized.wallet}`,
            `    amount:  ${normalized.tokenAmount} tokens  (~$${normalized.usdValue.toFixed(2)})`,
            `    tx:      https://solscan.io/tx/${logs.signature}`,
          ].join("\n"),
        );
      }
    },
    "confirmed",
  );

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await connection.removeOnLogsListener(subId);

  report();
  process.exit(stats.decoded > 0 ? 0 : 1);
}

function report(): void {
  console.log("─".repeat(64));
  console.log(`log notifications received : ${stats.notifications}`);
  console.log(`  carrying Program data    : ${stats.withProgramData}`);
  console.log(`  decoded as trades        : ${stats.decoded}  (${stats.buys} buy / ${stats.sells} sell)`);
  console.log(`  failed to decode         : ${stats.decodeFailed}`);
  console.log("─".repeat(64));

  if (samples.length > 0) {
    console.log("\nSample decoded trades - check these against Solscan:\n");
    console.log(samples.join("\n\n"));
  }
  if (failedSamples.length > 0) {
    console.log("\nSamples that failed to decode:\n");
    console.log(failedSamples.map((s) => `  ${s}`).join("\n\n"));
  }

  console.log("\n" + "─".repeat(64));
  if (stats.notifications === 0) {
    console.log("VERDICT: no notifications at all. The subscription never delivered -");
    console.log("suspect the WS endpoint, the API key's plan, or network egress.");
  } else if (stats.withProgramData === 0) {
    console.log("VERDICT: notifications arrived but none carried a 'Program data:' line.");
    console.log("pump.fun may have changed how it emits events; the decoder needs revisiting.");
  } else if (stats.decoded === 0) {
    console.log("VERDICT: DECODER IS WRONG. Events are arriving with Program data, but");
    console.log("none decode - the TradeEvent byte layout does not match reality.");
    console.log("Do not trust this feed until pumpFunDecoder.ts is corrected.");
  } else if (stats.decodeFailed > stats.decoded) {
    console.log("VERDICT: PARTIALLY WORKING. More events failed than decoded - the layout");
    console.log("is probably right for one event variant but not others.");
  } else {
    console.log("VERDICT: FEED WORKS. Trades are decoding. Spot-check a sample tx on");
    console.log("Solscan above to confirm wallet/mint/amount match what really happened.");
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\nFailed:", message);

  // A network-policy 403 and a rejected-key 403 read the same at a glance,
  // and blaming the key for a blocked egress sends you chasing the wrong bug.
  if (/allowlist|egress|tunnel|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(message)) {
    console.error("\nThis is your network blocking the host, not Helius rejecting the key -");
    console.error("the request never reached them. Run this from a machine with open egress.");
  } else if (/401|403|unauthorized|forbidden/i.test(message)) {
    console.error("\nHelius rejected the credentials. Check HELIUS_API_KEY and its plan.");
  }
  process.exit(1);
});
