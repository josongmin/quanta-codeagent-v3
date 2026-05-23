/**
 * Bench-specific opt-in ENV gate tests (SWE-bench A/B measurement).
 *
 * The bench harness deliberately omits skills/subagent and gates LSP-nav
 * behind a non-bench env knob (see the BENCH-INTENTIONAL OPT-OUTS comment
 * in `src/apps/bench/eval/driver.ts`). For A/B measurement we want to flip
 * each axis independently WITHOUT polluting the CLI's own knobs — so we
 * added three bench-only flags:
 *
 *   QUANTA_BENCH_LSP=1       wire LSP nav tools (OR with QUANTA_LSP_TOOLS=full)
 *   QUANTA_BENCH_SUBAGENT=1  wire `subagent: {}` AgentConfig block
 *   QUANTA_BENCH_SKILLS=1    wire `skills: {}` AgentConfig block
 *
 * Invariants pinned here:
 *   - ALL THREE unset ⇒ byte-identical to today (no `subagent`/`skills` keys
 *     emitted, no lsp-nav tools registered) — measurement integrity.
 *   - Each ENV ON ⇒ exactly the corresponding wire appears in the config
 *     (independent: setting one doesn't pull the others in).
 *   - The original `QUANTA_LSP_TOOLS=full` gate still works (OR with the
 *     new `QUANTA_BENCH_LSP=1` — either flips the bit).
 *
 * Convention: every test saves + restores the env it touches via
 * `beforeEach/afterEach` so cross-test contamination is impossible.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { benchOptIns, buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

/** Env keys this file touches — saved on `beforeEach`, restored on `afterEach`. */
const ENV_KEYS = [
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_LSP_TOOLS",
] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}

const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

// ── benchOptIns: pure env resolver — direct, independent assertions. ───────

describe("benchOptIns — env resolver (pure, three independent flags)", () => {
  test("all unset → byte-identical default-OFF (lspNav:false, subagent/skills undefined)", () => {
    const r = benchOptIns()
    expect(r.lspNav).toBe(false)
    expect(r.subagent).toBeUndefined()
    expect(r.skills).toBeUndefined()
  })

  test("QUANTA_BENCH_LSP=1 → lspNav:true (other axes unchanged)", () => {
    process.env.QUANTA_BENCH_LSP = "1"
    const r = benchOptIns()
    expect(r.lspNav).toBe(true)
    expect(r.subagent).toBeUndefined()
    expect(r.skills).toBeUndefined()
  })

  test("QUANTA_LSP_TOOLS=full → lspNav:true (original gate still honored)", () => {
    process.env.QUANTA_LSP_TOOLS = "full"
    expect(benchOptIns().lspNav).toBe(true)
  })

  test("BOTH gates set → lspNav:true (OR, not XOR)", () => {
    process.env.QUANTA_LSP_TOOLS = "full"
    process.env.QUANTA_BENCH_LSP = "1"
    expect(benchOptIns().lspNav).toBe(true)
  })

  test("QUANTA_BENCH_LSP=0 / other-value → treated as unset (lspNav:false)", () => {
    process.env.QUANTA_BENCH_LSP = "0"
    expect(benchOptIns().lspNav).toBe(false)
    process.env.QUANTA_BENCH_LSP = "yes"
    expect(benchOptIns().lspNav).toBe(false)
  })

  test("QUANTA_LSP_TOOLS=partial → lspNav:false (only 'full' triggers, same as CLI)", () => {
    process.env.QUANTA_LSP_TOOLS = "partial"
    expect(benchOptIns().lspNav).toBe(false)
  })

  test("QUANTA_BENCH_SUBAGENT=1 → subagent:{} (other axes unchanged)", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    const r = benchOptIns()
    expect(r.subagent).toEqual({})
    expect(r.lspNav).toBe(false)
    expect(r.skills).toBeUndefined()
  })

  test("QUANTA_BENCH_SUBAGENT not exactly '1' → undefined (strict gate)", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "true"
    expect(benchOptIns().subagent).toBeUndefined()
    process.env.QUANTA_BENCH_SUBAGENT = "0"
    expect(benchOptIns().subagent).toBeUndefined()
  })

  test("QUANTA_BENCH_SKILLS=1 → skills:{} (bundled-only, no user dir)", () => {
    process.env.QUANTA_BENCH_SKILLS = "1"
    const r = benchOptIns()
    expect(r.skills).toEqual({})
    expect(r.lspNav).toBe(false)
    expect(r.subagent).toBeUndefined()
  })

  test("QUANTA_BENCH_SKILLS not exactly '1' → undefined (strict gate)", () => {
    process.env.QUANTA_BENCH_SKILLS = "true"
    expect(benchOptIns().skills).toBeUndefined()
    process.env.QUANTA_BENCH_SKILLS = ""
    expect(benchOptIns().skills).toBeUndefined()
  })

  test("ALL THREE on simultaneously → all three wired (independent flags compose)", () => {
    process.env.QUANTA_BENCH_LSP = "1"
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    process.env.QUANTA_BENCH_SKILLS = "1"
    const r = benchOptIns()
    expect(r.lspNav).toBe(true)
    expect(r.subagent).toEqual({})
    expect(r.skills).toEqual({})
  })
})

