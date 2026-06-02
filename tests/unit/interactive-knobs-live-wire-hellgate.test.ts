/**
 * jun-02 hellgate — INTERACTIVE knobs LIVE on the cli + agent surfaces.
 *
 * THE GAP THIS SEALS (adversarial review): `advisor`, `task-budget`, and
 * `compose-authoring` are registered in the `@/runner/knobs` framework, but
 * the only thing that folds a resolved knob value onto an `AgentConfig`
 * (`applyKnobs`) is called ONLY by the bench driver. The live CLI / unified-
 * agent surfaces NEVER call `applyKnobs`, so `QUANTA_ADVISOR_MODEL` /
 * `QUANTA_TASK_BUDGET` / `QUANTA_COMPOSE_AUTHORING` activated NOTHING for users.
 *
 * The fix is the composition-root helper `wireInteractiveKnobs` (reusing each
 * knob's OWN parse+apply). This test proves the env→behavior path THROUGH that
 * REAL helper — NOT by injecting `config.advisor` directly (the gap no prior
 * test covered: prior suites inject the config slot and never exercise the
 * env→config fold the live surfaces must do).
 *
 * DETERMINISTIC — no network, no `process.env` mutation (env is threaded via a
 * passed object). NO arbitrary thresholds.
 *
 * Axes:
 *   A. ADVISOR     — env set ⇒ `config.advisor` populated ⇒ `advisor` tool
 *                    REGISTERED via `buildSessionFeatures`; absent ⇒ NOT.
 *   B. TASK-BUDGET — env set ⇒ `config.taskBudget` ⇒ the SOFT reminder line is
 *                    rendered by `renderTaskBudgetBlock`; absent ⇒ undefined.
 *   C. COMPOSE     — env set ⇒ `config.composeAuthoring` ⇒ `git_compose_commit`
 *                    + `git_compose_pr` REGISTERED; absent ⇒ NOT.
 *   D. SURFACE     — `bench` surface ⇒ all three untouched (they exclude bench).
 *   E. BYTE-IDENTITY — empty env on every interactive surface ⇒ the SAME config
 *                    reference is returned (`===`), so absent-env is a no-op.
 */

import { describe, expect, test } from "bun:test"
import { renderTaskBudgetBlock } from "@/agent/budget/task-budget"
import { buildSessionFeatures } from "@/agent/features"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { wireInteractiveKnobs } from "@/runner/assemble"
import type { Surface } from "@/runner/knobs"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── doubles ──────────────────────────────────────────────────────────────

/** Minimal LLM double — never streams; the consult/authoring closures only
 *  CLOSE over it at wire time (they are not invoked here). */
class StubLLM implements LLMPort {
  readonly model = "o3"
  // biome-ignore lint/correctness/useYield: never invoked in these wiring tests.
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("LLM.stream must not run in a wiring test")
  }
}

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: new StubLLM() as unknown as LLMPort,
    ...over,
  }) as AgentConfig

/** The live interactive surfaces these knobs activate on. */
const INTERACTIVE_SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

const toolNames = async (cfg: AgentConfig): Promise<Set<string>> => {
  const { extraTools } = await buildSessionFeatures(cfg)
  return new Set(extraTools.map((t) => t.name))
}

// ─── A. ADVISOR ─────────────────────────────────────────────────────────────

describe("wireInteractiveKnobs — advisor (QUANTA_ADVISOR_MODEL)", () => {
  for (const surface of INTERACTIVE_SURFACES) {
    test(`env set on ${surface} ⇒ config.advisor + advisor tool registered`, async () => {
      const env = { QUANTA_ADVISOR_MODEL: "o3" }
      const wired = wireInteractiveKnobs(baseCfg(), env, surface)
      expect(wired.advisor).toBeDefined()
      expect(wired.advisor?.models).toContain("o3")
      expect(await toolNames(wired)).toContain("advisor")
    })
  }

  test("off-allowlist model ⇒ config.advisor unset + tool NOT registered", async () => {
    const wired = wireInteractiveKnobs(baseCfg(), { QUANTA_ADVISOR_MODEL: "gpt-1o" }, "cli")
    expect(wired.advisor).toBeUndefined()
    expect(await toolNames(wired)).not.toContain("advisor")
  })

  test("absent env ⇒ config.advisor unset + tool NOT registered", async () => {
    const wired = wireInteractiveKnobs(baseCfg(), {}, "cli")
    expect(wired.advisor).toBeUndefined()
    expect(await toolNames(wired)).not.toContain("advisor")
  })
})

// ─── B. TASK-BUDGET ──────────────────────────────────────────────────────────

