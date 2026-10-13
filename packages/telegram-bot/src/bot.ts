import type { EventBus, Logger, RuntimeFlags } from "@whale-sniper/core";
import type { IPositionRepository, ISignalRepository, IWatchlistRepository } from "@whale-sniper/db";
import type { WatchlistIndex } from "@whale-sniper/wallet-intel";
import { Bot } from "grammy";
import {
  formatEntry,
  formatExit,
  formatSignalRejected,
  formatWhaleAutoPromoted,
  formatWhaleCandidateDiscovered,
  formatWhaleDetected,
  formatWhaleExit,
} from "./notifications.js";

export interface TelegramBotDeps {
  token: string;
  chatId: string;
  bus: EventBus;
  positionRepo: IPositionRepository;
  signalRepo: ISignalRepository;
  watchlistRepo: IWatchlistRepository;
  // Optional: when supplied, /approve and /reject also update the live
  // in-process WatchlistIndex the orchestrator trades off of (the same
  // object WhaleDiscoveryEngine.upsert()s directly), so an approval takes
  // effect immediately rather than only on the next restart. Omitted in
  // tests that don't need that - the repository write alone still
  // persists the decision.
  watchlistIndex?: WatchlistIndex;
  runtimeFlags: RuntimeFlags;
  logger: Logger;
}

/** Solana addresses are 32-byte public keys, base58-encoded to 32-44 chars. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Commands mutate trading state (/resume, /kill, and /approve, which makes a
 * wallet tradeable), so only the configured TELEGRAM_CHAT_ID may issue
 * them. Anyone can message a bot whose username they know. Fails closed:
 * with no chat id configured, nobody is authorized.
 */
export function isAuthorizedChat(configuredChatId: string, incomingChatId: number | string | undefined): boolean {
  if (!configuredChatId || incomingChatId === undefined) return false;
  return String(incomingChatId) === configuredChatId;
}

export function isValidWalletAddress(address: string): boolean {
  return SOLANA_ADDRESS_RE.test(address);
}

/**
 * Notifications/control only - never in the execution critical path.
 * Commands read repositories and flip runtime flags; they never call
 * execution or position management directly. If TELEGRAM_BOT_TOKEN is
 * unset, `start()` simply does not start anything and every other package
 * keeps working.
 */
