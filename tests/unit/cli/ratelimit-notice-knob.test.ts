import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "../../../src/agent"
import { isRatelimitNoticeEnabled } from "../../../src/apps/cli/ratelimit-notice"
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

  test("lenient SSOT parse — falsy ⇒ undefined; any other value ⇒ true (shared ratelimitNoticeWanted)", () => {
    expect(ratelimitNoticeKnob.parse(undefined)).toBeUndefined()
    for (const v of ["0", "false", "off", "no", "", "  ", "OFF", "False"]) {
      expect(ratelimitNoticeKnob.parse(v)).toBeUndefined()
    }
    // The knob delegates to the lenient `ratelimitNoticeWanted` SSOT so it can
    // NEVER disagree with the live capture/render gate — `yes`/`TRUE`/garbage
    // all enable (previously this strict-Set parse said undefined for them while
    // the real gate said ON: the observability drift this fix removes).
    for (const v of ["1", "on", "true", "TRUE", "On", "yes", "garbage", "2"]) {
      expect(ratelimitNoticeKnob.parse(v)).toBe(true)
    }
  })

  test("SSOT: knob.parse truthy ⟺ isRatelimitNoticeEnabled — three channels agree on every value", () => {
    for (const v of [
      undefined,
      "",
      "0",
      "false",
      "off",
      "no",
      "1",
      "on",
      "true",
      "TRUE",
      "On",
      "yes",
      "y",
      "2",
      "garbage",
      "  true  ",
    ]) {
      const knobOn = ratelimitNoticeKnob.parse(v) === true
      const gateOn = isRatelimitNoticeEnabled({ QUANTA_RATELIMIT_NOTICE: v } as NodeJS.ProcessEnv)
      expect(knobOn).toBe(gateOn) // telemetry channel === live render/capture channel
    }
  })

  test("apply is a PURE no-op — returns the config UNCHANGED (byte-identical)", () => {
    const base = { model: "x" } as unknown as AgentConfig
    const out = ratelimitNoticeKnob.apply(base, true, { surface: "cli" })
    expect(out).toBe(base) // same reference ⇒ no AgentConfig mutation
  })
})
