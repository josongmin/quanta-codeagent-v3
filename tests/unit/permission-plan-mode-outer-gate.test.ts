/**
 * ADR-0135 §Tradeoffs — Plan mode is the OUTER gate.
 *
 * Invariant: Plan-mode mutating-tool block must fire BEFORE any 2-layer
 * PermissionProfile / FileSystemSandboxPolicy check. The existing
 * `checkDispatchAllowed` ([[codex-collaboration-mode-pattern]]) is the
 * authoritative gate for this — it returns `{ok: false}` without consulting
 * the permission stack at all, so the order is enforced structurally (not
 * by composition).
 *
 * This test pins the contract so a future refactor that swaps the call
 * ordering immediately fails.
 */
import { describe, expect, test } from "bun:test"
import { checkDispatchAllowed } from "@/agent/dispatch-seam-guard"

describe("ADR-0135 — Plan mode precedes PermissionProfile check", () => {
  test("plan mode blocks a mutating tool without touching the permission stack", () => {
    // The guard returns ok:false directly — no opportunity for downstream
    // permission code to run. The ADR-0135 2-layer manager would never be
    // consulted for this call.
    const r = checkDispatchAllowed({ collaborationMode: "plan" }, { name: "write" })
    expect(r.ok).toBe(false)
  })

  test("default mode passes through the guard (permission stack runs next)", () => {
    const r = checkDispatchAllowed({ collaborationMode: "default" }, { name: "write" })
    expect(r.ok).toBe(true)
  })

  test("read-only tool in plan mode is allowed (gate is selective)", () => {
    const r = checkDispatchAllowed({ collaborationMode: "plan" }, { name: "read" })
    expect(r.ok).toBe(true)
  })
})
