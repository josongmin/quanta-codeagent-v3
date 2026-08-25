/**
 * ★ HELLGATE — the web-daemon transcript-persist DURABLE objective snapshot reads
 * the SESSION-STABLE authority, DECOUPLED from observability (RFC-03 C2 follow-on
 * to the GAP1 per-turn decoupling in `web-daemon-objective-session-stability`).
 *
 * THE RESIDUAL GAP (post-GAP1): GAP1 minted the ONE session-stable objective
 * authority at the factory under `QUANTA_OBJECTIVE_TOOLS` alone and threaded it
 * onto `base.objective` (per-turn goal works with observability OFF). BUT the
 * transcript-persist snapshot (`webObjectiveSnapshot`) still duck-read the
 * OBSERVABILITY-gated FACADE getter `runtime.objective` — which
 * `attachObservabilityPorts` proxies off the observability wire handle and which
 * reads `undefined` whenever `QUANTA_OBSERVABILITY` is off. So with TOOLS=1 +
 * OBSERVABILITY off, the live goal existed on the authority but the durable
 * snapshot encoded NOTHING ⇒ the transcript persisted no objective ⇒ goal not
 * durably saved.
 *
 * THE FIX: the factory exposes the session-stable authority on a NON-obs, plain
 * value getter `facade.objectiveAuthority` (the SAME instance on `base.objective`
 * and — when obs is on — the SAME instance the obs handle proxies). The server's
 * `webObjectiveSnapshot` reads THAT field, not the obs-gated `objective` getter,
 * so the goal persists whenever TOOLS is on regardless of observability — and
 * reading a plain value getter emits NO observability frame (obs stream
 * byte-identical).
 *
 * RED-on-injection (captured): revert `server.ts` `webObjectiveSnapshot` to read
 * `runtime.objective` (the obs getter) ⇒ [P1] flips (snapshot undefined under
 * obs-off) and [P3] flips (nothing persists to disk). Captured RED.
 *
 * Invariants proven:
 *   [P1] TOOLS on, OBSERVABILITY OFF ⇒ `webObjectiveSnapshot(facade)()` encodes
 *        the live goal (RED on unfixed: undefined).
 *   [P2] the persistence field is the SAME instance as `base.objective` / the
 *        per-turn authority — one authority, no third mint.
 *   [P3] end-to-end: a completed turn PERSISTS the goal to the @/session store
 *        with observability OFF (round-trips via `loadSessionById`).
 *   [P4] TOOLS off ⇒ snapshot undefined ⇒ transcript omits `objective`.
 *   [P5] obs byte-identity: with obs OFF the obs-gated `objective` getter is
 *        undefined (no objective frame port) while the persistence field carries
 *        the authority — the two seams are DISTINCT; with obs ON they collapse to
 *        the SAME instance (single authority, no split-brain).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachObservabilityPorts,
  defineOptionalFacadeGetters,
  type ObservableRuntimeFacade,
} from "@/apps/web-daemon/runtime-factory/observable-facade"
import { wireSessionObservability } from "@/apps/web-daemon/runtime-factory/session-observability"
import { _webObjectiveSnapshotForTest as webObjectiveSnapshot } from "@/apps/web-daemon/server"
import { attachTranscriptPersistence } from "@/apps/web-daemon/server/transcript-persist"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import type { Message } from "@/llm"
import type { ObjectivePort } from "@/objective"
import type { SessionEvent } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession } from "@/sdk/runtime"
import { loadSessionById } from "@/session"

const CWD = "/tmp/quanta-web-objective-persist-hellgate"

/** Reconstruct the EXACT production facade wiring the runtime-factory does for
 *  the objective seams: mint the ONE session-stable authority (web has no
 *  `onConfirm` ⇒ `confirmationAvailable:false`), feed the SAME instance into the
 *  obs wire (`attachObservabilityPorts` hangs the obs-gated `objective` getter
 *  off its handle), and expose the authority on the NON-obs persistence getter
 *  (`defineOptionalFacadeGetters` — undefined ⇒ skipped). Returns the facade +
 *  the minted authority so identity can be asserted across all three seams. */
const buildProductionShapedFacade = (
  env: Record<string, string | undefined>,
): { facade: ObservableRuntimeFacade; objective: ObjectivePort | undefined } => {
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  const observability = wireSessionObservability(env, CWD, objective)
  const facade = attachObservabilityPorts({} as RuntimeFacade, observability.handle)
  defineOptionalFacadeGetters(facade, {
    ...(objective !== undefined ? { objectiveAuthority: objective } : {}),
  })
  return { facade, objective }
}

