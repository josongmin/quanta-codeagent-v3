/**
 * Scriptable statusLine runner (ticket-15, §11.7 part A) — Claude Code's REAL
 * stdin contract, args-based spawn, first-line-only ANSI-aware truncated stdout.
 *
 * Claude Code exposes a `statusLine { type:"command", command, padding?,
 * refreshInterval?, hideVimModeIndicator? }` config (CC settings schema:737) and
 * invokes the operator-authored command on every status tick, piping a
 * `{"hook_event_name":"Status", …}` JSON object on **stdin**. The command prints
 * a status string on stdout; CC takes the FIRST LINE, allows ANSI color, and
 * truncates to the terminal width.
 *
 * This module mirrors that contract so a script written for CC's statusLine
 * works verbatim under quanta:
 *
 *   - {@link buildStatusPayload} assembles the CC-compatible payload from the
 *     host's session view (omitting fields we cannot fill so the script's
 *     optional handling kicks in). **NEVER carries secrets/tokens/api-keys** —
 *     only cost / model / cwd / workspace / context-window facts.
 *   - {@link runStatusCommand} spawns the command **args-based (NO `shell:true`
 *     — no shell-injection surface)**, injects the JSON on stdin, captures
 *     stdout, takes the first line, leaves ANSI intact, truncates to the
 *     terminal width with an ANSI-reset correction, and SILENTLY DEGRADES (warn
 *     + "") on a non-zero exit / spawn error / timeout. Timeout default 500ms,
 *     hard cap 5s.
 *
 * Trust model: the command string is OPERATOR-AUTHORED settings (the same trust
 * tier as a hook), so executing it is intended — but we still never use a shell
 * (args-based) and never leak credentials into its stdin.
 *
 * Lives in `src/apps/cli` (the REPL invokes it per status tick), inside the
 * existing CLI slice — no new tsconfig path / slice fence needed.
 */

import { errMessage, logger } from "@/shared"
import { stripAnsi, visibleWidth } from "@/ui/ui-helpers"

const log = logger.child({ caller: "statusline" })

/** Default per-tick command timeout (ms). CC's status command is on the prompt
 *  hot path, so a slow script must not stall the prompt — 500ms is the CC
 *  default. Operators may shorten via config but never exceed {@link HARD_CAP_MS}. */
export const DEFAULT_TIMEOUT_MS = 500

/** Absolute upper bound (ms) on a status command, regardless of config. A
 *  status line can never hang the REPL longer than this. */
export const HARD_CAP_MS = 5_000

/** Minimum legal `refreshInterval` in ms (CC: "min 1s"). A config value below
 *  this is clamped UP to 1000ms; absent ⇒ purely event-driven (no extra poll). */
export const MIN_REFRESH_INTERVAL_MS = 1_000

/** Operator-authored statusLine config (CC `statusLine{}` shape). The `type` is
 *  implicitly `"command"`; only `command` is required. */
export interface StatusLineConfig {
  /** The command argv. A single string is split on whitespace (a thin
   *  convenience for `"my-script --flag"`); an array is used verbatim (the
   *  robust form — no shell, no word-splitting surprises). EMPTY ⇒ inert. */
  readonly command: string | readonly string[]
  /** Left padding (spaces) the host renderer prepends. Carried through; the
   *  runner does not apply it (the renderer owns layout). */
  readonly padding?: number
  /** Extra polling cadence (ms) BEYOND event-driven refresh. Clamped UP to
   *  {@link MIN_REFRESH_INTERVAL_MS}. Absent ⇒ event-driven only. */
  readonly refreshInterval?: number
  /** Suppress the vim-mode indicator segment (CC parity). Carried for the
   *  renderer; the runner does not interpret it. */
  readonly hideVimModeIndicator?: boolean
}

/** The CC `Status` stdin payload. EVERY field is optional — `buildStatusPayload`
 *  omits anything the host cannot fill, matching CC's "scripts treat fields as
 *  optional" convention. `hook_event_name` is ALWAYS `"Status"`. */
