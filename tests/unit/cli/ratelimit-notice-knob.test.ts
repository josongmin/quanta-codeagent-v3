import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "../../../src/agent"
import { ratelimitNoticeKnob } from "../../../src/runner/knobs/knobs/ratelimit-notice"

/**
 * P27 — `ratelimit-notice` knob record contract.
 *
 * This is a CLI surface-render flag whose gate is read by `readCliFeatureConfig`
 * straight off the env; the knob record exists for the SSOT registry (`--help`,
 * telemetry, `/knobs`). Its `apply` MUST be a PURE no-op so the byte-identical
 * default-OFF contract holds (the resolved config is unchanged).
 */

describe("P27 ratelimitNoticeKnob — record shape + strict default-OFF parse", () => {
  test("metadata: cli-only surface, hint category, opt-in env key", () => {
    expect(ratelimitNoticeKnob.id).toBe("ratelimit-notice")
    expect(ratelimitNoticeKnob.envKey).toBe("QUANTA_RATELIMIT_NOTICE")
    expect(ratelimitNoticeKnob.surfaces).toEqual(["cli"])
    expect(ratelimitNoticeKnob.category).toBe("hint")
  })

  test("strict parse — only 1/on/true enable; unset/falsy/garbage ⇒ undefined", () => {
    expect(ratelimitNoticeKnob.parse(undefined)).toBeUndefined()
    for (const v of ["0", "false", "off", "no", "", "yes", "garbage"]) {
      expect(ratelimitNoticeKnob.parse(v)).toBeUndefined()
    }
    for (const v of ["1", "on", "true"]) {
      expect(ratelimitNoticeKnob.parse(v)).toBe(true)
    }
  })

  test("apply is a PURE no-op — returns the config UNCHANGED (byte-identical)", () => {
    const base = { model: "x" } as unknown as AgentConfig
    const out = ratelimitNoticeKnob.apply(base, true, { surface: "cli" })
    expect(out).toBe(base) // same reference ⇒ no AgentConfig mutation
  })
})
