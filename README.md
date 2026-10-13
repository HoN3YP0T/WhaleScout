# Whalescout

A Solana memecoin "whale-entry sniper" trading engine scaffold: detects
high-quality whale buys, scores the whale and the token, filters out
manipulation, combines everything into a deterministic composite signal, and
manages a position end-to-end (paper trading first, live execution gated).

The whole pipeline runs today against a deterministic **mock feed** with no
real Solana RPC/Geyser credentials, no Telegram bot token, and no live
wallet required. Paper trading is the primary, fully-tested path. Live
execution is structurally complete but explicitly gated off.

## Quick start

```bash
npm install
npm run test          # unit + integration tests, no external services needed
npm run start         # boots the mock feed and runs the full pipeline in-process
npm run backtest       # replays the mock scenarios through the same pipeline and prints a report
```

Optional, if you have Docker available:

```bash
docker compose up -d
npx prisma migrate dev --name init --schema packages/db/prisma/schema.prisma
npm run seed:watchlist
```

If Postgres/Prisma isn't reachable (no Docker, no `DATABASE_URL`), every
repository call falls back to an in-memory implementation automatically -
`npm run test`, `npm run start`, and `npm run backtest` all work either way.

## Architecture

npm workspaces monorepo, TypeScript on Node 22, `tsx` for running/testing
(no separate build step). Each package under `packages/*` is a real
workspace package (`@whale-sniper/<name>`) with its own `package.json`.

```
packages/
  core            shared types, zod-validated config/env, typed event bus,
                   logger, real/simulated Clock, latency helpers
  db              Prisma schema + repositories (in-memory and Prisma-backed)
  feed            IFeedProvider, MockFeedProvider + scenario generators,
                   real HeliusFeedProvider (pump.fun, opt-in), tx decoder,
                   FeedManager
  wallet-intel    watchlist loader + state machine (WatchlistIndex),
                   walletStatsUpdater, walletScoring.ts
  token-intel     token stats/metadata collector (mock, or real
                   DexScreener / DexScreener+Solana-RPC composite / Solscan
                   adapters, opt-in), tokenRiskScoring.ts,
                   CreatorRegistryUpdater
  cluster-detect  wallet relationship graph, union-find clustering, flags,
                   WalletRelationshipSource (mock, or real Solana-RPC
                   funder/deployer derivation, opt-in)
  signal-engine   composite signal score, entryGate.ts
  paper-trading   fill simulator, paper trade engine
  execution       IExecutionAdapter, paper + live adapters, risk engine,
                   execution pipeline
  position-mgmt   TP ladder / trailing stop / max-hold state machine
  whale-exit      post-entry whale monitoring, tiered response
  whale-discovery WhaleDiscoveryEngine - auto-promotes/pends
                   never-before-seen wallets onto the watchlist (opt-in)
  telegram-bot    grammy bot: notifications + control commands, plus
                   /candidates /approve /reject for whale-discovery
  monitoring      in-memory metrics, alerting, /health + /metrics
  orchestrator    the single canonical pipeline wiring, shared by the live
                   app and the backtest replay engine
  backtest        replay engine, parameter sweep, report builder

apps/
  sniper-runner   composition root (main.ts + wiring.ts)

scripts/          seed-watchlist.ts, run-backtest.ts
config/           strategy.json (all thresholds/weights), watchlist.json
tests/
  unit/           one file per package's core logic
  integration/    pipeline.e2e.test.ts, backtest.test.ts
```

## Phase -> package map

| Phase | What | Package(s) |
|---|---|---|
| 1 | Core types, config, event bus, feed interface + mock provider | `core`, `feed` |
| 2 | Persistence + wallet stats tracking | `db`, `wallet-intel` |
| 3 | Whale Score formula | `wallet-intel` (`walletScoring.ts`) |
| 4 | Token stats + risk scoring | `token-intel` |
| 5 | Cluster/manipulation detection | `cluster-detect` |
| 6 | Composite signal + entry gate | `signal-engine` |
| 7 | Paper trading | `paper-trading` |
| 8 | Backtesting | `backtest` |
| 9 | Execution (paper-first) | `execution` |
| 10 | Position management | `position-mgmt` |
| 11 | Risk engine + whale-exit monitoring, gated live adapter | `execution`, `whale-exit` |
| 12 | Telegram notifications/control | `telegram-bot` |
| 13 | Monitoring | `monitoring` |
| 14 | Composition root + end-to-end proof | `orchestrator`, `apps/sniper-runner`, `tests/integration` |

