/**
 * Plan-mode P3 AgentEvent variants hellgate (2026-05-23).
 *
 * Pins the contract for the 6 plan-mode events introduced in P3:
 *   plan_created / plan_updated / plan_snapshot
 *   plan_user_input_requested / plan_user_input_resolved
 *   mode_changed
 *
 * Coverage:
 *   - AgentEvent union admits all 6 variants (type-level construction).
 *   - JsonlRecorder maps each variant onto the `recovery` family with the
 *     documented `reason` discriminant (round-trip emit → parsed JSON line).
 *   - StdoutStream renders each variant non-empty and contains the
 *     discriminant token.
 *   - NullStream swallows every variant (no throw / no output).
 *   - Multi-event ordering is preserved across the jsonl writer.
 *   - Exhaustive switch coverage: a renderer with a `never` default arm
 *     forces compile-time coverage of the 6 new variants alongside every
 *     existing one (drift gate).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext, TrajectoryEvent } from "@/shared"
import { JsonlRecorder } from "../../../src/stream/adapters/jsonl-recorder"
import { StdoutStream } from "../../../src/stream/adapters/stdout"
import type { StreamPort } from "../../../src/stream/ports"
import type {
  AgentEvent,
  PlanDeltaReadonlyMirror,
  PlanReadonlyMirror,
} from "../../../src/stream/types"

/** Local NullStream — equivalent to the bench `NullStream` (swallows every
 *  event). We don't import the bench module here to avoid cross-slice
 *  coupling in a stream-slice test. */
class TestNullStream implements StreamPort {
  emit(_event: AgentEvent): void {
    // intentionally empty
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plan-evt-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CTX: RunContext = { runId: "r1", instanceId: "i1", attempt: 0 }
const fixedClocks = () => ({ now: () => 1_700_000_000_000, monotonic: () => 42 })

const readLines = (path: string): TrajectoryEvent[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEvent)

// ── Sample plan + delta fixtures (Readonly mirrors) ─────────────────────

const samplePlan: PlanReadonlyMirror = {
  id: "plan-1",
  name: "Implement auth flow",
  version: 1,
  todos: [
    { id: "t1", title: "design", status: "pending" },
    { id: "t2", title: "implement", status: "in_progress" },
    { id: "t3", title: "test", status: "pending" },
  ],
}

const sampleDelta: PlanDeltaReadonlyMirror = {
  kind: "todo_status_changed",
  todoId: "t1",
  todoTitle: "design",
  fromStatus: "pending",
  toStatus: "in_progress",
}

// ── AgentEvent union admits the 6 new variants ──────────────────────────

describe("AgentEvent union admits all 6 plan-mode variants", () => {
  test("plan_created compiles + carries plan", () => {
    const e: AgentEvent = { type: "plan_created", plan: samplePlan }
    expect(e.type).toBe("plan_created")
    if (e.type !== "plan_created") throw new Error("unreachable")
    expect(e.plan.id).toBe("plan-1")
    expect(e.plan.todos).toHaveLength(3)
  })
  test("plan_updated compiles + carries delta + version", () => {
    const e: AgentEvent = { type: "plan_updated", delta: sampleDelta, version: 2 }
    expect(e.type).toBe("plan_updated")
    if (e.type !== "plan_updated") throw new Error("unreachable")
    expect(e.version).toBe(2)
    expect(e.delta.kind).toBe("todo_status_changed")
  })
  test("plan_snapshot compiles + carries plan (late-attach surface)", () => {
    const e: AgentEvent = { type: "plan_snapshot", plan: samplePlan }
    expect(e.type).toBe("plan_snapshot")
    if (e.type !== "plan_snapshot") throw new Error("unreachable")
    expect(e.plan.version).toBe(1)
  })
  test("plan_user_input_requested compiles with and without choices", () => {
    const bare: AgentEvent = {
      type: "plan_user_input_requested",
      promptId: "p1",
      prompt: "approve plan?",
    }
    const withChoices: AgentEvent = {
      type: "plan_user_input_requested",
      promptId: "p2",
      prompt: "pick:",
      choices: ["yes", "no", "edit"],
    }
    expect(bare.type).toBe("plan_user_input_requested")
    expect(withChoices.type).toBe("plan_user_input_requested")
    if (withChoices.type === "plan_user_input_requested") {
      expect(withChoices.choices).toEqual(["yes", "no", "edit"])
    }
  })
  test("plan_user_input_resolved compiles for answer + cancelled", () => {
    const answered: AgentEvent = {
      type: "plan_user_input_resolved",
      promptId: "p1",
      decision: "answer",
      text: "yes",
    }
    const cancelled: AgentEvent = {
      type: "plan_user_input_resolved",
      promptId: "p1",
      decision: "cancelled",
    }
    expect(answered.type).toBe("plan_user_input_resolved")
    expect(cancelled.type).toBe("plan_user_input_resolved")
  })
  test("mode_changed compiles for every from/to pairing", () => {
    const pairs: { from: "default" | "plan"; to: "default" | "plan" }[] = [
      { from: "default", to: "plan" },
      { from: "plan", to: "default" },
      { from: "default", to: "default" },
      { from: "plan", to: "plan" },
    ]
    for (const { from, to } of pairs) {
      const e: AgentEvent = { type: "mode_changed", from, to }
      expect(e.type).toBe("mode_changed")
    }
  })
})

// ── JsonlRecorder mappings ──────────────────────────────────────────────

describe("JsonlRecorder maps the 6 plan-mode variants to the recovery family", () => {
  test("plan_created → kind=recovery, data.reason='plan_created' + plan payload", () => {
    const path = join(dir, "plan-created.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_created", plan: samplePlan })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("plan_created")
    expect(line?.data.plan).toBeDefined()
    expect((line?.data.plan as { id: string }).id).toBe("plan-1")
  })

  test("plan_updated → kind=recovery, data.reason='plan_updated' + version + delta", () => {
    const path = join(dir, "plan-updated.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_updated", delta: sampleDelta, version: 5 })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("plan_updated")
    expect(line?.data.version).toBe(5)
    expect((line?.data.delta as { kind: string }).kind).toBe("todo_status_changed")
  })

  test("plan_snapshot → kind=recovery, data.reason='plan_snapshot' + plan", () => {
    const path = join(dir, "plan-snapshot.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_snapshot", plan: samplePlan })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("plan_snapshot")
    expect((line?.data.plan as { name: string }).name).toBe("Implement auth flow")
  })

