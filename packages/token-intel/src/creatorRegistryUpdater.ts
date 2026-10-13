import type { CreatorRegistry, EventBus, RuggedTokenRegistry } from "@whale-sniper/core";
import type { ICreatorRegistryRepository, ITokenRepository } from "@whale-sniper/db";

/**
 * Listens to the already-emitted `token.stats-updated` event and keeps
 * `CreatorRegistry` in sync with two facts token-intel already knows:
 * "who created this token" (from `TokenStats.creatorAddress`, populated by
 * `SolscanTokenMetadataProvider`) and "has this token been flagged rugged"
 * (from `RuggedTokenRegistry.isRugged()`, set by `TokenStatsCollector`'s
 * UNMODIFIED liquidity-crash detection). This class makes ZERO changes to
 * that rug-detection logic - it only observes its output. Same `start(): ()
 * => void` shape as `TokenStatsCollector` so it plugs into
 * `SniperOrchestrator`'s `unsubscribers.push(...)` list identically.
 */
export class CreatorRegistryUpdater {
  // Idempotency: a creator's tokensCreated/tokensRugged counters must track
  // distinct tokens, not distinct token.stats-updated events (which fire on
  // every trade for a token).
  private observedTokens = new Set<string>();
  private ruggedTokens = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly tokenRepo: ITokenRepository,
    private readonly creatorRegistry: CreatorRegistry,
    private readonly ruggedRegistry: RuggedTokenRegistry,
    // Optional so tests/callers that only care about the in-memory
    // CreatorRegistry behavior don't need a repository - when supplied,
    // every observed/rugged update is also persisted so reputation
    // survives restarts (see CreatorRegistry.hydrate() at boot in wiring.ts).
    private readonly creatorRepo?: ICreatorRegistryRepository,
  ) {}

  start(): () => void {
    return this.bus.on("token.stats-updated", (event) => {
      return this.handle(event.tokenMint);
    });
  }

  private async handle(tokenMint: string): Promise<void> {
    // The event only carries tokenMint, not creatorAddress, so look it up
    // via the token repository (TokenStatsCollector already persisted the
    // latest TokenStats, including creatorAddress, before emitting).
    const stats = await this.tokenRepo.getStats(tokenMint);
    const creatorAddress = stats?.creatorAddress;
    if (!creatorAddress) return; // unknown creator (mock/DexScreener, or not yet resolved) - nothing to record

    if (!this.observedTokens.has(tokenMint)) {
      this.observedTokens.add(tokenMint);
      const updated = this.creatorRegistry.recordTokenObserved(creatorAddress);
      await this.creatorRepo?.upsertReputation(updated);
    }

    if (!this.ruggedTokens.has(tokenMint) && this.ruggedRegistry.isRugged(tokenMint)) {
      this.ruggedTokens.add(tokenMint);
      const updated = this.creatorRegistry.recordTokenRugged(creatorAddress);
      await this.creatorRepo?.upsertReputation(updated);
    }
  }
}
