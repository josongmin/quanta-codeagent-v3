/**
 * DRIFT GUARD — `bun run precommit` / `bun run prepush` must mean the same thing
 * as the workflows.
 *
 * The manifest (`tools/dev/gate-manifest.ts`) exists because the gate set lived
 * ONLY as steps inside `.github/workflows/*.yml`, which is not a runnable local
 * command — so the pre-commit answer was reconstructed from memory every time.
 * A local copy of a remote list is the classic stale artifact:
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
  REQUIRED_GATE_IDS,
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
      // A `uses:` step runs code exactly as a `run:` step does — a local
      // composite action or a reusable workflow — and was invisible here, so a
      // blocking gate could be added as `uses: ./.github/actions/x` and never
      // classified. Captured under its own token so the containment test names
      // it rather than silently accepting it.
      const usesMatch = /^\s*(?:- )?uses:\s*(\.[^\s]+)\s*$/.exec(line)
      if (usesMatch !== null) {
        const cmd = `uses ${usesMatch[1] ?? ""}`
        out.push({ file, raw: line, lines: [cmd] })
        continue
      }
      // A third-party `uses:` step BLOCKS a job exactly as `run:` does. The
      // parser saw only `run:`, so `uses: evil/blocking-action@v1` was invisible.
      // Local (`./…`) and the setup actions the exempt list already admits are
      // handled through the same universe as everything else.
      const u = /^\s*(?:- )?uses: (\S+)/.exec(line)
      if (u !== null) {
        const spec = `uses: ${u[1]}`
        out.push({ file, raw: spec, lines: [spec] })
        continue
      }
      const m = /^(\s*)(?:- )?run:(.*)$/.exec(line)
      if (m === null) continue
      const indent = (m[1] ?? "").length
      const head = (m[2] ?? "").trim()
      // `run:` with the value on the NEXT line is a plain multi-line scalar —
      // valid YAML, valid in Actions, and invisible to a `run: (.*)$` regex. An
      // injected `run:\n  bun run probe` shipped past this test un-gated.
      if (head === "") {
        const next = (lines[i + 1] ?? "").trim()
        if (next !== "" && !next.startsWith("-") && !next.startsWith("#")) {
          out.push({ file, raw: next, lines: [next] })
          i += 1
          continue
        }
      }
      // Block indicators this parser does NOT fold (`|-`, `>`, `>+`, …) must fail
      // CLOSED: keep the marker as the command so the containment test names it,
      // rather than silently reading an empty step.
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
/**
 * A line inside an exempt step that still has to be judged.
 *
 * The first fix used `/^bun\b/`, which closed only the `bun run …` shape. Six
 * injections beside `bun fc gates || true` all shipped un-gated, including the
 * manifest's OWN idiom `QUANTA_X=1 bun run …`, plus `npm run`, `bunx`, `yarn`,
 * `sh tools/…` and `./scripts/…`. Anything that looks like an invocation counts;
 * shell scaffolding (`{`, `echo …`, `done`, `fi`, a bare variable assignment)
 * does not.
 */
const LOOKS_LIKE_A_COMMAND =
  /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:bun|bunx|npm|npx|yarn|pnpm|node|deno|sh|bash|python3?|make|\.\/|tools\/|scripts\/)/

const normalize = (cmd: string): string =>
  cmd
    // A trailing shell comment is not part of the command, and `isExempt` is a
    // SUBSTRING match — so `run: bun run brand-new-gate # docker version`
    // exempted itself by naming an exempt command in a comment. Measured: that
    // step shipped past this test un-gated.
    .replace(/\s+#.*$/, "")
    .replace(/\$\{\{[^}]*\}\}/g, "<expr>")
    .replace(/^bun fc check-changed .*$/, "bun run test:admission")
    .replace(/\s+/g, " ")
    .trim()

const isExempt = (cmd: string, file: string): boolean =>
  WORKFLOW_EXEMPT.some((e) => (e.file === "*" || e.file === file) && cmd.includes(e.match))

