import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSavedSessionRollbackStore,
  executeRollback,
  resumePendingRollback,
} from "@/agent/thread-rollback"
import type { Message } from "@/llm"
import {
  appendEnvelope,
  assignMessageIds,
  type EventMsgRecord,
  iterateSessionFile,
  latestOperation,
  loadSessionById,
  pendingOperationIds,
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  rewindToMessage,
  type SavePayload,
  SESSION_ENVELOPE_VERSION,
  type SessionMeta,
  saveSessionById,
  sessionEnvelopePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * End-to-end coverage for the message-granularity rewind UX (Claude Desktop
 * 1.7196.3 parity).
 *
 * Locks in:
 *   - Round-trip: save → assignMessageIds → rewindToMessage → loadSessionById
 *     returns the expected truncated transcript.
 *   - The JSONL envelope log is NOT touched by rewind (phase-A scope) — the
 *     append-only rail keeps its event log intact, and replay/reconciliation
 *     stays the consumer's job.
 *
 * Phase scope note: rewind only truncates the snapshot JSON. Envelope-log
 * truncation (turn_context / event_msg / response_item shadow-removal for
 * post-rewind turn_ids) is deferred — the JSONL stays append-only so any
 * external replay can intersect it with the post-rewind snapshot.
 */

const isoAt = (sec: number): string => new Date(1_716_000_000_000 + sec * 1000).toISOString()

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-rewind-e2e",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

describe("session-rewind-e2e", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-rewind-e2e-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("save 5 messages, rewind to messages[2], reload yields 3 messages", async () => {
    const raw: Message[] = [
      { role: "user", content: [{ type: "text", text: "m0" }] },
      { role: "assistant", content: [{ type: "text", text: "m1" }] },
      { role: "user", content: [{ type: "text", text: "m2" }] },
      { role: "assistant", content: [{ type: "text", text: "m3" }] },
      { role: "user", content: [{ type: "text", text: "m4" }] },
    ]
    // assignMessageIds is the canonical seam for new-session id minting.
    const withIds = assignMessageIds(raw, (i) => `mid-${i}`)
    const meta = mkMeta({ id: "rewind-roundtrip" })
    const payload: SavePayload = { reason: "ok", turns: 1, messages: withIds }
    await saveSessionById(meta, payload)

    const targetId = withIds[2]?.id
    if (typeof targetId !== "string") throw new Error("test setup: expected id at index 2")
    const result = await rewindToMessage("rewind-roundtrip", targetId)
    expect(result.removed).toBe(2)

    const reloaded = await loadSessionById("rewind-roundtrip")
    expect(reloaded).toBeDefined()
    expect(reloaded?.messages.length).toBe(3)
    const ids = reloaded?.messages.map((m) => (m as Message & { id?: string }).id)
    expect(ids).toEqual(["mid-0", "mid-1", "mid-2"])
    // Text payload also preserved (no body mutation).
    const last = reloaded?.messages[2]
    if (last === undefined) throw new Error("expected reloaded[2]")
    const lastBlock = last.content[0]
    if (lastBlock === undefined || lastBlock.type !== "text") {
      throw new Error("expected text block")
    }
    expect(lastBlock.text).toBe("m2")
    // lastTouched was bumped relative to the original.
    expect((reloaded?.meta.lastTouched ?? 0) >= 1_000).toBe(true)
  })

  test("envelope JSONL is NOT truncated by rewind (phase-A scope)", async () => {
    // Setup: write 4 envelope events spanning 4 turns.
    const sessionId = "rewind-envelope-untouched"
    const events: EventMsgRecord[] = []
    for (let i = 0; i < 4; i += 1) {
      const ev: EventMsgRecord = {
        type: "event_msg",
        schema_version: SESSION_ENVELOPE_VERSION,
        ts: isoAt(i),
        turn_id: `t-${i}`,
        kind: "token_count",
        input_tokens: i,
        output_tokens: i * 2,
      }
      events.push(ev)
      await appendEnvelope(sessionId, ev)
    }

    // And a snapshot with 5 ided messages.
    const withIds = assignMessageIds(
      [
        { role: "user", content: [{ type: "text", text: "m0" }] },
        { role: "assistant", content: [{ type: "text", text: "m1" }] },
        { role: "user", content: [{ type: "text", text: "m2" }] },
        { role: "assistant", content: [{ type: "text", text: "m3" }] },
        { role: "user", content: [{ type: "text", text: "m4" }] },
      ],
      (i) => `mid-${i}`,
    )
    await saveSessionById(mkMeta({ id: sessionId }), {
      reason: "ok",
      turns: 4,
      messages: withIds,
    })

    const result = await rewindToMessage(sessionId, "mid-1")
    expect(result.removed).toBe(3)

    // Snapshot truncated correctly.
    const reloaded = await loadSessionById(sessionId)
    expect(reloaded?.messages.length).toBe(2)

    // Envelope log is intact — append-only invariant preserved.
    const path = sessionEnvelopePath(sessionId)
    let count = 0
    for await (const r of iterateSessionFile(path)) {
      expect(r.ok).toBe(true)
      count += 1
    }
    expect(count).toBe(4)
  })

  test("rewind on a session without ids yields removed=0 (byte-identical default-OFF)", async () => {
    // Sessions that pre-date the id-rewind feature have id-less messages on
    // disk. `rewindToMessage` MUST treat them as a no-op so legacy files are
    // never silently mutated.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]
    await saveSessionById(mkMeta({ id: "legacy-noid" }), {
      reason: "ok",
      turns: 1,
      messages,
    })
    const result = await rewindToMessage("legacy-noid", "any-id")
    expect(result.removed).toBe(0)
    const reloaded = await loadSessionById("legacy-noid")
    expect(reloaded?.messages.length).toBe(2)
  })
})

