/**
 * Which workflow runs may run over each other, and which must cancel.
 *
 * # Three defects, all invisible from inside a single workflow file
 *
 * 1. `ci.yml` keyed concurrency on `${{ github.workflow }}-${{ github.ref }}`.
 *    On a `schedule` event `github.ref` is `refs/heads/main` — identical to a
 *    push — so the 06:00 eval cron and required main verification shared ONE
 *    lane. A non-blocking 60-minute eval could queue the merge gate behind it.
 * 2. `fc-gate.yml` had no `concurrency` at all, while being a required context
 *    on the same pull requests: a superseded commit's catalog run kept going
 *    while the new one started.
 * 3. `verification-nightly.yml` had none either, so cron, a manual dispatch and
 *    a retry could run three 180-minute cache-off campaigns over each other.
 *
 * # Why nightly is the one that must NOT cancel
 *
 * Cancelling a 180-minute campaign at minute 170 to start a fresh one throws
 * away the only deterministic evidence of the day. Queueing is correct there and
 * wrong for a PR, so the two shapes are asserted separately rather than by one
 * uniform rule.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

import { assertScanPopulation } from "../_shared/scan-population"

const WORKFLOW_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows")

interface WorkflowConcurrency {
  readonly group?: string
  readonly "cancel-in-progress"?: unknown
}

interface Workflow {
  readonly on?: unknown
  readonly concurrency?: WorkflowConcurrency | string
  readonly jobs?: Readonly<Record<string, unknown>>
}

const workflow = (file: string): Workflow =>
  parseYaml(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow

const concurrencyOf = (file: string): WorkflowConcurrency => {
  const value = workflow(file).concurrency
  if (value === undefined) throw new Error(`${file} declares no concurrency`)
  if (typeof value === "string") return { group: value }
  return value
}

/** Trigger names a workflow responds to, however `on:` is spelled. */
const triggersOf = (file: string): readonly string[] => {
  const on = workflow(file).on
  if (typeof on === "string") return [on]
  if (Array.isArray(on)) return on.map(String)
  if (typeof on === "object" && on !== null) return Object.keys(on)
  return []
}

/**
 * A GitHub Actions expression, assembled from parts.
 *
 * Written literally, `"${{ … }}"` trips biome's template-placeholder rule, and
 * `lint:debt` is a one-directional ratchet — a new warning here would have to be
 * paid for by someone else. Assembling it also documents that these really are
 * Actions expressions and not accidental template strings.
 */
const ghExpr = (body: string): string => `\${${"{"} ${body} ${"}"}}`

const WORKFLOWS = readdirSync(WORKFLOW_DIR)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort()

// ENROLLED. This file states zero-verdicts over a walked corpus, so its reach is
// pinned rather than assumed: a workflow directory that stops yielding files
// would otherwise make every assertion below trivially true.
assertScanPopulation(
  WORKFLOWS.map((file) => join(WORKFLOW_DIR, file)),
  WORKFLOW_DIR,
  {
    collectable: (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    id: "tests/unit/_arch/workflow-concurrency.test.ts#WORKFLOWS",
    topLevelOnly: true,
  },
)

describe("workflow concurrency lanes", () => {
  test("ANTI-VACUITY — the workflow corpus is real and carries the files under test", () => {
    // Every assertion below reads named files; if the directory moved or the
    // parse returned nothing, they would throw for the wrong reason.
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(3)
    for (const file of ["ci.yml", "fc-gate.yml", "verification-nightly.yml"]) {
      expect({ file, present: WORKFLOWS.includes(file) }).toEqual({ file, present: true })
      expect(Object.keys(workflow(file).jobs ?? {}).length).toBeGreaterThan(0)
    }
  })

  test("a workflow that answers several event kinds separates them by lane", () => {
    // The defect exactly: `github.ref` cannot tell a scheduled run from a push
    // to the same branch, so a key without the event merges two purposes.
    for (const file of WORKFLOWS) {
      const parsed = workflow(file)
      if (parsed.concurrency === undefined) continue
      const triggers = triggersOf(file)
      const multiPurpose = triggers.filter((name) => name !== "workflow_dispatch").length > 1
      if (!multiPurpose) continue
      const group = concurrencyOf(file).group ?? ""
      expect({ file, keyedByEvent: group.includes("github.event_name") }).toEqual({
        file,
        keyedByEvent: true,
      })
    }
  })

  test("every gating workflow declares a lane at all", () => {
    // `fc-gate.yml` was a required context with no concurrency whatsoever.
    for (const file of ["ci.yml", "fc-gate.yml"]) {
      const group = concurrencyOf(file).group ?? ""
      expect({ file, hasGroup: group.length > 0 }).toEqual({ file, hasGroup: true })
      expect({ file, keyedByRef: group.includes("github.ref") }).toEqual({ file, keyedByRef: true })
    }
  })

  test("a superseded pull-request head is cancelled, and only that", () => {
    for (const file of ["ci.yml", "fc-gate.yml"]) {
      const cancel = String(concurrencyOf(file)["cancel-in-progress"] ?? "")
      // Conditional on the event, never a bare `true`: cancelling a main-push
      // verification because another push landed loses the evidence for the
      // first commit.
      expect({ file, cancel }).toEqual({
        file,
        cancel: ghExpr("github.event_name == 'pull_request'"),
      })
    }
  })

  test("the nightly campaign queues rather than cancelling itself", () => {
    const nightly = concurrencyOf("verification-nightly.yml")
    expect(nightly.group).toBe(ghExpr("github.workflow"))
    // A 180-minute cache-off campaign cancelled at minute 170 leaves the day
    // with no deterministic evidence at all.
    expect(nightly["cancel-in-progress"]).toBe(false)
    expect(triggersOf("verification-nightly.yml")).toContain("schedule")
    expect(triggersOf("verification-nightly.yml")).toContain("workflow_dispatch")
  })
})

describe("artifact retention is declared, not inherited", () => {
  test("every upload names a retention, and worker detail is the shortest", () => {
    const source = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")
    const uploads = [
      ...source.matchAll(/uses: actions\/upload-artifact@v4\n([\s\S]*?)(?=\n\s*- |\n\n|$)/gu),
    ]

    // ANTI-VACUITY: the parse must have found the uploads, or "all declare a
    // retention" is a statement about an empty list.
    expect(uploads.length).toBeGreaterThanOrEqual(7)

    const missing = uploads.filter((match) => !(match[1] ?? "").includes("retention-days"))
    expect(missing.length).toEqual(0)

    // The bulk of the bytes is the per-chunk worker detail, and it is superseded
    // the moment the aggregate exists. It must not outlive the evidence a
    // closeout actually reads.
    const retentionFor = (artifactPrefix: string): number => {
      const at = source.indexOf(artifactPrefix)
      expect(at).toBeGreaterThan(-1)
      const window = source.slice(at, at + 600)
      const found = /retention-days: (\d+)/u.exec(window)
      if (found === null) throw new Error(`no retention near ${artifactPrefix}`)
      return Number.parseInt(found[1] ?? "0", 10)
    }
    const worker = retentionFor("verification-worker-")
    const aggregate = retentionFor("verification-aggregate-")
    const capability = retentionFor("capability-result-")
    expect(worker).toBeLessThan(aggregate)
    expect(worker).toBeLessThan(capability)
    expect(worker).toBeGreaterThan(0)
  })
})
