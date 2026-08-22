/**
 * HELLGATE — per-host `custom` mode must FAIL-CLOSED in `evaluateStack`
 * (T6-permission audit, policy.ts:396).
 *
 * Threat model: an operator pins a remote host to `custom` — a deliberate
 * "this host needs a bespoke per-host policy, restrict me until it's wired"
 * marker. The PRE-fix code resolved the host axis through the legacy boolean
 * adapter `hostAllowsMutation`, which collapsed `custom` (a `defer` verdict)
 * into the SAME `undefined` as `unpinned`. `undefined` falls through to the
 * global default `evaluate()`, which returns `allow` under `bypass` and
 * `acceptEdits`. Net effect: a host an operator explicitly marked for tighter
 * control became IMPLICITLY fully writable the moment the agent ran in a
 * batch-approval mode — the exact inversion of the operator's intent.
 *
 * The fix branches on the TYPED `hostMutationVerdict`: `defer` (custom) is an
 * explicit fail-closed `deny` until a bespoke policy resolver lands. These
 * adversarial cases lock that in across EVERY mode (incl. the two that used
 * to leak), and a control case proves an UNPINNED host still falls through to
 * the global default (no over-correction).
 *
 * Sibling of tests/unit/permission-per-thread.test.ts (`evaluateStack —
 * precedence ordering`) — same isolated-store-per-test discipline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPermissionStore,
  evaluateStack,
  type PermissionMode,
  type PermissionStore,
  setHostMode,
} from "@/permission"

let tmp: string
let store: PermissionStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-perm-host-custom-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(async () => {
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

const mutatingAction = {
  tool: "edit",
  input: { path: "x" },
  isReadOnly: false,
}

const stackCtx = {
  threadId: "t-custom",
  hostId: "remote-host",
  actionSignature: "deadbeefdeadbeefdeadbeefdeadbeef",
  workdir: "/repo",
}

describe("evaluateStack — per-host `custom` fails CLOSED (no implicit allow)", () => {
  // The two modes that USED to leak: the global-default `evaluate()` returns
  // `allow` for a mutating action under bypass/acceptEdits, so a `custom`
  // host that fell through was silently fully writable. These must DENY.
  for (const mode of ["bypass", "acceptEdits"] as const) {
    test(`custom host DENIES a mutating action under '${mode}' (regression: was implicit allow)`, () => {
      setHostMode(stackCtx.hostId, "custom", store)
      const d = evaluateStack(mutatingAction, { mode }, stackCtx, { store })
      expect(d.kind).toBe("deny")
      // It must be the per-host axis that denies — NOT a fall-through to the
      // global default (which would have allowed under these modes).
      if (d.kind === "deny") {
        expect(d.reason).toContain("custom")
      }
    })
  }

  // And it must also deny (never allow / never silently ask via fall-through)
  // under the remaining modes — `custom` is a fail-closed deny, full stop.
  for (const mode of ["default", "auto"] as const) {
    test(`custom host DENIES a mutating action under '${mode}'`, () => {
      setHostMode(stackCtx.hostId, "custom", store)
      const d = evaluateStack(mutatingAction, { mode }, stackCtx, { store })
      expect(d.kind).toBe("deny")
    })
  }

  test("custom host still ALLOWS a read-only action (read-only bypass precedes the host axis)", () => {
    setHostMode(stackCtx.hostId, "custom", store)
    const d = evaluateStack(
      { tool: "read", input: {}, isReadOnly: true },
      { mode: "bypass" },
      stackCtx,
      { store },
    )
    expect(d.kind).toBe("allow")
  })

  // Control / no-over-correction: an UNPINNED host (no setHostMode call) must
  // STILL fall through to the global default — the fix must not turn the
  // legitimate `unpinned` fall-through into a deny.
  test("unpinned host falls through to global default (allow under bypass)", () => {
    const d = evaluateStack(mutatingAction, { mode: "bypass" }, stackCtx, { store })
    expect(d.kind).toBe("allow")
  })

  test("unpinned host falls through to global default (ask under default)", () => {
    const d = evaluateStack(mutatingAction, { mode: "default" }, stackCtx, { store })
    expect(d.kind).toBe("ask")
  })

  // The two legitimate non-custom pins keep their behavior.
  const pinned: ReadonlyArray<{
    mode: "read-only" | "full-access"
    runMode: PermissionMode
    expected: "deny" | "allow"
  }> = [
    { mode: "read-only", runMode: "bypass", expected: "deny" },
    { mode: "full-access", runMode: "default", expected: "allow" },
  ]
  for (const { mode, runMode, expected } of pinned) {
    test(`pinned '${mode}' host ⇒ ${expected} under '${runMode}' (unchanged by the fix)`, () => {
      setHostMode(stackCtx.hostId, mode, store)
      const d = evaluateStack(mutatingAction, { mode: runMode }, stackCtx, { store })
      expect(d.kind).toBe(expected)
    })
  }
})
