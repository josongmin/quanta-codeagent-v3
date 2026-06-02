/**
 * Integration hellgate (ADR-0462): the agent loop ENFORCES the per-mode STICKY
 * model when a `stickyModelStore` is wired at the composition root. Before this
 * slice the slot was a DEAD seam — published but never read — so a sticky
 * per-mode selection never swapped the LLM port. These cases prove the consume
 * site is now LIVE, with an EXPLICIT precedence and a byte-identical
 * default-OFF anchor.
 *
 * MODEL-SWAP PRECEDENCE proved here: `skill override > sticky > default`.
 *
 *  (1) sticky for the active mode → loop streams from the sticky candidate port;
 *  (2) NO sticky for the active mode → default base port (no swap);
 *  (3) unresolvable sticky id (no matching candidate) → default base port, no
 *      crash (advisory degrade);
 *  (4) skill override + sticky BOTH set → SKILL wins (sticky never overrides a
 *      skill's explicit model demand);
 *  (5) store ABSENT → byte-identical regression anchor (every input is the base
 *      port, exactly as the pre-ADR-0462 path);
 *  (6) mode change → the sticky for the NEW active mode is read (the store is
 *      keyed by mode and re-read per turn).
 *
 * Deterministic: scripted LLM doubles, in-memory sticky store, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

/** LLM double recording each StreamInput; yields one script per call (last
 *  repeats). Used both as the base port and as candidate ports. */
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

describe("agent loop — sticky-per-mode model enforcement (ADR-0462)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sticky-model-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("(1) sticky for active mode → loop streams from the sticky candidate port", async () => {
    const base = new RecordingLLM("base-model", [finishText("base done")])
    const sticky = new RecordingLLM("sticky-model", [finishText("from sticky")])
    // default mode (no mode/planMode set) ⇒ store keyed by "default".
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        modelCandidates: [{ id: "sticky-model", port: sticky }],
        stickyModelStore: { store: inMemoryStickyModelStore({ default: "sticky-model" }) },
      }),
    )
    // The very first turn swapped to the sticky candidate; the base never ran.
    expect(sticky.calls).toBe(1)
    expect(base.calls).toBe(0)
  })

  test("(2) NO sticky for active mode → default base port (no swap)", async () => {
    const base = new RecordingLLM("base-model", [finishText("base done")])
    const sticky = new RecordingLLM("sticky-model", [finishText("unused")])
    // Store has an entry for "plan", but the active mode is "default".
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        modelCandidates: [{ id: "sticky-model", port: sticky }],
        stickyModelStore: { store: inMemoryStickyModelStore({ plan: "sticky-model" }) },
      }),
    )
    expect(base.calls).toBe(1)
    expect(sticky.calls).toBe(0)
  })

  test("(3) unresolvable sticky id → default base port, no crash", async () => {
    const base = new RecordingLLM("base-model", [finishText("base done")])
    // Sticky id has NO matching candidate ⇒ advisory degrade to base.
    const outcome = await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        modelCandidates: [{ id: "some-other", port: base }],
        stickyModelStore: { store: inMemoryStickyModelStore({ default: "ghost-model" }) },
      }),
    )
    expect(outcome.reason).toBe("completed")
    expect(base.calls).toBe(1)
  })

  test("(4) skill override + sticky BOTH set → SKILL wins", async () => {
    await mkdir(join(dir, "boost"), { recursive: true })
    await writeFile(
      join(dir, "boost", "SKILL.md"),
      "---\nname: boost\ndescription: escalate\nmodel: boost-model\n---\nb\n",
    )
    // Turn 1 runs on the STICKY port (sticky is set for the active mode and no
    // skill override is armed yet), so the skill invocation must be scripted on
    // the sticky port. After it invokes `boost`, the skill's `model:` override
    // arms — proving on turn 2 that the SKILL demand wins over the sticky default.
    const base = new RecordingLLM("base-model", [finishText("base done")])
    const boost = new RecordingLLM("boost-model", [finishText("boosted")])
    const sticky = new RecordingLLM("sticky-model", [
      invokeSkill("s1", "boost"),
      finishText("from sticky"),
    ])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        modelCandidates: [
          { id: "boost-model", port: boost },
          { id: "sticky-model", port: sticky },
        ],
        // Sticky is set for the active (default) mode too — it must LOSE to the
        // skill's explicit model demand on the post-activation turn.
        stickyModelStore: { store: inMemoryStickyModelStore({ default: "sticky-model" }) },
      }),
    )
    // Turn 2 (after boost armed) streamed from the SKILL's candidate, not sticky.
    expect(boost.calls).toBe(1)
    // Turn 1 had no skill override armed yet, so sticky won that turn.
    expect(sticky.calls).toBe(1)
    // Base port (the global default) never ran — sticky covered turn 1, skill turn 2.
    expect(base.calls).toBe(0)
  })

  test("(5) store ABSENT → byte-identical regression anchor (base port only)", async () => {
    const base = new RecordingLLM("base-model", [finishText("base done")])
    const sticky = new RecordingLLM("sticky-model", [finishText("unused")])
    // No stickyModelStore slot ⇒ the loop must be byte-identical to the legacy
    // skill-only path: every turn streams from the base port, sticky never runs.
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        modelCandidates: [{ id: "sticky-model", port: sticky }],
      }),
    )
    expect(base.calls).toBe(1)
    expect(sticky.calls).toBe(0)
  })

  test("(6) mode change (plan) → reads the sticky for the new active mode", async () => {
    const base = new RecordingLLM("base-model", [finishText("base done")])
    const planSticky = new RecordingLLM("plan-model", [finishText("from plan sticky")])
    // Active mode is plan; the store has DISTINCT entries per mode. Only the
    // plan entry should be read — proving the read is keyed by the active mode.
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        mode: "plan",
        modelCandidates: [{ id: "plan-model", port: planSticky }],
        stickyModelStore: {
          store: inMemoryStickyModelStore({ plan: "plan-model", default: "default-model" }),
        },
      }),
    )
    expect(planSticky.calls).toBe(1)
    expect(base.calls).toBe(0)
  })
})
