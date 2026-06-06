/**
 * `host/runtime/agent-args.ts` — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * ADR-0303 thin-surface relocation: moved DOWN out of `apps/agent/cli-args.ts`
 * into the `@/host/runtime` composition layer so every surface (the CLI
 * launcher `apps/agent` AND `apps/cli`'s `batch` subcommand) reaches DOWN into
 * `@/host` for this parser, never sideways into a sibling surface. The legacy
 * `apps/agent/cli-args.ts` is now a thin re-export shim over this module.
 *
 * Pure argv parser. Takes a `readonly string[]` (typically `process.argv.slice(2)`)
 * and produces a typed {@link AgentArgs} discriminated by `mode`. There is NO
 * I/O here, NO `process.env` reads, NO silent defaults — defaults flow from
 * `BUDGET_PRESETS` via `assembleAgentConfig`, never from this file.
 *
 * Propositional rules (NO heuristics, NO threshold-based "if too many args"
 * checks): a flag is either KNOWN or unknown; a value either starts with `--`
 * (treated as missing) or doesn't. Errors throw {@link AgentArgsError} so the
 * caller (`./index.ts`) can map to a usage exit code (`64 EX_USAGE`).
 *
 * Lever ownership: `mode + dials + exhaustion` route into `AssembleRequest`;
 * mode-specific positional fields (`prompt` / `corpus` / `instance` / `pr`)
 * are consumed by the corresponding `./mode-presets/<mode>.ts` worker.
 */

import type { BudgetDials, BudgetExhaustionPolicy, RunMode } from "@/agent"

// Alias for readability — `RunMode` from `@/agent` is the run-mode slice's
// closed `interactive|headless|batch|ci-bot` union. (The barrel also exports
// a SEPARATE `AgentMode` for plan/review submode; do not conflate.)
type AgentMode = RunMode

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/** Closed set of provider tokens accepted on `--provider`. */
export type ProviderToken = "openai" | "anthropic"

/** Parsed argv shape. `mode` is the discriminator; per-mode fields are
 *  validated against `mode` in {@link parseAgentArgs}. */
export interface AgentArgs {
  mode: AgentMode
  model?: string
  provider?: ProviderToken
  dials: Partial<BudgetDials>
  exhaustion?: BudgetExhaustionPolicy
  /** headless: `-p` / `--prompt` body. */
  prompt?: string
  /** batch: `--corpus <dir>`. */
  corpus?: string
  /** batch: `--instance <substr>`. */
  instance?: string
  /** batch: `--predictions <path>` — JSONL predictions output. */
  predictions?: string
  /** batch: `--report <path>` — JSON report output. */
  report?: string
  /** ci-bot: `--pr <num>` (kept as string — surface decides numeric shape). */
  pr?: string
  /** ci-bot: `--dry-run` — stub the PR-comment write (read the PR but do not
   *  post). Used for safe e2e validation. Absent ⇒ real post. */
  ciBotDryRun?: boolean
  /** `--help` / `-h` short-circuit. */
  help: boolean
  /** ADR-0236 — `--tool-profile <write|ask|minimal|code-only>`. When set, the
   *  composition root constructs a `defaultToolProfileResolver` and seeds
   *  `AgentConfig.toolProfile.defaultName` (ADR-0213). Absent ⇒ no profile
   *  layer, byte-identical to legacy. */
  toolProfile?: ToolProfileToken
  /** ADR-0236 — `--sticky-model`. When set, the composition root wires the
   *  fs-backed sticky-model store (ADR-0212) so the per-mode preference
   *  survives across sessions. Absent ⇒ slot omitted; global default model
   *  wins for every mode. */
  stickyModel?: boolean
  /** ADR-0236 — `--identity-mode <default|plan|review|audit|architect|editor>`.
   *  When set, the composition root builds the system prompt through the
   *  mode-variant registry (ADR-0211) for the given mode. The runtime
   *  AgentMode (the run-mode lever) is INDEPENDENT — this flag drives ONLY
   *  the prompt-side persona. Absent ⇒ legacy single-identity prompt. */
  identityMode?: IdentityModeToken
  /** ADR-0236 — `--focus-chain-every <N>`. When set (N > 0), the composition
   *  root constructs `defaultFocusChainTracker({ reinjectEveryN: N })` and
   *  wires {@link focusChain} (ADR-0219) so the loop ticks per turn and the
   *  rendered todo list re-injects every N turns. Absent ⇒ no tracker. */
  focusChainEvery?: number
  /** ADR-0236 — `--no-auto-background`. When present, the composition root
   *  forces `autoBackground` OFF even if a host default would wire it.
   *  Default behaviour today is already OFF; this flag is the explicit
   *  hard-OFF for hosts that DO wire it by default in a future round. */
  noAutoBackground?: boolean
  /** ADR-0293 — `--playbook-trigger`. When present, the CLI host's
   *  `maybeStartPlaybookTriggerWire` opts in to the inline-trigger watcher
   *  (ADR-0203 / ADR-0240) for the session. Env `QUANTA_PLAYBOOK_TRIGGER=on`
   *  has the same effect and WINS over a missing flag. Default-OFF: absent
   *  ⇒ no watcher, byte-identical to legacy. */
  playbookTrigger?: boolean
  /** Track A2 — `--permission-profile <default|restricted|trusted>`. When set,
   *  the composition root resolves the name through the named-profile registry
   *  (fail-closed: an unknown name is a hard startup error) and applies it via
   *  `TwoLayerManager.setPermissionProfileByName`. The env knob
   *  `QUANTA_PERMISSION_PROFILE` has the same effect; an explicit flag WINS over
   *  the env. Absent (no flag, no env) ⇒ no profile manager, byte-identical to
   *  legacy. */
  permissionProfile?: PermissionProfileToken
}

