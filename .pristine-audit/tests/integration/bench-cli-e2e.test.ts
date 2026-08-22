/**
 * End-to-end hellgate for the `quanta-bench` CLI (ADR-0536). Spawns the REAL
 * cli.ts as a subprocess against on-disk fixtures and asserts stdout — proving
 * the wired dispatch + analyze/remote modules actually work together, not just
 * the units. Core scenarios: presets / diff / explain / leaderboard / cost /
 * unknown-backend-error.
 *
 * `cost` is RED until the cost subcommand is wired into cli.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-cli-e2e-"))
  // wave2-clean bench-shape reports
  writeFileSync(
    join(dir, "a.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:00:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 3, resolved: 2, resolvedPct: 67 },
      scoreTotals: {
        officialHarness: 2,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 67,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        { id: "x", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
        { id: "y", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
        {
          id: "z",
          passed: false,
          turns: 1,
          patchBytes: 0,
          failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
        },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }),
  )
  writeFileSync(
    join(dir, "b.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:05:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 3, resolved: 2, resolvedPct: 67 },
      scoreTotals: {
        officialHarness: 2,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 67,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        {
          id: "x",
          passed: false,
          turns: 1,
          patchBytes: 2,
          failure: { termination: "unknown", signals: [] },
        },
        { id: "y", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
        { id: "z", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict-execfull" },
    }),
  )
  // our bench-shape report WITH usage (for cost)
  writeFileSync(
    join(dir, "report-usage.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:10:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 1, resolved: 1, resolvedPct: 100 },
      scoreTotals: {
        officialHarness: 1,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 100,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        {
          id: "x",
          passed: true,
          turns: 1,
          patchBytes: 1,
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          durationMs: 1000,
          scoreLabel: "official_harness",
        },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }),
  )
  writeFileSync(
    join(dir, "legacy-a.json"),
    JSON.stringify({
      model: "gpt-5.4",
      perInstance: [
        { id: "legacy_x", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
        {
          id: "legacy_y",
          passed: false,
          turns: 1,
          patchBytes: 0,
          failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
        },
      ],
    }),
  )
  writeFileSync(
    join(dir, "legacy-b.json"),
    JSON.stringify({
      model: "gpt-5.4",
      perInstance: [
        {
          id: "legacy_x",
          passed: false,
          turns: 1,
          patchBytes: 2,
          failure: { termination: "unknown", signals: [] },
        },
        { id: "legacy_z", passed: true, turns: 1, patchBytes: 1, scoreLabel: "official_harness" },
      ],
    }),
  )
  writeFileSync(
    join(dir, "legacy-usage.json"),
    JSON.stringify({
      model: "gpt-5.4",
      perInstance: [
        {
          id: "legacy_cost",
          passed: true,
          turns: 1,
          patchBytes: 1,
          usage: { inputTokens: 1234, outputTokens: 56 },
          durationMs: 789,
          scoreLabel: "official_harness",
        },
      ],
    }),
  )
  writeFileSync(
    join(dir, "predictions.jsonl"),
    `${JSON.stringify({
      instance_id: "demo__inst-1",
      model_name_or_path: "gpt-5.4",
      model_patch: "diff --git a/src/foo.py b/src/foo.py\n+x\n",
    })}\n`,
  )
  // tiny dataset + agent patch for explain
  writeFileSync(
    join(dir, "instances.jsonl"),
    `${JSON.stringify({
      instance_id: "demo__inst-1",
      repo: "demo/repo",
      base_commit: "0".repeat(40),
      problem_statement: "fix demo__inst-1",
      patch:
        "diff --git a/src/foo.py b/src/foo.py\n--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1 +1 @@\n-x\n+y\n",
      test_patch: "diff --git a/t.py b/t.py\n",
      FAIL_TO_PASS: ["t.py::test_a"],
    })}\n`,
  )
  writeFileSync(
    join(dir, "agent.patch"),
    "diff --git a/src/foo.py b/src/foo.py\n--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1 +1 @@\n-x\n+z\n",
  )
  writeFileSync(
    join(dir, "wave2-dataset.jsonl"),
    [
      {
        instance_id: "wave2__partial",
        patch:
          "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1 +1 @@\n-x\n+y\n\n" +
          "diff --git a/pkg/b.py b/pkg/b.py\n--- a/pkg/b.py\n+++ b/pkg/b.py\n@@ -1 +1 @@\n-x\n+y\n",
      },
      {
        instance_id: "wave2__oracle",
        patch:
          "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1 +1 @@\n-x\n+y\n\n" +
          "diff --git a/pkg/d.py b/pkg/d.py\n--- a/pkg/d.py\n+++ b/pkg/d.py\n@@ -1 +1 @@\n-x\n+y\n",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )
  writeFileSync(
    join(dir, "wave2-report.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:15:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 2, resolved: 0, resolvedPct: 0 },
      scoreTotals: {
        officialHarness: 0,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 0,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        {
          id: "wave2__partial",
          passed: false,
          turns: 1,
          patchBytes: 90,
          gradeBreakdown: {
            resolved: false,
            failToPassFailed: 1,
            passToPassFailed: 0,
            passToPassTotal: 1,
          },
        },
        {
          id: "wave2__oracle",
          passed: false,
          turns: 1,
          patchBytes: 45,
          reproTest: { installed: false, reason: "execution_failed" },
          gradeBreakdown: {
            resolved: false,
            failToPassFailed: 1,
            passToPassFailed: 0,
            passToPassTotal: 1,
          },
        },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }),
  )
  writeFileSync(
    join(dir, "wave2-predictions.jsonl"),
    [
      {
        instance_id: "wave2__partial",
        model_name_or_path: "gpt-5.4",
        model_patch:
          "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1 +1 @@\n-x\n+y\n",
      },
      {
        instance_id: "wave2__oracle",
        model_name_or_path: "gpt-5.4",
        model_patch:
          "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1 +1 @@\n-x\n+y\n",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      QUANTA_BENCH_PRESET: "",
      QUANTA_BENCH_SOTA: "",
      QUANTA_KNOBS_PRESET: "",
    },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  const code = await proc.exited
  return { code, out }
}

describe("quanta-bench CLI e2e", () => {
  test("presets lists agentless-v1", async () => {
    const { out } = await run("presets")
    expect(out).toContain("agentless-v1")
    expect(out).toContain("Default live execution preset: agentless-v3-thin-strict")
    expect(out).toContain("Individual QUANTA_BENCH_* env vars override a preset's values.")
    expect(out).toContain("QUANTA_BENCH_SOTA=1")
  })

  test("diff reports newly-resolved / regressed", async () => {
    const { out } = await run("diff", join(dir, "a.json"), join(dir, "b.json"))
    // A resolved {x,y}, B resolved {y,z} ⇒ z newly resolved, x newly broken
    expect(out).toContain("newly resolved")
    expect(out).toContain("z")
    expect(out.toLowerCase()).toContain("newly broken")
  })

  test("diff stays usable for legacy non-wave2 reports", async () => {
    const { code, out } = await run("diff", join(dir, "legacy-a.json"), join(dir, "legacy-b.json"))
    expect(code).toBe(0)
    expect(out).toContain("newly resolved")
    expect(out).toContain("legacy_z")
    expect(out.toLowerCase()).toContain("newly broken")
  })

  test("explain surfaces FAIL_TO_PASS + a verdict", async () => {
    const { out } = await run(
      "explain",
      "--dataset",
      join(dir, "instances.jsonl"),
      "--instance",
      "demo__inst-1",
      "--patch",
      join(dir, "agent.patch"),
    )
    expect(out).toContain("t.py::test_a")
    expect(out).toContain("Verdict:")
  })

  test("leaderboard renders a resolved table", async () => {
    const { out } = await run("leaderboard", join(dir, "a.json"))
    expect(out).toContain("Official harness resolved")
    expect(out).toContain("| instance |")
  })

  test("leaderboard stays usable for legacy non-wave2 reports", async () => {
    const { code, out } = await run("leaderboard", join(dir, "legacy-a.json"))
    expect(code).toBe(0)
    expect(out).toContain("Official harness resolved")
    expect(out).toContain("legacy_x")
    expect(out).toContain("| unknown |")
  })

  test("cost reports tokens/$ for a report with usage", async () => {
    const { out } = await run("cost", join(dir, "report-usage.json"))
    // 1M input tokens — the cost subcommand must surface token/cost numbers.
    expect(out).toMatch(/token|cost|\$/i)
    expect(out).toContain("1000000") // 1M input tokens surfaced somewhere
  })

  test("cost stays usable for legacy non-wave2 reports", async () => {
    const { code, out } = await run("cost", join(dir, "legacy-usage.json"))
    expect(code).toBe(0)
    expect(out).toContain("legacy_cost")
    expect(out).toContain("1234")
  })

  test("wave2-coverage renders same/partial/disjoint census from clean artifacts", async () => {
    const { out } = await run(
      "wave2-coverage",
      "--dataset",
      join(dir, "wave2-dataset.jsonl"),
      "--report",
      join(dir, "wave2-report.json"),
      "--predictions",
      join(dir, "wave2-predictions.jsonl"),
      "--min-cases",
      "1",
    )
    expect(out).toContain("Wave2 Coverage Census")
    expect(out).toContain("partial overlap")
    expect(out).toContain("wave2__partial")
  })

  test("wave2-backlog renders completeness vs oracle buckets", async () => {
    const { out } = await run(
      "wave2-backlog",
      "--dataset",
      join(dir, "wave2-dataset.jsonl"),
      "--report",
      join(dir, "wave2-report.json"),
      "--predictions",
      join(dir, "wave2-predictions.jsonl"),
    )
    expect(out).toContain("Wave2 Follow-on Backlog")
    expect(out).toContain("Multi-Site / Completeness Failures")
    expect(out).toContain("Oracle-Quality Failures")
    expect(out).toContain("wave2__partial")
    expect(out).toContain("wave2__oracle")
  })

  test("run --dry-run surfaces the current base preset instead of implicit baseline", async () => {
    const { code, out } = await run("run", "--swebench", join(dir, "instances.jsonl"), "--dry-run")
    expect(code).toBe(0)
    expect(out).toContain("dry-run plan")
    expect(out).toContain("preset: agentless-v3-thin-strict")
  })

  test("grade --mode full WITHOUT --allow-remote-secrets is refused (secret gate)", async () => {
    const { code, out } = await run(
      "grade",
      "--predictions",
      join(dir, "predictions.jsonl"),
      "--backend",
      "ec2",
      "--dataset",
      join(dir, "instances.jsonl"),
      "--mode",
      "full",
    )
    expect(code).not.toBe(0)
    expect(out.toLowerCase()).toContain("--allow-remote-secrets")
  })

  test("grade --mode full --allow-remote-secrets --dry-run plans WITHOUT launching/shipping", async () => {
    const { out } = await run(
      "grade",
      "--backend",
      "ec2",
      "--dataset",
      join(dir, "instances.jsonl"),
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dry-run",
    )
    // executor wired: prints the plan, and the plan documents the access-token-only posture
    expect(out.toLowerCase()).toContain("dry-run")
    expect(out.toLowerCase()).toMatch(/access_token only|refresh.*dropped/)
    expect(out).toContain("preset=agentless-v3-thin-strict")
    expect(out.toLowerCase()).toContain("pyright")
  })

  test("grade with unknown backend errors out (non-zero)", async () => {
    const { code, out } = await run(
      "grade",
      "--predictions",
      join(dir, "predictions.jsonl"),
      "--backend",
      "bogus",
      "--dataset",
      join(dir, "instances.jsonl"),
    )
    expect(code).not.toBe(0)
    expect(out.toLowerCase()).toContain("unknown --backend")
  })
})
