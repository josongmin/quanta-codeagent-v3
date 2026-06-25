import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, loadRepoRules, type RepoRules, runAgent } from "@/agent"
import { CLOSEOUT_REMINDER } from "@/agent/closeout-guard"
import type { Message } from "@/llm"
import {
  FakeLLM,
  ScriptedLLM as HarnessScriptedLLM,
  baseConfig as harnessBaseConfig,
  NullStream,
  type TurnScript,
  text,
  turnScript,
} from "./_harness"

/**
 * Phase 8 — Codex absorption end-to-end integration check.
 *
 * Confirms three things across the seven Phases:
 *   1. ALL new optional fields can be set together without breaking the loop.
 *   2. The per-turn reminder block ordering matches the Codex trust ladder:
 *      mode → repo-rules → active skills → working state → memory hints.
 *   3. The default-OFF byte-identical contract holds — a fresh config with
 *      none of the new fields set yields a reminder whose only blocks are
 *      the legacy ones (date, cwd).
 *
 * Implementation note: a single-turn end-to-end test against a `FakeLLM`
 * lets every Phase assert from its own slice without standing up a real
 * provider; the reminder tail is the cleanest cross-Phase observation point.
 *
 * Helper bridge: the original local `ScriptedLLM` took a `Script[]` (text vs
 * tool_use variants) and yielded an extra `tool_use_delta` between start/end.
 * Migration uses the harness `ScriptedLLM` (which consumes `Step[]`) plus the
 * harness `turnScript` converter — the omitted `tool_use_delta` is benign
 * (the loop reads only `tool_use_end.input`).
 */

class ScriptedLLM extends HarnessScriptedLLM {
  constructor(scripts: TurnScript[]) {
    super(turnScript(scripts))
  }
}

const reminderText = (messages: Message[]): string => {
  // The per-turn `<system-reminder>` is the FINAL user message of every
  // assembled request — that's the ordering invariant `buildTurnContext`
  // documents.
  const tail = messages[messages.length - 1]
  if (!tail || tail.role !== "user") return ""
  const block = tail.content[0]
  return block?.type === "text" ? block.text : ""
}

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  harnessBaseConfig({
    llm: overrides.llm ?? new FakeLLM([text("ok")]),
    stream: new NullStream(),
    permission: { mode: "bypass" },
    messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    system: "TEST_SYSTEM",
    cwd: "/repo",
    maxTurns: 1,
    ...overrides,
  })

describe("Phase 8 — default-OFF byte-identical", () => {
  test("no new fields ⇒ reminder carries ONLY date + cwd (legacy)", async () => {
    const llm = new FakeLLM()
    const config = baseConfig({ llm })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    const reminder = reminderText(llm.seenMessages[0] ?? [])
    expect(reminder).toContain("Today's date is")
    expect(reminder).toContain("Working directory: /repo")
    // None of the Phase blocks should appear.
    expect(reminder).not.toContain("PLAN MODE")
    expect(reminder).not.toContain("REVIEW MODE")
    expect(reminder).not.toContain("AUDIT MODE")
    expect(reminder).not.toContain("Repo-local rules")
    expect(reminder).not.toContain("Active skills")
    expect(reminder).not.toContain("Working state")
    expect(reminder).not.toContain("Memory hints")
  })
})

