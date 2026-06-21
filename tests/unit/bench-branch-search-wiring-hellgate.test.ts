/**
 * Hellgate battery for the bench `branchSearch` wiring (ADR-0084 N-best).
 *
 * Adversarial inputs we *must* tolerate without surprising side-effects:
 *   - prototype-pollution-shaped env values
 *   - numeric edge cases (NaN, Infinity, 2^53, very negative, leading +/-)
 *   - format edge cases (hex/oct/binary literals, scientific notation, BOM,
 *     locale digits, unicode whitespace, padded zeros)
 *   - composition with EVERY other bench opt-in (lspNav/subagent/skills/
 *     verifyGuard) simultaneously
 *   - exactOptionalPropertyTypes contract — the `branchSearch` key MUST be
 *     omitted (not set to undefined) when the gate is off
 *   - env mutation hygiene — multiple sequential set→build→restore cycles
 *     never leak across calls
 *
 * The bench harness is a measurement surface; an env-induced silent K-change
 * (clamp, round, parse-as-zero) is a *measurement-integrity bug*, not just a
 * UX bug. Every assertion below pins one such invariant. Mirrors the hellgate
 * style of `bench-opt-in.test.ts` / `ctk-git-skills-router-hellgate.test.ts`.
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

// ── Stub LLM / stream / instance — never invoked, only config-shape inspection.
class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }
const baseInstance = (swebench: boolean): Instance =>
  swebench
    ? {
        id: "h-1",
        repoPath: "/tmp/x",
        problemStatement: "fix it",
        testCmd: "true",
        swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
      }
    : { id: "h-1", repoPath: "/tmp/x", problemStatement: "fix it", testCmd: "true" }
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }

const buildOnce = (): ReturnType<typeof buildConfig> => {
  const ac = new AbortController()
  return buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream)
}

// ── 15+ adversarial cases ───────────────────────────────────────────────────

describe("bench branch-search hellgate — adversarial K values", () => {
  // (1) prototype-pollution-shaped strings
  test("__proto__ / constructor / toString as K ⇒ undefined (no prototype pollution leak)", () => {
    for (const v of ["__proto__", "constructor", "toString", "[object Object]"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(parseBenchBranchSearchK(v)).toBeUndefined()
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
    // Object.prototype must not have been touched.
    // biome-ignore lint/suspicious/noExplicitAny: testing prototype integrity
    expect((Object.prototype as any).defaultN).toBeUndefined()
  })

  // (2) negative integers — exactly the "K<2 is baseline" rule extended to negatives
  test("very negative K (-1 / -1000000) ⇒ undefined", () => {
    for (const v of ["-1", "-2", "-7", "-1000000"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (3) NaN / Infinity / -Infinity literals
  test("NaN / Infinity / -Infinity strings ⇒ undefined (Number() coercion not honored)", () => {
    for (const v of ["NaN", "nan", "Infinity", "-Infinity", "+Infinity"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (4) above slice cap — K=1000, K=2^31, K=2^53
  test("very large K (1000 / 2^31 / 2^53) ⇒ undefined (slice cap = 8)", () => {
    for (const v of ["1000", "2147483648", "9007199254740992", "999999999999999"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (5) floats (rounding could mask intent — must reject, not round)
  test("floats / scientific (2.0 / 3.5 / 3e0 / .5) ⇒ undefined (no silent rounding)", () => {
    for (const v of ["2.0", "3.5", "3e0", "3.0e0", ".5", "2."]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (6) hex / oct / binary literals
  test("0x10 / 0o7 / 0b11 / +3 / leading-zero '03' handled per the strict regex", () => {
    // `0x10` — non-decimal, rejected.
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "0x10"
    expect(benchOptIns().branchSearch).toBeUndefined()
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "0o7"
    expect(benchOptIns().branchSearch).toBeUndefined()
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "0b11"
    expect(benchOptIns().branchSearch).toBeUndefined()
    // `+3` — leading explicit-positive sign not in our regex (`-?\d+`). Reject.
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "+3"
    expect(benchOptIns().branchSearch).toBeUndefined()
    // `03` — leading zero accepted as digit; Number("03") = 3; valid.
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "03"
    expect(benchOptIns().branchSearch?.defaultN).toBe(3)
  })

  // (7) empty / whitespace-only / unicode whitespace
  test("empty / whitespace-only / BOM / unicode-space ⇒ undefined", () => {
    for (const v of ["", " ", "\t", "\n", " ", "﻿", " "]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (8) padding tolerated — trim only
  test("padded '  3  ' / '\\t3\\n' ⇒ defaultN=3 (trim-on-edges only)", () => {
    for (const v of ["  3  ", "\t3\n", " 4 "]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      const r = benchOptIns().branchSearch
      expect(r).toBeDefined()
      const expected = v.trim()
      expect(r?.defaultN).toBe(Number(expected))
    }
  })

  // (9) exactly the K=1 case — explicitly pinned (1-best ≡ baseline)
  test("K='1' ⇒ undefined (1-best is byte-identical to baseline)", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "1"
    expect(benchOptIns().branchSearch).toBeUndefined()
    expect("branchSearch" in buildOnce()).toBe(false)
  })

  // (10) exactly K=2 boundary
  test("K='2' ⇒ defaultN=2 (lower boundary inclusive)", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "2"
    expect(benchOptIns().branchSearch?.defaultN).toBe(2)
  })

  // (11) exactly K=8 boundary; K=9 just above
  test("K='8' ⇒ defaultN=8; K='9' ⇒ undefined (slice tool.ts max(8))", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "8"
    expect(benchOptIns().branchSearch?.defaultN).toBe(8)
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "9"
    expect(benchOptIns().branchSearch).toBeUndefined()
  })

  // (12) garbage with embedded digits — must reject (do not extract)
  test("'3x' / 'x3' / '3 ' '3 4' / '3;rm -rf /' ⇒ undefined (no digit extraction)", () => {
    for (const v of ["3x", "x3", "3 4", "3;rm -rf /", "3$(whoami)", "3\x00"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (13) locale digits — must reject (we only accept ASCII 0-9)
  test("locale digits (Arabic-Indic, full-width) ⇒ undefined", () => {
    for (const v of ["٣", "３", "𝟑"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (14) negative zero / signed-zero quirks
  test("'-0' / '0' / '+0' ⇒ undefined (zero rejected as K<2)", () => {
    for (const v of ["-0", "0", "+0", "00", "000"]) {
      process.env.QUANTA_BENCH_BRANCH_SEARCH = v
      expect(benchOptIns().branchSearch).toBeUndefined()
    }
  })

  // (15) exactOptionalPropertyTypes contract — key OMITTED, not set to undefined
  test("default-OFF ⇒ `branchSearch` key OMITTED, not set to undefined (eOPT contract)", () => {
    const cfg = buildOnce()
    expect("branchSearch" in cfg).toBe(false)
    // sanity — Object.keys never lists `branchSearch` when off
    expect(Object.keys(cfg)).not.toContain("branchSearch")
  })

  // (16) co-existence with EVERY other bench opt-in simultaneously
  test("K=3 + lspNav + subagent + skills + verifyGuard ⇒ all five wired independently", () => {
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "3"
    process.env.QUANTA_BENCH_LSP = "1"
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    process.env.QUANTA_BENCH_SKILLS = "1"
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(cfg.branchSearch?.defaultN).toBe(3)
    expect(cfg.subagent).toEqual({})
    expect(cfg.skills).toEqual({})
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2, exactCommands: ["true"] }) // swebench branch wires this
    // lsp-nav grows the registry beyond baseline.
    delete process.env.QUANTA_BENCH_LSP
    const ac2 = new AbortController()
    const baseline = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac2.signal, stubStream)
    process.env.QUANTA_BENCH_LSP = "1"
    expect(cfg.registry.specs().length).toBeGreaterThan(baseline.registry.specs().length)
  })

  // (17) env mutation hygiene — multiple set/restore cycles never leak
  test("3-cycle set→build→delete→build is byte-identical for the `branchSearch` key set", () => {
    for (let i = 0; i < 3; i++) {
      const offCfg = buildOnce()
      expect("branchSearch" in offCfg).toBe(false)
      process.env.QUANTA_BENCH_BRANCH_SEARCH = String(2 + i) // 2,3,4
      const onCfg = buildOnce()
      expect(onCfg.branchSearch?.defaultN).toBe(2 + i)
      delete process.env.QUANTA_BENCH_BRANCH_SEARCH
    }
  })

  // (18) `verifyGuard` knob does NOT pull `branchSearch` in (no implicit coupling)
  test("swebench instance + branchSearch unset ⇒ branchSearch omitted (no auto-enable)", () => {
    // No QUANTA_BENCH_BRANCH_SEARCH — but it is a swebench instance.
    const ac = new AbortController()
    const cfg = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac.signal, stubStream)
    // verifyGuard auto-wires for swebench (orthogonal).
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2, exactCommands: ["true"] })
    // branchSearch MUST NOT auto-enable (cost discipline — explicit opt-in only).
    expect("branchSearch" in cfg).toBe(false)
  })

  // (19) tampering with process.env via Object.defineProperty (rarely seen but
  //      possible in some test setups) must not bypass the gate.
  test("Object.defineProperty on process.env.QUANTA_BENCH_BRANCH_SEARCH ⇒ still parsed strictly", () => {
    Object.defineProperty(process.env, "QUANTA_BENCH_BRANCH_SEARCH", {
      value: "3",
      writable: true,
      configurable: true,
      enumerable: true,
    })
    expect(benchOptIns().branchSearch?.defaultN).toBe(3)
    // restore
    delete process.env.QUANTA_BENCH_BRANCH_SEARCH
    expect(benchOptIns().branchSearch).toBeUndefined()
  })

  // (20) order independence — setting other opt-ins first/last does not affect K parsing
  test("setting other opt-ins before/after K parse ⇒ K result unchanged", () => {
    process.env.QUANTA_BENCH_LSP = "1"
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "5"
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    const a = benchOptIns()
    expect(a.branchSearch?.defaultN).toBe(5)

    delete process.env.QUANTA_BENCH_LSP
    delete process.env.QUANTA_BENCH_SUBAGENT
    const b = benchOptIns()
    expect(b.branchSearch?.defaultN).toBe(5) // unchanged
  })
})
