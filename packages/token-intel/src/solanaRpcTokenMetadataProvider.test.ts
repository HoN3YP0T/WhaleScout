import { describe, expect, it, vi } from "vitest";
import {
  CompositeTokenMetadataProvider,
  pumpFunBondingCurveTokenAccounts,
  top10ConcentrationFrom,
  type ParsedMintAccountInfo,
  type SolanaRpcLike,
  type TokenAccountBalanceLike,
  type TokenAmountLike,
} from "./solanaRpcTokenMetadataProvider.js";
import { conservativeUnknownSeed, type ITokenMetadataProvider, type TokenMetadataSeed } from "./tokenMetadataProvider.js";

const MINT = "SomeTokenMint1111111111111111111111111111";

interface FakeRpcOptions {
  mintAccount?: ParsedMintAccountInfo | undefined;
  largest?: TokenAccountBalanceLike[];
  supply?: TokenAmountLike | undefined;
  fail?: () => boolean;
}

function fakeRpc(options: FakeRpcOptions = {}): SolanaRpcLike & { calls: () => number } {
  let calls = 0;
  const guard = () => {
    calls += 1;
    if (options.fail?.()) throw new Error("rpc down");
  };
  return {
    calls: () => calls,
    getParsedMintAccount: vi.fn(async () => {
      guard();
      return "mintAccount" in options ? options.mintAccount : { mintAuthority: null, freezeAuthority: null };
    }),
    getTokenLargestAccounts: vi.fn(async () => {
      guard();
      return options.largest ?? [{ amount: "100" }, { amount: "100" }];
    }),
    getTokenSupply: vi.fn(async () => {
      guard();
      return "supply" in options ? options.supply : { amount: "1000" };
    }),
  };
}

/** Stand-in for `DexScreenerTokenMetadataProvider` - the composite provider
 * only ever calls `get()` on it, so a fake that answers with the real
 * provider's own semantics (conservative fallback for everything it cannot
 * supply) is enough to prove the merge. */
function fakeDexScreener(seed: Partial<TokenMetadataSeed> | "fails"): ITokenMetadataProvider {
  return {
    get: vi.fn(() => (seed === "fails" ? conservativeUnknownSeed() : { ...conservativeUnknownSeed(), ...seed })),
  };
}

function build(
  rpc: SolanaRpcLike,
  dexScreener: ITokenMetadataProvider,
  now: () => number,
  cacheTtlMs = 20_000,
): CompositeTokenMetadataProvider {
  return new CompositeTokenMetadataProvider({
    apiKey: "test-key",
    rpcFactory: () => rpc,
    dexScreener,
    cacheTtlMs,
    // Throttle off by default so each test exercises exactly the behaviour
    // it is about; the throttle gets its own tests below.
    refreshBudget: { minIntervalMs: 0, maxConcurrent: 100, perMintRetryCooldownMs: 0 },
    now,
  });
}

