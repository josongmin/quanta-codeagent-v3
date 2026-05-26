/**
 * Single-instance SWE-bench-style runner — top-level orchestration.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd (or the Python harness) to
 * decide pass/fail and captures a unified diff of the sandbox as the produced
 * patch.
 *
 * This file is the ONLY place that ties the eval sub-slice together:
 *   sandbox.create → env-prep.run → snapshot.withSnapshot(runAgent) →
 *   verdict.verify → report.emit*. Each step lives in its own sibling module
 *   (sandbox.ts / env-prep.ts / snapshot.ts / verdict.ts / report.ts / exec.ts).
 *
 * Behavior is byte-identical to the pre-decompose `src/apps/bench/runner.ts`;
 * this is a pure structural refactor.
 */

import { type Dirent, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import {
  type AgentConfig,
  type AgentlessLocalizeDeps,
  type AgentlessLocalizeResult,
  agentlessLocalize,
  type BranchSearchConfig,
  buildSystemPrompt,
  composeAgentlessHint,
  composeIssueHint,
  executeReproTests,
  extractIssueHint,
  generateReproTests,
  lspNavToolList,
  type ReproExecPort,
  type ReproTestConfig,
  type ReproTestSelection,
  type ReproWriteFilePort,
  runAgent,
  selectReproTest,
} from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { type AttemptObservation, BenchObserver, UsageTap } from "../observe"
import type { BenchAttemptOutcome, Instance, InstanceResult } from "../types"
import { computeAdaptedTimeout } from "./adaptive-timeout"
import { runEnvPrep } from "./env-prep"
import { exec, execArgv } from "./exec"
import { knobsForReport, resolveBenchKnobs } from "./knobs-bench"
import { buildRepairContext } from "./repair/context"
import { runRepairRounds } from "./repair/index"
import type {
  BuildRepairContextArgs,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import {
  buildWiring,
  emitPatch,
  emitSandbox,
  emitVerify,
  NullStream,
  ObservationError,
  type Wiring,
} from "./report"
import {
  type AttemptOutcome,
  classifyOutcome,
  DEFAULT_POLICY,
  parseRetryTransientEnv,
  type RetryPolicy,
  runRetryLoop,
} from "./retry-policy"
import { cleanupSandbox, copyRepo, createSandbox } from "./sandbox"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { type PythonSwebenchEvaluate, verify } from "./verdict"

export interface RunInstanceDeps {
  llm: LLMPort
  /** Hard ceiling on agent turns per attempt. */
  maxTurns: number
  /** Wall-clock budget (ms) for the whole instance. */
  timeoutMs: number
  /**
   * Official-harness verifier. When present AND the instance carries swebench
   * metadata, the captured patch is graded by the Python harness instead of
   * the local `testCmd`. Absent (default) ⇒ unchanged local testCmd path.
   * `opts` is forwarded to `evaluateWithPythonSwebench` (injectable spawn/probe
   * keep tests hermetic). index.ts gates this behind `QUANTA_SWEBENCH_PYTHON=1`.
   */
  pythonSwebench?: {
    evaluate?: PythonSwebenchEvaluate
    opts?: unknown
  }
  /**
   * RFC-0002 §8 observability. ABSENT (default) ⇒ `NullStream`, byte-identical
   * to pre-W-D behavior — no files written. PRESENT ⇒ the agent stream is
   * `TeeStream([NullStream, JsonlRecorder(<run>/<id>.<attempt>.jsonl)])` with
   * `strict:true` (eval), plus bench-produced `sandbox`/`patch_generated`/
   * `verify` lines. A strict recorder failure ⇒ `verdict:"degraded"`.
   */
  observe?: AttemptObservation
  /**
   * b2 — External repair rounds (RFC §16, ADR-0014). ABSENT (default) ⇒ feature
   * OFF / byte-identical single-pass; same gating posture as `pythonSwebench?`/
   * `observe?`. When present AND `instance.swebench` is set, the runner wraps
   * `runAgentPhase` in `runRepairRounds`: rounds share ONE sandbox (continue-
   * from-patched-tree, no git reset between rounds), the official `verify()`
   * runs EXACTLY ONCE at the end (no-leak invariant — never fed back to the
   * agent), and the seed message handed to round ≥1 is built from the agent's
   * own validator failure tail (NOT from any dataset hidden field).
   * `validate`/`buildContext` are injectable test seams; production defaults
   * are the G1 implementations.
   */
  repair?: {
    maxRounds?: number
    validate?: (args: ValidateArgs) => Promise<ValidatorResult>
    buildContext?: (args: BuildRepairContextArgs) => string
  }
  /**
   * Measurement-stability slice: knob-aware adaptive timeout + transient-retry
   * loop. ABSENT (default) ⇒ feature OFF (byte-identical single-pass path) —
   * `deps.timeoutMs` is the deadline, retries are not attempted, and the
   * `budget` field is omitted from `InstanceResult`. PRESENT ⇒ the driver:
   *   1. resolves the bench-surface knob state from `process.env`;
   *   2. computes `adaptedTimeoutMs = baseMs * Σ(active costMultipliers)`
   *      clamped to 30 min, and uses that as the per-attempt deadline;
   *   3. runs up to `maxAttempts` attempts, classifying each `InstanceResult`
   *      and retrying ONLY transient outcomes (empty-patch / infra-fail).
   *   4. stamps `result.budget` with the per-attempt history.
   *
   * `maxAttempts === 1` is byte-identical to the pre-feature single-pass
   * path EXCEPT that `budget` is recorded. To keep the JSON report
   * byte-identical, the wrapper omits `budget` when neither adaptive nor
   * retry produced a non-baseline value.
   *
   * The wrapper layer is ON TOP of Best-of-N (`apps/bench/index.ts`'s
   * `resolveInstance`) — each retry attempt is itself a full Best-of-N
   * round.
   */
  measurementStability?: {
    /** Max retries on transient outcome (1 = no retry, byte-identical). */
    maxAttempts?: number
    /** Custom retry policy (default: `DEFAULT_POLICY` — only empty-patch +
     *  infra-fail are retried). */
    policy?: RetryPolicy
  }
}

/** Solve directive for real SWE-bench tasks, grounded in observed 0/5 failure
 *  modes: full-file rewrites → 180KB diffs that break PASS_TO_PASS; agents
 *  editing tests/ (discarded by the source-only grader); plausible-but-wrong
 *  fixes with no verification loop. Appended to the task message only when
 *  `instance.swebench` is set (custom-corpus runs unaffected). */
const SWEBENCH_DIRECTIVE = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Reproduce first: from the issue, construct the concrete failing scenario",
  "  (the exact input/call the issue describes) and confirm it currently",
  "  misbehaves before you edit.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- MANDATORY before you stop: after your final edit, run the repository's",
  "  existing test(s) most specific to the changed code AND your reproduction",
  "  of the issue. If anything fails, iterate. Do NOT stop right after an edit",
  "  without running tests — an unverified edit is the #1 cause of failure.",
  "- Keep the final diff minimal and isolated to the fix.",
].join("\n")

/**
 * BENCH-INTENTIONAL OPT-OUTS (Codex absorption Phases 0-8 + Round 3):
 * the SWE-bench grader is byte-sensitive (the official Python harness diffs
 * the agent's patch against the reference), so the bench harness deliberately
 * omits every optional Codex-absorption knob below. The agent runs in the
 * *plainest possible posture* — only the cache lever (ADR-0004), compaction
 * (ADR-0011), and `verifyGuard` (ADR-0013, when explicitly enabled by the
 * caller) are touched. The omissions are NOT oversight; reintroducing them
 * would change measurement integrity:
 *
 *   - `mode`             — bench is plain "default" (no plan/review/audit
 *                          posture forcing); the agent's task is the diff,
 *                          not the report shape.
 *   - `repoRules`        — sandbox repo's own `CONTRIBUTING.md`/etc. is not
 *                          loaded as agent authority; bench measures the
 *                          agent's intrinsic skill, not its rule-reading.
 *   - `hitl`             — bench is unattended (`acceptEdits` permission);
 *                          a HITL gate would deadlock on every confirm.
 *   - `closeoutGuard`    — closeout reminders shape report text, not patch
 *                          contents; bench measures patches.
 *   - `workingState`     — L3 scratchpad rides the reminder and changes the
 *                          turn-context bytes; bench keeps a stable prompt.
 *   - `skills`           — skill discovery + active-skills block likewise
 *                          shifts the per-turn reminder.
 *
 * Opt-in flags added (A/B measurement; default-OFF preserves byte-identity):
 *   - QUANTA_BENCH_LSP=1            wire LSP nav tools (OR with QUANTA_LSP_TOOLS=full)
 *   - QUANTA_BENCH_SUBAGENT=1       wire `subagent` AgentConfig block
 *   - QUANTA_BENCH_SKILLS=1         wire `skills` AgentConfig block (bundled-only)
 *   - QUANTA_BENCH_BRANCH_SEARCH=K  wire `branchSearch` AgentConfig block with
 *                                   `defaultN=K` (Agentless N-best, ADR-0084).
 *                                   K must be an integer >= 2 (1-best ≡ baseline
 *                                   ⇒ ignored; non-integer / NaN / negative /
 *                                   garbage ⇒ ignored). Cost scales ~K× vs
 *                                   baseline — keep OFF unless measuring N-best.
 *                                   NOT auto-enabled for `instance.swebench` —
 *                                   explicit opt-in only (cost discipline).
 *  See {@link benchOptIns} (just below) for the resolver — the BENCH-INTENTIONAL
 *  posture is unchanged when all four are unset. If a future bench mode wants
 *  any of the other listed knobs, add another opt-in flag — do NOT remove this
 *  comment block without an accompanying measurement-integrity ADR.
 */

/** Per-branch verify budget for bench branch_search (60s — same shape as the
 *  IDE preset; bench is unattended but each candidate's own `runAgent` carries
 *  the dominant timeout via `deps.timeoutMs`, this only caps each shell-out
 *  verifier inside the slice). */
const BENCH_BRANCH_TIMEOUT_MS = 60_000

/** Parse `QUANTA_BENCH_BRANCH_SEARCH` to a positive integer K>=2. Returns
 *  `undefined` for every other shape (absent / `"0"` / `"1"` / negative /
 *  non-integer / NaN / garbage / empty / whitespace) — the gate is *strict*
 *  by design (K=1 is byte-identical to baseline, so wiring it would only add
 *  overhead without measurement effect). Exported for direct unit + hellgate.
 *
 *  No heuristics: K bounds match the slice's own `tool.ts` zod schema
 *  (`.min(2).max(8)`). K>8 is rejected here too so a misconfigured env can't
 *  cause the model to emit a request the tool would reject at runtime. */
export const parseBenchBranchSearchK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  // Trim whitespace; empty after trim ⇒ unset.
  const s = raw.trim()
  if (s === "") return undefined
  // Reject if the trimmed string contains any internal whitespace (e.g.
  // "1 2"), or anything that isn't a leading optional sign + digits.
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  // K<2 ⇒ 1-best ≡ baseline; K>8 ⇒ matches slice's hard cap (tool.ts zod
  // `.min(2).max(8)`). Out-of-range ⇒ ignored (don't silently clamp).
  if (n < 2 || n > 8) return undefined
  return n
}

