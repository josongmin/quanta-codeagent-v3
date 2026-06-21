/**
 * Bench wiring for ADR-0084 speculative branch search (Agentless N-best).
 *
 * `QUANTA_BENCH_BRANCH_SEARCH=K` sets `AgentConfig.branchSearch.defaultN = K`
 * (K must be an integer in [2..8]). Default-OFF: absent / K<2 / K>8 / garbage
 * ⇒ the `branchSearch` key is OMITTED entirely so the bench-driver config is
 * byte-identical to the BENCH-INTENTIONAL posture (exactOptionalPropertyTypes).
 *
 * Slice contract pinned here:
 *   - The resolved BranchSearchConfig points at the slice's natural defaults
 *     (verifier `tsc` — same fallback the slice's `tool.ts:93` enforces;
 *     `tmpdir` isolation — bench sandboxes are not always git repos).
 *   - K is round-tripped exactly (no clamp, no silent rounding) — out-of-range
 *     is REJECTED, not clamped, so a misconfigured env never silently runs
 *     fewer/more candidates than asked.
 *   - Setting `branchSearch` composes orthogonally with the existing opt-ins
 *     (lspNav / subagent / skills / verifyGuard) — independence pinned in
 *     `bench-branch-search-wiring-hellgate.test.ts`.
 *
 * Convention mirrors `bench-opt-in.test.ts`: every test saves + restores the
 * env via `beforeEach/afterEach` so cross-test contamination is impossible.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { benchOptIns, buildConfig, parseBenchBranchSearchK } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

const ENV_KEYS = [
  "QUANTA_BENCH_BRANCH_SEARCH",
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

// ── parseBenchBranchSearchK: pure, no env. ──────────────────────────────────

describe("parseBenchBranchSearchK — strict integer gate K in [2..8]", () => {
  test("undefined / empty / whitespace-only ⇒ undefined", () => {
    expect(parseBenchBranchSearchK(undefined)).toBeUndefined()
    expect(parseBenchBranchSearchK("")).toBeUndefined()
    expect(parseBenchBranchSearchK("   ")).toBeUndefined()
    expect(parseBenchBranchSearchK("\t\n")).toBeUndefined()
  })

  test("K=1 / K=0 / K=-3 ⇒ undefined (1-best ≡ baseline; negatives nonsensical)", () => {
    expect(parseBenchBranchSearchK("1")).toBeUndefined()
    expect(parseBenchBranchSearchK("0")).toBeUndefined()
    expect(parseBenchBranchSearchK("-3")).toBeUndefined()
  })

  test("K=2..8 ⇒ exact integer round-trip (no clamp)", () => {
    for (let k = 2; k <= 8; k++) {
      expect(parseBenchBranchSearchK(String(k))).toBe(k)
    }
  })

  test("K=9 / K=100 / K=1000 ⇒ undefined (slice cap matches tool.ts zod max(8))", () => {
    expect(parseBenchBranchSearchK("9")).toBeUndefined()
    expect(parseBenchBranchSearchK("100")).toBeUndefined()
    expect(parseBenchBranchSearchK("1000")).toBeUndefined()
  })

  test("non-integer / float / NaN / Infinity / garbage ⇒ undefined", () => {
    expect(parseBenchBranchSearchK("3.5")).toBeUndefined()
    expect(parseBenchBranchSearchK("3.0")).toBeUndefined()
    expect(parseBenchBranchSearchK("NaN")).toBeUndefined()
    expect(parseBenchBranchSearchK("Infinity")).toBeUndefined()
    expect(parseBenchBranchSearchK("-Infinity")).toBeUndefined()
    expect(parseBenchBranchSearchK("abc")).toBeUndefined()
    expect(parseBenchBranchSearchK("3x")).toBeUndefined()
    expect(parseBenchBranchSearchK("0x10")).toBeUndefined()
    expect(parseBenchBranchSearchK("3e2")).toBeUndefined()
  })

  test("leading/trailing whitespace tolerated (trim), internal whitespace rejected", () => {
    expect(parseBenchBranchSearchK("  3  ")).toBe(3)
    expect(parseBenchBranchSearchK("\t3\n")).toBe(3)
    expect(parseBenchBranchSearchK("1 2")).toBeUndefined()
    expect(parseBenchBranchSearchK("3 ")).toBe(3)
  })
})

// ── benchOptIns: env resolver — pinned to four-field shape. ─────────────────

describe("benchOptIns — branchSearch axis (independent flag)", () => {
  test("QUANTA_BENCH_BRANCH_SEARCH unset ⇒ branchSearch undefined (other axes preserved)", () => {
    const r = benchOptIns()
    expect(r.branchSearch).toBeUndefined()
    expect(r.lspNav).toBe(false)
    expect(r.subagent).toBeUndefined()
    expect(r.skills).toBeUndefined()
  })

  test("QUANTA_BENCH_BRANCH_SEARCH=3 ⇒ branchSearch wired with defaultN=3", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "3"
    const r = benchOptIns()
    expect(r.branchSearch).toBeDefined()
    expect(r.branchSearch?.defaultN).toBe(3)
    // Slice-natural defaults pinned: tsc verifier (same fallback as tool.ts:93)
    // and tmpdir isolation (bench sandboxes aren't always git repos).
    expect(r.branchSearch?.defaultVerifierKinds).toEqual(["tsc"])
    expect(r.branchSearch?.isolation).toBe("tmpdir")
    // Other axes untouched (orthogonality).
    expect(r.lspNav).toBe(false)
    expect(r.subagent).toBeUndefined()
    expect(r.skills).toBeUndefined()
  })

  test("K=1 / K=0 / garbage ⇒ branchSearch undefined (K<2 ignored — byte-identical)", () => {
    for (const v of ["1", "0", "garbage", "true", "yes"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  test("K=2 (boundary) ⇒ branchSearch wired with defaultN=2", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "2"
    expect(benchOptIns().branchSearch?.defaultN).toBe(2)
  })

  test("K=8 (upper boundary) ⇒ branchSearch wired with defaultN=8", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "8"
    expect(benchOptIns().branchSearch?.defaultN).toBe(8)
  })

  test("K=9 (above slice cap) ⇒ branchSearch undefined", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "9"
    expect(benchOptIns().branchSearch).toBeUndefined()
  })
})

// ── buildConfig: end-to-end — branchSearch flows into the AgentConfig key. ──

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

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

describe("buildConfig — branchSearch wired into AgentConfig", () => {
  test("QUANTA_BENCH_BRANCH_SEARCH unset ⇒ config omits `branchSearch` key (byte-identical baseline)", () => {
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("branchSearch" in cfg).toBe(false)
  })

  test("QUANTA_BENCH_BRANCH_SEARCH=3 ⇒ config has `branchSearch.defaultN=3`", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "3"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("branchSearch" in cfg).toBe(true)
    expect(cfg.branchSearch?.defaultN).toBe(3)
    expect(cfg.branchSearch?.defaultVerifierKinds).toEqual(["tsc"])
    expect(cfg.branchSearch?.isolation).toBe("tmpdir")
    expect(cfg.branchSearch?.timeoutPerBranchMs).toBeGreaterThan(0)
  })

  test("K=1 / K=0 / garbage / empty ⇒ config omits `branchSearch` key (strict gate)", () => {
    const ac = new AbortController()
    for (const v of ["1", "0", "garbage", "", "  ", "3.5", "1000"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
      expect("branchSearch" in cfg).toBe(false)
    }
  })

  test("K=3 on a swebench instance ⇒ branchSearch wired AND verifyGuard still wired (orthogonal)", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "3"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(cfg.branchSearch?.defaultN).toBe(3)
    // verifyGuard is wired by the swebench branch (independent of branchSearch).
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2, exactCommands: ["true"] })
  })

  test("env mutation isolation: set → buildConfig → restore yields the SAME (omitted) state", () => {
    const ac = new AbortController()
    // Before.
    const before = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("branchSearch" in before).toBe(false)
    // Set + assert.
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "4"
    const during = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(during.branchSearch?.defaultN).toBe(4)
    // Restore + assert byte-identical key-set to `before`.
    delete process.env.QUANTA_BENCH_BRANCH_SEARCH
    const after = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect("branchSearch" in after).toBe(false)
    // Core knobs unchanged across the three calls (sanity — env mutation does
    // not bleed into other config fields).
    expect(after.cwd).toBe(before.cwd)
    expect(after.maxTurns).toBe(before.maxTurns)
    expect(after.permission).toEqual(before.permission)
  })
})