## Data flow

Every `NormalizedTradeEvent` carries a `timestamps` object stamped through
each pipeline stage it passes: `rawReceivedAt -> decodedAt -> walletMatchedAt
-> tokenLookupAt -> clusterCheckAt -> scoredAt -> signalAt -> riskCheckedAt ->
orderBuiltAt -> filledAt -> confirmedAt -> notifiedAt`. Stages 0-2 are the
allocation-light hot path; everything from `tokenLookupAt` onward only runs
for whale BUYs from watchlisted wallets. `core/latency.ts` turns these into
per-stage latencies that `monitoring` aggregates.

## Scoring

- **Whale Score** (0-100): `0.25*Consistency + 0.20*Timing +
  0.15*Selectivity + 0.20*ExitQuality + 0.10*RugAvoidance +
  0.10*RecentPerformance`. Consistency uses a Bayesian-shrunk win rate
  (prior 3/6) scaled by a trade-count confidence factor, so a wallet with 8
  trades at 75% doesn't outscore one with 200 trades at 64%.
- **Token Risk Score** (0-100, higher = riskier): weighted age /
  liquidity / concentration / authority / buyer-diversity / flow / creator
  risk. `creatorRisk` ships at weight 0 (see "Creator reputation" below) -
  computed and visible on every score, contributing nothing until an
  operator deliberately rebalances the weights.
- **Cluster/manipulation**: a weighted-edge wallet relationship graph
  (common funder, direct transfer, repeated co-buy, timing correlation,
  shared creator) merged via union-find, producing five manipulation flags
  and a capped penalty fed into the signal score. The common-funder and
  shared-creator edges need on-chain funding/deployer history, which only
  `WALLET_RELATIONSHIP_SOURCE=solana-rpc` supplies - see "On-chain wallet
  relationships" under "Real integrations".
- **Composite Signal Score** (0-100): `0.30*whaleQuality + 0.20*tokenQuality
  + 0.15*liquidity + 0.10*buyingMomentum + 0.10*independentBuyers +
  0.10*earlyEntryQuality - 0.05*manipulationPenalty`.
- **Entry Gate**: a hard AND across every independent safeguard (qualified
  whale, token risk bound, liquidity floor, no active manipulation flag,
  buyer/momentum floors, slippage bound, signal score floor, risk engine
  veto) - "never trade on a single whale buy blindly".

All thresholds and weights live in `config/strategy.json`, zod-validated at
boot, and are what `backtest`'s parameter sweep recalibrates.

`tokenThresholds.allowedDexes` gates which venue the triggering trade
happened on - it includes both `"pumpfun"` and `"raydium"` by default,
since the same token trades on pump.fun's own bonding curve pre-migration
and on Raydium once it clears pump.fun's ~$69k migration market cap; both
are legitimate places to catch a whale entry over a token's lifecycle.
`minLiquidityUsd` (4000) and `minAgeSeconds` (30) are tuned for pump.fun's
actual launch profile - fresh launches routinely start with low-thousands
liquidity and are tradeable within seconds, so the higher defaults this
scaffold shipped with originally would reject almost everything on that
venue. `maxAgeSeconds` (21600, 6h) is a new upper bound: a whale *entry*
sniper should be catching fresh discovery, not opening a position hours
into an already-mature pump.

## Real integrations

All five of these are fully implemented, not stubs, and all five are off
by default - nothing about the mock-feed/mock-token-stats path above
changes unless you explicitly opt in. If you want real token data, the
recommended option is `dexscreener+rpc` (below); `dexscreener` alone is
documented mainly because it is what `dexscreener+rpc` is built out of.