/** ADR-0236 — closed set of tool-profile names accepted on `--tool-profile`. */
export type ToolProfileToken = "write" | "ask" | "minimal" | "code-only"
/** ADR-0236 — closed set of identity modes accepted on `--identity-mode`.
 *  Aligned 1:1 with `ModeVariantKey` (ADR-0211). */
export type IdentityModeToken = "default" | "plan" | "review" | "audit" | "architect" | "editor"
/** Track A2 — closed set of named permission profiles accepted on
 *  `--permission-profile`. Mirror of the resolvable subset of the
 *  named-profile registry (`default | restricted | trusted`); `custom` is
 *  intentionally excluded (it denotes a caller-supplied struct, never a name). */
export type PermissionProfileToken = "default" | "restricted" | "trusted"

/** Parser-level error. `index.ts` catches this and emits usage + exit 64. */
export class AgentArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentArgsError"
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Closed enum constants — keep the source of truth here so a wrong literal
// at the CLI surface is a parser-level error, not a runtime AgentMode union
// crash downstream.
// ─────────────────────────────────────────────────────────────────────────

const VALID_MODES = ["interactive", "headless", "batch", "ci-bot", "ide", "daemon"] as const
const VALID_PROVIDERS = ["openai", "anthropic"] as const satisfies readonly ProviderToken[]
const VALID_EXHAUSTION = [
  "ask-user",
  "stop",
  "stop-with-summary",
  "emit-partial",
  "fail-run",
] as const satisfies readonly BudgetExhaustionPolicy[]

/** ADR-0236 — closed set for `--tool-profile`. */
const VALID_TOOL_PROFILES = [
  "write",
  "ask",
  "minimal",
  "code-only",
] as const satisfies readonly ToolProfileToken[]

/** ADR-0236 — closed set for `--identity-mode`. */
const VALID_IDENTITY_MODES = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
] as const satisfies readonly IdentityModeToken[]

/** Track A2 — closed set for `--permission-profile`. */
const VALID_PERMISSION_PROFILES = [
  "default",
  "restricted",
  "trusted",
] as const satisfies readonly PermissionProfileToken[]

/**
 * Static mapping from CLI dial flag → `BudgetDials` field. All dials are
 * integer-typed in the parser (we read them via `parseInt` + range check);
 * downstream code may still treat e.g. `maxCostUsd` as a non-integer once a
 * pricing table is plugged in. Today every dial in the shape is an integer
 * unit, so integer parsing is the right propositional check.
 *
 * NOTE: every key in `BudgetDials` is represented EXACTLY ONCE — when a new
 * dial is added there, `tsc` flags the missing flag mapping (the satisfies
 * clause forces structural completeness).
 */
