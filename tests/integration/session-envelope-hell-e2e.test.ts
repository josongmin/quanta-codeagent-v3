/**
 * Hell-difficulty E2E for the ADR-0034 session JSONL envelope.
 *
 * Scope (per the prompt):
 *   1. All 5 top-level types in one session file, exact read-back ordering.
 *   2. 17 turn_context fields completeness — every Codex field + v3
 *      extensions round-trip through encode→decode unchanged.
 *   3. Parent → child → grandchild `thread_spawn` chain with id relationships
 *      preserved.
 *   4. Partial line + EOF without trailing newline surfaces malformed line
 *      as `{ ok: false }`, NOT silent skip.
 *   5. Streaming 10,000 records — memory bounded (running counter only),
 *      exact count.
 *   6. Concurrent writers — two `Promise.all` writers each append 500
 *      records to the SAME session, final file has exactly 1000 records,
 *      every line decodable, no torn writes. Run twice for flakiness.
 *   7. Snapshot independence invariant — `.jsonl` and `.json` files exist
 *      independently and neither corrupts the other.
 *
 * Test-isolation contract (see prompt + verify-workflow memory):
 *   - mkdtemp roots only; never `~`.
 *   - In every `beforeEach` re-assert QUANTA_SESSIONS_DIR + call
 *     `__resetRuntimeConfig()` so concurrent suites don't race-corrupt our
 *     reads. (Pre-existing `session-envelope-store-seam.test.ts` uses
 *     beforeAll only — that's the cache race surfaced at full-suite scale.)
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendEnvelope,
  appendSessionLine,
  EnvelopeDecodeError,
  type EventMsgRecord,
  encodeSessionLine,
  iterateSessionFile,
  type ResponseItemRecord,
  SESSION_ENVELOPE_VERSION,
  type SessionEnvelopeRecord,
  type SessionMeta,
  type SessionMetaRecord,
  saveSessionById,
  sessionEnvelopePath,
  sessionFilePath,
  type ThreadSpawnRecord,
  type TurnContextRecord,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const root = mkdtempSync(join(tmpdir(), "e2e-session-envelope-hell-"))

afterAll(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // Re-assert OUR env + reset the cached runtime-config; otherwise concurrent
  // test files in the same Bun process pool race-corrupt sessionsRoot() reads.
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

const isoAt = (sec: number): string => new Date(1_716_000_000_000 + sec * 1000).toISOString()

const buildMeta = (id: string): SessionMetaRecord => ({
  type: "session_meta",
  schema_version: SESSION_ENVELOPE_VERSION,
  session_id: id,
  started_at: isoAt(0),
  cwd: "/tmp",
  cli_version: "0.1.0",
  model: "gpt-5",
})

const buildTurnContext = (turn: string): TurnContextRecord => ({
  type: "turn_context",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: turn,
  cwd: "/tmp",
  current_date: isoAt(0),
  timezone: "America/Los_Angeles",
  approval_policy: "on-request",
  sandbox_policy: "workspace-write",
  permission_profile: "default",
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo",
  realtime_active: false,
  effort: "medium",
  summary: "",
  user_instructions: "",
  truncation_policy: "none",
  parent_thread_id: null,
  thread_role: "root",
})

const buildResponseItem = (turn: string, idx: number): ResponseItemRecord => ({
  type: "response_item",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: turn,
  item_kind: "assistant_text",
  index: idx,
  content: `text-${idx}`,
})

const buildThreadSpawn = (
  parent: string,
  parentTurn: string,
  child: string,
  kind: string,
  sec: number,
): ThreadSpawnRecord => ({
  type: "thread_spawn",
  schema_version: SESSION_ENVELOPE_VERSION,
  parent_session_id: parent,
  parent_turn_id: parentTurn,
  child_session_id: child,
  child_task_kind: kind,
  spawned_at: isoAt(sec),
})

type EventKind =
  | "task_started"
  | "user_message"
  | "token_count"
  | "turn_aborted"
  | "tool_invoke"
  | "tool_result"
  | "custom"

/** Build an `event_msg` record of every legal `kind` with deterministic content
 *  derived from `i`. Extracted from the big-sequence test below to keep its
 *  cognitive complexity below the Biome ceiling. */
