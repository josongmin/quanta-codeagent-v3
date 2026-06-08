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

import { scrubEnv } from "@/runtime"
import { asScrubbedEnv, bunScrubbedSpawner } from "@/runtime/scrubbed-spawn"
import { errMessage, logger } from "@/shared"
import { stripAnsi } from "@/ui/ui-helpers"

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

/** Like {@link defined} but for NUMERIC facts: a non-finite number (NaN /
 *  ±Infinity) is treated as ABSENT, because `JSON.stringify` serializes those as
 *  `null` — which would break the documented "omit rather than null" invariant
 *  (a CC script branches on key presence and would read `null` as a real value).
 *  Returns `undefined` for non-finite (so `compact` drops the key). */
const definedFinite = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) ? value : undefined

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
    total_cost_usd: definedFinite(view.totalCostUsd),
    total_duration_ms: definedFinite(view.totalDurationMs),
    total_api_duration_ms: definedFinite(view.totalApiDurationMs),
    total_lines_added: definedFinite(view.totalLinesAdded),
    total_lines_removed: definedFinite(view.totalLinesRemoved),
  })
  if (cost !== undefined) payload.cost = cost

  if (definedFinite(view.contextWindow) !== undefined) payload.context_window = view.contextWindow
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

// ── ANSI tokenization + reset-correction (findings 3 & 4) ────────────────────
const ESC = String.fromCharCode(27)
const SGR_RESET = `${ESC}[0m`
const ST = `${ESC}\\` // String Terminator (the OSC terminator alongside BEL)

/** OSC-8 hyperlink CLOSE: `ESC ] 8 ; ; ST` (empty URL ⇒ ends the clickable
 *  region). We emit ST-terminated (not BEL) since ST is the modern form and any
 *  terminal that understood the open understands this close. */
const OSC8_CLOSE = `${ESC}]8;;${ST}`

/** True iff the rendered line leaves an SGR style OPEN — it contains at least one
 *  SGR sequence and does NOT already end with a reset. An open SGR bleeds color
 *  into the prompt below, so the caller appends a reset. OSC (title) and
 *  cursor-move CSIs are self-terminating and paint no persistent color, so they
 *  need no reset. OSC-8 hyperlinks ARE stateful, though — handled separately by
 *  {@link hasOpenHyperlink}. */
const hasOpenSgr = (s: string): boolean => {
  const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
  return sgr.test(s) && !s.endsWith(SGR_RESET)
}

/** True iff `s` leaves an OSC-8 hyperlink OPEN — the LAST OSC-8 sequence in `s`
 *  set a NON-EMPTY URL (`ESC]8;;<url>` with url ≠ "") and is not followed by a
 *  close (`ESC]8;;`). An open OSC-8 hyperlink is STATEFUL: a truncation inside
 *  the clickable label drops the close and bleeds the clickable region into the
 *  prompt below. We walk every OSC-8 introducer and track the URL of the last
 *  one — non-empty ⇒ open, empty ⇒ closed. Other OSC kinds (title, etc.) are
 *  ignored (they paint no persistent clickable state). */
const hasOpenHyperlink = (s: string): boolean => {
  const OSC8_INTRO = `${ESC}]8;` // `ESC ] 8 ;`
  let open = false
  let from = 0
  while (true) {
    const idx = s.indexOf(OSC8_INTRO, from)
    if (idx < 0) break
    // The OSC-8 params end at the FIRST `;` after `ESC]8;` (i.e. `ESC]8;<params>;<url>`).
    const semi = s.indexOf(";", idx + OSC8_INTRO.length)
    if (semi < 0) {
      // Malformed/truncated OSC-8 introducer with no URL separator — treat as
      // not establishing a new open (the prior state stands).
      from = idx + OSC8_INTRO.length
      continue
    }
    // URL runs from just after that `;` to the sequence terminator (BEL or ST).
    const urlStart = semi + 1
    const bel = s.indexOf(BEL, urlStart)
    const st = s.indexOf(ST, urlStart)
    const ends = [bel, st].filter((n) => n >= 0)
    const urlEnd = ends.length > 0 ? Math.min(...ends) : s.length
    const url = s.slice(urlStart, urlEnd)
    open = url.length > 0 // non-empty URL ⇒ link opened; empty ⇒ link closed
    from = urlEnd
  }
  return open
}

