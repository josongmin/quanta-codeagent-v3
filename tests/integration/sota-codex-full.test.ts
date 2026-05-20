import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentConfig,
  loadRepoRules,
  type RepoRules,
  runAgent,
} from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { writeFile } from "node:fs/promises"

/**
 * Phase 8 — SOTA++ Codex absorption end-to-end integration check.
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
 */

class FakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  async *stream(input: { messages: Message[] }): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages)
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const noPermission: PermissionContext = { mode: "bypass" }

const reminderText = (messages: Message[]): string => {
  // The per-turn `<system-reminder>` is the FINAL user message of every
  // assembled request — that's the ordering invariant `buildTurnContext`
  // documents.
  const tail = messages[messages.length - 1]
  if (!tail || tail.role !== "user") return ""
  const block = tail.content[0]
  return block?.type === "text" ? block.text : ""
}

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => {
  const llm = new FakeLLM()
  return {
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new NullStream(),
    permission: noPermission,
    messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    system: "TEST_SYSTEM",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("SOTA++ Phase 8 — default-OFF byte-identical", () => {
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

describe("SOTA++ Phase 8 — all Phases ON compose cleanly", () => {
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
    const llm = new FakeLLM()
    const config = baseConfig({
      llm,
      cwd,
      mode: "review",
      repoRules: rules,
      closeoutGuard: { enabled: true, fourRule: true },
      hitl: { enabled: true },
      workingState: { enabled: true },
    })
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    const reminder = reminderText(llm.seenMessages[0] ?? [])

    // Phase 0/3 — mode notice (review-mode posture)
    expect(reminder).toContain("REVIEW MODE is active")
    expect(reminder).toContain("findings-first")

    // Phase 0 — repo-local rules block with entrypoint citation
    expect(reminder).toContain("## Repo-local rules (from AGENTS.md)")
    expect(reminder).toContain("no heuristics; fail-closed")

    // Phase 6 — memory hints, when present, must be labelled as routing hint
    // (the absence of a memory store means no hint block in this test; we
    // assert the LABEL contract elsewhere via prompt.test.ts)
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