export interface StatusPayload {
  readonly hook_event_name: "Status"
  readonly session_id?: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly model?: { readonly id?: string; readonly display_name?: string }
  readonly workspace?: {
    readonly current_dir?: string
    readonly project_dir?: string
    readonly added_dirs?: readonly string[]
    readonly git_worktree?: string
  }
  readonly version?: string
  readonly output_style?: { readonly name?: string }
  readonly cost?: {
    readonly total_cost_usd?: number
    readonly total_duration_ms?: number
    readonly total_api_duration_ms?: number
    readonly total_lines_added?: number
    readonly total_lines_removed?: number
  }
  readonly context_window?: number
  readonly exceeds_200k_tokens?: boolean
  readonly fast_mode?: boolean
  readonly effort?: { readonly level?: string }
  readonly thinking?: { readonly enabled?: boolean }
}

/** The host's session view — the SUPERSET of facts the payload may draw from.
 *  Every field is optional; a missing field is simply omitted from the payload.
 *  Declared structurally here (NOT imported from `@/agent`) so the module stays
 *  inside the CLI slice and the host adapter can pass a plain object. SECURITY:
 *  the host MUST NOT place credentials here — this shape has no token/key slot. */
export interface SessionStatusView {
  readonly sessionId?: string
  readonly transcriptPath?: string
  readonly cwd?: string
  readonly modelId?: string
  readonly modelDisplayName?: string
  readonly currentDir?: string
  readonly projectDir?: string
  readonly addedDirs?: readonly string[]
  readonly gitWorktree?: string
  readonly version?: string
  readonly outputStyleName?: string
  readonly totalCostUsd?: number
  readonly totalDurationMs?: number
  readonly totalApiDurationMs?: number
  readonly totalLinesAdded?: number
  readonly totalLinesRemoved?: number
  readonly contextWindow?: number
  readonly exceeds200kTokens?: boolean
  readonly fastMode?: boolean
  readonly effortLevel?: string
  readonly thinkingEnabled?: boolean
}

/** Include a field only when it is defined (drops `undefined` keys so the JSON
 *  payload OMITS them rather than serializing `null`/absent — CC scripts branch
 *  on key presence). */
const defined = <T>(value: T | undefined): T | undefined => value

/** Build a nested sub-object from defined entries; returns `undefined` if the
 *  sub-object would be empty (so the parent key is omitted entirely). */
const compact = <T extends Record<string, unknown>>(obj: T): T | undefined => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined
}

/**
 * Assemble the CC `Status` stdin payload from the host session view.
 *
 * SECURITY INVARIANT: only cost / model / cwd / workspace / context facts are
 * copied. There is NO code path that copies a token, api-key, secret, or env —
 * the {@link SessionStatusView} shape has no such field, by design.
 *
 * Fields the host did not supply are OMITTED (not nulled), so a CC statusLine
 * script's optional handling works unchanged. `hook_event_name` is always
 * `"Status"`. Pure function.
 */
export const buildStatusPayload = (view: SessionStatusView): StatusPayload => {
  const payload: Record<string, unknown> = { hook_event_name: "Status" }

  if (view.sessionId !== undefined) payload.session_id = view.sessionId
  if (view.transcriptPath !== undefined) payload.transcript_path = view.transcriptPath
  if (view.cwd !== undefined) payload.cwd = view.cwd

  const model = compact({ id: defined(view.modelId), display_name: defined(view.modelDisplayName) })
  if (model !== undefined) payload.model = model

  const workspace = compact({
    current_dir: defined(view.currentDir),
    project_dir: defined(view.projectDir),
    added_dirs: defined(view.addedDirs),
    git_worktree: defined(view.gitWorktree),
  })
  if (workspace !== undefined) payload.workspace = workspace

  if (view.version !== undefined) payload.version = view.version

  const outputStyle = compact({ name: defined(view.outputStyleName) })
  if (outputStyle !== undefined) payload.output_style = outputStyle

  const cost = compact({
    total_cost_usd: defined(view.totalCostUsd),
    total_duration_ms: defined(view.totalDurationMs),
    total_api_duration_ms: defined(view.totalApiDurationMs),
    total_lines_added: defined(view.totalLinesAdded),
    total_lines_removed: defined(view.totalLinesRemoved),
  })
  if (cost !== undefined) payload.cost = cost

  if (view.contextWindow !== undefined) payload.context_window = view.contextWindow
  if (view.exceeds200kTokens !== undefined) payload.exceeds_200k_tokens = view.exceeds200kTokens
  if (view.fastMode !== undefined) payload.fast_mode = view.fastMode

  const effort = compact({ level: defined(view.effortLevel) })
  if (effort !== undefined) payload.effort = effort

  const thinking = compact({ enabled: defined(view.thinkingEnabled) })
  if (thinking !== undefined) payload.thinking = thinking

  return payload as unknown as StatusPayload
}