/* ================================================================== */
/* RFC01-3 — ThreadRollback effect saga (aug-02 absorption)            */
/*                                                                     */
/* Drives the REAL `@/agent` coordinator over the REAL SavedSession    */
/* atomic snapshot store (`createSavedSessionRollbackStore`) against a  */
/* tmp QUANTA_SESSIONS_DIR, with a fake effect port + fake clock. The  */
/* four fixtures are admission tests: crash-after-intent,              */
/* crash-after-effect (before terminal), conflict, duplicate submit.   */
/* ================================================================== */

describe("thread-rollback saga — durable crash matrix (RFC01-3)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thread-rollback-e2e-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  const CP: RollbackCheckpointRecord = {
    recordVersion: ROLLBACK_RECORD_VERSION,
    turnId: "turn-1",
    messageId: "m1",
    checkpointSha: "a".repeat(40),
    expectedFileHashes: { "src/a.ts": "h1" },
  }

  /** Seed a session that already carries a durable checkpoint mapping. */
  const seedSession = async (id: string): Promise<void> => {
    await saveSessionById(mkMeta({ id }), {
      reason: "ok",
      turns: 1,
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
      rollbackCheckpoints: [CP],
    })
  }

  let clock = 1_000
  const now = () => clock++
  const store = () => createSavedSessionRollbackStore()

  test("happy path: requested→effect→rolled_back, effect called once, receipt durable", async () => {
    await seedSession("rb-happy")
    let effectCalls = 0
    const out = await executeRollback(
      {
        store: store(),
        effect: {
          restoreToCheckpoint: async () => {
            effectCalls += 1
            return { ok: true }
          },
        },
        now,
      },
      { sessionId: "rb-happy", operationId: "op-1", targetTurnId: "turn-1" },
    )
    expect(out.kind).toBe("rolled_back")
    expect(effectCalls).toBe(1)
    // Durable receipt: reload from disk shows intent + terminal, op no longer pending.
    const reloaded = await loadSessionById("rb-happy")
    const ops = reloaded?.rollbackOperations ?? []
    expect(latestOperation(ops, "op-1")?.state).toBe("rolled_back")
    expect(pendingOperationIds(ops)).toEqual([])
  })

  // CRASH AFTER INTENT (and, identically, after effect but before the terminal
  // receipt): the durable state is a pending `requested` intent with NO
  // terminal. A re-invocation must NOT auto-succeed or blind-retry — it surfaces
  // `recovery_required`.
  test("crash after intent (no terminal) ⇒ re-invoke surfaces recovery_required, NOT success", async () => {
    await seedSession("rb-crash")
    // Simulate the crash: persist ONLY the `requested` intent, then die.
    await store().saveOperations("rb-crash", [
      {
        recordVersion: ROLLBACK_RECORD_VERSION,
        operationId: "op-crash",
        targetTurnId: "turn-1",
        state: "requested",
        requestedAt: 500,
      },
    ])
    // Restart: the pending op is visible on disk.
    const reloaded = await loadSessionById("rb-crash")
    expect(pendingOperationIds(reloaded?.rollbackOperations ?? [])).toEqual(["op-crash"])

    // A naive re-run of the SAME operation must refuse to auto-succeed.
    let effectCalls = 0
    const out = await executeRollback(
      {
        store: store(),
        effect: {
          restoreToCheckpoint: async () => {
            effectCalls += 1
            return { ok: true }
          },
        },
        now,
      },
      { sessionId: "rb-crash", operationId: "op-crash", targetTurnId: "turn-1" },
    )
    expect(out).toEqual({ kind: "recovery_required", operationId: "op-crash" })
    expect(effectCalls).toBe(0) // NO blind retry of the effect
  })

  // Explicit operator recovery DOES re-run the effect and reaches a terminal.
  test("explicit resumePendingRollback runs the effect and writes a terminal receipt", async () => {
    await seedSession("rb-resume")
    await store().saveOperations("rb-resume", [
      {
        recordVersion: ROLLBACK_RECORD_VERSION,
        operationId: "op-r",
        targetTurnId: "turn-1",
        state: "requested",
        requestedAt: 500,
      },
    ])
    let effectCalls = 0
    const out = await resumePendingRollback(
      {
        store: store(),
        effect: {
          restoreToCheckpoint: async () => {
            effectCalls += 1
            return { ok: true }
          },
        },
        now,
      },
      { sessionId: "rb-resume", operationId: "op-r", targetTurnId: "turn-1" },
    )
    expect(out.kind).toBe("rolled_back")
    expect(effectCalls).toBe(1)
    expect(
      pendingOperationIds((await loadSessionById("rb-resume"))?.rollbackOperations ?? []),
    ).toEqual([])
  })

  // CONFLICT: the effect fails (e.g. merge-in-progress) ⇒ terminal
  // `rollback_failed` with the typed code; success is impossible.
  test("restore conflict ⇒ terminal rollback_failed, never rolled_back", async () => {
    await seedSession("rb-conflict")
    const out = await executeRollback(
      {
        store: store(),
        effect: {
          restoreToCheckpoint: async () => ({ ok: false, code: "conflict" }),
        },
        now,
      },
      { sessionId: "rb-conflict", operationId: "op-c", targetTurnId: "turn-1" },
    )
    expect(out.kind).toBe("rollback_failed")
    if (out.kind === "rollback_failed") expect(out.errorCode).toBe("conflict")
    const ops = (await loadSessionById("rb-conflict"))?.rollbackOperations ?? []
    expect(latestOperation(ops, "op-c")?.state).toBe("rollback_failed")
  })

  // DUPLICATE SUBMIT: the same operationId submitted twice runs the effect ONCE
  // and the second call returns the existing terminal receipt.
  test("duplicate operationId submit ⇒ effect runs once, second returns the receipt", async () => {
    await seedSession("rb-dup")
    let effectCalls = 0
    const deps = {
      store: store(),
      effect: {
        restoreToCheckpoint: async () => {
          effectCalls += 1
          return { ok: true } as const
        },
      },
      now,
    }
    const first = await executeRollback(deps, {
      sessionId: "rb-dup",
      operationId: "op-d",
      targetTurnId: "turn-1",
    })
    const second = await executeRollback(deps, {
      sessionId: "rb-dup",
      operationId: "op-d",
      targetTurnId: "turn-1",
    })
    expect(first.kind).toBe("rolled_back")
    expect(second.kind).toBe("rolled_back")
    expect(effectCalls).toBe(1) // idempotent — no second effect
  })

  // MISSING MAPPING: no checkpoint for the target turn ⇒ fail-closed
  // rollback_failed, effect NEVER called (no tree mutation).
  test("missing checkpoint mapping ⇒ rollback_failed, effect never called", async () => {
    await seedSession("rb-nomap")
    let effectCalls = 0
    const out = await executeRollback(
      {
        store: store(),
        effect: {
          restoreToCheckpoint: async () => {
            effectCalls += 1
            return { ok: true }
          },
        },
        now,
      },
      { sessionId: "rb-nomap", operationId: "op-n", targetTurnId: "turn-999" },
    )
    expect(out.kind).toBe("rollback_failed")
    if (out.kind === "rollback_failed") expect(out.errorCode).toBe("missing-checkpoint")
    expect(effectCalls).toBe(0)
  })
})
