/**
 * ADR-0311 / 0313 / 0314 hellgate R3 — workflow YAML schema invariants.
 *
 * Parses `.github/workflows/quanta-pr-bot.yml.template` and asserts the
 * security-relevant shape:
 *   - the `on` block declares every event we wire (issue_comment,
 *     pull_request_review_comment, pull_request_review, pull_request),
 *   - `permissions` grants the MINIMUM verbs (contents: read, NOT write —
 *     code modification is intentionally a separate workflow),
 *   - `concurrency.cancel-in-progress` is true (superseded runs cancel),
 *   - the `respond` job exports `QUANTA_GH_ACTIONS_TRIGGER=1` and
 *     `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`,
 *   - the workflow has ≥4 steps (checkout / bun / install / run),
 *   - the pre-filter `if:` references both `@quanta` and `/quanta` so the
 *     non-mention runner cost is bounded,
 *   - `timeout-minutes` ≤ 30 (cost abuse cap),
 *   - no step uses `--no-verify` or a similarly dangerous flag,
 *   - the workflow never declares `contents: write`.
 *
 * If any of these regress (e.g. someone "fixes" perms by widening them),
 * this test fails and the regression cannot ship.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"

interface WorkflowOnIssueComment {
  readonly types?: readonly string[]
}

interface WorkflowOn {
  readonly issue_comment?: WorkflowOnIssueComment
  readonly pull_request_review_comment?: WorkflowOnIssueComment
  readonly pull_request_review?: WorkflowOnIssueComment
  readonly pull_request?: WorkflowOnIssueComment
}

interface WorkflowPermissions {
  readonly contents?: string
  readonly "pull-requests"?: string
  readonly issues?: string
}

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
}

interface WorkflowJob {
  readonly name?: string
  readonly "runs-on"?: string
  readonly "timeout-minutes"?: number
  readonly if?: string
  readonly env?: Record<string, string>
  readonly steps?: readonly WorkflowStep[]
}

interface ConcurrencyBlock {
  readonly group?: string
  readonly "cancel-in-progress"?: boolean
}

interface ParsedWorkflow {
  readonly name?: string
  readonly on?: WorkflowOn
  readonly permissions?: WorkflowPermissions
  readonly concurrency?: ConcurrencyBlock
  readonly jobs?: Record<string, WorkflowJob>
}

const WORKFLOW_PATH = resolve(process.cwd(), ".github", "workflows", "quanta-pr-bot.yml.template")

let text: string
let wf: ParsedWorkflow
try {
  text = readFileSync(WORKFLOW_PATH, "utf8")
  wf = parseYaml(text) as ParsedWorkflow
} catch (e) {
  throw new Error(`workflow YAML not readable/parseable at ${WORKFLOW_PATH}: ${String(e)}`)
}

const respond = (): WorkflowJob => {
  const j = wf.jobs?.respond
  if (j === undefined) throw new Error("expected jobs.respond")
  return j
}

describe("ADR-0311 hellgate R3 — workflow YAML schema", () => {
  test("YAML parses without error", () => {
    expect(typeof wf).toBe("object")
    expect(wf).not.toBeNull()
  })

  test("on block declares every event kind we wire", () => {
    const on = wf.on
    expect(on).toBeDefined()
    if (on === undefined) throw new Error("unreachable")
    expect(on.issue_comment).toBeDefined()
    expect(on.pull_request_review_comment).toBeDefined()
    expect(on.pull_request_review).toBeDefined()
    expect(on.pull_request).toBeDefined()
  })

  test("permissions grant minimum: pull-requests write, issues write, contents read", () => {
    const p = wf.permissions
    expect(p).toBeDefined()
    if (p === undefined) throw new Error("unreachable")
    expect(p.contents).toBe("read")
    expect(p["pull-requests"]).toBe("write")
    expect(p.issues).toBe("write")
  })

  test("contents: write is NEVER declared (code-modification fence)", () => {
    expect(wf.permissions?.contents).not.toBe("write")
    // Also reject any later override at job level.
    for (const j of Object.values(wf.jobs ?? {})) {
      const env = (j as { permissions?: WorkflowPermissions }).permissions
      expect(env?.contents).not.toBe("write")
    }
    // Final raw-string defence: even commented-out usage should not appear
    // as an active key. We assert the raw YAML does not contain a literal
    // `contents: write` token.
    expect(text).not.toMatch(/^\s*contents:\s*write\s*$/m)
  })

  test("concurrency.cancel-in-progress is true", () => {
    expect(wf.concurrency).toBeDefined()
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(true)
  })

  test("respond job: QUANTA_GH_ACTIONS_TRIGGER=1 in env", () => {
    const env = respond().env
    expect(env).toBeDefined()
    expect(env?.QUANTA_GH_ACTIONS_TRIGGER).toBe("1")
  })

  test("respond job: GH_TOKEN references secrets.GITHUB_TOKEN", () => {
    const env = respond().env
    expect(env?.GH_TOKEN).toBeDefined()
    expect(env?.GH_TOKEN).toContain("secrets.GITHUB_TOKEN")
  })

  test("respond job: ≥4 steps (checkout + bun + install + run)", () => {
    const steps = respond().steps ?? []
    expect(steps.length).toBeGreaterThanOrEqual(4)
    const usesOrRuns = steps.map((s) => `${s.uses ?? ""}|${s.name ?? ""}|${s.run ?? ""}`)
    // Quick sanity on what the 4 essential steps must contain.
    expect(usesOrRuns.some((s) => s.includes("actions/checkout"))).toBe(true)
    expect(usesOrRuns.some((s) => s.includes("setup-bun"))).toBe(true)
    expect(usesOrRuns.some((s) => s.includes("bun install"))).toBe(true)
    expect(usesOrRuns.some((s) => s.includes("quanta from-pr"))).toBe(true)
  })

  test("respond.if pre-filter mentions both @quanta and /quanta", () => {
    const condition = respond().if
    expect(condition).toBeDefined()
    if (condition === undefined) throw new Error("unreachable")
    expect(condition).toContain("@quanta")
    expect(condition).toContain("/quanta")
  })

  test("respond.timeout-minutes is set and ≤ 30 (cost abuse cap)", () => {
    const t = respond()["timeout-minutes"]
    expect(typeof t).toBe("number")
    if (typeof t !== "number") throw new Error("unreachable")
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(30)
  })

  test("no step uses --no-verify or other dangerous flags", () => {
    // Use raw text — easier than walking nested step.run strings.
    expect(text).not.toMatch(/--no-verify/)
    expect(text).not.toMatch(/--force-with-lease/)
    expect(text).not.toMatch(/git\s+push\s+--force/)
    expect(text).not.toMatch(/--allow-empty/)
    // `gh pr merge` would push commits — also banned.
    expect(text).not.toMatch(/\bgh\s+pr\s+merge\b/)
  })

  test("workflow does NOT install global tooling outside frozen lockfile", () => {
    // `bun install --frozen-lockfile` is the documented install line — we
    // forbid `npm install -g`, `bun add` (unfrozen), etc.
    expect(text).toMatch(/bun install --frozen-lockfile/)
    expect(text).not.toMatch(/npm\s+install\s+-g/)
    expect(text).not.toMatch(/bun\s+add\s+(?!--dry-run)/)
  })

  test("runs-on uses GitHub-hosted ubuntu-latest (no self-hosted runner)", () => {
    const ro = respond()["runs-on"]
    expect(ro).toBe("ubuntu-latest")
  })

  test("workflow name is `quanta-pr-bot` (single source of truth)", () => {
    expect(wf.name).toBe("quanta-pr-bot")
  })
})