describe("Phase 8 — all Phases ON compose cleanly", () => {
  let cwd: string
  let rules: RepoRules

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "qct-sota-full-"))
    await writeFile(
      join(cwd, "AGENTS.md"),
      "no heuristics; fail-closed; front-door build only",
      "utf8",
    )
    const loaded = await loadRepoRules(cwd)
    if (!loaded) throw new Error("expected AGENTS.md to load")
    rules = loaded
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test("review mode + repo rules + closeout 4-rule + HITL + working state coexist", async () => {
    // W1-B audit fix: previous body set `closeoutGuard.fourRule:true` and
    // `hitl.enabled:true` but never asserted either had any effect — a
    // single-turn FakeLLM finished with `end_turn` and the closeout guard
    // had no chance to fire, so removing both options entirely would have
    // kept this test green. Two structural changes:
    //   (a) Use the ScriptedLLM (defined in the Phase 4 describe below) to
    //       drive a real finish-then-retry sequence so closeout-guard trips
    //       and we can assert its forced 4-rule reminder.
    //   (b) Assert that EACH opt-in produces a visible effect: mode notice,
    //       repo-rules block, AND closeout-guard's 4-rule meta-user message
    //       in the final transcript. (`workingState` is exercised by a
    //       dedicated round-trip test below; `hitl.enabled` doesn't fire
    //       without a tool call — covered by `hitl-tier.test.ts` dispatch
    //       tests at the unit level.)
    const llm = new ScriptedLLM([
      // Turn 1: model attempts to finish immediately — closeout-guard trips.
      { type: "text", text: "done" },
      // Turn 2: re-stream after the nudge — finish for real.
      { type: "text", text: "actually done" },
    ])
    const stream = new NullStream()
    const config = baseConfig({
      llm,
      cwd,
      stream,
      mode: "review",
      repoRules: rules,
      closeoutGuard: { enabled: true, fourRule: true },
      hitl: { enabled: true },
      workingState: { enabled: true },
      maxTurns: 5,
    })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    // Mode notice + repo-rules block appear in the FIRST outgoing reminder.
    const reminder = reminderText(llm.seenMessages[0] ?? [])
    expect(reminder).toContain("REVIEW MODE is active")
    expect(reminder).toContain("findings-first")
    expect(reminder).toContain("## Repo-local rules (from AGENTS.md)")
    expect(reminder).toContain("no heuristics; fail-closed")

    // closeout-guard ACTUALLY fired: a single `closeout` recovery event was
    // emitted and the forced meta-user message carries the 4-rule reminder
    // text (NOT the legacy one-liner — `fourRule:true` is honored).
    const closeoutRecoveries = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "closeout",
    )
    expect(closeoutRecoveries).toHaveLength(1)
    const forced = out.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("R1 Read-source")),
    )
    expect(forced).toBeDefined()
  })

  test("reminder block ORDER matches the trust ladder", async () => {
    // Trust ladder: mode notice → repo-rules → active skills → working state
    //  → memory hints. We exercise mode + repo-rules + working state in this
    // test (skills require a SKILL.md directory; memory requires a store —
    // both are covered in their own per-Phase tests).
    const llm = new FakeLLM()
    const config = baseConfig({
      llm,
      cwd,
      mode: "audit",
      repoRules: rules,
      workingState: { enabled: true },
    })
    await runAgent(config)

    const reminder = reminderText(llm.seenMessages[0] ?? [])
    const auditIdx = reminder.indexOf("AUDIT MODE is active")
    const repoIdx = reminder.indexOf("## Repo-local rules")
    expect(auditIdx).toBeGreaterThan(-1)
    expect(repoIdx).toBeGreaterThan(-1)
    // mode notice precedes repo-rules (mode is interaction-shape; repo-rules
    // is authority — both above the routing-hint tier).
    expect(auditIdx).toBeLessThan(repoIdx)
  })

  test("legacy planMode:true and mode:'plan' produce the SAME mode notice", async () => {
    const llmA = new FakeLLM()
    const llmB = new FakeLLM()
    await runAgent(baseConfig({ llm: llmA, planMode: true }))
    await runAgent(baseConfig({ llm: llmB, mode: "plan" }))
    const a = reminderText(llmA.seenMessages[0] ?? [])
    const b = reminderText(llmB.seenMessages[0] ?? [])
    expect(a).toContain("PLAN MODE is active")
    expect(b).toContain("PLAN MODE is active")
  })
})

/**
 * De-heuristicized closeout routing through the loop. The closeout reminder is
 * NO LONGER selected by a tool-name scan over history (that heuristic was
 * over- and under-inclusive). Every enabled non-`fourRule` session now
 * receives the SAME UNION self-check — the general defended-claim guidance PLUS
 * the self-select code-modification four-surface walk. These integration
 * checks pin the wired-through path: both a mutating session and a
 * non-mutating session get the identical complete reminder.
 */
