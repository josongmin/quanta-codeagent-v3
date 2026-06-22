import { describe, expect, test } from "bun:test"
import { buildForwardedBenchEnv } from "@/apps/bench/remote/full"

/**
 * Hellgate: full-remote forwards the operator's local `QUANTA_BENCH_*` knobs to
 * the box. Without this, env-only experiment knobs (spec-fidelity-steer,
 * verification-plan — NOT bundled in any preset) are SILENTLY INERT on the box
 * and a remote A/B reads as a null effect (jun-16 env-forwarding bug class).
 *
 * Scope is `QUANTA_BENCH_*` PLUS a small explicit `FORWARD_EXTRA_ENV` allowlist
 * of non-prefixed runtime-config dials the bench runner reads directly
 * (`QUANTA_MAX_TURNS` → `maxTurnsBatch`; jun-20).
 *
 * Red-on-injection:
 *  - drop the forward ⇒ FWD-1/FWD-2 RED.
 *  - forward the explicitly-handled keys too ⇒ FWD-3 RED (double-assignment).
 *  - widen scope to arbitrary non-allowlisted vars ⇒ FWD-4 RED (secret leak).
 *  - drop QUANTA_MAX_TURNS from the allowlist ⇒ FWD-7 RED (turn budget stuck at
 *    the box default 60 → complex instances max_turns_exhausted).
 */
describe("buildForwardedBenchEnv", () => {
  test("FWD-1: experiment knobs (spec-fidelity, verification-plan) are forwarded", () => {
    const out = buildForwardedBenchEnv({
      QUANTA_BENCH_SPEC_FIDELITY_STEER: "1",
      QUANTA_BENCH_VERIFICATION_PLAN: "1",
    })
    expect(out).toContain("QUANTA_BENCH_SPEC_FIDELITY_STEER='1' ")
    expect(out).toContain("QUANTA_BENCH_VERIFICATION_PLAN='1' ")
  })

  test("FWD-2: values are shell-quoted (no command injection)", () => {
    const out = buildForwardedBenchEnv({ QUANTA_BENCH_LSP_STEER: "off; rm -rf /" })
    expect(out).toBe("QUANTA_BENCH_LSP_STEER='off; rm -rf /' ")
  })

  test("FWD-3: explicitly-handled keys are NOT re-forwarded (no double-assign)", () => {
    const out = buildForwardedBenchEnv({
      QUANTA_BENCH_PRESET: "agentless-v1-nosteer",
      QUANTA_BENCH_CONCURRENCY: "6",
      QUANTA_BENCH_RECORD_TRAJECTORY: "1",
      QUANTA_BENCH_SPEC_FIDELITY_STEER: "1",
    })
    expect(out).not.toContain("QUANTA_BENCH_PRESET")
    expect(out).not.toContain("QUANTA_BENCH_CONCURRENCY")
    expect(out).not.toContain("QUANTA_BENCH_RECORD_TRAJECTORY")
    expect(out).toContain("QUANTA_BENCH_SPEC_FIDELITY_STEER='1' ")
  })

  test("FWD-4: scope is QUANTA_BENCH_* only — secrets / other vars never forwarded", () => {
    const out = buildForwardedBenchEnv({
      QUANTA_BENCH_SPEC_FIDELITY_STEER: "1",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      QUANTA_PROVIDER: "chatgpt-oauth",
      HOME: "/Users/x",
    })
    expect(out).toBe("QUANTA_BENCH_SPEC_FIDELITY_STEER='1' ")
  })

  test("FWD-5: empty / unset values are skipped; deterministic sorted order", () => {
    const out = buildForwardedBenchEnv({
      QUANTA_BENCH_Z: "1",
      QUANTA_BENCH_A: "1",
      QUANTA_BENCH_EMPTY: "",
    })
    expect(out).toBe("QUANTA_BENCH_A='1' QUANTA_BENCH_Z='1' ")
  })

  test("FWD-6: no bench knobs ⇒ empty string (byte-identical box command)", () => {
    expect(buildForwardedBenchEnv({ HOME: "/x", QUANTA_PROVIDER: "chatgpt-oauth" })).toBe("")
  })

  test("FWD-7: QUANTA_MAX_TURNS (non-BENCH allowlist) reaches the box", () => {
    // Without forwarding, the box falls back to the preset default (60) and
    // complex instances exhaust turns even when the operator raised the budget.
    const out = buildForwardedBenchEnv({ QUANTA_MAX_TURNS: "120", QUANTA_BENCH_A: "1" })
    expect(out).toContain("QUANTA_MAX_TURNS='120' ")
    // still NOT a blanket widening — a sibling non-allowlisted var stays home.
    expect(buildForwardedBenchEnv({ QUANTA_RUN_ID: "run-x" })).toBe("")
  })

  test("FWD-8: local bench replay cassette path is rejected for full-remote/pool runs", () => {
    expect(() =>
      buildForwardedBenchEnv({
        QUANTA_BENCH_REPLAY_TRAJECTORY: "/tmp/bench-trajectory.jsonl",
      }),
    ).toThrow(/QUANTA_BENCH_REPLAY_TRAJECTORY/)
  })
})