// ── buildConfig: end-to-end check that opt-ins reach the AgentConfig keys. ─

/** Minimal LLM that satisfies the type — never called by these tests since we
 *  don't run the agent, only inspect the assembled config. */
class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Minimal stream — `buildConfig` only forwards it, never emits. */
const stubStream: StreamPort = {
  emit() {
    // no-op
  },
}

const baseInstance = (swebench: boolean): Instance =>
  swebench
    ? {
        id: "test-1",
        repoPath: "/tmp/x",
        problemStatement: "fix it",
        testCmd: "true",
        swebench: {
          instanceId: "x__1",
          repo: "x/x",
          baseCommit: "deadbeef",
        },
      }
    : {
        id: "test-1",
        repoPath: "/tmp/x",
        problemStatement: "fix it",
        testCmd: "true",
      }

const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }

describe("buildConfig — bench opt-ins wired into AgentConfig", () => {
  test("ALL THREE unset → config omits `subagent`/`skills` keys (byte-identical to BENCH-INTENTIONAL posture)", () => {
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    // Default-OFF: the keys are NOT present at all (exactOptionalPropertyTypes
    // contract). `in` checks key presence, not undefined-vs-absent.
    expect("subagent" in cfg).toBe(false)
    expect("skills" in cfg).toBe(false)
  })

  test("QUANTA_BENCH_LSP=1 → registry expands by exactly the lspNavToolList count", () => {
    const ac = new AbortController()
    const before = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const baselineCount = before.registry.specs().length

    process.env.QUANTA_BENCH_LSP = "1"
    const after = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const afterCount = after.registry.specs().length

    // Strict positive delta — pins that the gate actually wires *something*
    // without coupling the test to a specific tool count (which evolves with
    // the agent slice). We avoid asserting a magic number per the
    // no-heuristics rule.
    expect(afterCount).toBeGreaterThan(baselineCount)
  })

  test("QUANTA_LSP_TOOLS=full → registry expands too (original gate still works)", () => {
    const ac = new AbortController()
    const before = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const baselineCount = before.registry.specs().length

    process.env.QUANTA_LSP_TOOLS = "full"
    const after = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(after.registry.specs().length).toBeGreaterThan(baselineCount)
  })

  test("QUANTA_BENCH_SUBAGENT=1 → config has `subagent:{}`", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("subagent" in cfg).toBe(true)
    expect(cfg.subagent).toEqual({})
    // Independence: skills MUST still be omitted.
    expect("skills" in cfg).toBe(false)
  })

  test("QUANTA_BENCH_SKILLS=1 → config has `skills:{}`", () => {
    process.env.QUANTA_BENCH_SKILLS = "1"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("skills" in cfg).toBe(true)
    expect(cfg.skills).toEqual({})
    // Independence: subagent MUST still be omitted.
    expect("subagent" in cfg).toBe(false)
  })

  test("ALL THREE on → registry expanded + subagent:{} + skills:{} (independent flags compose)", () => {
    process.env.QUANTA_BENCH_LSP = "1"
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    process.env.QUANTA_BENCH_SKILLS = "1"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(cfg.subagent).toEqual({})
    expect(cfg.skills).toEqual({})
    // verifyGuard still wired by the swebench branch (orthogonal — not touched
    // by these flags); pinned here to lock that the new opts don't drop it.
    // mustPass+maxTrips:2 (ADR-0011 outcome-gate extension) — pins the bench
    // shape so a regression that strips the SOTA mustPass branch fails here.
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2 })
    // Nav tools present — registry expands relative to the all-unset baseline.
    const ac2 = new AbortController()
    const savedLsp = process.env.QUANTA_BENCH_LSP
    const savedSub = process.env.QUANTA_BENCH_SUBAGENT
    const savedSk = process.env.QUANTA_BENCH_SKILLS
    delete process.env.QUANTA_BENCH_LSP
    delete process.env.QUANTA_BENCH_SUBAGENT
    delete process.env.QUANTA_BENCH_SKILLS
    const baseline = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac2.signal, stubStream)
    process.env.QUANTA_BENCH_LSP = savedLsp ?? "1"
    process.env.QUANTA_BENCH_SUBAGENT = savedSub ?? "1"
    process.env.QUANTA_BENCH_SKILLS = savedSk ?? "1"
    expect(cfg.registry.specs().length).toBeGreaterThan(baseline.registry.specs().length)
  })

  test("byte-identical core fields when all opt-ins unset (compaction, cwd, permission, system, maxTurns)", () => {
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    // Core knobs unchanged by the opt-ins — pinned so a future careless edit
    // to `buildConfig` doesn't silently shift them.
    expect(cfg.cwd).toBe("/tmp/sb")
    expect(cfg.permission).toEqual({ mode: "acceptEdits" })
    expect(cfg.compaction).toEqual({})
    expect(cfg.maxTurns).toBe(1)
    // SWEBENCH directive ONLY for swebench instances — custom-corpus is plain.
    const userMsg = cfg.messages[0]
    expect(userMsg?.role).toBe("user")
    const content = userMsg?.content
    if (Array.isArray(content)) {
      const first = content[0]
      if (first && first.type === "text") {
        // Custom-corpus → no SWEBENCH_DIRECTIVE appended.
        expect(first.text).not.toContain("automated grader")
      }
    }
  })
})
