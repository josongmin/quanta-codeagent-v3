/**
 * `/inspect <toolCallId>` hellgate — pins the debug-mode follow-up surface
 * for ADR-0239.
 *
 * 18 adversarial cases:
 *   1.  decision-event match by `tool_call_id`
 *   2.  tool_invoke + tool_result co-turn attachment after a decision opens
 *       the bucket
 *   3.  custom event match via `data.id` field
 *   4.  custom event match via `data.toolCallId` field
 *   5.  unknown id ⇒ exit 1 + "not found in session" message
 *   6.  undefined session id ⇒ exit 1 + "no active session" message
 *   7.  reader rejects ⇒ exit 1 + "failed to read session"
 *   8.  secret-shape input is redacted (Bearer token / sk- key)
 *   9.  color=false strips ANSI completely
 *  10.  500-char `decision_reason` truncated (no full reason in output)
 *  11.  multiple decisions render one row each, in arrival order
 *  12.  same toolCallId in TWO turns ⇒ two occurrences printed
 *  13.  unknown envelope type is skipped without throwing
 *  14.  tool_result without a paired invoke ⇒ warning line emitted
 *  15.  empty `tool_result.output` paints "(empty)" preview
 *  16.  turn_context is attached to the group when present
 *  17.  empty toolCallId argument ⇒ exit 1
 *  18.  whitespace toolCallId argument is trimmed to empty ⇒ exit 1
 *
 * Slice-fence: imports ONLY @/session types + the new inspect-cmd module +
 * the new inspect-source projector. No REPL wiring touched.
 */

import { describe, expect, test } from "bun:test"
import { __test as inspectTest, runInspectCmd } from "../../../src/apps/cli/inspect-cmd"
import type { SessionEnvelopeRecord } from "../../../src/session"
import { findByToolCallId } from "../../../src/session/inspect-source"

// ─── fixtures ────────────────────────────────────────────────────────────

const ISO = (n: number): string => new Date(1717000000000 + n).toISOString()

const turnContext = (turn_id: string): SessionEnvelopeRecord => ({
  type: "turn_context",
  schema_version: 2,
  turn_id,
  cwd: "/tmp/x",
  current_date: ISO(0),
  timezone: "UTC",
  approval_policy: "never",
  sandbox_policy: "read-only",
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

const toolInvoke = (
  turn_id: string,
  tool: string,
  input: Record<string, unknown>,
  tsOffset = 1,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_invoke",
  tool,
  input,
})

const toolResult = (
  turn_id: string,
  tool: string,
  ok: boolean,
  output: string,
  tsOffset = 3,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_result",
  tool,
  ok,
  output,
})

const decision = (
  turn_id: string,
  gate: "permission" | "rule" | "hook" | "cap" | "jail" | "budget",
  outcome: "allow" | "deny" | "ask",
  decision_reason: string,
  toolCallId: string,
  extras: { rule_id?: string; hook_name?: string; metadata?: Record<string, unknown> } = {},
  tsOffset = 2,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "decision",
  gate,
  outcome,
  decision_reason,
  tool_call_id: toolCallId,
  ...(extras.rule_id !== undefined ? { rule_id: extras.rule_id } : {}),
  ...(extras.hook_name !== undefined ? { hook_name: extras.hook_name } : {}),
  ...(extras.metadata !== undefined ? { metadata: extras.metadata } : {}),
})

const custom = (
  turn_id: string,
  custom_kind: string,
  data: Record<string, unknown>,
  tsOffset = 2,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "custom",
  custom_kind,
  data,
})

// ─── helpers ─────────────────────────────────────────────────────────────

const captureSink = (): { out: (s: string) => void; text: () => string } => {
  let buf = ""
  return {
    out: (s) => {
      buf += s
    },
    text: () => buf,
  }
}

const runWith = async (
  toolCallId: string,
  envelopes: readonly SessionEnvelopeRecord[],
  opts: { sessionId?: string | undefined; color?: boolean } = {},
): Promise<{ exitCode: number; message: string; text: string }> => {
  const sink = captureSink()
  const result = await runInspectCmd(toolCallId, {
    out: sink.out,
    sessionId: opts.sessionId ?? "sess-test",
    color: opts.color ?? false,
    readSessionJsonl: async () => envelopes,
  })
  return { ...result, text: sink.text() }
}

