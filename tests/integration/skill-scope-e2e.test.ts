// TODO(migrate-to-harness): swap the local `FakeLLM` + `RecordingStream` +
// `baseConfig` for `tests/integration/_harness.ts` exports
// (`FakeLLM` + `RecordingStream` + `baseConfig`). See `agent-loop.test.ts` for
// the pattern. Deferred from refactor B to keep that PR scoped to 3 files.
/**
 * Skill tool-scoping ENFORCEMENT — end-to-end (ADR-0011).
 *
 * Proves the loop's `SkillGate` is actually wired through
 * runAgent → runTurn → streamConsume → dispatch closure:
 *
 *  (a) after a scoped `Skill` invocation, a DISALLOWED tool is denied as a
 *      recoverable (`is_error`) tool_result WITHOUT being dispatched (a stub
 *      side-effect counter proves non-execution), the model recovers, and a
 *      subsequently-ALLOWED tool runs normally.
 *  (b) the `Skill` / `ToolSearch` meta-tools are always permitted even under
 *      an active scope.
 *  (c) a skill that declares NO `tools:` imposes no restriction.
 *  (d) a strict `allowedTools: []` skill SEALS to nav-base (ADR-0512): ordinary
 *      tools are denied — even if a stale legacy `tools:` mirror tries to widen
 *      it — but the read-only exploration ladder (nav-base) still works.
 *  (e) control: with no skills configured there is no gate at all.
 *
 * Deterministic: scripted fake LLM, no network, temp skill dirs cleaned up.
 * Mirrors the fake-LLM harness in tests/integration/agent-features.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

/** Yields one scripted StreamEvent[] per stream() call, in order. */
class FakeLLM implements LLMPort {
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  calls = 0
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.calls += 1
    for (const ev of script) yield ev
  }
}

/** StreamPort double recording every emitted AgentEvent. */
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A counting stub tool: every actual `execute()` bumps `counts[name]`. If a
 *  call is scope-DENIED by the loop the closure never runs, so the counter
 *  staying flat is the non-dispatch proof. */
const countingTool = (name: string, counts: Record<string, number>): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    counts[name] = (counts[name] ?? 0) + 1
    yield { type: "result", result: { ok: true, output: `${name} ran` } }
  },
})

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  cwd: string,
  permission: PermissionContext,
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd,
  maxTurns: 12,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

const allToolResults = (outcome: Awaited<ReturnType<typeof runAgent>>) =>
  outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))

const SCOPE_MSG = "not in the active skill's permitted tool set"

