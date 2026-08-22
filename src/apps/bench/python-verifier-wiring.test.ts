/**
 * HELLGATE — the T4 GRADE port is consumed on the LOCAL-RUN path (aug-22
 * re-audit R6).
 *
 * `run-main.ts` fills the single `RunCfg.pythonSwebench` seam via
 * `buildPythonSwebench(cfg.family, exit)` on BOTH real local production paths
 * (the official-dataset mode and the custom-corpus mode). That builder
 * short-circuits on `profile.gradesWithProHarness` — and the short-circuited
 * branch then called `gradeEvaluatorForFamily("pro", …)`, a HARDCODED family.
 *
 * So the T4 stop rule ("adding a dataset family is one token + one profile
 * object, and NOTHING in any consumer") was false exactly here: a family #4 that
 * grades through the pro-style harness reached this branch and was handed the
 * PRO profile's evaluator instead of its own `gradeEvaluator` port. Its grade
 * port was unreachable from the real local run.
 *
 * OBSERVABLE: the evaluator actually installed into the seam is CALLED, and the
 * verdict it returns is the one this family's own port produces. No source
 * scanning, no spying on internals — the returned function is invoked and its
 * output compared.
 *
 * NON-VACUITY: the synthetic family is registered through the ONE production
 * extension point (`registerDatasetFamilyProfile`) and NOTHING else, and the
 * paired control shows the built-in `pro` family still reaches the built-in Pro
 * port — so a builder that returned a constant sentinel for everyone fails.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetFamily } from "./dataset-family-token"
import { officialJsonlCorpusReader } from "./profiles/jsonl-corpus"
import { registerDatasetFamilyProfile } from "./profiles/registry"
import type { DatasetFamilyProfile, FamilyGradeEvaluator } from "./profiles/types"
import { buildPythonSwebench } from "./python-verifier-wiring"
import type { ExitFn } from "./run-main"
import type { Instance } from "./types"

const FIX = (() => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-grade-port-"))
  const harnessDir = join(dir, "harness")
  const rawSample = join(dir, "raw.jsonl")
  writeFileSync(rawSample, "")
  return { dir, harnessDir, rawSample }
})()

const PRO_ENV_KEYS = [
  "QUANTA_SWEBENCH_PRO_HARNESS_DIR",
  "QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH",
  "QUANTA_SWEBENCH_PRO_PYTHON_BIN",
  "QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME",
  "QUANTA_SWEBENCH_PRO_MODEL_NAME",
] as const

const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

/** Run `body` with the pro-harness operator knobs pointed at a temp dir, so the
 *  builder's fail-closed "REFUSING to fake-grade" guard is satisfied without any
 *  real harness on disk. */
