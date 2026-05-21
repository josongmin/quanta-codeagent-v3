import { escapeReminderBoundary } from "./prompt"

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
 *  absent so the renderer can skip the section without emitting a blank line. */
const renderActiveFile = (file: IdeSnapshot["activeFile"]): string | undefined => {
  if (file === undefined) return undefined
  const path = escapeReminderBoundary(file.path)
  return file.line !== undefined
    ? `## Active file: ${path}:${file.line}`
    : `## Active file: ${path}`
}

/** Render the `## Open tabs:` block (heading + one bullet per tab). Returns
 *  `undefined` when the list is absent or empty. */
const renderOpenTabs = (tabs: IdeSnapshot["openTabs"]): string[] | undefined => {
  if (!tabs || tabs.length === 0) return undefined
  const lines: string[] = ["## Open tabs:"]
  for (const tab of tabs) {
    const path = escapeReminderBoundary(tab.path)
    lines.push(tab.dirty === true ? `- ${path} [dirty]` : `- ${path}`)
  }
  return lines
}

/** Render the `## Selection in ...` block (heading + escaped body). Returns
 *  `undefined` when no selection is present. */
const renderSelection = (selection: IdeSnapshot["selection"]): string[] | undefined => {
  if (selection === undefined) return undefined
  const path = escapeReminderBoundary(selection.path)
  const [start, end] = selection.range
  const text = escapeReminderBoundary(selection.text)
  return [`## Selection in ${path} [${start}:${end}]:`, text]
}

/** Render the `## Diagnostics:` block (heading + one bullet per item). Returns
 *  `undefined` when the list is absent or empty. */
const renderDiagnostics = (diagnostics: IdeSnapshot["diagnostics"]): string[] | undefined => {
  if (!diagnostics || diagnostics.length === 0) return undefined
  const lines: string[] = ["## Diagnostics:"]
  for (const d of diagnostics) {
    const path = escapeReminderBoundary(d.path)
    const message = escapeReminderBoundary(d.message)
    lines.push(`- ${d.severity} ${path}:${d.line} — ${message}`)
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
