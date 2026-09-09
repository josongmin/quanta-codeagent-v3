/** ADR-0405 (A3) — edit-after-diagnostics auto-injection hook.
 *
 *  Registers a `post_tool_use` HANDLER on a {@link HookBus} that, after an
 *  edit-class tool runs, fetches LSP diagnostics for the edited file and pushes
 *  a {@link HookPromptInject} through the caller's `subagentPendingPrompt` port.
 *  The agent loop folds that injection into the NEXT turn's prompt via the
 *  EXISTING ADR-0133 mechanism — so the model immediately sees the type/lint
 *  errors its edit introduced, without an explicit `diagnostics` tool call.
 *
 *  ZERO changes to `dispatch.ts` / `loop.ts`: this rides entirely on the
 *  already-present `post_tool_use` fire (dispatch) + `subagentPendingPrompt`
 *  drain (loop). Default-OFF: a host that never calls `attachLspDiagnosticsHook`
 *  registers NO handler, so the bus + loop are byte-identical to today.
 *
 *  No-heuristics seam: this module owns NO tool-name knowledge. The caller
 *  injects `editTools` — a map of tool-name → path-extractor — so WHICH tools
 *  are "edit-class" and HOW to read the edited path from each tool's input is a
 *  caller decision (the composition root, which already knows the tool set).
 *  A tool not in the map is ignored (no diagnostics fetch).
 *
 *  Per-session client reuse: opening a fresh language server on every edit is
 *  wasteful (start + handshake per hook). The hook caches the opened
 *  {@link DiagnosticsSession} per language (keyed by file extension — same
 *  extension ⇒ same server), so N edits to same-language files share ONE
 *  server. The cache is disposed via the returned disposer (NOT per-hook).
 *
 *  Degrade-gracefully: `open()` returning `null` (no server / unsupported ext)
 *  or any `diagnostics()` throw is swallowed — a flaky LSP must NEVER break the
 *  turn. On error nothing is pushed and the handler returns no `promptHook`. */

import { extname } from "node:path"
import type { DiagnosticItem, DiagnosticsSession } from "@/tool"
import { formatDiagnostics } from "@/tool"
import type { HookBus, HookPromptInject } from "./hooks"

/** Push port — structurally the `AgentConfig.subagentPendingPrompt` slot. */
export interface PromptInjectPush {
  push: (entry: HookPromptInject) => unknown
}

/** Open a (possibly cached) diagnostics session for a file, or `null` when no
 *  server can handle it. Mirrors `DiagnosticsProvider.open` — the bridge wires
 *  the real LSP-backed one; tests inject a fake. */
export type OpenDiagnosticsSession = (
  filePath: string,
  cwd: string,
) => Promise<DiagnosticsSession | null>

export interface LspDiagnosticsHookOptions {
  /** Bus to register the `post_tool_use` handler on. */
  hooks: HookBus
  /** Where to push the resulting prompt injection (= `subagentPendingPrompt`). */
  push: PromptInjectPush
  /** tool-name → extractor(input) → edited file path (or `null` to skip). The
   *  ONLY source of edit-class tool knowledge — injected by the caller. */
  editTools: Map<string, (input: unknown) => string | null>
  /** Session opener (cached per language by this hook). */
  open: OpenDiagnosticsSession
  /** Workspace root passed to `open`. */
  cwd: string
}

/** Disposer — stops every cached language session. Idempotent. */
export interface LspDiagnosticsHookHandle {
  dispose(): Promise<void>
}

/** Render the injection text the model will read next turn. Kept terse — a
 *  one-line lead-in + the standard `formatDiagnostics` body (severity-sorted,
 *  1-based coords) so the surface matches the explicit `diagnostics` tool. */
const renderInjection = (path: string, diags: DiagnosticItem[]): string =>
  `Your last edit produced language-server diagnostics:\n${formatDiagnostics(path, diags)}`

export const attachLspDiagnosticsHook = (
  opts: LspDiagnosticsHookOptions,
): LspDiagnosticsHookHandle => {
  // Per-language session cache. Key = file extension (deterministic grouping:
  // same extension ⇒ same server). Value = the in-flight OPEN promise so
  // concurrent edits to the same language share ONE open (the bus serializes
  // handlers per emit, but a future parallel emitter must not double-open).
  const sessions = new Map<string, Promise<DiagnosticsSession | null>>()
  let disposed = false
  const stopped = new WeakSet<DiagnosticsSession>()

  const stopOnce = async (session: DiagnosticsSession | null): Promise<void> => {
    if (session === null || stopped.has(session)) return
    stopped.add(session)
    await session.stop().catch(() => undefined)
  }

  const sessionFor = (filePath: string): Promise<DiagnosticsSession | null> => {
    if (disposed) return Promise.resolve(null)
    const key = extname(filePath).toLowerCase()
    const existing = sessions.get(key)
    if (existing !== undefined) return existing
    let tracked: Promise<DiagnosticsSession | null>
    tracked = Promise.resolve(opts.open(filePath, opts.cwd)).then(
      (opened) => {
        if (opened === null && sessions.get(key) === tracked) sessions.delete(key)
        return opened
      },
      (err: unknown) => {
        if (sessions.get(key) === tracked) sessions.delete(key)
        throw err
      },
    )
    sessions.set(key, tracked)
    // Dispose may have started after the opening `if (disposed)` check.
    // If it already snapshotted this promise, it owns stop. If we re-inserted
    // after clear(), we own stop so the client cannot leak.
    if (disposed) {
      if (sessions.get(key) === tracked) sessions.delete(key)
      return tracked.then(
        async (opened) => {
          await stopOnce(opened)
          return null
        },
        () => null,
      )
    }
    return tracked
  }

  const pathOfEdit = (event: { name: string; input: unknown }): string | null => {
    if (disposed) return null
    const extract = opts.editTools.get(event.name)
    if (extract === undefined) return null
    try {
      const path = extract(event.input)
      return path === null || path === "" ? null : path
    } catch {
      return null
    }
  }

  const diagnosticsFor = async (path: string): Promise<DiagnosticItem[] | null> => {
    try {
      const session = await sessionFor(path)
      if (disposed || session === null) return null
      return await session.diagnostics(path)
    } catch {
      // Any LSP failure (spawn, handshake, request) is swallowed — a flaky
      // server must never turn a successful edit into a broken turn.
      return null
    }
  }

  opts.hooks.on("post_tool_use", async (event) => {
    const path = pathOfEdit(event)
    if (path === null) return
    const diags = await diagnosticsFor(path)
    if (diags === null || disposed || diags.length === 0) return
    opts.push.push({ injectAfterSystem: renderInjection(path, diags) })
  })

  return {
    dispose: async () => {
      disposed = true
      const pending = [...sessions.values()]
      sessions.clear()
      for (const p of pending) {
        await stopOnce(await p.catch(() => null))
      }
    },
  }
}
