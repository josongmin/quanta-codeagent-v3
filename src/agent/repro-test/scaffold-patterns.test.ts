import { describe, expect, test } from "bun:test"
import { isBenchReproArtifactBasename } from "@/runner/batch/eval/repro-artifacts"
import { HYGIENE_ALLOWLIST } from "@/agent/closure/patch-hygiene"
import {
  REPRO_CANONICAL_BASENAME,
  isReproArtifactBasename,
  isReproScriptBasename,
  reproScriptBasename,
} from "./scaffold-patterns"

// RFC jun-29 Phase 1b: the repro-scaffold basenames were defined in THREE places (anchor-synth
// regex, patch-hygiene literal, repro-artifacts regexes). They now derive from THIS leaf SSOT.
// These tests LOCK the contract so a future drift (or polyglot ext change) is caught.

const SCRIPTS = [
  reproScriptBasename(0, "a1b2c3d4-0000-4000-8000-000000000000"),
  reproScriptBasename(7, "deadbeef"),
  REPRO_CANONICAL_BASENAME,
]
const SIDECARS = SCRIPTS.map((s) => `${s}.pytest-report.json`)
const DECOYS = ["src/foo.py", "reproduce_issue.txt", "__repro_.py", "test_repro.py", "main.go"]

describe("repro scaffold SSOT", () => {
  test("reproScriptBasename builds a name the SCRIPT predicate recognizes", () => {
    // uuid is hex+dash (the rail uses real UUIDs; the pattern is [0-9a-fA-F-]+).
    expect(reproScriptBasename(3, "abcd-1234")).toBe("__repro_3_abcd-1234.py")
    expect(isReproScriptBasename(reproScriptBasename(3, "abcd-1234"))).toBe(true)
  })

  // hellaudit lock: execute.ts's name GENERATOR uses reproScriptBasename, so both id forms it
  // feeds (crypto UUID + the no-crypto fallback `Date-pid-i-counter`) MUST be recognized — else
  // a generated repro leaks past the artifact/anchor/hygiene filters.
  test("generator id forms (uuid + Date-pid fallback) are recognized by the SCRIPT predicate", () => {
    expect(isReproScriptBasename(reproScriptBasename(0, "a1b2c3d4-0000-4000-8000-000000000000"))).toBe(true)
    expect(isReproScriptBasename(reproScriptBasename(2, "1782726785470-12345-2-7"))).toBe(true)
  })

  test("script predicate: scripts ✓, sidecars ✗ (anchor synth must NOT anchor a sidecar)", () => {
    for (const s of SCRIPTS) expect(isReproScriptBasename(s)).toBe(true)
    for (const sc of SIDECARS) expect(isReproScriptBasename(sc)).toBe(false)
    for (const d of DECOYS) expect(isReproScriptBasename(d)).toBe(false)
  })

  test("artifact predicate: scripts ✓ AND sidecars ✓ (filter/strip excludes both)", () => {
    for (const s of [...SCRIPTS, ...SIDECARS]) expect(isReproArtifactBasename(s)).toBe(true)
    for (const d of DECOYS) expect(isReproArtifactBasename(d)).toBe(false)
  })

  test("hygiene allowlist = the canonical scaffold (sourced from SSOT, no drift)", () => {
    expect(HYGIENE_ALLOWLIST).toEqual([REPRO_CANONICAL_BASENAME])
  })
})

// The cross-module AGREEMENT lock: repro-artifacts' public predicate (consumed by snapshot
// strip) MUST agree with the SSOT for the full battery — proves the consolidation is wired, not
// just co-incidentally equal. Catches any site re-introducing a private divergent regex.
describe("cross-module agreement (repro-artifacts ↔ SSOT)", () => {
  test("isBenchReproArtifactBasename == isReproArtifactBasename across scripts/sidecars/decoys", () => {
    for (const name of [...SCRIPTS, ...SIDECARS, ...DECOYS]) {
      expect(isBenchReproArtifactBasename(name)).toBe(isReproArtifactBasename(name))
    }
  })
})
