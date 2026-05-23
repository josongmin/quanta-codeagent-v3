import { readFileSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { errMessage } from "@/shared"
import { escapeBoundary } from "./untrusted"

/**
 * Defang BOTH boundary tag families a user-controlled fragment could forge:
 * the outer `<system-reminder>` wrapper (the rendered block is ultimately
 * prepended to a user message that may itself be inside a reminder downstream)
 * AND this block's own `<ide-context>` wrapper. A selection text or diagnostic
 * message carrying a literal `</ide-context>` would otherwise terminate THIS
 * block's wrapper and let the trailing payload read as out-of-band context —
 * the exact trust-boundary break the renderer's docstring promises against.
 *
 * This is now a thin alias over the canonical {@link escapeBoundary} helper
 * (`src/agent/untrusted.ts`) bound to the `ide-context` tag — the SINGLE
 * enforced path all untrusted fragments funnel through. `escapeBoundary`
 * always also defangs `system-reminder`, so the behavior is byte-identical to
 * the prior local form (`escapeReminderBoundary(s).replace(/<(\/?ide-context>)/gi,
 * "<\\$1")`): same backslash defang form (`<\/ide-context>` / `<\ide-context>`),
 * case-insensitive, casing preserved. */
const escapeContextBoundary = (s: string): string => escapeBoundary("ide-context", s)

/**
 * IDE context provider seam (ADR-0080).
 *
 * The loop has no way to know what file the human is currently editing, which
 * tabs are open, what text is selected, or which diagnostics the editor sees.
 * An IDE host (e.g. a future VS Code extension wired through the CLI/MCP) can
 * surface that snapshot per turn via an {@link IdeContextProvider} — the agent
 * then renders it as a deterministic `<ide-context>` block PREPENDED to the
 * user message body so the model sees fresh editor state for every turn.
 *
 * Hard rules (no heuristic, no fallback):
 *   - Provider returns {@link IdeSnapshot} or `null`. `null` ⇒ no IDE attached
 *     ⇒ nothing rendered. There is no inference of IDE state from anything
 *     else — `null` is the closed signal, not a default to recover from.
 *   - The {@link IdeSnapshot} shape is CLOSED: every field is optional but the
 *     surface is fixed. Hosts cannot smuggle ad-hoc data through an open bag.
 *   - Default OFF: with no `ideContextProvider` wired the loop is byte-
 *     identical to the pre-ADR path (no call, no allocation, no block).
 *
 * Reminder-boundary protection: file contents (active file path, selection
 * text, diagnostic messages, open-tab paths) are USER-CONTROLLABLE. Without
 * defang, an attacker-authored file could carry a literal `</system-reminder>`
 * inside its selection text and prematurely terminate the harness's per-turn
 * reminder wrapper, forging system-attributed instructions. Every user-supplied
 * fragment is funneled through {@link escapeReminderBoundary} before it lands
 * in the rendered block — the SAME helper the existing per-turn reminder uses,
 * so the defense is uniform across surfaces.
 *
 * Why prepend to the USER message (not the `<system-reminder>` tail): IDE
 * context is the user's local editor reality, not a harness reminder. Treating
 * it as user-side context preserves the trust boundary — the model knows it
 * came from the user's environment, not from the safety/honesty layer.
 */

/**
 * One frozen snapshot of the IDE state captured AT TURN ENTRY. Every field is
 * optional so a partially-wired IDE (only an active file, only tabs, etc.)
 * still renders something useful. Empty arrays = "the IDE reported nothing in
 * this category"; the renderer omits the section entirely in that case so the
 * model never sees "## Diagnostics: (none)" noise.
 */
export interface IdeSnapshot {
  readonly activeFile?: {
    readonly path: string
    readonly line?: number
  }
  readonly openTabs?: ReadonlyArray<{
    readonly path: string
    readonly dirty?: boolean
  }>
  readonly selection?: {
    readonly path: string
    readonly range: readonly [start: number, end: number]
    readonly text: string
  }
  readonly diagnostics?: ReadonlyArray<{
    readonly path: string
    readonly severity: "error" | "warning"
    readonly line: number
    readonly message: string
  }>
}

/**
 * Provider seam — implemented by the IDE host (e.g. a VS Code extension or
 * MCP bridge). The loop calls `snapshot(turnSignal)` ONCE per turn entry and
 * passes the abort signal so the provider can honor cancellation. Returning
 * `null` means "no IDE attached" — the loop renders nothing, no block in the
 * user message. Throws / rejections are caught at the boundary: the loop logs
 * via the existing observability sink and proceeds as if `null` (an IDE bug
 * must not crash the turn — this is a BOUNDARY between the agent runtime and
 * an external system, not a fallback for missing data).
 */
export interface IdeContextProvider {
  /** Return `null` when no IDE is attached. Snapshot is captured fresh per turn. */
  snapshot(signal: AbortSignal): Promise<IdeSnapshot | null>
}

/** True when the snapshot has no presentable content (every field absent or
 *  an empty array). Used by {@link renderIdeContext} to short-circuit to an
 *  empty string instead of rendering an empty `<ide-context>` wrapper. */
const isEmptySnapshot = (snapshot: IdeSnapshot): boolean => {
  if (snapshot.activeFile !== undefined) return false
  if (snapshot.openTabs && snapshot.openTabs.length > 0) return false
  if (snapshot.selection !== undefined) return false
  if (snapshot.diagnostics && snapshot.diagnostics.length > 0) return false
  return true
}

/** Render the `## Active file:` heading. Returns `undefined` when the field is
 *  absent so the renderer can skip the section without emitting a blank line.
 *  PR-4 self-audit fix: every interpolated field — including numeric `line`,
 *  union `severity`, tuple `range` — goes through `String(...)` +
 *  `escapeReminderBoundary` so a provider returning the wrong runtime shape
 *  (untyped JS host, `as any` cast) cannot forge `<system-reminder>` tags. */
const renderActiveFile = (file: IdeSnapshot["activeFile"]): string | undefined => {
  if (file === undefined) return undefined
  const path = escapeContextBoundary(file.path)
  return file.line !== undefined
    ? `## Active file: ${path}:${escapeContextBoundary(String(file.line))}`
    : `## Active file: ${path}`
}

/** Render the `## Open tabs:` block (heading + one bullet per tab). Returns
 *  `undefined` when the list is absent or empty. */
const renderOpenTabs = (tabs: IdeSnapshot["openTabs"]): string[] | undefined => {
  if (!tabs || tabs.length === 0) return undefined
  const lines: string[] = ["## Open tabs:"]
  for (const tab of tabs) {
    const path = escapeContextBoundary(tab.path)
    lines.push(tab.dirty === true ? `- ${path} [dirty]` : `- ${path}`)
  }
  return lines
}

/** Render the `## Selection in ...` block (heading + escaped body). Returns
 *  `undefined` when no selection is present. */
const renderSelection = (selection: IdeSnapshot["selection"]): string[] | undefined => {
  if (selection === undefined) return undefined
  const path = escapeContextBoundary(selection.path)
  const [start, end] = selection.range
  const startStr = escapeContextBoundary(String(start))
  const endStr = escapeContextBoundary(String(end))
  const text = escapeContextBoundary(selection.text)
  return [`## Selection in ${path} [${startStr}:${endStr}]:`, text]
}

/** Render the `## Diagnostics:` block (heading + one bullet per item). Returns
 *  `undefined` when the list is absent or empty. */
const renderDiagnostics = (diagnostics: IdeSnapshot["diagnostics"]): string[] | undefined => {
  if (!diagnostics || diagnostics.length === 0) return undefined
  const lines: string[] = ["## Diagnostics:"]
  for (const d of diagnostics) {
    const path = escapeContextBoundary(d.path)
    const message = escapeContextBoundary(d.message)
    const severity = escapeContextBoundary(String(d.severity))
    const line = escapeContextBoundary(String(d.line))
    lines.push(`- ${severity} ${path}:${line} — ${message}`)
  }
  return lines
}

/**
 * Deterministic renderer. Produces the closed `<ide-context>` block format:
 *
 * ```
 * <ide-context>
 * ## Active file: <path>:<line?>
 * ## Open tabs:
 * - <path> [dirty]
 * - <path>
 * ## Selection in <path> [start:end]:
 * <escaped text>
 * ## Diagnostics:
 * - error <path>:<line> — <message>
 * - warning <path>:<line> — <message>
 * </ide-context>
 * ```
 *
 * Sections are present ONLY when their field is present (and arrays non-
 * empty). `escapeReminderBoundary` is applied to every user-supplied text
 * fragment (paths, selection text, diagnostic messages) so a file's content
 * cannot forge `<system-reminder>` tags.
 *
 * `null` snapshot ⇒ empty string (caller prepends nothing).
 * Empty snapshot (every field absent/empty) ⇒ empty string.
 */
export const renderIdeContext = (snapshot: IdeSnapshot | null): string => {
  if (snapshot === null) return ""
  if (isEmptySnapshot(snapshot)) return ""

  const lines: string[] = ["<ide-context>"]
  const activeFile = renderActiveFile(snapshot.activeFile)
  if (activeFile !== undefined) lines.push(activeFile)
  const tabs = renderOpenTabs(snapshot.openTabs)
  if (tabs !== undefined) lines.push(...tabs)
  const selection = renderSelection(snapshot.selection)
  if (selection !== undefined) lines.push(...selection)
  const diagnostics = renderDiagnostics(snapshot.diagnostics)
  if (diagnostics !== undefined) lines.push(...diagnostics)
  lines.push("</ide-context>")
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────
// Concrete provider — `FileSystemIdeContextProvider` (ADR-0080 follow-up).
//
// In-repo wire path for IDE context. When no VS Code / Tauri extension is
// available, an external editor (or test harness) can still surface IDE
// state by writing `.quanta/ide-context.json` under the cwd. The provider
// reads that file on every `snapshot()` call (one read per turn entry —
// matches the per-turn capture contract) and converts the JSON into an
// {@link IdeSnapshot}.
//
// Provider-side promotion of L3 → L4:
//   - **Concrete in-repo wire path** — no external dependency, the agent
//     loop can be exercised end-to-end without a real editor.
//   - **Absolute → relative path normalisation** — selection/activeFile/
//     openTabs/diagnostics paths inside the file are normalised to be
//     RELATIVE to the provider's `cwd`. The rendered `<ide-context>` block
//     therefore never leaks `/Users/<name>/…` style paths into the model
//     context (privacy + reproducibility win — Cursor's pattern).
//   - **Dual-tier metadata** — the persisted metadata distinguishes user-
//     selected (`injected`, e.g. activeFile + selection) from AI-inferred
//     (`predicted`, e.g. heuristic open-tab recommendations). The JSON
//     schema lets the host author both; an absent `kind` defaults to
//     `injected` (the safe assumption — anything the JSON file declares
//     IS by definition user-surfaced data).
//   - **Metadata-only persistence** — the provider can be wired with an
//     optional `metadataSink` (a `StreamPort`-shaped callback) that
//     receives a SCRUBBED snapshot per turn — relative paths, line ranges,
//     diagnostic message LENGTHS — but never selection text or file
//     contents. The host wires this into the trajectory recorder.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Provenance tier for an IdeSnapshot. `injected` = explicitly authored by
 * the IDE host / user (the canonical case — anything in
 * `.quanta/ide-context.json`); `predicted` = inferred by an AI heuristic
 * (reserved for future ranking models — currently unused in the concrete
 * provider). Recorded in the persisted metadata, NEVER rendered into the
 * model context — the model sees a single block, the provenance is for the
 * observability layer alone.
 */
export type IdeContextTier = "injected" | "predicted"

/**
 * Metadata-only snapshot — what we record into the jsonl envelope. Crucially
 * EXCLUDES `selection.text` (file contents) so a persisted trajectory cannot
 * leak the source file through the snapshot record. Cursor's pattern: the
 * UI persists `{ relativeFilePath, range }`, never the full text.
 *
 * Paths are guaranteed RELATIVE — absolute paths from the host JSON are
 * normalised by the provider before this metadata is emitted.
 */
export interface IdeContextMetadata {
  /** Provenance — see {@link IdeContextTier}. */
  readonly tier: IdeContextTier
  /** Wall-clock ms at capture. */
  readonly capturedAtMs: number
  readonly activeFile?: { readonly relativeFilePath: string; readonly line?: number }
  readonly openTabs?: ReadonlyArray<{ readonly relativeFilePath: string; readonly dirty?: boolean }>
  /** Selection records relative path + range ONLY — `text` is dropped. */
  readonly selection?: {
    readonly relativeFilePath: string
    readonly range: readonly [start: number, end: number]
    /** Length of the original text in characters (for sizing audits). */
    readonly textLength: number
  }
  readonly diagnostics?: ReadonlyArray<{
    readonly relativeFilePath: string
    readonly severity: "error" | "warning"
    readonly line: number
    /** Length of the diagnostic message (for sizing audits) — NOT the
     *  message itself, which can carry user code fragments. */
    readonly messageLength: number
  }>
}

/** Sink for metadata-only persistence. Implementations write to the
 *  trajectory jsonl recorder, an OTel span, or simply collect for tests.
 *  MUST NOT throw — a sink bug must not crash the turn (boundary, same
 *  semantics as the provider's own throw-handling). */
export type IdeContextMetadataSink = (md: IdeContextMetadata) => void

/**
 * Normalise an arbitrary file path against a cwd. Absolute paths are made
 * relative; relative paths are returned unchanged. Path-traversal sequences
 * (`..`) are preserved on input but the result NEVER starts with `/` so a
 * downstream renderer doesn't accidentally leak a host-absolute prefix.
 */
export const toRelativePath = (cwd: string, path: string): string => {
  if (path === "") return ""
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path)
  // `relative('/a','/a')` returns ''; preserve the original basename in that
  // edge case so the rendered block still shows SOMETHING (the empty string
  // would silently drop the field downstream).
  return rel === "" ? "." : rel
}

/** Strip a snapshot's paths to relative + return a fresh snapshot. */
const toRelativeSnapshot = (cwd: string, snap: IdeSnapshot): IdeSnapshot => ({
  ...(snap.activeFile !== undefined
    ? {
        activeFile: {
          path: toRelativePath(cwd, snap.activeFile.path),
          ...(snap.activeFile.line !== undefined ? { line: snap.activeFile.line } : {}),
        },
      }
    : {}),
  ...(snap.openTabs !== undefined
    ? {
        openTabs: snap.openTabs.map((t) => ({
          path: toRelativePath(cwd, t.path),
          ...(t.dirty !== undefined ? { dirty: t.dirty } : {}),
        })),
      }
    : {}),
  ...(snap.selection !== undefined
    ? {
        selection: {
          path: toRelativePath(cwd, snap.selection.path),
          range: snap.selection.range,
          text: snap.selection.text,
        },
      }
    : {}),
  ...(snap.diagnostics !== undefined
    ? {
        diagnostics: snap.diagnostics.map((d) => ({
          path: toRelativePath(cwd, d.path),
          severity: d.severity,
          line: d.line,
          message: d.message,
        })),
      }
    : {}),
})

/**
 * Strip a snapshot down to its metadata projection — absolute paths normalised
 * to relative, selection text replaced with `textLength`, diagnostic messages
 * replaced with `messageLength`. Used by the persistence path so the
 * trajectory never carries raw editor contents.
 *
 * `tier` and `capturedAtMs` are injected by the caller (the provider knows
 * which tier the data is from + when it was captured). This function is pure
 * + safe to call without a provider.
 */
export const toMetadataSnapshot = (
  cwd: string,
  snap: IdeSnapshot,
  tier: IdeContextTier,
  capturedAtMs: number,
): IdeContextMetadata => ({
  tier,
  capturedAtMs,
  ...(snap.activeFile !== undefined
    ? {
        activeFile: {
          relativeFilePath: toRelativePath(cwd, snap.activeFile.path),
          ...(snap.activeFile.line !== undefined ? { line: snap.activeFile.line } : {}),
        },
      }
    : {}),
  ...(snap.openTabs !== undefined
    ? {
        openTabs: snap.openTabs.map((t) => ({
          relativeFilePath: toRelativePath(cwd, t.path),
          ...(t.dirty !== undefined ? { dirty: t.dirty } : {}),
        })),
      }
    : {}),
  ...(snap.selection !== undefined
    ? {
        selection: {
          relativeFilePath: toRelativePath(cwd, snap.selection.path),
          range: snap.selection.range,
          textLength: snap.selection.text.length,
        },
      }
    : {}),
  ...(snap.diagnostics !== undefined
    ? {
        diagnostics: snap.diagnostics.map((d) => ({
          relativeFilePath: toRelativePath(cwd, d.path),
          severity: d.severity,
          line: d.line,
          messageLength: d.message.length,
        })),
      }
    : {}),
})

/** Per-field parsers extracted from {@link parseIdeContextJson} so the root
 *  parser stays under the cognitive-complexity budget. Each helper validates
 *  shape + throws with a descriptive message on the first violation. */

const parseActiveFile = (raw: unknown): NonNullable<IdeSnapshot["activeFile"]> => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ide-context.activeFile: must be an object")
  }
  const a = raw as Record<string, unknown>
  if (typeof a.path !== "string") throw new Error("ide-context.activeFile.path: must be a string")
  return { path: a.path, ...(typeof a.line === "number" ? { line: a.line } : {}) }
}