/** SWE-bench A/B opt-in resolver. EVERY flag default-OFF; an unset env yields
 *  `{ lspNav:false, subagent:undefined, skills:undefined, branchSearch:undefined }`
 *  and `buildConfig` is byte-identical to the BENCH-INTENTIONAL posture above.
 *  Exported for direct unit testing — four independent env reads, no
 *  cross-coupling.
 *
 *  Slice-isolation choice: the CLI has cousins (`buildSubagentConfig` /
 *  `buildSkillsConfig` in `src/apps/cli/internal.ts`) but they read DIFFERENT
 *  env keys (`QUANTA_SUBAGENT` / `QUANTA_SKILLS_DIR` + a `--skills` argv
 *  check). Bench needs its OWN bench-only gate so a `QUANTA_SUBAGENT=1`
 *  exported in a dev shell does NOT silently leak into measurement runs.
 *  Inline duplication is intentional: ~3 lines per builder, isolated test
 *  surface, no `apps/bench → apps/cli` import dependency. */
/**
 * Issue-hint mode resolved from `QUANTA_BENCH_ISSUE_HINT`:
 *   - `"off"`       — flag unset OR value not in the accept-list. Default-OFF
 *                     posture: byte-identical to the pre-feature path.
 *   - `"regex"`     — `=1` / `=on`. The legacy regex extractor
 *                     (`extractIssueHint` + `composeIssueHint`) runs synchronously
 *                     inside `buildConfig`. Pre-existing behavior — kept stable.
 *   - `"agentless"` — `=agentless`. The new LLM-driven path (Agentless paper
 *                     Stage 1). Async pre-compute via `prepareIssueHint`; on any
 *                     failure the wiring falls back to `regex`.
 *
 * Strict accept-list — anything else (`true`, `yes`, garbage) ⇒ `off`. */
export type IssueHintMode = "off" | "regex" | "agentless"

