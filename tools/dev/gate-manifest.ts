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
   * Set when this gate can PASS by finding nothing to check on this host. The
   * summary then marks it, and the run's closing line counts it separately —
   * because a green that includes a gate which verified nothing poisons every
   * other number beside it. The string says what makes it host-dependent.
   */
  readonly hostDependent?: string
  /**
   * Set ONLY for a gate no workflow runs. The string is the justification the
   * parity test prints, so an unrunnable-in-CI gate stays visible rather than
   * silently expanding the local-only set.
   */
  readonly notInWorkflow?: string
  /**
   * This gate drives a REAL external toolchain and loses to CPU contention
   * rather than slowing down under it. Set to the reason; the runner then waits
   * (bounded) for the box to stop being oversubscribed before starting it.
   *
   * Never a longer timeout: a starved language server returns EMPTY, not late,
   * so more time buys a differently-timed wrong answer.
   */
  readonly needsQuietBox?: string
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
    id: "full-suite",
    stage: "prepush",
    run: "bun run tools/dev/worktree-pollution-guard.ts -- bun run test:full:ci",
    why:
      "ONE authoritative execution of unit + integration + meta/adversarial/measurement + " +
      "colocated src/tools tests (the chunked runner), wrapped so a test that leaves a file " +
      "in the worktree is caught at the source. It replaced three separate suite gates that " +
      "each re-bought discovery and re-queued on the repository lane; every receipt-consuming " +
      "gate below derives its verdict from this run's junit/scan-reach receipts",
  },
  {
    id: "unit-speed-budget",
    stage: "prepush",
    consumes: "full-suite",
    run: "bun run tools/dev/unit-speed-budget.ts .cache/full-junit.xml --scope=tests/unit/",
    why: "no SINGLE unit test may exceed the pinned ceiling; consumes the full-suite junit receipt scoped to the unit tier",
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
    id: "scan-reach",
    stage: "prepush",
    consumes: "full-suite",
    run: "bun run scan-reach",
    why: "a scanning guard whose corpus shrank under it — the floors are measured numbers in tools/dev/scan-reach-baseline.json, so a scan that quietly stopped reaching fails instead of reporting clean; consumes the scan-reach receipt the full-suite run writes",
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
    consumes: "full-suite",
    run: "bun run tools/dev/junit-file-green.ts .cache/full-junit.xml tests/meta/preload-runtime-closure-hellgate.test.ts",
    why: "the bunfig preload dragging production slices into every test — it was 1,259 files of src/. The hellgate already runs inside the full suite; this consumes its receipt instead of executing the file a second time",
  },
  {
    id: "real-toolchain-e2e",
    stage: "prepush",
    run: "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run test:real-toolchain",
    why: "the `*-real-e2e.test.ts` lane — 43 cases that run in NO other gate, because the env gate that keeps them out of the unit speed budget also kept them out of every gate",
    needsQuietBox:
      "real rust-analyzer/gopls/pyright indexing a fixture project. MEASURED on this 16-core box, same commit and command: at load 52 evidence-lsp-bridge-real-e2e goes 1 pass / 1 fail (a starved server answers with an EMPTY hover); at load 3.9 it goes 2 pass in 5.2s. The lane was already moved out of the parallel suite for exactly this, but it starts right after a 30-chunk full suite",
  },
  {
    id: "web-frontend",
    stage: "prepush",
    run: "bun run test:web-frontend",
    why: "the SPA's 744 tests, which ran in NO gate — `bun test` cannot give them a verdict (it loads the files but supplies no DOM), so the positional gates skipped them and an out-of-band entry naming a working runner read as coverage. 4.3s under vitest",
  },
  {
    id: "pm-dod-ratchet",
    stage: "prepush",
    consumes: "full-suite",
    run: "bun run tools/dev/junit-file-green.ts .cache/full-junit.xml tests/unit/pm-dod-ratchet.test.ts",
    why: "a new/touched feature that does not meet the Definition of Done. The ratchet test already runs inside the full suite; this consumes its receipt instead of executing the file a second time",
  },
  {
    id: "contract",
    stage: "prepush",
    run: "bun test tests/contract",
    why: 'real docker + language servers + python/lancedb. LOCALLY THIS PASSES BY SKIPPING: the ci.yml job sets REQUIRE_CONTRACT=1 at the JOB level ("absent dependency = hard fail, never a silent skip") and the manifest pins the command string, not the env — so a local PASS here means "nothing was missing that I checked", not "the contracts hold"',
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
export const WORKFLOW_EXEMPT: readonly {
  readonly match: string
  /** The workflow the exemption is granted IN. An unscoped exemption is a hole:
   *  "advisory maturity-promotion audit, explicitly warn-only" is true of the
   *  `|| true` step in fc-gate.yml, and an audit used it to smuggle a genuinely
   *  BLOCKING `run: bun fc gates` into ci.yml unnoticed. */
  readonly file: string
  readonly why: string
}[] = [
  // The setup actions every job needs. Named ONE BY ONE, not by a `uses:`
  // wildcard: a third-party action blocks a job exactly as a `run:` does, and an
  // audit shipped `uses: evil/blocking-action@v1` past this guard while it saw
  // only `run:` steps. A new action is now a deliberate line here.
  { file: "*", match: "uses: actions/checkout@", why: "checkout — required by every job" },
  { file: "*", match: "uses: oven-sh/setup-bun@", why: "the bun toolchain itself" },
  { file: "*", match: "uses: actions/cache@", why: "tsbuildinfo cache; cannot change a verdict" },
  { file: "*", match: "uses: actions/setup-python@", why: "contract-job python runtime" },
  {
    file: "ci.yml",
    match: "uses: actions/upload-artifact@",
    why: "eval job (non-blocking) publishes its report",
  },
  { file: "*", match: "bun install --frozen-lockfile", why: "dependency install" },
  {
    file: "*",
    match: "bun add -g pyright typescript typescript-language-server",
    why: "contract-job toolchain",
  },
  { file: "*", match: "docker version", why: "contract-job sanity probe" },
  { file: "*", match: "python -m pip install", why: "contract-job lancedb runtime" },
  { file: "ci.yml", match: "mkdir -p .eval-corpus", why: "eval job (non-blocking, needs a key)" },
  {
    file: "ci.yml",
    match: "writeSyntheticCorpus",
    why: "eval job (non-blocking, needs a key) — the synthetic-corpus writer inside that step's shell block",
  },
  {
    file: "ci.yml",
    match: "bun run src/apps/bench/index.ts",
    why: "eval job (non-blocking, needs a key)",
  },
  { file: "*", match: "bun run agent:batch", why: "nightly regression job (non-blocking)" },
  { file: "*", match: "bun run agent:ci-bot", why: "PR-bot job (not a merge gate)" },
  {
    file: "fc-gate.yml",
    match: "GITHUB_STEP_SUMMARY",
    why: "fc gates audit — warn-only, surfaced in the step summary",
  },
  {
    file: "fc-gate.yml",
    match: "bun fc gates",
    why: "advisory maturity-promotion audit, explicitly warn-only",
  },
  {
    file: "fc-gate.yml",
    match: "bun run pm:gate",
    why: "standalone DoD-ratchet execution in the fc job; the merge gate consumes the full-suite junit receipt for the same test file instead",
  },
]

/**
 * Gate ids that may NEVER leave this manifest.
 *
 * Deleting a gate and adding a `WORKFLOW_EXEMPT` entry for the same command in
 * one commit satisfied every other check: direction ① saw the workflow step as
 * exempt, direction ② had no manifest gate left to compare, and the count floor
 * still cleared. This list is the ratchet that shape needs — it can grow when a
 * gate is added, and shrinking it is a deliberate, reviewable edit rather than a
 * side effect of an exemption.
 */
export const REQUIRED_GATE_IDS: readonly string[] = [
  // EVERY gate id, deliberately: with only a subset listed, the seven unlisted
  // gates were open to the exact delete+exempt regression this ratchet exists
  // for. Removing a gate now requires editing this list in the same reviewable
  // diff.
  "typecheck",
  "lint",
  "lint-debt",
  "fc-check-changed",
  "fc-validate",
  "fc-diff",
  "fc-lint",
  "fc-reachability",
  "silent-catch-baseline",
  "protocol-generated",
  "full-suite",
  "unit-speed-budget",
  "e2e-pty",
  "cwd-parity-arch",
  "scan-reach",
  "non-vacuity-oracle",
  "preload-runtime-closure",
  "real-toolchain-e2e",
  "web-frontend",
  "pm-dod-ratchet",
  "contract",
]
