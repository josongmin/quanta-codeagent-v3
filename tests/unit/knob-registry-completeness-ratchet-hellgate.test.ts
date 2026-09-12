/**
 * KNOB-REGISTRY COMPLETENESS RATCHET (ADR-0503, P0).
 *
 * GOVERNANCE INVARIANT: every `QUANTA_*` env var that is READ in `src/` to
 * gate/configure behavior MUST be declared in a known registry — so a feature
 * added later can never silently bypass discoverability + default-OFF proof
 * (the failure mode that left ~77 orphan reads this session).
 *
 * The knob systems are 3 (hexagonal-layer-forced, ADR-0503 — NOT mergeable):
 *   - `src/shared/runtime-config.ts`  (value knobs)
 *   - `src/runner/knobs/**`           (AgentConfig-mutating knobs)
 *   - [future] apps/cli-local         (CLI-render knobs)
 * This ratchet is the SINGLE governance point that spans all of them: it does
 * NOT care WHICH registry a knob lives in, only that EVERY read is in ONE.
 *
 * DECREASING-CEILING BURN-DOWN (same pattern as gate-vocabulary / no-raw-nul):
 * the count of orphan reads (read somewhere, declared nowhere) may only ever
 * DECREASE. A NEW orphan trips the ceiling → register it (or, if genuinely not
 * a knob, add to EXCEPTIONS with a reason). NON-BLOCKING: the ceiling is the
 * current high-water mark, not 0 — touching an existing orphan does not fail CI.
 *
 * Method: PURE STATIC source-scan (deterministic, no runtime registration
 * side-effects). The "declared" set = every QUANTA_* token in the declaration
 * files; "reads" = QUANTA_* tokens in env-access lines of every OTHER src file.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import ts from "typescript"
import {
  censusFiles,
  censusSource,
  declaredKeysInSources,
  type KnobAccess,
  readKeys,
  trackedSourceFiles,
} from "../../tools/dev/knob-env-access"

/** Files that DECLARE knobs (their QUANTA_* tokens are the registry, not orphan
 *  reads). The canonical reads live here by design. */
const isDeclarationFile = (path: string): boolean =>
  path.endsWith("src/shared/runtime-config.ts") ||
  path.includes("src/runner/knobs/") ||
  // the CLI-local registry (ADR-0503 P1) — declared, not orphan
  path.endsWith("src/apps/cli/cli-knobs.ts") ||
  // the daemon/agent-side declaration inventory (ADR-0503 P1; god-module split →
  // entries live in src/config/knob-inventory/{host,runner,daemon,bench,extra,const-keyed}.ts)
  path.includes("src/config/knob-inventory") ||
  // the bench knob SCHEMA SSOT (relocated into the config leaf): the bench
  // inventory is now `ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)`, so the
  // canonical `envKey: "QUANTA_BENCH_*"` declarations live in the schema files
  // here (`src/config/knob-schema/schemas/*`), not in the derived bench.ts.
  path.includes("src/config/knob-schema") ||
  // the typed runtime-config knob declaration registry (ADR-0503 P3; god-module
  // split → entries live in src/shared/runtime-config-knobs/knobs-{a,b,c}.ts)
  path.includes("src/shared/runtime-config-knobs")

/** Files excluded from the orphan scan entirely: tests, type decls, and the
 *  `--help` doc renderer (it NAMES knobs as documentation, not reads). */
const isExcludedFromScan = (path: string): boolean =>
  path.endsWith(".d.ts") ||
  path.endsWith(".test.ts") ||
  path.includes("/__tests__/") ||
  path.endsWith("src/apps/cli/help-render.ts")

/** A line that READS an env var (vs merely mentioning the token in prose / an
 *  error string). Requires an env-access or gate-helper on the line. */