export const benchOptIns = (): {
  lspNav: boolean
  subagent: AgentConfig["subagent"] | undefined
  skills: AgentConfig["skills"] | undefined
  localizePhase: AgentConfig["localizePhase"] | undefined
  branchSearch: BranchSearchConfig | undefined
  issueHint: boolean
  /** Resolved tri-state. `"off"` ⇒ flag unset/unknown; `"regex"` ⇒ `1`/`on`;
   *  `"agentless"` ⇒ `agentless`. The legacy boolean `issueHint` above
   *  remains for back-compat with the wiring tests; `issueHintMode` is the
   *  forward-looking field used by `prepareIssueHint`. */
  issueHintMode: IssueHintMode
  /** Opt-in toggle for the expected/actual extractor. Default false; only
   *  true when `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1|on`. Independent
   *  of `issueHintMode` — can be set even when the parent gate is off (in
   *  which case it has no effect because no hint runs at all). */
  issueHintExpectedActual: boolean
} => {
  // ADR-0015 LSP-nav: original gate `QUANTA_LSP_TOOLS=full` (same as CLI) OR
  // the new bench-only gate `QUANTA_BENCH_LSP=1`. Either one ⇒ tools wired.
  const lspNav = process.env.QUANTA_LSP_TOOLS === "full" || process.env.QUANTA_BENCH_LSP === "1"
  // Subagent: bench-only `QUANTA_BENCH_SUBAGENT=1`. Empty block ⇒ runner default
  // applies (no per-bench maxDepth tuning — keep the surface minimal until a
  // measured reason appears).
  const subagent: AgentConfig["subagent"] | undefined =
    process.env.QUANTA_BENCH_SUBAGENT === "1" ? {} : undefined
  // Skills: bench-only `QUANTA_BENCH_SKILLS=1`. Empty block ⇒ bundled system
  // skills ONLY (ADR-0045) — bench never points at a user dir (measurement
  // integrity). `changedPaths` is left unset (full inventory).
  const skills: AgentConfig["skills"] | undefined =
    process.env.QUANTA_BENCH_SKILLS === "1" ? {} : undefined
  // Localize-phase (Agentless absorption — Tier 0): bench-only
  // `QUANTA_BENCH_LOCALIZE_PHASE=<int>`. The value is the number of leading
  // turns to block mutating tools. Domain: positive integer 1..20 (cap is a
  // measurement-integrity guard; >20 would force pure-exploration on a
  // maxTurns=30 SWE-bench run and starve the repair phase). Any other value
  // (absent, 0, negative, NaN, >20, non-integer) ⇒ `undefined` (guard OFF).
  // NOT auto-activated for `instance.swebench` — over-correction risk; opt-in
  // is explicit.
  const localizePhase = parseLocalizePhaseEnv(process.env.QUANTA_BENCH_LOCALIZE_PHASE)
  // ADR-0084 branch-search (Agentless N-best, K candidates). Strict integer
  // gate (see parseBenchBranchSearchK); K<2 / non-integer / out-of-range ⇒
  // undefined (key omitted by buildConfig, byte-identical to baseline).
  // Verifier kinds: ["tsc"] — the slice's natural fallback. Isolation: "tmpdir"
  // — bench sandboxes from createSandbox may not be git repos. NOT auto-enabled
  // for instance.swebench — explicit opt-in only (K× cost discipline).
  const k = parseBenchBranchSearchK(process.env.QUANTA_BENCH_BRANCH_SEARCH)
  const branchSearch: BranchSearchConfig | undefined =
    k !== undefined
      ? {
          defaultN: k,
          defaultVerifierKinds: ["tsc"],
          timeoutPerBranchMs: BENCH_BRANCH_TIMEOUT_MS,
          isolation: "tmpdir",
        }
      : undefined
  // Issue-text hint injection (Agentless paper, localization +5pp).
  //
  // Verbatim-evidence policy (post-upgrade): when on, the `regex` mode emits
  // VERBATIM extracted evidence (code fence bodies, traceback blocks, errors
  // with `: message` tails, refs) rather than count-summaries. The flag
  // accept-list itself is unchanged.
  //
  //   - `1` / `on`         ⇒ regex extractor (verbatim-evidence format)
  //   - `agentless`        ⇒ LLM-driven Stage-1 localization (Agentless paper)
  //   - anything else      ⇒ off (default OFF preserves byte-identical
  //                              measurement until explicit opt-in)
  const v = process.env.QUANTA_BENCH_ISSUE_HINT
  const issueHintMode: IssueHintMode =
    v === "agentless" ? "agentless" : v === "1" || v === "on" ? "regex" : "off"
  // Back-compat: the old `issueHint` boolean stays true for BOTH `regex` and
  // `agentless` modes (anything that produces a non-empty hint block).
  const issueHint = issueHintMode !== "off"
  // Expected/Actual extraction is gated SEPARATELY (false-positive-prone in
  // prose). Default-OFF even when parent issueHint is enabled. Accept-list:
  // `1` / `on` only.
  const eaRaw = process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL
  const issueHintExpectedActual = eaRaw === "1" || eaRaw === "on"
  return {
    lspNav,
    subagent,
    skills,
    localizePhase,
    branchSearch,
    issueHint,
    issueHintMode,
    issueHintExpectedActual,
  }
}

/** Pure parser for the `QUANTA_BENCH_LOCALIZE_PHASE` env var. Exported for
 *  direct unit testing — keeps the resolver above one-line readable.
 *
 *  Domain (ACTIVE):
 *    - The string parses to a finite integer N in [1, 20] ⇒ `{ phase1Turns: N }`.
 *
 *  Domain (INACTIVE, all return `undefined`):
 *    - absent / empty string
 *    - non-numeric ("garbage", "1.5", "abc")
 *    - 0 / negative / NaN / Infinity
 *    - > 20 (measurement-integrity cap)
 *
 *  Closed parser: explicit `Number.isFinite` + `Number.isInteger` checks (no
 *  `parseInt`-then-coerce that would silently swallow "1abc" as 1). */
export const parseLocalizePhaseEnv = (
  raw: string | undefined,
): AgentConfig["localizePhase"] | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  // Use Number(...) (NOT parseInt) so "1abc" / "1.5" cleanly become NaN /
  // non-integer and fail the validity check — no partial-parse foot-gun.
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 1) return undefined
  if (n > 20) return undefined
  return { phase1Turns: n }
}

/** Source file extensions enumerated for Agentless localization. The set
 *  matches Agentless paper §4 (Python is the SWE-bench corpus; we additionally
 *  include common companion languages for non-SWE-bench harnesses). Tests are
 *  excluded by directory walk (see `isExcludedDir`) — the grader supplies its
 *  own tests, so test-file localization is wasted budget. */
const SOURCE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
])

/** Directories that NEVER contain source code we want the LLM to consider:
 *    - `test`/`tests`              — grader supplies its own; agent edits are
 *                                    discarded (see SWEBENCH_DIRECTIVE)
 *    - `node_modules`/`vendor`/etc — third-party
 *    - `.git`/`.venv`/`__pycache__`— infra noise
 *    - `dist`/`build`/`target`     — build artifacts */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "test",
  "tests",
  "testing",
  "__tests__",
])

/** Hard cap on the file-tree walk — defensive against pathological repos.
 *  Above this we stop walking and return whatever we collected. */
const MAX_WALK_FILES = 5_000

/** Enumerate source-file relative paths under `repoRoot`. Excludes tests,
 *  build artifacts, and version-control infra. Pure-ish (does I/O via
 *  `readdirSync` only — that is the contract of the function, called inside
 *  `prepareIssueHint`'s fileTree dep). Returns an empty array on any thrown
 *  syscall (repo doesn't exist, permission denied, …); the caller falls back
 *  to regex extraction in that case. */
/** Classify one directory entry as either a child-dir-to-descend, a source-
 *  file relative path, or nothing-of-interest. Pure helper — splitting it
 *  out keeps `enumerateRepoSources` under biome's complexity ceiling. */