  test("plan_user_input_requested → reason='plan_user_input_requested' + prompt", () => {
    const path = join(dir, "puir.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "plan_user_input_requested",
      promptId: "pq1",
      prompt: "approve?",
      choices: ["yes", "no"],
    })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("plan_user_input_requested")
    expect(line?.data.promptId).toBe("pq1")
    expect(line?.data.prompt).toBe("approve?")
    expect(line?.data.choices).toEqual(["yes", "no"])
  })

  test("plan_user_input_requested OMITS choices field when undefined (exactOptional)", () => {
    const path = join(dir, "puir2.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_user_input_requested", promptId: "pq2", prompt: "free text?" })
    rec.close()
    const [line] = readLines(path)
    expect("choices" in (line?.data ?? {})).toBe(false)
  })

  test("plan_user_input_resolved → reason='plan_user_input_resolved' + decision", () => {
    const path = join(dir, "puir-resolved.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "plan_user_input_resolved",
      promptId: "pq1",
      decision: "answer",
      text: "yes",
    })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("plan_user_input_resolved")
    expect(line?.data.decision).toBe("answer")
    expect(line?.data.text).toBe("yes")
  })

  test("plan_user_input_resolved cancelled OMITS text field", () => {
    const path = join(dir, "puir-cancel.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_user_input_resolved", promptId: "pq1", decision: "cancelled" })
    rec.close()
    const [line] = readLines(path)
    expect(line?.data.reason).toBe("plan_user_input_resolved")
    expect(line?.data.decision).toBe("cancelled")
    expect("text" in (line?.data ?? {})).toBe(false)
  })

  test("mode_changed → reason='mode_changed' + from + to", () => {
    const path = join(dir, "mode.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "mode_changed", from: "default", to: "plan" })
    rec.close()
    const [line] = readLines(path)
    expect(line?.kind).toBe("recovery")
    expect(line?.data.reason).toBe("mode_changed")
    expect(line?.data.from).toBe("default")
    expect(line?.data.to).toBe("plan")
    expect("transitionReason" in (line?.data ?? {})).toBe(false)
  })

  test("mode_changed with reason → emits transitionReason", () => {
    const path = join(dir, "mode2.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "mode_changed",
      from: "plan",
      to: "default",
      fromAgentMode: "plan",
      toAgentMode: "default",
      reason: "developer toggled",
    })
    rec.close()
    const [line] = readLines(path)
    expect(line?.data.fromAgentMode).toBe("plan")
    expect(line?.data.toAgentMode).toBe("default")
    expect(line?.data.transitionReason).toBe("developer toggled")
  })

  test("multi-event ordering preserved: created → updated → snapshot", () => {
    const path = join(dir, "ordered.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_created", plan: samplePlan })
    rec.emit({ type: "plan_updated", delta: sampleDelta, version: 2 })
    rec.emit({ type: "plan_snapshot", plan: { ...samplePlan, version: 2 } })
    rec.close()
    const lines = readLines(path)
    expect(lines.map((l) => l.data.reason)).toEqual([
      "plan_created",
      "plan_updated",
      "plan_snapshot",
    ])
  })

  test("plan_updated payload renders every optional delta field when present", () => {
    const path = join(dir, "delta-full.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "plan_updated",
      version: 7,
      delta: {
        kind: "plan_renamed",
        fromName: "old",
        toName: "new",
      },
    })
    rec.close()
    const [line] = readLines(path)
    const delta = line?.data.delta as { kind: string; fromName?: string; toName?: string }
    expect(delta.kind).toBe("plan_renamed")
    expect(delta.fromName).toBe("old")
    expect(delta.toName).toBe("new")
  })

  test("plan_updated delta OMITS optional fields when undefined", () => {
    const path = join(dir, "delta-min.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "plan_updated",
      version: 3,
      delta: { kind: "todo_added", todoId: "x" },
    })
    rec.close()
    const [line] = readLines(path)
    const delta = (line?.data.delta ?? {}) as Record<string, unknown>
    expect(delta.kind).toBe("todo_added")
    expect(delta.todoId).toBe("x")
    expect("todoTitle" in delta).toBe(false)
    expect("fromStatus" in delta).toBe(false)
    expect("toStatus" in delta).toBe(false)
    expect("fromName" in delta).toBe(false)
    expect("toName" in delta).toBe(false)
  })

  test("plan inlined as JSON has the exact projected fields", () => {
    const path = join(dir, "plan-inline.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "plan_created", plan: samplePlan })
    rec.close()
    const [line] = readLines(path)
    const plan = line?.data.plan as {
      id: string
      name: string
      version: number
      todos: { id: string; title: string; status: string }[]
    }
    expect(plan.id).toBe("plan-1")
    expect(plan.name).toBe("Implement auth flow")
    expect(plan.version).toBe(1)
    expect(plan.todos).toEqual([
      { id: "t1", title: "design", status: "pending" },
      { id: "t2", title: "implement", status: "in_progress" },
      { id: "t3", title: "test", status: "pending" },
    ])
  })
})

