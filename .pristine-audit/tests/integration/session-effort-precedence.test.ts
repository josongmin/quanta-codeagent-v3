/**
 * Hellgate (skill > session > default, session effort fold-in for ADR-???):
 *
 * Validates the new `AgentConfig.sessionEffort` slot wired into the loop's
 * `resolveSkillTurnOverride`. Mirrors the structure of
 * `loop-skill-override.test.ts` (the L4 ENFORCEMENT integration that already
 * covers skill > default) — this file adds the SESSION rung in the middle.
 *
 * Adversarial cases:
 *   (a) sessionEffort: "high", no skill                ⇒ every turn carries
 *       budget 16384 (session wins; byte-identical otherwise).
 *   (b) sessionEffort: "high", skill effort: "low"     ⇒ skill wins (1024).
 *   (c) sessionEffort: "high", skill model-only (no
 *       `effort:` in frontmatter)                       ⇒ swapped port runs
 *       with the SESSION budget (16384 — fall-through).
 *   (d) sessionEffort: "default"                        ⇒ no `thinking` field
 *       (named "default" tier maps to undefined budget, byte-identical).
 *   (e) sessionEffort returns undefined (e.g. store
 *       was deleted)                                    ⇒ no `thinking`.
 *   (f) skill numeric effort 0 + session "high"        ⇒ no `thinking`
 *       (non-positive numeric is an explicit "off" — does NOT fall through,
 *       byte-identical to the pre-session-effort skill branch).
 *   (g) skill frontmatter omitting `effort:` entirely
 *       + session "high"                                ⇒ session "high"
 *       applies on every turn (skill SILENCE = fall through, distinct from
 *       skill EXPLICIT off in case (f)).
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

describe("session-effort precedence — skill > session > default", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-effort-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("(a) sessionEffort=high alone ⇒ every turn carries budget 16384", async () => {
    const base = new RecordingLLM("base", [finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        sessionEffort: () => "high",
      }),
    )
    expect(base.inputs.length).toBeGreaterThanOrEqual(1)
    for (const i of base.inputs) {
      expect(i.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
    }
  })

  test("(b) skill effort 'low' beats session 'high'", async () => {
    await mkdir(join(dir, "small"), { recursive: true })
    await writeFile(
      join(dir, "small", "SKILL.md"),
      "---\nname: small\ndescription: lower\neffort: low\n---\nthink less\n",
    )
    const base = new RecordingLLM("base", [invokeSkill("s1", "small"), finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        sessionEffort: () => "high",
      }),
    )
    // Turn 1 — skill not yet armed → session "high" applies → 16384.
    expect(base.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
    // Turn 2 — `small` is armed → skill "low" beats session → 1024.
    expect(base.inputs[1]?.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  test("(c) skill model-only (no `effort:`) falls through to session budget", async () => {
    await mkdir(join(dir, "swap"), { recursive: true })
    await writeFile(
      join(dir, "swap", "SKILL.md"),
      "---\nname: swap\ndescription: model only\nmodel: other-model\n---\nswap port\n",
    )
    const base = new RecordingLLM("base", [invokeSkill("s1", "swap"), finishText("base done")])
    const other = new RecordingLLM("other-model", [finishText("on swap")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        modelCandidates: [{ id: "other-model", port: other }],
        sessionEffort: () => "high",
      }),
    )
    // Swap port should run once with session "high" budget folded in
    // (skill didn't declare effort).
    expect(other.calls).toBe(1)
    expect(other.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
  })

  test("(d) sessionEffort='default' ⇒ no thinking field (byte-identical baseline)", async () => {
    const base = new RecordingLLM("base", [finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        sessionEffort: () => "default",
      }),
    )
    for (const i of base.inputs) expect(i.thinking).toBeUndefined()
  })

  test("(e) sessionEffort returns undefined ⇒ no thinking", async () => {
    const base = new RecordingLLM("base", [finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        sessionEffort: () => undefined,
      }),
    )
    for (const i of base.inputs) expect(i.thinking).toBeUndefined()
  })

  test("(f) skill numeric effort 0 explicit ⇒ wins over session, no thinking", async () => {
    // The skill frontmatter parser silently DROPS `effort: default` (it only
    // accepts low|medium|high|max or a numeric). To exercise the loop's
    // "explicit no thinking" branch, use a numeric 0 — which the parser DOES
    // forward as a `0` and the loop treats as explicit-off (does NOT fall
    // through to session).
    await mkdir(join(dir, "zero"), { recursive: true })
    await writeFile(
      join(dir, "zero", "SKILL.md"),
      "---\nname: zero\ndescription: explicit zero budget\neffort: 0\n---\nno think\n",
    )
    const base = new RecordingLLM("base", [invokeSkill("s1", "zero"), finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        sessionEffort: () => "high",
      }),
    )
    // Turn 1 (skill not yet armed) sees session "high".
    expect(base.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
    // Turn 2 (skill armed with numeric 0) drops the thinking field.
    expect(base.inputs[1]?.thinking).toBeUndefined()
  })

  test("(g) skill frontmatter omitting effort ⇒ falls through to session 'high'", async () => {
    // Sibling of (c) but without a `model:` swap — proves that a skill with
    // NO override at all (just name + description) still lets the session
    // effort flow through to the per-turn LLMInput. Documents the precedence:
    // skill SILENCE on effort = fall through to session.
    await mkdir(join(dir, "silent"), { recursive: true })
    await writeFile(
      join(dir, "silent", "SKILL.md"),
      "---\nname: silent\ndescription: no override\n---\nordinary skill\n",
    )
    const base = new RecordingLLM("base", [invokeSkill("s1", "silent"), finishText("done")])
    await runAgent(
      cfg({
        llm: base,
        cwd: dir,
        skills: { dir },
        sessionEffort: () => "high",
      }),
    )
    // Every turn carries the session "high" budget (16384).
    expect(base.inputs.length).toBeGreaterThanOrEqual(2)
    for (const i of base.inputs) {
      expect(i.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
    }
  })
})
