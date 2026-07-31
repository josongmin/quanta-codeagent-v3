/**
 * Runtime-config value parsers + the small leaf type/const vocabulary they
 * validate against. Extracted from `runtime-config.ts` (god-module split) so the
 * 1150-line `RuntimeConfig` interface (`./types`) and the `loadFromEnv` resolver
 * body (the parent) can each import these pure helpers without bloating one file.
 *
 * Pure + leaf: depends ONLY on `./env-flag` (`isTruthyToken`) and `./terminal-io`
 * (`writeStderr`) — never on the parent or on `runtime-config-knobs.ts`, so there
 * is no import cycle. Every parser REJECTS garbage + warns once on stderr (the
 * logger imports US, so we cannot import it here — raw `writeStderr`).
 */

import { isTruthyToken } from "../env-flag"
import { writeStderr } from "../terminal-io"

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** SWE-bench Docker image cache levels (upstream `run_evaluation` vocabulary).
 *  `none` rebuilds + discards everything; `env` (the upstream default and ours)
 *  keeps base + per-repo env images warm; `instance` also keeps per-instance
 *  images for fastest re-runs of the SAME instance. */
export const SWEBENCH_CACHE_LEVELS = ["none", "base", "env", "instance"] as const
export type SwebenchCacheLevel = (typeof SWEBENCH_CACHE_LEVELS)[number]

const SWEBENCH_CACHE_LEVEL_SET = new Set<string>(SWEBENCH_CACHE_LEVELS)

/** jun-6 — default watchdog cap (ms) for a `block`-tool critical section. The
 *  critical-section slice has NO embedded magic number (it takes `maxMs` by
 *  injection), so this measured one-rename budget is the SSOT default. 5s is
 *  generous for a single atomic FS-write window yet bounds a withheld abort so
 *  `block` can never permanently swallow a cancel. */
export const DEFAULT_CRITICAL_SECTION_MAX_MS = 5_000

const stderrWarn = (msg: string): void => {
  // Direct write because the logger imports US; using logger here would loop.
  writeStderr(`[quanta] config: ${msg}\n`)
}

export const parseLogLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined) return "info"
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw
  stderrWarn(
    `ignoring unknown QUANTA_LOG_LEVEL="${raw}" — valid: ${LOG_LEVELS.join("|")} — defaulting to "info"`,
  )
  return "info"
}

/** Like {@link parsePositiveInt} but ACCEPTS `0` as a valid value. Used by knobs
 *  whose `0` carries meaning DISTINCT from "absent" (e.g.
 *  `QUANTA_LLM_STREAM_TRACE_MS=0` ⇒ explicitly DISABLE the stream-progress
 *  heartbeat, vs absent ⇒ default ON). Absent ⇒ `undefined`; a negative / non-
 *  integer value is rejected with a warning and treated as absent. */
export const parseNonNegativeInt = (
  raw: string | undefined,
  varName: string,
): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a non-negative integer`)
    return undefined
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n < 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a non-negative integer`)
    return undefined
  }
  return n
}

export const parsePositiveInt = (raw: string | undefined, varName: string): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // Reject non-integer / non-positive / extra whitespace / hex / sign:
  if (!/^\d+$/.test(trimmed)) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n <= 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  return n
}

/** SSOT truthy predicate for boolean env knobs. Case-INSENSITIVE: `"1"` /
 *  `"true"` / `"on"` (any case) ⇒ true; `undefined` / empty / any other value ⇒
 *  false. Exported so a knob's own `parse` can reuse the EXACT same function as
 *  the live `runtimeConfig()` read (e.g. `QUANTA_MCP_TOOL_ANNOTATIONS`), making
 *  the two channels byte-equal — no `"TRUE"`/`"ON"` divergence between the knob
 *  registry/telemetry and the consumer. */
export const parseBool = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on"
}

/** "Is the rate-limit NOTICE surface wanted?" — lenient truthy: absent / `""` /
 *  `0` / `false` / `off` / `no` (case-insensitive) ⇒ false; ANY other value ⇒
 *  true. Exported as the SINGLE SSOT predicate shared by the core loop
 *  (snapshot-capture gate in `session-bootstrap`) and the CLI render gate
 *  (`isRatelimitNoticeEnabled`). The notice and proactive-backoff both feed the
 *  SAME snapshot store; this decides whether the store/capture is built when
 *  proactive is OFF, so `QUANTA_RATELIMIT_NOTICE` alone produces snapshots. */