const buildEventByKind = (
  kind: EventKind,
  ts: string,
  turnId: string,
  i: number,
): EventMsgRecord => {
  const base = {
    type: "event_msg" as const,
    schema_version: SESSION_ENVELOPE_VERSION,
    ts,
    turn_id: turnId,
  }
  switch (kind) {
    case "task_started":
      return { ...base, kind, task: `task-${i}` }
    case "user_message":
      return { ...base, kind, content: `msg-${i}` }
    case "token_count":
      return { ...base, kind, input_tokens: i, output_tokens: i * 2 }
    case "turn_aborted":
      return { ...base, kind, reason: `reason-${i}` }
    case "tool_invoke":
      return { ...base, kind, tool: "read", input: { path: `/p/${i}` } }
    case "tool_result":
      return { ...base, kind, tool: "read", ok: true, output: `out-${i}` }
    case "custom":
      return { ...base, kind, custom_kind: `v3.${i}`, data: { i } }
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 1 — every top-level type in one file                       */
/* ------------------------------------------------------------------ */

describe("session envelope hell — all 5 top-level types, exact order preserved", () => {
  test("1× session_meta, 5× turn_context, 50× event_msg (7 kinds), 3× response_item, 2× thread_spawn", async () => {
    const sessionId = "all-types-001"
    const sequence: SessionEnvelopeRecord[] = []
    sequence.push(buildMeta(sessionId))
    for (let i = 0; i < 5; i += 1) {
      sequence.push(buildTurnContext(`turn-${i}`))
    }
    // 50 events split across all 7 kinds, distributed evenly.
    const eventKinds: EventKind[] = [
      "task_started",
      "user_message",
      "token_count",
      "turn_aborted",
      "tool_invoke",
      "tool_result",
      "custom",
    ]
    for (let i = 0; i < 50; i += 1) {
      const kind = eventKinds[i % eventKinds.length] as EventKind
      sequence.push(buildEventByKind(kind, isoAt(100 + i), `turn-${i % 5}`, i))
    }
    for (let i = 0; i < 3; i += 1) {
      sequence.push(buildResponseItem(`turn-${i}`, i))
    }
    sequence.push(buildThreadSpawn(sessionId, "turn-0", "child-A", "explore", 200))
    sequence.push(buildThreadSpawn(sessionId, "turn-1", "child-B", "fix", 201))

    // Sanity on the sequence we built:
    expect(sequence.length).toBe(1 + 5 + 50 + 3 + 2)
    expect(sequence.length).toBe(61)

    for (const rec of sequence) {
      await appendEnvelope(sessionId, rec)
    }

    const path = sessionEnvelopePath(sessionId)
    const readBack: SessionEnvelopeRecord[] = []
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) throw new Error(`unexpected decode failure: ${r.error.message}`)
      readBack.push(r.value)
    }
    expect(readBack.length).toBe(sequence.length)
    for (let i = 0; i < sequence.length; i += 1) {
      // Deep-equality of the full schema-validated record.
      expect(readBack[i]).toEqual(sequence[i] as SessionEnvelopeRecord)
    }

    // Exact-count assertions per type:
    const byType = new Map<string, number>()
    for (const r of readBack) {
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
    }
    expect(byType.get("session_meta")).toBe(1)
    expect(byType.get("turn_context")).toBe(5)
    expect(byType.get("event_msg")).toBe(50)
    expect(byType.get("response_item")).toBe(3)
    expect(byType.get("thread_spawn")).toBe(2)

    // Per-kind exact counts across the 50 events:
    const byEventKind = new Map<string, number>()
    for (const r of readBack) {
      if (r.type === "event_msg") {
        byEventKind.set(r.kind, (byEventKind.get(r.kind) ?? 0) + 1)
      }
    }
    // 50 / 7 = 7 remainder 1 → first kind gets 8, rest get 7.
    expect(byEventKind.get("task_started")).toBe(8)
    expect(byEventKind.get("user_message")).toBe(7)
    expect(byEventKind.get("token_count")).toBe(7)
    expect(byEventKind.get("turn_aborted")).toBe(7)
    expect(byEventKind.get("tool_invoke")).toBe(7)
    expect(byEventKind.get("tool_result")).toBe(7)
    expect(byEventKind.get("custom")).toBe(7)
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 2 — 17 turn_context fields completeness                    */
/* ------------------------------------------------------------------ */

describe("session envelope hell — every turn_context field round-trips", () => {
  test("all 15 Codex fields + 2 v3-extension fields preserved exactly", async () => {
    const sessionId = "tc-fields-001"
    // Build a turn_context that exercises EVERY field with a non-default value.
    const rec: TurnContextRecord = {
      type: "turn_context",
      schema_version: SESSION_ENVELOPE_VERSION,
      turn_id: "t-hell-1",
      cwd: "/some/very/deep/path/with-dashes_and.dots",
      current_date: "2026-05-21T12:34:56.789Z",
      timezone: "Asia/Seoul",
      approval_policy: "untrusted",
      sandbox_policy: "isolated",
      permission_profile: "custom",
      model: "gpt-5-pro",
      personality: "skeptical-reviewer",
      collaboration_mode: "supervised",
      realtime_active: true,
      effort: "max",
      summary: "long summary with spaces and 한글 🚀",
      user_instructions: "be exact, never swallow errors",
      truncation_policy: "summarize",
      parent_thread_id: "t-root-parent",
      thread_role: "subagent",
    }
    // Encode → decode parity:
    const wire = encodeSessionLine(rec)
    expect(wire.endsWith("\n")).toBe(true)
    expect(wire.endsWith("\n\n")).toBe(false)

    await appendEnvelope(sessionId, rec)
    const path = sessionEnvelopePath(sessionId)
    const out: SessionEnvelopeRecord[] = []
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      out.push(r.value)
    }
    expect(out.length).toBe(1)
    const decoded = out[0] as TurnContextRecord
    expect(decoded.type).toBe("turn_context")
    // Walk every field explicitly so a future field add forces a test update.
    expect(decoded.schema_version).toBe(rec.schema_version)
    expect(decoded.turn_id).toBe(rec.turn_id)
    expect(decoded.cwd).toBe(rec.cwd)
    expect(decoded.current_date).toBe(rec.current_date)
    expect(decoded.timezone).toBe(rec.timezone)
    expect(decoded.approval_policy).toBe(rec.approval_policy)
    expect(decoded.sandbox_policy).toBe(rec.sandbox_policy)
    expect(decoded.permission_profile).toBe(rec.permission_profile)
    expect(decoded.model).toBe(rec.model)
    expect(decoded.personality).toBe(rec.personality)
    expect(decoded.collaboration_mode).toBe(rec.collaboration_mode)
    expect(decoded.realtime_active).toBe(rec.realtime_active)
    expect(decoded.effort).toBe(rec.effort)
    expect(decoded.summary).toBe(rec.summary)
    expect(decoded.user_instructions).toBe(rec.user_instructions)
    expect(decoded.truncation_policy).toBe(rec.truncation_policy)
    expect(decoded.parent_thread_id).toBe(rec.parent_thread_id)
    expect(decoded.thread_role).toBe(rec.thread_role)
    // Deep-equality belt-and-suspenders:
    expect(decoded).toEqual(rec)
    // Byte-identical re-encode:
    expect(encodeSessionLine(decoded)).toBe(wire)
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 3 — parent → child → grandchild thread_spawn chain         */
/* ------------------------------------------------------------------ */

describe("session envelope hell — 3-level thread_spawn chain preserves ids", () => {
  test("parent→child→grandchild references survive read-back", async () => {
    const sessionId = "chain-001"
    const parentId = "sess-parent"
    const childId = "sess-child"
    const grandchildId = "sess-grandchild"

    const spawnParentToChild = buildThreadSpawn(parentId, "t-p1", childId, "review", 100)
    const spawnChildToGrandchild = buildThreadSpawn(childId, "t-c1", grandchildId, "fix", 110)
    // Cross-ref: an extra link to keep the chain explicit when read back.
    const spawnParentSelf = buildThreadSpawn(parentId, "t-p2", childId, "review-second", 120)

    await appendEnvelope(sessionId, spawnParentToChild)
    await appendEnvelope(sessionId, spawnChildToGrandchild)
    await appendEnvelope(sessionId, spawnParentSelf)

    const path = sessionEnvelopePath(sessionId)
    const out: ThreadSpawnRecord[] = []
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      if (r.value.type !== "thread_spawn") {
        throw new Error(`unexpected type: ${r.value.type}`)
      }
      out.push(r.value)
    }
    expect(out.length).toBe(3)
    const [pc, cg, ps2] = out
    if (pc === undefined || cg === undefined || ps2 === undefined) {
      throw new Error("missing record")
    }
    // parent→child:
    expect(pc.parent_session_id).toBe(parentId)
    expect(pc.child_session_id).toBe(childId)
    expect(pc.child_task_kind).toBe("review")
    // child→grandchild:
    expect(cg.parent_session_id).toBe(childId)
    expect(cg.child_session_id).toBe(grandchildId)
    expect(cg.child_task_kind).toBe("fix")
    // parent→child (second):
    expect(ps2.parent_session_id).toBe(parentId)
    expect(ps2.child_session_id).toBe(childId)
    expect(ps2.child_task_kind).toBe("review-second")
    // Spawn order via spawned_at:
    expect(pc.spawned_at).toBe(isoAt(100))
    expect(cg.spawned_at).toBe(isoAt(110))
    expect(ps2.spawned_at).toBe(isoAt(120))
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 4 — partial line + EOF without trailing newline            */
/* ------------------------------------------------------------------ */

describe("session envelope hell — malformed trailing line surfaced, never silently skipped", () => {
  test("file ending mid-line yields { ok: false } with parse_json kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-session-envelope-partial-"))
    try {
      const valid = encodeSessionLine(buildMeta("partial-ok"))
      // Build a deliberately-truncated line: take a valid record, drop a
      // brace, no trailing newline.
      const broken = encodeSessionLine(buildMeta("partial-bad")).slice(0, -10)
      const path = join(dir, "partial.jsonl")
      writeFileSync(path, `${valid}${broken}`)

      const results: Array<{ ok: boolean; kind?: string }> = []
      for await (const r of iterateSessionFile(path)) {
        if (r.ok) {
          results.push({ ok: true })
        } else {
          results.push({ ok: false, kind: r.error.kind })
        }
      }
      expect(results.length).toBe(2)
      expect(results[0]).toEqual({ ok: true })
      expect(results[1]?.ok).toBe(false)
      expect(results[1]?.kind).toBe("parse_json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("file ending with a truncated VALID-prefix line still produces { ok: false } EnvelopeDecodeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-session-envelope-partial-2-"))
    try {
      // Just a partial open-brace: forces parse_json on the trailing flush.
      const path = join(dir, "p.jsonl")
      writeFileSync(path, `{"type":"session_meta","schema_version":1,`)
      let count = 0
      let errKind: string | undefined
      let errInstance: unknown
      for await (const r of iterateSessionFile(path)) {
        count += 1
        if (!r.ok) {
          errKind = r.error.kind
          errInstance = r.error
        }
      }
      expect(count).toBe(1)
      expect(errKind).toBe("parse_json")
      expect(errInstance).toBeInstanceOf(EnvelopeDecodeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 5 — streaming 10,000 records, memory-bounded               */
/* ------------------------------------------------------------------ */

/**
 * Write `n` `token_count` records to `path` as ONE append stream.
 *
 * Uses the lower-level `encodeSessionLine` rather than `appendEnvelope` — it
 * skips the per-write open()/close() ceremony by batching into one open, and
 * the on-disk shape is byte-identical (the same encoded lines, same order,
 * concatenated).
 *
 * CHUNKED, not one awaited `fh.write()` per record. Measured on this file:
 * 10,000 awaited single-line writes cost ~8.8s of pure FIXTURE SETUP while the
 * thing actually under test — `iterateSessionFile` streaming the result back —
 * costs ~1.0s. The scenario therefore blew the 5s default `bun test` timeout
 * (the CI pyramid's `bun test tests/integration` passes no `--timeout`) on
 * setup that asserts nothing. Chunking is the fix rather than a longer timeout:
 * the read side, which is what "memory bounded" refers to, is untouched, and
 * CHUNK_LINES bounds the writer's own peak buffer too instead of materialising
 * one 10k-line string.
 *
 * Lives OUTSIDE the test body deliberately: inlined, its loop + flush branch
 * pushed the test's cognitive complexity past the lint-debt ceiling, and the
 * ceiling may only go down.
 */
const CHUNK_LINES = 1_000

const writeTokenCountFixture = async (path: string, n: number): Promise<void> => {
  const fh = await open(path, "a")
  try {
    let chunk = ""
    for (let i = 0; i < n; i += 1) {
      const ev: EventMsgRecord = {
        type: "event_msg",
        schema_version: SESSION_ENVELOPE_VERSION,
        ts: isoAt(i),
        turn_id: `t-${i % 32}`,
        kind: "token_count",
        input_tokens: i,
        output_tokens: i,
      }
      chunk += encodeSessionLine(ev)
      if ((i + 1) % CHUNK_LINES === 0) {
        await fh.write(chunk)
        chunk = ""
      }
    }
    if (chunk !== "") await fh.write(chunk)
  } finally {
    await fh.close()
  }
}

describe("session envelope hell — streaming 10,000 records with running counter only", () => {
  test("exact 10,000 read-back; we never materialise the full array", async () => {
    const sessionId = "stream-10k"
    const N = 10_000
    const path = sessionEnvelopePath(sessionId)
    await writeTokenCountFixture(path, N)

    let count = 0
    let okCount = 0
    let sumInputs = 0
    for await (const r of iterateSessionFile(path)) {
      count += 1
      if (!r.ok) throw new Error(`decode failed at ${count}: ${r.error.message}`)
      okCount += 1
      if (r.value.type === "event_msg" && r.value.kind === "token_count") {
        sumInputs += r.value.input_tokens
      }
    }
    expect(count).toBe(N)
    expect(okCount).toBe(N)
    // sum 0..N-1 = N*(N-1)/2
    expect(sumInputs).toBe((N * (N - 1)) / 2)
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 6 — concurrent writers, no torn lines                      */
/* ------------------------------------------------------------------ */

describe("session envelope hell — two concurrent Promise.all writers, no torn lines", () => {
  const N_PER = 500

  const oneWriter = async (
    sessionId: string,
    label: "writer-A" | "writer-B",
    tsBase: number,
  ): Promise<void> => {
    for (let i = 0; i < N_PER; i += 1) {
      const ev: EventMsgRecord = {
        type: "event_msg",
        schema_version: SESSION_ENVELOPE_VERSION,
        ts: isoAt(tsBase + i),
        turn_id: label,
        kind: "token_count",
        input_tokens: i,
        output_tokens: i,
      }
      await appendEnvelope(sessionId, ev)
    }
  }

  const tallyWriters = async (path: string): Promise<{ total: number; a: number; b: number }> => {
    let total = 0
    let a = 0
    let b = 0
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) {
        throw new Error(`torn or malformed line at #${total + 1}: ${r.error.message}`)
      }
      total += 1
      if (r.value.type !== "event_msg") continue
      if (r.value.turn_id === "writer-A") a += 1
      else if (r.value.turn_id === "writer-B") b += 1
    }
    return { total, a, b }
  }

  const assertTally = (t: { total: number; a: number; b: number }): void => {
    expect(t.total).toBe(N_PER * 2)
    expect(t.a).toBe(N_PER)
    expect(t.b).toBe(N_PER)
  }

  const runConcurrentBurst = async (sessionId: string): Promise<void> => {
    await Promise.all([
      oneWriter(sessionId, "writer-A", 0),
      oneWriter(sessionId, "writer-B", N_PER),
    ])
    const t = await tallyWriters(sessionEnvelopePath(sessionId))
    assertTally(t)
  }

  test("first run: 1000 records, all decodable", async () => {
    await runConcurrentBurst("concurrent-1")
  })

  test("second run (same harness, fresh session): catches flakiness", async () => {
    await runConcurrentBurst("concurrent-2")
  })
})

/* ------------------------------------------------------------------ */
/* Scenario 7 — snapshot independence invariant                        */
/* ------------------------------------------------------------------ */

describe("session envelope hell — JSONL and JSON snapshot live independently", () => {
  test("appendEnvelope + saveSessionById create two independent files; neither corrupts the other", async () => {
    const id = "independence-001"
    const meta: SessionMeta = {
      id,
      title: "independence test",
      cwd: "/tmp",
      createdAt: 1_716_000_000_000,
      lastTouched: 1_716_000_000_000,
      archived: false,
    }
    await saveSessionById(meta, {
      reason: "test-init",
      turns: 0,
      messages: [],
    })

    const ev: EventMsgRecord = {
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: isoAt(0),
      turn_id: "t-indep",
      kind: "task_started",
      task: "indep-task",
    }
    await appendEnvelope(id, ev)

    const jsonlPath = sessionEnvelopePath(id)
    const jsonPath = sessionFilePath(id)

    // Both files exist.
    expect(await Bun.file(jsonlPath).exists()).toBe(true)
    expect(await Bun.file(jsonPath).exists()).toBe(true)
    // Different paths.
    expect(jsonlPath).not.toBe(jsonPath)

    // Re-append AFTER saveSessionById to assert no cross-mutation.
    await appendEnvelope(id, ev)

    // JSONL holds exactly 2 records.
    let jsonlCount = 0
    for await (const r of iterateSessionFile(jsonlPath)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      jsonlCount += 1
    }
    expect(jsonlCount).toBe(2)

    // JSON snapshot is still parseable + matches what we wrote.
    const text = await Bun.file(jsonPath).text()
    const parsed = JSON.parse(text) as {
      version: number
      meta: SessionMeta
      reason: string
      turns: number
      messages: unknown[]
    }
    expect(parsed.version).toBe(2)
    expect(parsed.meta.id).toBe(id)
    expect(parsed.meta.title).toBe("independence test")
    expect(parsed.reason).toBe("test-init")
    expect(parsed.turns).toBe(0)
    expect(parsed.messages.length).toBe(0)

    // Re-write the snapshot AFTER more appends; JSONL must still survive.
    const updatedMeta: SessionMeta = { ...meta, title: "updated" }
    await saveSessionById(updatedMeta, {
      reason: "test-updated",
      turns: 1,
      messages: [],
    })
    // JSONL count unchanged.
    let jsonlCount2 = 0
    for await (const r of iterateSessionFile(jsonlPath)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      jsonlCount2 += 1
    }
    expect(jsonlCount2).toBe(2)

    // Snapshot reflects the update.
    const text2 = await Bun.file(jsonPath).text()
    const parsed2 = JSON.parse(text2) as { meta: SessionMeta; reason: string; turns: number }
    expect(parsed2.meta.title).toBe("updated")
    expect(parsed2.reason).toBe("test-updated")
    expect(parsed2.turns).toBe(1)
  })

  test("appendSessionLine directly on a manually-built path also stays bounded to that file", async () => {
    // Belt-and-suspenders: bypass sessionEnvelopePath to assert appendSessionLine
    // never touches the snapshot's path.
    const id = "independence-002"
    const meta: SessionMeta = {
      id,
      title: "raw append",
      cwd: "/tmp",
      createdAt: 1_716_000_000_000,
      lastTouched: 1_716_000_000_000,
      archived: false,
    }
    await saveSessionById(meta, { reason: "init", turns: 0, messages: [] })
    const jsonlPath = sessionEnvelopePath(id)
    const line = encodeSessionLine(buildMeta(id))
    await appendSessionLine(jsonlPath, line)
    expect(await Bun.file(jsonlPath).exists()).toBe(true)
    // The snapshot path was not even touched indirectly:
    const jsonPath = sessionFilePath(id)
    const text = await Bun.file(jsonPath).text()
    const parsed = JSON.parse(text) as { meta: SessionMeta }
    expect(parsed.meta.id).toBe(id)
  })
})