const DIAL_FLAG_MAP = {
  "--max-turns": "maxTurns",
  "--max-wall-clock-ms": "maxWallClockMs",
  "--max-model-calls": "maxModelCalls",
  "--max-tool-calls": "maxToolCalls",
  "--max-shell-commands": "maxShellCommands",
  "--max-test-runs": "maxTestRuns",
  "--max-input-tokens": "maxInputTokens",
  "--max-output-tokens": "maxOutputTokens",
  "--max-reasoning-tokens": "maxReasoningTokens",
  "--max-total-tokens": "maxTotalTokens",
  "--max-cost-usd": "maxCostUsd",
  "--max-files-changed": "maxFilesChanged",
  "--max-patch-bytes": "maxPatchBytes",
  "--max-retries": "maxRetries",
  "--max-consecutive-failures": "maxConsecutiveFailures",
  "--compaction-token-threshold": "compactionTokenThreshold",
} as const satisfies Record<string, keyof BudgetDials>

type DialFlag = keyof typeof DIAL_FLAG_MAP

const isDialFlag = (s: string): s is DialFlag => Object.hasOwn(DIAL_FLAG_MAP, s)

const isValidMode = (s: string): s is AgentMode => (VALID_MODES as readonly string[]).includes(s)

const isValidProvider = (s: string): s is ProviderToken =>
  (VALID_PROVIDERS as readonly string[]).includes(s)

const isValidExhaustion = (s: string): s is BudgetExhaustionPolicy =>
  (VALID_EXHAUSTION as readonly string[]).includes(s)

/** ADR-0236 type guard for `--tool-profile`. */
const isValidToolProfile = (s: string): s is ToolProfileToken =>
  (VALID_TOOL_PROFILES as readonly string[]).includes(s)

/** ADR-0236 type guard for `--identity-mode`. */
const isValidIdentityMode = (s: string): s is IdentityModeToken =>
  (VALID_IDENTITY_MODES as readonly string[]).includes(s)

/** Track A2 type guard for `--permission-profile`. */
const isValidPermissionProfile = (s: string): s is PermissionProfileToken =>
  (VALID_PERMISSION_PROFILES as readonly string[]).includes(s)

/** Read `argv[i+1]` and assert it exists + is NOT another flag. */
const takeValue = (argv: readonly string[], i: number, flag: string): string => {
  const next = argv[i + 1]
  if (next === undefined || next.startsWith("--") || next === "-h" || next === "-p") {
    throw new AgentArgsError(`flag '${flag}' requires a value`)
  }
  return next
}

/** Parse `s` as a non-negative integer; throw otherwise. */
const parseIntStrict = (s: string, flag: string): number => {
  // Reject non-numeric prefixes EXACTLY (parseInt happily accepts "12abc").
  if (!/^-?\d+$/.test(s)) {
    throw new AgentArgsError(`flag '${flag}' expects an integer, got '${s}'`)
  }
  const n = parseInt(s, 10)
  if (!Number.isFinite(n)) {
    throw new AgentArgsError(`flag '${flag}' expects a finite integer, got '${s}'`)
  }
  if (n < 0) {
    throw new AgentArgsError(`flag '${flag}' must be >= 0, got ${n}`)
  }
  // Audit R2: `/^-?\d+$/` happily accepts a 400-digit string; `parseInt` then
  // returns a value past Number.MAX_SAFE_INTEGER where integer identity is lost
  // (`9007199254740993 === 9007199254740992`). A budget dial silently rounded
  // to a different integer is a correctness hole — reject it as out of range.
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new AgentArgsError(
      `flag '${flag}' exceeds the maximum safe integer (${Number.MAX_SAFE_INTEGER}), got '${s}'`,
    )
  }
  return n
}

/** Parse `s` as a non-negative finite number (allows a fractional part). Used
 *  for `--max-cost-usd`, whose dial is a dollar ceiling ($1.50 is valid). */