/** EXCEPTIONS — tokens that look like knob reads but are NOT a registrable knob
 *  (e.g. a doc/error-string literal, a const NAME echoed in a read line). Each
 *  MUST carry a reason. Keep this SMALL; prefer registering a real knob. */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // SECRETS (ADR-0503) — credentials are owned by @/auth / the keyring, NEVER the
  // knob registry (a `/config set` of an API key would be a billing/scope hazard).
  // They are read at their auth call site; intentionally NOT a registrable knob.
  ["QUANTA_WEB_AUTH_TOKEN", "secret: web-daemon bearer token (apps/web-daemon, @/auth-owned)"],
  ["QUANTA_LANCE_API_KEY", "secret: Lance vector-DB credential (search-index-backend)"],
  ["QUANTA_QDRANT_API_KEY", "secret: Qdrant vector-DB credential (search-index-backend)"],
  ["QUANTA_CHATGPT_AUTH_SOURCE", "secret: ChatGPT token-store preference (@/auth/chatgpt-oauth)"],
  [
    "QUANTA_ENDPOINT_API_KEY",
    "secret: configured-endpoint API key (RFC05) — the host-resolved value for an openaiEndpoints authRef, owned at the CLI llm-build composition root (apps/cli/internal.ts), never a /config knob (a `/config set` of an endpoint credential would be a scope hazard). Same class as QUANTA_WEB_AUTH_TOKEN; the SELECTOR QUANTA_LLM_ENDPOINT is the registered knob.",
  ],
  [
    "QUANTA_SIDE_AGENT_LLM_REPLAY",
    "test-only: side-agent hermetic forked-child LLM replay seam (worker-charter-runner), not a user knob",
  ],
  // DEV / BENCH-INTERNAL toggles — read at their own call site, intentionally NOT
  // surfaced in /config (an internal bench/experiment seam, not a user setting).
  [
    // TB21-06 SR-6. This knob was RETIRED with the terminal-local best-of-N
    // sampler (trials belong to the run harness's `-k`, one fresh container per
    // trial). Its only remaining appearance is a REFUSAL: the 2.1 run config
    // names it so an operator who still exports it is told why it is gone. It is
    // deliberately absent from the inventory — re-registering it would need a
    // readSite for a module that no longer exists, i.e. a fabricated declaration
    // for a knob that changes nothing. Reachability of the refusal (env, --knob,
    // and decoded-manifest paths) is pinned in
    // tests/unit/apps/bench/terminal/tb-2-0-retirement.test.ts.
    "QUANTA_TB_BEST_OF_N",
    "retired (TB21-06 SR-6): a refusal-only literal in apps/bench/terminal/config.ts; the sampler, its runner and its inventory entry are deleted, so there is nothing left to declare",
  ],
  [
    "QUANTA_FORK_EXPERIMENT",
    "dev-experiment: counterfactual trajectory-fork troubleshooting seam (jun-23 fork-experiments), not a user knob",
  ],
  [
    "QUANTA_FORK_INJECT_TEXT",
    "dev-experiment: trajectory-fork text injection (fork-experiments), not a user knob",
  ],
  [
    "QUANTA_FORK_INJECT_TURN",
    "dev-experiment: trajectory-fork turn injection (fork-experiments), not a user knob",
  ],
  [
    "QUANTA_BENCH_REPLAY_LIMIT",
    "dev/bench-only: trajectory replay cap (apps/bench/trajectory), not a shipped user knob",
  ],
  [
    "QUANTA_CAPTURE_DEBUG",
    "dev/bench-only: jun-24 lost-edits RCA diagnostic (apps/bench/eval/driver — per-call git-status exec, default-OFF), not a shipped user knob",
  ],
  [
    "QUANTA_BENCH_HEALTH_ABORT",
    "bench-only: run-health systemic-failure abort control (runner/batch/eval/run-health — read at call site), not a shipped user /config knob",
  ],
  [
    "QUANTA_LSP_MEM_BUDGET_MB",
    "infra: LSP server RSS cap (lsp/server-mem-budget — operator memory-budget tuning read at call site), not a user /config knob",
  ],
  [
    "QUANTA_BENCH_NO_PROGRESS_ABORT_S",
    "bench-only: full-remote no-progress (wedged-box) idle-abort budget (resolveNoProgressBudgetMs, read at the full.ts composition root), same class as QUANTA_BENCH_HEALTH_ABORT — not a shipped /config knob",
  ],
  // `QUANTA_OTEL_ENDPOINT` used to sit here. It is DECLARED in
  // knob-inventory/daemon.ts, so `!declared && !excepted` already filtered it and
  // the row never once changed an outcome — which is exactly what the inert-row
  // assertion below now refuses to let happen again.
  [
    "QUANTA_OTEL_RUN_ID",
    "infra: OTEL trace-viewer deep-link run id (apps/bench/otel + default-trace-sink, operator tracing), not a user /config knob",
  ],
  [
    "QUANTA_OTEL_SINK",
    "infra: OTEL durable span-sink target file/s3 (apps/bench/span-sink resolveSpanSink, operator tracing), not a user /config knob",
  ],
  [
    "QUANTA_OTEL_S3_REGION",
    "infra: OTEL durable s3 span-sink region (apps/bench/span-sink, operator tracing), not a user /config knob",
  ],
  [
    "QUANTA_LSP_RSS_BUDGET_MB",
    "infra: LSP server RSS watchdog budget (lsp/server-rss-watchdog resolveLspRssBudgetMb — operator memory-budget tuning read at call site), sibling of QUANTA_LSP_MEM_BUDGET_MB, not a user /config knob",
  ],
  // BENCH-INTERNAL harness env (read at the bench/eval composition root to
  // configure benchmark + SWE-bench-Pro grading runs — a test-harness concern,
  // never a user-facing /config live-toggle). Same class as QUANTA_BENCH_HEALTH_ABORT.
  [
    "QUANTA_BENCH_HOST_MONITOR",
    "bench-only: host-resource sampler kill-switch (apps/bench/run-main, jun-28 fork-storm OOM diagnostic), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_BENCH_MAX_COST_USD",
    "bench-only: per-run cost cap for the eval driver (runner/batch/eval/driver/config-build), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_BENCH_MAX_COST_PER_TURN_USD",
    "bench-only: per-turn cost cap for the eval driver (runner/batch/eval/driver/config-build), read at the bench composition root, not a shipped /config knob",
  ],
  // VERIFY-AXIS strategy toggles (jul-4 3-axis prompt refactor + jul-5 P6): the SWE
  // verifyStrategy is picked in config-build.sweVerify via gateOn at the eval-driver
  // composition root (raw env, NOT the typed runtime-config registry that their sibling
  // QUANTA_BENCH_IN_LOOP_EXEC uses). Default-OFF, measure-first A/B levers — not shipped
  // user /config knobs. Same class as the cost/health/host-monitor bench toggles above.
  [
    "QUANTA_BENCH_REPRODUCE_FIRST",
    "bench-only: verify-axis reproduce-first strategy toggle (config-build.sweVerify), read via gateOn at the eval-driver composition root, default-OFF measure-first A/B — not a shipped /config knob",
  ],
  [
    "QUANTA_SWE_HIDDEN_GRADER",
    "bench-only: verify-axis grader-only strategy toggle + user-directive NOEXEC coherence (config-build.sweVerify + buildPromptText, P6 SWE hidden-grader pack), read via gateOn at the eval-driver composition root, default-OFF measure-first A/B — not a shipped /config knob",
  ],
  [
    "QUANTA_BENCH_PROMPT_SECTIONED",
    "bench-only: render STYLE axis toggle (flat|sectioned `##` headers, jul-6 4th prompt slot), read via gateOn at config-build (eval-driver composition root), default-OFF measure-first A/B on SWE f2p — same class as the verify-axis toggles above, not a shipped /config knob",
  ],
  [
    "QUANTA_OBS_RENDER",
    "bench-only: observation-kernel render toggle (jul-6 S3, `<quanta_observations>` vs legacy `## Issue Hints`), resolved DEFAULT-ON in benchPostureFromState (BenchPosture.renderObservations) — env disables (0/off/false) ⇒ byte-identical legacy render; not a shipped /config knob",
  ],
  [
    "QUANTA_BENCH_LANE_PROGRESS",
    "bench-only: live CLI view of parallel candidate lanes (apps/bench/lane-progress-renderer startLaneProgressRenderer, read at the bench composition root) — DEFAULT-ON terminal progress display, falsy disables; a bench-run display toggle, not a shipped /config knob",
  ],
  [
    "QUANTA_OBS_LSP_PREFETCH",
    "bench-only: LSP-enrich provider toggle (jul-6 S3, documentSymbol/hover over candidate files → symbol owners + contracts), resolved DEFAULT-ON in benchPostureFromState (BenchPosture.lspPrefetch) — env disables; graceful no-op without a language server; not a shipped /config knob",
  ],
  [
    "QUANTA_OBS_OWNER_CRITIC",
    "bench-only: observe-only OwnerCritic toggle (jul-6 S1, LSP callgraph refutes wrong-owner edits post-repair), resolved DEFAULT-OFF in benchPostureFromState (BenchPosture.ownerCritic) — repair-time LSP latency measure-first lever, fail-open telemetry, never diverts control flow; not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_DATASET_FAMILY",
    "bench-only: SWE-bench dataset family selector verified|pro|live (apps/bench/dataset-family), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PIP_SPEC",
    "bench-only: SWE-bench remote box pip spec override (apps/bench/remote/box-session/ec2-lifecycle), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PRO_HARNESS_DIR",
    "bench-only: SWE-bench-Pro ScaleAI grading harness dir (apps/bench/run-main buildProGradeVerifier), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH",
    "bench-only: SWE-bench-Pro raw sample path (apps/bench/run-main buildProGradeVerifier), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PRO_PYTHON_BIN",
    "bench-only: SWE-bench-Pro grading python bin (apps/bench/run-main), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PRO_MODEL_NAME",
    "bench-only: SWE-bench-Pro report model-name label (apps/bench/run-main), read at the bench composition root, not a shipped /config knob",
  ],
  [
    "QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME",
    "bench-only: SWE-bench-Pro DockerHub namespace for prebuilt images (apps/bench/run-main), read at the bench composition root, not a shipped /config knob",
  ],
  // TEST-ONLY SEAMS — read by a harness, never by an operator. Declaring one puts
  // a knob in `/knobs` that only tests are supposed to touch.
  [
    "QUANTA_SIDE_AGENT_TEST_MODE",
    "test-only: the forked side-agent worker's protocol seam (no_finding|throw|multi|late) in src/side-agent/worker-entry.mjs, set ONLY by tests/integration/sep8-remediation/r05. Direct sibling of QUANTA_SIDE_AGENT_LLM_REPLAY above. Unreachable in a compiled binary — nodeProcessForkPort throws SideAgentForkUnsupportedError before forking — and the port is not even constructed unless QUANTA_SIDE_AGENT_PROCESS is on (default-OFF)",
  ],
  // BUILD-TIME CONSTANTS — not operator knobs. These three are INLINED by
  // `bun build --env='QUANTA_BUILD_*'` at compile time, so in a shipped binary they
  // are literals, not environment. Setting one at runtime changes nothing, and
  // listing them in `/knobs` would advertise three settings that cannot be set.
  // They are recorded here instead, which is where the census expects a read that
  // is genuinely not a knob to be accounted for.
  [
    "QUANTA_BUILD_COMMIT",
    "build-time: inlined by tools/bin/build-cli.ts via `bun build --env`; the commit a compiled binary was built from, not a runtime setting",
  ],
  [
    "QUANTA_BUILD_DIRTY",
    "build-time: inlined alongside QUANTA_BUILD_COMMIT; whether the tree was modified at build time, so a dirty build cannot borrow a clean commit's identity",
  ],
  [
    "QUANTA_BUILD_TIME",
    "build-time: inlined alongside QUANTA_BUILD_COMMIT; distinguishes two builds of the same commit",
  ],
])

