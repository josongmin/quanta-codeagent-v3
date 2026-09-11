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

const pinnedBunVersions = (file: string): readonly string[] =>
  [
    ...readFileSync(join(WORKFLOW_DIR, file), "utf8").matchAll(/^\s*bun-version:\s*(\S+)\s*$/gm),
  ].map((match) => match[1] ?? "")

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
  readonly name?: string
  readonly raw: string
  readonly lines: readonly string[]
}

const localUsesStep = (file: string, line: string, name?: string): WorkflowStep | undefined => {
  const match = /^\s*(?:- )?uses:\s*(\.[^\s]+)\s*$/.exec(line)
  if (match === null) return undefined
  const command = `uses ${match[1] ?? ""}`
  return { file, ...(name === undefined ? {} : { name }), raw: line, lines: [command] }
}

const externalUsesStep = (file: string, line: string, name?: string): WorkflowStep | undefined => {
  const match = /^\s*(?:- )?uses: (\S+)/.exec(line)
  if (match === null) return undefined
  const command = `uses: ${match[1] ?? ""}`
  return { file, ...(name === undefined ? {} : { name }), raw: command, lines: [command] }
}

const adjacentStepName = (lines: readonly string[], index: number): string | undefined => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? ""
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    const match = /^\s*-\s*name\s*:\s*(.+)$/.exec(line)
    if (match !== null) return match[1]?.trim()
    if (/^\s*-\s*(?:uses|run)\s*:/.test(line)) return undefined
  }
  return undefined
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
  name: string | undefined,
): ParsedRunStep | undefined => {
  const next = (lines[index + 1] ?? "").trim()
  if (next === "" || next.startsWith("-") || next.startsWith("#")) return undefined
  return {
    step: { file, ...(name === undefined ? {} : { name }), raw: next, lines: [next] },
    lastLine: index + 1,
  }
}

const blockRunStep = (
  file: string,
  lines: readonly string[],
  index: number,
  indent: number,
  indicator: string,
  name: string | undefined,
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
      ...(name === undefined ? {} : { name }),
      raw: body.join(" "),
      lines: indicator === ">-" ? [body.join(" ")] : body,
    },
    lastLine,
  }
}

/**
 * `name` is threaded through every branch because it was threaded through NONE
 * of them. `localUsesStep`/`externalUsesStep` carried the step name, but every
 * `run:` step was built without it, so `step.name` was permanently `undefined`
 * for commands — and `isExempt`'s `e.step === step.name` arm could never match
 * one. A `run:` exemption therefore HAD to be a file-wide substring, which is
 * the wildcard hole this guard's own docstring warns about: `{ match: "bun run
 * lint" }` also covers `lint:debt`. Carrying the name makes an exact,
 * step-scoped exemption expressible for commands too.
 */
const parseRunStep = (
  file: string,
  lines: readonly string[],
  index: number,
  name: string | undefined,
): ParsedRunStep | undefined => {
  const match = /^(\s*)(?:- )?run:(.*)$/.exec(lines[index] ?? "")
  if (match === null) return undefined
  const indent = (match[1] ?? "").length
  const head = (match[2] ?? "").trim()
  if (head === "") {
    const nextLine = nextLineRunStep(file, lines, index, name)
    if (nextLine !== undefined) return nextLine
  }
  if (head !== ">-" && head !== "|") {
    return {
      step: { file, ...(name === undefined ? {} : { name }), raw: head, lines: [head] },
      lastLine: index,
    }
  }
  return blockRunStep(file, lines, index, indent, head, name)
}