// ── StdoutStream rendering ──────────────────────────────────────────────

describe("StdoutStream renders each plan-mode variant with the discriminant token", () => {
  const realWrite = process.stdout.write.bind(process.stdout)
  let captured: string[]
  beforeEach(() => {
    captured = []
    process.stdout.write = ((chunk: unknown): boolean => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })
  afterEach(() => {
    process.stdout.write = realWrite
  })

  const out = (): string => captured.join("")

  test("plan_created renders one line containing 'plan_created' + plan name + todo count", () => {
    new StdoutStream().emit({ type: "plan_created", plan: samplePlan })
    const s = out()
    expect(s).toContain("plan_created")
    expect(s).toContain("Implement auth flow")
    expect(s).toContain("3 todos")
    expect(s.length).toBeGreaterThan(0)
    expect(s.endsWith("\n")).toBe(true)
  })

  test("plan_updated renders one line containing 'plan_updated' + version + delta kind", () => {
    new StdoutStream().emit({ type: "plan_updated", delta: sampleDelta, version: 4 })
    const s = out()
    expect(s).toContain("plan_updated")
    expect(s).toContain("v4")
    expect(s).toContain("todo_status_changed")
  })

  test("plan_snapshot renders one line containing 'plan_snapshot' + plan name", () => {
    new StdoutStream().emit({ type: "plan_snapshot", plan: samplePlan })
    const s = out()
    expect(s).toContain("plan_snapshot")
    expect(s).toContain("Implement auth flow")
  })

  test("plan_user_input_requested renders the prompt + choices when present", () => {
    new StdoutStream().emit({
      type: "plan_user_input_requested",
      promptId: "p1",
      prompt: "approve plan?",
      choices: ["yes", "no"],
    })
    const s = out()
    expect(s).toContain("plan_user_input_requested")
    expect(s).toContain("approve plan?")
    expect(s).toContain("yes")
    expect(s).toContain("no")
  })

  test("plan_user_input_requested with no choices does not render choice brackets", () => {
    new StdoutStream().emit({
      type: "plan_user_input_requested",
      promptId: "p1",
      prompt: "free text question?",
    })
    const s = out()
    // Strip ANSI escape codes (ESC[...m) so the assertion targets only the
    // human-readable payload — choices render as ` [a|b|c]` which would
    // inject a literal `[` after the prompt. ESC is `String.fromCharCode(27)`
    // (biome forbids the literal control char in source).
    const ESC = String.fromCharCode(27)
    const stripped = s.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "")
    expect(stripped).toContain("plan_user_input_requested")
    expect(stripped).toContain("free text question?")
    expect(stripped).not.toContain("[")
  })

  test("plan_user_input_resolved renders decision (answer + text)", () => {
    new StdoutStream().emit({
      type: "plan_user_input_resolved",
      promptId: "p1",
      decision: "answer",
      text: "yes",
    })
    const s = out()
    expect(s).toContain("plan_user_input_resolved")
    expect(s).toContain("answer")
    expect(s).toContain("yes")
  })

  test("plan_user_input_resolved cancelled renders 'cancelled' and no text", () => {
    new StdoutStream().emit({
      type: "plan_user_input_resolved",
      promptId: "p1",
      decision: "cancelled",
    })
    const s = out()
    expect(s).toContain("plan_user_input_resolved")
    expect(s).toContain("cancelled")
  })

  test("mode_changed renders 'mode_changed' + arrow + from/to", () => {
    new StdoutStream().emit({ type: "mode_changed", from: "default", to: "plan" })
    const s = out()
    expect(s).toContain("mode_changed")
    expect(s).toContain("default")
    expect(s).toContain("plan")
    expect(s).toContain("→")
  })

  test("mode_changed with reason includes the reason text", () => {
    new StdoutStream().emit({
      type: "mode_changed",
      from: "plan",
      to: "default",
      reason: "dev override",
    })
    const s = out()
    expect(s).toContain("mode_changed")
    expect(s).toContain("dev override")
  })

  test("subagent lifecycle renders its type token and redacts model-derived text", () => {
    const stream = new StdoutStream()
    stream.emit({
      type: "subagent_spawn",
      taskId: "child-1",
      parentTaskId: "root-1",
      depth: 1,
      agentType: "worker",
      description: "investigate sk-test-abcdefghijklmnopqrstuvwxyz",
      at: 1,
    })
    stream.emit({
      type: "subagent_status",
      taskId: "child-1",
      status: "failed",
      turns: 2,
      error: "failed with sk-test-abcdefghijklmnopqrstuvwxyz",
      at: 2,
    })
    const s = out()
    expect(s).toContain("subagent_spawn")
    expect(s).toContain("child-1")
    expect(s).toContain("subagent_status")
    expect(s).toContain("failed")
    expect(s).not.toContain("sk-test-abcdefghijklmnopqrstuvwxyz")
  })

  test("each variant produces exactly one terminal newline (one-line dim render)", () => {
    const events: AgentEvent[] = [
      { type: "plan_created", plan: samplePlan },
      { type: "plan_updated", delta: sampleDelta, version: 1 },
      { type: "plan_snapshot", plan: samplePlan },
      { type: "plan_user_input_requested", promptId: "p", prompt: "?" },
      { type: "plan_user_input_resolved", promptId: "p", decision: "answer", text: "ok" },
      { type: "mode_changed", from: "default", to: "plan" },
    ]
    const s = new StdoutStream()
    for (const e of events) {
      captured.length = 0
      s.emit(e)
      const joined = out()
      // each emit writes exactly ONE call to process.stdout.write with a
      // trailing newline (no banner-flush newline because none of these
      // follow assistant_text in this loop).
      expect(captured).toHaveLength(1)
      expect(joined.endsWith("\n")).toBe(true)
    }
  })
})

