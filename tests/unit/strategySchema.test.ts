import { readFileSync } from "node:fs";
import { parseStrategyConfig } from "@whale-sniper/core";
import { describe, expect, it } from "vitest";

const raw = JSON.parse(readFileSync(new URL("../../config/strategy.json", import.meta.url), "utf-8"));

describe("strategy config validation", () => {
  it("accepts the shipped config", () => {
    expect(() => parseStrategyConfig(raw)).not.toThrow();
  });

  it("rejects a stop loss of 100% or more, which could never trigger", () => {
    const bad = structuredClone(raw);
    bad.position.initialStopLossPct = 100;
    expect(() => parseStrategyConfig(bad)).toThrow();
  });

  it("rejects whale-exit thresholds that are out of order", () => {
    const bad = structuredClone(raw);
    bad.whaleExit.reduceThresholdPct = 0.8; // above emergency (0.6)
    expect(() => parseStrategyConfig(bad)).toThrow(/warn <= reduce <= emergency/);
  });
});