const classifyDirent = (
  e: Dirent,
  dir: string,
  repoRoot: string,
): { kind: "dir"; path: string } | { kind: "file"; rel: string } | undefined => {
  const name = e.name
  if (typeof name !== "string" || name.length === 0) return undefined
  const full = join(dir, name)
  if (e.isDirectory()) {
    if (EXCLUDED_DIRS.has(name)) return undefined
    // Hidden dirs (starting with ".") are infra (`.git`, `.cache`, …) — never
    // descend; SOURCE_EXTENSIONS doesn't gain anything from them.
    if (name.startsWith(".")) return undefined
    return { kind: "dir", path: full }
  }
  if (!e.isFile()) return undefined
  const dot = name.lastIndexOf(".")
  if (dot === -1) return undefined
  const ext = name.slice(dot)
  if (!SOURCE_EXTENSIONS.has(ext)) return undefined
  // Relative path — normalize separators to forward-slash so paths match what
  // the LLM sees in GitHub-style issue text.
  const rel = relative(repoRoot, full).split(sep).join("/")
  if (rel.length === 0) return undefined
  return { kind: "file", rel }
}

export const enumerateRepoSources = (repoRoot: string): string[] => {
  const out: string[] = []
  const stack: string[] = [repoRoot]
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[]
    try {
      // `withFileTypes: true` + string encoding returns Dirent<string>[];
      // the Node typings ship Dirent<Buffer | string> generics, so we
      // annotate explicitly to keep TS happy on every Node 20+ version.
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      continue
    }
    for (const e of entries) {
      const c = classifyDirent(e, dir, repoRoot)
      if (c === undefined) continue
      if (c.kind === "dir") stack.push(c.path)
      else out.push(c.rel)
    }
  }
  return out
}

export interface PrepareIssueHintDeps {
  /** Bench's main LLM port. The Agentless localizer reuses it (no separate
   *  cheaper-model wiring — adds one ~800-token call per instance, which is
   *  negligible against a 30-turn agent budget). */
  readonly llm: LLMPort
  /** Override for `enumerateRepoSources` — tests inject a deterministic
   *  fileTree. Production wiring uses `enumerateRepoSources(sandbox)`. */
  readonly fileTree?: () => Promise<string[]>
  /** Override for the localizer itself — tests inject a mock that returns a
   *  predetermined `AgentlessLocalizeResult`. Production wiring uses the real
   *  `agentlessLocalize`. */
  readonly localize?: (
    problemStatement: string,
    deps: AgentlessLocalizeDeps,
  ) => Promise<AgentlessLocalizeResult>
  /** Soft timeout (ms) for the LLM localization call. On expiry the wiring
   *  falls back to the regex extractor. Default 30_000. */
  readonly timeoutMs?: number
}

const DEFAULT_PREPARE_TIMEOUT_MS = 30_000

/** Compute the hint string to PREPEND onto the user message, deciding
 *  between the new Agentless LLM path and the legacy regex path based on
 *  `mode`.
 *
 *    - mode `"off"`          ⇒ empty string (byte-identical sentinel)
 *    - mode `"regex"`        ⇒ legacy synchronous extractor (byte-identical
 *                              with the pre-feature single-arg buildConfig)
 *    - mode `"agentless"`    ⇒ async LLM localization. On any failure
 *                              (timeout, stream error, zero files in tree,
 *                              empty parse result) falls back to regex —
 *                              i.e. the worst case of agentless mode is
 *                              still a non-degenerate hint.
 *
 *  This function never throws — every failure path lands on a regex
 *  fallback (or `""` when regex also returns empty). */
export const prepareIssueHint = async (
  instance: Instance,
  sandbox: string,
  mode: IssueHintMode,
  deps: PrepareIssueHintDeps,
): Promise<string> => {
  if (mode === "off") return ""
  const opt = benchOptIns()
  const extractOpts = { withExpectedActual: opt.issueHintExpectedActual }
  if (mode === "regex") {
    return composeIssueHint(extractIssueHint(instance.problemStatement, extractOpts))
  }
  // mode === "agentless"
  const regexFallback = (): string =>
    composeIssueHint(extractIssueHint(instance.problemStatement, extractOpts))
  // Empty problem statement ⇒ regex also yields "" ⇒ byte-identical.
  if (typeof instance.problemStatement !== "string" || instance.problemStatement.length === 0) {
    return regexFallback()
  }
  const fileTree = deps.fileTree ?? (async () => enumerateRepoSources(sandbox))
  const localize = deps.localize ?? agentlessLocalize
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<AgentlessLocalizeResult>((resolve) => {
    timer = setTimeout(() => resolve({ files: [], rationales: [], rawResponse: "" }), timeoutMs)
  })
  let result: AgentlessLocalizeResult
  try {
    result = await Promise.race([
      localize(instance.problemStatement, { llm: deps.llm, fileTree }),
      timeoutP,
    ])
  } catch {
    // localize threw (the function itself catches; this is belt-and-braces)
    return regexFallback()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (result.files.length === 0) {
    // Localize gave up — fall back to regex so the bench still gets SOME
    // hint when an issue body contains explicit paths.
    return regexFallback()
  }
  return composeAgentlessHint(result)
}

/**
 * Parse `QUANTA_BENCH_REPRO_TEST` to a positive integer K in [1, 40] (the
 * paper's upper bound). Returns `undefined` for every other shape (absent /
 * `"0"` / negative / non-integer / NaN / garbage / empty / whitespace) — the
 * gate is *strict* by design (K=0 is byte-identical to baseline, so wiring
 * it would only add overhead without measurement effect).
 *
 * Exported for direct unit + hellgate.
 *
 * Domain choices:
 *   - K>=1 — paper's `1` means greedy-only; we accept it (no temperature
 *     knob in our `LLMPort`, so K=1 is meaningful but the majority-vote
 *     degenerates).
 *   - K<=40 — paper cap; >40 is rejected to bound LLM cost.
 */
export const parseBenchReproTestK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 40) return undefined
  return n
}

export interface PrepareReproTestDeps {
  /** Bench's main LLM port. Reused (no separate model wiring — adds ~K
   *  small calls per instance, bounded by `parseBenchReproTestK`). */
  readonly llm: LLMPort
  /** Override for the generator. Tests inject a deterministic K-stream;
   *  production uses {@link generateReproTests}. */
  readonly generate?: typeof generateReproTests
  /** Override for the executor. Tests inject a Map-backed mock; production
   *  wraps `execArgv` + a file-write port. */
  readonly execute?: typeof executeReproTests
  /** Override for the selector. Tests can swap to deterministic; production
   *  uses {@link selectReproTest}. */
  readonly select?: typeof selectReproTest
  /** Injected file writer for the candidate scripts. Production wraps
   *  `Bun.write`; tests inject a Map-backed shim. */
  readonly writeFile?: ReproWriteFilePort
  /** Injected exec port. Production: `execArgv` from `./exec.ts`. */
  readonly exec?: ReproExecPort
}

/** Per-instance reproduction-script filename written into the sandbox. The
 *  agent's user message references this exact path. The leading underscore
 *  is intentional — keeps the script at the top of `ls` so the agent sees
 *  it without scanning. */
export const REPRO_FILE_NAME = "reproduce_issue.py"

/** User-message line appended (before the existing base text) when a repro
 *  test was successfully selected. Verbatim contract — the agent sees this
 *  exact string. */
export const REPRO_HINT_MESSAGE = [
  "A reproduction script has been placed at `reproduce_issue.py` in the sandbox.",
  "After your fix, run `python reproduce_issue.py` — it must print exactly",
  '"Issue resolved". If it prints anything else ("Issue reproduced",',
  '"Other issues", or nothing), your fix is incorrect and you must iterate.',
].join("\n")

