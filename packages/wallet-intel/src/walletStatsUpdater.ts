import type {
  Clock,
  EventBus,
  NormalizedTradeEvent,
  RuggedTokenRegistry,
  TokenFirstSeenIndex,
  WalletStats,
} from "@whale-sniper/core";
import type { IWalletRepository } from "@whale-sniper/db";

interface OpenLot {
  quantity: number;
  costUsd: number;
}

interface WalletAccumulator {
  wallet: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  realizedPnlUsd: number;
  roiSum: number;
  buyCount: number;
  buyUsdSum: number;
  earlyBuyCount: number;
  rugExposureCount: number;
  equityPeak: number;
  equityCurrent: number;
  maxDrawdownPct: number;
  firstTradeAt: number;
  lastTradeAt: number;
  openLots: Map<string, OpenLot>; // keyed by tokenMint
}

const EARLY_ENTRY_WINDOW_SECONDS = 120;

function newAccumulator(wallet: string): WalletAccumulator {
  return {
    wallet,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    realizedPnlUsd: 0,
    roiSum: 0,
    buyCount: 0,
    buyUsdSum: 0,
    earlyBuyCount: 0,
    rugExposureCount: 0,
    equityPeak: 0,
    equityCurrent: 0,
    maxDrawdownPct: 0,
    firstTradeAt: 0,
    lastTradeAt: 0,
    openLots: new Map(),
  };
}

function toStats(acc: WalletAccumulator): WalletStats {
  return {
    wallet: acc.wallet,
    tradeCount: acc.tradeCount,
    winCount: acc.winCount,
    lossCount: acc.lossCount,
    winRate: acc.tradeCount > 0 ? acc.winCount / acc.tradeCount : 0,
    realizedPnlUsd: acc.realizedPnlUsd,
    avgRoiPct: acc.tradeCount > 0 ? (acc.roiSum / acc.tradeCount) * 100 : 0,
    maxDrawdownPct: acc.maxDrawdownPct,
    avgWhaleBuySizeUsd: acc.buyCount > 0 ? acc.buyUsdSum / acc.buyCount : 0,
    earlyEntryFrequency: acc.buyCount > 0 ? acc.earlyBuyCount / acc.buyCount : 0,
    rugExposureCount: acc.rugExposureCount,
    lastTradeAt: acc.lastTradeAt,
    firstTradeAt: acc.firstTradeAt,
  };
}

/**
 * Maintains incremental, as-of-timestamp wallet statistics from the live
 * (or replayed) trade stream. Every input is a NormalizedTradeEvent already
 * on the bus, so this never looks ahead of what has actually happened by
 * the current Clock position.
 */
export class WalletStatsUpdater {
  private accumulators = new Map<string, WalletAccumulator>();

  constructor(
    private readonly bus: EventBus,
    private readonly repo: IWalletRepository,
    private readonly tokenFirstSeen: TokenFirstSeenIndex,
    private readonly ruggedRegistry: RuggedTokenRegistry,
    private readonly clock: Clock,
  ) {}

  start(): () => void {
    return this.bus.on("trade.normalized", (event) => {
      return this.handle(event);
    });
  }

  getStats(wallet: string): WalletStats | undefined {
    const acc = this.accumulators.get(wallet);
    return acc ? toStats(acc) : undefined;
  }

  private async handle(event: NormalizedTradeEvent): Promise<void> {
    this.tokenFirstSeen.record(event.tokenMint, event.blockTime);

    let acc = this.accumulators.get(event.wallet);
    if (!acc) {
      acc = newAccumulator(event.wallet);
      this.accumulators.set(event.wallet, acc);
    }

    if (acc.firstTradeAt === 0) acc.firstTradeAt = this.clock.now();
    acc.lastTradeAt = this.clock.now();

    if (event.side === "BUY") {
      this.handleBuy(acc, event);
    } else {
      this.handleSell(acc, event);
    }

    await this.repo.upsertStats(toStats(acc));
    this.bus.emit("wallet.stats-updated", { wallet: event.wallet, tokenMint: event.tokenMint });
  }

  private handleBuy(acc: WalletAccumulator, event: NormalizedTradeEvent): void {
    acc.buyCount += 1;
    acc.buyUsdSum += event.usdValue;

    const firstSeen = this.tokenFirstSeen.get(event.tokenMint);
    const secondsSinceLaunch = firstSeen === undefined ? 0 : event.blockTime - firstSeen;
    if (secondsSinceLaunch <= EARLY_ENTRY_WINDOW_SECONDS) {
      acc.earlyBuyCount += 1;
    }

    const existing = acc.openLots.get(event.tokenMint);
    if (existing) {
      existing.quantity += event.tokenAmount;
      existing.costUsd += event.usdValue;
    } else {
      acc.openLots.set(event.tokenMint, { quantity: event.tokenAmount, costUsd: event.usdValue });
    }
  }

  private handleSell(acc: WalletAccumulator, event: NormalizedTradeEvent): void {
    // Proceeds are priced per unit below; a zero/garbage amount would turn
    // realizedPnl/roi into NaN and poison this wallet's stats permanently.
    if (!(event.tokenAmount > 0) || !Number.isFinite(event.usdValue)) return;
    const lot = acc.openLots.get(event.tokenMint);
    if (!lot || lot.quantity <= 0) return; // selling something we never tracked a buy for

    const sellQty = Math.min(event.tokenAmount, lot.quantity);
    const avgCostPerUnit = lot.costUsd / lot.quantity;
    const proportionalCostUsd = avgCostPerUnit * sellQty;
    const proceedsUsd = (event.usdValue / event.tokenAmount) * sellQty;
    const roi = proportionalCostUsd > 0 ? (proceedsUsd - proportionalCostUsd) / proportionalCostUsd : 0;

    lot.quantity -= sellQty;
    lot.costUsd -= proportionalCostUsd;
    if (lot.quantity <= 1e-9) acc.openLots.delete(event.tokenMint);

    acc.tradeCount += 1;
    acc.roiSum += roi;
    acc.realizedPnlUsd += proceedsUsd - proportionalCostUsd;
    if (roi > 0) acc.winCount += 1;
    else acc.lossCount += 1;

    if (this.ruggedRegistry.isRugged(event.tokenMint)) {
      acc.rugExposureCount += 1;
    }

    acc.equityCurrent += proceedsUsd - proportionalCostUsd;
    acc.equityPeak = Math.max(acc.equityPeak, acc.equityCurrent);
    if (acc.equityPeak > 0) {
      const drawdownPct = ((acc.equityPeak - acc.equityCurrent) / acc.equityPeak) * 100;
      acc.maxDrawdownPct = Math.max(acc.maxDrawdownPct, drawdownPct);
    }
  }
}