/**
 * The corpus. `git ls-files` rather than a directory walk: this tree carries two
 * gitignored mirrors of `src` (`tools/dev/.scratch`, `.pristine-audit`, together
 * ~12k files), and a readdir corpus makes this ceiling mean different numbers on
 * a developer machine and on a fresh clone.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..")
const isTestFile = (file: string): boolean => /\.test\.[cm]?ts$|(^|\/)__tests__\//.test(file)

/** The two filters this ratchet applies, as a pure function so an injected
 *  census can drive them without touching the tree. */
const orphansOf = (
  reads: ReadonlyMap<string, KnobAccess>,
  declared: ReadonlySet<string>,
  /** Membership only. `EXCEPTIONS` is a Map (key → reason) and the injection test
   *  passes a Set, so the parameter is typed to what is actually used — widening it
   *  to `ReadonlySet` looked right and did not typecheck, which `bun test` cannot
   *  tell you: it does not typecheck `.test.ts` at all. Only `typecheck:all` does. */
  excepted: { readonly has: (key: string) => boolean },
): Map<string, string> =>
  new Map(
    [...reads]
      .filter(([token]) => !declared.has(token) && !excepted.has(token))
      .map(([token, access]) => [token, `${access.file}:${access.line}`] as const),
  )

const scan = (): {
  declared: Set<string>
  orphans: Map<string, string>
  reads: Map<string, KnobAccess>
  files: readonly string[]
} => {
  const files = trackedSourceFiles(REPO_ROOT, ["src"])
  const census = censusFiles(REPO_ROOT, files)
  const declared = declaredKeysInSources(REPO_ROOT, files, isDeclarationFile)
  // A test that reads an env key is not evidence of an operator knob, and the
  // registry exists for operator discoverability. Excluded EXPLICITLY rather than
  // by accident — the population assertion below keeps the narrowing honest.
  const reads = readKeys(
    census,
    (f) => isDeclarationFile(f) || isExcludedFromScan(f) || isTestFile(f),
  )
  return { declared, orphans: orphansOf(reads, declared, EXCEPTIONS), reads, files }
}