const workflowStepsInFile = (file: string): readonly WorkflowStep[] => {
  const out: WorkflowStep[] = []
  const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const name = adjacentStepName(lines, index)
    const uses = localUsesStep(file, line, name) ?? externalUsesStep(file, line, name)
    if (uses !== undefined) {
      out.push(uses)
      continue
    }
    const run = parseRunStep(file, lines, index, name)
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

/**
 * TVH item 10 — a substring exemption hid whatever was appended to it.
 *
 * `cmd.includes(exemption.match)` accepted the whole command as long as some
 * exempt text appeared ANYWHERE in it. So
 *
 *   bun install --frozen-lockfile && bun run unregistered-gate
 *
 * matched the `bun install --frozen-lockfile` exemption and the second half —
 * a blocking gate in no manifest — was never compared to anything. Exactly the
 * shape the `file`-scoping note above this list already describes: an exemption
 * granted for one thing covering another.
 *
 * Shell operators are separators, not characters in a command. Splitting on
 * them makes an exemption cover a SEGMENT, so appending to an exempt command
 * produces a segment nothing covers.
 */
const SHELL_SEPARATORS = /\s*(?:&&|\|\||;|\|)\s*/

export const commandSegments = (cmd: string): readonly string[] =>
  cmd
    .split(SHELL_SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")

const exemptionMatches = (cmd: string, exemption: (typeof WORKFLOW_EXEMPT)[number]): boolean =>
  exemption.exact === true ? cmd === exemption.match : cmd.includes(exemption.match)

const exemptionAppliesTo = (
  step: WorkflowStep,
  exemption: (typeof WORKFLOW_EXEMPT)[number],
): boolean =>
  (exemption.file === "*" || exemption.file === step.file) &&
  (exemption.step === undefined || exemption.step === step.name)

/**
 * EVERY segment must be covered. One exempt half does not exempt the other.
 *
 * An exact exemption still compares against the whole command, because an
 * exact entry names one specific step's one specific command and splitting it
 * would change what the author wrote down.
 */
export const isExempt = (cmd: string, step: WorkflowStep): boolean => {
  const applicable = WORKFLOW_EXEMPT.filter((e) => exemptionAppliesTo(step, e))
  if (applicable.some((e) => e.exact === true && exemptionMatches(cmd, e))) return true
  const substringMatch = (text: string): boolean =>
    applicable.some((e) => e.exact !== true && exemptionMatches(text, e))
  // Only the segments that LOOK LIKE AN INVOCATION are candidate gates. `tee
  // eval-report.txt` and the `true` in `|| true` are plumbing, and this file
  // already owns that distinction — reusing it keeps ONE notion of "a command"
  // rather than inventing a second that could disagree with the first.
  const invocations = commandSegments(cmd).filter((segment) => LOOKS_LIKE_A_COMMAND.test(segment))
  // A line with no invocation at all is a `uses:` step or shell scaffolding.
  // Those were always decided by the whole-string match and there is nothing to
  // append to them, so splitting would only break what already worked.
  if (invocations.length === 0) return substringMatch(cmd)
  return invocations.every(substringMatch)
}

describe("gate manifest ↔ workflow parity", () => {
  test("required CI and deterministic nightly pin the same Bun runtime", () => {
    const ciVersions = pinnedBunVersions("ci.yml")
    const nightlyVersions = pinnedBunVersions("verification-nightly.yml")
    expect(ciVersions.length).toBeGreaterThanOrEqual(10)
    expect(nightlyVersions).toHaveLength(1)
    expect(new Set(ciVersions)).toEqual(new Set(["1.3.14"]))
    expect(new Set(nightlyVersions)).toEqual(new Set(ciVersions))
  })

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
      WORKFLOW_EXEMPT.some((e) => exemptionMatches(normalize(g.run), e)),
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

  test("one-off producer/consumer and compatibility steps use exact exemptions", () => {
    const exact = new Set(
      WORKFLOW_EXEMPT.filter((entry) => entry.file === "ci.yml" && entry.exact === true).map(
        (entry) => entry.match,
      ),
    )
    expect(exact.has("uses: actions/cache/restore@v4")).toBe(true)
    expect(exact.has("uses: actions/download-artifact@v4")).toBe(true)
    expect(
      exact.has("bun add -g pyright@1.1.414 typescript@5.9.3 typescript-language-server@6.0.0"),
    ).toBe(true)
    expect(exact.has('test "<expr>" = "success"')).toBe(true)
  })

  test("artifact and cache actions are exact, named producer/consumer semantics", () => {
    const actions = WORKFLOW_EXEMPT.filter((entry) =>
      /^uses: actions\/(?:cache|cache\/restore|download-artifact|upload-artifact)@/.test(
        entry.match,
      ),
    )
    expect(actions.length).toBeGreaterThanOrEqual(10)
    for (const entry of actions) {
      expect({
        match: entry.match,
        exact: entry.exact,
        named: (entry.step?.length ?? 0) > 5,
      }).toEqual({
        match: entry.match,
        exact: true,
        named: true,
      })
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
    /^\s{8,}continue-on-error\s*:\s*true\s*$/.test(line) || /^\s{8,}if\s*:/.test(line)

  const precedingStepName = (lines: readonly string[], index: number): string => {
    const nameLine = lines
      .slice(0, index)
      .reverse()
      .find((line) => /^\s*-\s*name\s*:/.test(line))
    return (nameLine ?? "").replace(/^\s*-\s*name\s*:\s*/, "").trim()
  }

  /**
   * The body of the step that OWNS the line at `index`, by real step
   * boundaries.
   *
   * This was a +/-8-line window, which bleeds across step boundaries in both
   * directions. It produced a false positive the moment a conditional step
   * followed a gate step — three `capability result (…)` publishers carrying
   * `if: always()` were reported as neutering the `e2e:pty`, `test:real-toolchain`
   * and `test:contract` gates that merely happened to sit above them. And it
   * misses the symmetric case: an `if:` nine lines from its own step's `run` was
   * never associated with it at all.
   *
   * A step starts at a `- ` item under `steps:` and ends before the next one, so
   * the boundary is exactly what YAML already says it is.
   */
  const conditionalStepBody = (lines: readonly string[], index: number): string => {
    const isStepStart = (line: string): boolean => /^\s*-\s/.test(line)
    let start = index
    while (start > 0 && !isStepStart(lines[start] ?? "")) start -= 1
    let end = index + 1
    while (end < lines.length && !isStepStart(lines[end] ?? "")) end += 1
    return lines.slice(start, end).join("\n")
  }

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
    // The contract lane's canonical command. It used to be `bun test
    // tests/contract` here and `bun run test:contract` (clean-js + --parallel=1)
    // in package.json — two commands under one name. Anchored on the canonical
    // one so this floor cannot be satisfied by the drifted spelling.
    expect(normalized.some((c) => c.includes("test:contract"))).toBe(true)
  })

  test("a `run:` step carries its name, so an exemption can be step-scoped", () => {
    // Every `run:` step used to be parsed WITHOUT its name, so `isExempt`'s
    // `e.step === step.name` arm could never match a command — a `run:`
    // exemption had to be a file-wide substring, which is the wildcard hole this
    // file's own docstring warns about (`{ match: "bun run lint" }` also covers
    // `lint:debt`). Pinned structurally: a run step with a `- name:` above it
    // must report that name.
    const named = steps.filter((st) => st.name !== undefined && !st.raw.startsWith("uses"))
    expect(named.length).toBeGreaterThanOrEqual(10)
    const capability = steps.find((st) => st.lines.some((l) => l === "bun run capability:pty"))
    expect(capability?.name).toBe("capability result (pty)")

    // …and the exemptions that rely on it are genuinely step-scoped, not a
    // substring that would also cover a sibling lane.
    const stepScopedRuns = WORKFLOW_EXEMPT.filter(
      (e) => e.step !== undefined && e.exact === true && e.match.startsWith("bun run capability:"),
    )
    expect(stepScopedRuns.map((e) => e.step).sort()).toEqual([
      "capability result (contract)",
      "capability result (pty)",
      "capability result (toolchain)",
    ])
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
      const stepExempt = isExempt(st.raw, st)
      for (const line of st.lines) {
        const c = normalize(line)
        if (stepExempt && !LOOKS_LIKE_A_COMMAND.test(c)) continue
        if (!isExempt(c, st) && !manifestRuns.has(c) && !missing.includes(c)) missing.push(c)
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

/**
 * TVH item 10 — what a substring exemption used to hide.
 *
 * `cmd.includes(exemption.match)` accepted a whole command as long as some
 * exempt text appeared anywhere in it, so appending a blocking gate to an
 * exempt command made the appended half invisible. The `file` scoping note on
 * `WORKFLOW_EXEMPT` already describes this exact shape one level up: an
 * exemption granted for one thing covering another.
 */
describe("a compound command cannot hide behind an exempt half", () => {
  const step = (raw: string): WorkflowStep => ({
    file: "ci.yml",
    name: "install dependencies",
    raw,
    lines: [raw],
  })

  test("the exempt command alone is still exempt", () => {
    // ANTI-VACUITY: without this the arms below are satisfied by a matcher
    // that exempts nothing at all.
    expect(isExempt("bun install --frozen-lockfile", step("bun install --frozen-lockfile"))).toBe(
      true,
    )
  })

  test("APPENDING an un-gated command to it is NOT exempt", () => {
    const smuggled = "bun install --frozen-lockfile && bun run unregistered-gate"
    expect(isExempt(smuggled, step(smuggled))).toBe(false)
  })

  test("every operator separates, not just &&", () => {
    for (const joiner of ["&&", "||", ";", "|"]) {
      const smuggled = `bun install --frozen-lockfile ${joiner} bun run unregistered-gate`
      expect({ joiner, exempt: isExempt(smuggled, step(smuggled)) }).toEqual({
        joiner,
        exempt: false,
      })
    }
  })

  test("PREPENDING is caught too — order is not the protection", () => {
    const smuggled = "bun run unregistered-gate && bun install --frozen-lockfile"
    expect(isExempt(smuggled, step(smuggled))).toBe(false)
  })

  test("two exempt halves are still exempt", () => {
    // The rule is "every invocation is covered", not "compound is forbidden".
    const both = "bun install --frozen-lockfile && bun install --frozen-lockfile"
    expect(isExempt(both, step(both))).toBe(true)
  })

  test("shell plumbing is not a gate", () => {
    // `|| true` and `| tee` produce segments that are not invocations. Treating
    // them as candidate gates would have made two real workflow steps fail for
    // the wrong reason — both of them exist in ci.yml today.
    expect(commandSegments("bun fc gates || true")).toEqual(["bun fc gates", "true"])
    expect(commandSegments("bun run x --n 1 | tee report.txt")).toEqual([
      "bun run x --n 1",
      "tee report.txt",
    ])
  })

  test("segmentation keeps a plain command whole", () => {
    const plain = "bun run tools/dev/gate.ts precommit --quiet"
    expect(commandSegments(plain)).toEqual([plain])
  })

  test("a `uses:` step is still decided by the whole string", () => {
    // Nothing can be appended to a `uses:` line, so splitting it would only
    // break what already worked.
    const uses = "uses: actions/checkout@v4"
    expect(isExempt(uses, { file: "ci.yml", raw: uses, lines: [uses] })).toBe(true)
  })
})