/** Append an SGR reset iff the line leaves a style open, AND an OSC-8 close iff
 *  the line leaves a hyperlink open (idempotent — never double-resets, never
 *  pads plain text). Applied on EVERY return path so neither an unclosed SGR nor
 *  an unclosed OSC-8 hyperlink bleeds into the prompt. */
const withResetCorrection = (s: string): string => {
  let out = s
  if (hasOpenSgr(out)) out += SGR_RESET
  if (hasOpenHyperlink(out)) out += OSC8_CLOSE
  return out
}

/** Consume a complete ANSI escape starting at index `i` of `s` (which begins
 *  with ESC). Returns the end index (exclusive) of the whole sequence so the
 *  caller slices `[i, end)` as one indivisible token and never cuts mid-escape:
 *    - CSI  `ESC [ … <final 0x40-0x7E>` (SGR colors, cursor moves)
 *    - OSC  `ESC ] … (BEL | ST)`        (hyperlinks `ESC]8;;URL`, window title)
 *    - other `ESC <byte>` (covers the ST `ESC \\`) / a lone trailing ESC.
 *  An UNTERMINATED sequence consumes to end-of-string so it is emitted whole or
 *  dropped whole — never as a bare introducer. */
const CSI_FINAL = /[\x40-\x7e]/ // CSI terminator byte range 0x40–0x7E
const BEL = "\x07" // OSC terminator (alternative to ST)

/** End index (exclusive) of a CSI escape whose introducer `ESC[` starts at `i`. */
const csiEnd = (s: string, i: number): number => {
  let j = i + 2
  while (j < s.length && !CSI_FINAL.test(s[j] ?? "")) j++
  return j < s.length ? j + 1 : s.length // include final byte; else consume all
}

/** End index (exclusive) of an OSC escape whose introducer `ESC]` starts at `i`.
 *  Terminated by BEL or ST (`ESC \`); unterminated ⇒ consume to end-of-string. */
const oscEnd = (s: string, i: number): number => {
  let j = i + 2
  while (j < s.length) {
    if (s[j] === BEL) return j + 1
    if (s[j] === ESC && s[j + 1] === "\\") return j + 2
    j++
  }
  return s.length // unterminated OSC ⇒ consume whole (never leak bare ESC])
}

const escapeSeqEnd = (s: string, i: number): number => {
  const c = s[i + 1]
  if (c === "[") return csiEnd(s, i)
  if (c === "]") return oscEnd(s, i)
  return Math.min(i + 2, s.length) // other ESC<byte> / lone trailing ESC
}

/** Strip ALL ANSI escapes (CSI *and* OSC) to leave only visible text. The shared
 *  `@/ui` `stripAnsi` is SGR-only (`ESC[…m`), so it MISCOUNTS a line carrying an
 *  OSC hyperlink/title — leaving the URL in the "visible" width and cutting the
 *  status line mid-sequence (finding 4). This OSC-aware strip is the runner's
 *  width oracle. Exported so callers/tests measure rendered width consistently. */
export const stripStatusAnsi = (s: string): string => {
  let out = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === ESC) {
      i = escapeSeqEnd(s, i) // skip the whole escape (zero visible width)
      continue
    }
    out += s[i]
    i += 1
  }
  return out
}

/** Visible columns of `s`, OSC-aware (counts neither CSI nor OSC). */
export const statusVisibleWidth = (s: string): number => stripStatusAnsi(s).length

/** Truncate `line` to `width` VISIBLE columns, consuming each ANSI escape (CSI
 *  *and* OSC) as one indivisible token so a cut never splits a sequence. */
const truncateToWidth = (line: string, width: number): string => {
  let visible = 0
  let out = ""
  let i = 0
  while (i < line.length && visible < width) {
    if (line[i] === ESC) {
      const end = escapeSeqEnd(line, i)
      out += line.slice(i, end)
      i = end
      continue
    }
    out += line[i]
    visible += 1
    i += 1
  }
  return out
}

