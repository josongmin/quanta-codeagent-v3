/**
 * ADR-0303 — `shift+tab` permission-posture authority hellgate.
 *
 * Pins the fix for the §3.1 "a slash-only mirror is not authority" violation:
 * the CLI mode-cycle's permission posture used to live ONLY in a slash-local
 * store (`apps/cli/mode-cycle.ts`) that the runtime read once at
 * `createSession`, so a mid-session `shift+tab` applied to the NEXT session, not
 * the next turn. The fix makes the engine the authority via an engine-owned
 * `PermissionModeSessionState` that backs `permission.mode` as an accessor and
 * is synced per-turn.
 *
 * Two layers of guard:
 *   1. BEHAVIORAL — the accessor-backed permission (mirroring bootstrap) reads
 *      the engine cell LIVE, including a per-turn spread taken after a mutation.
 *   2. STRUCTURAL — the wiring is present end-to-end (bootstrap accessor →
 *      snapshot → RuntimeContext accessor → per-turn sync in the CLI loop). A
 *      refactor that reverts any leg to a static `{ mode }` mirror trips here.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PermissionContext } from "@/permission"
import { createPermissionModeSessionState } from "@/runner/assemble"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("mode-cycle permission authority hellgate (ADR-0303)", () => {
  test("engine cell backs permission.mode as a LIVE accessor (next-turn authority)", () => {
    // Mirror exactly what bootstrap-session.ts constructs.
    const state = createPermissionModeSessionState({ defaultMode: "default" })
    const permission: PermissionContext = {
      get mode() {
        return state.get()
      },
      set mode(next) {
        state.set(next)
      },
    }

    expect(permission.mode).toBe("default")

    // A mid-session shift+tab mutates the engine cell...
    state.set("acceptEdits")
    // ...and every existing reader of `permission.mode` observes it live.
    expect(permission.mode).toBe("acceptEdits")

    // The per-turn base is produced by spreading `permission` into the turn
    // config (`...rest` in context-binding). A spread taken AFTER the mutation
    // must carry the NEW mode — this is the "applies on the next turn" property.
    state.set("bypass")
    const perTurn = { ...permission }
    expect(perTurn.mode).toBe("bypass")

    // Writing through the accessor also routes to the engine cell (so any code
    // that assigns `permission.mode = x` stays authoritative).
    permission.mode = "default"
    expect(state.get()).toBe("default")
  })

  test("bootstrap builds permission as an accessor over the engine cell, not a static mirror", () => {
    const src = read("src/host/bootstrap/bootstrap-session.ts")
    expect(src).toContain("createPermissionModeSessionState({ defaultMode: runtime.mode })")
    // accessor-backed, not a frozen `{ mode: runtime.mode }` snapshot
    expect(src).toContain("get mode()")
    expect(src).toContain("set mode(next)")
    // the cell is returned on the bootstrap result so the runtime can wire it
    expect(src).toMatch(/permission,\s*\n\s*permissionModeState,/)
  })

  test("permissionModeState is threaded through snapshot + exposed on RuntimeContext", () => {
    const binding = read("src/host/runtime/internal/context-binding.ts")
    // boot → base and base → snapshot legs
    expect(binding).toContain('whenDefined("permissionModeState", args.boot.permissionModeState)')
    expect(binding).toContain('whenDefined("permissionModeState", base.permissionModeState)')

    const ctx = read("src/sdk/runtime/context.ts")
    expect(ctx).toContain("permissionModeState(): RuntimeContextPermissionModeStateView")
    expect(ctx).toContain(
      "permissionModeState: () => record.state.snapshot.permissionModeState",
    )
  })

  test("CLI loop syncs the mode-cycle posture into the engine cell before each turn", () => {
    const loop = read("src/apps/cli/repl/session-loop.ts")
    // The per-turn sync runs as the `beforeTurn` host hook handed to the shared
    // runner-owned driver (ADR-0303 hoist): read the slash-local mode-cycle,
    // write the engine-owned permissionModeState BEFORE the turn. Assert the
    // behavior (engine cell set from the cycle's permissionMode), not the exact
    // local variable name.
    expect(loop).toContain("runtimeContext.permissionModeState()?.set(")
    expect(loop).toContain(".current().permissionMode)")
    expect(loop).toContain("beforeTurn")
  })
})
