import { resolveSolanaRpcEndpoint } from "@whale-sniper/core";
import { HeliusFeedProvider } from "@whale-sniper/feed";
import { describe, expect, it } from "vitest";

const none = { SOLANA_RPC_URL: "", SOLANA_WS_URL: "", HELIUS_API_KEY: "" };

describe("resolveSolanaRpcEndpoint", () => {
  it("is undefined with neither SOLANA_RPC_URL nor HELIUS_API_KEY", () => {
    expect(resolveSolanaRpcEndpoint(none)).toBeUndefined();
  });

  it("falls back to Helius when only HELIUS_API_KEY is set, without leaking the key into the label", () => {
    const ep = resolveSolanaRpcEndpoint({ ...none, HELIUS_API_KEY: "secret" })!;
    expect(ep.httpUrl).toBe("https://mainnet.helius-rpc.com/?api-key=secret");
    expect(ep.wsUrl).toBe("wss://mainnet.helius-rpc.com/?api-key=secret");
    expect(ep.label).not.toContain("secret");
  });

  it("prefers SOLANA_RPC_URL, deriving the WebSocket URL unless one is given", () => {
    const ep = resolveSolanaRpcEndpoint({ ...none, HELIUS_API_KEY: "k", SOLANA_RPC_URL: "https://rpc.example.com/abc?token=t" })!;
    expect(ep.httpUrl).toBe("https://rpc.example.com/abc?token=t");
    expect(ep.wsUrl).toBe("wss://rpc.example.com/abc?token=t");
    expect(ep.label).toBe("rpc.example.com");

    const explicit = resolveSolanaRpcEndpoint({ ...none, SOLANA_RPC_URL: "http://node:8899", SOLANA_WS_URL: "ws://node:8900" })!;
    expect(explicit.wsUrl).toBe("ws://node:8900");
  });
});

describe("HeliusFeedProvider endpoint override", () => {
  it("connects to the configured RPC endpoint without a Helius key", async () => {
    const seen: string[] = [];
    const provider = new HeliusFeedProvider({
      apiKey: "",
      rpcUrl: "https://rpc.example.com",
      wsUrl: "wss://ws.example.com",
      solUsdPrice: 100,
      connectionFactory: (ws, http) => {
        seen.push(ws, http);
        return { onLogs: () => 1, removeOnLogsListener: async () => {} };
      },
    });
    await provider.connect();
    expect(seen).toEqual(["wss://ws.example.com", "https://rpc.example.com"]);
  });

  it("still refuses to construct with neither a key nor an endpoint", () => {
    expect(() => new HeliusFeedProvider({ apiKey: "" })).toThrow(/SOLANA_RPC_URL/);
  });
});
