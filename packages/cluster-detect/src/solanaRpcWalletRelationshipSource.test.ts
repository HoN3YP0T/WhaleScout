import { describe, expect, it, vi } from "vitest";
import { MockWalletRelationshipSource } from "./mockRelationshipSource.js";
import {
  SolanaRpcWalletRelationshipSource,
  funderFromTransaction,
  type SignatureInfoLike,
  type SolanaHistoryRpcLike,
  type TransactionLike,
} from "./solanaRpcWalletRelationshipSource.js";
import type { WalletRelationshipSource } from "./walletRelationshipSource.js";

const MINT = "TokenMint111111111111111111111111111111111";
const FUNDER = "Funder11111111111111111111111111111111111";
const OTHER_FUNDER = "Other111111111111111111111111111111111111";
const WALLET_A = "WalletA11111111111111111111111111111111111";
const WALLET_B = "WalletB11111111111111111111111111111111111";

const LAMPORT = 1;
const SOL = 1_000_000_000 * LAMPORT;

/** A funding transaction: `funder` pays 1 SOL to `wallet`. Fee payer is the
 * funder, which is the realistic shape. */
function fundingTx(funder: string, wallet: string): TransactionLike {
  return {
    accountKeys: [funder, wallet],
    preBalances: [10 * SOL, 0],
    postBalances: [9 * SOL, 1 * SOL],
  };
}

/** A mint creation transaction: `deployer` is the fee payer at index 0. */
function mintCreationTx(deployer: string, mint: string): TransactionLike {
  return {
    accountKeys: [deployer, mint],
    preBalances: [5 * SOL, 0],
    postBalances: [4 * SOL, 0],
  };
}

interface FakeHistory {
  /** address -> signatures, newest first. */
  signatures: Record<string, string[]>;
  /** signature -> transaction. */
  transactions: Record<string, TransactionLike>;
  fail?: () => boolean;
}

function fakeRpc(history: FakeHistory): SolanaHistoryRpcLike & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    getSignaturesForAddress: vi.fn(async (address: string, options: { limit: number; before?: string }) => {
      calls += 1;
      if (history.fail?.()) throw new Error("rpc down");
      const all = history.signatures[address] ?? [];
      const start = options.before === undefined ? 0 : all.indexOf(options.before) + 1;
      return all.slice(start, start + options.limit).map((signature): SignatureInfoLike => ({ signature }));
    }),
    getTransaction: vi.fn(async (signature: string) => {
      calls += 1;
      if (history.fail?.()) throw new Error("rpc down");
      return history.transactions[signature];
    }),
  };
}

function build(
  rpc: SolanaHistoryRpcLike,
  opts: { now?: () => number; maxSignaturePages?: number; perMintRetryCooldownMs?: number } = {},
): SolanaRpcWalletRelationshipSource {
  return new SolanaRpcWalletRelationshipSource({
    apiKey: "test-key",
    rpcFactory: () => rpc,
    // Throttle off by default so each test exercises exactly the behaviour
    // it is about; the cooldown gets its own test below.
    refreshBudget: { minIntervalMs: 0, maxConcurrent: 100, perMintRetryCooldownMs: opts.perMintRetryCooldownMs ?? 0 },
    maxSignaturePages: opts.maxSignaturePages,
    now: opts.now,
  });
}

/** Two wallets funded by the same address, plus a mint deployed by FUNDER. */
function sharedFunderHistory(): FakeHistory {
  return {
    signatures: {
      [WALLET_A]: ["a-latest", "a-first"],
      [WALLET_B]: ["b-latest", "b-first"],
      [MINT]: ["m-latest", "m-first"],
    },
    transactions: {
      "a-first": fundingTx(FUNDER, WALLET_A),
      "b-first": fundingTx(FUNDER, WALLET_B),
      "m-first": mintCreationTx(FUNDER, MINT),
    },
  };
}