const parseFloatStrict = (s: string, flag: string): number => {
  // Accept `12`, `12.5`, `.5`, `0.50` — but NOT `12abc`, `1e9`, `Infinity`,
  // `NaN`, or empty fraction. Propositional: a strict decimal grammar.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) {
    throw new AgentArgsError(`flag '${flag}' expects a number, got '${s}'`)
  }
  const n = Number.parseFloat(s)
  if (!Number.isFinite(n)) {
    throw new AgentArgsError(`flag '${flag}' expects a finite number, got '${s}'`)
  }
  if (n < 0) {
    throw new AgentArgsError(`flag '${flag}' must be >= 0, got ${n}`)
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new AgentArgsError(
      `flag '${flag}' exceeds the maximum safe value (${Number.MAX_SAFE_INTEGER}), got '${s}'`,
    )
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────
// Flag dispatch table (OCP)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mutable accumulator threaded through the flag handlers. Each {@link FlagSpec}
 * `apply` writes into this struct; after the scan loop the optional fields are
 * copied into the immutable {@link AgentArgs} output (omitting `undefined`/`false`
 * exactly as the legacy if-chain did).
 *
 * Booleans default `false`; everything else `undefined` (= slot omitted).
 */
interface FlagAcc {
  mode?: AgentMode
  model?: string
  provider?: ProviderToken
  exhaustion?: BudgetExhaustionPolicy
  prompt?: string
  corpus?: string
  instance?: string
  predictions?: string
  report?: string
  ciBotDryRun: boolean
  pr?: string
  toolProfile?: ToolProfileToken
  stickyModel: boolean
  identityMode?: IdentityModeToken
  focusChainEvery?: number
  noAutoBackground: boolean
  playbookTrigger: boolean
  permissionProfile?: PermissionProfileToken
  dials: Partial<BudgetDials>
}

/**
 * A single flag's contract. Replaces one `if (a === "--x") { … }` arm:
 *  - `takesValue: true`  → the next argv token is consumed via {@link takeValue}
 *    (rejecting a missing/`--`-looking value) and passed to `apply` as `value`.
 *  - `takesValue: false` → a bare boolean flag; `apply` gets `undefined` and
 *    advances by one token.
 *
 * `apply` mutates the accumulator. Validation/enum-coercion lives inside `apply`,
 * byte-identical to the legacy arm (it may throw {@link AgentArgsError}). Adding
 * a new flag is ONE entry here, not an edit across the scan loop.
 */
type FlagSpec =
  | { takesValue: true; apply: (acc: FlagAcc, value: string, flag: string) => void }
  | { takesValue: false; apply: (acc: FlagAcc, value: undefined, flag: string) => void }

/**
 * Canonical-flag → spec. Aliases (e.g. `-p`) get their OWN entry pointing at the
 * same spec so lookup is O(1) and the canonical-name set stays explicit. Dial
 * flags are NOT listed here — they fan out from {@link DIAL_FLAG_MAP} and are
 * resolved by the dedicated `isDialFlag` branch in the loop (its int-vs-float
 * split keys off the resolved `BudgetDials` field, not the flag string).
 */
const FLAG_HANDLERS: Record<string, FlagSpec> = {
  "--mode": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidMode(v)) {
        throw new AgentArgsError(`--mode must be one of ${VALID_MODES.join("|")}, got '${v}'`)
      }
      acc.mode = v
    },
  },
  "--model": {
    takesValue: true,
    apply: (acc, v) => {
      acc.model = v
    },
  },
  "--provider": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidProvider(v)) {
        throw new AgentArgsError(
          `--provider must be one of ${VALID_PROVIDERS.join("|")}, got '${v}'`,
        )
      }
      acc.provider = v
    },
  },
  "--exhaustion": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidExhaustion(v)) {
        throw new AgentArgsError(
          `--exhaustion must be one of ${VALID_EXHAUSTION.join("|")}, got '${v}'`,
        )
      }
      acc.exhaustion = v
    },
  },
  "-p": {
    takesValue: true,
    apply: (acc, v) => {
      acc.prompt = v
    },
  },
  "--prompt": {
    takesValue: true,
    apply: (acc, v) => {
      acc.prompt = v
    },
  },
  "--corpus": {
    takesValue: true,
    apply: (acc, v) => {
      acc.corpus = v
    },
  },
  "--instance": {
    takesValue: true,
    apply: (acc, v) => {
      acc.instance = v
    },
  },
  "--predictions": {
    takesValue: true,
    apply: (acc, v) => {
      acc.predictions = v
    },
  },
  "--report": {
    takesValue: true,
    apply: (acc, v) => {
      acc.report = v
    },
  },
  "--pr": {
    takesValue: true,
    apply: (acc, v) => {
      acc.pr = v
    },
  },
  "--dry-run": {
    takesValue: false,
    // ci-bot only: stub the PR-comment write at the runner edge.
    apply: (acc) => {
      acc.ciBotDryRun = true
    },
  },
  "--tool-profile": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidToolProfile(v)) {
        throw new AgentArgsError(
          `--tool-profile must be one of ${VALID_TOOL_PROFILES.join("|")}, got '${v}'`,
        )
      }
      acc.toolProfile = v
    },
  },
  "--sticky-model": {
    takesValue: false,
    apply: (acc) => {
      acc.stickyModel = true
    },
  },
  "--identity-mode": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidIdentityMode(v)) {
        throw new AgentArgsError(
          `--identity-mode must be one of ${VALID_IDENTITY_MODES.join("|")}, got '${v}'`,
        )
      }
      acc.identityMode = v
    },
  },
  "--focus-chain-every": {
    takesValue: true,
    apply: (acc, raw, flag) => {
      const n = parseIntStrict(raw, flag)
      if (n === 0) {
        // Reject 0 explicitly — the tracker treats 0 as "disable", but the
        // operator wanting to disable should simply omit the flag (the slot
        // is default-OFF). Accepting 0 would silently wire a no-op tracker.
        throw new AgentArgsError(`flag '${flag}' must be > 0, got 0`)
      }
      acc.focusChainEvery = n
    },
  },
  "--no-auto-background": {
    takesValue: false,
    apply: (acc) => {
      acc.noAutoBackground = true
    },
  },
  "--playbook-trigger": {
    takesValue: false,
    apply: (acc) => {
      acc.playbookTrigger = true
    },
  },
  "--permission-profile": {
    takesValue: true,
    apply: (acc, v) => {
      if (!isValidPermissionProfile(v)) {
        throw new AgentArgsError(
          `--permission-profile must be one of ${VALID_PERMISSION_PROFILES.join("|")}, got '${v}'`,
        )
      }
      acc.permissionProfile = v
    },
  },
}

