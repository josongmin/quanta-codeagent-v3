import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { buildSessionFeatures } from "../../src/agent/features"
import type { AgentConfig } from "../../src/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"
import { AutoModeClassifier } from "../../src/permission"
import type { Tool, ToolEvent } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"

/** Inert LLM stub — features never streams; it only stores the port. */
const inertLLM: LLMPort = {
  // biome-ignore lint/correctness/useYield: never invoked in these tests
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

/** Assert a value is present, throwing otherwise — same fail-on-missing
 *  contract the previous `x!` non-null assertions had, with an explicit
 *  runtime guard instead of a compile-only assertion. */
const must = <T>(v: T | undefined | null, what = "value"): T => {
  if (v === undefined || v === null) throw new Error(`expected ${what} to be present`)
  return v
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const baseRegistry = (): ToolRegistry => new ToolRegistry([fakeTool("read"), fakeTool("write")])

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: baseRegistry(),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 10,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const names = (tools: Tool[]): string[] => tools.map((t) => t.name).sort()

const tmpDirs: string[] = []
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
})

describe("buildSessionFeatures", () => {
  test("no Tier-1 config ⇒ empty result (loop byte-identical)", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(f.extraTools).toEqual([])
    expect(f.classifier).toBeUndefined()
    expect(f.taskRegistry).toBeUndefined()
  })

  test("subagent-only ⇒ 3 tools sharing ONE TaskRegistry instance", async () => {
    const f = await buildSessionFeatures(cfg({ subagent: { maxDepth: 2 } }))
    expect(names(f.extraTools)).toEqual(["agent", "task_output", "task_stop"])
    expect(f.taskRegistry).toBeDefined()
    expect(f.classifier).toBeUndefined()

    // Identity proof: the `agent` tool exposes `.registry`; it must be the
    // SAME object returned as `taskRegistry`, and the Task* tools must observe
    // tasks registered through it.
    const agentTool = f.extraTools.find((t) => t.name === "agent") as Tool & {
      registry: import("../../src/subagent").TaskRegistry
    }
    const taskRegistry = must(f.taskRegistry, "taskRegistry")
    expect(agentTool.registry).toBe(taskRegistry)

    const id = taskRegistry.newId()
    taskRegistry.register({ id, description: "probe" })
    const out = must(
      f.extraTools.find((t) => t.name === "task_output"),
      "task_output tool",
    )
    let observed = ""
    for await (const ev of out.execute(
      { task_id: id },
      {
        cwd: "/repo",
        signal: new AbortController().signal,
      },
    )) {
      if (ev.type === "result") observed = ev.result.output
    }
    expect(observed).toContain(id)
    expect(observed).toContain("running")
  })

  test("subagent without maxDepth ⇒ still wires 3 tools", async () => {
    const f = await buildSessionFeatures(cfg({ subagent: {} }))
    expect(names(f.extraTools)).toEqual(["agent", "task_output", "task_stop"])
    expect(f.taskRegistry).toBeDefined()
  })

  test("skills-only over a temp fixture dir ⇒ Skill + ToolSearch tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-skills-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "demo"), { recursive: true })
    await writeFile(
      join(dir, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\n---\nDemo body.\n",
    )

    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    expect(names(f.extraTools)).toEqual(["Skill", "ToolSearch"])

    // The Skill tool's description should advertise the discovered skill.
    const skill = must(
      f.extraTools.find((t) => t.name === "Skill"),
      "Skill tool",
    )
    expect(skill.description).toContain("demo")
    // ADR-0045: bundled system skills (e.g. `progress-audit`) are merged in
    // unconditionally when `config.skills` is set. The user-supplied `demo`
    // and the system `progress-audit` are both advertised.
    expect(skill.description).toContain("progress-audit")
  })

  test("missing skills dir ⇒ tools STILL registered (documented behavior)", async () => {
    const f = await buildSessionFeatures(cfg({ skills: { dir: "/no/such/dir/at/all" } }))
    expect(names(f.extraTools)).toEqual(["Skill", "ToolSearch"])
    const skill = must(
      f.extraTools.find((t) => t.name === "Skill"),
      "Skill tool",
    )
    // ADR-0045: even when the user dir is missing, bundled system skills are
    // still discovered — so the catalogue is non-empty.
    expect(skill.description).toContain("progress-audit")
  })

  test("ToolSearch tool ranks the live registry catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-ts-"))
    tmpDirs.push(dir)
    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    const ts = must(
      f.extraTools.find((t) => t.name === "ToolSearch"),
      "ToolSearch tool",
    )
    let output = ""
    for await (const ev of ts.execute(
      { query: "select:read" },
      { cwd: "/repo", signal: new AbortController().signal },
    )) {
      if (ev.type === "result") output = ev.result.output
    }
    expect(output).toContain("read")
  })

  test("permission.mode === 'auto' ⇒ AutoModeClassifier built", async () => {
    const f = await buildSessionFeatures(cfg({ permission: { mode: "auto" } }))
    expect(f.classifier).toBeInstanceOf(AutoModeClassifier)
    expect(f.extraTools).toEqual([])
    // Built with a real (LLM-backed) port: it must NOT degrade to the
    // no-port fallback; denial state starts clean.
    const classifier = must(f.classifier, "classifier")
    expect(classifier.isCircuitBroken()).toBe(false)
    expect(classifier.getDenialState()).toEqual({
      consecutiveDenials: 0,
      totalDenials: 0,
    })
  })

  test("non-auto permission modes ⇒ no classifier", async () => {
    for (const mode of ["default", "acceptEdits", "bypass"] as const) {
      const f = await buildSessionFeatures(cfg({ permission: { mode } }))
      expect(f.classifier).toBeUndefined()
    }
  })

  test("combined config ⇒ all features present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-all-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "s"), { recursive: true })
    await writeFile(join(dir, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nbody\n")

    const f = await buildSessionFeatures(
      cfg({
        subagent: { maxDepth: 3 },
        skills: { dir },
        permission: { mode: "auto" },
      }),
    )
    expect(names(f.extraTools)).toEqual([
      "Skill",
      "ToolSearch",
      "agent",
      "task_output",
      "task_stop",
    ])
    expect(f.taskRegistry).toBeDefined()
    expect(f.classifier).toBeInstanceOf(AutoModeClassifier)
  })

  test("does not mutate the caller's registry", async () => {
    const c = cfg({ subagent: {}, skills: { dir: "/missing" } })
    const before = c.registry.specs().map((s) => s.name)
    await buildSessionFeatures(c)
    expect(c.registry.specs().map((s) => s.name)).toEqual(before)
  })

  // --- Skill tool-scoping ENFORCEMENT data (ADR-0011) --------------------

  test("skillAllowlists: ONLY scoped skill present, no-tools skill absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-allow-"))
    tmpDirs.push(dir)
    // Scoped skill: declares an inline `tools:` allowlist.
    await mkdir(join(dir, "scoped"), { recursive: true })
    await writeFile(
      join(dir, "scoped", "SKILL.md"),
      '---\nname: scoped\ndescription: scoped skill\ntools: ["Read"]\n---\nScoped body.\n',
    )
    // Unscoped skill: NO `tools:` key at all.
    await mkdir(join(dir, "open"), { recursive: true })
    await writeFile(
      join(dir, "open", "SKILL.md"),
      "---\nname: open\ndescription: open skill\n---\nOpen body.\n",
    )

    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    const al = must(f.skillAllowlists, "skillAllowlists")
    expect(al).toBeInstanceOf(Map)
    // The user-declared scoped skill is present with its exact list.
    expect(al.get("scoped")).toEqual(["Read"])
    // The no-tools skill must NOT appear.
    expect(al.has("open")).toBe(false)
    // ADR-0045: the bundled `progress-audit` system skill also declares
    // `tools:`, so it appears in the allowlist map alongside user skills.
    expect(al.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])
    // Tools themselves are still registered regardless of scoping.
    expect(names(f.extraTools)).toEqual(["Skill", "ToolSearch"])
  })

  test("skillAllowlists: multi-tool inline list preserved verbatim & in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-allow-multi-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "multi"), { recursive: true })
    await writeFile(
      join(dir, "multi", "SKILL.md"),
      '---\nname: multi\ndescription: d\ntools: ["Read", "Grep", "Glob"]\n---\nbody\n',
    )
    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    const al = must(f.skillAllowlists, "skillAllowlists")
    expect(al.get("multi")).toEqual(["Read", "Grep", "Glob"])
  })

  test("skillAllowlists: only system-skill entries when no user skill declares tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-noallow-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "a"), { recursive: true })
    await writeFile(join(dir, "a", "SKILL.md"), "---\nname: a\ndescription: d\n---\nbody\n")
    await mkdir(join(dir, "b"), { recursive: true })
    await writeFile(join(dir, "b", "SKILL.md"), "---\nname: b\ndescription: d\n---\nbody\n")
    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    // ADR-0045: bundled `progress-audit` declares `tools:` so the map exists,
    // populated only with system-skill entries. Pre-0045 contract was
    // `undefined` here, but the addition is opt-in via `config.skills`.
    const al = must(f.skillAllowlists, "skillAllowlists")
    expect(al.has("a")).toBe(false)
    expect(al.has("b")).toBe(false)
    expect(al.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])
    // Tools still registered (gate is gated on config.skills, not contents).
    expect(names(f.extraTools)).toEqual(["Skill", "ToolSearch"])
  })

  test("skillAllowlists: absent when skills not configured at all", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(f.skillAllowlists).toBeUndefined()
  })

  test("skillAllowlists: empty `tools: []` is treated as no allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feat-emptylist-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "e"), { recursive: true })
    await writeFile(
      join(dir, "e", "SKILL.md"),
      "---\nname: e\ndescription: d\ntools: []\n---\nbody\n",
    )
    const f = await buildSessionFeatures(cfg({ skills: { dir } }))
    // skillToolAllowlist returns undefined for the empty-list user skill; the
    // bundled `progress-audit` is still present (ADR-0045).
    const al = must(f.skillAllowlists, "skillAllowlists")
    expect(al.has("e")).toBe(false)
    expect(al.get("progress-audit")).toEqual(["Read", "Grep", "Bash"])
  })

  // --- Phase 6: Codex memory L3 (workingState) ---------------------------

  test("workingState absent ⇒ tool NOT registered, no session (byte-identical)", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(names(f.extraTools)).not.toContain("update_working_state")
    expect(f.workingState).toBeUndefined()
  })

  test("workingState.enabled=false ⇒ tool NOT registered", async () => {
    const f = await buildSessionFeatures(cfg({ workingState: { enabled: false } }))
    expect(names(f.extraTools)).not.toContain("update_working_state")
    expect(f.workingState).toBeUndefined()
  })

  test("workingState.enabled=true ⇒ tool registered, session built", async () => {
    const f = await buildSessionFeatures(cfg({ workingState: { enabled: true } }))
    expect(names(f.extraTools)).toContain("update_working_state")
    expect(f.workingState).toBeDefined()
    // The tool's closure shares state with the returned session: mutating via
    // the tool reflects in the session's snapshot.
    const tool = must(
      f.extraTools.find((t) => t.name === "update_working_state"),
      "update_working_state tool",
    )
    for await (const _ev of tool.execute(
      { ownerShortlist: [{ file: "a.ts", reason: "p" }] } as Parameters<typeof tool.execute>[0],
      { cwd: "/repo", signal: new AbortController().signal },
    )) {
      // consume
    }
    expect(must(f.workingState, "workingState").snapshot().ownerShortlist).toEqual([
      { file: "a.ts", reason: "p" },
    ])
  })
})
