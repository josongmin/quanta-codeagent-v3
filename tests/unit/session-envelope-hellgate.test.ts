/**
 * ★ CONTRACT — G1: ADR-0034 (src/session/envelope.ts) — 5 record types
 *   (session_meta / turn_context 17 fields / event_msg / response_item /
 *   thread_spawn) encode→decode→encode is BYTE-IDENTICAL (replay determinism).
 *   Alphabetical key order = sorted. Adversarial payloads (unicode/emoji/RTL/
 *   embedded newlines / `"` / `}`) round-trip stable. Malformed line on decode
 *   = typed error or skip, never a crash that loses the rest of the log.
 *
 * G1 — session envelope replay, ADVERSARIAL (HELLGATE).
 *
 * Pushes the JSONL codec (`encodeSessionLine` / `decodeSessionLine` /
 * `iterateSessionFile`) at the determinism + robustness contracts that
 * deterministic replay (ADR-0023 byte-identical invariant) leans on:
 *   - round-trip ALL 5 record kinds (incl. turn_context with all 17 + 2 fields)
 *   - encode→decode→encode is byte-identical for each
 *   - unicode / RTL / CJK / emoji / embedded control chars survive intact
 *   - a value containing a literal backslash-n, a `"`, and a `}` does not
 *     corrupt the single-line JSONL framing
 *   - key-order determinism: same content, different insertion order → same bytes
 *   - a malformed / truncated line is a TYPED error, and one bad line in a
 *     stream does NOT lose the rest of the log
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeSessionLine,
  type EventMsgRecord,
  encodeSessionLine,
  iterateSessionFile,
  type ResponseItemRecord,
  SESSION_ENVELOPE_VERSION,
  type SessionEnvelopeRecord,
  type SessionMetaRecord,
  type ThreadSpawnRecord,
  type TurnContextRecord,
} from "@/session"

/* ------------------------------------------------------------------ */
/* fixtures — one per record kind                                     */
/* ------------------------------------------------------------------ */

const meta = (): SessionMetaRecord => ({
  type: "session_meta",
  schema_version: SESSION_ENVELOPE_VERSION,
  session_id: "s-hell",
  started_at: "2026-05-22T01:02:03.456Z",
  cwd: "/work",
  cli_version: "0.9.9",
  model: "gpt-5",
})

/** turn_context with ALL 17 Codex fields + the 2 v3 linkage fields populated
 *  to NON-default values (so a dropped/reordered field would change bytes). */
const turnContext = (): TurnContextRecord => ({
  type: "turn_context",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: "t-1", //                       1
  cwd: "/work/sub", //                     2
  current_date: "2026-05-22T00:00:00Z", // 3
  timezone: "America/Los_Angeles", //      4
  approval_policy: "untrusted", //         5
  sandbox_policy: "isolated", //           6
  permission_profile: "restricted", //     7
  model: "claude-opus-4-7", //             8
  personality: "terse", //                 9
  collaboration_mode: "supervised", //    10
  realtime_active: true, //               11
  effort: "max", //                       12
  summary: "rolling summary text", //     13
  user_instructions: "be careful", //     14
  truncation_policy: "middle", //         15
  parent_thread_id: "parent-99", //       v3-1
  thread_role: "subagent", //             v3-2
})

const eventMsg = (): EventMsgRecord => ({
  type: "event_msg",
  schema_version: SESSION_ENVELOPE_VERSION,
  ts: "2026-05-22T01:02:03.456Z",
  turn_id: "t-1",
  kind: "tool_result",
  tool: "bash",
  ok: true,
  output: "done",
})

const responseItem = (): ResponseItemRecord => ({
  type: "response_item",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: "t-1",
  item_kind: "assistant_text",
  index: 0,
  content: "hello",
})

const threadSpawn = (): ThreadSpawnRecord => ({
  type: "thread_spawn",
  schema_version: SESSION_ENVELOPE_VERSION,
  parent_session_id: "s-hell",
  parent_turn_id: "t-1",
  child_session_id: "s-child",
  child_task_kind: "explorer",
  spawned_at: "2026-05-22T01:02:04.000Z",
})

const ALL: Array<{ name: string; rec: SessionEnvelopeRecord }> = [
  { name: "session_meta", rec: meta() },
  { name: "turn_context (17+2 fields)", rec: turnContext() },
  { name: "event_msg", rec: eventMsg() },
  { name: "response_item", rec: responseItem() },
  { name: "thread_spawn", rec: threadSpawn() },
]

/* ------------------------------------------------------------------ */
/* 1. round-trip every record kind, byte-identical                    */
/* ------------------------------------------------------------------ */