// ─────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse `argv` into an {@link AgentArgs}. Throws {@link AgentArgsError} on any
 * propositional violation (unknown flag, missing value, non-integer dial,
 * mode-specific flag without its mode, invalid enum literal).
 *
 * `--help` / `-h` short-circuit: when seen, the returned object has
 * `help: true`; the caller is expected to print {@link formatHelp} and exit 0
 * BEFORE validating other fields. `mode` is still set to a placeholder
 * `"interactive"` so the discriminated union is well-formed, but the caller
 * MUST NOT proceed past help.
 */
export const parseAgentArgs = (argv: readonly string[]): AgentArgs => {
  // First pass: did the user ask for help? Short-circuit before mode validation.
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      return {
        mode: "interactive",
        dials: {},
        help: true,
      }
    }
  }

  const acc = scanFlags(argv)
  assertModeCombo(acc)
  return assembleArgs(acc)
}

/**
 * Single linear scan over `argv`, dispatching each loop-head token through
 * {@link FLAG_HANDLERS} (then the dial fan-out, then unknown-flag throw). Pulled
 * out of {@link parseAgentArgs} so the entry point stays a flat 3-step pipeline
 * — the scan/validate/assemble split is structural only, the throws and the
 * accumulator writes are byte-identical to the legacy inline loop.
 */
const scanFlags = (argv: readonly string[]): FlagAcc => {
  const acc: FlagAcc = {
    ciBotDryRun: false,
    stickyModel: false,
    noAutoBackground: false,
    playbookTrigger: false,
    dials: {},
  }

  // Audit R2: duplicate-flag guard. None of our flags are repeatable, so the
  // propositional rule is "a flag seen twice is an error" — silently taking the
  // last `--mode` (or any other flag) hid operator typos. `-p` canonicalizes to
  // `--prompt` so the two spellings cannot both be passed.
  const seen = new Set<string>()
  const canonFlag = (f: string): string => (f === "-p" ? "--prompt" : f)
  const markSeen = (f: string): void => {
    const c = canonFlag(f)
    if (seen.has(c)) {
      throw new AgentArgsError(`flag '${c}' specified more than once`)
    }
    seen.add(c)
  }

  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === undefined) {
      i++
      continue
    }
    // Every token at a loop-head position is a flag (values are consumed via
    // takeValue + i+=2 and never reach here). Dedup recognized + unknown alike;
    // unknown flags still throw below.
    if (a.startsWith("-")) markSeen(a)

    // OCP dispatch: a known non-dial flag is a single table entry. Value-taking
    // specs consume argv[i+1] via takeValue (i += 2); boolean specs advance one.
    const spec = FLAG_HANDLERS[a]
    if (spec !== undefined) {
      if (spec.takesValue) {
        spec.apply(acc, takeValue(argv, i, a), a)
        i += 2
      } else {
        spec.apply(acc, undefined, a)
        i += 1
      }
      continue
    }

    if (isDialFlag(a)) {
      const raw = takeValue(argv, i, a)
      const key = DIAL_FLAG_MAP[a]
      // `maxCostUsd` is a dollar ceiling (fractional); every other dial is an
      // integer count/byte/ms/token unit.
      const n = key === "maxCostUsd" ? parseFloatStrict(raw, a) : parseIntStrict(raw, a)
      acc.dials[key] = n
      i += 2
      continue
    }

    throw new AgentArgsError(`unknown flag '${a}'`)
  }

  return acc
}

