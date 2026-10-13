import { EventBus, type DomainEventName } from "@whale-sniper/core";
import { describe, expect, it } from "vitest";

describe("EventBus listener isolation", () => {
  it("keeps delivering to later listeners when an earlier one throws, and reports the error", () => {
    const errors: Array<[DomainEventName, unknown]> = [];
    const bus = new EventBus((event, err) => errors.push([event, err]));
    const seen: string[] = [];
    bus.on("token.stats-updated", () => {
      throw new Error("boom");
    });
    bus.on("token.stats-updated", ({ tokenMint }) => {
      seen.push(tokenMint);
    });

    expect(() => bus.emit("token.stats-updated", { tokenMint: "T" })).not.toThrow();
    expect(seen).toEqual(["T"]);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe("token.stats-updated");
  });

  it("routes a rejected async listener to the error handler instead of an unhandled rejection", async () => {
    const errors: unknown[] = [];
    const bus = new EventBus((_event, err) => errors.push(err));
    bus.on("token.stats-updated", async () => {
      throw new Error("db down");
    });

    bus.emit("token.stats-updated", { tokenMint: "T" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("db down");
  });
});