/** Frozen ceiling = current orphan high-water mark (ADR-0503 P0 baseline).
 *  May ONLY decrease as orphans are burned down (P1). A new orphan above this
 *  is a governance regression — declare the knob in one of the 3 registries.
 *
 *  Baseline 196 (jun-07, TDD red-first: ceiling 0 → RED surfaced 196 → recorded).
 *  This is the FULL surface of `QUANTA_*` DIRECT-env reads (`process.env.X` /
 *  `gateOn(env,"X")` / `env["X"]`) in non-declaration files that are NOT in the
 *  typed registries (runtime-config / @/runner/knobs). NOTE: a knob properly
 *  registered in runtime-config is consumed as `runtimeConfig().field` and so
 *  never appears here — these 196 genuinely bypass the central typed registry
 *  (many are legit `gateOn` reads but undiscoverable: not in --help/catalog).
 *  P1 burn-down: register each (or route through runtimeConfig) → ceiling ↓ 0.
 *  Priority subset = the 50 needing a NEW home (ADR-0503 §census: 16 AgentConfig
 *  → @/runner/knobs, 8 daemon → runtime-config, 26 CLI-render → apps/cli-local).
 *
 *  Burn-down log (decreasing-only):
 *    196 → 181  (P1-C cluster 1: 15 CLI-render knobs → apps/cli/cli-knobs.ts —
 *                flash timings + status/lifecycle pills)
 *    181 → 171  (P1-C cluster 2: 10 REPL render/input/history knobs → cli-knobs.ts)
 *    171 → 139  (P1-C cluster 3: 32 CLI render/input/status/session/voice → cli-knobs.ts)
 *    139 → 0    (P1 complete: +21 CLI agent-gates & +9 subagent/remote → cli-knobs.ts;
 *                +95 host/runner/daemon/bench → src/config/knob-inventory.ts;
 *                4 secrets → EXCEPTIONS. ALL reads now declared.)
 *  CEILING IS 0: every QUANTA_* read is declared in a registry OR a secret
 *  exception. A new undeclared read is a hard regression. Read-routing of
 *  declared knobs to their typed home (runtime-config field / @/runner/knobs
 *  Knob) is P4 — declaration here already closes the governance gap. */
