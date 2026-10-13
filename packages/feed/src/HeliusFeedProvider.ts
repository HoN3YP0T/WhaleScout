import { heliusEndpoint, type ErrorHandler, type FeedHealth, type IFeedProvider, type TradeEventHandler } from "@whale-sniper/core";
import { Connection, PublicKey, type Context, type Logs } from "@solana/web3.js";
import { decodePumpFunTradeLogs, PUMP_FUN_PROGRAM_ID, pumpFunTradeToNormalizedEvent } from "./pumpFunDecoder.js";
import { LiveSolUsdPrice, StaticSolUsdPrice, type SolUsdPriceSource } from "./solUsdPrice.js";

/** Narrow surface of `@solana/web3.js`'s `Connection` this provider needs -
 * lets tests inject a fake instead of opening a real WebSocket. */
export interface ConnectionLike {
  onLogs(
    filter: PublicKey | "all",
    callback: (logs: Logs, ctx: Context) => void,
    commitment?: string,
  ): number;
  removeOnLogsListener(id: number): Promise<void>;
}

export interface HeliusFeedProviderOptions {
  /** Required - the caller (wiring.ts) is responsible for refusing to
   * construct this provider at all when HELIUS_API_KEY is unset, per the
   * "fail fast, never silently fall back" contract for FEED_PROVIDER=helius. */
  apiKey: string;
  /** Use this RPC endpoint instead of Helius (SOLANA_RPC_URL). When set,
   * `apiKey` may be empty. */
  rpcUrl?: string;
  wsUrl?: string;
  /** pump.fun's bonding-curve program id. Overridable for tests/fixtures. */
  programId?: string;
  /** SOL/USD used to convert decoded lamport amounts to USD: a fixed number
   * (tests), or a live source started/stopped with the feed. Defaults to
   * `LiveSolUsdPrice` (DexScreener). */
  solUsdPrice?: number | SolUsdPriceSource;
  /** DI seam for tests: skips opening a real Helius WebSocket. Defaults to
   * a real `@solana/web3.js` Connection against Helius's RPC/WS endpoint. */
  connectionFactory?: (wsUrl: string, httpUrl: string) => ConnectionLike;
}

function defaultConnectionFactory(wsUrl: string, httpUrl: string): ConnectionLike {
  return new Connection(httpUrl, { commitment: "confirmed", wsEndpoint: wsUrl });
}

/**
 * Real-time pump.fun feed backed by Helius's RPC/WS.
 *
 * Approach taken and why: Helius also offers a Geyser-enhanced gRPC
 * ("LaserStream") firehose, which is the lowest-latency option, but its
 * client is a heavier dependency and its exact wire contract is not
 * something this build can verify without a live API key to test against.
 * Instead this subscribes to `logsSubscribe` (via `@solana/web3.js`'s
 * `Connection.onLogs`) filtered to the pump.fun program id, over Helius's
 * standard RPC/WS URL - a plain, well-documented Solana JSON-RPC method
 * that doesn't require a publicly reachable webhook endpoint (which this
 * process doesn't have). It decodes the self-CPI-logged `TradeEvent` out of
 * each notification's logs via `pumpFunDecoder.ts`.
 *
 * Never selected unless the composition root (`wiring.ts`) explicitly opts
 * in with a real `HELIUS_API_KEY` - see that file for the fail-fast check.
 */
export class HeliusFeedProvider implements IFeedProvider {
  readonly name = "helius";

  private readonly programId: string;
  private readonly solUsdPrice: SolUsdPriceSource;
  private readonly connectionFactory: (wsUrl: string, httpUrl: string) => ConnectionLike;

  private connection: ConnectionLike | undefined;
  private subscriptionId: number | undefined;
  private handlers: TradeEventHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private connected = false;
  private eventsReceived = 0;
  private errorsReceived = 0;
  private lastEventAt: number | undefined;

  constructor(private readonly options: HeliusFeedProviderOptions) {
    if (!options.apiKey && !options.rpcUrl) {
      // Defense in depth - wiring.ts already refuses to construct this
      // without a key, but the class itself must never silently proceed
      // unauthenticated if constructed some other way (e.g. directly in a
      // test or a future entry point).
      throw new Error("HeliusFeedProvider requires a non-empty apiKey (HELIUS_API_KEY) or an rpcUrl (SOLANA_RPC_URL)");
    }
    this.programId = options.programId ?? PUMP_FUN_PROGRAM_ID;
    this.solUsdPrice =
      typeof options.solUsdPrice === "number"
        ? new StaticSolUsdPrice(options.solUsdPrice)
        : (options.solUsdPrice ?? new LiveSolUsdPrice());
    this.connectionFactory = options.connectionFactory ?? defaultConnectionFactory;
  }

  async connect(): Promise<void> {
    const helius = heliusEndpoint(this.options.apiKey);
    const httpUrl = this.options.rpcUrl ?? helius.httpUrl;
    const wsUrl = this.options.wsUrl ?? (this.options.rpcUrl ? this.options.rpcUrl.replace(/^http/, "ws") : helius.wsUrl);
    await this.solUsdPrice.start?.();
    this.connection = this.connectionFactory(wsUrl, httpUrl);

    const programPubkey = new PublicKey(this.programId);
    this.subscriptionId = this.connection.onLogs(
      programPubkey,
      (logs, ctx) => {
        this.handleLogs(logs, ctx);
      },
      "confirmed",
    );
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.solUsdPrice.stop?.();
    if (this.connection && this.subscriptionId !== undefined) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    }
    this.subscriptionId = undefined;
    this.connection = undefined;
    this.connected = false;
  }

  onEvent(handler: TradeEventHandler): void {
    this.handlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  health(): FeedHealth {
    return {
      provider: this.name,
      connected: this.connected,
      lastEventAt: this.lastEventAt,
      eventsReceived: this.eventsReceived,
      errorsReceived: this.errorsReceived,
    };
  }

  private handleLogs(logs: Logs, ctx: Context): void {
    try {
      const trades = decodePumpFunTradeLogs({ signature: logs.signature, err: logs.err, logs: logs.logs });
      // No trades = not a trade event (or a failed tx) - not an error.
      const receivedAt = Date.now();
      for (const decoded of trades) {
        const normalized = pumpFunTradeToNormalizedEvent(decoded, {
          solUsdPrice: this.solUsdPrice.current(),
          slot: ctx.slot,
          txSignature: logs.signature,
          receivedAt,
        });
        this.eventsReceived += 1;
        this.lastEventAt = Date.now();
        for (const handler of this.handlers) handler(normalized);
      }
    } catch (err) {
      this.errorsReceived += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const handler of this.errorHandlers) handler(error);
    }
  }
}
