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
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { PermissionContext } from "@/permission"
import {
  buildPostureAuthority,
  createPermissionModeAdapter,
  createSeededPosturePersistence,
} from "@/runner/assemble/session-authorities"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")
// The `runSessionLoop` god-fn split (b17ce99aa) moved the per-turn posture-sync
// wiring out of `session-loop.ts` into a `session-loop/*.ts` lane; aggregate the
// entrypoint + every lane so this behavior pin follows the code, not the file.
const SESSION_LOOP_REL = "src/apps/cli/repl/session-loop"
const readSessionLoopAggregate = (): string =>
  [
    `${SESSION_LOOP_REL}.ts`,
    ...readdirSync(join(REPO_ROOT, SESSION_LOOP_REL))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `${SESSION_LOOP_REL}/${f}`),
  ]
    .map(read)
    .join("\n")

/** Drain the delegating adapter's fire-and-forget write chain (a real surface
 *  writes mode before a turn; the durable publish lands across a macrotask). */
const drain = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("mode-cycle permission authority hellgate (ADR-0303 → RFC-05 E3)", () => {
  test("the posture authority backs permission.mode as a LIVE accessor (next-turn authority)", async () => {
    // Mirror exactly what bootstrap-session.ts constructs: the delegating adapter
    // over the durable posture AUTHORITY (E3 retired the standalone mode cell).
    const authority = buildPostureAuthority({
      threadId: "session",
      persistence: createSeededPosturePersistence("session", "default"),
      reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
    })
    const state = createPermissionModeAdapter(authority)
    const permission: PermissionContext = {
      get mode() {
        return state.get()
      },
      set mode(next) {
        state.set(next)
      },
    }

    expect(permission.mode).toBe("default")

    // A mid-session shift+tab delegates to the authority; the change is a durable
    // posture mutation applied before the next turn reads it.
    state.set("acceptEdits")
    await drain()
    // RED-ON-INJECTION: make the adapter `get` return a stale snapshot instead of
    // the authority's live effectiveMode ⇒ this stays "default" ⇒ RED.
    expect(permission.mode).toBe("acceptEdits")
    // The write flowed through the posture revision (not an out-of-band cell).
    expect(authority.read().revision).toBeGreaterThan(0)

    // The per-turn base is produced by spreading `permission` into the turn
    // config (`...rest` in context-binding). A spread taken AFTER the mutation
    // must carry the NEW mode — this is the "applies on the next turn" property.
    state.set("bypass")
    await drain()
    const perTurn = { ...permission }
    expect(perTurn.mode).toBe("bypass")

    // Writing through the accessor also delegates to the authority (so any code
    // that assigns `permission.mode = x` stays authoritative, not a shadow cell).
    permission.mode = "default"
    await drain()
    expect(authority.read().effective.effectiveMode).toBe("default")
  })

  test("bootstrap builds permission as an accessor over the posture authority, not a static mirror", () => {
    const src = read("src/host/bootstrap/bootstrap-session.ts")
    // The mode is owned by the durable authority via the delegating adapter (the
    // `buildLivePermissionModeState` seam) — NOT a standalone
    // `createPermissionModeSessionState` state cell.
    expect(src).toContain("buildLivePermissionModeState(runtime.mode)")
    expect(src).not.toContain("createPermissionModeSessionState")
    // accessor-backed, not a frozen `{ mode: runtime.mode }` snapshot
    expect(src).toContain("get mode()")
    expect(src).toContain("set mode(next)")
    // the adapter is returned on the bootstrap result so the runtime can wire it
    expect(src).toMatch(/permission,\s*\n\s*permissionModeState,/)
  })

  test("permissionModeState is threaded through snapshot + exposed on RuntimeContext", () => {
    const binding = read("src/host/runtime/internal/context-binding/base.ts")
    // boot → base and base → snapshot legs
    expect(binding).toContain('whenDefined("permissionModeState", args.boot.permissionModeState)')
    expect(binding).toContain('whenDefined("permissionModeState", base.permissionModeState)')

    const ctx = read("src/sdk/runtime/context.ts")
    expect(ctx).toContain("permissionModeState(): RuntimeContextPermissionModeStateView")
    expect(ctx).toContain("permissionModeState: () => record.state.snapshot.permissionModeState")
  })

  test("CLI loop syncs the mode-cycle posture into the engine cell before each turn", () => {
    const loop = readSessionLoopAggregate()
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
