/**
 * Integration: end-to-end discovery + tool-scoping for the bundled
 * `progress-audit` system skill (ADR-0045).
 *
 * Three contracts pinned:
 *   1. `buildSessionFeatures({ skills: { dir } })` returns the bundled
 *      `progress-audit` skill via the `Skill` tool's catalogue regardless of
 *      what (if anything) the user populated in their `skills.dir`.
 *   2. The skill's allowedTools enforcement is wired: invoking the `Skill`
 *      tool with `name: "progress-audit"` arms a gate that permits only
 *      Read/Grep/Bash. A disallowed tool MUST be denied as a recoverable
 *      tool_result and NOT actually executed (counting-stub proof).
 *   3. The user's own SKILL.md and the system progress-audit coexist —
 *      neither shadows the other, and system skills WIN on a name collision
 *      so a user cannot impersonate `progress-audit` with a weaker version.
 *
 * Deterministic: scripted fake LLM, no network, temp skill dir cleaned up.
 * Modeled on `tests/integration/skill-scope-e2e.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { findProgressAuditSkill, PROGRESS_AUDIT_SKILL_NAME, triggerProgressAudit } from "@/skill"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { buildSessionFeatures } from "../../src/agent/features"

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

/** A counting stub tool — `counts[name]` only increments when execute()
 *  actually runs, so scope-denied dispatches keep the counter at 0. */
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