const parseOpenTabs = (raw: unknown): NonNullable<IdeSnapshot["openTabs"]> => {
  if (!Array.isArray(raw)) throw new Error("ide-context.openTabs: must be an array")
  return raw.map((t, i) => {
    if (typeof t !== "object" || t === null) {
      throw new Error(`ide-context.openTabs[${i}]: must be an object`)
    }
    const x = t as Record<string, unknown>
    if (typeof x.path !== "string") {
      throw new Error(`ide-context.openTabs[${i}].path: must be a string`)
    }
    return { path: x.path, ...(typeof x.dirty === "boolean" ? { dirty: x.dirty } : {}) }
  })
}

const parseSelection = (raw: unknown): NonNullable<IdeSnapshot["selection"]> => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ide-context.selection: must be an object")
  }
  const x = raw as Record<string, unknown>
  if (typeof x.path !== "string") {
    throw new Error("ide-context.selection.path: must be a string")
  }
  if (!Array.isArray(x.range) || x.range.length !== 2) {
    throw new Error("ide-context.selection.range: must be a 2-element [start, end] array")
  }
  const [start, end] = x.range
  if (typeof start !== "number" || typeof end !== "number") {
    throw new Error("ide-context.selection.range: both endpoints must be numbers")
  }
  if (typeof x.text !== "string") {
    throw new Error("ide-context.selection.text: must be a string")
  }
  return { path: x.path, range: [start, end], text: x.text }
}