**DexScreener token data** (`TOKEN_DATA_PROVIDER=dexscreener` in `.env`) -
`DexScreenerTokenMetadataProvider` (`packages/token-intel`) calls
DexScreener's free, no-API-key public API for a token's liquidity and
market cap, short-TTL cached per mint so the hot trade path never blocks
on network I/O. DexScreener has no holder count, concentration, or
mint/freeze authority data, so those fields fall back to conservative
"treat as risky" defaults (authorities read as *not revoked*) rather than
a guess - see the comment on `conservativeUnknownSeed` in
`tokenMetadataProvider.ts` (shared by DexScreener's, the
composite's and Solscan's adapters, so the fallback never drifts between
them). No env var is required beyond the flag itself; DexScreener needs no
key. Those conservative fallbacks are what impose the 35-point risk floor
described under `dexscreener+rpc` below, which is why that option, not
this one, is the recommended way to run on real data.

**DexScreener + Solana RPC token data, recommended**
(`TOKEN_DATA_PROVIDER=dexscreener+rpc` in `.env`, plus `HELIUS_API_KEY` -
the same key the live feed uses, no second credential and no paid API) -
`CompositeTokenMetadataProvider`
(`packages/token-intel/src/solanaRpcTokenMetadataProvider.ts`) merges two
sources field-by-field, because neither one alone can answer all six
fields `TokenStats` needs:

| field | source |
|---|---|
| `liquidityUsd`, `marketCapUsd` | DexScreener (the existing `DexScreenerTokenMetadataProvider`, reused wholesale) |
| `holderCount`, `top10HolderPct` | Solana RPC `getTokenLargestAccounts` + `getTokenSupply` |
| `mintAuthorityRevoked`, `freezeAuthorityRevoked` | Solana RPC `getParsedAccountInfo` on the mint (`mintAuthority`/`freezeAuthority` null = revoked) |
| `creatorAddress`, `creatorTokenLaunchCount` | left `undefined` - standard RPC can't cheaply attribute a deployer, and `creatorRiskComponent` treats unknown creator data as *neutral* by design |

*The 35-point risk floor this exists to remove.* DexScreener is the only
free real provider, and it has no holder, concentration or authority data
at all, so `conservativeUnknownSeed()` has to assume worst case:
`top10HolderPct: 1` and both authorities *not revoked*. That maxes out
`concentrationRisk` (weight .20) **and** `authorityRisk` (weight .15), a
flat 35-point floor on every single token's risk score before age,
liquidity, buyer diversity or flow contribute anything. The entry gate
rejects anything above `maxTokenRiskScore: 55`, so realistic pump.fun
tokens are rejected on missing data rather than on their actual risk:

| token profile | DexScreener only | with real holder/authority data |
|---|---|---|
| 1h old, $10k liquidity, 15 buyers | 82.0 rejected | 53.0 passes |
| 6h old, $50k liquidity, 30 buyers | 66.3 rejected | 37.3 passes |
| 6h old, $99k liquidity, 50 buyers | 56.5 rejected | 27.5 passes |