describe("progress-audit system skill — discovery + scoping (e2e)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-system-e2e-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("buildSessionFeatures returns progress-audit in the Skill catalogue", async () => {
    const inertLLM: LLMPort = {
      // biome-ignore lint/correctness/useYield: never invoked in this test
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("unused")
      },
    }
    const registry = new ToolRegistry([])
    const cfg: AgentConfig = {
      llm: inertLLM,
      registry,
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "SYS",
      cwd: "/repo",
      maxTurns: 10,
      signal: new AbortController().signal,
      skills: { dir },
    }
    const features = await buildSessionFeatures(cfg)
    const skillTool = features.extraTools.find((t) => t.name === "Skill")
    expect(skillTool).toBeDefined()
    // The Skill tool's description embeds the catalogue ("- name: desc").
    expect(skillTool?.description).toContain("progress-audit")
    expect(skillTool?.description).toContain("진행률")

    // The host-enforcement allowlist map MUST contain progress-audit's three
    // tools so the dispatch gate can enforce them when the skill is invoked.
    const al = features.skillAllowlists
    expect(al).toBeDefined()
    expect(al?.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])

    // activeSkills (per-turn reminder inventory) must include progress-audit
    // so the model sees the trigger description in the dynamic reminder.
    const pa = features.activeSkills?.find((s) => s.name === "progress-audit")
    expect(pa).toBeDefined()
    expect(pa?.description).toContain("진행률")
  })

  test("invoking progress-audit denies a disallowed tool and permits Read", async () => {
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([
      countingTool("Read", counts),
      countingTool("Edit", counts), // not in progress-audit's allowlist
    ])

    const llm = new FakeLLM([
      // 1. Arm the gate via the bundled system skill.
      toolUseScript("s1", "Skill", { name: "progress-audit" }),
      // 2. Try a disallowed tool — must be DENIED and NOT executed.
      toolUseScript("d1", "Edit", {}),
      // 3. Allowed tool runs normally.
      toolUseScript("r1", "Read", {}),
      // 4. Done.
      textScript("audit-complete"),
    ])
    const stream = new RecordingStream()

    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })

    expect(outcome.reason).toBe("completed")
    // The disallowed tool was NEVER actually dispatched.
    expect(counts.Edit).toBeUndefined()
    // The allowed Read ran once.
    expect(counts.Read).toBe(1)

    const results = allToolResults(outcome)
    const denied = results.filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG))
    expect(denied).toHaveLength(1)
    const d = denied[0]
    if (d?.type === "tool_result") {
      expect(d.is_error).toBe(true)
      expect(d.tool_use_id).toBe("d1")
    }
  })

  test("a user SKILL.md and the system progress-audit coexist; system wins on collision", async () => {
    // Write a user skill named the same as the system one with a weaker
    // allowlist. The system skill MUST win (security-relevant: a user must
    // not be able to shadow progress-audit's audit-discipline body).
    await mkdir(join(dir, "progress-audit"), { recursive: true })
    await writeFile(
      join(dir, "progress-audit", "SKILL.md"),
      [
        "---",
        "name: progress-audit",
        "description: USER OVERRIDE (should not win)",
        'tools: ["Bash"]',
        "---",
        "USER BODY (should not be served).",
      ].join("\n"),
    )
    // Write a coexisting user skill with a distinct name.
    await mkdir(join(dir, "userhelper"), { recursive: true })
    await writeFile(
      join(dir, "userhelper", "SKILL.md"),
      "---\nname: userhelper\ndescription: User helper\n---\nUser body.\n",
    )

    const inertLLM: LLMPort = {
      // biome-ignore lint/correctness/useYield: never invoked in this test
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("unused")
      },
    }
    const registry = new ToolRegistry([])
    const cfg: AgentConfig = {
      llm: inertLLM,
      registry,
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "SYS",
      cwd: dir,
      maxTurns: 10,
      signal: new AbortController().signal,
      skills: { dir },
    }
    const features = await buildSessionFeatures(cfg)
    const al = features.skillAllowlists
    expect(al).toBeDefined()
    // The SYSTEM skill's allowlist (Read/Grep/Bash) wins — NOT the user
    // override's `["Bash"]`. This is the security invariant: a user-supplied
    // skill cannot shadow a system one with a weaker (or different) policy.
    expect(al?.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])
    // The user's distinctly-named skill also appears in the catalogue.
    const userHelper = features.activeSkills?.find((s) => s.name === "userhelper")
    expect(userHelper).toBeDefined()

    // The Skill tool's catalogue must NOT advertise the user's override
    // description for `progress-audit`.
    const skillTool = features.extraTools.find((t) => t.name === "Skill")
    expect(skillTool?.description).not.toContain("USER OVERRIDE")
  })

  test("user skill with malformed frontmatter does not crash discovery; system skill still present", async () => {
    // Authoring mistake: missing closing fence. The lenient parser MUST
    // degrade gracefully — the user skill becomes a stub-ish entry (parser
    // contract documents `body` is the whole post-fence content), but
    // discovery as a whole MUST NOT throw, and the bundled system skill
    // MUST still appear so the audit discipline is preserved even when the
    // user's own skill dir contains a broken file.
    await mkdir(join(dir, "broken"), { recursive: true })
    await writeFile(
      join(dir, "broken", "SKILL.md"),
      ["---", "name: broken", "description: missing closing fence"].join("\n"),
    )

    const cfg: AgentConfig = {
      llm: { async *stream(): AsyncIterable<StreamEvent> {} } as LLMPort,
      registry: new ToolRegistry([]),
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "SYS",
      cwd: dir,
      maxTurns: 10,
      signal: new AbortController().signal,
      skills: { dir },
    }
    const features = await buildSessionFeatures(cfg)
    const skillTool = features.extraTools.find((t) => t.name === "Skill")
    // System skill must still be listed.
    expect(skillTool?.description).toContain("progress-audit")
    // Bundled allowlist still wired.
    expect(features.skillAllowlists?.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])
  })

  test("triggerProgressAudit() arms the SAME gate the LLM-driven path arms", async () => {
    // Equivalence: the router-agnostic helper returns `{ name: "progress-
    // audit" }` and the existing dispatch path treats that input identically
    // to one the LLM would have emitted. Probe: arm via the helper-derived
    // input and verify the deny-on-Edit path triggers the same way the
    // earlier "invoking progress-audit" test exercised.
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([countingTool("Read", counts), countingTool("Edit", counts)])

    const helperInput = triggerProgressAudit()
    // The helper output's `name` MUST match the canonical id.
    expect(helperInput.name).toBe(PROGRESS_AUDIT_SKILL_NAME)
    expect(PROGRESS_AUDIT_SKILL_NAME).toBe("progress-audit")

    const llm = new FakeLLM([
      // Arm via the helper-shaped input.
      toolUseScript("s1", "Skill", helperInput),
      // Disallowed tool — must be denied.
      toolUseScript("d1", "Edit", {}),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
      skills: { dir },
    })
    expect(outcome.reason).toBe("completed")
    expect(counts.Edit).toBeUndefined() // gate denied it
    const denied = allToolResults(outcome).filter(
      (b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG),
    )
    expect(denied).toHaveLength(1)
  })

  test("findProgressAuditSkill() exposes the bundled skill record (host-side preview seam)", async () => {
    // Used by hosts that want to preview the skill body in a planner UI
    // before arming the gate (e.g. show the 6 rules to the user). The
    // returned record MUST match what `buildSessionFeatures` would put on
    // the dispatch path.
    const pa = await findProgressAuditSkill()
    expect(pa).toBeDefined()
    if (!pa) return
    expect(pa.name).toBe(PROGRESS_AUDIT_SKILL_NAME)
    expect(pa.tools).toEqual(["Read", "Grep", "Bash"])
    expect(pa.body).toContain("No finding without code evidence")
    expect(pa.body).toContain("Verify with the narrowest trustworthy command")
  })
})