export const ratelimitNoticeWanted = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  const norm = raw.trim().toLowerCase()
  return !(norm === "" || norm === "0" || norm === "false" || norm === "off" || norm === "no")
}

/** Boolean knob that DEFAULTS to true: absent ⇒ true; an explicit off-vocabulary
 *  value (`0`/`false`/`off`, case-insensitive) ⇒ false; anything else ⇒ true.
 *  Used by the single default-ON knob (`QUANTA_IPYNB_OUTPUTS`) — see the field
 *  doc for why default-true is the safe posture there. */
export const parseBoolDefaultTrue = (raw: string | undefined): boolean => {
  if (raw === undefined) return true
  const lc = raw.toLowerCase()
  return !(raw === "0" || lc === "false" || lc === "off")
}

/** Parse a strictly-positive finite number (fractional allowed). Used for the
 *  auto-dream HOURS threshold where a sub-hour cadence (`0.5`) is legal.
 *  Rejects `NaN`, `Infinity`, zero, negatives, and non-numeric strings —
 *  invalid ⇒ `undefined` (the caller falls back to a documented default). */
export const parsePositiveNumber = (
  raw: string | undefined,
  varName: string,
): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (trimmed.length === 0 || !Number.isFinite(n) || n <= 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive number`)
    return undefined
  }
  return n
}

/** Parse a delimiter-separated list (`,` `:` `;` `\n`). Trims, drops empties.
 *  Returns a frozen array (length 0 ⇒ caller treats as "no extras"). Used for
 *  list-shaped env vars that EXTEND a code-side default (operator merge, not
 *  replace) — keeps audited defaults intact while admitting ecosystem additions
 *  (Rust `target/`, new package managers like `uv`/`poetry`, etc). */
export const parseStringList = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw.length === 0) return Object.freeze([])
  const parts: string[] = []
  for (const piece of raw.split(/[,:;\n]/)) {
    const t = piece.trim()
    if (t.length > 0) parts.push(t)
  }
  return Object.freeze(parts)
}

/** ticket-15 (§11.7) — operator-authored scriptable statusLine config (Claude
 *  Code `statusLine{}` shape: CC settings schema:737). The `type` is implicitly
 *  `"command"`; only `command` is required. Carried as plain data; the CLI
 *  surface (`status-command-runner.ts`) interprets it. Declared HERE (not
 *  imported from `@/apps/cli`) to keep `@/shared` a leaf — the runner's own
 *  `StatusLineConfig` is structurally assignable to this. */
export interface StatusLineConfig {
  /** The command argv — a string (whitespace-split, no shell) or an array
   *  (verbatim, the robust form). */
  readonly command: string | readonly string[]
  /** Left padding (spaces) the host renderer prepends. */
  readonly padding?: number
  /** Extra polling cadence (ms) BEYOND event-driven refresh (CC: min 1s). */
  readonly refreshInterval?: number
  /** Suppress the vim-mode indicator segment (CC parity). */
  readonly hideVimModeIndicator?: boolean
}

/** Parse the scriptable-statusLine config from env. DOUBLE-gated, default-OFF:
 *  returns `undefined` (byte-identical — the built-in segmented `/context`
 *  status render stays the only render) UNLESS the master gate `QUANTA_STATUS_LINE` is on
 *  (gateOn vocab) AND `QUANTA_STATUS_LINE_CONFIG` parses to a JSON object with a
 *  usable `command`. Any defect (gate off / absent / malformed JSON / no
 *  command) ⇒ `undefined` + a single stderr warn on a malformed-but-present
 *  config (so an operator typo is visible, never silently swallowed). The
 *  command is OPERATOR-AUTHORED (hook trust tier); the runner spawns it
 *  args-based (NO shell). */
export const parseStatusLineConfig = (
  gateRaw: string | undefined,
  raw: string | undefined,
): StatusLineConfig | undefined => {
  if (!isTruthyToken(gateRaw)) return undefined
  if (raw === undefined || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    stderrWarn(`ignoring malformed QUANTA_STATUS_LINE_CONFIG (not JSON) — statusLine disabled`)
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    stderrWarn(`ignoring QUANTA_STATUS_LINE_CONFIG — must be a JSON object — statusLine disabled`)
    return undefined
  }
  const obj = parsed as Record<string, unknown>
  const command = obj.command
  const commandOk =
    (typeof command === "string" && command.trim().length > 0) ||
    (Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === "string"))
  if (!commandOk) {
    stderrWarn(
      `ignoring QUANTA_STATUS_LINE_CONFIG — "command" must be a non-empty string or string[] — statusLine disabled`,
    )
    return undefined
  }
  const cfg: { -readonly [K in keyof StatusLineConfig]: StatusLineConfig[K] } = {
    command: command as string | readonly string[],
  }
  if (typeof obj.padding === "number" && Number.isFinite(obj.padding)) {
    cfg.padding = obj.padding
  }
  if (typeof obj.refreshInterval === "number" && Number.isFinite(obj.refreshInterval)) {
    cfg.refreshInterval = obj.refreshInterval
  }
  if (typeof obj.hideVimModeIndicator === "boolean") {
    cfg.hideVimModeIndicator = obj.hideVimModeIndicator
  }
  return Object.freeze(cfg)
}

export const parseSessionListFormat = (raw: string | undefined): "rich" | "plain" | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  if (raw === "rich" || raw === "plain") return raw
  stderrWarn(
    `ignoring unknown QUANTA_SESSION_LIST_FORMAT="${raw}" — valid: rich|plain — falling back to TTY auto-detect`,
  )
  return undefined
}

/** PTY backend selector (`QUANTA_PTY_BACKEND`). `tmux` (default, byte-identical
 *  to the pre-slice path) | `bun` (Bun-native terminal) | `both` (try bun, fall
 *  back to tmux). Unknown ⇒ warn once + default `tmux`. */
const PTY_BACKENDS = ["tmux", "bun", "both"] as const
export type PtyBackend = (typeof PTY_BACKENDS)[number]
const PTY_BACKEND_SET = new Set<string>(PTY_BACKENDS)
export const parsePtyBackend = (raw: string | undefined): PtyBackend => {
  if (raw === undefined) return "tmux"
  if (PTY_BACKEND_SET.has(raw)) return raw as PtyBackend
  stderrWarn(
    `ignoring unknown QUANTA_PTY_BACKEND="${raw}" — valid: ${PTY_BACKENDS.join("|")} — defaulting to "tmux"`,
  )
  return "tmux"
}

export const parseSwebenchCacheLevel = (raw: string | undefined): SwebenchCacheLevel => {
  if (raw === undefined) return "env"
  if (SWEBENCH_CACHE_LEVEL_SET.has(raw)) return raw as SwebenchCacheLevel
  stderrWarn(
    `ignoring unknown QUANTA_SWEBENCH_CACHE_LEVEL="${raw}" — valid: ${SWEBENCH_CACHE_LEVELS.join("|")} — defaulting to "env"`,
  )
  return "env"
}

/** ADR-0296 auto-background — what happens when a foreground bash command
 *  exceeds its deadline. `background` (DEFAULT — ships ON, ADR-0296) detaches
 *  the still-running child into the bash background registry so the model
 *  resumes it via `bash_await`/`bash_kill` (Claude-Code-style auto-background);
 *  a command that COMPLETES before its deadline is byte-identical to the legacy
 *  result, so the only behavior change is "deadline ⇒ detach instead of kill".
 *  `kill` is the legacy SIGTERM-on-deadline opt-out. `prompt` surfaces a
 *  one-keystroke consent before detaching (falls back to `background` where no
 *  interactive surface is wired). A per-call `timeout_behavior` on the bash tool
 *  always overrides. */
export const BASH_AUTO_BACKGROUND_MODES = ["kill", "background", "prompt"] as const
export type BashAutoBackgroundMode = (typeof BASH_AUTO_BACKGROUND_MODES)[number]

export const parseBashAutoBackground = (raw: string | undefined): BashAutoBackgroundMode => {
  if (raw === undefined) return "background"
  if (raw === "kill" || raw === "background" || raw === "prompt") return raw
  stderrWarn(
    `ignoring unknown QUANTA_BASH_AUTO_BACKGROUND="${raw}" — valid: ${BASH_AUTO_BACKGROUND_MODES.join("|")} — defaulting to "background"`,
  )
  return "background"
}

export const stringOrUndef = (raw: string | undefined): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined
