/**
 * PMX-04 — the MULTILINGUAL execution posture, and `working_dir` as pure record.
 *
 * Two ticket rules that are easy to state and easy to violate silently:
 *
 *  1. *"PMX integration smoke uses an explicitly FROZEN portable preset; it never
 *     inherits the repo default implicitly."* The repo default is
 *     `agentless-v3-thin-strict`, which REQUIRES live LSP grounding — and the
 *     remote box proves only `pyright-langserver`, while ProMax spans seven
 *     languages. Inheriting it makes six of seven languages unlaunchable.
 *  2. *"`working_dir` stays recorded but is NOT routed into patch application."*
 *     The pinned evaluator applies patches under hard-coded `/testbed`; honouring
 *     a row's `working_dir` would fork the grader while still calling itself the
 *     frozen evaluator.
 *
 * Everything is asserted against the REAL production resolvers.
 *
 * ⚠️ No box, no Docker, no network.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DATASET_FAMILIES } from "@/apps/bench/dataset-family-token"
import {
  buildProMaxEvaluatorInvocation,
  proMaxPreflightProbeScript,
} from "@/apps/bench/harness/promax"
import {
  CURRENT_BENCH_BASE_PRESET,
  presetRequiresLiveLspGrounding,
  resolveRemoteBenchExecutionPreset,
} from "@/apps/bench/preset"
import { PROMAX_FROZEN_PORTABLE_PRESET } from "@/apps/bench/profiles/promax"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import {
  assertRemoteStrictGroundingSupported,
  UnsupportedRemoteStrictLspGroundingError,
} from "@/apps/bench/remote/box-session/dataset-preflight"

const DIRS: string[] = []
afterAll(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true })
})

const corpusOf = (language: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx-posture-"))
  DIRS.push(dir)
  const path = join(dir, "public-tasks.jsonl")
  writeFileSync(
    path,
    `${JSON.stringify({
      instance_id: `promax__${language}-1`,
      repo: "acme/thing",
      base_commit: "1".repeat(40),
      problem_statement: "broken",
      language,
    })}\n`,
  )
  return path
}

describe("PMX-04 — the ProMax remote preset is an explicitly FROZEN portable one", () => {
  test("the frozen preset is named, LSP-optional, and NOT the repo default", () => {
    expect(PROMAX_FROZEN_PORTABLE_PRESET).not.toBe(CURRENT_BENCH_BASE_PRESET)
    expect(presetRequiresLiveLspGrounding(PROMAX_FROZEN_PORTABLE_PRESET)).toBe(false)
    // paired control: the repo default really does require it, so the claim above
    // is a difference, not a coincidence.
    expect(presetRequiresLiveLspGrounding(CURRENT_BENCH_BASE_PRESET)).toBe(true)
  })

  test("a ProMax remote run with NO operator preset resolves to the frozen preset", () => {
    expect(resolveRemoteBenchExecutionPreset({ family: "promax", envVars: {} })).toBe(
      PROMAX_FROZEN_PORTABLE_PRESET,
    )
    // the profile field is the SSOT the resolver reads (not a second constant)
    expect(resolveDatasetFamilyProfile("promax").remoteDefaultPreset).toBe(
      PROMAX_FROZEN_PORTABLE_PRESET,
    )
  })

  test("an EXPLICIT operator preset still wins — the freeze is a default, not a lock", () => {
    expect(
      resolveRemoteBenchExecutionPreset({
        family: "promax",
        envVars: { QUANTA_BENCH_PRESET: CURRENT_BENCH_BASE_PRESET },
      }),
    ).toBe(CURRENT_BENCH_BASE_PRESET)
  })

  test("the whole family union flows through: only pro/promax override the default", () => {
    const overriding = DATASET_FAMILIES.filter(
      (f) =>
        resolveRemoteBenchExecutionPreset({ family: f, envVars: {} }) !== CURRENT_BENCH_BASE_PRESET,
    )
    expect([...overriding].sort()).toEqual(["pro", "promax"])
  })
})

describe("PMX-04 — strict-LSP admission is not used for the cross-language headline", () => {
  test("under the FROZEN portable preset a Java ProMax task launches (no LSP demanded)", () => {
    expect(() =>
      assertRemoteStrictGroundingSupported({
        preset: PROMAX_FROZEN_PORTABLE_PRESET,
        datasetPath: corpusOf("java"),
        surface: "full-remote",
        family: "promax",
      }),
    ).not.toThrow()
  })

  test("under a STRICT preset the same Java task is refused BY NAME, not by guesswork", () => {
    let caught: unknown
    try {
      assertRemoteStrictGroundingSupported({
        preset: CURRENT_BENCH_BASE_PRESET,
        datasetPath: corpusOf("java"),
        surface: "full-remote",
        family: "promax",
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsupportedRemoteStrictLspGroundingError)
    const message = caught instanceof Error ? caught.message : ""
    expect(message).toContain("java")
    expect(message).toContain("promax__java-1")
  })

  test("a strict preset also refuses the other unsupported ProMax languages by name", () => {
    for (const language of ["c", "c++", "go", "rust", "typescript"]) {
      let message = ""
      try {
        assertRemoteStrictGroundingSupported({
          preset: CURRENT_BENCH_BASE_PRESET,
          datasetPath: corpusOf(language),
          surface: "full-remote",
          family: "promax",
        })
      } catch (err) {
        message = err instanceof Error ? err.message : ""
      }
      expect(message).not.toBe("")
      expect(message).toContain(`promax__${language}-1`)
    }
    // paired control: Python — the ONE language the box proves — is admitted.
    expect(() =>
      assertRemoteStrictGroundingSupported({
        preset: CURRENT_BENCH_BASE_PRESET,
        datasetPath: corpusOf("python"),
        surface: "full-remote",
        family: "promax",
      }),
    ).not.toThrow()
  })
})

describe("PMX-04 — `working_dir` is recorded, never routed into patch application", () => {
  test("the evaluator invocation carries no working_dir anywhere in its argv", () => {
    const inv = buildProMaxEvaluatorInvocation({
      pinnedRoot: "/opt/quanta/promax/upstream",
      predictionsPath: "/campaign/preds.json",
      goldenPath: "/campaign/campaign-golden.json",
      outputPath: "/campaign/pass-rate.json",
    })
    if (!inv.ok) throw new Error("invocation refused")
    const flat = inv.invocation.argv.join(" ")
    expect(flat).not.toContain("working_dir")
    expect(flat).not.toContain("--workdir")
    expect(flat).not.toContain("/workspace")
    // the pinned evaluator gets a golden + preds + eval path and nothing else
    expect(inv.invocation.argv).toEqual([
      "python",
      "/opt/quanta/promax/upstream/src/evaluation/test_run.py",
      "--pred",
      "/campaign/preds.json",
      "--golden",
      "/campaign/campaign-golden.json",
      "--eval",
      "/opt/quanta/promax/upstream/data/eval.json",
      "--output",
      "/campaign/pass-rate.json",
      "--workers",
      "1",
    ])
  })

  test("the preflight probe uses upstream's hard-coded /testbed, never a row working_dir", () => {
    const script = proMaxPreflightProbeScript("PMX-7@abc")
    expect(script).toContain("/testbed/")
    expect(script).not.toContain("/workspace")
    expect(script).not.toContain("working_dir")
  })

  test("`--cleanup` is never passed — the pulled images are the campaign's replay evidence", () => {
    const inv = buildProMaxEvaluatorInvocation({
      pinnedRoot: "/opt/quanta/promax/upstream",
      predictionsPath: "/campaign/preds.json",
      goldenPath: "/campaign/campaign-golden.json",
      outputPath: "/campaign/pass-rate.json",
    })
    if (!inv.ok) throw new Error("invocation refused")
    expect(inv.invocation.argv).not.toContain("--cleanup")
  })
})