describe("skill tool-scoping enforcement (e2e)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-scope-e2e-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // (a) + (b): scoped skill arms a gate; disallowed tool denied & NOT
  // dispatched; meta-tools always allowed; allowed tool runs.
  test("scoped skill denies out-of-scope tool without dispatching, allows in-scope + meta", async () => {
    // Skill `narrow` permits ONLY the "Read" tool.
    await mkdir(join(dir, "narrow"), { recursive: true })
    await writeFile(
      join(dir, "narrow", "SKILL.md"),
      '---\nname: narrow\ndescription: narrow scope\ntools: ["Read"]\n---\nUse only Read.\n',
    )

    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([
      countingTool("Read", counts),
      countingTool("danger", counts),
    ])

    const llm = new FakeLLM([
      // 1. arm the scope via the scoped skill
      toolUseScript("s1", "Skill", { name: "narrow" }),
      // 2. ToolSearch meta-tool — must be allowed even under active scope
      toolUseScript("t1", "ToolSearch", { query: "select:Read" }),
      // 3. disallowed tool — must be DENIED, recoverable, NOT executed
      toolUseScript("d1", "danger", {}),
      // 4. model recovers and uses the allowed tool
      toolUseScript("r1", "Read", {}),
      // 5. another Skill call is always allowed (meta) — re-arm
      toolUseScript("s2", "Skill", { name: "narrow" }),
      // 6. done
      textScript("finished"),
    ])
    const stream = new RecordingStream()

    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })

    expect(outcome.reason).toBe("completed")

    // The disallowed tool was NEVER executed (non-dispatch proof).
    expect(counts.danger).toBeUndefined()
    // The allowed tool DID execute exactly once.
    expect(counts.Read).toBe(1)

    const results = allToolResults(outcome)

    // Exactly one scope-deny tool_result, and it is a recoverable error.
    const denied = results.filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG))
    expect(denied).toHaveLength(1)
    const d = denied[0]
    if (d?.type === "tool_result") {
      expect(d.is_error).toBe(true)
      expect(d.tool_use_id).toBe("d1")
    }

    // The ToolSearch meta-call ran (allowed) — its result is present & not a
    // scope-deny.
    const tsResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "t1")
    expect(tsResult).toBeDefined()
    if (tsResult?.type === "tool_result") {
      expect(tsResult.is_error ?? false).toBe(false)
      expect(tsResult.content.includes(SCOPE_MSG)).toBe(false)
    }

    // The allowed Read call produced a normal (non-error) result.
    const readResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "r1")
    expect(readResult).toBeDefined()
    if (readResult?.type === "tool_result") {
      expect(readResult.is_error ?? false).toBe(false)
      expect(readResult.content).toContain("Read ran")
    }

    // The Skill meta-tool itself was never scope-denied.
    const skillDenied = results.some(
      (b) =>
        b.type === "tool_result" &&
        (b.tool_use_id === "s1" || b.tool_use_id === "s2") &&
        b.content.includes(SCOPE_MSG),
    )
    expect(skillDenied).toBe(false)
  })

  // (c): a skill that declares NO `tools:` imposes no restriction — any tool
  // invoked after it runs normally.
  test("skill with no tools: declared ⇒ no restriction (arbitrary tool runs)", async () => {
    await mkdir(join(dir, "open"), { recursive: true })
    await writeFile(
      join(dir, "open", "SKILL.md"),
      "---\nname: open\ndescription: open scope\n---\nNo tool restriction.\n",
    )

    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingTool("anything", counts)])

    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "open" }),
      toolUseScript("a1", "anything", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()

    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })

    expect(outcome.reason).toBe("completed")
    // No allowlist anywhere ⇒ skillAllowlists absent ⇒ gate undefined ⇒ the
    // arbitrary tool runs.
    expect(counts.anything).toBe(1)
    const denied = allToolResults(outcome).filter(
      (b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG),
    )
    expect(denied).toHaveLength(0)
  })

  // (c'): a scoped skill EXISTS in the dir (so a gate is built) but the model
  // invokes the UNSCOPED skill — the gate stays disarmed, arbitrary tool runs.
  test("invoking the unscoped skill leaves the gate disarmed even when a scoped skill exists", async () => {
    await mkdir(join(dir, "narrow"), { recursive: true })
    await writeFile(
      join(dir, "narrow", "SKILL.md"),
      '---\nname: narrow\ndescription: n\ntools: ["Read"]\n---\nbody\n',
    )
    await mkdir(join(dir, "open"), { recursive: true })
    await writeFile(join(dir, "open", "SKILL.md"), "---\nname: open\ndescription: o\n---\nbody\n")

    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingTool("danger", counts)])

    const llm = new FakeLLM([
      // invoke the UNSCOPED skill — gate exists but is not armed by this
      toolUseScript("s1", "Skill", { name: "open" }),
      // a tool not in narrow's list — must still run (scope never armed)
      toolUseScript("d1", "danger", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()

    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })

    expect(outcome.reason).toBe("completed")
    expect(counts.danger).toBe(1)
    const denied = allToolResults(outcome).filter(
      (b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG),
    )
    expect(denied).toHaveLength(0)
  })

  // (d) ADR-0512 — `allowedTools: []` SEALS to nav-base: ordinary tools are
  // denied (and a stale legacy `tools:` mirror does NOT widen the seal), but the
  // read-only exploration ladder (nav-base) still works so a sealed/briefing
  // skill can orient and read.
  test("empty allowedTools seals to nav-base — ordinary denied (no legacy fallback), nav-base allowed", async () => {
    await mkdir(join(dir, "sealed"), { recursive: true })
    await writeFile(
      join(dir, "sealed", "SKILL.md"),
      [
        "---",
        "name: sealed",
        "description: read-only seal",
        "userInvocable: true",
        "allowedTools: []", // strict seal
        'tools: ["danger"]', // stale legacy mirror — MUST NOT widen the seal
        "category: skill",
        "stability: stable",
        "---",
        "Explore only.",
      ].join("\n"),
    )

    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([
      countingTool("danger", counts), // ordinary ⇒ denied by the seal
      countingTool("grep", counts), // nav-base read-only ⇒ allowed despite the seal
    ])

    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("t1", "ToolSearch", { query: "select:grep" }),
      toolUseScript("d1", "danger", {}), // denied — legacy `tools:` ignored
      toolUseScript("g1", "grep", {}), // nav-base ⇒ runs
      textScript("done"),
    ])
    const stream = new RecordingStream()

    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })

    expect(outcome.reason).toBe("completed")
    // Ordinary tool denied — the legacy `tools: ["danger"]` mirror did NOT grant it.
    expect(counts.danger).toBeUndefined()
    // Nav-base read-only exploration STILL works under the seal.
    expect(counts.grep).toBe(1)

    const results = allToolResults(outcome)
    // `danger` is the ONLY scope-deny; `grep` (nav-base) is not denied.
    const denied = results.filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG))
    expect(denied).toHaveLength(1)
    expect(denied[0]?.type === "tool_result" ? denied[0].tool_use_id : "").toBe("d1")

    const gResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "g1")
    expect(gResult?.type === "tool_result" ? (gResult.is_error ?? false) : true).toBe(false)

    const tsResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "t1")
    expect(tsResult).toBeDefined()
    if (tsResult?.type === "tool_result") {
      expect(tsResult.is_error ?? false).toBe(false)
    }
  })

  // (e): control — no skills configured at all ⇒ no gate, behavior unchanged.
  test("control: no skills configured ⇒ no gate, tools run unrestricted", async () => {
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([
      countingTool("Read", counts),
      countingTool("danger", counts),
    ])

    const llm = new FakeLLM([
      toolUseScript("a1", "danger", {}),
      toolUseScript("a2", "Read", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()

    // NOTE: no `skills:` block.
    const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }))

    expect(outcome.reason).toBe("completed")
    expect(counts.danger).toBe(1)
    expect(counts.Read).toBe(1)
    const denied = allToolResults(outcome).filter(
      (b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG),
    )
    expect(denied).toHaveLength(0)
  })
})