/** Normalize the config command into a non-empty argv, or `undefined` (inert).
 *  A string is whitespace-split; an array is filtered of empties. */
const toArgv = (command: string | readonly string[]): string[] | undefined => {
  const parts =
    typeof command === "string"
      ? command.split(/\s+/).filter((p) => p.length > 0)
      : command.filter((p) => typeof p === "string" && p.length > 0)
  return parts.length > 0 ? parts : undefined
}

/** Clamp the configured timeout into `(0, HARD_CAP_MS]`, defaulting absent /
 *  non-positive / non-finite to {@link DEFAULT_TIMEOUT_MS}. Exported for tests. */
export const resolveTimeoutMs = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(raw, HARD_CAP_MS)
}

/** Clamp a configured `refreshInterval` UP to {@link MIN_REFRESH_INTERVAL_MS};
 *  absent / non-positive / non-finite ⇒ `undefined` (event-driven only).
 *  Exported so the REPL poller and the config validator agree. */
export const resolveRefreshIntervalMs = (raw: number | undefined): number | undefined => {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.max(raw, MIN_REFRESH_INTERVAL_MS)
}

/**
 * Take the FIRST LINE of the command's stdout, leave ANSI intact, and truncate
 * to `width` VISIBLE columns (ANSI codes don't count toward width). When the
 * truncation cuts inside styled text, a trailing `\x1b[0m` reset is appended so
 * the surrounding prompt is never left colored (ANSI-reset correction). Pure.
 *
 * `width <= 0` / non-finite ⇒ no width truncation (the first line is returned
 * as-is). Exported for direct unit testing.
 */
export const formatStatusOutput = (stdout: string, width: number): string => {
  // First line only — split on the first newline (CR/LF tolerant).
  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? ""
  if (!Number.isFinite(width) || width <= 0) return firstLine
  if (visibleWidth(firstLine) <= width) return firstLine

  // Walk the string, counting VISIBLE chars, skipping ANSI CSI sequences, until
  // we hit `width` visible columns. Preserve every ANSI code seen so color
  // is intact up to the cut.
  let visible = 0
  let out = ""
  let i = 0
  let sawAnsi = false
  // CSI matcher: ESC '[' … 'm' — matches the canonical color-code shape.
  const ESC = String.fromCharCode(27)
  while (i < firstLine.length && visible < width) {
    if (firstLine[i] === ESC && firstLine[i + 1] === "[") {
      // Consume the full CSI sequence (up to and including the final letter).
      let j = i + 2
      while (j < firstLine.length && !/[a-zA-Z]/.test(firstLine[j] ?? "")) j++
      out += firstLine.slice(i, j + 1)
      sawAnsi = true
      i = j + 1
      continue
    }
    out += firstLine[i]
    visible += 1
    i += 1
  }
  // ANSI-reset correction: if we cut anywhere inside styled output, ensure the
  // line ends reset so the prompt below isn't left colored.
  if (sawAnsi && !out.endsWith(`${ESC}[0m`)) {
    out += `${ESC}[0m`
  }
  return out
}

/** Result of a status-command run. `text` is the rendered status line (possibly
 *  `""` on degrade); `degraded` flags a silent failure (the caller may keep the
 *  previous cached line). */