/**
 * Pre-agent reproduction-test generation + selection + sandbox install.
 *
 * Returns the selected test source (to be saved as `reproduce_issue.py`)
 * and the full selection record. Returns `null` when:
 *   - K is absent / invalid (env-gate)
 *   - the instance has no problem statement
 *   - every sample's outcome was non-"reproduced" (LLM couldn't synthesise
 *     a working reproducer)
 *
 * The function NEVER throws; on internal failure (LLM stream error, exec
 * exception) the worst outcome is `null` and the agent runs without the
 * hint — byte-identical to the K=undefined path.
 */
export const prepareReproTest = async (
  instance: Instance,
  sandbox: string,
  k: number | undefined,
  deps: PrepareReproTestDeps,
): Promise<ReproTestSelection | null> => {
  if (k === undefined || k < 1) return null
  if (typeof instance.problemStatement !== "string" || instance.problemStatement.length === 0) {
    return null
  }
  const config: ReproTestConfig = { samples: k }
  const generate = deps.generate ?? generateReproTests
  const execute = deps.execute ?? executeReproTests
  const select = deps.select ?? selectReproTest
  const execPort = deps.exec ?? execArgv
  const writeFile =
    deps.writeFile ??
    (async (path: string, content: string): Promise<void> => {
      await Bun.write(path, content)
    })
  let tests: readonly string[]
  try {
    tests = await generate({ issue: instance.problemStatement, llm: deps.llm, config })
  } catch {
    return null
  }
  if (tests.length === 0) return null
  let samples: Awaited<ReturnType<typeof executeReproTests>>
  try {
    samples = await execute({
      tests,
      repoRoot: sandbox,
      exec: execPort,
      writeFile,
      config,
    })
  } catch {
    return null
  }
  const selection = select(samples)
  return selection
}

/**
 * Wire `prepareReproTest` + `Bun.write` into a single `runInstance` helper.
 * Default-OFF: when `QUANTA_BENCH_REPRO_TEST` is unset/invalid OR no candidate
 * reproduces, returns `undefined` — the agent runs without the hint
 * (byte-identical to the pre-feature path).
 *
 * Extracted from `runInstance` to keep its cognitive complexity under the
 * biome ceiling. The wiring is exactly:
 *   K = parseBenchReproTestK(env)
 *   if K invalid ⇒ undefined
 *   selection = prepareReproTest(K)
 *   if no selection ⇒ undefined
 *   write `<sandbox>/reproduce_issue.py` ⇒ on success return REPRO_HINT_MESSAGE
 *   on disk write failure ⇒ undefined (byte-identical to K-unset)
 */
const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
): Promise<string | undefined> => {
  const reproK = parseBenchReproTestK(process.env.QUANTA_BENCH_REPRO_TEST)
  if (reproK === undefined) return undefined
  const selection = await prepareReproTest(instance, sandbox, reproK, { llm })
  if (selection === null || selection.selected === null) return undefined
  try {
    await Bun.write(`${sandbox}/${REPRO_FILE_NAME}`, selection.selected)
    return REPRO_HINT_MESSAGE
  } catch {
    return undefined
  }
}

/**
 * Pure composer for the repro-hint block placement.
 *
 * Agent prompt order (top → bottom):
 *   <issue-hint>             (optional, default-OFF)
 *   <REPRO_HINT_MESSAGE>     (optional, default-OFF — this slice)
 *   <base task>
 *   <SWEBENCH_DIRECTIVE>     (already inside baseText for swebench instances)
 *   <seedMsg>                (only on repair rounds ≥1, appended by caller)
 *
 * Inputs:
 *   - `hint`        — issue-hint block (`""` when default-OFF)
 *   - `hintedBase`  — `hint + "\n\n" + baseText` when hint non-empty; else
 *                     `baseText`. Caller pre-computes (this preserves the
 *                     byte-identical pre-feature path when reproHint is "").
 *   - `baseText`    — the raw base task text (with SWEBENCH_DIRECTIVE).
 *   - `reproHint`   — the repro directive line, or `undefined` / `""` to skip.
 *
 * Returns:
 *   - `hintedBase` (byte-identical to pre-feature) when reproHint is empty.
 *   - `${hint}\n\n${reproHint}\n\n${baseText}` when hint present + repro
 *     present.
 *   - `${reproHint}\n\n${baseText}` when only repro present.
 *
 * Extracted to keep `buildConfig`'s cognitive complexity under the biome
 * ceiling. Pure — exported for direct unit testing.
 */
export const composeWithReproHint = (
  hint: string,
  hintedBase: string,
  baseText: string,
  reproHint: string | undefined,
): string => {
  if (reproHint === undefined || reproHint === "") return hintedBase
  if (hint !== "") return `${hint}\n\n${reproHint}\n\n${baseText}`
  return `${reproHint}\n\n${baseText}`
}

