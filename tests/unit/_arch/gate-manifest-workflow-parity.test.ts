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
import { assertScanPopulation } from "../_shared/scan-population"

const WORKFLOW_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows")
const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR).sort()
assertScanPopulation(
  WORKFLOW_FILES.map((file) => join(WORKFLOW_DIR, file)),
  WORKFLOW_DIR,
  {
    collectable: (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    id: "tests/unit/_arch/gate-manifest-workflow-parity.test.ts#WORKFLOWS",
    topLevelOnly: true,
  },
)

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

const localUsesStep = (file: string, line: string): WorkflowStep | undefined => {
  const match = /^\s*(?:- )?uses:\s*(\.[^\s]+)\s*$/.exec(line)
  if (match === null) return undefined
  const command = `uses ${match[1] ?? ""}`
  return { file, raw: line, lines: [command] }
}

const externalUsesStep = (file: string, line: string): WorkflowStep | undefined => {
  const match = /^\s*(?:- )?uses: (\S+)/.exec(line)
  if (match === null) return undefined
  const command = `uses: ${match[1] ?? ""}`
  return { file, raw: command, lines: [command] }
}

type ParsedRunStep = {
  readonly step: WorkflowStep
  /** Last consumed line: a block scalar owns its indented body. */
  readonly lastLine: number
}

const nextLineRunStep = (
  file: string,
  lines: readonly string[],
  index: number,
): ParsedRunStep | undefined => {
  const next = (lines[index + 1] ?? "").trim()
  if (next === "" || next.startsWith("-") || next.startsWith("#")) return undefined
  return { step: { file, raw: next, lines: [next] }, lastLine: index + 1 }
}

const blockRunStep = (
  file: string,
  lines: readonly string[],
  index: number,
  indent: number,
  indicator: string,
): ParsedRunStep => {
  const body: string[] = []
  let lastLine = index
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? ""
    if (line.trim() === "") continue
    const lead = line.length - line.trimStart().length
    if (lead <= indent) break
    body.push(line.trim())
    lastLine = cursor
  }
  return {
    step: {
      file,
      raw: body.join(" "),
      lines: indicator === ">-" ? [body.join(" ")] : body,
    },
    lastLine,
  }
}

const parseRunStep = (
  file: string,
  lines: readonly string[],
  index: number,
): ParsedRunStep | undefined => {
  const match = /^(\s*)(?:- )?run:(.*)$/.exec(lines[index] ?? "")
  if (match === null) return undefined
  const indent = (match[1] ?? "").length
  const head = (match[2] ?? "").trim()
  if (head === "") {
    const nextLine = nextLineRunStep(file, lines, index)
    if (nextLine !== undefined) return nextLine
  }
  if (head !== ">-" && head !== "|") {
    return { step: { file, raw: head, lines: [head] }, lastLine: index }
  }
  return blockRunStep(file, lines, index, indent, head)
}

const workflowStepsInFile = (file: string): readonly WorkflowStep[] => {
  const out: WorkflowStep[] = []
  const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const uses = localUsesStep(file, line) ?? externalUsesStep(file, line)
    if (uses !== undefined) {
      out.push(uses)
      continue
    }
    const run = parseRunStep(file, lines, index)
    if (run === undefined) continue
    out.push(run.step)
    index = run.lastLine
  }
  return out
}

const workflowSteps = (): readonly WorkflowStep[] => {
  const out: WorkflowStep[] = []
  for (const file of GATING_WORKFLOWS) {
    out.push(...workflowStepsInFile(file))
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

    // …and the other direction, which a count floor cannot express. The list
    // says of itself that it holds EVERY gate id — "with only a subset listed,
    // the seven unlisted gates were open to the exact delete+exempt regression
    // this ratchet exists for". A floor of 16 under a manifest of 21 leaves
    // five gates in precisely that hole, and every gate added from now on lands
    // there by default. Set equality is the invariant, and it needs no number
    // to go stale.
    const required = new Set(REQUIRED_GATE_IDS)
    const unprotected = [...have].filter((id) => !required.has(id)).sort()
    expect(
      { unprotected },
      unprotected.length === 0
        ? ""
        : "these gates are in the manifest but not in REQUIRED_GATE_IDS, so each " +
            "can still be deleted while a WORKFLOW_EXEMPT entry covers its command " +
            "in the same commit — the regression this ratchet exists to stop: " +
            unprotected.join(", "),
    ).toEqual({ unprotected: [] })

    // ANTI-VACUITY, bound to the corpus rather than to a constant that ages:
    // an emptied manifest must fail here, not satisfy set equality trivially.
    expect(REQUIRED_GATE_IDS.length).toBe(GATES.length)
    expect(GATES.length).toBeGreaterThanOrEqual(16)
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

  const isConditionalOrNonBlocking = (line: string): boolean =>
    /^\s*continue-on-error\s*:\s*true\s*$/.test(line) || /^\s*if\s*:/.test(line)

  const precedingStepName = (lines: readonly string[], index: number): string => {
    const nameLine = lines
      .slice(0, index)
      .reverse()
      .find((line) => /^\s*-\s*name\s*:/.test(line))
    return (nameLine ?? "").replace(/^\s*-\s*name\s*:\s*/, "").trim()
  }

  const conditionalStepBody = (lines: readonly string[], index: number): string =>
    [
      ...lines.slice(Math.max(0, index - 8), index).reverse(),
      ...lines.slice(index, index + 8),
    ].join("\n")

  const conditionalGateOffenders = (file: string): readonly string[] => {
    const offenders: string[] = []
    const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")
    for (const [index, line] of lines.entries()) {
      if (!isConditionalOrNonBlocking(line)) continue
      const stepName = precedingStepName(lines, index)
      const carriesGate = GATES.some((gate) => conditionalStepBody(lines, index).includes(gate.run))
      if (!carriesGate || CONDITION_ALLOWED.some((allowed) => stepName.includes(allowed.step)))
        continue
      offenders.push(`${file}: ${stepName || `line ${index + 1}`} — ${line.trim()}`)
    }
    return offenders
  }

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
    const offenders = GATING_WORKFLOWS.flatMap(conditionalGateOffenders)
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
    const onDisk = WORKFLOW_FILES
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