(Both columns are the same token, same weights; the only difference is
whether the four RPC-sourced fields are measured or assumed. "Real data"
here means authorities renounced and the top 10 holders at 30%, which is
unremarkable for a surviving launch. The floor and these before/after
numbers are pinned as tests in `tests/unit/tokenRiskScoring.test.ts` so a
future weight change can't silently reintroduce the problem.) Paying for
Solscan would also fix this, but its one unique contribution - creator
history - feeds `creatorRisk`, which ships at weight 0, so today it buys
nothing this doesn't.

*Why composite and not an RPC-only provider.* Solana RPC has no concept of
pool pricing, so an RPC-only provider would report `liquidityUsd: 0` -
which maxes out `liquidityRiskComponent` (weight .20) *and* fails
`tokenThresholds.minLiquidityUsd` (4000) in `entryGate.ts` outright. That
would trade the 35-point floor for a hard rejection, which is worse.

The two sources degrade strictly independently, because they are two
separate caches: if RPC is down, DexScreener's liquidity/market cap is
still served and only the four RPC-sourced fields fall back to
`conservativeUnknownSeed()`; if DexScreener is down, real holder and
authority data is still served. Like the other adapters, `get()` is
synchronous and never blocks on I/O - it returns cached-or-conservative
immediately and schedules a background refresh. One refresh costs 3 RPC
calls, so on top of the 20s per-mint TTL and the in-flight de-dupe there
is a global throttle: a 250ms minimum gap between refresh *starts* (a 4
refresh/s, 12 call/s steady-state ceiling no matter how many mints the
feed throws at it), at most 4 concurrent refreshes, and a 5s per-mint
cooldown so a mint whose refresh keeps failing isn't retried on every
`get()`. Dropping a refresh is always safe - it delays better data, it
never blocks a trade decision. **Honesty note**: this build cannot reach
Helius (the sandbox blocks it outright), so every behaviour above is
verified against injected `SolanaRpcLike` fakes only, never a live
response - see the HONESTY NOTE at the top of
`solanaRpcTokenMetadataProvider.ts` for what specifically to re-check with
a real key.

**Solscan token data** (`TOKEN_DATA_PROVIDER=solscan` in `.env`, plus
`SOLSCAN_API_KEY`) - `SolscanTokenMetadataProvider` (`packages/token-intel`)
calls Solscan's paid Pro API v2.0 (`token/meta`, `token/holders`, and an
account-activity lookup) and, unlike DexScreener, can supply holder count,
top-10 concentration, and mint/freeze authority state directly, plus two
fields DexScreener has no concept of at all: `creatorAddress` (who deployed
the token) and `creatorTokenLaunchCount` (a serial-deployer signal). If
`TOKEN_DATA_PROVIDER=solscan` is set and `SOLSCAN_API_KEY` is empty, the app
refuses to start (`wiring.ts`'s `buildTokenMetadataProvider()`), mirroring
Helius's fail-fast contract below. **Honesty note**: this build has no live
Solscan key to test against, so the exact endpoint paths and response field
names in `solscanTokenMetadataProvider.ts` are best-effort, written against
Solscan's documented v2.0 shape - see the HONESTY NOTE at the top of that
file before relying on it in production. Unlike the other four metadata
fields, an unknown `creatorTokenLaunchCount` (Solscan outage, or a provider
that doesn't support it) deliberately defaults to *neutral* (0 risk
contribution), not risky - a brand-new first-time creator is normal, and
missing data shouldn't punish every token equally.

**On-chain wallet relationships / manipulation detection**
(`WALLET_RELATIONSHIP_SOURCE=solana-rpc` in `.env`, plus `HELIUS_API_KEY` -
the same key again, no second credential and no paid API) -
`SolanaRpcWalletRelationshipSource`
(`packages/cluster-detect/src/solanaRpcWalletRelationshipSource.ts`).

*What this fixes.* `ClusterDetector` combines four edge detectors, and
until this existed **two of the four were dead code in production - the two
highest-weighted ones**. `timingCorrelationEdges` and `repeatedCoBuyEdges`
are derived from the trade stream and always worked; `commonFunderEdges`
(weight 0.9) and `sharedCreatorEdges` (weight 1.0) came from
`MockWalletRelationshipSource`, whose `setFunder()`/`setCreator()` are only
ever called by scenario setup - never by wiring - so both returned `[]` on
every call. Against `clusterThresholds.edgeMergeThreshold` of 0.5 those two
are the decisive signals: either one alone forces a merge, where timing and
co-buy weights may or may not clear the bar. Two consequences followed:
the `creatorAssociatedWallets` cluster flag could never fire, and
`whale-discovery`'s `WhaleDiscoveryEngine` - which uses that exact flag to
auto-reject wash-trading candidates before promoting a wallet onto the
watchlist - had an inert safety check. The bot could see "these wallets buy
the same things at the same time" but was blind to "these wallets are the
same person".

| relationship | how it is derived |
|---|---|
| a wallet's original funder | paginate `getSignaturesForAddress(wallet)` back to the earliest signature, fetch that transaction, and take the account with the largest lamport decrease (the wallet's own balance having increased). Two wallets sharing one -> `common-funder` edge, weight 0.9 |
| a token's deployer | paginate `getSignaturesForAddress(mint)` back to the mint's creation transaction and take its fee payer / first signer (`accountKeys[0]`) |
| creator-associated wallets | a wallet that *is* the deployer, or whose funder is the deployer - reusing the same funder cache, so it costs no extra calls. Feeds `shared-creator` edges (weight 1.0) and the `creatorAssociatedWallets` flag |

