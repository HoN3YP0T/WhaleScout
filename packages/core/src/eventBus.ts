import { rootLogger } from "./logger.js";
import type { DomainEventMap, DomainEventName } from "./types/events.js";

/** Listeners may be async; a returned promise is not awaited, but its
 * rejection is routed to the bus's error handler rather than escaping as an
 * unhandled rejection (which terminates a Node >=15 process). */
type Listener<K extends DomainEventName> = (payload: DomainEventMap[K]) => unknown;

export type ListenerErrorHandler = (event: DomainEventName, error: unknown) => void;

const defaultErrorHandler: ListenerErrorHandler = (event, error) => {
  rootLogger.error({ event, err: error instanceof Error ? error.message : String(error) }, "event listener failed");
};

/** Minimal typed pub/sub bus. Deliberately synchronous so unit/integration
 * tests can assert on side effects without waiting on a microtask queue.
 *
 * Each listener is isolated: one that throws (or rejects) is reported via
 * `onListenerError` and never stops the remaining listeners or propagates
 * into the emitter - otherwise e.g. a failing stats writer would silently
 * hide the trade from the orchestrator, and the feed provider that emitted
 * it would miscount the pipeline's error as a feed decode error. */
export class EventBus {
  private listeners: Map<DomainEventName, Set<Listener<any>>> = new Map();

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  on<K extends DomainEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  emit<K extends DomainEventName>(event: K, payload: DomainEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((err: unknown) => this.reportError(event, err));
        }
      } catch (err) {
        this.reportError(event, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  private reportError(event: DomainEventName, error: unknown): void {
    try {
      this.onListenerError(event, error);
    } catch {
      // An error handler that itself throws must not take the bus down.
    }
  }
}

export function createEventBus(onListenerError?: ListenerErrorHandler): EventBus {
  return new EventBus(onListenerError);
}
