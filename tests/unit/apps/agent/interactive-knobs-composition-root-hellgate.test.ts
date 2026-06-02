/**
 * jun-02 hellgate — INTERACTIVE knobs live at the UNIFIED-AGENT composition
 * root (`buildBaseFromArgs`).
 *
 * Complements `tests/unit/interactive-knobs-live-wire-hellgate.test.ts` (which
 * seals the `wireInteractiveKnobs` helper in isolation) by proving the helper
 * is ACTUALLY CALLED at the real agent composition root, so the produced
 * `AssembleRequest.base` carries the three slots — i.e. the env→config fold is
 * wired into `buildBaseFromArgs`, not just available as a library function.
 *
 * `buildBaseFromArgs` reads `process.env` at the composition boundary (the same
 * env view it seeds `--provider` into), so this suite sets + restores env with
 * the established composition-root pattern (cf. `observability-live-wire`). NO
 * network: the LLM is built but never streamed.
 *
 * Axes:
 *   A. ENV SET   ⇒ base.advisor / base.taskBudget / base.composeAuthoring set.
 *   B. ABSENT    ⇒ all three slots absent (default-OFF byte-identical).
 *   C. SURFACE   ⇒ batch mode maps to the `agent-batch` knob surface; other
 *                  modes map to `agent-interactive`. Both are live surfaces.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"

const ADVISOR = "QUANTA_ADVISOR_MODEL"
const TASK = "QUANTA_TASK_BUDGET"
const COMPOSE = "QUANTA_COMPOSE_AUTHORING"

describe("buildBaseFromArgs — interactive knobs live at the agent composition root", () => {
  const prev = {
    openai: process.env.OPENAI_API_KEY,
    advisor: process.env[ADVISOR],
    task: process.env[TASK],
    compose: process.env[COMPOSE],
    provider: process.env.QUANTA_PROVIDER,
  }

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
    delete process.env[ADVISOR]
    delete process.env[TASK]
    delete process.env[COMPOSE]
  })

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    restore("OPENAI_API_KEY", prev.openai)
    restore(ADVISOR, prev.advisor)
    restore(TASK, prev.task)
    restore(COMPOSE, prev.compose)
    restore("QUANTA_PROVIDER", prev.provider)
  })

  test("[A] all three env vars set ⇒ base carries advisor + taskBudget + composeAuthoring", () => {
    process.env[ADVISOR] = "o3"
    process.env[TASK] = "120000"
    process.env[COMPOSE] = "1"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.advisor).toBeDefined()
    expect(base.advisor?.models).toContain("o3")
    expect(base.taskBudget).toEqual({ tokens: 120000 })
    expect(base.composeAuthoring).toBeDefined()
    expect(base.composeAuthoring?.authorLLM).toBeDefined()
  })

  test("[B] absent env ⇒ all three slots absent (default-OFF byte-identical)", () => {
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.advisor).toBeUndefined()
    expect(base.taskBudget).toBeUndefined()
    expect(base.composeAuthoring).toBeUndefined()
    expect("advisor" in base).toBe(false)
    expect("taskBudget" in base).toBe(false)
    expect("composeAuthoring" in base).toBe(false)
  })

  test("[C] batch mode (agent-batch surface) also activates the knobs", () => {
    process.env[ADVISOR] = "gpt-5"
    process.env[TASK] = "30000"
    process.env[COMPOSE] = "1"
    const base = buildBaseFromArgs({ mode: "batch", dials: {} })
    expect(base.advisor).toBeDefined()
    expect(base.taskBudget).toEqual({ tokens: 30000 })
    expect(base.composeAuthoring).toBeDefined()
  })

  test("[D] off-allowlist advisor + garbage task-budget ⇒ those slots stay absent", () => {
    process.env[ADVISOR] = "not-a-real-model"
    process.env[TASK] = "0"
    process.env[COMPOSE] = "1"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.advisor).toBeUndefined()
    expect(base.taskBudget).toBeUndefined()
    // compose still activates (independent knob).
    expect(base.composeAuthoring).toBeDefined()
  })
})