*Cached permanently, with no TTL.* This is the one large efficiency win it
has over `dexscreener+rpc`'s 20s TTL: a wallet's original funder and a
token's deployer are **immutable** - properties of a transaction that
already happened, which no later activity can supersede. Holder
concentration changes minute to minute; "who first sent this address SOL"
does not. So one successful lookup per address is the entire process
lifetime cost. Only *failed* lookups are retried, under the shared refresh
governor's per-key cooldown.

*RPC cost and the pagination cap.* `getSignaturesForAddress` only walks
backwards, so reaching an address's earliest signature costs one call per
1000 signatures of its whole lifetime - unbounded for an old, busy wallet.
Pagination is therefore capped at 4 pages, so one lookup is 2 RPC calls in
the common case (one short page + one `getParsedTransaction`) and at most 5.
Past the cap the result is recorded as **unknown**, never guessed from the
oldest signature seen so far - that signature is some mid-life trade, and
the "funder" read off it would be a trading counterparty, i.e. a fabricated
relationship merging two unrelated wallets at weight 0.9. The same
`RpcRefreshGovernor` (lifted to `packages/core` and re-exported from
`token-intel`, not copied) governs this and `dexscreener+rpc` together, and
`wiring.ts` passes **one instance** to both, so the operator's single Helius
rate limit is spent once rather than twice.

*Fail-closed on unknown.* Reads are synchronous and never block: they answer
from cache and schedule a throttled background lookup on a miss, so the
first trades from an unseen wallet arrive while its relationships are still
"unknown" rather than "absent". The two cases are treated differently on
purpose. For cluster edges, unknown means no edge - the same as today, and
acceptable, since it only risks missing a cluster while the timing/co-buy
detectors still apply. For `WhaleDiscoveryEngine` auto-promotion it must
not: promoting a wallet because "no manipulation was found" when nothing had
been looked up yet is exactly the wash-trade trap the check exists to
prevent. So the engine now consults `relationshipDataKnown()` and **defers**
- the candidate stays unstatused (and therefore untradeable) and is
re-evaluated on its next trade, by which time the lookups that call
scheduled have usually landed. `MockWalletRelationshipSource` answers
`relationshipDataKnown()` with `true`, because it *is* ground truth for the
fixtures registered into it, which keeps the default path byte-identical.

**Honesty note**: this build cannot reach Helius (the sandbox blocks it
outright), so all of the above is verified against injected
`SolanaHistoryRpcLike` fakes only. The risky assumptions are about the
*shape* of real responses - that `accountKeys[0]` is the fee payer, and that
lamport deltas (`meta.preBalances`/`postBalances`, used deliberately in
place of matching `jsonParsed` instruction shapes) identify the funder - see
the HONESTY NOTE at the top of `solanaRpcWalletRelationshipSource.ts` for
what specifically to re-check with a real key.

**Helius live feed** (`FEED_PROVIDER=helius` in `.env`, plus
`HELIUS_API_KEY`) - `HeliusFeedProvider` (`packages/feed`) subscribes to
real pump.fun buy/sell activity over Helius's RPC/WS using
`Connection.onLogs` against pump.fun's bonding-curve program, and decodes
the on-chain `TradeEvent` logs into the same `NormalizedTradeEvent` shape
the mock feed produces. If `FEED_PROVIDER=helius` is set and
`HELIUS_API_KEY` is empty, the app refuses to start (`wiring.ts`'s
`buildFeedProvider()`) rather than silently falling back to the mock feed.
Get a key at https://helius.dev, or set `SOLANA_RPC_URL` to any Solana RPC
endpoint instead (the public `https://api.mainnet-beta.solana.com` carries
the full pump.fun log stream).

