import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://whale:whale@localhost:5432/whale_sniper?schema=public"),
  FEED_PROVIDER: z.enum(["mock", "helius"]).default("mock"),
  // Empty by default - no real key exists yet. wiring.ts refuses to select
  // FEED_PROVIDER=helius when this is unset rather than silently falling
  // back to the mock feed.
  HELIUS_API_KEY: z.string().optional().default(""),
  // Any Solana JSON-RPC endpoint (another provider, a self-hosted node, or
  // the public https://api.mainnet-beta.solana.com for testing). When set it
  // is used INSTEAD of Helius by every RPC-backed component - the live
  // feed, dexscreener+rpc, and solana-rpc relationships - and satisfies
  // their "needs an endpoint" check in place of HELIUS_API_KEY. The
  // WebSocket URL defaults to this URL with http(s) -> ws(s); set
  // SOLANA_WS_URL when the provider serves it elsewhere.
  SOLANA_RPC_URL: z.string().optional().default(""),
  SOLANA_WS_URL: z.string().optional().default(""),
  // "dexscreener+rpc" is the recommended real-data option: it merges
  // DexScreener's liquidity/market cap with holder concentration and
  // mint/freeze authority state read from standard Solana RPC (via the
  // operator's existing HELIUS_API_KEY), which is what removes the
  // 35-point token-risk floor a DexScreener-only setup is stuck with. It
  // reads HELIUS_API_KEY, not a new key of its own - see
  // solanaRpcTokenMetadataProvider.ts, and wiring.ts's
  // buildTokenMetadataProvider() for the fail-fast check.
  TOKEN_DATA_PROVIDER: z.enum(["mock", "dexscreener", "dexscreener+rpc", "solscan"]).default("mock"),
  // Empty by default - no real key exists yet. wiring.ts's
  // buildTokenMetadataProvider() refuses to select TOKEN_DATA_PROVIDER=solscan
  // when this is unset rather than silently falling back to mock/dexscreener,
  // mirroring HELIUS_API_KEY's fail-fast contract above.
  SOLSCAN_API_KEY: z.string().optional().default(""),
  // "mock" (default) keeps MockWalletRelationshipSource, whose
  // funder/creator maps are only ever populated by scenario setup - so
  // cluster-detect's common-funder and shared-creator edge detectors
  // contribute nothing in production. "solana-rpc" derives both from
  // on-chain history over the operator's existing HELIUS_API_KEY (no
  // second credential); wiring.ts's buildWalletRelationshipSource()
  // refuses to select it without one, mirroring the fail-fast contract
  // above. See solanaRpcWalletRelationshipSource.ts.
  WALLET_RELATIONSHIP_SOURCE: z.enum(["mock", "solana-rpc"]).default("mock"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  LIVE_TRADING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  HOT_WALLET_KEYPAIR_PATH: z.string().optional().default(""),
  HOT_WALLET_MAX_BALANCE_USD: z
    .string()
    .optional()
    .default("0")
    .transform((v) => Number(v) || 0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HEALTH_PORT: z
    .string()
    .default("3001")
    .transform((v) => Number(v) || 3001),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface SolanaRpcEndpoint {
  httpUrl: string;
  wsUrl: string;
  /** Safe to log - never contains an API key. */
  label: string;
}

export function heliusEndpoint(apiKey: string): SolanaRpcEndpoint {
  return {
    httpUrl: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    label: "helius",
  };
}

/** SOLANA_RPC_URL when set, else Helius when HELIUS_API_KEY is set, else
 * undefined (callers that need RPC must refuse to start). */
export function resolveSolanaRpcEndpoint(
  env: Pick<AppEnv, "SOLANA_RPC_URL" | "SOLANA_WS_URL" | "HELIUS_API_KEY">,
): SolanaRpcEndpoint | undefined {
  if (env.SOLANA_RPC_URL) {
    const url = new URL(env.SOLANA_RPC_URL);
    return {
      httpUrl: env.SOLANA_RPC_URL,
      wsUrl: env.SOLANA_WS_URL || env.SOLANA_RPC_URL.replace(/^http/, "ws"),
      // Host only: providers often embed keys in the path or query string.
      label: url.host,
    };
  }
  if (env.HELIUS_API_KEY) return heliusEndpoint(env.HELIUS_API_KEY);
  return undefined;
}

/**
 * Loads a `.env` file into `process.env`, if one exists.
 *
 * Must be called by every entry point BEFORE `loadEnv()`. Without it a
 * `.env` file is inert - the schema below reads `process.env` and nothing
 * else, so an operator who sets HELIUS_API_KEY there gets silently dropped
 * back to the mock feed with no error explaining why.
 *
 * Uses Node's built-in `process.loadEnvFile` (v20.12+/21.7+; this repo
 * requires >=22) rather than the dotenv package - no dependency needed.
 * Existing process env vars win, so `FEED_PROVIDER=mock npm run start`
 * still overrides the file.
 */
export function loadEnvFile(path = ".env"): boolean {
  const before = { ...process.env };
  try {
    process.loadEnvFile(path);
  } catch {
    return false; // absent or unreadable - mock mode needs no .env
  }
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
  return true;
}

let cached: AppEnv | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached) return cached;
  cached = envSchema.parse(source);
  return cached;
}

/** Test-only: clear the memoized env so a fresh loadEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