const withProHarnessEnv = async <T>(body: () => Promise<T>): Promise<T> => {
  const before = new Map(PRO_ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.QUANTA_SWEBENCH_PRO_HARNESS_DIR = FIX.harnessDir
  process.env.QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH = FIX.rawSample
  try {
    return await body()
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const INSTANCE = { instanceId: "demo__pkg-1" } as unknown as Instance

/** A family whose grade port returns a value NOTHING else in the registry can
 *  produce, so "the port was consumed" is directly observable in the verdict. */
const registerProbeFamily = (
  family: string,
  marker: string,
  seen: { proOpts?: unknown },
): DatasetFamily => {
  const evaluator: FamilyGradeEvaluator = async () =>
    ({ ok: true, verdict: marker }) as unknown as Awaited<ReturnType<FamilyGradeEvaluator>>
  const profile: DatasetFamilyProfile = {
    family: family as DatasetFamily,
    // PMX-01: each probe family partitions under its own key (the registry
    // refuses a duplicate), so a probe can never merge into a real family's score.
    reportPartitionKey: family,
    verifierLabel: `${marker} harness`,
    gradesWithProHarness: true,
    readCorpus: officialJsonlCorpusReader,
    gradeEvaluator: (proOpts) => {
      seen.proOpts = proOpts
      return evaluator
    },
    harnessSpec: () => ({ pipSpec: "swebench", namespace: "swebench" }),
    onBoxEnvPrefix: () => "",
    admitBox: () => {},
    setupBox: async () => {},
    preflight: () => {},
  }
  disposers.push(registerDatasetFamilyProfile(profile))
  return family as DatasetFamily
}

describe("R6 — buildPythonSwebench routes the pro-harness branch through the FAMILY's own grade port", () => {
  test("a registered family #4 gets ITS evaluator, not the hardcoded Pro one", async () => {
    const seen: { proOpts?: unknown } = {}
    const family = registerProbeFamily("family4grade", "FAMILY4-VERDICT", seen)
    const wiring = await withProHarnessEnv(async () =>
      buildPythonSwebench(family, () => {
        throw new Error("builder refused (exit) — the pro-harness knobs were not honoured")
      }),
    )
    expect(wiring, "no pythonSwebench wiring was produced at all").toBeDefined()
    // REAL EFFECT: call the evaluator the seam would receive.
    const evaluate = wiring?.evaluate
    expect(evaluate, "the wiring carried no evaluator at all").toBeDefined()
    if (evaluate === undefined) throw new Error("no evaluator")
    const verdict = (await evaluate(INSTANCE, "diff --git a/x b/x")) as unknown as {
      verdict?: string
    }
    expect(
      verdict?.verdict,
      "the local-run grade seam did NOT receive family4's own gradeEvaluator",
    ).toBe("FAMILY4-VERDICT")
    // The harness opts really reached the port (not an opts-less call).
    expect(seen.proOpts).toMatchObject({ harnessDir: FIX.harnessDir })
  })

  test("PAIRED CONTROL — the built-in `pro` family still reaches the BUILT-IN Pro port", async () => {
    // A builder that just returned the last-registered sentinel for every family
    // would pass the test above and fail here.
    const seen: { proOpts?: unknown } = {}
    registerProbeFamily("family4control", "OTHER-FAMILY-VERDICT", seen)
    const wiring = await withProHarnessEnv(async () =>
      buildPythonSwebench("pro", () => {
        throw new Error("builder refused (exit) for pro")
      }),
    )
    expect(wiring).toBeDefined()
    // Pro's port was NOT the probe family's port: the probe's gradeEvaluator was
    // never invoked while building the `pro` wiring.
    expect(seen.proOpts).toBeUndefined()
  })

  test("PAIRED CONTROL — a NON-pro-harness family is untouched by this branch", async () => {
    // `verified` has gradesWithProHarness:false, so it must NOT take the branch —
    // with the official-harness gate off it produces no wiring at all.
    const before = process.env.QUANTA_SWEBENCH_PYTHON
    delete process.env.QUANTA_SWEBENCH_PYTHON
    try {
      const wiring = await withProHarnessEnv(async () =>
        buildPythonSwebench("verified", () => {
          throw new Error("verified must not reach the fail-closed pro exit")
        }),
      )
      expect(wiring).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env.QUANTA_SWEBENCH_PYTHON
      else process.env.QUANTA_SWEBENCH_PYTHON = before
    }
  })

  test("the pro-harness branch still FAILS CLOSED when its knobs are missing", async () => {
    // The short-circuit's load-bearing safety property, unchanged by the repair:
    // no harness dir ⇒ refuse + exit, never a silent fake-grade.
    const seen: { proOpts?: unknown } = {}
    const family = registerProbeFamily("family4failclosed", "NEVER", seen)
    const before = new Map(PRO_ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of PRO_ENV_KEYS) delete process.env[k]
    const argvBefore = process.argv
    process.argv = ["bun", "cli.ts", "run"] // no --swebench ⇒ no rawSamplePath
    let exited: number | undefined
    try {
      const wiring = await buildPythonSwebench(family, ((code: number) => {
        exited = code
      }) as unknown as ExitFn)
      expect(wiring).toBeUndefined()
      expect(exited).toBe(1)
      expect(seen.proOpts, "a refused build must not construct an evaluator").toBeUndefined()
    } finally {
      process.argv = argvBefore
      for (const [k, v] of before) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
