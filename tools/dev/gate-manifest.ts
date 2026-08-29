/**
 * SSOT for what "precommit" and "prepush" mean in this repo.
 *
 * WHY THIS FILE EXISTS. Development here happens LOCALLY, and there was no
 * local command for the gate set. The list existed only as steps inside
 * `.github/workflows/*.yml` — a shape you cannot run, cannot compose, and
 * cannot see the total of. So the answer to "am I about to break the build?"
 * was a from-memory reconstruction, every time, by every session.
 *
 * That is independent of whether CI is running: a green pipeline still reports
 * AFTER the commit exists, and the thing wanted here is a verdict BEFORE it.
 *
 * Measured cost of not having it: `bun run lint` went RED on two consecutive
 * days from commits that landed `assist/source/organizeImports` and `format`
 * ERRORS. biome exits 0 on WARN, so the ~221 warnings a normal run prints look
 * identical to a clean one — the failure is invisible unless the command is
 * actually run and its EXIT CODE read.
 *
 * NOT A SECOND AUTHORITY. Every gate below shells out to the SAME
 * `bun run <script>` a developer and a workflow run — never a reimplementation.
 * `tools/dev/run-biome.ts` already carries the scar from breaking that rule
 * ("MUST stay `bun run lint` … invoking biome directly here let CI and local
 * drift apart"), so the manifest holds command STRINGS, verbatim.
 *
 * TWO-DIRECTIONAL PARITY. `tests/unit/_arch/gate-manifest-workflow-parity.test.ts`
 * fails when a workflow gains a blocking step this manifest does not list, AND
 * when this manifest lists a command no workflow runs (unless the entry carries
 * an explicit `notInWorkflow` justification). Without that, this file becomes
 * exactly the stale copy it exists to prevent.
 */

/** Which stage a gate belongs to. `precommit` must stay fast enough to run on
 *  every commit (static analysis only — no test suite). */
export type GateStage = "precommit" | "prepush"

export interface Gate {
  readonly id: string
  readonly stage: GateStage
  /** The command, verbatim. Run through the shell so `--` pass-through works. */
  readonly run: string
  /** One line: what breaks if this gate is absent. */
  readonly why: string
  /**
   * This gate CONSUMES a file the named gate produces. When the producer fails,
   * the consumer is reported SKIPPED — never PASS.
   *
   * Measured hole this closes: `bun test` does NOT write `--reporter-outfile`
   * when a run aborts, and the runner does not bail, so `unit-speed-budget`
   * happily rendered a verdict over the PREVIOUS run's junit — a file dated
   * 2020 was accepted without comment. `MIN_TESTCASES` cannot catch it, because
   * a stale FULL run has 39k cases.
   */
  readonly consumes?: string
  /**
   * Set ONLY for a gate no workflow runs. The string is the justification the
   * parity test prints, so an unrunnable-in-CI gate stays visible rather than
   * silently expanding the local-only set.
   */
  readonly notInWorkflow?: string
}