/** A read-only counting tool ⇒ inferToolTier "none" (auto-run) ⇒ the tier that
 *  the escalation actually ASKS about under skill-scope v2. */
const countingToolRO = (name: string, counts: Record<string, number>): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    counts[name] = (counts[name] ?? 0) + 1
    yield { type: "result", result: { ok: true, output: `${name} ran` } }
  },
})

/** A counting tool that declares the hand-off-required tier (the security
 *  boundary the escalation must NEVER even ask about). */
const countingToolHandoff = (name: string, counts: Record<string, number>): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "hand-off-required",
  async *execute(): AsyncIterable<ToolEvent> {
    counts[name] = (counts[name] ?? 0) + 1
    yield { type: "result", result: { ok: true, output: `${name} ran` } }
  },
})

const sealedSkill = async (dir: string): Promise<void> => {
  await mkdir(join(dir, "sealed"), { recursive: true })
  await writeFile(
    join(dir, "sealed", "SKILL.md"),
    [
      "---",
      "name: sealed",
      "description: read-only seal",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
      "Explore only.",
    ].join("\n"),
  )
}

// ADR-0512 L3 — skill-scope v2 ESCALATION (gate `QUANTA_SKILL_SCOPE_V2`). Proves
// the onConfirm ask, scope widening, the `skill_scope_decision` timeline event,
// and the hand-off-required security boundary — all wired through runAgent.
describe("skill tool-scoping v2 escalation (e2e)", () => {
  let dir: string
  let prev: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-scope-v2-"))
    prev = process.env.QUANTA_SKILL_SCOPE_V2
    process.env.QUANTA_SKILL_SCOPE_V2 = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.QUANTA_SKILL_SCOPE_V2
    else process.env.QUANTA_SKILL_SCOPE_V2 = prev
    __resetRuntimeConfig()
  })

  test("out-of-scope auto-run tool ASKS; approve dispatches + widens (no re-ask); emits decision", async () => {
    // Guard against a false-green: prove the env actually took effect (the cache
    // was reset), so this test really runs the V2-ON path (audit finding).
    expect(runtimeConfig().skillScopeV2).toBe(true)
    await sealedSkill(dir)
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingToolRO("peek", counts)])
    const asks: { tool: string; scopeContext: { activeSkill: string; reason: string } | undefined }[] =
      []

    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("p1", "peek", {}), // out of scope ⇒ ask
      toolUseScript("p2", "peek", {}), // after widen ⇒ NO re-ask, dispatches
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
      skills: { dir },
      onConfirm: async (action) => {
        asks.push({ tool: action.tool, scopeContext: action.scopeContext })
        return true // approve the escalation
      },
    })

    expect(outcome.reason).toBe("completed")
    expect(counts.peek).toBe(2) // both ran (1st after approve, 2nd after widen)
    expect(asks).toHaveLength(1) // asked ONLY once — 2nd call was widened into scope
    expect(asks[0]?.scopeContext?.activeSkill).toBe("sealed")
    expect(asks[0]?.scopeContext?.reason).toContain("peek")

    // ADR-0512 P3 — the interactive escalation pair is emitted around the ask:
    // ONE `permission_escalation_requested` (the 1st out-of-scope call) carrying
    // tool/risk/activeSkill + the 4 options, then a matching
    // `permission_escalation_resolved` with the `allow_session` verb (approve
    // widens scope). The 2nd call was in scope ⇒ no second pair.
    const reqs = stream.events.filter((e) => e.type === "permission_escalation_requested")
    expect(reqs).toHaveLength(1)
    const req = reqs[0]
    if (req?.type === "permission_escalation_requested") {
      expect(req.tool).toBe("peek")
      expect(req.activeSkill).toBe("sealed")
      expect(req.risk).toBe("read-only") // the RO counting tool
      expect(req.options).toEqual(["allow_once", "allow_session", "deny", "deny_and_steer"])
    }
    const res = stream.events.filter((e) => e.type === "permission_escalation_resolved")
    expect(res).toHaveLength(1)
    if (res[0]?.type === "permission_escalation_resolved") {
      expect(res[0].decision).toBe("allow_session")
      expect(res[0].id).toBe(req?.type === "permission_escalation_requested" ? req.id : "")
    }
  })

  test("hand-off-required tool is BLOCKED without asking; not dispatched; decision=blocked", async () => {
    await sealedSkill(dir)
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingToolHandoff("destroyer", counts)])
    let asked = false

    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("x1", "destroyer", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
      skills: { dir },
      onConfirm: async () => {
        asked = true
        return true
      },
    })

    expect(outcome.reason).toBe("completed")
    expect(asked).toBe(false) // security boundary: never even asked
    expect(counts.destroyer).toBeUndefined() // never dispatched
    // The hard-lock surfaces as a tool_result labeled "blocked" (NOT a card).
    const tr = stream.events.find((e) => e.type === "tool_result" && e.id === "x1")
    expect(tr?.type === "tool_result" ? tr.preview : "").toBe("skill-scoped: blocked")
    // ADR-0512 P3 security invariant (RED-on-injection): a hand-off-required tool
    // is NON-escalatable — it NEVER emits an interactive escalation request /
    // resolution. The card seam must not be reachable for a security boundary.
    expect(stream.events.some((e) => e.type === "permission_escalation_requested")).toBe(false)
    expect(stream.events.some((e) => e.type === "permission_escalation_resolved")).toBe(false)
  })

  test("v2 OFF ⇒ flat ADR-0011 deny, NO escalation events (byte-identical legacy)", async () => {
    // Same out-of-scope scenario as the approve test, but with v2 OFF: the path
    // is the ADR-0011 flat `is_error` deny — and crucially NO escalation events.
    const prevV2 = process.env.QUANTA_SKILL_SCOPE_V2
    delete process.env.QUANTA_SKILL_SCOPE_V2
    __resetRuntimeConfig()
    try {
      await sealedSkill(dir)
      const counts: Record<string, number> = {}
      const registry = new ToolRegistry([countingToolRO("peek", counts)])
      let asked = false
      const llm = new FakeLLM([
        toolUseScript("s1", "Skill", { name: "sealed" }),
        toolUseScript("p1", "peek", {}),
        textScript("done"),
      ])
      const stream = new RecordingStream()
      const outcome = await runAgent({
        ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
        skills: { dir },
        onConfirm: async () => {
          asked = true
          return true
        },
      })
      expect(outcome.reason).toBe("completed")
      expect(asked).toBe(false) // legacy flat deny never asks
      expect(counts.peek).toBeUndefined() // never dispatched
      // Legacy flat deny tool_result is present…
      const denied = allToolResults(outcome).filter(
        (b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG),
      )
      expect(denied).toHaveLength(1)
      // …and ZERO P3 escalation events (byte-identical to ADR-0011).
      expect(stream.events.some((e) => e.type === "permission_escalation_requested")).toBe(false)
      expect(stream.events.some((e) => e.type === "permission_escalation_resolved")).toBe(false)
    } finally {
      if (prevV2 === undefined) delete process.env.QUANTA_SKILL_SCOPE_V2
      else process.env.QUANTA_SKILL_SCOPE_V2 = prevV2
      __resetRuntimeConfig()
    }
  })

  test("L1 availability filter — the LLM tool list is NARROWED to in-scope once a skill is armed", async () => {
    await sealedSkill(dir)
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingTool("danger", counts), countingToolRO("grep", counts)])
    // Capture the tool names sent to the model on EACH turn.
    const toolsPerTurn: string[][] = []
    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("g1", "grep", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
      skills: { dir },
      onTurnStreamInput: (input) => toolsPerTurn.push(input.tools.map((t) => t.name)),
    })

    // Turn 1 (before the skill armed) sees the full menu incl. the ordinary tool.
    expect(toolsPerTurn[0]).toContain("danger")
    // A later turn (after Skill(sealed) armed the scope) has `danger` FILTERED OUT
    // — the model literally cannot see it — while nav-base `grep` remains visible.
    const armedTurn = toolsPerTurn.slice(1).find((names) => !names.includes("danger"))
    expect(armedTurn).toBeDefined()
    expect(armedTurn).toContain("grep") // nav-base stays visible
    expect(armedTurn).toContain("Skill") // meta stays visible
  })

  test("user DECLINES the escalation ⇒ tool not dispatched; decision=declined; preview labeled", async () => {
    await sealedSkill(dir)
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingToolRO("peek", counts)])
    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("p1", "peek", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
      skills: { dir },
      onConfirm: async () => false, // decline
    })

    expect(counts.peek).toBeUndefined() // not dispatched
    const res = stream.events.filter((e) => e.type === "permission_escalation_resolved")
    expect(res[0]?.type === "permission_escalation_resolved" ? res[0].decision : "").toBe("deny")
    // The tool_result is labeled "declined", and the model is told to use a permitted tool.
    const tr = stream.events.find((e) => e.type === "tool_result" && e.id === "p1")
    expect(tr?.type === "tool_result" ? tr.preview : "").toBe("skill-scoped: declined")
    const msg = allToolResults(outcome).find((b) => b.type === "tool_result" && b.tool_use_id === "p1")
    expect(msg?.type === "tool_result" ? msg.content : "").toContain("Declined")
  })

  test("deny_and_steer ⇒ tool not dispatched; decision=steered; steer reaches the tool_result", async () => {
    await sealedSkill(dir)
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingToolRO("peek", counts)])
    const llm = new FakeLLM([
      toolUseScript("s1", "Skill", { name: "sealed" }),
      toolUseScript("p1", "peek", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "default" }),
      skills: { dir },
      onConfirm: async () => ({ decision: "deny_and_steer", steer: "use grep instead" }),
    })

    expect(counts.peek).toBeUndefined() // not dispatched
    const res = stream.events.filter((e) => e.type === "permission_escalation_resolved")
    expect(res[0]?.type === "permission_escalation_resolved" ? res[0].decision : "").toBe(
      "deny_and_steer",
    )
    const msg = allToolResults(outcome).find((b) => b.type === "tool_result" && b.tool_use_id === "p1")
    expect(msg?.type === "tool_result" ? msg.content : "").toContain("use grep instead")
  })
})