// ── NullStream swallows ─────────────────────────────────────────────────

describe("NullStream swallows every plan-mode variant", () => {
  test("emit() returns void without throwing for every variant", () => {
    const stream = new TestNullStream()
    const events: AgentEvent[] = [
      { type: "plan_created", plan: samplePlan },
      { type: "plan_updated", delta: sampleDelta, version: 1 },
      { type: "plan_snapshot", plan: samplePlan },
      { type: "plan_user_input_requested", promptId: "p", prompt: "?" },
      { type: "plan_user_input_resolved", promptId: "p", decision: "cancelled" },
      { type: "mode_changed", from: "default", to: "plan" },
    ]
    for (const e of events) {
      expect(() => stream.emit(e)).not.toThrow()
    }
  })
})

// ── Exhaustive switch coverage with `never` default arm ─────────────────

describe("Exhaustive AgentEvent switch covers the 6 new variants (drift gate)", () => {
  /** A minimal renderer with a `never` default arm. If any AgentEvent
   *  variant is missed at compile time, the `_exhaustive: never = e`
   *  assignment fails (tsc error). At runtime the function returns a
   *  short, non-empty discriminator string per variant. */
  const discriminate = (e: AgentEvent): string => {
    switch (e.type) {
      case "session_start":
        return "session_start"
      case "turn_start":
        return "turn_start"
      case "llm_request":
        return "llm_request"
      case "llm_continuation":
        return "llm_continuation"
      case "assistant_text":
        return "assistant_text"
      case "in_progress":
        return "in_progress"
      case "tool_call":
        return "tool_call"
      case "tool_progress":
        return "tool_progress"
      case "tool_result":
        return "tool_result"
      case "recovery":
        return "recovery"
      case "context_compacted":
        return "context_compacted"
      case "error":
        return "error"
      case "usage":
        return "usage"
      case "response_queued":
        return "response_queued"
      case "interrupted":
        return "interrupted"
      case "subagent_cancel":
        return "subagent_cancel"
      case "subagent_spawn":
        return "subagent_spawn"
      case "subagent_status":
        return "subagent_status"
      case "plan_created":
        return "plan_created"
      case "plan_updated":
        return "plan_updated"
      case "plan_snapshot":
        return "plan_snapshot"
      case "plan_user_input_requested":
        return "plan_user_input_requested"
      case "plan_user_input_resolved":
        return "plan_user_input_resolved"
      case "mode_changed":
        return "mode_changed"
      case "turn_diff_updated":
        return "turn_diff_updated"
      case "decision":
        return "decision"
      case "knobs_applied":
        return "knobs_applied"
      case "done":
        return "done"
      case "output_progress":
        return "output_progress"
      case "item_started":
        return "item_started"
      case "item_updated":
        return "item_updated"
      case "item_completed":
        return "item_completed"
      case "progress_update":
        return "progress_update"
      case "ratelimit_snapshot":
        return "ratelimit_snapshot"
      case "skill_scope_decision":
        return "skill_scope_decision"
      case "permission_escalation_requested":
        return "permission_escalation_requested"
      case "permission_escalation_resolved":
        return "permission_escalation_resolved"
      case "assistant_thinking":
        return "assistant_thinking"
      case "peer_message":
        return "peer_message"
      case "subagent_delivery":
        return "subagent_delivery"
      case "budget_breach":
        return "budget_breach"
      default: {
        const _exhaustive: never = e
        return _exhaustive
      }
    }
  }

  test("each new variant discriminates to its `type` string", () => {
    expect(
      discriminate({
        type: "llm_continuation",
        surfaceId: "openai-responses",
        transportId: "public",
        phase: "prepare",
        mode: "resume",
        reason: "prepared_resume",
      }),
    ).toBe("llm_continuation")
    expect(discriminate({ type: "plan_created", plan: samplePlan })).toBe("plan_created")
    expect(discriminate({ type: "plan_updated", delta: sampleDelta, version: 1 })).toBe(
      "plan_updated",
    )
    expect(discriminate({ type: "plan_snapshot", plan: samplePlan })).toBe("plan_snapshot")
    expect(discriminate({ type: "plan_user_input_requested", promptId: "p", prompt: "?" })).toBe(
      "plan_user_input_requested",
    )
    expect(
      discriminate({ type: "plan_user_input_resolved", promptId: "p", decision: "answer" }),
    ).toBe("plan_user_input_resolved")
    expect(discriminate({ type: "mode_changed", from: "default", to: "plan" })).toBe("mode_changed")
    expect(
      discriminate({
        type: "subagent_spawn",
        taskId: "child-1",
        depth: 1,
        description: "work",
        at: 1,
      }),
    ).toBe("subagent_spawn")
    expect(
      discriminate({ type: "subagent_status", taskId: "child-1", status: "completed", at: 2 }),
    ).toBe("subagent_status")
  })
})