const parseDiagnosticItem = (
  raw: unknown,
  i: number,
): NonNullable<IdeSnapshot["diagnostics"]>[number] => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`ide-context.diagnostics[${i}]: must be an object`)
  }
  const x = raw as Record<string, unknown>
  if (typeof x.path !== "string") {
    throw new Error(`ide-context.diagnostics[${i}].path: must be a string`)
  }
  if (x.severity !== "error" && x.severity !== "warning") {
    throw new Error(`ide-context.diagnostics[${i}].severity: must be "error" or "warning"`)
  }
  if (typeof x.line !== "number") {
    throw new Error(`ide-context.diagnostics[${i}].line: must be a number`)
  }
  if (typeof x.message !== "string") {
    throw new Error(`ide-context.diagnostics[${i}].message: must be a string`)
  }
  return { path: x.path, severity: x.severity, line: x.line, message: x.message }
}

const parseDiagnostics = (raw: unknown): NonNullable<IdeSnapshot["diagnostics"]> => {
  if (!Array.isArray(raw)) {
    throw new Error("ide-context.diagnostics: must be an array")
  }
  return raw.map((d, i) => parseDiagnosticItem(d, i))
}

/** Validate + coerce a raw JSON object into an {@link IdeSnapshot}. Throws
 *  with a descriptive message on shape error so a typo in the JSON file is
 *  surfaced loudly (not silently rendered as an empty snapshot). */
