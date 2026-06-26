/**
 * Hellgate E2E (true subprocess) — the operator-facing token/cost workflow.
 *
 * docs/plans/jun-26-bench-token-usage-tracking.md. The in-process tests prove
 * each link (wire→tap→report serialization, pricing math). THIS proves the whole
 * thing through the REAL `quanta-bench cost` CLI binary, spawned as a separate
 * process, reading a report.json off disk — exactly what an operator runs after a
 * campaign. No mocks, no in-process shortcut.
 *
 * Three scenarios, each adversarial:
 *   1. PRIMARY  — report.json carries usage (incl. an OpenAI cached bucket) ⇒ the
 *                 CLI renders real tokens + the cache-CARVE-OUT cost (not a
 *                 double-count, not $0). This is the `cost.ts` path-1 SSOT.
 *   2. BACKFILL — report.json has NO usage but an observe/ trajectory does ⇒ the
 *                 CLI `--observe-dir` backfills tokens (the fallback path).
 *   3. HONESTY  — usage present but the model is UNPRICED ⇒ the CLI prints a
 *                 visible caveat and "—", NEVER a fake "$0.0000" (the teeth).
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(import.meta.dir, "..", "..", "src", "apps", "bench", "cli.ts")

/** Run the real `quanta-bench cost` CLI as a subprocess; return stdout+stderr. */
const runCostCli = async (args: string[]): Promise<{ out: string; code: number }> => {
  const proc = Bun.spawn(["bun", "run", CLI, "cost", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // SSOT mirror is irrelevant to `cost` (it only reads) — pin it off anyway so
    // the test never touches ~/.quanta.
    env: { ...process.env, QUANTA_BENCH_RESULTS_DIR: "off" },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out: out + err, code }
}

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "cost-cli-e2e-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("hellgate E2E — quanta-bench cost CLI (real subprocess)", () => {
  test("PRIMARY: report.json usage incl. cache ⇒ real tokens + carve-out cost", async () => {
    await withDir(async (dir) => {
      const reportPath = join(dir, "report.json")
      // gpt-5.4 (OpenAI-family, in SSOT): 1M input of which 400k cached, 200k out.
      // carve-out: 600k*1.25 + 400k*0.625 + 200k*10 (all /1e6) = 0.75 + 0.25 + 2.0 = $3.00.
      // A double-count bug would render $4.00 here.
      writeFileSync(
        reportPath,
        JSON.stringify({
          model: "gpt-5.4",
          provider: "chatgpt-oauth",
          perInstance: [
            {
              id: "psf__requests-1",
              passed: true,
              usage: {
                model: "gpt-5.4",
                inputTokens: 1_000_000,
                outputTokens: 200_000,
                cacheReadTokens: 400_000,
              },
              durationMs: 42_000,
            },
          ],
        }),
      )
      const { out, code } = await runCostCli([reportPath])
      expect(code).toBe(0)
      expect(out).toContain("1000000") // input tokens surfaced
      expect(out).toContain("200000") // output tokens surfaced
      expect(out).toContain("$3.0000") // cache carve-out cost (NOT $4.0000)
      expect(out).not.toContain("$4.0000")
      expect(out).toContain("1/1 instances had token data")
      // Teeth: the honest-caveat branches must NOT fire when data is real.
      expect(out).not.toMatch(/NO token usage|NO pricing/)
    })
  })

  test("BACKFILL: no report usage + observe jsonl ⇒ CLI --observe-dir backfills tokens", async () => {
    await withDir(async (dir) => {
      const reportPath = join(dir, "report.json")
      writeFileSync(
        reportPath,
        JSON.stringify({
          model: "gpt-5.4",
          provider: "chatgpt-oauth",
          perInstance: [{ id: "psf__requests-5414", passed: true }], // NO usage
        }),
      )
      const observeDir = join(dir, "observe")
      mkdirSync(observeDir, { recursive: true })
      writeFileSync(
        join(observeDir, "psf__requests-5414.0.jsonl"),
        [
          JSON.stringify({ ts: 1000, kind: "llm", data: { inputTokens: 700, outputTokens: 90 } }),
          JSON.stringify({ ts: 5000, kind: "llm", data: { inputTokens: 300, outputTokens: 10 } }),
        ].join("\n"),
      )
      const { out, code } = await runCostCli([reportPath, "--observe-dir", observeDir])
      expect(code).toBe(0)
      expect(out).toContain("1000") // 700+300 input tokens backfilled
      expect(out).toContain("100") // 90+10 output tokens backfilled
      expect(out).toContain("1/1 instances had token data")
      expect(out).not.toContain("NO token usage")
    })
  })

  test("HONESTY: unpriced model with real tokens ⇒ caveat + '—', never fake $0", async () => {
    await withDir(async (dir) => {
      const reportPath = join(dir, "report.json")
      writeFileSync(
        reportPath,
        JSON.stringify({
          model: "totally-unpriced-model-9000",
          provider: "x",
          perInstance: [
            {
              id: "a",
              passed: true,
              usage: { model: "x", inputTokens: 1_000_000, outputTokens: 50_000 },
            },
          ],
        }),
      )
      const { out, code } = await runCostCli([reportPath])
      expect(code).toBe(0)
      // tokens ARE real → token table shows them...
      expect(out).toContain("1000000")
      expect(out).toContain("1/1 instances had token data")
      // ...but cost is honestly unknown: a caveat, "—", and NO fabricated $0.0000.
      expect(out).toMatch(/NO pricing/i)
      expect(out).toContain("totally-unpriced-model-9000")
      expect(out).not.toContain("$0.0000")
    })
  })
})
