/**
 * jun-6 exfil-rail (c) — exfil-SCOUTING detector + taxonomy + gate hellgate.
 *
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.3 / §6 (c) / §7 (c).
 *
 * Proves:
 *  - `detectScouting` FIRES on K distinct denied non-allowlisted hosts.
 *  - NO false positive: a single denied host, K denials of the SAME host, K
 *    ALLOWLISTED (allow/amended-allow) hosts → `null`.
 *  - K is a REQUIRED configurable knob — no magic number; non-positive /
 *    non-integer K ⇒ inert (`null`).
 *  - ADVISORY (a signal, not a hard block): the function returns a hint object,
 *    never mutates/denies.
 *  - The taxonomy prose line is present in the assembled prompt ONLY when the
 *    knob is ON (byte-identical prompt assertion when OFF).
 *  - Strict env gate.
 */

import { describe, expect, test } from "bun:test"
import type { DecisionLogEntry } from "@/../src/runtime/network-proxy/types"
import {
  CLASSIFIER_SYSTEM_PROMPT,
  EXFIL_SCOUTING_TAXONOMY_LINE,
  withExfilScoutingTaxonomy,
} from "@/permission/classifier"
import { detectScouting, exfilScoutingEnabled, type ScoutingSignal } from "@/runtime/network-proxy"

const entry = (host: string, decision: DecisionLogEntry["decision"], at = 0): DecisionLogEntry =>
  Object.freeze({ host, decision, reason: "test", at })

describe("detectScouting — fires on a K-distinct denied-host probe sequence", () => {
  test("K distinct denied non-allowlisted hosts → signal with the sample", () => {
    const log = [
      entry("webhook.site", "deny"),
      entry("file.io", "deny"),
      entry("dns.example-resolver.net", "deny"),
      entry("paste.ee", "deny"),
    ]
    const sig = detectScouting(log, { threshold: 4 })
    expect(sig).not.toBeNull()
    const s = sig as ScoutingSignal
    expect(s.kind).toBe("exfil-scouting")
    expect(s.distinctDeniedHosts).toBe(4)
    expect(s.sample).toEqual(["webhook.site", "file.io", "dns.example-resolver.net", "paste.ee"])
  })

  test("sampleCap bounds the surfaced sample without changing the count", () => {
    const log = [entry("a.test", "deny"), entry("b.test", "deny"), entry("c.test", "deny")]
    const sig = detectScouting(log, { threshold: 3, sampleCap: 2 })
    expect(sig?.distinctDeniedHosts).toBe(3)
    expect(sig?.sample).toEqual(["a.test", "b.test"])
  })
})

describe("detectScouting — NO false positive (advisory false-positive discipline)", () => {
  test("a single denied host → null (below K)", () => {
    expect(detectScouting([entry("only.test", "deny")], { threshold: 4 })).toBeNull()
  })

  test("K denials of the SAME host (a retry loop) → null (distinct, not count)", () => {
    const log = [
      entry("flaky.test", "deny", 1),
      entry("flaky.test", "deny", 2),
      entry("flaky.test", "deny", 3),
      entry("flaky.test", "deny", 4),
      entry("flaky.test", "deny", 5),
    ]
    expect(detectScouting(log, { threshold: 4 })).toBeNull()
  })

  test("K allowlisted hosts (allow / amended-allow) → null (only denies count)", () => {
    const log = [
      entry("a.test", "allow"),
      entry("b.test", "allow"),
      entry("c.test", "amended-allow"),
      entry("d.test", "allow"),
    ]
    expect(detectScouting(log, { threshold: 4 })).toBeNull()
  })

  test("empty log → null", () => {
    expect(detectScouting([], { threshold: 4 })).toBeNull()
  })
})

describe("detectScouting — K is a required configurable knob (no magic number)", () => {
  test("non-positive / non-integer K ⇒ inert (null), never a guessed default", () => {
    const log = [entry("a.test", "deny"), entry("b.test", "deny")]
    expect(detectScouting(log, { threshold: 0 })).toBeNull()
    expect(detectScouting(log, { threshold: -1 })).toBeNull()
    expect(detectScouting(log, { threshold: 1.5 })).toBeNull()
    expect(detectScouting(log, { threshold: Number.NaN })).toBeNull()
  })

  test("threshold exactly met (== K) fires; one below does not", () => {
    const two = [entry("a.test", "deny"), entry("b.test", "deny")]
    expect(detectScouting(two, { threshold: 2 })?.distinctDeniedHosts).toBe(2)
    expect(detectScouting(two, { threshold: 3 })).toBeNull()
  })
})

describe("withExfilScoutingTaxonomy — prose line ONLY when ON (byte-identical OFF)", () => {
  test("OFF ⇒ the assembled prompt is byte-identical to the base prompt", () => {
    expect(withExfilScoutingTaxonomy(CLASSIFIER_SYSTEM_PROMPT, false)).toBe(
      CLASSIFIER_SYSTEM_PROMPT,
    )
  })

  test("ON ⇒ the verbatim taxonomy line is appended", () => {
    const out = withExfilScoutingTaxonomy(CLASSIFIER_SYSTEM_PROMPT, true)
    expect(out).not.toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(out.includes(EXFIL_SCOUTING_TAXONOMY_LINE)).toBe(true)
    // verbatim corpus wording — fidelity is load-bearing
    expect(EXFIL_SCOUTING_TAXONOMY_LINE).toContain("webhook sites, file-sharing, DNS resolvers")
    expect(EXFIL_SCOUTING_TAXONOMY_LINE).toContain("preparation for data exfiltration")
  })
})

describe("exfilScoutingEnabled — strict gate", () => {
  test("ON only for the exact `1` token", () => {
    expect(exfilScoutingEnabled({ QUANTA_EXFIL_SCOUTING: "1" })).toBe(true)
  })

  test("OFF for unset / empty / off-vocabulary / arbitrary", () => {
    for (const v of [undefined, "", "0", "true", "on", "yes", "2", " 1 "]) {
      expect(exfilScoutingEnabled({ QUANTA_EXFIL_SCOUTING: v })).toBe(false)
    }
    expect(exfilScoutingEnabled({})).toBe(false)
  })
})
