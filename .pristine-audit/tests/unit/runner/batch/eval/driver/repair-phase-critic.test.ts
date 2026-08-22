/**
 * repair-phase OwnerCritic wiring (jul-6 S1) — the hot-path wire was untested.
 *
 * Pins the observe-only contract of `maybeCriticRefute`:
 *   1. default-OFF ⇒ undefined (⇒ Phase.criticRefutes absent ⇒ byte-identical);
 *   2. empty patch ⇒ undefined (nothing to refute);
 *   3. the critic is called for EVERY (file × symbol) the patch edits (`checked`),
 *      and ONLY `refuted` verdicts are recorded (not_refuted / inconclusive are not);
 *   4. FAIL-OPEN: a throwing critic ⇒ undefined, never propagates (repair unaffected);
 *   5. an already-aborted signal ⇒ no critic calls (checked 0).
 */

import { describe, expect, it } from "bun:test"
import type { EditTarget, OwnerCritic, RefuteResult } from "@/agent/observation/critic"
import { maybeCriticRefute } from "@/runner/batch/eval/driver/repair-phase"

const PATCH = `diff --git a/requests/models.py b/requests/models.py
--- a/requests/models.py
+++ b/requests/models.py
@@ -400,4 +400,5 @@ def prepare_url(self, url, params):
     host = parsed.hostname
+    if not host:
         raise InvalidURL("URL has no host")
     return host
`
// This patch parses to exactly one (file, symbol): requests/models.py × prepare_url.

/** Fake critic: fixed verdict + records every call. */
const fakeCritic = (verdict: RefuteResult): { critic: OwnerCritic; calls: EditTarget[] } => {
  const calls: EditTarget[] = []
  return {
    calls,
    critic: {
      refute: async (edited: EditTarget): Promise<RefuteResult> => {
        calls.push(edited)
        return verdict
      },
    },
  }
}

const base = {
  patch: PATCH,
  cwd: "/repo",
  issueText: "url with no host raises the wrong error",
  signal: new AbortController().signal,
}

describe("maybeCriticRefute — observe-only wiring", () => {
  it("default-OFF ⇒ undefined (byte-identical Phase; critic never constructed)", async () => {
    const { critic, calls } = fakeCritic({ verdict: "refuted", reason: "x" })
    const out = await maybeCriticRefute({ ...base, enabled: false, critic })
    expect(out).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("empty patch ⇒ undefined", async () => {
    const { critic } = fakeCritic({ verdict: "refuted", reason: "x" })
    expect(await maybeCriticRefute({ ...base, patch: "", enabled: true, critic })).toBeUndefined()
  })

  it("records a refuted verdict; checks every (file × symbol)", async () => {
    const { critic, calls } = fakeCritic({ verdict: "refuted", reason: "unreachable" })
    const out = await maybeCriticRefute({ ...base, enabled: true, critic })
    expect(out).toEqual({
      checked: 1,
      refuted: [{ file: "requests/models.py", symbol: "prepare_url", reason: "unreachable" }],
    })
    expect(calls).toEqual([{ file: "requests/models.py", symbol: "prepare_url" }])
  })

  it("non-vacuous: not_refuted / inconclusive are CHECKED but NOT recorded", async () => {
    for (const verdict of [
      { verdict: "not_refuted" } as const,
      { verdict: "inconclusive", reason: "dynamic dispatch" } as const,
    ]) {
      const { critic, calls } = fakeCritic(verdict)
      const out = await maybeCriticRefute({ ...base, enabled: true, critic })
      expect(out).toEqual({ checked: 1, refuted: [] })
      expect(calls).toHaveLength(1) // the critic WAS consulted (not a silent skip)
    }
  })

  it("FAIL-OPEN: a throwing critic ⇒ undefined, never propagates", async () => {
    const throwing: OwnerCritic = {
      refute: async (): Promise<RefuteResult> => {
        throw new Error("engine blew up")
      },
    }
    const out = await maybeCriticRefute({ ...base, enabled: true, critic: throwing })
    expect(out).toBeUndefined() // the repair phase is unaffected by a critic failure
  })

  it("an already-aborted signal ⇒ no critic calls (checked 0)", async () => {
    const ac = new AbortController()
    ac.abort()
    const { critic, calls } = fakeCritic({ verdict: "refuted", reason: "x" })
    const out = await maybeCriticRefute({ ...base, enabled: true, signal: ac.signal, critic })
    expect(out).toEqual({ checked: 0, refuted: [] })
    expect(calls).toHaveLength(0)
  })
})
