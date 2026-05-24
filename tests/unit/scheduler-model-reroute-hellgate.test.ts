/**
 * ADR-0161 Phase D — Model reroute hellgate.
 *
 * preference / fallback chain / all-unavailable / probe-throws / dedupe /
 * empty preference / special chars / long chain.
 */

import { describe, expect, test } from "bun:test"
import { chooseModel } from "@/scheduler/model-reroute"
import type { ModelAvailabilityPort } from "@/scheduler/types"

const portOf = (available: ReadonlyArray<string>): ModelAvailabilityPort => ({
  isAvailable: async (model) => available.includes(model),
})

const throwingPort: ModelAvailabilityPort = {
  isAvailable: async () => {
    throw new Error("network down")
  },
}

describe("chooseModel hellgate", () => {
  test("[1] preference available → preference-available", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4"],
      availability: portOf(["gpt-5", "claude-4"]),
    })
    expect(r.chosen).toBe("gpt-5")
    expect(r.reason).toBe("preference-available")
    expect(r.fallbackIndex).toBeUndefined()
  })

  test("[2] preference unavail + first fallback available → fallback idx=0", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4", "gpt-4-mini"],
      availability: portOf(["claude-4"]),
    })
    expect(r.chosen).toBe("claude-4")
    expect(r.reason).toBe("fallback")
    expect(r.fallbackIndex).toBe(0)
  })

  test("[3] preference + first 2 fallbacks unavail + 3rd available → idx=2", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["m1", "m2", "m3"],
      availability: portOf(["m3"]),
    })
    expect(r.chosen).toBe("m3")
    expect(r.reason).toBe("fallback")
    expect(r.fallbackIndex).toBe(2)
  })

  test("[4] all unavailable → all-unavailable + chosen=preference", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4", "gpt-4-mini"],
      availability: portOf([]),
    })
    expect(r.reason).toBe("all-unavailable")
    expect(r.chosen).toBe("gpt-5")
  })

  test("[5] empty fallbacks + preference unavail → all-unavailable", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: [],
      availability: portOf([]),
    })
    expect(r.reason).toBe("all-unavailable")
  })

  test("[6] availability throws → treated as unavailable", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4"],
      availability: throwingPort,
    })
    expect(r.reason).toBe("all-unavailable")
  })

  test("[7] preference duplicated in fallbacks → probed only once", async () => {
    let probeCount = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => {
        probeCount += 1
        return m === "claude-4"
      },
    }
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["gpt-5", "claude-4"],
      availability: port,
    })
    expect(r.chosen).toBe("claude-4")
    // gpt-5 probed once (not twice), claude-4 probed once. Total 2 probes.
    expect(probeCount).toBe(2)
  })

  test("[8] special chars in model name passthrough", async () => {
    const r = await chooseModel({
      preference: "anthropic/claude-3.5-sonnet@20241022",
      fallbacks: [],
      availability: portOf(["anthropic/claude-3.5-sonnet@20241022"]),
    })
    expect(r.chosen).toBe("anthropic/claude-3.5-sonnet@20241022")
  })

  test("[9] very long fallback chain — stops at first available", async () => {
    const chain = Array.from({ length: 100 }, (_, i) => `m${i}`)
    let probeCount = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => {
        probeCount += 1
        return m === "m50"
      },
    }
    const r = await chooseModel({
      preference: "preferred",
      fallbacks: chain,
      availability: port,
    })
    expect(r.chosen).toBe("m50")
    expect(r.fallbackIndex).toBe(50)
    // probe: preferred + m0..m50 = 52
    expect(probeCount).toBe(52)
  })

  test("[10] empty preference → all-unavailable without probing", async () => {
    let probed = false
    const port: ModelAvailabilityPort = {
      isAvailable: async () => {
        probed = true
        return true
      },
    }
    const r = await chooseModel({
      preference: "",
      fallbacks: ["claude-4"],
      availability: port,
    })
    expect(r.reason).toBe("all-unavailable")
    expect(probed).toBe(false)
  })
})
