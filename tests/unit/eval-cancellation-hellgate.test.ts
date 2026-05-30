/**
 * ★ CONTRACT — T01 (May-31 bugbash): eval / python-swebench cancellation.
 *
 * HELLGATE — proves the SWE-bench harness orchestration honors the per-instance
 * deadline signal: the transient-crash retry SLEEP races abort (L5 M-8) instead
 * of blocking the full 5s, and the retry SPAWN is skipped when already aborted
 * (L5 H-5). Without the fix a cancelled instance ran its 5s settle + a second
 * harness spawn to completion, cascading the deadline into the next instance.
 */

import { describe, expect, test } from "bun:test"
import { evaluateWithPythonSwebench } from "@/apps/bench/python-swebench"
import type { Instance } from "@/apps/bench/types"

const swInstance = (): Instance =>
  ({
    id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    testCmd: "pytest -q",
    swebench: {
      instanceId: "astropy__astropy-12907",
      repo: "astropy/astropy",
      baseCommit: "deadbeef",
    },
  }) as unknown as Instance

describe("python-swebench — retry sleep/spawn honor the abort signal", () => {
  test("an already-aborted signal skips the 5s settle + retry spawn (no cascade)", async () => {
    const c = new AbortController()
    c.abort()
    let spawnCalls = 0
    // First spawn: non-zero, no summary marker ⇒ would normally trigger the
    // transient-crash 5s settle + retry. With the signal already aborted the
    // settle rejects immediately and the retry spawn is skipped.
    const spawn = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      spawnCalls++
      return { code: 1, stdout: "", stderr: "boom" }
    }
    const started = Date.now()
    const r = await evaluateWithPythonSwebench(swInstance(), "diff --git a b", {
      spawn,
      probe: () => Promise.resolve(true),
      signal: c.signal,
    })
    const elapsed = Date.now() - started
    // Exactly ONE spawn — the retry was skipped.
    expect(spawnCalls).toBe(1)
    // Did NOT block for the 5s settle.
    expect(elapsed).toBeLessThan(2000)
    // Result is a clean (non-throwing) typed shape — best-effort harness never throws.
    expect(r.resolved).toBe(false)
  })

  test("a live signal still performs the transient-crash retry (no false skip)", async () => {
    let spawnCalls = 0
    const spawn = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      spawnCalls++
      return { code: 1, stdout: "", stderr: "boom" }
    }
    // No signal ⇒ the 5s settle would run; to keep the test fast we still assert
    // the retry path is taken by using a live (never-fired) signal and a tiny
    // override is not available, so we cap with a generous timeout. Instead we
    // assert structurally: with a NON-aborted signal the retry IS attempted.
    const c = new AbortController()
    const r = await evaluateWithPythonSwebench(swInstance(), "diff --git a b", {
      spawn,
      probe: () => Promise.resolve(true),
      signal: c.signal,
    })
    // Two spawns: initial + retry (the 5s settle completed because the signal
    // never fired).
    expect(spawnCalls).toBe(2)
    expect(r.resolved).toBe(false)
  }, 15_000)
})
