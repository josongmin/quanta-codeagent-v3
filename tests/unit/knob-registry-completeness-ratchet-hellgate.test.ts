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
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** A QUANTA_* env-var read is ALWAYS either quoted (`"QUANTA_X"` — bracket
 *  access / gate-helper arg / `envKey:` decl) or a dot-access (`env.QUANTA_X`,
 *  `process.env.QUANTA_X`). A BARE identifier (`gateOn(env, QUANTA_X_ENV)`) is a
 *  CONST reference whose VALUE is the real var (declared at the const site) — NOT
 *  a distinct knob, so we must NOT count the const name. These two precise
 *  extractors skip const-name false-positives (the `*_ENV` noise). */
const QUOTED = /[`"'](QUANTA_[A-Z0-9_]+)[`"']/g // backtick ⇒ template-bracket env[`X`]
const ENV_DOT = /\benv\.(QUANTA_[A-Z0-9_]+)\b/g
// destructure read: `const { QUANTA_X, QUANTA_Y } = env` / `… = process.env`
const DESTRUCT = /\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g
const TOKEN = /\bQUANTA_[A-Z0-9_]+/g

/** Every real-read QUANTA_* token on a line (quoted ∪ env-dot ∪ destructure). */
const knobsOnLine = (line: string): string[] => {
  const out: string[] = []
  for (const m of line.matchAll(QUOTED)) out.push(m[1] as string)
  for (const m of line.matchAll(ENV_DOT)) out.push(m[1] as string)
  for (const d of line.matchAll(DESTRUCT)) {
    for (const t of (d[1] as string).matchAll(TOKEN)) out.push(t[0])
  }
  return out
}

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
const isReadLine = (line: string): boolean => {
  const t = line.trimStart()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false
  return (
    /\bprocess\.env\b/.test(line) ||
    /\benv\s*[.[]/.test(line) ||
    /\bgate(?:On|Disabled)(?:Strict)?\s*\(/.test(line) ||
    /\bparseEnvFlag\s*\(/.test(line) ||
    // destructure read: `const { QUANTA_X } = env` / `… = process.env`
    /\}\s*=\s*(?:process\.)?env\b/.test(line) ||
    // const-keyed gate: `const FOO_ENV = "QUANTA_X"` then `gateOn(env, FOO_ENV)`.
    // The gateOn line has only a BARE const ref (invisible), so we instead count
    // the const DEFINITION (a QUANTA literal being ASSIGNED). Precise `= "..."`
    // form (incl. backtick) excludes error/log strings like `Error("QUANTA_X failed")`.
    /[=:]\s*[`"']QUANTA_[A-Z0-9_]+[`"']/.test(line)
  )
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts")) yield p
  }
}

/** Declared tokens in a declaration file = every quoted/env-dot QUANTA_* on any
 *  non-comment line (declarations use `env["X"]` / `envKey: "X"` — both quoted). */
const declaredTokensIn = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const line of text.split("\n")) {
    const t = line.trimStart()
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue
    for (const tok of knobsOnLine(line)) out.add(tok)
  }
  return out
}

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
  [
    "QUANTA_OTEL_ENDPOINT",
    "infra: operator OTEL collector URL (apps/bench OTLP export + reverse tunnel, read at the bench composition root), not a user /config knob",
  ],
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
])

const scan = (): { declared: Set<string>; orphans: Map<string, string> } => {
  const declared = new Set<string>()
  const reads = new Map<string, string>() // token -> first file:line
  for (const file of walk("src")) {
    const rel = file.replace(/^.*\/quanta-codeagent-v3\//, "")
    const text = readFileSync(file, "utf8")
    if (isDeclarationFile(file)) {
      for (const tok of declaredTokensIn(text)) declared.add(tok)
      continue
    }
    if (isExcludedFromScan(file)) continue
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!isReadLine(line)) continue
      for (const tok of knobsOnLine(line)) {
        if (!reads.has(tok)) reads.set(tok, `${rel}:${i + 1}`)
      }
    }
  }
  const orphans = new Map<string, string>()
  for (const [tok, loc] of reads) {
    if (!declared.has(tok) && !EXCEPTIONS.has(tok)) orphans.set(tok, loc)
  }
  return { declared, orphans }
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
    const { declared, orphans } = scan()
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
    expect(orphans.size).toBeLessThanOrEqual(ORPHAN_CEILING)
  }, 15_000)

  // RED-ON-INJECTION: prove the scanner actually CATCHES an orphan read and does
  // NOT false-positive on a declared one — else the ceiling is a vacuous 0.
  test("scanner catches an undeclared read but not a declared one", () => {
    expect(isReadLine(`  const x = gateOn(env, "QUANTA_FAKE_ORPHAN")`)).toBe(true)
    expect(isReadLine(`  // QUANTA_FAKE_ORPHAN is just a comment`)).toBe(false)
    expect(isReadLine(`  throw new Error("QUANTA_FAKE_ORPHAN failed")`)).toBe(false)
    // quoted + env-dot are caught; bare const-name (the `*_ENV` indirection) is NOT
    expect(knobsOnLine(`gateOn(env, "QUANTA_FAKE_ORPHAN")`)).toEqual(["QUANTA_FAKE_ORPHAN"])
    expect(knobsOnLine(`const x = process.env.QUANTA_DOT_READ`)).toEqual(["QUANTA_DOT_READ"])
    expect(knobsOnLine(`gateOnStrict(env, QUANTA_CODE_MODE_ENV)`)).toEqual([]) // bare const ref skipped
    // P2-R1 fix: a const-keyed gate is caught at its DEFINITION line (the QUANTA
    // literal being assigned), closing the `gateOn(env, CONST)` false-negative hole.
    expect(isReadLine(`const CONTEXT_1M_FLAG = "QUANTA_CONTEXT_1M"`)).toBe(true)
    expect(knobsOnLine(`const CONTEXT_1M_FLAG = "QUANTA_CONTEXT_1M"`)).toEqual([
      "QUANTA_CONTEXT_1M",
    ])
    expect(isReadLine(`  throw new Error("QUANTA_X failed")`)).toBe(false) // error string still NOT a read
    // R3 mutation-test: destructure + template-bracket evasion forms are caught.
    expect(isReadLine("const { QUANTA_DESTRUCT } = env")).toBe(true)
    expect(knobsOnLine("const { QUANTA_DESTRUCT, QUANTA_TWO } = process.env")).toEqual([
      "QUANTA_DESTRUCT",
      "QUANTA_TWO",
    ])
    expect(isReadLine("const x = env[`QUANTA_TMPL`]")).toBe(true)
    expect(knobsOnLine("const x = env[`QUANTA_TMPL`]")).toEqual(["QUANTA_TMPL"])
    // a non-QUANTA destructure is harmless (read-line but yields no tokens)
    expect(knobsOnLine("const { foo, bar } = env")).toEqual([])
  })
})
