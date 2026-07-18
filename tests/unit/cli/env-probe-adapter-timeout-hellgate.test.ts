/**
 * GAP-CLOSER (leaf audit, jul-18) — `createProbeExecPort` REAL-SPAWN timeout
 * (the anti-STARTUP-HANG guarantee).
 *
 * The env-probe leaf invariant is "no startup hang: a `<bin> --version` that
 * does not return is bounded and treated as an `Err`". The existing wire
 * hellgate exercises the real adapter only for a FAST-EXIT binary (`node
 * --version`) and an ABSENT binary — NEITHER drives the `settleProbe`
 * `timedOut` branch (kill the child, return `Err{kind:"timeout"}`). That
 * branch IS the anti-hang mechanism; untested, a regression that dropped the
 * kill/timeout (e.g. awaiting `child.exited` with no bound) would hang startup
 * forever and every existing test would still pass.
 *
 * This test spawns a genuinely HANGING binary (`sleep 30`) with a tiny 120ms
 * timeout. It is NON-VACUOUS: if the timeout/kill regressed, THIS TEST ITSELF
 * would hang for 30s (bun's per-test timeout would then fail it) — the guard is
 * observed by the fact that it returns promptly with `Err{kind:"timeout"}`.
 */

import { describe, expect, it } from "bun:test"
import { createProbeExecPort } from "@/apps/cli/repl/env-probe-wire"

describe("env-probe adapter — real-spawn timeout bounds a hanging probe (no startup hang)", () => {
  it(
    "a hanging binary (sleep 30) is killed at the timeout ⇒ Err{kind:timeout}, returns promptly",
    async () => {
      const TIMEOUT_MS = 120
      const exec = createProbeExecPort(TIMEOUT_MS)
      const startedAt = Date.now()
      // `sleep 30` never returns within the window — the ONLY way this resolves
      // is the adapter's timeout→kill path. (If that regressed the promise would
      // hang for ~30s and bun's test timeout would fail this test.)
      const res = await exec(["sleep", "30"])
      const elapsed = Date.now() - startedAt

      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.kind).toBe("timeout")
      // Returned promptly — bounded by the timeout, NOT the 30s sleep. Generous
      // ceiling (spawn + kill reap overhead) but far below the 30s hang.
      expect(elapsed).toBeLessThan(5_000)
    },
    // Belt-and-suspenders: cap the test itself well under the 30s sleep so a
    // regression FAILS loudly instead of stalling the suite.
    10_000,
  )

  it("timeout detail names the window (advisory, no throw)", async () => {
    const exec = createProbeExecPort(80)
    const res = await exec(["sleep", "30"])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.kind).toBe("timeout")
      expect(res.error.detail).toContain("80ms")
    }
  })
})
