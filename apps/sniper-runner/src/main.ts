import { loadEnvFile, resolveSolanaRpcEndpoint } from "@whale-sniper/core";
import { buildAppContext, startApp } from "./wiring.js";

// Before anything reads process.env - otherwise a configured .env is inert.
const envFileLoaded = loadEnvFile();

async function main(): Promise<void> {
  const ctx = await buildAppContext();
  ctx.logger.info(
    {
      envFile: envFileLoaded ? "loaded .env" : "no .env found - using defaults",
      feedProvider: ctx.env.FEED_PROVIDER,
      solanaRpc: resolveSolanaRpcEndpoint(ctx.env)?.label ?? "none",
      tokenDataProvider: ctx.env.TOKEN_DATA_PROVIDER,
      walletRelationshipSource: ctx.env.WALLET_RELATIONSHIP_SOURCE,
      liveTradingEnabled: ctx.env.LIVE_TRADING_ENABLED,
      healthPort: ctx.env.HEALTH_PORT,
    },
    "starting whale-sniper",
  );
  if (ctx.env.FEED_PROVIDER === "mock") {
    ctx.logger.warn(
      {},
      "feed provider is MOCK - all wallets, tokens and trades are fabricated fixtures. Set FEED_PROVIDER=helius in .env for real chain data.",
    );
  }

  const { stop } = await startApp(ctx);

  ctx.logger.info({}, `health/metrics available at http://localhost:${ctx.env.HEALTH_PORT}/health and /metrics`);
  ctx.logger.info({}, `dashboard available at http://localhost:${ctx.env.HEALTH_PORT}/ (read-only)`);
  ctx.bus.on("signal.generated", ({ tokenMint, score }) => {
    ctx.logger.info({ tokenMint, score }, "signal generated");
  });
  ctx.bus.on("position.opened", ({ positionId, tokenMint }) => {
    ctx.logger.info({ positionId, tokenMint }, "paper position opened");
  });
  ctx.bus.on("position.closed", ({ positionId, reason }) => {
    ctx.logger.info({ positionId, reason }, "paper position closed");
  });
  ctx.bus.on("signal.rejected", ({ tokenMint, reason }) => {
    ctx.logger.debug({ tokenMint, reason }, "signal rejected");
  });

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, "shutting down");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal error starting whale-sniper", err);
  process.exit(1);
});