export const GATES: readonly Gate[] = [
  // ── precommit: static, no test suite ───────────────────────────────────────
  {
    id: "typecheck",
    stage: "precommit",
    run: "bun run typecheck:all",
    why: "src + tests type errors (full tree). The local runner skips on an unchanged CONTENT hash — sound, and it writes no stamp on failure, so a red always re-runs",
  },
  {
    id: "lint",
    stage: "precommit",
    run: "bun run lint",
    why: "biome exits non-zero only on ERROR-severity diagnostics (assist/format) — the class that broke main twice",
  },
  {
    id: "lint-debt",
    stage: "precommit",
    run: "bun run lint:debt",
    why: "the WARN-level rules gate nothing on their own; this is the per-rule one-directional ceiling",
  },
  {
    id: "fc-check-changed",
    stage: "precommit",
    run: "bun run test:admission",
    why: "a new src/*.ts that no feature-catalog entry references",
  },
  {
    id: "fc-validate",
    stage: "precommit",
    run: "bun fc validate",
    why: "an evidence file / ADR / test a catalog entry names does not exist",
  },
  {
    id: "fc-diff",
    stage: "precommit",
    run: "bun fc diff",
    why: "docs/10.feature-catalog.md out of sync with the YAMLs",
  },
  {
    id: "fc-lint",
    stage: "precommit",
    run: "bun fc lint",
    why: "empty-stub count + orphan Accepted ADRs may not grow",
  },
  {
    id: "fc-reachability",
    stage: "precommit",
    run: "bun fc reachability --strict --symbols",
    why: "an L4+ feature that the real import graph cannot reach (overclaim)",
  },
  {
    id: "silent-catch-baseline",
    stage: "precommit",
    run: "bun run baseline:silent-catch --check",
    why: "a bare `} catch {` past the pinned baseline, or an available tighten left uncommitted",
  },
  {
    id: "protocol-generated",
    stage: "precommit",
    run: "bun run build:protocol:check",
    why: "the generated web-frontend protocol types drifted from their source",
    notInWorkflow:
      "no workflow runs it; the generator's own docstring names the CLI/pre-commit as its intended home",
  },

  // ── prepush: everything above, plus the suites ─────────────────────────────
  {
    id: "unit",
    stage: "prepush",
    run: "bun run tools/dev/worktree-pollution-guard.ts -- bun test tests/unit --reporter=junit --reporter-outfile=.cache/unit-junit.xml",
    why: "the unit suite, wrapped so a test that leaves a file in the worktree is caught at the source",
  },
  {
    id: "unit-speed-budget",
    stage: "prepush",
    consumes: "unit",
    run: "bun run tools/dev/unit-speed-budget.ts .cache/unit-junit.xml",
    why: "no SINGLE unit test may exceed the pinned ceiling; consumes the junit the `unit` gate writes",
  },
  {
    id: "integration",
    stage: "prepush",
    run: "bun run tools/dev/worktree-pollution-guard.ts -- bun test tests/integration",
    why: "the integration suite (also the home of the cases too slow for the unit budget)",
  },
  {
    id: "e2e-pty",
    stage: "prepush",
    run: "bun run tools/dev/worktree-pollution-guard.ts -- bun run e2e:pty",
    why: "the ONLY coverage of the raw-mode interactive input layer",
  },
  {
    id: "cwd-parity-arch",
    stage: "prepush",
    run: "bun run test:cwd-parity:arch",
    why: "a guard that passes only because it resolved a repo path from the ambient cwd",
  },
  {
    id: "non-vacuity-oracle",
    stage: "prepush",
    run: "bun run test:non-vacuity",
    why: "a guard that reports no violations over a corpus it never read — run against a mirror with that corpus emptied, because three static detectors reported green while inert",
  },
  {
    id: "preload-runtime-closure",
    stage: "prepush",
    run: "bun test tests/meta/preload-runtime-closure-hellgate.test.ts",
    why: "the bunfig preload dragging production slices into every test — it was 1,259 files of src/, and it made the non-vacuity mirror impossible to start",
  },
  {
    id: "real-toolchain-e2e",
    stage: "prepush",
    run: "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run test:real-toolchain",
    why: "the `*-real-e2e.test.ts` lane — 43 cases that run in NO other gate, because the env gate that keeps them out of the unit speed budget also kept them out of every gate",
  },
  {
    id: "pm-dod-ratchet",
    stage: "prepush",
    run: "bun run pm:gate",
    why: "a new/touched feature that does not meet the Definition of Done",
  },
  {
    id: "contract",
    stage: "prepush",
    run: "bun test tests/contract",
    why: "real docker + language servers + python/lancedb; skips politely without them",
  },
  {
    id: "rest-suites",
    stage: "prepush",
    run: "bun test tests/meta tests/adversarial tests/measurement ./src/ ./tools/",
    why: "the colocated src/ tests plus the meta/adversarial/measurement tiers, which no other gate covers",
    notInWorkflow:
      "no workflow runs these paths; `bun run test` and `test:ci` do, so they are a real part of the local gate",
  },
]

/**
 * Which workflow files define MERGE GATES. Only these are compared against the
 * manifest; the rest run on a cron / a label / a PR-bot trigger and never block
 * a merge, so folding them in would demand that `bun run prepush` execute a
 * nightly bench and a live-LLM grounding canary.
 *
 * Both lists together must cover `.github/workflows/` exactly — the parity test
 * asserts it — so a NEW workflow file forces a deliberate classification rather
 * than defaulting to "not a gate".
 */
export const GATING_WORKFLOWS: readonly string[] = ["ci.yml", "fc-gate.yml"]

export const NON_GATING_WORKFLOWS: readonly { readonly file: string; readonly why: string }[] = [
  { file: "agent-auto-fix.yml", why: "agent bot, label/dispatch triggered — not a merge gate" },
  { file: "agent-nightly-regression.yml", why: "cron bench run, needs provider keys" },
  { file: "agent-pr-review.yml", why: "review bot commenting on PRs, never blocks" },
  {
    file: "grounding-live-gate.yml",
    why: "live-LLM canary; opt-in via the `grounding-gate` label",
  },
  { file: "quanta-pr-bot.yml.template", why: "a template, not an installed workflow" },
]

export const gatesForStage = (stage: GateStage): readonly Gate[] =>
  stage === "precommit"
    ? GATES.filter((g) => g.stage === "precommit")
    : // prepush is a SUPERSET: the static gates run first, then the suites.
      GATES

/**
 * Workflow `run:` commands that are deliberately NOT gates: environment setup,
 * or steps belonging to a non-blocking job. Kept as an explicit list so the
 * parity test's universe stays closed — a new workflow step is either a gate or
 * an admitted exemption, never silently neither.
 */
export const WORKFLOW_EXEMPT: readonly { readonly match: string; readonly why: string }[] = [
  { match: "bun install --frozen-lockfile", why: "dependency install" },
  {
    match: "bun add -g pyright typescript typescript-language-server",
    why: "contract-job toolchain",
  },
  { match: "docker version", why: "contract-job sanity probe" },
  { match: "python -m pip install", why: "contract-job lancedb runtime" },
  { match: "mkdir -p .eval-corpus", why: "eval job (non-blocking, needs a key)" },
  {
    match: "writeSyntheticCorpus",
    why: "eval job (non-blocking, needs a key) — the synthetic-corpus writer inside that step's shell block",
  },
  { match: "bun run src/apps/bench/index.ts", why: "eval job (non-blocking, needs a key)" },
  { match: "bun run agent:batch", why: "nightly regression job (non-blocking)" },
  { match: "bun run agent:ci-bot", why: "PR-bot job (not a merge gate)" },
  { match: "GITHUB_STEP_SUMMARY", why: "fc gates audit — warn-only, surfaced in the step summary" },
  { match: "bun fc gates", why: "advisory maturity-promotion audit, explicitly warn-only" },
]