// Lint-safe ANSI regex (built from non-literal escape).
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`)

// ─── cases ───────────────────────────────────────────────────────────────

describe("inspect-cmd · core matching", () => {
  test("case 1 — decision event matched by tool_call_id", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "default-allow", "tc_7a")]
    const r = await runWith("tc_7a", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("tool call tc_7a")
    expect(r.text).toContain("permission")
    expect(r.text).toContain("allow")
    expect(r.text).toContain("default-allow")
  })

  test("case 2 — tool_invoke + tool_result co-located in matched turn", async () => {
    const envs = [
      turnContext("3"),
      decision("3", "permission", "allow", "ok", "tc_7a", {}, 1),
      toolInvoke("3", "Read", { path: "src/foo.ts" }, 2),
      toolResult("3", "Read", true, "export const x = 1\n", 3),
    ]
    const r = await runWith("tc_7a", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("Read")
    expect(r.text).toContain("src/foo.ts")
    // The two-letter "ok" substring is too generic; pin the specific
    // structured form the renderer emits (column-separated " · ok · " or
    // a "ok=true" k=v shape).
    expect(r.text).toMatch(/[·:] ok |ok=true/)
    expect(r.text).toContain("export const x")
    // Negative: failure label MUST NOT bleed into this success render.
    expect(r.text).not.toContain("ok=false")
    expect(r.text).not.toMatch(/ fail | error /)
  })

  test("case 3 — custom event matched via data.id", async () => {
    const envs = [
      turnContext("4"),
      custom("4", "tool_call", { id: "tc_99", tool: "Bash", cmd: "ls" }),
    ]
    const r = await runWith("tc_99", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("tc_99")
    expect(r.text).toContain("tool_call")
  })

  test("case 4 — custom event matched via data.toolCallId (camelCase)", async () => {
    const envs = [
      turnContext("4"),
      custom("4", "tool_progress", { toolCallId: "tc_77", message: "running" }),
    ]
    const r = await runWith("tc_77", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("tc_77")
    expect(r.text).toContain("tool_progress")
  })
})

describe("inspect-cmd · error code paths", () => {
  test("case 5 — unknown id produces clear 'not found' message + exit 1", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_other")]
    const r = await runWith("tc_missing", envs)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain("tc_missing not found in session sess-test")
  })

  test("case 6 — undefined session id ⇒ 'no active session'", async () => {
    const sink = captureSink()
    const r = await runInspectCmd("tc_x", {
      out: sink.out,
      sessionId: undefined,
      readSessionJsonl: async () => [],
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("no active session")
  })

  test("case 7 — reader rejection surfaces 'failed to read session'", async () => {
    const sink = captureSink()
    const r = await runInspectCmd("tc_x", {
      out: sink.out,
      sessionId: "sess-bad",
      readSessionJsonl: async () => {
        throw new Error("simulated EACCES")
      },
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("failed to read session sess-bad")
    expect(sink.text()).toContain("simulated EACCES")
  })

  test("case 17 — empty toolCallId argument fails fast", async () => {
    const sink = captureSink()
    const r = await runInspectCmd("", {
      out: sink.out,
      sessionId: "sess",
      readSessionJsonl: async () => [],
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("tool call id is required")
  })

  test("case 18 — whitespace toolCallId is trimmed to empty ⇒ exit 1", async () => {
    const sink = captureSink()
    const r = await runInspectCmd("   ", {
      out: sink.out,
      sessionId: "sess",
      readSessionJsonl: async () => [],
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("tool call id is required")
  })
})

describe("inspect-cmd · sanitisation + truncation", () => {
  test("case 8 — secret-shape input is redacted (Bearer + sk- + Authorization key)", async () => {
    const envs = [
      decision("3", "permission", "allow", "ok", "tc_sec", {
        metadata: {
          Authorization: "Bearer abc123def456ghi789",
          apiKey: "sk-proj-abcdefghij1234567890",
          other: "fine value",
        },
      }),
    ]
    const r = await runWith("tc_sec", envs)
    expect(r.exitCode).toBe(0)
    // Verbatim secret values must not leak — assert the *raw token tail* is
    // gone, not just the full prefixed string (catches a "strip Bearer
    // word, leak the rest" regression).
    expect(r.text).not.toContain("Bearer abc123def456ghi789")
    expect(r.text).not.toContain("abc123def456ghi789")
    expect(r.text).not.toContain("sk-proj-abcdefghij1234567890")
    expect(r.text).not.toContain("abcdefghij1234567890")
    // Redaction marker should be present somewhere in the metadata column.
    expect(r.text).toContain("REDACTED")
    // Non-secret keys pass through unchanged.
    expect(r.text).toContain("fine value")
  })

  test("case 9 — color=false produces zero ANSI escapes", async () => {
    const envs = [
      decision("3", "permission", "deny", "blocked", "tc_color"),
      toolInvoke("3", "Bash", { cmd: "rm -rf /" }, 1),
      toolResult("3", "Bash", false, "denied", 4),
    ]
    const r = await runWith("tc_color", envs, { color: false })
    expect(r.exitCode).toBe(0)
    expect(ANSI_RE.test(r.text)).toBe(false)
    // Stronger: count ESC bytes — leak even ONE byte and we fail.
    const ESC = String.fromCharCode(0x1b)
    expect(r.text.split(ESC).length - 1).toBe(0)
  })

  test("case 9b — color=true emits ANSI escapes (inverse of 9)", async () => {
    const envs = [
      decision("3", "permission", "deny", "blocked", "tc_color2"),
      toolInvoke("3", "Bash", { cmd: "echo" }, 1),
      toolResult("3", "Bash", true, "ok", 4),
    ]
    const r = await runWith("tc_color2", envs, { color: true })
    expect(r.exitCode).toBe(0)
    // Inverse pin — guarantees the painter is wired (a regression that
    // pinned color=false everywhere would silently be masked by case 9).
    expect(ANSI_RE.test(r.text)).toBe(true)
  })

  test("case 10 — 500-char decision reason truncates with ellipsis marker", async () => {
    const longReason = "x".repeat(800)
    const envs = [decision("3", "permission", "allow", longReason, "tc_long")]
    const r = await runWith("tc_long", envs)
    expect(r.exitCode).toBe(0)
    // The full untruncated reason must NOT appear verbatim.
    expect(r.text).not.toContain("x".repeat(800))
    // "more" alone matches "moreover" / "smore" / etc. Pin the truncation
    // marker shape: either an ellipsis char or a "(N more chars)" suffix
    // followed by a digit.
    expect(r.text).toMatch(/…|\(\d+\s*more/)
    // The truncated visible body should still fit in the line cap
    // (TRUNCATE_DEFAULT = 200; reason cap = 500). Length of the FULL line
    // containing the long reason must be < 800 (catches `trunc` no-op).
    const longestLine = r.text.split("\n").reduce((a, b) => (a.length > b.length ? a : b), "")
    expect(longestLine.length).toBeLessThan(800)
  })
})

describe("inspect-cmd · multi-record + ordering", () => {
  test("case 11 — multiple decisions render in arrival order", async () => {
    const envs = [
      turnContext("3"),
      decision("3", "permission", "allow", "p-ok", "tc_multi", {}, 1),
      decision("3", "rule", "allow", "r-ok", "tc_multi", { rule_id: "r1" }, 2),
      decision("3", "hook", "ask", "h-ask", "tc_multi", { hook_name: "h1" }, 3),
    ]
    const r = await runWith("tc_multi", envs)
    expect(r.exitCode).toBe(0)
    const permissionIdx = r.text.indexOf("permission")
    const ruleIdx = r.text.indexOf("rule")
    const hookIdx = r.text.indexOf("hook")
    expect(permissionIdx).toBeGreaterThan(-1)
    expect(ruleIdx).toBeGreaterThan(permissionIdx)
    expect(hookIdx).toBeGreaterThan(ruleIdx)
    expect(r.text).toContain("r1")
    expect(r.text).toContain("h1")
    // Reasons are also rendered in arrival order. A regression that sorted
    // by gate name alphabetically would put hook before permission and
    // pass the substring checks above — pin reason ordering too.
    const pOk = r.text.indexOf("p-ok")
    const rOk = r.text.indexOf("r-ok")
    const hAsk = r.text.indexOf("h-ask")
    expect(pOk).toBeGreaterThan(-1)
    expect(rOk).toBeGreaterThan(pOk)
    expect(hAsk).toBeGreaterThan(rOk)
  })

  test("case 12 — same toolCallId in two different turns ⇒ two occurrences", async () => {
    const envs = [
      turnContext("3"),
      decision("3", "permission", "allow", "first", "tc_fork", {}, 1),
      toolInvoke("3", "Read", { path: "a.ts" }, 2),
      toolResult("3", "Read", true, "first-run", 3),
      turnContext("9"),
      decision("9", "permission", "allow", "second", "tc_fork", {}, 4),
      toolInvoke("9", "Read", { path: "b.ts" }, 5),
      toolResult("9", "Read", true, "second-run", 6),
    ]
    const r = await runWith("tc_fork", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("occurrence 1/2")
    expect(r.text).toContain("occurrence 2/2")
    expect(r.text).toContain("first-run")
    expect(r.text).toContain("second-run")
  })

  test("case 13 — unknown event kinds are skipped without throwing", async () => {
    const envs = [
      // task_started / user_message are valid envelope variants the projector
      // simply ignores (they carry no id).
      {
        type: "event_msg" as const,
        schema_version: 2 as const,
        ts: ISO(0),
        turn_id: "3",
        kind: "task_started" as const,
        task: "warmup",
      },
      {
        type: "event_msg" as const,
        schema_version: 2 as const,
        ts: ISO(1),
        turn_id: "3",
        kind: "user_message" as const,
        content: "hi",
      },
      decision("3", "permission", "allow", "ok", "tc_skip", {}, 2),
    ]
    const r = await runWith("tc_skip", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("tc_skip")
  })

  test("case 14 — tool_result without a matching decision/invoke ⇒ no group", async () => {
    // Orphan tool_result for an id-less turn — the projector returns no
    // group (the id was never opened) so the surface shows "not found".
    const envs = [toolResult("3", "Read", true, "orphan", 1)]
    const r = await runWith("tc_orphan", envs)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain("not found in session")
  })

  test("case 15 — empty tool_result.output paints '(empty)' preview", async () => {
    const envs = [
      decision("3", "permission", "allow", "ok", "tc_empty", {}, 1),
      toolInvoke("3", "Bash", { cmd: "true" }, 2),
      toolResult("3", "Bash", true, "", 3),
    ]
    const r = await runWith("tc_empty", envs)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("(empty)")
  })

  test("case 16 — turn_context discovered for the matched turn", async () => {
    const envs = [turnContext("7"), decision("7", "permission", "allow", "ok", "tc_ctx")]
    const groups = findByToolCallId(envs, "tc_ctx")
    expect(groups).toHaveLength(1)
    expect(groups[0]?.turnContext).toBeDefined()
    expect(groups[0]?.turnContext?.model).toBe("gpt-5")
  })
})

describe("inspect-cmd · projector unit coverage", () => {
  test("findByToolCallId returns [] for empty id", () => {
    expect(findByToolCallId([], "")).toEqual([])
  })

  test("findByToolCallId attaches response_item co-located in turn", () => {
    const envs: SessionEnvelopeRecord[] = [
      decision("5", "permission", "allow", "ok", "tc_resp", {}, 1),
      {
        type: "response_item",
        schema_version: 2,
        turn_id: "5",
        item_kind: "assistant_text",
        index: 0,
        content: "All done.",
      },
    ]
    const groups = findByToolCallId(envs, "tc_resp")
    expect(groups).toHaveLength(1)
    expect(groups[0]?.responseItems).toHaveLength(1)
    expect(groups[0]?.responseItems[0]?.content).toBe("All done.")
  })

  test("sanitize redacts deeply nested secret keys", () => {
    const out = inspectTest.sanitize({ nested: { Authorization: "Bearer xyzxyzxyz123" } })
    expect(out).not.toContain("Bearer xyzxyzxyz123")
    expect(out).toContain("REDACTED")
  })

  test("trunc keeps short strings verbatim", () => {
    expect(inspectTest.trunc("short")).toBe("short")
  })

  test("fmtSize spans B / KB / MB", () => {
    expect(inspectTest.fmtSize(0)).toBe("0B")
    expect(inspectTest.fmtSize(1500)).toBe("1.5KB")
    expect(inspectTest.fmtSize(2 * 1024 * 1024)).toBe("2.0MB")
  })

  test("fmtSize boundary at 1023/1024 byte transition", () => {
    // 1023 ⇒ still B suffix; 1024 ⇒ flips to KB. A `<= 1024` regression
    // (off-by-one in the branch threshold) would slip past 1500-only tests.
    expect(inspectTest.fmtSize(1023)).toBe("1023B")
    expect(inspectTest.fmtSize(1024)).toBe("1.0KB")
  })
})
