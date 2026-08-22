import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "../../dataset-family-token"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"

/** The PRODUCTION seam this pins: `buildBenchCommand` resolves the chunk's family
 *  profile and calls its `onBoxEnvPrefix` port. aug-22 HIGH-4 replaced the old
 *  `buildProEnv(family, env, path)` wrapper — which held the `family === "pro"`
 *  compare inside box-session — with this profile field. */
const buildProEnv = (family: DatasetFamily, env: NodeJS.ProcessEnv, datasetPath: string): string =>
  resolveDatasetFamilyProfile(family).onBoxEnvPrefix({ datasetPath, env })

// Wiring-proof (jun-30): QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME / _MODEL_NAME are operator
// overrides READ by buildProGradeVerifier (apps/bench/index.ts) but are neither
// QUANTA_BENCH_*-prefixed nor in FORWARD_EXTRA_ENV — so on full-remote/pool runs they were
// SILENTLY DROPPED and the box graded with the verifier defaults (jefzda / quanta). A fork whose
// Pro images live under a different DockerHub user would have every image-pull fail (all-infra).
// These pin the Pro-only forward.
describe("onBoxEnvPrefix — Pro override forwarding (jun-30 wiring fix)", () => {
  const DATASET = "~/instances.jsonl"

  test("forwards QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME + _MODEL_NAME (shell-quoted) on Pro", () => {
    const out = buildProEnv(
      "pro",
      {
        QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME: "myfork",
        QUANTA_SWEBENCH_PRO_MODEL_NAME: "my-model",
      },
      DATASET,
    )
    expect(out).toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME='myfork'")
    expect(out).toContain("QUANTA_SWEBENCH_PRO_MODEL_NAME='my-model'")
    // the base Pro verifier wiring is still present
    expect(out).toContain('QUANTA_SWEBENCH_PRO_HARNESS_DIR="$HOME/swebench-pro"')
    expect(out).toContain("QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH=")
  })

  test("a Pro run WITHOUT the overrides omits both keys (byte-identical to legacy proEnv)", () => {
    const out = buildProEnv("pro", {}, DATASET)
    expect(out).not.toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME")
    expect(out).not.toContain("QUANTA_SWEBENCH_PRO_MODEL_NAME")
    // legacy three-var proEnv, exact spacing
    expect(out).toBe(
      `QUANTA_SWEBENCH_PRO_HARNESS_DIR="$HOME/swebench-pro" ` +
        `QUANTA_SWEBENCH_PRO_PYTHON_BIN="$HOME/swebench-pro-venv/bin/python" ` +
        `QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH="$HOME/instances.jsonl" `,
    )
  })

  test("expands a pool dataset path before Node resolves it", () => {
    const out = buildProEnv("pro", {}, "~/runs/chunk-01/instances.jsonl")
    expect(out).toContain(
      `QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH="$HOME/runs/chunk-01/instances.jsonl"`,
    )
    expect(out).not.toContain("='~/")
  })

  test("empty-string overrides are treated as unset (not forwarded)", () => {
    const out = buildProEnv(
      "pro",
      {
        QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME: "",
        QUANTA_SWEBENCH_PRO_MODEL_NAME: "",
      },
      DATASET,
    )
    expect(out).not.toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME")
    expect(out).not.toContain("QUANTA_SWEBENCH_PRO_MODEL_NAME")
  })

  test("non-Pro family forwards NOTHING even when overrides are set (byte-identical Verified/Live)", () => {
    const verified = buildProEnv(
      "verified",
      {
        QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME: "myfork",
        QUANTA_SWEBENCH_PRO_MODEL_NAME: "my-model",
      },
      DATASET,
    )
    expect(verified).toBe("")
    expect(buildProEnv("live", {}, DATASET)).toBe("")
    // The whole family union flows through: ONLY pro emits a prefix, and the
    // decision comes from the TYPED argument — an ambient env var claiming "pro"
    // can no longer switch it on.
    expect(buildProEnv("verified", { QUANTA_SWEBENCH_DATASET_FAMILY: "pro" }, DATASET)).toBe("")
    expect(buildProEnv("pro", {}, DATASET)).not.toBe("")
  })
})
