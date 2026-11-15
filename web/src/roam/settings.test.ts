import { describe, expect, it } from "vitest";
import { actionOf, DEFAULT_KEYS, rebind } from "./settings";

describe("free-roam key bindings", () => {
  it("maps keys and arrows to actions", () => {
    expect(actionOf(DEFAULT_KEYS, "W")).toBe("forward");
    expect(actionOf(DEFAULT_KEYS, "ArrowLeft")).toBe("left");
    expect(actionOf(DEFAULT_KEYS, " ")).toBe("jump");
    expect(actionOf(DEFAULT_KEYS, "q")).toBeNull();
  });

  it("swaps when a key is already bound, and refuses reserved keys", () => {
    const k = rebind(DEFAULT_KEYS, "forward", "e")!;
    expect(k.forward).toBe("e");
    expect(k.use).toBe("w"); // the old key moves to the action that had "e"
    expect(rebind(DEFAULT_KEYS, "jump", "1")).toBeNull();
    expect(rebind(DEFAULT_KEYS, "jump", "ArrowUp")).toBeNull();
    const z = rebind(DEFAULT_KEYS, "forward", "z")!;
    expect(actionOf(z, "z")).toBe("forward");
  });
});
