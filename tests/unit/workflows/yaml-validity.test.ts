// Workflow YAML structural validity — every authored workflow must parse and
// satisfy the GitHub Actions baseline shape (top-level on/jobs, every job has
// runs-on+steps, every step has run or uses). We also assert no raw secret
// literal leaks: any token-shaped string outside `${{ secrets.* }}` is rejected.
// meta-test: lints .github/workflows/*.yml; no src/ unit to import.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { asArray, asObject, asString, parseWorkflowYaml, type YamlValue } from "./parse-workflow"

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows")
const AGENT_WORKFLOWS = [
  "agent-pr-review.yml",
  "agent-nightly-regression.yml",
  "agent-auto-fix.yml",
] as const
const VALIDATED_WORKFLOWS = [...AGENT_WORKFLOWS, "grounding-live-gate.yml"] as const

const loadWorkflow = (name: string): { src: string; parsed: { [k: string]: YamlValue } } => {
  const src = readFileSync(join(WORKFLOWS_DIR, name), "utf8")
  return { src, parsed: asObject(parseWorkflowYaml(src)) }
}

describe("workflow yaml validity", () => {
  for (const name of VALIDATED_WORKFLOWS) {
    test(`${name}: parses and has top-level on + jobs`, () => {
      const { parsed } = loadWorkflow(name)
      expect(parsed.on).toBeDefined()
      expect(parsed.jobs).toBeDefined()
    })

    test(`${name}: every job has runs-on and steps`, () => {
      const { parsed } = loadWorkflow(name)
      const jobs = asObject(parsed.jobs as YamlValue)
      const jobIds = Object.keys(jobs)
      expect(jobIds.length).toBeGreaterThan(0)
      for (const jobId of jobIds) {
        const job = asObject(jobs[jobId] as YamlValue)
        expect(asString(job["runs-on"] as YamlValue)).toBe("ubuntu-latest")
        const steps = asArray(job.steps as YamlValue)
        expect(steps.length).toBeGreaterThan(0)
      }
    })

    test(`${name}: every step has run or uses`, () => {
      const { parsed } = loadWorkflow(name)
      const jobs = asObject(parsed.jobs as YamlValue)
      for (const jobId of Object.keys(jobs)) {
        const job = asObject(jobs[jobId] as YamlValue)
        const steps = asArray(job.steps as YamlValue)
        for (const stepRaw of steps) {
          const step = asObject(stepRaw)
          const hasRun = typeof step.run === "string"
          const hasUses = typeof step.uses === "string"
          expect(hasRun || hasUses).toBe(true)
        }
      }
    })

    test(`${name}: no raw secret references — only \${{ secrets.* }} form allowed`, () => {
      const { src } = loadWorkflow(name)
      // Find any `secrets.` reference, then assert each appears inside ${{ ... }}.
      // We strip ${{ ... }} expressions first; if `secrets.` remains, it's a leak.
      const stripped = src.replace(/\$\{\{[\s\S]*?\}\}/g, "")
      expect(stripped).not.toMatch(/secrets\./)
      // Also: no obviously-hard-coded API-key-shaped literals.
      expect(src).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
      expect(src).not.toMatch(/ghp_[A-Za-z0-9]{20,}/)
    })
  }

  // Audit R2/FIX-9: `--action` is NOT a flag `parseAgentArgs` accepts, so the
  // prior invocations exited 64 (EX_USAGE) — the workflows were dead on
  // arrival. They now invoke ci-bot with only parser-valid flags. The
  // review/auto-fix behavioral split is tracked as future work.
  test("agent-pr-review.yml: invokes agent:ci-bot with parser-valid flags (no --action)", () => {
    const { src } = loadWorkflow("agent-pr-review.yml")
    expect(src).toContain("bun run agent:ci-bot")
    expect(src).toContain("--pr")
    expect(src).not.toContain("--action")
  })

  test("agent-auto-fix.yml: invokes agent:ci-bot with parser-valid flags (no --action)", () => {
    const { src } = loadWorkflow("agent-auto-fix.yml")
    expect(src).toContain("bun run agent:ci-bot")
    expect(src).toContain("--pr")
    expect(src).not.toContain("--action")
  })

  test("agent-nightly-regression.yml: invokes agent:batch with corpus + predictions + report", () => {
    const { src } = loadWorkflow("agent-nightly-regression.yml")
    expect(src).toContain("bun run agent:batch")
    expect(src).toContain("--corpus")
    expect(src).toContain("--predictions")
    expect(src).toContain("--report")
  })

  test("grounding-live-gate.yml: has pull_request + workflow_dispatch + schedule triggers", () => {
    const { parsed } = loadWorkflow("grounding-live-gate.yml")
    const on = asObject(parsed.on as YamlValue)
    expect(on.pull_request).toBeDefined()
    expect(on.workflow_dispatch).toBeDefined()
    expect(on.schedule).toBeDefined()
    const dispatch = asObject(on.workflow_dispatch as YamlValue)
    const inputs = asObject(dispatch.inputs as YamlValue)
    expect(inputs.baseline_run_id).toBeDefined()
  })

  test("grounding-live-gate.yml: has canary + nightly jobs with eval grounding commands", () => {
    const { src, parsed } = loadWorkflow("grounding-live-gate.yml")
    const jobs = asObject(parsed.jobs as YamlValue)
    expect(jobs.canary).toBeDefined()
    expect(jobs.nightly).toBeDefined()
    expect(src).toContain("bun run eval grounding preflight")
    expect(src).toContain(
      'bun run eval grounding run --suite canary --concurrency 4 --json-out "$RUNNER_TEMP/grounding/canary-run.json"',
    )
    expect(src).toContain(
      'bun run eval grounding run --suite nightly --concurrency 4 --json-out "$RUNNER_TEMP/grounding/nightly-run.json"',
    )
    expect(src).toContain("bun run eval grounding baseline --candidate")
    expect(src).toContain("--concurrency 4")
    expect(src).toContain("bun run eval grounding report --run-id")
    expect(src).toContain("bun run eval grounding compare --baseline")
    expect(src).toContain("bun run eval grounding regress --baseline")
    expect(src).toContain('node -e \'const fs=require("node:fs")')
    expect(src).not.toContain("sed -n 's/.*run=")
    expect(src).not.toContain("sed -n 's/.* baseline=")
    expect(src).toContain("grounding-gate")
  })

  test("grounding-live-gate.yml: uploads JSONL + markdown + JSON artifacts", () => {
    const { src } = loadWorkflow("grounding-live-gate.yml")
    expect(src).toContain("actions/upload-artifact@v4")
    expect(src).toContain("canary-run.json")
    expect(src).toContain("canary-report.md")
    expect(src).toContain("canary-baseline.txt")
    expect(src).toContain("canary-baseline.json")
    expect(src).toContain("canary-gate.md")
    expect(src).toContain("canary-gate.json")
    expect(src).toContain("canary-compare.md")
    expect(src).toContain("canary-regress.md")
    expect(src).toContain("canary-regress.json")
    expect(src).toContain("nightly-run.json")
    expect(src).toContain("nightly-report.md")
    expect(src).toContain("nightly-baseline.txt")
    expect(src).toContain("nightly-baseline.json")
    expect(src).toContain("nightly-compare.md")
    expect(src).toContain("nightly-regress.md")
    expect(src).toContain("nightly-regress.json")
    expect(src).toContain("*.jsonl")
    expect(src).toContain("report.json")
  })

  test("every authored workflow declares an explicit timeout-minutes (belt+braces over BudgetCaps)", () => {
    for (const name of VALIDATED_WORKFLOWS) {
      const { parsed } = loadWorkflow(name)
      const jobs = asObject(parsed.jobs as YamlValue)
      for (const jobId of Object.keys(jobs)) {
        const job = asObject(jobs[jobId] as YamlValue)
        expect(typeof job["timeout-minutes"]).toBe("number")
        // Principle: every job's timeout matches its mode's BudgetCap order-of-magnitude.
        expect(job["timeout-minutes"] as number).toBeGreaterThan(0)
        expect(job["timeout-minutes"] as number).toBeLessThanOrEqual(60)
      }
    }
  })
})