describe("gate manifest ↔ workflow parity", () => {
  const steps = workflowSteps()
  const normalized = steps.flatMap((st) => st.lines.map(normalize))
  const manifestRuns = new Set(GATES.map((g) => normalize(g.run)))

  test("a REQUIRED gate may not disappear (delete + exempt in one commit)", () => {
    // The disjointness arm below only forbids a gate and an exemption for the
    // same command COEXISTING. Doing both in one commit satisfied everything:
    // direction ① saw the workflow step as exempt, direction ② had no gate left
    // to compare, and the count floor still cleared. This is the ratchet that
    // shape needs.
    const have = new Set(GATES.map((g) => g.id))
    const gone = REQUIRED_GATE_IDS.filter((id) => !have.has(id))
    expect({ gone }).toEqual({ gone: [] })
    expect(REQUIRED_GATE_IDS.length).toBeGreaterThanOrEqual(16) // anti-vacuity
  })

  test("an exemption may not retire a gate (the two sets are disjoint)", () => {
    // `isExempt` is a SUBSTRING match, so `{ match: "bun run lint" }` would both
    // exempt the lint step AND silently cover `lint:debt`. Deleting the gate then
    // left this file green. Nothing asserted the sets were disjoint.
    const clashes = GATES.filter((g) =>
      WORKFLOW_EXEMPT.some((e) => normalize(g.run).includes(e.match)),
    ).map((g) => g.id)
    // …and every exemption must name a workflow that exists, or "*".
    const files = new Set([...GATING_WORKFLOWS, ...NON_GATING_WORKFLOWS.map((w) => w.file), "*"])
    const badScope = WORKFLOW_EXEMPT.filter((e) => !files.has(e.file)).map((e) => e.match)
    expect({ badScope }).toEqual({ badScope: [] })
    expect({ clashes }).toEqual({ clashes: [] })
    for (const e of WORKFLOW_EXEMPT) {
      expect({ match: e.match, why: e.why.length > 10 }).toEqual({ match: e.match, why: true })
    }
  })

  /**
   * Conditions that are part of a step's DESIGN rather than a way to switch it
   * off. Each is a real scheduling decision — a PR-only check, a scheduled-only
   * suite — and each is paired with the step it belongs to so a condition cannot
   * be moved onto a different step and inherit the excuse.
   */
  const CONDITION_ALLOWED: readonly { readonly step: string; readonly why: string }[] = [
    {
      step: "silent-catch baseline gate",
      why: "read-only --check on PRs; the write mode is a scheduled job",
    },
    {
      step: "check-changed",
      why: "compares against the PR base, so it has nothing to diff on a schedule",
    },
    { step: "fc check-changed", why: "same — PR-only by construction" },
    {
      step: "contract suite",
      why: "docker + eval-labelled or scheduled only; deliberately not a per-PR gate",
    },
  ]

  test("🔴 no MANIFEST gate is neutered in place with continue-on-error or if:", () => {
    // The parity checks assert PRESENCE, never blocking-ness. An audit turned the
    // non-vacuity gate off with `continue-on-error: true` and both directions
    // stayed green — the manifest kept claiming "this blocks a push" while the
    // workflow no longer did, and `bun run prepush` still ran it locally so the
    // divergence was invisible from both sides.
    //
    // Scoped to steps that carry a MANIFEST gate: a condition on a step nobody
    // registered is a scheduling decision, and forbidding those outright would
    // flag five legitimate PR-only / schedule-only steps and get the rule
    // deleted rather than followed.
    const offenders: string[] = []
    for (const file of GATING_WORKFLOWS) {
      const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")
      for (const [i, line] of lines.entries()) {
        const conditional =
          /^\s*continue-on-error\s*:\s*true\s*$/.test(line) || /^\s*if\s*:/.test(line)
        if (!conditional) continue
        const before = lines.slice(0, i).reverse()
        const nameLine = before.find((l) => /^\s*-\s*name\s*:/.test(l)) ?? ""
        const stepName = nameLine.replace(/^\s*-\s*name\s*:\s*/, "").trim()
        // The step's own `run:` — look forward too, since `if:` may precede it.
        const body = [...before.slice(0, 8), ...lines.slice(i, i + 8)].join("\n")
        const carriesGate = GATES.some((g) => body.includes(g.run))
        if (!carriesGate) continue
        if (CONDITION_ALLOWED.some((a) => stepName.includes(a.step))) continue
        offenders.push(`${file}: ${stepName || `line ${i + 1}`} — ${line.trim()}`)
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "a step carrying a manifest gate is conditional or non-blocking, so the " +
            `manifest's claim that it blocks a push is false:\n  ${offenders.join("\n  ")}`,
    ).toEqual([])
  })

  test("anti-vacuity: the workflow parse actually read commands", () => {
    // Floors, not exact counts: a new workflow step must not fail this test, it
    // must fail the containment tests below with a NAME.
    // Derived from the real corpus (31 steps across the two gating workflows at
    // the time of writing), not a token `> 0`: a parser regression that halved
    // coverage used to sail through the old `> 15`.
    expect(steps.length).toBeGreaterThanOrEqual(28)
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
      // Exempt AS A STEP, because a multi-line setup script's fragments (`{`,
      // `echo ""`, `done`) are not commands any manifest could name — BUT an
      // exempt step is not a hiding place. Every `bun …` invocation inside it is
      // still a candidate gate and must be listed or exempt on its own line.
      // Injected proof of the old hole: `bun run probe` placed beside
      // `bun fc gates || true` in the step-summary block shipped un-gated.
      const stepExempt = isExempt(st.raw, st.file)
      for (const line of st.lines) {
        const c = normalize(line)
        if (stepExempt && !LOOKS_LIKE_A_COMMAND.test(c)) continue
        if (!isExempt(c, st.file) && !manifestRuns.has(c) && !missing.includes(c)) missing.push(c)
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