describe("SolanaRpcWalletRelationshipSource", () => {
  it("throws on an empty apiKey rather than proceeding unauthenticated", () => {
    expect(() => new SolanaRpcWalletRelationshipSource({ apiKey: "" })).toThrow(/non-empty apiKey/);
  });

  it("emits one common-funder edge at weight 0.9 for two wallets sharing a funder", async () => {
    const source = build(fakeRpc(sharedFunderHistory()));
    await source.prefetch(MINT, [WALLET_A, WALLET_B]);

    const edges = source.commonFunderEdges([WALLET_A, WALLET_B]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ a: WALLET_A, b: WALLET_B, reason: "common-funder", weight: 0.9 });
  });

  it("emits no edge for two wallets with different funders", async () => {
    const history = sharedFunderHistory();
    history.transactions["b-first"] = fundingTx(OTHER_FUNDER, WALLET_B);
    const source = build(fakeRpc(history));
    await source.prefetch(MINT, [WALLET_A, WALLET_B]);

    expect(source.commonFunderEdges([WALLET_A, WALLET_B])).toEqual([]);
  });

  it("emits no edge and does not throw while funders are still unknown", async () => {
    const source = build(fakeRpc(sharedFunderHistory()));

    // Cold cache: synchronous read answers immediately, edge-free.
    expect(source.commonFunderEdges([WALLET_A, WALLET_B])).toEqual([]);
    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(false);
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(false);

    // ...and once the background lookups it scheduled land, the edge appears
    // without any further prompting.
    await flushMicrotasks();
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(true);
    expect(source.commonFunderEdges([WALLET_A, WALLET_B])).toHaveLength(1);
  });

  it("identifies the deployer from the mint's earliest signature and treats deployer-funded wallets as creator-associated", async () => {
    const source = build(fakeRpc(sharedFunderHistory()));
    await source.prefetch(MINT, [WALLET_A, WALLET_B, FUNDER]);

    // FUNDER deployed the mint AND funded both wallets.
    expect(source.isCreatorAssociated(MINT, FUNDER)).toBe(true);
    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(true);
    expect(source.isCreatorAssociated(MINT, WALLET_B)).toBe(true);

    const edges = source.sharedCreatorEdges(MINT, [WALLET_A, WALLET_B]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ reason: "shared-creator", weight: 1 });
  });

  it("does not treat a wallet funded by someone other than the deployer as creator-associated", async () => {
    const history = sharedFunderHistory();
    history.transactions["m-first"] = mintCreationTx(OTHER_FUNDER, MINT);
    const source = build(fakeRpc(history));
    await source.prefetch(MINT, [WALLET_A]);

    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(false);
    expect(source.sharedCreatorEdges(MINT, [WALLET_A, WALLET_B])).toEqual([]);
  });

  it("caches funders and deployers permanently - a second lookup issues no new RPC calls", async () => {
    const rpc = fakeRpc(sharedFunderHistory());
    // A clock that jumps a full day forward proves there is no TTL at all:
    // an original funder and a deployer are immutable facts.
    let now = 0;
    const source = build(rpc, { now: () => now });

    await source.prefetch(MINT, [WALLET_A]);
    const afterFirst = rpc.calls();
    expect(afterFirst).toBeGreaterThan(0);

    now += 86_400_000;
    source.commonFunderEdges([WALLET_A]);
    source.isCreatorAssociated(MINT, WALLET_A);
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(true);
    await flushMicrotasks();
    await source.prefetch(MINT, [WALLET_A]);

    expect(rpc.calls()).toBe(afterFirst);
  });

  it("respects the retry cooldown after a failed lookup instead of re-firing on every read", async () => {
    let failing = true;
    const rpc = fakeRpc({ ...sharedFunderHistory(), fail: () => failing });
    let now = 0;
    const source = build(rpc, { now: () => now, perMintRetryCooldownMs: 5_000 });

    source.commonFunderEdges([WALLET_A, WALLET_B]);
    await flushMicrotasks();
    const afterFirst = rpc.calls();
    expect(afterFirst).toBeGreaterThan(0);

    now += 1_000; // inside the cooldown
    source.commonFunderEdges([WALLET_A, WALLET_B]);
    source.commonFunderEdges([WALLET_A, WALLET_B]);
    await flushMicrotasks();
    expect(rpc.calls()).toBe(afterFirst);

    now += 5_000; // past it
    failing = false;
    source.commonFunderEdges([WALLET_A, WALLET_B]);
    await flushMicrotasks();
    expect(rpc.calls()).toBeGreaterThan(afterFirst);
    // The retried lookup succeeded, so the edge the failure had suppressed
    // now exists.
    expect(source.commonFunderEdges([WALLET_A, WALLET_B])).toHaveLength(1);
  });

  it("honours the pagination cap, recording unknown rather than paginating forever", async () => {
    // A wallet whose history never ends within the cap: every page comes
    // back full, so the earliest signature is never reached.
    const pageSize = 1000;
    const signatures = Array.from({ length: pageSize * 10 }, (_, i) => `sig-${i}`);
    const rpc = fakeRpc({
      signatures: { [WALLET_A]: signatures },
      transactions: { [signatures[signatures.length - 1]]: fundingTx(FUNDER, WALLET_A) },
    });
    const source = build(rpc, { maxSignaturePages: 3 });

    await source.prefetch(MINT, [WALLET_A]);

    // 3 signature pages for the wallet and 1 for the (empty-history) mint -
    // and crucially no getTransaction call, because no earliest signature
    // was ever established.
    expect(rpc.calls()).toBe(4);
    expect(source.commonFunderEdges([WALLET_A, WALLET_B])).toEqual([]);
    // Unknown, not "no funder": the cap leaves nothing cached, so the
    // lookup can be retried once the cooldown lapses.
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(false);
  });

  it("records a conclusive no-funder result rather than retrying forever", async () => {
    const rpc = fakeRpc({
      signatures: { [WALLET_A]: ["a-only"], [MINT]: ["m-first"] },
      // Earliest transaction is not a funding of WALLET_A at all.
      transactions: {
        "a-only": { accountKeys: [WALLET_A, OTHER_FUNDER], preBalances: [1 * SOL, 1 * SOL], postBalances: [0, 2 * SOL] },
        "m-first": mintCreationTx(FUNDER, MINT),
      },
    });
    const source = build(rpc, { perMintRetryCooldownMs: 5_000 });
    await source.prefetch(MINT, [WALLET_A]);
    const afterFirst = rpc.calls();

    // Conclusively "no funder" - cached, so reads never re-trigger a lookup.
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(true);
    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(false);
    expect(source.commonFunderEdges([WALLET_A])).toEqual([]);
    await flushMicrotasks();
    expect(rpc.calls()).toBe(afterFirst);
  });

  it("resolves a history that is an exact multiple of the page size", async () => {
    // One full page, then an empty one: the full page's last signature is
    // the first, and must not be recorded as unknown.
    const signatures = Array.from({ length: 1000 }, (_, i) => `sig-${i}`);
    const rpc = fakeRpc({
      signatures: { [WALLET_A]: signatures, [MINT]: ["m-first"] },
      transactions: { [signatures[999]]: fundingTx(FUNDER, WALLET_A), "m-first": mintCreationTx(FUNDER, MINT) },
    });
    const source = build(rpc);

    await source.prefetch(MINT, [WALLET_A]);
    expect(source.relationshipDataKnown(MINT, WALLET_A)).toBe(true);
    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(true);
  });

  it("walks back through full pages to the real earliest signature", async () => {
    const pageSize = 1000;
    const first = Array.from({ length: pageSize }, (_, i) => `p0-${i}`);
    const second = ["p1-0", "p1-1"];
    const rpc = fakeRpc({
      signatures: { [WALLET_A]: [...first, ...second], [MINT]: ["m-first"] },
      transactions: { "p1-1": fundingTx(FUNDER, WALLET_A), "m-first": mintCreationTx(FUNDER, MINT) },
    });
    const source = build(rpc);

    await source.prefetch(MINT, [WALLET_A]);
    expect(source.isCreatorAssociated(MINT, WALLET_A)).toBe(true);
  });
});