describe("CompositeTokenMetadataProvider", () => {
  it("throws on an empty apiKey rather than proceeding unauthenticated", () => {
    expect(() => new CompositeTokenMetadataProvider({ apiKey: "" })).toThrow(/non-empty apiKey/);
  });

  it("returns the conservative fallback on a cold cache without blocking", () => {
    const provider = build(fakeRpc(), fakeDexScreener({ liquidityUsd: 8000, marketCapUsd: 45000 }), () => 0);

    const seed = provider.get(MINT);
    // DexScreener's half is synchronous-cached in the real provider too, so
    // the only guarantee on a cold cache is that the RPC-sourced fields are
    // conservative and nothing threw or awaited.
    expect(seed.top10HolderPct).toBe(1);
    expect(seed.mintAuthorityRevoked).toBe(false);
    expect(seed.freezeAuthorityRevoked).toBe(false);
    expect(seed.holderCount).toBe(0);
  });

  it("merges liquidity/market cap from DexScreener with holders/authorities from RPC", async () => {
    const rpc = fakeRpc({
      mintAccount: { mintAuthority: null, freezeAuthority: null },
      largest: [{ amount: "300" }, { amount: "200" }],
      supply: { amount: "2000" },
    });
    const provider = build(rpc, fakeDexScreener({ liquidityUsd: 12345, marketCapUsd: 67890 }), () => 0);

    await provider.prefetch(MINT);
    const seed = provider.get(MINT);

    expect(seed.liquidityUsd).toBe(12345);
    expect(seed.marketCapUsd).toBe(67890);
    expect(seed.top10HolderPct).toBeCloseTo(0.25, 6);
    expect(seed.holderCount).toBe(2);
    expect(seed.mintAuthorityRevoked).toBe(true);
    expect(seed.freezeAuthorityRevoked).toBe(true);
    // RPC cannot cheaply answer creator identity - left undefined so
    // creatorRiskComponent reads it as neutral, not risky.
    expect(seed.creatorAddress).toBeUndefined();
    expect(seed.creatorTokenLaunchCount).toBeUndefined();
  });

  it("keeps DexScreener's liquidity when RPC fails, falling back only the RPC-sourced fields", async () => {
    const rpc = fakeRpc({ fail: () => true });
    const provider = build(rpc, fakeDexScreener({ liquidityUsd: 50_000, marketCapUsd: 250_000 }), () => 0);

    await provider.prefetch(MINT);
    const seed = provider.get(MINT);

    expect(seed.liquidityUsd).toBe(50_000);
    expect(seed.marketCapUsd).toBe(250_000);
    expect(seed.top10HolderPct).toBe(1);
    expect(seed.mintAuthorityRevoked).toBe(false);
    expect(seed.freezeAuthorityRevoked).toBe(false);
  });

  it("keeps RPC's holder/authority data when DexScreener fails", async () => {
    const rpc = fakeRpc({
      mintAccount: { mintAuthority: null, freezeAuthority: null },
      largest: [{ amount: "150" }],
      supply: { amount: "1000" },
    });
    const provider = build(rpc, fakeDexScreener("fails"), () => 0);

    await provider.prefetch(MINT);
    const seed = provider.get(MINT);

    expect(seed.liquidityUsd).toBe(0);
    expect(seed.top10HolderPct).toBeCloseTo(0.15, 6);
    expect(seed.mintAuthorityRevoked).toBe(true);
    expect(seed.freezeAuthorityRevoked).toBe(true);
  });

  it("excludes a pump.fun mint's bonding-curve account from holder concentration", async () => {
    // A real pump.fun mint; its curve's token account (Token-2022) was
    // measured live holding 99.9% of supply.
    const pumpMint = "GUDj8gaa3Mw7Jv4dE2k3h1q8aMwRrdX794CwATVopump";
    const curveAccounts = [...pumpFunBondingCurveTokenAccounts(pumpMint)];
    expect(curveAccounts.some((a) => a.startsWith("BRVdWw"))).toBe(true);

    const rpc = fakeRpc({
      largest: [
        { address: curveAccounts[1], amount: "900" },
        { address: "Holder1", amount: "60" },
        { address: "Holder2", amount: "40" },
      ],
      supply: { amount: "1000" },
    });
    const provider = build(rpc, fakeDexScreener({}), () => 0);
    await provider.prefetch(pumpMint);

    const seed = provider.get(pumpMint);
    expect(seed.top10HolderPct).toBeCloseTo(0.1, 6);
    expect(seed.holderCount).toBe(2);
  });

  it("reads a null authority as revoked and a non-null one as live", async () => {
    const revoked = build(
      fakeRpc({ mintAccount: { mintAuthority: null, freezeAuthority: null } }),
      fakeDexScreener({}),
      () => 0,
    );
    await revoked.prefetch(MINT);
    expect(revoked.get(MINT).mintAuthorityRevoked).toBe(true);
    expect(revoked.get(MINT).freezeAuthorityRevoked).toBe(true);

    const live = build(
      fakeRpc({ mintAccount: { mintAuthority: "Auth1111111111111111111111111111111111111", freezeAuthority: null } }),
      fakeDexScreener({}),
      () => 0,
    );
    await live.prefetch(MINT);
    expect(live.get(MINT).mintAuthorityRevoked).toBe(false);
    expect(live.get(MINT).freezeAuthorityRevoked).toBe(true);
  });

  it("treats an absent authority field as unknown-and-risky, not as revoked", async () => {
    const provider = build(fakeRpc({ mintAccount: {} }), fakeDexScreener({}), () => 0);
    await provider.prefetch(MINT);
    expect(provider.get(MINT).mintAuthorityRevoked).toBe(false);
    expect(provider.get(MINT).freezeAuthorityRevoked).toBe(false);
  });

  it("leaves the cache alone when the account is not a parseable token mint", async () => {
    const provider = build(fakeRpc({ mintAccount: undefined }), fakeDexScreener({ liquidityUsd: 7000 }), () => 0);
    await provider.prefetch(MINT);
    const seed = provider.get(MINT);
    expect(seed.liquidityUsd).toBe(7000);
    expect(seed.top10HolderPct).toBe(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    const rpc = fakeRpc();
    let now = 0;
    const provider = build(rpc, fakeDexScreener({}), () => now, 1_000);

    await provider.prefetch(MINT);
    expect(rpc.calls()).toBe(3);

    now += 500;
    provider.get(MINT);
    await flushMicrotasks();
    expect(rpc.calls()).toBe(3); // still fresh

    now += 2_000;
    provider.get(MINT); // stale - triggers a new background refresh
    await flushMicrotasks();
    expect(rpc.calls()).toBe(6);
  });

  it("de-duplicates concurrent refreshes for the same mint", async () => {
    const rpc = fakeRpc();
    const provider = build(rpc, fakeDexScreener({}), () => 0);

    provider.get(MINT);
    provider.get(MINT);
    provider.get(MINT);
    await flushMicrotasks();

    expect(rpc.calls()).toBe(3); // one refresh = 3 RPC calls, not three refreshes
  });

  it("throttles background refresh starts across distinct mints", async () => {
    const rpc = fakeRpc();
    let now = 0;
    const provider = new CompositeTokenMetadataProvider({
      apiKey: "test-key",
      rpcFactory: () => rpc,
      dexScreener: fakeDexScreener({}),
      cacheTtlMs: 20_000,
      refreshBudget: { minIntervalMs: 250, maxConcurrent: 4, perMintRetryCooldownMs: 5_000 },
      now: () => now,
    });

    // Five never-seen mints in the same millisecond: only the first refresh
    // may start, the rest are dropped (get() still answers conservatively).
    for (let i = 0; i < 5; i += 1) expect(provider.get(`mint-${i}`).top10HolderPct).toBe(1);
    await flushMicrotasks();
    expect(rpc.calls()).toBe(3);

    now += 300; // past minIntervalMs - the next miss may start
    provider.get("mint-1");
    await flushMicrotasks();
    expect(rpc.calls()).toBe(6);
  });

  it("does not retry a never-successful mint on every get() while its cooldown holds", async () => {
    const rpc = fakeRpc({ fail: () => true });
    let now = 0;
    const provider = new CompositeTokenMetadataProvider({
      apiKey: "test-key",
      rpcFactory: () => rpc,
      dexScreener: fakeDexScreener({}),
      cacheTtlMs: 20_000,
      refreshBudget: { minIntervalMs: 0, maxConcurrent: 4, perMintRetryCooldownMs: 5_000 },
      now: () => now,
    });

    provider.get(MINT);
    await flushMicrotasks();
    const afterFirst = rpc.calls();
    expect(afterFirst).toBeGreaterThan(0);

    now += 1_000; // inside the cooldown
    provider.get(MINT);
    await flushMicrotasks();
    expect(rpc.calls()).toBe(afterFirst);

    now += 5_000; // past it
    provider.get(MINT);
    await flushMicrotasks();
    expect(rpc.calls()).toBeGreaterThan(afterFirst);
  });
});

describe("top10ConcentrationFrom", () => {
  it("sums the ten largest balances over total supply", () => {
    // 12 accounts; the ten largest are 100..10 (sum 550), the 5 and 1 are
    // outside the top ten and must be excluded.
    const largest = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 1].map((n) => ({ amount: String(n) }));
    expect(top10ConcentrationFrom(largest, "1000")).toBeCloseTo(0.55, 6);
  });

  it("sorts by balance rather than trusting the RPC's ordering", () => {
    const largest = [10, 100, 90, 80, 70, 60, 50, 40, 30, 20, 5].map((n) => ({ amount: String(n) }));
    expect(top10ConcentrationFrom(largest, "1000")).toBeCloseTo(0.55, 6);
  });

  it("clamps to 1 when the reported balances exceed supply", () => {
    expect(top10ConcentrationFrom([{ amount: "2000" }], "1000")).toBe(1);
  });

  it("stays precise for balances beyond double-precision integer range", () => {
    // 1e18 raw units (a 9-decimal mint with a 1e9 supply) - would lose
    // precision if summed as numbers rather than bigints.
    expect(top10ConcentrationFrom([{ amount: "250000000000000001" }], "1000000000000000000")).toBeCloseTo(0.25, 6);
  });

  it("returns undefined for missing/zero supply or unusable balances", () => {
    expect(top10ConcentrationFrom([{ amount: "100" }], undefined)).toBeUndefined();
    expect(top10ConcentrationFrom([{ amount: "100" }], "0")).toBeUndefined();
    expect(top10ConcentrationFrom([], "1000")).toBeUndefined();
    expect(top10ConcentrationFrom([{ amount: "not-a-number" }], "1000")).toBeUndefined();
  });
});

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