describe("G1 round-trip all 5 record kinds (encode→decode→encode byte-identical)", () => {
  for (const { name, rec } of ALL) {
    test(name, () => {
      const w1 = encodeSessionLine(rec)
      const d = decodeSessionLine(w1)
      expect(d.ok).toBe(true)
      if (!d.ok) throw new Error("unreachable")
      const w2 = encodeSessionLine(d.value)
      expect(w2).toBe(w1) // byte-identical
      // Exactly one trailing newline, no embedded raw newline splitting it.
      expect(w1.endsWith("\n")).toBe(true)
      expect(w1.slice(0, -1).includes("\n")).toBe(false)
    })
  }

  test("turn_context preserves ALL 19 fields through the round-trip", () => {
    const rec = turnContext()
    const d = decodeSessionLine(encodeSessionLine(rec))
    expect(d.ok).toBe(true)
    if (!d.ok) throw new Error("unreachable")
    // Deep value equality — no field silently dropped or coerced.
    expect(d.value).toEqual(rec)
    expect(Object.keys(d.value).length).toBe(Object.keys(rec).length)
  })
})

/* ------------------------------------------------------------------ */
/* 2. adversarial payloads — unicode, control chars, JSONL escapes     */
/* ------------------------------------------------------------------ */

describe("G1 adversarial string payloads survive round-trip + framing", () => {
  // Each string is dropped into a free-form text field (summary) — these are
  // exactly the bytes a hostile / multilingual user can put in a prompt.
  const payloads: Record<string, string> = {
    emoji: "🚀😀🇰🇷 family 👨‍👩‍👧‍👦",
    cjk: "中文 日本語 한국어",
    rtl: "العربية و עברית mixed with latin",
    "embedded real newline": "line one\nline two\nline three",
    "embedded CR + tab": "col1\tcol2\r\nnext",
    "literal backslash-n (not a newline)": "this has a \\n literal sequence",
    "double quote + brace + backslash": 'has " and } and \\ and {"nested":"json"}',
    "json-injection attempt": '"}\n{"type":"session_meta","session_id":"PWNED"}',
    "null-ish + zero-width": "a\x00b​c",
    "lone surrogate-safe high codepoint": "𝕳𝖊𝖑𝖑𝖌𝖆𝖙𝖊",
  }

  for (const [label, value] of Object.entries(payloads)) {
    test(`summary=${label} → round-trips, single line, no corruption`, () => {
      const rec: SessionEnvelopeRecord = { ...turnContext(), summary: value }
      const w1 = encodeSessionLine(rec)
      // CRITICAL FRAMING INVARIANT: the encoded record is exactly ONE JSONL
      // line. Any real newline embedded in a field MUST be escaped (\n), so
      // the only literal newline is the terminator.
      expect(w1.endsWith("\n")).toBe(true)
      expect(w1.slice(0, -1).split("\n").length).toBe(1)

      const d = decodeSessionLine(w1)
      expect(d.ok).toBe(true)
      if (!d.ok) throw new Error("unreachable")
      // The exact bytes round-trip.
      expect((d.value as TurnContextRecord).summary).toBe(value)
      // And re-encoding is byte-identical (determinism).
      expect(encodeSessionLine(d.value)).toBe(w1)
    })
  }

  test("a json-injection payload does NOT smuggle a second record", () => {
    // The malicious summary contains a fake newline + a forged session_meta.
    // Because it is escaped inside one JSON string, decoding yields exactly the
    // ONE turn_context — the forged record is inert text, not a second line.
    const evil = '"}\n{"type":"session_meta","session_id":"PWNED","schema_version":1}'
    const rec: SessionEnvelopeRecord = { ...turnContext(), summary: evil }
    const w1 = encodeSessionLine(rec)
    expect(w1.slice(0, -1).split("\n").length).toBe(1) // still one physical line
    const d = decodeSessionLine(w1)
    expect(d.ok).toBe(true)
    if (!d.ok) throw new Error("unreachable")
    expect(d.value.type).toBe("turn_context")
    expect((d.value as TurnContextRecord).summary).toBe(evil)
  })
})

/* ------------------------------------------------------------------ */
/* 3. key-order determinism                                            */
/* ------------------------------------------------------------------ */