export const buildConfig = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  stream: StreamPort,
  seedMsg?: string,
  /**
   * Pre-computed issue-hint text (Agentless async path). When provided AND
   * non-empty, replaces the synchronous regex path entirely — buildConfig
   * does not re-run extraction. `""` (empty string) is treated the same as
   * undefined (no hint section emitted) so the byte-identical contract for
   * "extraction yielded nothing" is preserved across both code paths.
   *
   * Production wiring: `prepareIssueHint` computes this BEFORE the agent
   * runs (async LLM call) and threads it through `runAgentOnce`/Phase. Tests
   * that exercise buildConfig directly without async setup pass undefined.
   */
  precomputedHint?: string,
  /**
   * Pre-computed reproduction-script hint line (Agentless §3.3.1 absorption).
   * When provided AND non-empty, the line is prepended to the user message
   * BELOW any `precomputedHint` block but ABOVE the base task description.
   * Absent / `""` ⇒ no hint injection (byte-identical to the pre-feature
   * path).
   *
   * Production wiring: `prepareReproTest` selects a candidate before the
   * agent runs, writes it to `<sandbox>/reproduce_issue.py`, and threads the
   * verbatim {@link REPRO_HINT_MESSAGE} through here.
   */
  reproHint?: string,
) => {
  // ADR-0015 LSP-nav: opt-in via `QUANTA_LSP_TOOLS=full` (same gate as CLI) OR
  // the bench-only `QUANTA_BENCH_LSP=1`. When the language-server binary
  // (`pyright-langserver` / `typescript-language-server`) is absent the
  // per-call probe in `lsp-bridge` makes the tools emit a clean `ok:false` —
  // registration is harmless without a server. Default-OFF preserves
  // byte-identical bench behavior.
  const opt = benchOptIns()
  const lspNavTools = opt.lspNav ? lspNavToolList() : []
  // DIP factory: bench driver runs against the default port surface; the
  // per-instance sandbox is enforced by cwd, not by injected fs ports.
  const registry = new ToolRegistry([...buildDefaultTools(), ...lspNavTools])
  const permission: PermissionContext = { mode: "acceptEdits" }
  const base = `${instance.problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
  // Default behavior (no seedMsg) is byte-identical to the pre-b2 prompt: the
  // user message is `base` (+ SWEBENCH_DIRECTIVE for swebench instances). A
  // seedMsg ⇒ appended after a blank line ONLY for repair rounds ≥1.
  const baseText = instance.swebench ? `${base}${SWEBENCH_DIRECTIVE}` : base
  // Hint injection (default-OFF; opt-in via `QUANTA_BENCH_ISSUE_HINT`).
  //   - mode `"regex"` (legacy)     ⇒ synchronous regex extractor here
  //   - mode `"agentless"` (new)    ⇒ pre-computed by `prepareIssueHint`,
  //                                    threaded in via `precomputedHint`
  //   - mode `"off"`                ⇒ empty hint (byte-identical)
  // When `precomputedHint` is provided (any non-undefined value, including
  // `""`), the Agentless pre-compute already ran; we honor it verbatim and do
  // NOT re-extract. Empty pre-computed hint ⇒ "" ⇒ byte-identical.
  const hint =
    precomputedHint !== undefined
      ? precomputedHint
      : opt.issueHintMode === "regex"
        ? composeIssueHint(
            extractIssueHint(instance.problemStatement, {
              withExpectedActual: opt.issueHintExpectedActual,
            }),
          )
        : ""
  const hintedBase = hint !== "" ? `${hint}\n\n${baseText}` : baseText
  // Repro-test hint composition (Agentless §3.3.1). Default-OFF
  // (undefined / "") ⇒ byte-identical to the pre-feature path.
  const withRepro = composeWithReproHint(hint, hintedBase, baseText, reproHint)
  const text = seedMsg !== undefined && seedMsg !== "" ? `${withRepro}\n\n${seedMsg}` : withRepro
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text }],
    },
  ]
  return {
    llm: deps.llm,
    registry,
    stream,
    permission,
    messages,
    system: buildSystemPrompt(sandbox),
    cwd: sandbox,
    maxTurns: deps.maxTurns,
    signal,
    onConfirm: async () => false,
    // Real SWE-bench repos blow the context window over a long trajectory.
    // Enable proactive + reactive compaction (RFC §8 / ADR-0004 robustness):
    // without this, large-repo instances PTL-die instead of compacting.
    compaction: {},
    // Verify-guard (ADR-0013): observed bench failure — agent edits a
    // source file then declares "done" with 0 verification → wrong fix ships.
    // Gated exactly like SWEBENCH_DIRECTIVE (real SWE-bench only; custom-corpus
    // byte-identical). Absent ⇒ guard OFF, loop unchanged.
    //
    // mustPass (outcome-gate) extension — sanity runs with skills/subagent ON
    // showed the model can call `test_runner`, receive `ok:false`, and STILL
    // declare "done"; the presence-only guard accepts the call as "verified"
    // because it ran. mustPass = ALSO require the verify to PASS. maxTrips=2
    // gives one budget slot per branch (presence + must-pass) so a single run
    // can hit both before the cap; SWE-bench prioritizes measurement integrity
    // over the over-correction risk that motivated DEFAULT_MAX_TRIPS=1.
    ...(instance.swebench ? { verifyGuard: { mustPass: true, maxTrips: 2 } } : {}),
    // Bench A/B opt-ins (default-OFF; all unset ⇒ keys omitted entirely,
    // exactOptionalPropertyTypes-friendly, AgentConfig byte-identical).
    ...(opt.subagent !== undefined ? { subagent: opt.subagent } : {}),
    ...(opt.skills !== undefined ? { skills: opt.skills } : {}),
    ...(opt.localizePhase !== undefined ? { localizePhase: opt.localizePhase } : {}),
    ...(opt.branchSearch !== undefined ? { branchSearch: opt.branchSearch } : {}),
  }
}

interface Phase {
  patch: string
  turns: number
}

/**
 * Capture the agent's LAST `bash`/`test_runner` tool call argument by
 * wrapping a downstream `StreamPort` and intercepting `tool_call` events. Pure
 * tap: every event is forwarded unchanged; the bench can read `lastVerifyCmd`
 * after `runAgent` returns. For `bash`, `input.command` carries the shell
 * string; for `test_runner` the tool name itself counts as a verification — we
 * record the tool name (no command string is associated) so the validator can
 * still fall back to the agent's `reproPath` (or return degenerate).
 */
class LastVerifyCmdTap implements StreamPort {
  lastVerifyCmd: string | undefined
  constructor(private readonly downstream: StreamPort) {}
  emit(event: AgentEvent): void {
    if (event.type === "tool_call") {
      if (event.name === "bash") {
        const input = event.input
        if (typeof input === "object" && input !== null && "command" in input) {
          const cmd = (input as { command: unknown }).command
          if (typeof cmd === "string" && cmd !== "") this.lastVerifyCmd = cmd
        }
      } else if (event.name === "test_runner") {
        // test_runner has no shell-equivalent string; treat the tool-call name
        // as a sentinel so the orchestrator knows the agent DID verify (the
        // validator falls back to reproPath / degenerate when cmd is unset).
        this.lastVerifyCmd = "test_runner"
      }
    }
    this.downstream.emit(event)
  }
}

/**
 * Emit ONE `knobs_applied` event onto the given stream, carrying the
 * bench-surface knob posture resolved from `process.env`. Fail-soft: any
 * resolution error (a malformed env value that throws in `parse`) is caught
 * locally so a measurement run can never be aborted by a telemetry call. With
 * an empty registry the event still fires with `knobs:{}` and
 * `costMultiplier:0` (matrix budget contract: Σ(active) = 0 when none active).
 *
 * Cost computation: Σ of each ACTIVE knob's `costMultiplier` field (default 1
 * when the knob does not declare one). Matches the contract documented in
 * `tools/swebench-matrix.ts#estimateAxesCost` per-condition product is summed
 * across a sweep; here we project ONE condition (this run) so the sum is just
 * Σ over active knobs. A zero-cost return ⇒ no knob active.
 *
 * Default-OFF byte-identical: the only on-wire side effect is one `emit` call;
 * `NullStream.emit` is a no-op so a run without observation produces zero new
 * bytes (and the existing recorder maps the event onto the `recovery`
 * trajectory family, no new TrajectoryKind required).
 */
const emitKnobsApplied = (stream: StreamPort, envVars: NodeJS.ProcessEnv): void => {
  try {
    const state = resolveBenchKnobs({ envVars })
    const knobs = knobsForReport(state)
    let cost = 0
    for (const id of Object.keys(knobs)) {
      const knob = state.knobs.get(id)
      const m = knob?.costMultiplier
      cost += typeof m === "number" && m > 0 ? m : 1
    }
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs,
      preset: state.preset !== undefined ? state.preset : null,
      costMultiplier: cost,
    }
    stream.emit(event)
  } catch {
    // Telemetry must NEVER abort a bench run — a malformed env value that
    // throws in a knob's `parse` is a measurement-data concern, not a
    // run-correctness one. The error already surfaces via the next
    // `resolveBenchKnobs` call (e.g. `buildConfig` → `applyBenchKnobs`), so
    // we deliberately swallow here. The recorder receives no event in this
    // case (degenerate but safe — the report's `knobs` section still
    // captures the same posture at write time).
  }
}

