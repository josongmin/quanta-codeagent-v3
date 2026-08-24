/**
 * HELLGATE — the web observability objective pane reflects the LIVE session's goal.
 *
 * THE GAP (pre-fix): the emitter reads `objective.get(threadId)` and, absent a
 * threadId, defaults to "default" (observability-emitter DEFAULT_THREAD_ID). But
 * the tools/authority key the objective by config.sessionId === base.sessionId ===
 * sharedSession.sessionId (a per-boot random id), so `objective.get("default")` was
 * always null — the pane showed an EMPTY goal even with a live objective. (Flagged
 * by the cross-surface audit as corroboration of the per-boot-key mismatch.)
 *
 * THE FIX: `bindObjectivePaneThread(config, sessionId)` sets the emitter threadId to
 * the live session key (the SAME key the reopen restore re-keys onto), so the pane
 * reads the domain the tools actually write. Gate OFF (no observabilityPorts) ⇒ the
 * config is returned UNCHANGED (byte-identical, no pane).
 */

import { describe, expect, test } from "bun:test"
import { bindObjectivePaneThread, type WebDaemonServerConfig } from "@/apps/web-daemon/server"

const SESSION = "live-boot-session-id"
const baseConfig = (over: Partial<WebDaemonServerConfig>): WebDaemonServerConfig =>
  ({
    runtimeFactory: async () => ({}) as never,
    sessionConfig: {},
    ...over,
  }) as WebDaemonServerConfig

describe("web objective pane — emitter threadId is the live session key", () => {
  test("observabilityPorts present ⇒ threadId is bound to the session id (pane reads the live goal's key)", () => {
    const cfg = baseConfig({ observabilityPorts: { objective: {} as never } })
    const bound = bindObjectivePaneThread(cfg, SESSION)
    expect(bound.observabilityPorts?.threadId).toBe(SESSION)
    // The other ports are preserved (spread, not replaced).
    expect(bound.observabilityPorts?.objective).toBe(cfg.observabilityPorts?.objective)
  })

  test("RED-on-injection witness: without the bind the pane key would be the emitter default, NOT the session id", () => {
    // The pre-fix config carried no threadId ⇒ the emitter falls back to "default"
    // ≠ the session key the tools write under. The bind is the load-bearing step.
    const cfg = baseConfig({ observabilityPorts: { objective: {} as never } })
    expect(cfg.observabilityPorts?.threadId).toBeUndefined()
    expect(bindObjectivePaneThread(cfg, SESSION).observabilityPorts?.threadId).toBe(SESSION)
  })

  test("GATE OFF (no observabilityPorts) ⇒ config returned UNCHANGED (byte-identical, same reference)", () => {
    const cfg = baseConfig({})
    expect(cfg.observabilityPorts).toBeUndefined()
    // Same reference — no allocation, no behavior change when the obs gate is off.
    expect(bindObjectivePaneThread(cfg, SESSION)).toBe(cfg)
  })
})
