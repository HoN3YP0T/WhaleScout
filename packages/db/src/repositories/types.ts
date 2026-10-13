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

/**
 * Watchlist entries are a small state machine (see `WatchlistIndex` in
 * wallet-intel and `WhaleDiscoveryEngine`):
 * - "active": tradeable - `SniperOrchestrator` acts on this wallet's buys.
 * - "pending": an auto-discovered candidate awaiting operator review
 *   (`/candidates`, `/approve`, `/reject` in telegram-bot).
 * - "rejected": auto-discovered but failed a hard gate/cluster check, or an
 *   operator rejected it - never tradeable.
 */
export type WatchlistEntryStatus = "pending" | "active" | "rejected";
/** "manual": from config/watchlist.json or an operator addition.
 * "auto-discovered": promoted/pended by WhaleDiscoveryEngine. */
export type WatchlistEntrySource = "manual" | "auto-discovered";

export interface WatchlistEntry {
  address: string;
  label?: string;
  notes?: string;
  /** Optional so every existing call site (config/watchlist.json entries,
   * scripts/seed-watchlist.ts, existing tests, backtest fixtures) keeps
   * compiling and behaving unchanged - `normalizeWatchlistEntry()` fills in
   * the default ({status: "active", source: "manual"}) wherever entries are
   * loaded or added. */
  status?: WatchlistEntryStatus;
  source?: WatchlistEntrySource;
}

/** Fills in the default status/source for a watchlist entry that doesn't
 * specify them - applied at every point entries enter the system (both
 * repository `add()` implementations, `WatchlistIndex.load()`/`upsert()`)
 * so a manually-curated entry from config/watchlist.json (which has no
 * concept of status/source) is always treated as an active, manually-added
 * wallet, exactly as it always has been. */
export function normalizeWatchlistEntry(entry: WatchlistEntry): WatchlistEntry & {
  status: WatchlistEntryStatus;
  source: WatchlistEntrySource;
} {
  return {
    ...entry,
    status: entry.status ?? "active",
    source: entry.source ?? "manual",
  };
}

export interface RiskState {
  dailyLossUsd: number;
  dailyLossResetAt: number;
  consecutiveLosses: number;
  cooldownUntil?: number;
  killSwitchActive: boolean;
}

/** Every repository is defined as a plain interface so packages depend on
 * behavior, not on Prisma directly - unit tests use in-memory
 * implementations, the live app uses the Prisma-backed ones. */
export interface IWalletRepository {
  upsertStats(stats: WalletStats): Promise<void>;
  getStats(wallet: string): Promise<WalletStats | undefined>;
  upsertScore(score: WalletScoreBreakdown): Promise<void>;
  getScore(wallet: string): Promise<WalletScoreBreakdown | undefined>;
}

export interface ITokenRepository {
  upsertStats(stats: TokenStats): Promise<void>;
  getStats(tokenMint: string): Promise<TokenStats | undefined>;
  upsertRiskScore(score: TokenRiskScore): Promise<void>;
  getRiskScore(tokenMint: string): Promise<TokenRiskScore | undefined>;
}

export interface ITradeRepository {
  recordTrade(event: NormalizedTradeEvent): Promise<void>;
  tradesForWallet(wallet: string): Promise<NormalizedTradeEvent[]>;
}

export interface IClusterRepository {
  upsertCluster(cluster: WalletCluster): Promise<void>;
  getCluster(clusterId: string): Promise<WalletCluster | undefined>;
}

export interface ISignalRepository {
  saveSignal(signal: Signal): Promise<void>;
  getSignal(signalId: string): Promise<Signal | undefined>;
  recentSignals(limit: number): Promise<Signal[]>;
}

export interface IPositionRepository {
  savePosition(position: Position): Promise<void>;
  getPosition(positionId: string): Promise<Position | undefined>;
  getOpenPositions(): Promise<Position[]>;
  allPositions(): Promise<Position[]>;
}

export interface IWatchlistRepository {
  load(): Promise<WatchlistEntry[]>;
  /** Inserts an entry, or refreshes an existing one's label/notes. An
   * existing entry's status/source are kept: re-seeding config/watchlist.json
   * on every boot must not re-activate a wallet an operator /reject'ed. */
  add(entry: WatchlistEntry): Promise<void>;
  /** Updates (or creates, for a wallet with no prior entry) a wallet's
   * status - used by `WhaleDiscoveryEngine` to move a candidate to
   * "pending"/"active"/"rejected" and by telegram-bot's /approve, /reject. */
  updateStatus(address: string, status: WatchlistEntryStatus, notes?: string): Promise<void>;
  listByStatus(status: WatchlistEntryStatus): Promise<WatchlistEntry[]>;
}

export interface IRiskStateRepository {
  get(): Promise<RiskState>;
  update(partial: Partial<RiskState>): Promise<RiskState>;
}

/** Persists `CreatorRegistry`'s reputation map so it survives restarts -
 * hydrated at boot, upserted on every observed/rugged update. */
export interface ICreatorRegistryRepository {
  upsertReputation(reputation: CreatorReputation): Promise<void>;
  loadAll(): Promise<CreatorReputation[]>;
}

export interface Repositories {
  wallet: IWalletRepository;
  token: ITokenRepository;
  trade: ITradeRepository;
  cluster: IClusterRepository;
  signal: ISignalRepository;
  position: IPositionRepository;
  watchlist: IWatchlistRepository;
  riskState: IRiskStateRepository;
  creatorReputation: ICreatorRegistryRepository;
}