describe("wireInteractiveKnobs — task-budget (QUANTA_TASK_BUDGET)", () => {
  for (const surface of INTERACTIVE_SURFACES) {
    test(`env set on ${surface} ⇒ config.taskBudget + soft reminder rendered`, () => {
      const wired = wireInteractiveKnobs(baseCfg(), { QUANTA_TASK_BUDGET: "100000" }, surface)
      expect(wired.taskBudget).toEqual({ tokens: 100000 })
      // Prove the wired budget reaches the REAL renderer the loop uses.
      const line = renderTaskBudgetBlock(wired.taskBudget)
      expect(line).toBeDefined()
      expect(line).toContain("task budget")
    })
  }

  test("non-positive / garbage ⇒ config.taskBudget unset (no reminder)", () => {
    for (const raw of ["0", "-5", "1.5", "abc", ""]) {
      const wired = wireInteractiveKnobs(baseCfg(), { QUANTA_TASK_BUDGET: raw }, "cli")
      expect(wired.taskBudget).toBeUndefined()
    }
  })

  test("absent env ⇒ config.taskBudget unset + renderer returns undefined", () => {
    const wired = wireInteractiveKnobs(baseCfg(), {}, "agent-interactive")
    expect(wired.taskBudget).toBeUndefined()
    expect(renderTaskBudgetBlock(wired.taskBudget)).toBeUndefined()
  })
})

// ─── C. COMPOSE-AUTHORING ────────────────────────────────────────────────────

describe("wireInteractiveKnobs — compose-authoring (QUANTA_COMPOSE_AUTHORING)", () => {
  for (const surface of INTERACTIVE_SURFACES) {
    test(`env "1" on ${surface} ⇒ config.composeAuthoring + git_compose_* registered`, async () => {
      const wired = wireInteractiveKnobs(baseCfg(), { QUANTA_COMPOSE_AUTHORING: "1" }, surface)
      expect(wired.composeAuthoring).toBeDefined()
      expect(wired.composeAuthoring?.authorLLM).toBeDefined()
      const names = await toolNames(wired)
      expect(names).toContain("git_compose_commit")
      expect(names).toContain("git_compose_pr")
    })
  }

  test("non-'1' value ⇒ config.composeAuthoring unset + tools NOT registered", async () => {
    for (const raw of ["0", "true", "on", "yes", ""]) {
      const wired = wireInteractiveKnobs(baseCfg(), { QUANTA_COMPOSE_AUTHORING: raw }, "cli")
      expect(wired.composeAuthoring).toBeUndefined()
      const names = await toolNames(wired)
      expect(names).not.toContain("git_compose_commit")
      expect(names).not.toContain("git_compose_pr")
    }
  })

  test("absent env ⇒ config.composeAuthoring unset + tools NOT registered", async () => {
    const wired = wireInteractiveKnobs(baseCfg(), {}, "agent-batch")
    expect(wired.composeAuthoring).toBeUndefined()
    const names = await toolNames(wired)
    expect(names).not.toContain("git_compose_commit")
    expect(names).not.toContain("git_compose_pr")
  })
})

// ─── D. SURFACE EXCLUSION (bench) ────────────────────────────────────────────

describe("wireInteractiveKnobs — bench surface is excluded", () => {
  test("all three env vars set on bench ⇒ NONE applied (knobs exclude bench)", () => {
    const env = {
      QUANTA_ADVISOR_MODEL: "o3",
      QUANTA_TASK_BUDGET: "100000",
      QUANTA_COMPOSE_AUTHORING: "1",
    }
    const cfg = baseCfg()
    const wired = wireInteractiveKnobs(cfg, env, "bench")
    expect(wired.advisor).toBeUndefined()
    expect(wired.taskBudget).toBeUndefined()
    expect(wired.composeAuthoring).toBeUndefined()
  })
})

// ─── E. BYTE-IDENTITY (absent env ⇒ same reference) ──────────────────────────

describe("wireInteractiveKnobs — absent env is byte-identical", () => {
  for (const surface of INTERACTIVE_SURFACES) {
    test(`empty env on ${surface} ⇒ returns the SAME config reference`, () => {
      const cfg = baseCfg()
      const wired = wireInteractiveKnobs(cfg, {}, surface)
      expect(wired).toBe(cfg)
    })
  }

  test("all three together on cli ⇒ all three slots set in ONE fold", async () => {
    const env = {
      QUANTA_ADVISOR_MODEL: "gpt-5",
      QUANTA_TASK_BUDGET: "50000",
      QUANTA_COMPOSE_AUTHORING: "1",
    }
    const wired = wireInteractiveKnobs(baseCfg(), env, "cli")
    expect(wired.advisor).toBeDefined()
    expect(wired.taskBudget).toEqual({ tokens: 50000 })
    expect(wired.composeAuthoring).toBeDefined()
    const names = await toolNames(wired)
    expect(names).toContain("advisor")
    expect(names).toContain("git_compose_commit")
    expect(names).toContain("git_compose_pr")
  })
})