describe("G1 key-order determinism", () => {
  for (const { name, rec } of ALL) {
    test(`${name}: shuffled insertion order → identical bytes`, () => {
      const canonical = encodeSessionLine(rec)
      // Rebuild the same record with keys inserted in REVERSE order.
      const reversed: Record<string, unknown> = {}
      for (const k of Object.keys(rec).reverse()) {
        reversed[k] = (rec as unknown as Record<string, unknown>)[k]
      }
      // ...and one more with a pseudo-random shuffle.
      const keys = Object.keys(rec)
      const shuffled: Record<string, unknown> = {}
      for (const k of [...keys].sort(() => 0.3 - Math.random())) {
        shuffled[k] = (rec as unknown as Record<string, unknown>)[k]
      }
      expect(encodeSessionLine(reversed as unknown as SessionEnvelopeRecord)).toBe(canonical)
      expect(encodeSessionLine(shuffled as unknown as SessionEnvelopeRecord)).toBe(canonical)
    })
  }

  test("nested object keys (event_msg custom data) are also sorted deterministically", () => {
    const base: EventMsgRecord = {
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: "2026-05-22T01:02:03.456Z",
      turn_id: "t-1",
      kind: "custom",
      custom_kind: "x",
      data: { zebra: 1, alpha: 2, mango: { y: 1, b: 2 } },
    }
    const flipped: EventMsgRecord = {
      ...base,
      data: { mango: { b: 2, y: 1 }, alpha: 2, zebra: 1 },
    }
    expect(encodeSessionLine(flipped)).toBe(encodeSessionLine(base))
  })
})

/* ------------------------------------------------------------------ */
/* 4. malformed / truncated lines — typed error, no log loss           */
/* ------------------------------------------------------------------ */

describe("G1 malformed / truncated decode is typed (never a crash)", () => {
  test("truncated JSON mid-object → typed parse_json error, decode returns (no throw)", () => {
    const truncated = '{"type":"session_meta","session_id":"s-1'
    const r = decodeSessionLine(truncated)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("parse_json")
    expect(r.error.raw).toBe(truncated) // raw preserved for forensics
  })

  test("valid JSON, wrong/unknown shape → typed schema error", () => {
    const r = decodeSessionLine('{"type":"nope","x":1}')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
  })

  test("turn_context missing a required field → typed schema error (issues listed)", () => {
    // Drop `thread_role` (a required v3 field).
    const { thread_role: _drop, ...partial } = turnContext() as Record<string, unknown>
    const r = decodeSessionLine(`${JSON.stringify(partial)}`)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
    expect(r.error.issues.length).toBeGreaterThan(0)
  })

  test("ONE bad line in a stream does NOT lose the surrounding good lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-envelope-hellgate-"))
    cleanups.push(dir)
    const path = join(dir, "session.jsonl")
    // good, GARBAGE, good(truncated-but-valid-JSON-wrong-shape), good
    const lines = [
      encodeSessionLine(meta()).slice(0, -1), // strip \n; we re-join below
      "{this is not json at all", // <- corruption
      '{"type":"unknown_kind"}', // <- valid JSON, schema-invalid
      encodeSessionLine(turnContext()).slice(0, -1),
      encodeSessionLine(eventMsg()).slice(0, -1),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)

    const results: Array<{ ok: boolean; kind?: string; type?: string }> = []
    for await (const r of iterateSessionFile(path)) {
      if (r.ok) results.push({ ok: true, type: r.value.type })
      else results.push({ ok: false, kind: r.error.kind })
    }
    // All 5 logical lines were yielded — nothing swallowed, stream not aborted.
    expect(results.length).toBe(5)
    expect(results[0]).toEqual({ ok: true, type: "session_meta" })
    expect(results[1]).toEqual({ ok: false, kind: "parse_json" })
    expect(results[2]).toEqual({ ok: false, kind: "schema" })
    // The two GOOD lines AFTER the corruption still decoded correctly.
    expect(results[3]).toEqual({ ok: true, type: "turn_context" })
    expect(results[4]).toEqual({ ok: true, type: "event_msg" })
    // Survivor count: the corruption did not cost us any valid record.
    expect(results.filter((x) => x.ok).length).toBe(3)
  })

  test("a final line WITHOUT a trailing newline (truncated write) is still yielded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-envelope-hellgate-"))
    cleanups.push(dir)
    const path = join(dir, "trunc.jsonl")
    // First line newline-terminated; second line abruptly cut off (no \n).
    const first = encodeSessionLine(meta())
    const secondNoNl = encodeSessionLine(turnContext()).slice(0, -1)
    writeFileSync(path, `${first}${secondNoNl}`)
    const got: string[] = []
    for await (const r of iterateSessionFile(path)) {
      if (r.ok) got.push(r.value.type)
    }
    expect(got).toEqual(["session_meta", "turn_context"])
  })
})

const cleanups: string[] = []
afterAll(() => {
  for (const d of cleanups) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})
