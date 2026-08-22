/**
 * Integration (ADR-0011 §6.2 L3→L4): the loop ENFORCES a skill's author-declared
 * model/effort override on the turn AFTER the skill is invoked.
 *
 * Inheritance: skill > session config > default.
 *
 *  (a) a skill declaring `model:` + `effort:` ⇒ the next turn streams from the
 *      matching `config.modelCandidates` port AND carries a `thinking` budget
 *      derived from the effort tier;
 *  (b) a sibling skill declaring NO override ⇒ clears the override back to the
 *      session/default path (base port, no `thinking`);
 *  (c) control: a skill set with no overrides at all leaves every turn
 *      byte-identical (base port, no `thinking`).
 *
 * Deterministic: scripted LLM doubles, temp skill dirs, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

/** LLM double that records each StreamInput and yields one script per call
 *  (last repeats). Used both as the base port and as a candidate port. */
class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private last: StreamEvent[] = []
  constructor(
    readonly model: string,
    private readonly scripts: StreamEvent[][],
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const e of next ?? this.last) yield e
  }
}

const invokeSkill = (id: string, name: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "Skill" },
  { type: "tool_use_end", id, input: { name } },
  { type: "message_stop", stop_reason: "tool_use" },
]
const finishText = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm" | "cwd">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" },
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  system: "test",
  maxTurns: 8,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

describe("agent loop — skill model/effort override enforcement (ADR-0011 §6.2)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-override-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("(a) skill with model+effort → next turn uses candidate port + thinking budget", async () => {
    await mkdir(join(dir, "boost"), { recursive: true })
    await writeFile(
      join(dir, "boost", "SKILL.md"),
      "---\nname: boost\ndescription: escalate\nmodel: boost-model\neffort: high\n---\nThink harder.\n",
    )
    // Base port: turn-1 invokes the skill, then a defensive completion.
    const base = new RecordingLLM("base-model", [
      invokeSkill("s1", "boost"),
      finishText("base done"),
    ])
    // Candidate port (id === skill's `model:`): yields the post-activation turn.
    const boost = new RecordingLLM("boost-model", [finishText("boosted")])

    const outcome = await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        modelCandidates: [{ id: "boost-model", port: boost }],
      }),
    )
    expect(outcome.reason).toBe("completed")
    // Turn 1 ran on the base port (override not yet armed).
    expect(base.inputs[0]?.thinking).toBeUndefined()
    // Turn 2 streamed from the SWAPPED candidate port, NOT the base port.
    expect(boost.calls).toBe(1)
    // …and carried the `high` effort tier's thinking budget (16384).
    expect(boost.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
  })

  test("(b) sibling skill with no override clears it back to base port / no thinking", async () => {
    await mkdir(join(dir, "boost"), { recursive: true })
    await mkdir(join(dir, "plain"), { recursive: true })
    await writeFile(
      join(dir, "boost", "SKILL.md"),
      "---\nname: boost\ndescription: escalate\nmodel: boost-model\neffort: high\n---\nb\n",
    )
    await writeFile(
      join(dir, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: ordinary\n---\np\n",
    )
    // base: invoke boost, then invoke plain, then a defensive completion.
    const base = new RecordingLLM("base-model", [
      invokeSkill("s1", "boost"),
      invokeSkill("s2", "plain"),
      finishText("base done"),
    ])
    const boost = new RecordingLLM("boost-model", [
      // After boost is armed, this turn invokes `plain` (which clears override).
      invokeSkill("s2", "plain"),
    ])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        modelCandidates: [{ id: "boost-model", port: boost }],
      }),
    )
    // The boost candidate ran exactly once (the turn right after boost armed it,
    // which invoked `plain`). The FOLLOWING turn — after `plain` cleared the
    // override — must fall back to the base port with no thinking budget.
    expect(boost.calls).toBe(1)
    const lastBase = base.inputs[base.inputs.length - 1]
    expect(lastBase?.thinking).toBeUndefined()
  })

  test("(c) control: skills with no overrides ⇒ every turn byte-identical (base port, no thinking)", async () => {
    await mkdir(join(dir, "plain"), { recursive: true })
    await writeFile(
      join(dir, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: ordinary\n---\np\n",
    )
    const base = new RecordingLLM("base-model", [invokeSkill("s1", "plain"), finishText("done")])
    await runAgent(cfg({ llm: base, cwd: dir, skills: { dir } }))
    for (const i of base.inputs) expect(i.thinking).toBeUndefined()
  })
})