export interface StatusCommandResult {
  readonly text: string
  readonly degraded: boolean
}

/** Injectable spawn seam so tests can drive deterministic stdout/exit/timeout
 *  without a real subprocess. Mirrors the subset of `Bun.spawn` we use. */
export interface StatusSpawnHandle {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(): void
}
export type StatusSpawner = (
  argv: readonly string[],
  opts: { readonly stdin: Uint8Array; readonly cwd?: string | undefined },
) => StatusSpawnHandle

/** Real Bun.spawn-backed spawner. Args-based (NO `shell:true`), pipes stdin from
 *  the provided bytes, captures stdout, ignores stderr (a status script's noise
 *  must never pollute the prompt). */
const defaultSpawner: StatusSpawner = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdin: opts.stdin,
    stdout: "pipe",
    stderr: "ignore",
  })
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array> | null,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill()
      } catch {
        // best-effort
      }
    },
  }
}

/** Options for {@link runStatusCommand}. */
export interface RunStatusCommandOptions {
  /** Terminal width for truncation (visible columns). `<=0` ⇒ no truncation. */
  readonly width?: number
  /** Working directory for the spawned command. */
  readonly cwd?: string
  /** Test seam: override the spawner. */
  readonly spawn?: StatusSpawner
}

/**
 * Run the operator's statusLine command with the CC `Status` payload on stdin
 * and return the rendered first line.
 *
 * Contract:
 *   - **Args-based spawn, NO `shell:true`** (no shell-injection surface).
 *   - The payload JSON is written to the child's **stdin**.
 *   - Output = FIRST LINE of stdout, ANSI preserved, truncated to `width`.
 *   - Timeout = `resolveTimeoutMs(cfg.refreshInterval-independent timeout)`;
 *     here the per-call timeout is the DEFAULT (500ms) clamped to the 5s hard
 *     cap. On timeout the child is killed and the result degrades to `""`.
 *   - A NON-ZERO exit warns once and STILL returns the (truncated) stdout — a
 *     script may exit non-zero yet print a useful line; we surface it but flag
 *     the failure.
 *   - A SPAWN ERROR / empty command degrades to `""` (warn).
 *
 * Never throws — a status line must not break the REPL.
 */
export const runStatusCommand = async (
  cfg: StatusLineConfig,
  payload: StatusPayload,
  opts: RunStatusCommandOptions = {},
): Promise<StatusCommandResult> => {
  const argv = toArgv(cfg.command)
  if (argv === undefined) {
    return { text: "", degraded: true }
  }

  const width = opts.width ?? 0
  const timeoutMs = resolveTimeoutMs(undefined) // per-tick default, clamped to hard cap
  const spawner = opts.spawn ?? defaultSpawner
  const stdinBytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`)

  let handle: StatusSpawnHandle
  try {
    handle = spawner(argv, { stdin: stdinBytes, cwd: opts.cwd })
  } catch (err) {
    log.warn("statusLine spawn failed", { error: errMessage(err) })
    return { text: "", degraded: true }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    handle.kill()
  }, timeoutMs)

  try {
    const stdoutPromise = handle.stdout ? readAll(handle.stdout) : Promise.resolve("")
    const [stdout, exitCode] = await Promise.all([stdoutPromise, handle.exited])

    if (timedOut) {
      log.warn("statusLine command timed out", { timeoutMs })
      return { text: "", degraded: true }
    }
    const text = formatStatusOutput(stdout, width)
    if (exitCode !== 0) {
      log.warn("statusLine command exited non-zero", { exitCode })
      // Surface whatever it printed, but flag the failure so the caller knows.
      return { text, degraded: true }
    }
    return { text, degraded: false }
  } catch (err) {
    log.warn("statusLine command errored", { error: errMessage(err) })
    return { text: "", degraded: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Drain a byte stream to a UTF-8 string. */
const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder("utf-8").decode(buf)
}

/** Re-export for callers that want to sanity-check a string carries no ANSI. */
export { stripAnsi }
