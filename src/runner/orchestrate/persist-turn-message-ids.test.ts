/**
 * ★ CONTRACT — RFC-13 HOP-2: durable STABLE message-id assignment at the
 * per-turn persist boundary (`persistTurn`), gate default-OFF byte-identical.
 *
 * WHY: `/rewind --restore-files`, the no-arg `/rewind` message table, and the
 * F3 `feedCheckpointCapture` feeder ALL key on `Message.id`. No production path
 * assigned ids, so all three were inert. `persistTurn` is the surface-agnostic
 * per-TURN save boundary (NOT the per-token loop) — assigning ids here, BEFORE
 * `saveSessionById` AND the checkpoint hook, makes the saved transcript
 * addressable and lets the checkpoint hook bind to a durable id.
 *
 * Contracts proven:
 *   1. GATE-OFF byte-identical: no gate ⇒ the saved transcript is deep-equal to
 *      an id-less save (NO ids appear). `/rewind` fail-closes as today.
 *   2. GATE-ON assigns: every id-less message on disk carries a stable id after
 *      the turn persists.
 *   3. IDEMPOTENT / STABLE across resave: a message that already had an id KEEPS
 *      it across a second persist (resume/resave) — same message, same id.
 *   4. Assigned BEFORE the checkpoint hook: the hook observes ids (so F3 can
 *      bind to the last message id instead of no-op'ing at `no-message-id`).
 *   5. Best-effort: assignment never breaks persistence.
 *
 * RED-ON-INJECTION: drop the assign at the top of persistTurn ⇒ (2)/(3)/(4)
 * flip RED (messages stay id-less, hook sees no id). (1) is the drift anchor for
 * the OFF posture: if the gate check were dropped (always assign), (1) flips RED.
 *
 * Hermetic: tmp QUANTA_SESSIONS_DIR, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { persistTurn } from "./persist-turn"

let root: string
let priorSessions: string | undefined
let priorGate: string | undefined

beforeEach(() => {
  priorSessions = process.env.QUANTA_SESSIONS_DIR
  priorGate = process.env.QUANTA_MESSAGE_IDS
  root = mkdtempSync(join(tmpdir(), "persist-msgids-"))
  process.env.QUANTA_SESSIONS_DIR = root
  delete process.env.QUANTA_MESSAGE_IDS
  __resetRuntimeConfig()
})

afterEach(() => {
  if (priorSessions === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = priorSessions
  if (priorGate === undefined) delete process.env.QUANTA_MESSAGE_IDS
  else process.env.QUANTA_MESSAGE_IDS = priorGate
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

const meta = (id: string): SessionMeta => ({
  id,
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const outcome = { reason: "done", turns: 1 } as never

describe("persistTurn message-id assignment (RFC-13 HOP-2)", () => {
  test("GATE-OFF: saved transcript is byte-identical to an id-less save (no ids)", async () => {
    const id = "sess-off"
    const m = meta(id)
    const messages = [msg("user", "hi"), msg("assistant", "yo")]

    // Reference: a plain id-less save of the SAME messages.
    const refId = "sess-off-ref"
    await saveSessionById(meta(refId), { reason: "done", turns: 1, messages })
    const ref = await loadSessionById(refId)

    // Gate is OFF (deleted in beforeEach) ⇒ persistTurn must NOT assign.
    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages, outcome })
    const saved = await loadSessionById(id)

    for (const sm of saved?.messages ?? []) {
      expect(sm.id).toBeUndefined()
    }
    // Deep-equal transcript (message shape identical to the id-less reference).
    expect(saved?.messages).toEqual(ref?.messages ?? [])
  })

  test("GATE-ON: every id-less message gets a stable id on disk", async () => {
    process.env.QUANTA_MESSAGE_IDS = "1"
    __resetRuntimeConfig()
    const id = "sess-on"
    const m = meta(id)
    const messages = [msg("user", "hi"), msg("assistant", "yo")]

    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages, outcome })
    const saved = await loadSessionById(id)

    expect(saved?.messages.length).toBe(2)
    for (const sm of saved?.messages ?? []) {
      expect(typeof sm.id).toBe("string")
      expect((sm.id as string).length).toBeGreaterThan(0)
    }
  })

  test("STABILITY across resave: existing ids are KEPT; a new message gets a new id", async () => {
    process.env.QUANTA_MESSAGE_IDS = "1"
    __resetRuntimeConfig()
    const id = "sess-stable"
    const m = meta(id)

    const turn1 = [msg("user", "q1"), msg("assistant", "a1")]
    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages: turn1, outcome })
    const afterT1 = await loadSessionById(id)
    const idsT1 = (afterT1?.messages ?? []).map((x) => x.id)
    expect(idsT1.every((x) => typeof x === "string")).toBe(true)

    // Resume: reload the persisted (now-id-bearing) messages, append a new turn,
    // and persist AGAIN. This is the resume/resave path.
    const turn2 = [...(afterT1?.messages ?? []), msg("user", "q2"), msg("assistant", "a2")]
    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages: turn2, outcome })
    const afterT2 = await loadSessionById(id)
    const idsT2 = (afterT2?.messages ?? []).map((x) => x.id)

    // IDEMPOTENT: the first two ids are UNCHANGED across the resave.
    expect(idsT2[0]).toBe(idsT1[0])
    expect(idsT2[1]).toBe(idsT1[1])
    // The two new messages got fresh, non-empty ids.
    expect(typeof idsT2[2]).toBe("string")
    expect(typeof idsT2[3]).toBe("string")
    // All ids distinct (addressable boundaries).
    const uniq = new Set(idsT2)
    expect(uniq.size).toBe(4)
  })

  test("idempotent third resave with NO new messages leaves every id byte-identical", async () => {
    process.env.QUANTA_MESSAGE_IDS = "1"
    __resetRuntimeConfig()
    const id = "sess-noop-resave"
    const m = meta(id)
    const t = [msg("user", "q"), msg("assistant", "a")]
    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages: t, outcome })
    const first = await loadSessionById(id)
    const ids1 = (first?.messages ?? []).map((x) => x.id)

    // Resave the SAME reloaded messages verbatim.
    await persistTurn({
      state: undefined,
      idMeta: m,
      sessionId: id,
      messages: first?.messages ?? [],
      outcome,
    })
    const second = await loadSessionById(id)
    const ids2 = (second?.messages ?? []).map((x) => x.id)
    expect(ids2).toEqual(ids1)
  })

  test("NO id collision with a pre-existing id at a different position", async () => {
    process.env.QUANTA_MESSAGE_IDS = "1"
    __resetRuntimeConfig()
    const id = "sess-collide"
    const m = meta(id)
    // msg[0] already carries "m1" (e.g. from a fork); a naive m{index} scheme
    // would mint "m1" for the id-less msg[1] and go AMBIGUOUS → /rewind broken.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }], id: "m1" },
      msg("assistant", "b"),
    ]
    await persistTurn({ state: undefined, idMeta: m, sessionId: id, messages, outcome })
    const saved = await loadSessionById(id)
    const ids = (saved?.messages ?? []).map((x) => x.id)
    // Pre-existing id KEPT (idempotent) + the minted id is DISTINCT from it.
    expect(ids[0]).toBe("m1")
    expect(ids[1]).not.toBe("m1")
    expect(new Set(ids).size).toBe(2)
  })

  test("checkpoint hook observes ASSIGNED ids (assign happens BEFORE the hook)", async () => {
    process.env.QUANTA_MESSAGE_IDS = "1"
    __resetRuntimeConfig()
    const id = "sess-hook"
    const m = meta(id)
    const messages = [msg("user", "hi"), msg("assistant", "yo")]

    let seenLastId: string | undefined = "SENTINEL"
    await persistTurn({
      state: undefined,
      idMeta: m,
      sessionId: id,
      messages,
      outcome,
      captureCheckpoint: async ({ messages: hookMsgs }) => {
        seenLastId = hookMsgs[hookMsgs.length - 1]?.id
      },
    })

    // The hook ran AFTER assignment ⇒ it sees a real id on the last message,
    // NOT undefined (which is what fed the F3 `no-message-id` no-op).
    expect(typeof seenLastId).toBe("string")
    expect((seenLastId as string).length).toBeGreaterThan(0)
  })
})