/**
 * Run the agent ONCE in the sandbox (no git wrap — caller controls snapshot
 * boundaries). Returns the cumulative diff + turns + lastVerifyCmd captured
 * from the stream. Used both by the single-pass path and by the per-round
 * `runOnce` closure of the repair orchestrator (continue-from-patched-tree).
 *
 * The optional `precomputedHint` threads the Agentless pre-computed hint
 * through to `buildConfig`. When undefined, `buildConfig` falls back to the
 * legacy synchronous regex path (gated on `issueHintMode === "regex"`).
 */
const runAgentOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  seedMsg: string | undefined,
  timeoutMs: number,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
): Promise<RunOnceResult> => {
  const tap = new LastVerifyCmdTap(w.stream)
  // Knob telemetry (2026-05-26): emit ONE `knobs_applied` event per
  // runAgent invocation. In the repair orchestrator each round calls this
  // helper, so each round produces its own trajectory line (the env doesn't
  // change between rounds, so the lines are identical — useful as a
  // boundary marker).
  emitKnobsApplied(tap, process.env)
  const outcome = await runAgent(
    buildConfig(instance, deps, sandbox, signal, tap, seedMsg, precomputedHint, reproHint),
  )
  // Capture the cumulative diff CURRENTLY in the worktree (without resetting
  // the index): mirrors `withGitSnapshot`'s final diff step. `git` is
  // opportunistic — absence ⇒ "". T2: cache/build paths pruned at source.
  const patch = await gitStageAndDiffCached(sandbox, timeoutMs)
  const result: RunOnceResult = {
    patch,
    turns: outcome.turns,
    ...(tap.lastVerifyCmd !== undefined ? { lastVerifyCmd: tap.lastVerifyCmd } : {}),
  }
  return result
}

/** Sandbox snapshot → agent (inside the git pre/post-image) → captured diff. */
const runAgentPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
): Promise<Phase> => {
  let turns = 0
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      // Knob telemetry: emit once per phase entry (matches the contract
      // documented on `emitKnobsApplied`). The single-pass path bypasses
      // `runAgentOnce`, so the emit lives here directly.
      emitKnobsApplied(w.stream, process.env)
      const outcome = await runAgent(
        buildConfig(
          instance,
          deps,
          sandbox,
          signal,
          w.stream,
          undefined,
          precomputedHint,
          reproHint,
        ),
      )
      turns = outcome.turns
    },
  )
  return { patch, turns }
}

/**
 * Repair-path phase: ONE `withGitSnapshot` wraps ALL rounds (so the prior
 * round's edits persist into round N+1 — no `git reset/clean` between rounds).
 * The official `verify()` is NEVER invoked here — it runs ONCE outside, on the
 * cumulative final patch (no-leak invariant). The validator/buildContext are
 * injectable; production defaults are G1's `validate`/`buildRepairContext`.
 */
const runRepairPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const out = await runRepairRounds({
        config: { ...(repair.maxRounds !== undefined ? { maxRounds: repair.maxRounds } : {}) },
        problem: instance.problemStatement,
        runOnce: (seedMsg) =>
          runAgentOnce(
            instance,
            deps,
            sandbox,
            signal,
            w,
            seedMsg,
            deps.timeoutMs,
            precomputedHint,
            reproHint,
          ),
        validate: repair.validate ?? defaultValidate,
        buildContext: repair.buildContext ?? buildRepairContext,
        sandbox,
        exec,
        timeoutMs: deps.timeoutMs,
      })
      turns = out.turns
      finalPatch = out.patch
    },
  )
  // `patch` (from withGitSnapshot's final diff) is the canonical capture; if
  // available we prefer it (it reflects the worktree at end of all rounds).
  // `finalPatch` is the orchestrator's view of the last round's diff — they
  // agree by construction (continue-from-patched-tree, single sandbox).
  return { patch: patch !== "" ? patch : finalPatch, turns }
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
  extra: Partial<InstanceResult>,
): InstanceResult => ({
  id: instance.id,
  passed: v.passed,
  patch: phase.patch,
  turns: phase.turns,
  ...(v.error !== undefined ? { error: v.error } : {}),
  ...extra,
})

/**
 * Run one instance once: sandbox → (setup) → agent → verify → diff. Always
 * cleans up the temp dir. Never throws for an instance-level failure — it is
 * reported via `InstanceResult.error` with passed=false.
 *
 * Observability (RFC §8) is a pure add-on gated on `deps.observe`: absent ⇒
 * `NullStream`, byte-identical to before (no files written). Present ⇒ the
 * agent stream is Tee'd into a strict `JsonlRecorder` plus bench `sandbox`/
 * `patch_generated`/`verify` lines; a strict observation failure yields
 * `verdict:"degraded"` (excluded from `resolved/total`).
 *
 * Internal — `runInstance` (below) wraps this with the measurement-stability
 * retry loop. Exported as `runInstanceOnce` so tests can pin the single-pass
 * path independently of the retry wrapper.
 */
export const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    // T4 — per-instance env pre-preparation (fail-fast). When the instance
    // carries a `setupCmd`, run it in the sandbox copy BEFORE the agent. If
    // setup exits non-zero we fail-fast with a DISTINCT `env_prep_failed`
    // verdict and DO NOT run the agent — handing a half-prepared env to the
    // agent is exactly the failure this prevents.
    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) {
      return {
        id: instance.id,
        passed: false,
        patch: "",
        turns: 0,
        verdict: "env_prep_failed",
        error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
      }
    }

    // Pre-compute the issue-hint text. For mode `"off"` and `"regex"` this is
    // a cheap synchronous shortcut (regex path computed eagerly so the hint
    // string is byte-identical to the legacy in-buildConfig path). For mode
    // `"agentless"` an async LLM localization call runs here exactly ONCE
    // per instance, before any agent turn — repair rounds reuse the same
    // hint (the issue text doesn't change across rounds; re-asking the LLM
    // would just waste budget).
    const hintMode = benchOptIns().issueHintMode
    const precomputedHint = await prepareIssueHint(instance, sandbox, hintMode, { llm: deps.llm })

    // Repro-test (Agentless §3.3.1) — default-OFF; env-gated. See
    // `installReproTestHint` for details.
    const reproHint = await installReproTestHint(instance, sandbox, deps.llm)

    // b2 — Repair gating: ONLY when caller set `deps.repair` AND this is a
    // real SWE-bench instance (same posture as verifyGuard / SWEBENCH_DIRECTIVE).
    // ABSENT ⇒ existing single-pass path verbatim (byte-identical: same calls,
    // same buildConfig (no seedMsg), same single withGitSnapshot/runAgent,
    // same single verify()). The official verify() ALWAYS runs exactly once,
    // OUTSIDE the repair loop — its result is never fed back to the agent
    // (no-leak invariant; also enforced by code locality).
    //
    // When `hintMode === "off"`, `precomputedHint` is `""`; `buildConfig`
    // treats a defined-but-empty hint identically to undefined: no
    // injection. So the off-mode path is byte-identical to the pre-feature
    // pipeline (the legacy regex-on-`=1` path is also byte-identical
    // because `prepareIssueHint("regex")` returns the same string the
    // in-buildConfig regex would have produced).
    phase =
      deps.repair !== undefined && instance.swebench !== undefined
        ? await runRepairPhase(
            instance,
            deps,
            sandbox,
            abort.signal,
            w,
            deps.repair,
            precomputedHint,
            reproHint,
          )
        : await runAgentPhase(instance, deps, sandbox, abort.signal, w, precomputedHint, reproHint)
    const v = await verify(instance, phase.patch, sandbox, deps)

    const extra: Partial<InstanceResult> = {}
    if (deps.observe && w.observer) {
      extra.verdict = "ok"
      extra.durationMs = Date.now() - startedAt
      extra.patchPath = emitPatch(deps.observe, instance, w.observer, phase.patch)
      emitVerify(w.observer, v)
      const usage = w.usage?.total()
      if (usage) extra.usage = usage
    }
    return okResult(instance, phase, v, extra)
  } catch (e) {
    if (e instanceof ObservationError) {
      return {
        id: instance.id,
        passed: false,
        patch: phase.patch,
        turns: phase.turns,
        verdict: "degraded",
        error: `observation failed (strict): ${e.message}`,
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: (e as Error).message,
    }
  } finally {
    clearTimeout(deadline)
    w.observer?.close()
    await cleanupSandbox(sandbox)
  }
}