const parseIdeContextJson = (raw: unknown): IdeSnapshot => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ide-context: root must be a JSON object")
  }
  const r = raw as Record<string, unknown>
  const out: { -readonly [K in keyof IdeSnapshot]: IdeSnapshot[K] } = {}
  if (r.activeFile !== undefined) out.activeFile = parseActiveFile(r.activeFile)
  if (r.openTabs !== undefined) out.openTabs = parseOpenTabs(r.openTabs)
  if (r.selection !== undefined) out.selection = parseSelection(r.selection)
  if (r.diagnostics !== undefined) out.diagnostics = parseDiagnostics(r.diagnostics)
  return out
}

/** Construction options for {@link FileSystemIdeContextProvider}. */
export interface FileSystemIdeContextProviderOpts {
  /** Working directory used for relative-path normalisation + JSON file
   *  resolution. Required so the provider has a deterministic root regardless
   *  of `process.cwd()` drift in long-running daemons. */
  cwd: string
  /** Override the JSON file path. Default `<cwd>/.quanta/ide-context.json`. */
  contextFile?: string
  /** Optional metadata sink — receives a SCRUBBED snapshot per `snapshot()`
   *  call. The host wires this into the trajectory recorder; if absent, the
   *  provider is purely render-side (no persistence). */
  metadataSink?: IdeContextMetadataSink
  /** Wall-clock ms (inject for deterministic tests). */
  now?: () => number
  /** File reader (inject for tests / non-fs hosts). Default `node:fs.readFileSync`. */
  read?: (path: string) => string | null
}