Verified against live mainnet traffic: the decoder matches pump.fun's
`TradeEvent` by its Anchor discriminator and reads the original field
prefix of today's longer (382-431 byte) events; decoded token amounts,
trader and block time match the on-chain transactions exactly. Each
trade's bonding-curve real SOL reserves become `poolLiquidityUsd`, which
`TokenStatsCollector` prefers over the metadata provider's liquidity -
DexScreener reports none for bonding-curve pairs. SOL/USD comes from
DexScreener's deepest SOL/USDC pool, refreshed every minute
(`LiveSolUsdPrice`), falling back to $150 only until the first quote lands.

**Live smoke test** - `npm run smoke:live` (or `npx tsx scripts/live-smoke.ts
--minutes 10`) runs the full pipeline on the live pump.fun feed with paper
execution and prints a report: feed throughput and ingest lag, discovered
wallets, signals and top rejection reasons, paper positions and exits. It
enables auto-discovery and relaxes the wallet/entry gates so every stage
fires within minutes, so it tests the plumbing, not the strategy.

## Creator reputation

Two existing gaps turned out to correlate rather than needing two separate
bolt-ons: token risk scoring couldn't see who deployed a token, and the
bot's own rug detection never fed back into anything. Concretely, the loop
is:

1. `SolscanTokenMetadataProvider` puts a real `creatorAddress` +
   `creatorTokenLaunchCount` onto `TokenStats`, when it can resolve one.
2. The existing, **unmodified** rug detector - `TokenStatsCollector`'s
   liquidity-crash logic flagging `RuggedTokenRegistry` - keeps working
   exactly as it always has. A new `CreatorRegistryUpdater`
   (`packages/token-intel`) just listens to the already-emitted
   `token.stats-updated` event and, when a token it knows the creator of
   gets flagged rugged, increments that creator's `tokensRugged` count in a
   new persistent `CreatorRegistry` (`packages/core`).
3. `creatorRiskComponent()` in `tokenRiskScoring.ts` blends that
   self-learned rug rate (confidence-shrunk the same way `walletScoring.ts`
   shrinks small-sample wallet data) with Solscan's serial-deployer
   launch-count signal into `TokenRiskScore.creatorRisk` - computed and
   visible from day one, but contributing nothing to the score while
   `tokenRiskWeights.creatorRisk` stays at its shipped default of `0`.
   Recommended rebalanced split when turning it on: `age .20, liquidity
   .18, concentration .18, authority .12, buyerDiversity .08, flow .08,
   creatorRisk .16` (sums to 1.00).
4. `TokenRiskScore` already gates every entry (`signal-engine/entryGate.ts`)
   for every whale buy that reaches it, watchlisted or auto-discovered
   alike, since it's the same function call either way.
5. Which tokens whales win or get rugged on already feeds
   `WalletStats.rugExposureCount` (unchanged) -> `rugAvoidanceScore()` ->
   10% of Whale Score - so creator reputation, wallet reputation, and token
   risk all stay connected through data the bot already collects.

`CreatorRegistry` is hydrated from `repos.creatorReputation` at boot
(`wiring.ts`) so reputation survives restarts.

## Whale auto-discovery

