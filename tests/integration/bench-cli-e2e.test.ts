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
  // swebench-shape reports
  writeFileSync(
    join(dir, "a.json"),
    JSON.stringify({
      resolved_ids: ["x", "y"],
      unresolved_ids: ["z"],
      error_ids: [],
      empty_patch_ids: [],
    }),
  )
  writeFileSync(
    join(dir, "b.json"),
    JSON.stringify({
      resolved_ids: ["y", "z"],
      unresolved_ids: ["x"],
      error_ids: [],
      empty_patch_ids: [],
    }),
  )
  // our bench-shape report WITH usage (for cost)
  writeFileSync(
    join(dir, "report-usage.json"),
    JSON.stringify({
      model: "gpt-5.4",
      perInstance: [
        {
          id: "x",
          passed: true,
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          durationMs: 1000,
        },
      ],
    }),
  )
  // tiny dataset + agent patch for explain
  writeFileSync(
    join(dir, "instances.jsonl"),
    `${JSON.stringify({
      instance_id: "demo__inst-1",
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
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  const code = await proc.exited
  return { code, out }
}

describe("quanta-bench CLI e2e", () => {
  test("presets lists agentless-v1", async () => {
    const { out } = await run("presets")
    expect(out).toContain("agentless-v1")
  })

  test("diff reports newly-resolved / regressed", async () => {
    const { out } = await run("diff", join(dir, "a.json"), join(dir, "b.json"))
    // A resolved {x,y}, B resolved {y,z} ⇒ z newly resolved, x newly broken
    expect(out).toContain("newly resolved")
    expect(out).toContain("z")
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
    expect(out.toLowerCase()).toContain("resolved")
    expect(out).toContain("| instance |")
  })

  test("cost reports tokens/$ for a report with usage", async () => {
    const { out } = await run("cost", join(dir, "report-usage.json"))
    // 1M input tokens — the cost subcommand must surface token/cost numbers.
    expect(out).toMatch(/token|cost|\$/i)
    expect(out).toContain("1000000") // 1M input tokens surfaced somewhere
  })

  test("grade --mode full WITHOUT --allow-remote-secrets is refused (secret gate)", async () => {
    const { code, out } = await run(
      "grade",
      "--predictions",
      join(dir, "a.json"),
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

  test("grade --mode full --allow-remote-secrets is gated (executor pending hardening)", async () => {
    const { code, out } = await run(
      "grade",
      "--predictions",
      join(dir, "a.json"),
      "--backend",
      "ec2",
      "--dataset",
      join(dir, "instances.jsonl"),
      "--mode",
      "full",
      "--allow-remote-secrets",
    )
    expect(code).not.toBe(0)
    // honest: full-remote executor deliberately deferred pending §6 hardening
    expect(out.toLowerCase()).toMatch(/not yet|pending|hardening|§6|adr-0536/)
  })

  test("grade with unknown backend errors out (non-zero)", async () => {
    const { code, out } = await run(
      "grade",
      "--predictions",
      join(dir, "a.json"),
      "--backend",
      "bogus",
      "--dataset",
      join(dir, "instances.jsonl"),
    )
    expect(code).not.toBe(0)
    expect(out.toLowerCase()).toContain("unknown --backend")
  })
})
