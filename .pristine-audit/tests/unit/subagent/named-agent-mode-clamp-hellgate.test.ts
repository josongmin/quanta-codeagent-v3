/**
 * Hellgate — a child's prompt `mode` is clamped MOST-RESTRICTIVE: a named-agent
 * `mode:` (repo-controlled, folded into `req.mode`) may FURTHER restrict the
 * child but must NEVER relax a read-only parent into a write-capable posture.
 *
 * BUG (pre-fix): `resolveChildMode` honored `req.mode` unconditionally. A repo
 * `.quanta/agents/*.md` definition declaring `mode: default` (or `editor`),
 * spawned from a `review`/`audit`-posture parent, ran the child in a MUTATING
 * posture — a privilege escalation that broke the documented parent-mode
 * inheritance invariant (a review/audit parent must never spawn a child that
 * writes). `normalizeMode` only validates membership in AGENT_PROMPT_MODES; it
 * does not clamp to most-restrictive.
 *
 * FIX: `resolveChildMode` floors a read-only parent — if `parent.mode` is
 * read-only (plan/review/audit/architect) and the requested mode is mutating
 * (default/editor), keep the parent's mode. A read-only request (further
 * restriction) or a parent that is already mutating still honors the request.
 *
 * RED-on-injection: case (1) is "default" without the clamp; the clamp makes it
 * "review".
 */

import { describe, expect, test } from "bun:test"
import type { runAgent } from "../../../src/agent/loop"
import type { AgentMode } from "../../../src/agent/prompt"
import { createSubagentRunner } from "../../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../../src/agent/types"
import type { SubagentRequest } from "../../../src/subagent/types"
import { ToolRegistry } from "../../../src/tool"

const parentConfig = (mode: AgentMode | undefined): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub — loop never runs
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "P" }] }],
    system: "S",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...(mode !== undefined ? { mode } : {}),
  }) as AgentConfig

const outcome: AgentOutcome = {
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
}

/** Capture the child config the runner builds; return its resolved `mode`. */
const childModeFor = async (
  parentMode: AgentMode | undefined,
  reqMode: AgentMode | undefined,
): Promise<AgentMode | undefined> => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome
  }) as typeof runAgent
  const runner = createSubagentRunner(parentConfig(parentMode), { run })
  const req: SubagentRequest = {
    prompt: "do it",
    depth: 1,
    ...(reqMode !== undefined ? { mode: reqMode } : {}),
  }
  await runner(req)
  const child = seen[0]
  if (child === undefined) throw new Error("runner did not spawn a child")
  return child.mode
}

describe("named-agent mode clamp — most-restrictive (hellgate)", () => {
  test("(1) read-only parent (review) + mutating req (default) ⇒ child stays review", async () => {
    expect(await childModeFor("review", "default")).toBe("review")
  })

  test("(2) read-only parent (audit) + mutating req (editor) ⇒ child stays audit", async () => {
    expect(await childModeFor("audit", "editor")).toBe("audit")
  })

  test("(3) read-only parent (plan) + mutating req (default) ⇒ child stays plan", async () => {
    expect(await childModeFor("plan", "default")).toBe("plan")
  })

  test("(4) read-only parent (review) + read-only req (audit) ⇒ further restriction honored", async () => {
    expect(await childModeFor("review", "audit")).toBe("audit")
  })

  test("(5) mutating parent (default) + mutating req (editor) ⇒ request honored", async () => {
    expect(await childModeFor("default", "editor")).toBe("editor")
  })

  test("(6) mutating parent (default) + read-only req (review) ⇒ child may restrict to review", async () => {
    expect(await childModeFor("default", "review")).toBe("review")
  })

  test("(7) no req mode ⇒ inherit parent (byte-identical)", async () => {
    expect(await childModeFor("review", undefined)).toBe("review")
  })

  test("(8) no parent mode (no floor) + mutating req ⇒ request honored", async () => {
    expect(await childModeFor(undefined, "default")).toBe("default")
  })
})