Whale-finding was 100% manual: `SniperOrchestrator` only ever scored/traded
wallets already in the static `config/watchlist.json`. `WhaleDiscoveryEngine`
(`packages/whale-discovery`) closes that gap - off by default
(`config/strategy.json`'s `walletDiscovery.enabled: false`).

The watchlist is now a small state machine (`WatchlistEntry.status`:
`"pending" | "active" | "rejected"`, `.source`: `"manual" |
"auto-discovered"`) - existing entries default to `{status: "active",
source: "manual"}` via `normalizeWatchlistEntry()`, so `config/watchlist.json`
and every existing test/fixture behave exactly as before. Only `"active"`
entries are tradeable (`WatchlistIndex.isWatched()`).

When enabled, `WhaleDiscoveryEngine` watches every wallet's trade activity
(not just watchlisted ones) for a never-before-seen wallet. It reuses
`scoreWallet()`/`evaluateHardGate()` from `walletScoring.ts`
**byte-for-byte unchanged** - a wallet only gets auto-promoted if it clears
the identical bar a manually curated wallet has to clear, no second, laxer
rulebook. A candidate that clears the gate is then checked against
`ClusterDetector`'s manipulation flags for the triggering token; a wallet in
a cluster flagged `creatorAssociatedWallets` or `coordinatedBuying` is
auto-rejected regardless of score. A candidate that clears both checks goes
to:

- `"active"` immediately (and a `wallet.discovery-promoted` event fires) if
  `walletDiscovery.autoPromote: true`, or
- `"pending"` (and a `wallet.discovery-candidate` event fires) otherwise,
  awaiting operator review.

Telegram (only relevant when `TELEGRAM_BOT_TOKEN` is set - see "Telegram"
below) gets three new commands: `/candidates` lists everything pending,
`/approve <address>` and `/reject <address>` move a candidate to
`"active"`/`"rejected"`, updating both the persisted watchlist and the live
in-process index immediately.

To try it: set `walletDiscovery.enabled: true` (and optionally
`autoPromote: true`) in `config/strategy.json` and run `npm run start` - do
not commit that change, the shipped default is off.

## Live trading

`LIVE_TRADING_ENABLED=false` by default in `.env.example`. The execution
pipeline only ever selects `PaperExecutionAdapter` unless
`LIVE_TRADING_ENABLED=true` **and** a distinct `HOT_WALLET_KEYPAIR_PATH`
**and** a positive `HOT_WALLET_MAX_BALANCE_USD` are all configured -
`selectExecutionAdapterKind()` in `packages/execution` is the single choke
point for that decision. Even when constructible, `LiveExecutionAdapter`'s
`submitOrder` always throws "not implemented" in this build: signing and
on-chain submission require a real wallet/RPC integration that is
intentionally out of scope here.

To eventually enable live trading you would need: a real feed provider (see
"Real integrations" above - `HeliusFeedProvider` is a complete
implementation now, just gated behind `FEED_PROVIDER=helius` +
`HELIUS_API_KEY`), a funded, dedicated hot wallet kept separate from any
other wallet, and a completed `LiveExecutionAdapter.submitOrder`
implementation - then set `LIVE_TRADING_ENABLED=true`,
`HOT_WALLET_KEYPAIR_PATH`, and `HOT_WALLET_MAX_BALANCE_USD` in `.env`.

## Dashboard

`npm run start` also serves a read-only operator dashboard on the same port
as `/health`/`/metrics` (`http://localhost:3001/` by default, or `/dashboard`
- see `HEALTH_PORT` in `.env`). It's a plain HTML/CSS/vanilla-JS page
(`packages/dashboard/src/public`) that polls its own JSON API every 5
seconds - no build step, no framework, matching the rest of this repo.

What's on it: overview stat tiles (realized PnL, win rate, expectancy,
profit factor, drawdown, open positions, signal counts, watchlist counts),
an open-positions table, a trade history table, feed/pipeline health
(latency percentiles, order counts), a watchlisted-whales table with a
click-through detail panel (Whale Score breakdown + that wallet's trades),
whale-discovery candidates awaiting review, and a live signal feed (both
passed and rejected signals).

It's explicitly **read-only** in this version - there's no approve/reject or
any other action from the dashboard; that stays in Telegram's existing
`/approve`, `/reject`, `/candidates` commands. The API it's built on
(`packages/dashboard`) reuses `buildReport()` from `@whale-sniper/backtest`
for win-rate/expectancy/profit-factor/drawdown math rather than
re-implementing it, and adds a small in-process ring buffer
(`RecentEventLog`) for the signal feed, since rejected signals were never
persisted anywhere before (only counted).

## Telegram

`telegram-bot` only starts if `TELEGRAM_BOT_TOKEN` is set; otherwise it's a
no-op and everything else keeps working. Commands (`/status /positions /pnl
/signals /pause /resume /kill /candidates /approve /reject`) only read
repositories and flip runtime flags (or, for `/approve` and `/reject`,
update watchlist status) - they never call execution or position management
directly. `/candidates`, `/approve`, and `/reject` are whale-discovery's
review workflow - see "Whale auto-discovery" above.

Commands are only accepted from the chat set in `TELEGRAM_CHAT_ID`; updates
from any other chat are ignored and logged. With `TELEGRAM_CHAT_ID` unset,
no chat is authorized and commands are disabled - anyone can message a bot
whose username they know, and `/approve` makes a wallet tradeable.