/**
 * Cross-flag (mode ↔ companion) validation. Throws {@link AgentArgsError} in the
 * EXACT order of the legacy inline guards: required-mode → wrong-mode rejects
 * (corpus/instance/predictions/report/pr/prompt) → missing-companion requires
 * (ci-bot/batch/headless). Narrows `acc.mode` to a defined {@link AgentMode}.
 */
/**
 * Mode-only flags: `acc[field]` is rejected unless `mode === requires`. Listed in
 * the legacy guard order (corpus→instance→predictions→report→pr→prompt). The
 * `message` is verbatim the legacy throw text.
 */
const MODE_ONLY_GUARDS: readonly {
  field: keyof FlagAcc
  requires: AgentMode
  message: string
}[] = [
  { field: "corpus", requires: "batch", message: `--corpus is only valid with --mode batch` },
  { field: "instance", requires: "batch", message: `--instance is only valid with --mode batch` },
  {
    field: "predictions",
    requires: "batch",
    message: `--predictions is only valid with --mode batch`,
  },
  { field: "report", requires: "batch", message: `--report is only valid with --mode batch` },
  { field: "pr", requires: "ci-bot", message: `--pr is only valid with --mode ci-bot` },
  {
    field: "prompt",
    requires: "headless",
    message: `-p/--prompt is only valid with --mode headless`,
  },
]

/**
 * Modes that REQUIRE a companion flag (the inverse direction). Listed in the
 * legacy order (ci-bot→batch→headless); `message` verbatim.
 */
const MODE_REQUIRES_GUARDS: readonly {
  mode: AgentMode
  field: keyof FlagAcc
  message: string
}[] = [
  { mode: "ci-bot", field: "pr", message: `--pr is required with --mode ci-bot` },
  { mode: "batch", field: "corpus", message: `--corpus is required with --mode batch` },
  { mode: "headless", field: "prompt", message: `-p/--prompt is required with --mode headless` },
]

function assertModeCombo(acc: FlagAcc): asserts acc is FlagAcc & { mode: AgentMode } {
  if (acc.mode === undefined) {
    throw new AgentArgsError(
      `--mode is required (one of ${VALID_MODES.join("|")}); pass --help for usage`,
    )
  }

  // Mode-specific flag validation — each mode-only flag must accompany its mode.
  for (const g of MODE_ONLY_GUARDS) {
    if (acc[g.field] !== undefined && acc.mode !== g.requires) {
      throw new AgentArgsError(g.message)
    }
  }

  // The OTHER direction — each mode that REQUIRES its companion flag must
  // receive it. The one-directional guards above reject a flag on the wrong
  // mode; without these the mode would start with no work to do (e.g. `--mode
  // headless` with no prompt, `--mode batch` with no corpus) and either hang
  // or fault deeper at the runner edge. Throwing AgentArgsError here surfaces
  // it as exit 64 / EX_USAGE with usage text, same as the guards above.
  for (const g of MODE_REQUIRES_GUARDS) {
    if (acc.mode === g.mode && acc[g.field] === undefined) {
      throw new AgentArgsError(g.message)
    }
  }
}

/**
 * Copy the validated accumulator into the immutable {@link AgentArgs}, omitting
 * each optional slot exactly as the legacy `if (x !== undefined) out.x = x`
 * tail did (booleans only set when truthy). Required `mode` is guaranteed by the
 * `assertModeCombo` narrowing.
 */