/**
 * Concrete in-repo IDE context provider — reads `.quanta/ide-context.json`
 * per turn (or a host-overridden path). Absent file ⇒ `null` snapshot (no
 * IDE attached signal). Malformed JSON ⇒ throw (the loop catches at the
 * boundary, emits an `error` event, and proceeds with no block).
 *
 * Why a JSON file (not a socket / pipe / env var)?
 *   - The file is hand-editable for ad-hoc debugging.
 *   - It survives process restarts (daemon mode benefit).
 *   - A host can atomically swap it (write-then-rename) without coupling
 *     to a runtime IPC channel.
 *   - The agent loop already reads files for skills + AGENTS.md — no new
 *     I/O primitive.
 *
 * Concurrency: `snapshot()` does ONE `readFileSync`. If the host writes
 * concurrently using rename-after-write the read either sees the old
 * complete file or the new complete file — never a torn read.
 *
 * Negative invariants (mirror the seam's own — preserved here):
 *   - The provider does NOT cache across turns. Each `snapshot()` reads the
 *     file fresh — the host is the source of truth.
 *   - The provider does NOT widen `IdeSnapshot` (closed shape). Dual-tier
 *     provenance is recorded in the METADATA only.
 */
export class FileSystemIdeContextProvider implements IdeContextProvider {
  private readonly cwd: string
  private readonly contextFile: string
  private readonly metadataSink: IdeContextMetadataSink | undefined
  private readonly now: () => number
  private readonly read: (path: string) => string | null
  /** Visible to tests — count of `snapshot()` invocations. */
  calls = 0

