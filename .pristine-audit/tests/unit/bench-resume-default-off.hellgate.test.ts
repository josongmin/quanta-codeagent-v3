/**
 * HELLGATE — bench-resume byte-identical DEFAULT-OFF guard (config layer).
 *
 * The resume feature streams a per-turn cassette to S3 and replays on a fresh
 * box after spot reclaim. That MUST be opt-in: with `QUANTA_BENCH_RESUME` unset,
 * resolving config against the REAL `process.env` yields `enabled:false`, and
 * `resumeActive` is false no matter what other env is present (fail-closed). This
 * is the config-layer half of the all-knobs-default-OFF invariant — if it ever
 * goes true with the gate unset, a normal bench run would silently start hitting
 * S3.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveResumeConfig, resumeActive } from "@/apps/bench/resume"

describe("bench-resume default-OFF (config layer)", () => {
  const saved = process.env.QUANTA_BENCH_RESUME
  beforeEach(() => {
    delete process.env.QUANTA_BENCH_RESUME
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUANTA_BENCH_RESUME
    else process.env.QUANTA_BENCH_RESUME = saved
  })

  test("unset gate ⇒ resolveResumeConfig(process.env).enabled === false", () => {
    expect(process.env.QUANTA_BENCH_RESUME).toBeUndefined()
    const c = resolveResumeConfig(process.env)
    expect(c.enabled).toBe(false)
  })

  test("unset gate ⇒ resumeActive === false even with a bucket present", () => {
    const c = resolveResumeConfig({
      ...process.env,
      QUANTA_BENCH_RESUME_S3_BUCKET: "would-be-bucket",
    })
    expect(c.enabled).toBe(false)
    expect(resumeActive(c)).toBe(false)
  })
})
