/**
 * DRIFT GUARD — `bun run precommit` / `bun run prepush` must mean the same thing
 * as the workflows.
 *
 * The manifest (`tools/dev/gate-manifest.ts`) exists because the gate set lived
 * ONLY in `.github/workflows/*.yml` and GitHub Actions has not started a job in
 * this repo since billing was cut, so nothing between "write the code" and
 * "push" ran it. A local copy of a remote list is the classic stale artifact:
 * without this test, the manifest would drift the first time someone added a CI
 * step, and `prepush: ok` would then be a claim over a smaller universe than the
 * merge gate — the precise "confident number over a universe nobody checked"
 * shape the repo's other ratchets exist to catch.
 *
 * Both directions, over a CLOSED universe:
 *
 *   1. every blocking `run:` in a workflow is a manifest gate, OR is named in
 *      `WORKFLOW_EXEMPT` with a reason (setup / non-blocking job / advisory);
 *   2. every manifest gate's command appears verbatim in a workflow, OR carries
 *      an explicit `notInWorkflow` justification.
 *
 * Direction 2 is what stops the local set quietly growing into a private
 * superset nobody else runs. Direction 1 is what stops it shrinking.
 *
 * ANTI-VACUITY. A parse that found no commands would satisfy both directions
 * trivially, which is how a scan-derived verdict lies. The floors below assert
 * the parse actually read the workflows.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  GATES,
  GATING_WORKFLOWS,
  gatesForStage,
  NON_GATING_WORKFLOWS,
  WORKFLOW_EXEMPT,
} from "../../../tools/dev/gate-manifest"

const WORKFLOW_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows")

/**
 * Every `run:` command in the workflow files, one entry per command.
 *
 * Handles both YAML forms the repo uses: an inline `run: <cmd>` and a block
 * scalar (`run: >-` / `run: |`). A step is returned as `{ raw, lines }`: `raw`
 * is the whole step (a `>-` block folded to one command, a `|` block joined),
 * `lines` are its individual commands.
 *
 * BOTH shapes are kept because a step is exempt or not AS A STEP — the eval
 * job's corpus writer and the fc-gates step-summary block are multi-line shell
 * whose fragments (`{`, `echo ""`) are not commands anyone could list — while a
 * `|` step that IS a gate can hold several (the fc step runs validate + diff +
 * lint). So: exempt the step, else every one of its lines must be a gate.
 */
interface WorkflowStep {
  readonly file: string
  readonly raw: string
  readonly lines: readonly string[]
}

const workflowSteps = (): readonly WorkflowStep[] => {
  const out: WorkflowStep[] = []
  for (const file of GATING_WORKFLOWS) {
    const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ""
      const m = /^(\s*)(?:- )?run: (.*)$/.exec(line)
      if (m === null) continue
      const indent = (m[1] ?? "").length
      const head = (m[2] ?? "").trim()
      if (head !== ">-" && head !== "|") {
        out.push({ file, raw: head, lines: [head] })
        continue
      }
      const body: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j] ?? ""
        if (l.trim() === "") continue
        const lead = l.length - l.trimStart().length
        if (lead <= indent) break
        body.push(l.trim())
        i = j
      }
      out.push({
        file,
        raw: body.join(" "),
        lines: head === ">-" ? [body.join(" ")] : body,
      })
    }
  }
  return out
}

/** A workflow command with CI-only noise removed, so it can be compared to the
 *  manifest's local spelling. `bun fc check-changed origin/<base>` and the local
 *  `bun run test:admission` are the same gate with a different default base. */
const normalize = (cmd: string): string =>
  cmd
    .replace(/\$\{\{[^}]*\}\}/g, "<expr>")
    .replace(/^bun fc check-changed .*$/, "bun run test:admission")
    .replace(/\s+/g, " ")
    .trim()

const isExempt = (cmd: string): boolean => WORKFLOW_EXEMPT.some((e) => cmd.includes(e.match))

describe("gate manifest ↔ workflow parity", () => {
  const steps = workflowSteps()
  const normalized = steps.flatMap((st) => st.lines.map(normalize))
  const manifestRuns = new Set(GATES.map((g) => normalize(g.run)))

  test("anti-vacuity: the workflow parse actually read commands", () => {
    // Floors, not exact counts: a new workflow step must not fail this test, it
    // must fail the containment tests below with a NAME.
    expect(steps.length).toBeGreaterThan(15)
    expect(normalized.some((c) => c === "bun run lint")).toBe(true)
    expect(normalized.some((c) => c.includes("tests/contract"))).toBe(true)
  })

  test("anti-vacuity: the manifest is non-empty and both stages are populated", () => {
    expect(gatesForStage("precommit").length).toBeGreaterThan(5)
    expect(gatesForStage("prepush").length).toBeGreaterThan(gatesForStage("precommit").length)
    // prepush is a SUPERSET — every precommit gate runs before a push too.
    const pre = new Set(gatesForStage("precommit").map((g) => g.id))
    const push = new Set(gatesForStage("prepush").map((g) => g.id))
    expect([...pre].filter((id) => !push.has(id))).toEqual([])
  })

  test("the workflow directory is fully classified (gating vs deliberately not)", () => {
    // A new workflow file must force a decision. Without this, adding one that
    // DOES gate merges would leave its steps outside the parity check entirely.
    const onDisk = readdirSync(WORKFLOW_DIR).sort()
    const classified = [...GATING_WORKFLOWS, ...NON_GATING_WORKFLOWS.map((w) => w.file)].sort()
    expect(onDisk).toEqual(classified)
    for (const w of NON_GATING_WORKFLOWS) {
      expect({ file: w.file, why: w.why.length > 20 }).toEqual({ file: w.file, why: true })
    }
  })

  test("① every blocking workflow step is a manifest gate (or an admitted exemption)", () => {
    const missing: string[] = []
    for (const st of steps) {
      // Exempt AS A STEP first — a multi-line setup script's fragments are not
      // commands a manifest could name.
      if (isExempt(st.raw)) continue
      for (const line of st.lines) {
        const c = normalize(line)
        if (!isExempt(c) && !manifestRuns.has(c) && !missing.includes(c)) missing.push(c)
      }
    }
    expect({ missing }).toEqual({ missing: [] })
  })

  test("② every manifest gate is a real workflow step (or carries a justification)", () => {
    const workflowSet = new Set(normalized)
    const invented = GATES.filter(
      (g) => g.notInWorkflow === undefined && !workflowSet.has(normalize(g.run)),
    ).map((g) => g.id)
    expect({ invented }).toEqual({ invented: [] })
  })

  test("a `notInWorkflow` justification is a sentence, not a placeholder", () => {
    for (const g of GATES) {
      if (g.notInWorkflow === undefined) continue
      expect({ id: g.id, len: g.notInWorkflow.length > 30 }).toEqual({ id: g.id, len: true })
    }
  })

  test("gate ids are unique and every gate states what it catches", () => {
    expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length)
    for (const g of GATES)
      expect({ id: g.id, why: g.why.length > 20 }).toEqual({ id: g.id, why: true })
  })
})