// Optional slots copied iff defined (string/enum/number). Order verbatim from
// the legacy `if (x !== undefined) out.x = x` tail.
const OPTIONAL_SLOTS = [
  "model",
  "provider",
  "exhaustion",
  "prompt",
  "corpus",
  "instance",
  "predictions",
  "report",
  "pr",
  "toolProfile",
  "identityMode",
  "focusChainEvery",
  "permissionProfile",
] as const satisfies readonly (keyof AgentArgs & keyof FlagAcc)[]

// Boolean slots copied iff truthy (matches legacy `if (flag) out.flag = true`).
const BOOLEAN_SLOTS = [
  "ciBotDryRun",
  "stickyModel",
  "noAutoBackground",
  "playbookTrigger",
] as const satisfies readonly (keyof AgentArgs & keyof FlagAcc)[]

const assembleArgs = (acc: FlagAcc & { mode: AgentMode }): AgentArgs => {
  const out: AgentArgs = { mode: acc.mode, dials: acc.dials, help: false }
  // ADR-0236 — composition-root mega-wire flags ride the same two tables.
  for (const k of OPTIONAL_SLOTS) {
    const v = acc[k]
    if (v !== undefined) {
      // Index assignment across a heterogeneous union — each (k,v) pair is
      // structurally aligned by the `keyof AgentArgs & keyof FlagAcc` constraint.
      ;(out[k] as unknown) = v
    }
  }
  for (const k of BOOLEAN_SLOTS) {
    if (acc[k]) {
      ;(out[k] as unknown) = true
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Help text — pure data, no I/O.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic usage string. Stable across runs so tests can pin it.
 *
 * Includes every dial flag from {@link DIAL_FLAG_MAP} — keeping the help text
 * source-of-truth-aligned with the parser means adding a dial cannot drift the
 * help and the parser apart.
 */
export const formatHelp = (): string => {
  const dialLines = Object.entries(DIAL_FLAG_MAP)
    .map(([flag, field]) => `    ${flag} <int>    → dials.${field}`)
    .join("\n")
  return `quanta agent — unified agent runtime entry (RFC may-22)

USAGE
  bun run agent --mode <interactive|headless|batch|ci-bot> [options]

REQUIRED
  --mode <m>              Run mode (one of ${VALID_MODES.join("|")})

COMMON OPTIONS
  --model <id>            Provider-specific model id (e.g. gpt-5-mini)
  --provider <p>          One of ${VALID_PROVIDERS.join("|")}
  --exhaustion <p>        One of ${VALID_EXHAUSTION.join("|")}
  --help, -h              Print this help and exit

MODE-SPECIFIC
  -p, --prompt <text>     headless only — task body
  --corpus <dir>          batch only — corpus directory
  --instance <substr>     batch only — instance filter substring
  --predictions <path>    batch only — JSONL predictions output path
  --report <path>         batch only — JSON report output path
  --pr <num>              ci-bot only — PR number

BUDGET DIALS (operator-requested ceilings; clamped to per-mode caps)
${dialLines}

COMPOSITION-ROOT MEGA-WIRE (ADR-0236 — all default-OFF; absent ⇒ slot omitted)
  --tool-profile <p>      One of ${VALID_TOOL_PROFILES.join("|")} (ADR-0213)
  --sticky-model          Wire fs-backed sticky-model store (ADR-0212)
  --identity-mode <m>     One of ${VALID_IDENTITY_MODES.join("|")} (ADR-0211)
  --focus-chain-every <N> Re-inject todos every N turns (>0, ADR-0219)
  --no-auto-background    Force auto-background OFF (ADR-0223)
  --playbook-trigger      Opt in to inline-trigger watcher (ADR-0293; or
                          set QUANTA_PLAYBOOK_TRIGGER=on)
  --permission-profile <p> One of ${VALID_PERMISSION_PROFILES.join("|")} (Track A2;
                          or set QUANTA_PERMISSION_PROFILE; unknown ⇒ fail-closed)

NOTES
  • Defaults flow from per-mode BUDGET_PRESETS via the assembler — this
    parser never injects defaults.
  • Unknown flags are a hard error (exit 64 / EX_USAGE).
  • Mode-specific flags (e.g. --corpus) outside their mode are a hard error.
`
}