export class TelegramBot {
  private bot: Bot | undefined;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: TelegramBotDeps) {}

  async start(): Promise<void> {
    if (!this.deps.token) {
      this.deps.logger.info({}, "TELEGRAM_BOT_TOKEN not set - telegram-bot disabled");
      return;
    }

    this.bot = new Bot(this.deps.token);
    if (!this.deps.chatId) {
      this.deps.logger.warn({}, "TELEGRAM_CHAT_ID not set - telegram commands are disabled (no chat is authorized)");
    }
    // Without a handler grammY stops polling and rethrows on the first
    // error thrown by a command (e.g. a repository failure).
    this.bot.catch((err) => {
      this.deps.logger.error({ err: err.error instanceof Error ? err.error.message : String(err.error) }, "telegram command failed");
    });
    this.bot.use(async (ctx, next) => {
      if (!isAuthorizedChat(this.deps.chatId, ctx.chat?.id)) {
        this.deps.logger.warn({ chatId: ctx.chat?.id, from: ctx.from?.id }, "ignoring telegram update from unauthorized chat");
        return;
      }
      await next();
    });
    this.registerCommands(this.bot);
    this.registerNotifications();

    // Long-polling - intentionally not awaited by the caller.
    // An invalid token or a network failure rejects this promise; leaving
    // it unhandled would terminate the whole process, trading included.
    this.bot
      .start({ onStart: () => this.deps.logger.info({}, "telegram bot started") })
      .catch((err: unknown) => {
        this.deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "telegram bot stopped polling");
      });
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    await this.bot?.stop();
  }

  private registerCommands(bot: Bot): void {
    bot.command("status", async (ctx) => {
      const flags = this.deps.runtimeFlags;
      const open = await this.deps.positionRepo.getOpenPositions();
      await ctx.reply(
        `Status: ${flags.killed ? "KILLED" : flags.paused ? "PAUSED" : "RUNNING"}\nOpen positions: ${open.length}`,
      );
    });

    bot.command("positions", async (ctx) => {
      const open = await this.deps.positionRepo.getOpenPositions();
      if (open.length === 0) {
        await ctx.reply("No open positions.");
        return;
      }
      const lines = open.map(
        (p) => `${p.tokenMint.slice(0, 8)}... entry $${p.entryPriceUsd.toFixed(6)} unrealized $${p.unrealizedPnlUsd.toFixed(2)}`,
      );
      await ctx.reply(lines.join("\n"));
    });

    bot.command("pnl", async (ctx) => {
      const all = await this.deps.positionRepo.allPositions();
      const realized = all.reduce((s, p) => s + p.realizedPnlUsd, 0);
      const closed = all.filter((p) => p.status === "CLOSED").length;
      await ctx.reply(`Realized PnL: $${realized.toFixed(2)} across ${closed} closed positions`);
    });

    bot.command("signals", async (ctx) => {
      const recent = await this.deps.signalRepo.recentSignals(5);
      if (recent.length === 0) {
        await ctx.reply("No recent signals.");
        return;
      }
      await ctx.reply(recent.map((s) => `${s.tokenMint.slice(0, 8)}... score ${s.score.toFixed(1)}`).join("\n"));
    });

    bot.command("pause", async (ctx) => {
      this.deps.runtimeFlags.pause();
      await ctx.reply("Trading paused.");
    });

    bot.command("resume", async (ctx) => {
      this.deps.runtimeFlags.resume();
      await ctx.reply("Trading resumed.");
    });

    bot.command("kill", async (ctx) => {
      this.deps.runtimeFlags.kill();
      await ctx.reply("Kill switch engaged. Trading halted for this session.");
    });

    bot.command("candidates", async (ctx) => {
      const pending = await this.deps.watchlistRepo.listByStatus("pending");
      if (pending.length === 0) {
        await ctx.reply("No pending whale candidates.");
        return;
      }
      const lines = pending.map((e) => `${e.address}${e.notes ? ` - ${e.notes}` : ""}`);
      await ctx.reply(`Pending whale candidates:\n${lines.join("\n")}`);
    });

    bot.command("approve", async (ctx) => {
      const address = String(ctx.match ?? "").trim();
      if (!address) {
        await ctx.reply("Usage: /approve <address>");
        return;
      }
      if (!isValidWalletAddress(address)) {
        await ctx.reply(`Not a valid Solana address: ${address}`);
        return;
      }
      await this.deps.watchlistRepo.updateStatus(address, "active", "approved via telegram /approve");
      this.deps.watchlistIndex?.upsert({ address, status: "active", source: "auto-discovered" });
      await ctx.reply(`Approved ${address} - now active on the watchlist.`);
    });

    bot.command("reject", async (ctx) => {
      const address = String(ctx.match ?? "").trim();
      if (!address) {
        await ctx.reply("Usage: /reject <address>");
        return;
      }
      if (!isValidWalletAddress(address)) {
        await ctx.reply(`Not a valid Solana address: ${address}`);
        return;
      }
      await this.deps.watchlistRepo.updateStatus(address, "rejected", "rejected via telegram /reject");
      this.deps.watchlistIndex?.upsert({ address, status: "rejected", source: "auto-discovered" });
      await ctx.reply(`Rejected ${address}.`);
    });
  }

  /** Sends an arbitrary message to the configured chat (used by
   * monitoring's AlertManager for threshold alerts). A no-op whenever the
   * bot isn't running or no chat is configured - callers don't need to
   * check either condition themselves. */
  async notify(text: string): Promise<void> {
    if (!this.deps.chatId || !this.bot) return;
    try {
      await this.bot.api.sendMessage(this.deps.chatId, text);
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "failed to send telegram notification");
    }
  }

  private registerNotifications(): void {
    const send = (text: string) => this.notify(text);

    this.unsubscribers.push(
      this.deps.bus.on("whale.detected", async ({ wallet, tokenMint, usdValue, whaleScore }) => {
        await send(formatWhaleDetected(wallet, tokenMint, usdValue, whaleScore));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("position.closed", async ({ positionId }) => {
        const position = await this.deps.positionRepo.getPosition(positionId);
        if (position) await send(formatExit(position));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("position.opened", async ({ positionId }) => {
        const position = await this.deps.positionRepo.getPosition(positionId);
        if (!position) return;
        const signal = await this.deps.signalRepo.getSignal(position.signalId);
        if (signal) await send(formatEntry(position, signal));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("whale.exit-detected", async ({ wallet, tokenMint, pctSold }) => {
        await send(formatWhaleExit(wallet, tokenMint, pctSold));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("signal.rejected", async ({ tokenMint, reason }) => {
        await send(formatSignalRejected(tokenMint, reason));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("wallet.discovery-candidate", async ({ wallet, whaleScore }) => {
        await send(formatWhaleCandidateDiscovered(wallet, whaleScore));
      }),
    );
    this.unsubscribers.push(
      this.deps.bus.on("wallet.discovery-promoted", async ({ wallet, whaleScore }) => {
        await send(formatWhaleAutoPromoted(wallet, whaleScore));
      }),
    );
  }
}