/** Project `AttemptOutcome` (the retry-policy enum) into `BenchAttemptOutcome`
 *  (the wire shape on `InstanceResult.budget`). Same union, mirrored here so
 *  the bench-types module doesn't have to depend on `retry-policy.ts`. */
const projectOutcome = (o: AttemptOutcome): BenchAttemptOutcome => {
  if (o.kind === "pass") return { kind: "pass" }
  if (o.kind === "empty-patch") {
    return o.reason !== undefined
      ? { kind: "empty-patch", reason: o.reason }
      : { kind: "empty-patch" }
  }
  if (o.kind === "timeout") return { kind: "timeout" }
  if (o.kind === "real-fail") return { kind: "real-fail", subkind: o.subkind }
  return { kind: "infra-fail", reason: o.reason }
}

/**
 * Public entry-point with measurement-stability wrapper.
 *
 * Flow:
 *   1. Resolve bench knob state from `process.env`. (Pure: closed-port read.)
 *   2. Compute the adaptive per-attempt timeout via `computeAdaptedTimeout`
 *      (= `baseMs * Σ(active knob costMultipliers)`, clamped to 30 min).
 *   3. Resolve `maxAttempts` (`deps.measurementStability?.maxAttempts` >
 *      `QUANTA_BENCH_RETRY_TRANSIENT` > 1).
 *   4. Run the retry loop: each iteration calls `runInstanceOnce` with deps
 *      whose `timeoutMs` is the ADAPTED value. Classify the result; stop on
 *      pass / real-fail / policy says stop.
 *   5. Stamp `result.budget` with the per-attempt history when adaptive OR
 *      retry produced a non-baseline value; otherwise omit (byte-identical
 *      JSON report shape).
 *
 * Byte-identical fence: when `maxAttempts === 1` (default) AND every active
 * knob's `costMultiplier <= 1` (i.e. `adaptedTimeoutMs === baseTimeoutMs`),
 * the wrapper:
 *   - calls `runInstanceOnce` EXACTLY ONCE with `deps.timeoutMs` unchanged;
 *   - does NOT stamp `result.budget` (omitted);
 *   - returns the same `InstanceResult` shape the legacy path would have.
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  // Resolve knob state for adaptive timeout. Fail-soft: any unexpected
  // throw in the resolver falls back to baseMs (byte-identical posture).
  let adaptedTimeoutMs = deps.timeoutMs
  const baseTimeoutMs = deps.timeoutMs
  try {
    const state = resolveBenchKnobs({ envVars: process.env })
    adaptedTimeoutMs = computeAdaptedTimeout(deps.timeoutMs, state)
    // computeAdaptedTimeout returns 0 for garbage baseMs; preserve the caller's
    // value in that case (the deadline timer will fire immediately, which is
    // the intended fail-fast posture).
    if (adaptedTimeoutMs === 0 && deps.timeoutMs > 0) adaptedTimeoutMs = deps.timeoutMs
  } catch {
    // Any resolution error ⇒ baseline posture. Telemetry concerns must
    // never fail a measurement run.
  }

  // Resolve maxAttempts. Precedence: deps.measurementStability.maxAttempts
  // (test seam) > QUANTA_BENCH_RETRY_TRANSIENT env > 1 (no retry).
  const envAttempts = parseRetryTransientEnv(process.env.QUANTA_BENCH_RETRY_TRANSIENT)
  const maxAttempts = Math.max(
    1,
    Math.floor(deps.measurementStability?.maxAttempts ?? envAttempts ?? 1),
  )
  const policy = deps.measurementStability?.policy ?? DEFAULT_POLICY

  // Adapted deps: only `timeoutMs` differs. All other fields are passed
  // through verbatim so each attempt sees the same agent / repair / observe
  // wiring. `measurementStability` is stripped so the inner call doesn't try
  // to recurse into the wrapper.
  const innerDeps: RunInstanceDeps = {
    llm: deps.llm,
    maxTurns: deps.maxTurns,
    timeoutMs: adaptedTimeoutMs,
    ...(deps.pythonSwebench !== undefined ? { pythonSwebench: deps.pythonSwebench } : {}),
    ...(deps.observe !== undefined ? { observe: deps.observe } : {}),
    ...(deps.repair !== undefined ? { repair: deps.repair } : {}),
  }

  // Byte-identical fast path: single attempt + adapted === base ⇒ run the
  // legacy single-pass and return without stamping `budget`. This is the
  // contract that keeps `QUANTA_BENCH_RETRY_TRANSIENT=1` + all-knobs-OFF
  // identical to the pre-feature wall-clock and JSON shape.
  if (maxAttempts === 1 && adaptedTimeoutMs === baseTimeoutMs) {
    return runInstanceOnce(instance, innerDeps)
  }

  const { result, loop } = await runRetryLoop(
    async () => runInstanceOnce(instance, innerDeps),
    maxAttempts,
    policy,
  )
  const budget = {
    baseTimeoutMs,
    adaptedTimeoutMs,
    attempts: loop.attempts,
    attemptOutcomes: loop.outcomes.map(projectOutcome),
  }
  return { ...result, budget }
}

/** Re-export the adaptive-timeout helpers so apps/bench's matrix budget tools
 *  can reuse the exact same projection. */
export { computeAdaptedTimeout, MAX_TIMEOUT_MS, sumCostMultipliers } from "./adaptive-timeout"
export type { BenchKnobState } from "./knobs-bench"
// Knob wiring helpers — re-exported for the report path + tests so callers
// don't have to import from two siblings.
export { applyBenchKnobs, knobsForReport, readKnobValue, resolveBenchKnobs } from "./knobs-bench"
export type { AttemptOutcome, RetryPolicy }
/** Re-export the classifier + policy types so apps/bench callers can wire
 *  custom policies (test seam) or inspect outcomes without reaching into the
 *  retry-policy sub-slice directly. */
// Re-export the observation usage tap so test fixtures and other internals can
// continue to use bench's typed surface unchanged.
export { BenchObserver, classifyOutcome, DEFAULT_POLICY, parseRetryTransientEnv, UsageTap }