describe("funderFromTransaction", () => {
  it("picks the account with the largest lamport decrease", () => {
    const tx: TransactionLike = {
      accountKeys: [FUNDER, OTHER_FUNDER, WALLET_A],
      preBalances: [10 * SOL, 10 * SOL, 0],
      postBalances: [5 * SOL, 9.9 * SOL, 5 * SOL],
    };
    expect(funderFromTransaction(tx, WALLET_A)).toBe(FUNDER);
  });

  it("ignores decreases too small to be a funding transfer (fees, rent)", () => {
    const tx: TransactionLike = {
      accountKeys: [OTHER_FUNDER, WALLET_A],
      preBalances: [10 * SOL, 0],
      postBalances: [10 * SOL - 5000, 1],
    };
    expect(funderFromTransaction(tx, WALLET_A)).toBeUndefined();
  });

  it("returns undefined when the wallet did not gain lamports, or is absent", () => {
    expect(funderFromTransaction(fundingTx(FUNDER, WALLET_A), WALLET_B)).toBeUndefined();
    expect(
      funderFromTransaction({ accountKeys: [WALLET_A, FUNDER], preBalances: [1 * SOL, 0], postBalances: [0, 1 * SOL] }, WALLET_A),
    ).toBeUndefined();
  });
});

describe("WalletRelationshipSource interface", () => {
  it("is satisfied by both the mock and the RPC-backed implementation", () => {
    const implementations: WalletRelationshipSource[] = [
      new MockWalletRelationshipSource(),
      new SolanaRpcWalletRelationshipSource({ apiKey: "test-key", rpcFactory: () => fakeRpc({ signatures: {}, transactions: {} }) }),
    ];
    for (const impl of implementations) {
      expect(impl.commonFunderEdges([WALLET_A, WALLET_B])).toEqual([]);
      expect(impl.sharedCreatorEdges(MINT, [WALLET_A, WALLET_B])).toEqual([]);
      expect(impl.isCreatorAssociated(MINT, WALLET_A)).toBe(false);
      expect(typeof impl.relationshipDataKnown(MINT, WALLET_A)).toBe("boolean");
    }
    // The mock is ground truth for its own fixtures, so nothing is ever
    // "not yet checked" on that path - which is what keeps the default
    // wiring's behaviour unchanged.
    expect(new MockWalletRelationshipSource().relationshipDataKnown(MINT, WALLET_A)).toBe(true);
  });
});

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
