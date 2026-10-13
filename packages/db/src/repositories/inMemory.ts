import type {
  CreatorReputation,
  NormalizedTradeEvent,
  Position,
  Signal,
  TokenRiskScore,
  TokenStats,
  WalletCluster,
  WalletScoreBreakdown,
  WalletStats,
} from "@whale-sniper/core";
import {
  normalizeWatchlistEntry,
  type ICreatorRegistryRepository,
  type IClusterRepository,
  type IPositionRepository,
  type IRiskStateRepository,
  type ISignalRepository,
  type ITokenRepository,
  type ITradeRepository,
  type IWalletRepository,
  type IWatchlistRepository,
  type Repositories,
  type RiskState,
  type WatchlistEntry,
  type WatchlistEntryStatus,
} from "./types.js";

export class InMemoryWalletRepository implements IWalletRepository {
  private stats = new Map<string, WalletStats>();
  private scores = new Map<string, WalletScoreBreakdown>();

  async upsertStats(stats: WalletStats): Promise<void> {
    this.stats.set(stats.wallet, stats);
  }
  async getStats(wallet: string): Promise<WalletStats | undefined> {
    return this.stats.get(wallet);
  }
  async upsertScore(score: WalletScoreBreakdown): Promise<void> {
    this.scores.set(score.wallet, score);
  }
  async getScore(wallet: string): Promise<WalletScoreBreakdown | undefined> {
    return this.scores.get(wallet);
  }
}

export class InMemoryTokenRepository implements ITokenRepository {
  private stats = new Map<string, TokenStats>();
  private risk = new Map<string, TokenRiskScore>();

  async upsertStats(stats: TokenStats): Promise<void> {
    this.stats.set(stats.tokenMint, stats);
  }
  async getStats(tokenMint: string): Promise<TokenStats | undefined> {
    return this.stats.get(tokenMint);
  }
  async upsertRiskScore(score: TokenRiskScore): Promise<void> {
    this.risk.set(score.tokenMint, score);
  }
  async getRiskScore(tokenMint: string): Promise<TokenRiskScore | undefined> {
    return this.risk.get(tokenMint);
  }
}

export class InMemoryTradeRepository implements ITradeRepository {
  private trades: NormalizedTradeEvent[] = [];

  async recordTrade(event: NormalizedTradeEvent): Promise<void> {
    this.trades.push(event);
  }
  async tradesForWallet(wallet: string): Promise<NormalizedTradeEvent[]> {
    return this.trades.filter((t) => t.wallet === wallet);
  }
}

/** Clusters are an audit trail - nothing in the pipeline reads them back -
 * and a live feed produces new ones for every busy token, each carrying
 * every pairwise edge. Keep the most recently written ones only. */
const MAX_IN_MEMORY_CLUSTERS = 1_000;

export class InMemoryClusterRepository implements IClusterRepository {
  private clusters = new Map<string, WalletCluster>();
  constructor(private readonly capacity: number = MAX_IN_MEMORY_CLUSTERS) {}
  async upsertCluster(cluster: WalletCluster): Promise<void> {
    // Delete first so a re-written cluster moves to the newest position.
    this.clusters.delete(cluster.clusterId);
    this.clusters.set(cluster.clusterId, cluster);
    if (this.clusters.size > this.capacity) {
      const oldest = this.clusters.keys().next().value as string;
      this.clusters.delete(oldest);
    }
  }
  async getCluster(clusterId: string): Promise<WalletCluster | undefined> {
    return this.clusters.get(clusterId);
  }
}

export class InMemorySignalRepository implements ISignalRepository {
  private signals = new Map<string, Signal>();
  private insertionOrder = new Map<string, number>();
  private counter = 0;

  async saveSignal(signal: Signal): Promise<void> {
    this.signals.set(signal.signalId, signal);
    this.insertionOrder.set(signal.signalId, this.counter++);
  }
  async getSignal(signalId: string): Promise<Signal | undefined> {
    return this.signals.get(signalId);
  }
  async recentSignals(limit: number): Promise<Signal[]> {
    // generatedAt is wall-clock ms and can tie under fast synchronous
    // replay (many signals generated within the same millisecond); break
    // ties by insertion order so "most recent" stays meaningful.
    return [...this.signals.values()]
      .sort((a, b) => b.generatedAt - a.generatedAt || this.insertionOrder.get(b.signalId)! - this.insertionOrder.get(a.signalId)!)
      .slice(0, limit);
  }
}

export class InMemoryPositionRepository implements IPositionRepository {
  private positions = new Map<string, Position>();
  async savePosition(position: Position): Promise<void> {
    this.positions.set(position.positionId, { ...position });
  }
  async getPosition(positionId: string): Promise<Position | undefined> {
    return this.positions.get(positionId);
  }
  async getOpenPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.status === "OPEN");
  }
  async allPositions(): Promise<Position[]> {
    return [...this.positions.values()];
  }
}

export class InMemoryWatchlistRepository implements IWatchlistRepository {
  private entries = new Map<string, WatchlistEntry>();
  async load(): Promise<WatchlistEntry[]> {
    return [...this.entries.values()];
  }
  async add(entry: WatchlistEntry): Promise<void> {
    const existing = this.entries.get(entry.address);
    const normalized = normalizeWatchlistEntry(entry);
    this.entries.set(
      entry.address,
      existing ? { ...normalized, status: existing.status, source: existing.source } : normalized,
    );
  }
  async updateStatus(address: string, status: WatchlistEntryStatus, notes?: string): Promise<void> {
    const existing = this.entries.get(address) ?? normalizeWatchlistEntry({ address, source: "auto-discovered" });
    this.entries.set(address, { ...existing, status, notes: notes ?? existing.notes });
  }
  async listByStatus(status: WatchlistEntryStatus): Promise<WatchlistEntry[]> {
    return [...this.entries.values()].filter((e) => e.status === status);
  }
}

export class InMemoryRiskStateRepository implements IRiskStateRepository {
  private state: RiskState = {
    dailyLossUsd: 0,
    dailyLossResetAt: Date.now(),
    consecutiveLosses: 0,
    killSwitchActive: false,
  };
  async get(): Promise<RiskState> {
    return { ...this.state };
  }
  async update(partial: Partial<RiskState>): Promise<RiskState> {
    this.state = { ...this.state, ...partial };
    return { ...this.state };
  }
}

export class InMemoryCreatorRegistryRepository implements ICreatorRegistryRepository {
  private reputations = new Map<string, CreatorReputation>();
  async upsertReputation(reputation: CreatorReputation): Promise<void> {
    this.reputations.set(reputation.creatorAddress, reputation);
  }
  async loadAll(): Promise<CreatorReputation[]> {
    return [...this.reputations.values()];
  }
}

export function createInMemoryRepositories(): Repositories {
  return {
    wallet: new InMemoryWalletRepository(),
    token: new InMemoryTokenRepository(),
    trade: new InMemoryTradeRepository(),
    cluster: new InMemoryClusterRepository(),
    signal: new InMemorySignalRepository(),
    position: new InMemoryPositionRepository(),
    watchlist: new InMemoryWatchlistRepository(),
    riskState: new InMemoryRiskStateRepository(),
    creatorReputation: new InMemoryCreatorRegistryRepository(),
  };
}
