import type { EventBus, Position, StrategyConfig } from "@whale-sniper/core";
import type { IPositionRepository } from "@whale-sniper/db";
import { applyPaperExit } from "@whale-sniper/paper-trading";
import { applyPriceTick, decideNextAction, markTakeProfitFilled } from "./positionStateMachine.js";

const MAX_ACTIONS_PER_TICK = 10; // guards against any pathological infinite loop

/** Drives the TP ladder / trailing stop / max-hold state machine off price
 * ticks, executing (and persisting) whatever fills the state machine
 * decides on. */
export class PositionManager {
  constructor(
    private readonly bus: EventBus,
    private readonly repo: IPositionRepository,
    private readonly config: StrategyConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async onPriceTick(position: Position, priceUsd: number, liquidityUsd: number, nowMs: number = this.now()): Promise<Position> {
    if (position.status === "CLOSED") return position;

    applyPriceTick(position, priceUsd, this.config);

    for (let i = 0; i < MAX_ACTIONS_PER_TICK; i++) {
      const outcome = decideNextAction(position, this.config, nowMs);
      if (outcome.kind === "NO_ACTION") break;

      if (outcome.kind === "PARTIAL_EXIT") {
        applyPaperExit(position, priceUsd, outcome.sellFraction, liquidityUsd, this.config, outcome.reason, nowMs);
        markTakeProfitFilled(position, outcome.triggerPct);
        await this.repo.savePosition(position);
        // A ladder level that sells everything that's left (e.g. levels
        // summing to 100%) closes the position - report it as a close, or
        // every position.closed consumer (metrics, risk engine, Telegram)
        // misses it.
        if ((position.status as string) === "CLOSED") {
          this.bus.emit("position.closed", { positionId: position.positionId, reason: outcome.reason });
          break;
        }
        this.bus.emit("position.updated", { positionId: position.positionId });
      } else {
        applyPaperExit(position, priceUsd, 1, liquidityUsd, this.config, outcome.reason, nowMs);
        await this.repo.savePosition(position);
        this.bus.emit("position.closed", { positionId: position.positionId, reason: outcome.reason });
        break;
      }
    }

    if (position.status === "OPEN") {
      await this.repo.savePosition(position);
    }
    return position;
  }

  /** Executes an exit outside the normal price-tick state machine - used by
   * whale-exit's tiered response (REDUCE/EMERGENCY), which can fire between
   * ticks based on the triggering whale's own on-chain selling. */
  async forceExit(
    position: Position,
    priceUsd: number,
    sellFraction: number,
    liquidityUsd: number,
    reason: Position["exitReason"],
  ): Promise<Position> {
    if (position.status === "CLOSED") return position;
    applyPaperExit(position, priceUsd, sellFraction, liquidityUsd, this.config, reason, this.now());
    await this.repo.savePosition(position);
    // applyPaperExit may have just flipped status to CLOSED via mutation,
    // which TS can't see through the call above - compare through `string`
    // so the check isn't (incorrectly) narrowed away by the early return.
    if ((position.status as string) === "CLOSED") {
      this.bus.emit("position.closed", { positionId: position.positionId, reason: reason ?? "MANUAL" });
    } else {
      this.bus.emit("position.updated", { positionId: position.positionId });
    }
    return position;
  }
}