const goalOf = (
  snapshot: ReturnType<NonNullable<ReturnType<typeof webObjectiveSnapshot>>> | undefined,
): string | undefined =>
  // GOAL-01: a live encode is the v2 envelope (`threads[i].objective`); v1 is load-only.
  snapshot?.version === 2 ? snapshot.threads[0]?.objective?.goal : undefined

describe("HELLGATE RFC-03 C2 (web parity) — durable objective snapshot is observability-decoupled", () => {
  test("[P1] TOOLS on, OBSERVABILITY OFF ⇒ webObjectiveSnapshot encodes the live goal (RED on unfixed: undefined)", () => {
    const { facade, objective } = buildProductionShapedFacade({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(objective).toBeDefined()
    objective?.create("thread-1", { goal: "ship the decoupled snapshot" })
    // The obs-gated getter is undefined (obs OFF) — the OLD read would return no
    // provider. The fix reads the persistence field instead.
    expect((facade as { objective?: unknown }).objective).toBeUndefined()
    const provider = webObjectiveSnapshot(facade)
    expect(provider).toBeDefined()
    expect(goalOf(provider?.())).toBe("ship the decoupled snapshot")
  })

  test("[P2] the persistence field is the SAME instance as the minted authority (no third mint)", () => {
    const { facade, objective } = buildProductionShapedFacade({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(objective).toBeDefined()
    // `facade.objectiveAuthority` IS the session-stable authority the factory also
    // threads onto `base.objective` (the per-turn authority). Same object.
    expect((facade as { objectiveAuthority?: ObjectivePort }).objectiveAuthority).toBe(objective)
  })

  test("[P3] end-to-end: a completed turn PERSISTS the goal to the @/session store with obs OFF", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-obj-persist-"))
    try {
      const { facade, objective } = buildProductionShapedFacade({ QUANTA_OBJECTIVE_TOOLS: "1" })
      objective?.create("thread-1", { goal: "durably remembered goal" })

      // A minimal RuntimeSession exposing the persistence wire's read seams,
      // mirroring the transcript-persist hellgate's fakeSession.
      const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] } as never]
      const subs: ((e: SessionEvent) => void)[] = []
      const session = {
        sessionId: "web-obj-1",
        subscribe: (cb: (e: SessionEvent) => void) => {
          subs.push(cb)
          return () => undefined
        },
        transcript: { messages: () => msgs, replace: async () => ({}) as never },
      } as unknown as RuntimeSession

      const wire = attachTranscriptPersistence(session, {
        enabled: true,
        rootProvider: { resolve: async () => root },
        cwd: "/repo",
        // The EXACT server wiring: the snapshot provider is derived from the facade.
        objectiveSnapshot: webObjectiveSnapshot(facade),
      })
      // Emit a completed turn — the persist subscription fires.
      const turn: SessionEvent = {
        type: "turn.completed",
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: 0,
      } as never
      for (const s of subs) s(turn)
      await wire.flush()

      const saved = await loadSessionById("web-obj-1", { resolve: async () => root })
      expect(saved).toBeDefined()
      // The durable objective survived even though observability was OFF.
      // GOAL-01: the persisted snapshot is the v2 envelope (`threads[i].objective`).
      expect(saved?.objective?.version).toBe(2)
      const persisted =
        saved?.objective?.version === 2 ? saved.objective.threads[0]?.objective : undefined
      expect(persisted?.goal).toBe("durably remembered goal")
      wire.unsub()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[P4] TOOLS off ⇒ snapshot provider undefined (paired control; transcript omits objective)", () => {
    const { facade, objective } = buildProductionShapedFacade({})
    expect(objective).toBeUndefined()
    expect((facade as { objectiveAuthority?: unknown }).objectiveAuthority).toBeUndefined()
    expect(webObjectiveSnapshot(facade)).toBeUndefined()
  })

  test("[P5] obs byte-identity: obs-gated getter distinct from persistence field (OFF distinct, ON collapse)", () => {
    // OBSERVABILITY OFF: the obs emitter reads `facade.objective` (undefined ⇒ no
    // objective frame port); the persistence field carries the authority. Distinct.
    const off = buildProductionShapedFacade({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect((off.facade as { objective?: unknown }).objective).toBeUndefined()
    expect((off.facade as { objectiveAuthority?: unknown }).objectiveAuthority).toBe(off.objective)

    // OBSERVABILITY ON: the SAME instance backs the obs getter AND the persistence
    // field (single authority, no split-brain).
    const on = buildProductionShapedFacade({
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_OBSERVABILITY: "on",
    })
    expect((on.facade as { objective?: unknown }).objective).toBe(on.objective)
    expect((on.facade as { objectiveAuthority?: unknown }).objectiveAuthority).toBe(on.objective)
    expect((on.facade as { objective?: unknown }).objective).toBe(
      (on.facade as { objectiveAuthority?: unknown }).objectiveAuthority,
    )
  })
})
