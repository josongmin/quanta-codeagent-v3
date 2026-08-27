/**
 * HELLGATE — the web control-request surface cannot hand itself `bypass`.
 *
 * `web-control-request-port.ts`'s own header states the contract:
 *
 *   "The permission axis is fail-closed at the planner (an explicit allowlist is
 *    REQUIRED — a model-issued `bypass` is never silently honored)."
 *
 * The allowlist was `ALL_PERMISSION_MODES`, i.e. `["default","acceptEdits",
 * "bypass","auto"]` — so the requirement was satisfied by a set that CONTAINS
 * the mode the sentence promises is never honored. Combined with a WS upgrade
 * that validated no `Origin`, a page could open the socket on a tokenless
 * daemon, send `set_permission_mode: "bypass"`, and the next `turn.run`
 * executed tools with approvals off on the user's machine.
 *
 * Fence:
 *   P-1  `bypass` is NOT in the allowlist this composition supplies.
 *   P-2  PAIRED CONTROL — the non-escalating modes ARE, so the fence is not
 *        "supply nothing", which would fail-close the whole axis and silently
 *        retire a shipped feature.
 *   P-3  The allowlist is a SUBSET of the closed SSOT set — it may narrow the
 *        union, never invent a mode the permission layer does not know.
 */

import { describe, expect, test } from "bun:test"
import { createWebControlRequestPort } from "@/apps/web-daemon/web-control-request-port"
import { ALL_PERMISSION_MODES } from "@/permission"

const contextOf = () =>
  createWebControlRequestPort({
    permission: { mode: "default" },
    observe: () => undefined,
  } as never).context

describe("P — the web control-request allowlist excludes privilege escalation", () => {
  test("P-1 `bypass` is not offered", () => {
    expect(contextOf().permissionModes).not.toContain("bypass")
  })

  test("P-2 PAIRED CONTROL — the non-escalating modes are still offered", () => {
    const modes = contextOf().permissionModes ?? []
    expect([...modes].sort()).toEqual(["acceptEdits", "auto", "default"])
  })

  test("P-3 the allowlist only ever NARROWS the closed SSOT set", () => {
    const modes = contextOf().permissionModes ?? []
    const ssot = new Set<string>(ALL_PERMISSION_MODES)
    expect(modes.filter((m) => !ssot.has(m))).toEqual([])
  })
})