describe("closeout reminder is the UNION self-check (no history route) through the loop", () => {
  // A scripted LLM that takes a list of "scripts" (one per turn) and yields the
  // events for the current turn each time `.stream()` is called. Each script
  // is `{type:"text", text}` (a finish attempt) or `{type:"tool_use", id, name,
  // ScriptedLLM is declared at module scope (above) so multiple describe
  // blocks can drive multi-turn LLM scripts. The aliases below keep the
  // existing inner-describe references intact without a rename churn.
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "qct-sota-closeout-"))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test("session that called `write` then attempts to finish ⇒ UNION self-check injected", async () => {
    const file = join(cwd, "patched.txt")
    const llm = new ScriptedLLM([
      // Turn 1: mutate source.
      { type: "tool_use", id: "c1", name: "write", input: { path: file, content: "new" } },
      // Turn 2: model tries to finish — closeout-guard should block ONCE and
      // inject the UNION self-check.
      { type: "text", text: "done" },
      // Forced re-stream of turn 2: finish for real.
      { type: "text", text: "actually done" },
    ])
    const stream = new NullStream()
    const config = baseConfig({
      llm,
      cwd,
      stream,
      maxTurns: 5,
      closeoutGuard: { enabled: true, fourRule: false },
    })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    // Exactly one `closeout` recovery happened (single-shot).
    const closeout = stream.events.filter((e) => e.type === "recovery" && e.reason === "closeout")
    expect(closeout).toHaveLength(1)

    // The injected nudge is the UNION self-check (general defended-claim
    // guidance + the self-select four-surface walk), pinned by identity.
    const forced = out.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("four truth surfaces")),
    )
    expect(forced).toBeDefined()
    const forcedText = forced?.content.find(
      (b) => b.type === "text" && b.text.includes("four truth surfaces"),
    ) as { type: "text"; text: string } | undefined
    expect(forcedText?.text).toBe(CLOSEOUT_REMINDER)
    // Both portions present.
    expect(forcedText?.text).toContain("defended claims")
    expect(forcedText?.text).toContain("If you modified code")
    for (const surface of ["type", "owner", "wire", "test"]) {
      expect(forcedText?.text).toContain(surface)
    }
  })

  test("non-mutating session + fourRule:false ⇒ SAME UNION self-check (no history route)", async () => {
    const llm = new ScriptedLLM([
      // Turn 1: model tries to finish immediately — no mutating tool ran. The
      // closeout still injects the full UNION self-check (no history scan).
      { type: "text", text: "done" },
      // Forced re-stream of turn 1: finish for real.
      { type: "text", text: "actually done" },
    ])
    const stream = new NullStream()
    const config = baseConfig({
      llm,
      cwd,
      stream,
      maxTurns: 5,
      closeoutGuard: { enabled: true, fourRule: false },
    })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    const forced = out.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("defended claims")),
    )
    expect(forced).toBeDefined()
    const forcedText = forced?.content.find(
      (b) => b.type === "text" && b.text.includes("defended claims"),
    ) as { type: "text"; text: string } | undefined
    // Identical to the mutating-session reminder: the four-surface section is
    // ALWAYS present now — the old "legacy one-liner for non-mutating" route
    // is gone.
    expect(forcedText?.text).toBe(CLOSEOUT_REMINDER)
    expect(forcedText?.text).toContain("four truth surfaces")
  })

  // V4-P3 fix (Round 6 audit): the working-state cross-turn round-trip was
  // verified in pieces (mutation unit + render unit + opt-in registration
  // integration) but no single e2e test followed an `update_working_state`
  // mutation in turn N to its rendered `## Working state` block in turn N+1's
  // outgoing LLM messages. This test closes that loop: it's the round-trip
  // proof that mutations actually reach the model on the next prompt.
  test("update_working_state mutation in turn N appears in turn N+1's reminder", async () => {
    const llm = new ScriptedLLM([
      // Turn 1: invoke update_working_state with a hypothesis.
      {
        type: "tool_use",
        id: "c1",
        name: "update_working_state",
        input: { hypothesis: "race-in-streaming-dispatch" },
      },
      // Turn 2: finish.
      { type: "text", text: "done" },
    ])
    const config = baseConfig({
      llm,
      cwd,
      maxTurns: 5,
      workingState: { enabled: true },
    })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")
    // Turn 1's outgoing messages (BEFORE the mutation): NO working-state block.
    const turn1 = reminderText(llm.seenMessages[0] ?? [])
    expect(turn1).not.toContain("## Working state")
    // Turn 2's outgoing messages (AFTER the mutation): block IS present and
    // carries the hypothesis the LLM just wrote — the round-trip closes.
    const turn2 = reminderText(llm.seenMessages[1] ?? [])
    expect(turn2).toContain("## Working state")
    expect(turn2).toContain("### Hypothesis")
    expect(turn2).toContain("race-in-streaming-dispatch")
  })
})
