import { z } from "zod";

export const walletGateSchema = z.object({
  minTradeCount: z.number().positive(),
  minWinRate: z.number().min(0).max(1),
  minRealizedPnlUsd: z.number(),
  minAvgRoiPct: z.number(),
  minWhaleBuySizeUsd: z.number().positive(),
  maxDrawdownPct: z.number().positive(),
  minEarlyEntryFrequency: z.number().min(0).max(1),
  maxRugExposureCount: z.number().int().nonnegative(),
  minWhaleScore: z.number().min(0).max(100),
});

export const walletScoreWeightsSchema = z.object({
  consistency: z.number(),
  timing: z.number(),
  selectivity: z.number(),
  exitQuality: z.number(),
  rugAvoidance: z.number(),
  recentPerformance: z.number(),
});

export const tokenRiskWeightsSchema = z.object({
  ageRisk: z.number(),
  liquidityRisk: z.number(),
  concentrationRisk: z.number(),
  authorityRisk: z.number(),
  buyerDiversityRisk: z.number(),
  flowRisk: z.number(),
  // Ships at 0 - computed and visible on every TokenRiskScore from day one
  // (creatorRiskComponent in tokenRiskScoring.ts), but contributes nothing
  // to riskScore until an operator deliberately rebalances the weights.
  // Recommended rebalanced split when turning it on: age .20, liquidity
  // .18, concentration .18, authority .12, buyerDiversity .08, flow .08,
  // creatorRisk .16 (sums to 1.00).
  creatorRisk: z.number(),
});

export const dexNameSchema = z.enum(["raydium", "orca", "pumpfun", "meteora", "jupiter", "unknown"]);

export const tokenThresholdsSchema = z.object({
  maxTokenRiskScore: z.number().min(0).max(100),
  minLiquidityUsd: z.number().positive(),
  minAgeSeconds: z.number().nonnegative(),
  // Upper bound on token age at entry time - a whale ENTRY sniper wants
  // fresh discovery, not a position opened hours into an already-mature
  // pump. Trades on tokens older than this are rejected by the entry gate
  // even if every other safeguard passes.
  maxAgeSeconds: z.number().positive(),
  // Which DEXes/venues a trade is allowed to have happened on. pump.fun
  // tokens trade on its own bonding-curve program until ~$69k market cap,
  // then migrate to Raydium - both are legitimate venues for the same
  // token over its lifecycle, so both must be allowed for pump.fun/DexScreener
  // trading to work end-to-end.
  allowedDexes: z.array(dexNameSchema).min(1),
});

export const clusterThresholdsSchema = z.object({
  edgeMergeThreshold: z.number().min(0).max(1),
  manipulationPenaltyCap: z.number().min(0).max(100),
});

export const signalWeightsSchema = z.object({
  whaleQuality: z.number(),
  tokenQuality: z.number(),
  liquidity: z.number(),
  buyingMomentum: z.number(),
  independentBuyers: z.number(),
  earlyEntryQuality: z.number(),
  manipulationPenalty: z.number(),
});

export const entryGateSchema = z.object({
  minSignalScore: z.number().min(0).max(100),
  minIndependentBuyers: z.number().int().nonnegative(),
  minBuyingMomentumUsd5m: z.number().nonnegative(),
  maxSlippagePct: z.number().positive(),
});

export const positionSchema = z.object({
  takeProfitLadder: z.array(
    z.object({
      triggerPct: z.number().positive(),
      sellFraction: z.number().positive().max(1),
    }),
  ),
  trailingActivationPct: z.number().positive(),
  // Both are percentages of price below a reference; at >=100 the stop
  // price is <= 0 and can never trigger.
  trailingTrailPct: z.number().positive().lt(100),
  initialStopLossPct: z.number().positive().lt(100),
  maxHoldTimeSeconds: z.number().positive(),
});

export const whaleExitSchema = z
  .object({
    warnThresholdPct: z.number().min(0).max(1),
    reduceThresholdPct: z.number().min(0).max(1),
    emergencyThresholdPct: z.number().min(0).max(1),
    reduceSellFraction: z.number().min(0).max(1),
    liquidityDeteriorationPct: z.number().min(0).max(1),
    volumeReversalRatio: z.number().positive(),
  })
  .refine((w) => w.warnThresholdPct <= w.reduceThresholdPct && w.reduceThresholdPct <= w.emergencyThresholdPct, {
    message: "whaleExit thresholds must satisfy warn <= reduce <= emergency",
  });

export const riskSchema = z.object({
  maxTradeSizeUsd: z.number().positive(),
  maxDailyLossUsd: z.number().positive(),
  maxOpenPositions: z.number().int().positive(),
  maxTotalExposureUsd: z.number().positive(),
  maxPerTokenExposureUsd: z.number().positive(),
  maxPerClusterExposureUsd: z.number().positive(),
  maxSlippagePct: z.number().positive(),
  maxTxCostUsd: z.number().positive(),
  maxConsecutiveLosses: z.number().int().positive(),
  cooldownSecondsAfterLoss: z.number().nonnegative(),
});

export const executionSchema = z.object({
  baseSlippagePct: z.number().nonnegative(),
  slippageSizeImpactK: z.number().nonnegative(),
  dexFeePct: z.number().nonnegative(),
  mockGasUsd: z.number().nonnegative(),
});

export const walletDiscoverySchema = z.object({
  // Off by default - WhaleDiscoveryEngine.start() is a no-op subscriber
  // (never touches the watchlist) while this is false, so the manual
  // watchlist-only path is completely unchanged unless an operator opts in.
  enabled: z.boolean(),
  // When true, a candidate that clears the hard gate + cluster check goes
  // straight to "active" (tradeable) instead of "pending" (awaiting
  // /approve via telegram-bot). Only meaningful when enabled is true.
  autoPromote: z.boolean(),
});

export const strategyConfigSchema = z.object({
  walletGate: walletGateSchema,
  walletScoreWeights: walletScoreWeightsSchema,
  tokenRiskWeights: tokenRiskWeightsSchema,
  tokenThresholds: tokenThresholdsSchema,
  clusterThresholds: clusterThresholdsSchema,
  signalWeights: signalWeightsSchema,
  entryGate: entryGateSchema,
  position: positionSchema,
  whaleExit: whaleExitSchema,
  risk: riskSchema,
  execution: executionSchema,
  walletDiscovery: walletDiscoverySchema,
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export function parseStrategyConfig(raw: unknown): StrategyConfig {
  return strategyConfigSchema.parse(raw);
}