  constructor(opts: FileSystemIdeContextProviderOpts) {
    this.cwd = opts.cwd
    this.contextFile = opts.contextFile ?? `${opts.cwd}/.quanta/ide-context.json`
    this.metadataSink = opts.metadataSink
    this.now = opts.now ?? (() => Date.now())
    this.read =
      opts.read ??
      ((p): string | null => {
        try {
          return readFileSync(p, "utf8")
        } catch (e) {
          if (e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT") {
            return null
          }
          throw e
        }
      })
  }

  async snapshot(signal: AbortSignal): Promise<IdeSnapshot | null> {
    this.calls += 1
    if (signal.aborted) return null
    const raw = this.read(this.contextFile)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(`ide-context: JSON parse failed at ${this.contextFile}: ${errMessage(e)}`)
    }
    const snap = parseIdeContextJson(parsed)
    const relative = toRelativeSnapshot(this.cwd, snap)
    // Persist metadata-only BEFORE returning so the recorder sees the
    // capture for THIS turn even if the loop later aborts. Sink failures
    // are absorbed (boundary contract) — a broken sink must not crash the
    // turn.
    if (this.metadataSink !== undefined) {
      try {
        this.metadataSink(toMetadataSnapshot(this.cwd, snap, "injected", this.now()))
      } catch {
        // sink bug ⇒ swallow (boundary)
      }
    }
    return relative
  }
}
