/**
 * `apps/agent/cli-args.ts` — RFC may-22-unified-agent-runtime / Phase 4.
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
}

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

  let mode: AgentMode | undefined
  let model: string | undefined
  let provider: ProviderToken | undefined
  let exhaustion: BudgetExhaustionPolicy | undefined
  let prompt: string | undefined
  let corpus: string | undefined
  let instance: string | undefined
  let predictions: string | undefined
  let report: string | undefined
  let ciBotDryRun = false
  let pr: string | undefined
  const dials: Partial<BudgetDials> = {}

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

    if (a === "--mode") {
      const v = takeValue(argv, i, a)
      if (!isValidMode(v)) {
        throw new AgentArgsError(`--mode must be one of ${VALID_MODES.join("|")}, got '${v}'`)
      }
      mode = v
      i += 2
      continue
    }

    if (a === "--model") {
      model = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--provider") {
      const v = takeValue(argv, i, a)
      if (!isValidProvider(v)) {
        throw new AgentArgsError(
          `--provider must be one of ${VALID_PROVIDERS.join("|")}, got '${v}'`,
        )
      }
      provider = v
      i += 2
      continue
    }

    if (a === "--exhaustion") {
      const v = takeValue(argv, i, a)
      if (!isValidExhaustion(v)) {
        throw new AgentArgsError(
          `--exhaustion must be one of ${VALID_EXHAUSTION.join("|")}, got '${v}'`,
        )
      }
      exhaustion = v
      i += 2
      continue
    }

    if (a === "-p" || a === "--prompt") {
      prompt = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--corpus") {
      corpus = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--instance") {
      instance = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--predictions") {
      predictions = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--report") {
      report = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--pr") {
      pr = takeValue(argv, i, a)
      i += 2
      continue
    }

    if (a === "--dry-run") {
      // ci-bot only: stub the PR-comment write at the runner edge.
      ciBotDryRun = true
      i += 1
      continue
    }

    if (isDialFlag(a)) {
      const raw = takeValue(argv, i, a)
      const key = DIAL_FLAG_MAP[a]
      // `maxCostUsd` is a dollar ceiling (fractional); every other dial is an
      // integer count/byte/ms/token unit.
      const n = key === "maxCostUsd" ? parseFloatStrict(raw, a) : parseIntStrict(raw, a)
      dials[key] = n
      i += 2
      continue
    }

    throw new AgentArgsError(`unknown flag '${a}'`)
  }

  if (mode === undefined) {
    throw new AgentArgsError(
      `--mode is required (one of ${VALID_MODES.join("|")}); pass --help for usage`,
    )
  }

  // Mode-specific flag validation — each mode-only flag must accompany its mode.
  if (corpus !== undefined && mode !== "batch") {
    throw new AgentArgsError(`--corpus is only valid with --mode batch`)
  }
  if (instance !== undefined && mode !== "batch") {
    throw new AgentArgsError(`--instance is only valid with --mode batch`)
  }
  if (predictions !== undefined && mode !== "batch") {
    throw new AgentArgsError(`--predictions is only valid with --mode batch`)
  }
  if (report !== undefined && mode !== "batch") {
    throw new AgentArgsError(`--report is only valid with --mode batch`)
  }
  if (pr !== undefined && mode !== "ci-bot") {
    throw new AgentArgsError(`--pr is only valid with --mode ci-bot`)
  }
  if (prompt !== undefined && mode !== "headless") {
    throw new AgentArgsError(`-p/--prompt is only valid with --mode headless`)
  }

  const out: AgentArgs = { mode, dials, help: false }
  if (model !== undefined) out.model = model
  if (provider !== undefined) out.provider = provider
  if (exhaustion !== undefined) out.exhaustion = exhaustion
  if (prompt !== undefined) out.prompt = prompt
  if (corpus !== undefined) out.corpus = corpus
  if (instance !== undefined) out.instance = instance
  if (predictions !== undefined) out.predictions = predictions
  if (report !== undefined) out.report = report
  if (pr !== undefined) out.pr = pr
  if (ciBotDryRun) out.ciBotDryRun = true
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

NOTES
  • Defaults flow from per-mode BUDGET_PRESETS via the assembler — this
    parser never injects defaults.
  • Unknown flags are a hard error (exit 64 / EX_USAGE).
  • Mode-specific flags (e.g. --corpus) outside their mode are a hard error.
`
}