/**
 * Take the FIRST LINE of the command's stdout, leave ANSI intact, and truncate
 * to `width` VISIBLE columns. Reset-correction is applied on EVERY return path
 * (fits / width<=0 / truncated) so an unclosed SGR never bleeds into the prompt.
 * Pure. Exported for direct unit testing.
 */
export const formatStatusOutput = (stdout: string, width: number): string => {
  // First line only — split on the first newline (CR/LF tolerant).
  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? ""
  // No-truncation paths STILL get reset-correction (an unclosed SGR that "fits"
  // bleeds into the prompt just as badly as a truncated one). OSC-aware width
  // (NOT the SGR-only `visibleWidth`) so an OSC line isn't wrongly truncated.
  if (!Number.isFinite(width) || width <= 0) return withResetCorrection(firstLine)
  if (statusVisibleWidth(firstLine) <= width) return withResetCorrection(firstLine)
  return withResetCorrection(truncateToWidth(firstLine, width))
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

/** The structural subset of a default byte-stream reader the runner uses. Typed
 *  structurally so it is invariant to the `ReadableStream` impl (`stream/web` vs
 *  DOM) the tsconfig resolves; both expose `read()`/`releaseLock()`/`cancel()`. */
interface StatusStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  releaseLock(): void
  cancel(reason?: unknown): Promise<void>
}
export type StatusSpawner = (
  argv: readonly string[],
  opts: { readonly stdin: Uint8Array; readonly cwd?: string | undefined },
) => StatusSpawnHandle

/** The scrubbed env the status child receives. SECURITY (finding 5): a status
 *  command is operator-authored, but it must NEVER inherit the parent's API keys
 *  / tokens / secrets. We route through the SAME `scrubEnv` allowlist chokepoint
 *  the command-hooks feature uses (`@/runtime` → `DEFAULT_ENV_ALLOWLIST`: PATH /
 *  HOME / LANG / proxy vars only), so the leak is impossible by construction —
 *  ONE source of truth, not a re-invented denylist. Exported for direct testing. */
export const statusChildEnv = (): Record<string, string> => scrubEnv()

/** Real Bun.spawn-backed spawner. Args-based (NO `shell:true`), pipes stdin from
 *  the provided bytes, captures stdout, ignores stderr (a status script's noise
 *  must never pollute the prompt). The child env is the SCRUBBED allowlist
 *  ({@link statusChildEnv}) routed through the typed `spawnScrubbed` boundary —
 *  a parent-secret leak would be a tsc error, not a runtime hazard. */