const ORPHAN_CEILING = 0

describe("knob-registry completeness ratchet (ADR-0503 P0)", () => {
  test(`orphan QUANTA_* reads (declared nowhere) stay <= ${ORPHAN_CEILING}`, () => {
    const { declared, orphans, files, reads } = scan()
    // The corpus floor. `ORPHAN_CEILING` is 0, so `orphans.size <= 0` is satisfied
    // by a scan that read NOTHING — and this file once printed
    // `declared=0 orphans=0/0` while passing against an empty mirror of the tree.
    expect(
      files.length,
      "the tracked-source corpus collapsed — the completeness verdict is over an empty scan",
    ).toBeGreaterThan(3000)
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(
      `[knob-completeness] declared=${declared.size} orphans=${orphans.size}/${ORPHAN_CEILING}`,
    )
    if (orphans.size > ORPHAN_CEILING) {
      const list = [...orphans.entries()]
        .sort()
        .map(([t, loc]) => `  ${t}  (${loc})`)
        .join("\n")
      throw new Error(
        `${orphans.size} orphan QUANTA_* reads (ceiling ${ORPHAN_CEILING}) — each is read in src ` +
          `but declared in NO registry (runtime-config / @/runner/knobs / apps/cli-local). ` +
          `Declare it, or add to EXCEPTIONS with a reason:\n${list}`,
      )
    }
    // The floor this file LOGGED but never asserted. `ORPHAN_CEILING` is 0, so
    // `orphans.size <= 0` is satisfied by a scan that read nothing — and the
    // log line printed `declared=0 orphans=0/0` while passing 2/0 against an
    // empty mirror of the repo tree. The registry count is the only thing that
    // separates "every read is declared" from "no read was seen".
    expect(
      declared.size,
      "no knob declarations found — the completeness verdict is over an empty scan",
    ).toBeGreaterThan(400)
    // The THIRD floor, and the one this file shipped without. `files` and
    // `declared` are both computed from the corpus, so both survive a scan whose
    // READ resolution has broken. Measured: widening `isExcludedFromScan` to
    // cover all of `src/` collapses reads to 0 while files stays >3000 and
    // declared stays 674 — and this test passed. The only thing that fired was a
    // sibling test, and that backstop holds only while EXCEPTIONS is non-empty,
    // which this file's own guidance ("keep this SMALL") works against.
    expect(
      reads.size,
      "no QUANTA_* reads resolved — every knob is trivially declared because nothing was read",
    ).toBeGreaterThan(400)
    expect(orphans.size).toBeLessThanOrEqual(ORPHAN_CEILING)
  }, 30_000)

  /**
   * The escape hatch is measured too.
   *
   * While the ceiling sat pinned at 0, `EXCEPTIONS` grew from 1 row to its
   * current size and nothing asserted either. ONE row was pure decoration:
   * `QUANTA_OTEL_ENDPOINT` was DECLARED as well as excepted, and
   * `!declared && !excepted` already filtered it, so that row had never once
   * changed an outcome. A row nobody checks is a ceiling nobody raised.
   *
   * (An earlier version of this comment, and the commit message that added it,
   * said TWO rows were inert and named `QUANTA_CONTEXT_1M` as the second.
   * `QUANTA_CONTEXT_1M` was never in `EXCEPTIONS` at all — it appears only in a
   * fixture line further down this file.)
   */
  /**
   * The list's SIZE is pinned, and the pin is checked against the SOURCE rather
   * than the Map.
   *
   * `EXCEPTIONS` is a `Map` literal, so a duplicated key is silently collapsed —
   * the later row wins and the earlier one becomes unreachable. That is not
   * hypothetical: `QUANTA_TB_BEST_OF_N` was keyed twice, and the second row (added
   * by the commit that also added the "no inert row" and "no stale row" tests)
   * overwrote a longer, more precise reason. All three quality tests read the Map,
   * so none of them could see it. Counting the literal rows in this file's own
   * text is the only way a duplicate becomes visible.
   */
  test("EXCEPTIONS is pinned in size and free of duplicate keys", () => {
    const src = readFileSync(join(import.meta.dir, basename(import.meta.path)), "utf8")
    const block = src.slice(
      src.indexOf("const EXCEPTIONS: ReadonlyMap<string, string> = new Map<string, string>(["),
    )
    const sf = ts.createSourceFile("e.ts", block, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    let rows: string[] | undefined
    const visit = (node: ts.Node): void => {
      if (rows === undefined && ts.isArrayLiteralExpression(node)) {
        const keys = node.elements
          .filter(ts.isArrayLiteralExpression)
          .map((e) => e.elements[0])
          .filter((e): e is ts.StringLiteral => e !== undefined && ts.isStringLiteral(e))
          .map((e) => e.text)
        if (keys.length > 0) rows = keys
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sf, visit)
    const literalRows = rows ?? []
    expect(literalRows.length, "could not parse the EXCEPTIONS literal").toBeGreaterThan(20)
    const dupes = literalRows.filter((k, i) => literalRows.indexOf(k) !== i)
    expect(dupes, "these keys appear twice in the EXCEPTIONS literal — the later row wins").toEqual(
      [],
    )
    // Every literal row must survive into the Map, and the size is frozen. An
    // exception is the only way past a ceiling of 0, so growing this list is the
    // same act as raising the ceiling.
    expect(EXCEPTIONS.size).toBe(literalRows.length)
    expect(EXCEPTIONS.size).toBe(40)
  })

  test("no EXCEPTIONS row is inert — excepting a DECLARED key does nothing", () => {
    const { declared } = scan()
    const redundant = [...EXCEPTIONS.keys()].filter((key) => declared.has(key))
    expect(
      redundant,
      "these keys are declared in a registry AND excepted — the exception row is dead, delete it",
    ).toEqual([])
  }, 30_000)

  test("no EXCEPTIONS row is stale — an exception for a key nothing reads is dead", () => {
    const { reads } = scan()
    // A row may legitimately outlive its read for one commit (the read is removed
    // first), so the assertion names the rows rather than counting them.
    const unread = [...EXCEPTIONS.keys()].filter((key) => !reads.has(key))
    expect(
      unread,
      "these keys are excepted but no longer read anywhere — delete the row in the same change",
    ).toEqual([])
  }, 30_000)

  test("every EXCEPTIONS row carries a reason", () => {
    const empty = [...EXCEPTIONS.entries()].filter(([, why]) => why.trim().length < 20)
    expect(
      empty.map(([k]) => k),
      "an exception without a real reason is a silent ceiling raise",
    ).toEqual([])
  })

  /**
   * RED-ON-INJECTION at the RATCHET, not at the scanner.
   *
   * `tests/unit/dev/knob-env-access.test.ts` proves the census SEES each access
   * form. What this proves is the wiring: that a seen read with no declaration and
   * no exception actually becomes an orphan here, and that the two filters this
   * ratchet applies (declared, excepted) each remove one and only one.
   *
   * Both halves matter. With only the positive case, "everything is an orphan"
   * passes. With only the negatives, "nothing is ever an orphan" passes — which is
   * the state this file was in for the seven access forms the regex could not see.
   */
  test("an undeclared read becomes an orphan; a declared or excepted one does not", () => {
    const injected = [
      "const a = env.QUANTA_INJ_UNDECLARED",
      "const b = env.QUANTA_INJ_DECLARED",
      "const c = env.QUANTA_INJ_EXCEPTED",
    ].join("\n")
    const reads = new Map(
      censusSource("injected.ts", injected)
        .filter((x) => x.kind === "read")
        .map((x) => [x.key, x] as const),
    )
    expect([...reads.keys()].sort()).toEqual([
      "QUANTA_INJ_DECLARED",
      "QUANTA_INJ_EXCEPTED",
      "QUANTA_INJ_UNDECLARED",
    ])

    const orphans = orphansOf(
      reads,
      new Set(["QUANTA_INJ_DECLARED"]),
      new Set(["QUANTA_INJ_EXCEPTED"]),
    )
    expect([...orphans.keys()]).toEqual(["QUANTA_INJ_UNDECLARED"])

    // Each filter removes exactly one — neither is a no-op that the other covers.
    expect(
      [...orphansOf(reads, new Set(), new Set(["QUANTA_INJ_EXCEPTED"])).keys()].sort(),
    ).toEqual(["QUANTA_INJ_DECLARED", "QUANTA_INJ_UNDECLARED"])
    expect(
      [...orphansOf(reads, new Set(["QUANTA_INJ_DECLARED"]), new Set()).keys()].sort(),
    ).toEqual(["QUANTA_INJ_EXCEPTED", "QUANTA_INJ_UNDECLARED"])
  })

  // A write is not a read. `process.env.QUANTA_ALLOW_UNSIGNED = "1"` is a process
  // seeding a CHILD, and the regex scanner counted it — which asked the registry
  // to declare a value nothing ever reads back.
  test("a write-only access never reaches the orphan set", () => {
    const reads = new Map(
      censusSource("injected.ts", 'process.env.QUANTA_INJ_WRITE = "1"')
        .filter((x) => x.kind === "read")
        .map((x) => [x.key, x] as const),
    )
    expect(reads.size).toBe(0)
    expect(orphansOf(reads, new Set(), new Set()).size).toBe(0)
  })
})