const defaultSpawner: StatusSpawner = (argv, opts) => {
  const proc = bunScrubbedSpawner([...argv], {
    cwd: opts.cwd ?? process.cwd(),
    env: asScrubbedEnv(statusChildEnv()),
    stdout: "pipe",
    stderr: "ignore",
    // The payload bytes go on stdin (Bun.spawn accepts a Uint8Array directly).
    // Passed via `extra` because the typed `stdin` slot only models the pipe
    // MODE, not the byte source.
    extra: { stdin: opts.stdin },
  }) as {
    stdout: ReadableStream<Uint8Array> | null
    exited: Promise<number>
    kill: () => void
  }
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
  /** Test seam: override the ABSOLUTE wall-clock cap (ms). Defaults to
   *  {@link HARD_CAP_MS}. The runner ALWAYS settles within this bound even if the
   *  child never closes stdout / never exits (finding 6). Clamped to
   *  `(0, HARD_CAP_MS]` — a test may shorten it but never extend past the cap. */
  readonly hardCapMs?: number
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
  // ABSOLUTE wall-clock bound (finding 6). The runner MUST settle within this
  // even if the child never closes stdout AND never resolves `exited` — the
  // `Promise.all` below would otherwise hang forever past the soft timeout (the
  // soft timer only fires `kill()`, which a dead/uncooperative child ignores).
  const hardCapMs = Math.min(
    opts.hardCapMs !== undefined && Number.isFinite(opts.hardCapMs) && opts.hardCapMs > 0
      ? opts.hardCapMs
      : HARD_CAP_MS,
    HARD_CAP_MS,
  )
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

  // The hard-cap watchdog: a wall-clock race so a child that never closes stdout
  // / never exits can never wedge the prompt. On expiry it kills the child and
  // resolves to the degraded sentinel — independent of whether the stream/exit
  // promises ever settle.
  const HARD_CAP = Symbol("statusline-hard-cap")
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const capPromise = new Promise<typeof HARD_CAP>((resolve) => {
    capTimer = setTimeout(() => {
      handle.kill()
      resolve(HARD_CAP)
    }, hardCapMs)
  })

  // Own the reader at THIS scope so the hard-cap branch (and the `finally`) can
  // cancel it — finding (R4-5 #2): on the hard-cap return the `readAll` promise
  // never settles, so without an explicit cancel the reader-lock + the pending
  // `read()` promise leak (and a no-op `kill()` never closes the stream).
  // `reader.cancel()` releases the lock, signals the stream's `cancel()`, and
  // unblocks any pending `read()`.
  const reader: StatusStreamReader | undefined = handle.stdout?.getReader() as
    | StatusStreamReader
    | undefined
  // Track whether `readAll` already released the lock via its normal-drain path
  // (`done`). Once released the reader is DETACHED, and calling `.cancel()` on a
  // detached reader throws `ERR_INVALID_STATE` synchronously — so we only cancel
  // a STILL-ATTACHED reader (the orphaned / pending case finding #2 is about).
  let readerReleased = false
  // Best-effort cancel of the stdout reader; never throws (a status line must
  // not break the REPL). Idempotent — a no-op once the reader has drained/
  // released. `cancel()` releases the lock and resolves a pending `read()`.
  const cancelReader = (): void => {
    if (reader === undefined || readerReleased) return
    readerReleased = true
    try {
      // `cancel()` returns a promise; swallow both a sync throw and an async
      // rejection so a raced detach can never surface as an unhandled error.
      reader.cancel().catch(() => {})
    } catch {
      // best-effort (already detached / unsupported)
    }
  }
  try {
    const stdoutPromise = reader
      ? readAll(reader, () => {
          readerReleased = true
        })
      : Promise.resolve("")
    const work = Promise.all([stdoutPromise, handle.exited] as const)
    const raced = await Promise.race([work, capPromise])

    if (raced === HARD_CAP) {
      log.warn("statusLine command exceeded hard cap (never settled)", { hardCapMs })
      // Release the orphaned reader (lock + pending read) — see cancelReader.
      cancelReader()
      return { text: "", degraded: true }
    }
    const [stdout, exitCode] = raced

    if (timedOut) {
      log.warn("statusLine command timed out", { timeoutMs })
      cancelReader()
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
    cancelReader()
    return { text: "", degraded: true }
  } finally {
    clearTimeout(timer)
    if (capTimer !== undefined) clearTimeout(capTimer)
  }
}

/** Drain an already-acquired byte-stream reader to a UTF-8 string. The caller
 *  OWNS the reader (so it can `cancel()` on a hard-cap / timeout to release the
 *  lock and unblock a pending `read()`); we release the lock on normal drain and
 *  signal that release via `onReleased` so the owner skips a (now-illegal) cancel
 *  of the detached reader. */
const readAll = async (
  // Structural subset of a default stream reader — only the members we use. Typed
  // structurally (not the lib `ReadableStreamDefaultReader`) so it matches
  // whichever `ReadableStream` impl (`stream/web` vs DOM) the tsconfig resolves,
  // whose `getReader()` overloads otherwise widen `value` to `ArrayBufferView`.
  reader: StatusStreamReader,
  onReleased?: () => void,
): Promise<string> => {
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) chunks.push(value)
    }
  } finally {
    // Releasing a lock already released by `cancel()` is a no-op/throws on some
    // impls — guard it so a raced cancel never surfaces as an error.
    try {
      reader.releaseLock()
    } catch {
      // already released (e.g. via cancel) — fine
    }
    onReleased?.()
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
