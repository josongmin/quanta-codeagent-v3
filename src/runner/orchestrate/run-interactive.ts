import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import type { SessionMeta } from "@/session"
import { normalizePromptPayload, type PromptSource } from "./prompt-source"
import type { OrchestrateDeps, RunOnceInput } from "./run-once"
import { runOnce } from "./run-once"

/**
 * Surface-AGNOSTIC interactive loop orchestration.
 *
 * Extracted from `apps/cli/repl.ts` (the interactive branch of `runRepl`,
 * deferred from the R5 `runOnce` extraction). Lifts the surface-agnostic
 * essence — "while not aborted: get next prompt → runOnce → carry history
 * forward" — into Layer-2 so Web/Tauri surfaces can reuse the loop driver
 * without depending on `apps/cli`.
 *
 * BYTE-IDENTICAL invariant for the CLI surface:
 *   - Each iteration delegates to {@link runOnce} with the same arguments
 *     the CLI's `turn()` closure used to pass — so per-turn behavior (history
 *     append → runAgent → persistTurn → onTurnEnd) is unchanged.
 *   - History is carried verbatim from one turn to the next (the `messages`
 *     field of `RunOnceResult` becomes the next iteration's history input).
 *   - The optional `onTurnEnd` hook fires AFTER `runOnce` resolves and
 *     BEFORE the next prompt is solicited — matches the CLI dashboard render
 *     ordering.
 *   - Loop exits when `signal.aborted` OR `promptSource.next()` returns null.
 *     Either path is a clean return (no throw).
 *
 * NON-GOALS (kept in `apps/cli`):
 *   - Raw-line-reader / Tab completion / slash palette UX (CLI-only).
 *   - Status bar (vim-style; CLI-only).
 *   - Esc-Esc per-turn cancel (terminal keypress; CLI-only).
 *   - Shell-stream painter (CLI-only stderr live paint).
 *   - Slash command routing (`/exit`, `/skills`, …) — the surface should
 *     resolve `/exit` to a null `next()` (loop exit) and route other slash
 *     commands BEFORE handing the line to this driver.
 *
 * Adapter pattern (CLI):
 *
 *   const cliPromptSource: PromptSource = {
 *     next: async (signal) => {
 *       try {
 *         const line = (await readLine({ prompt: "› ", signal, … })).trim()
 *         if (line === "" ) return ""               // caller filters blanks
 *         if (line === "/exit" || line === "/quit") return null
 *         if (await tryRunReplSlash(line, slashCtx)) return ""  // handled
 *         return line
 *       } catch (e) {
 *         if (e instanceof AbortError) return null
 *         throw e
 *       }
 *     },
 *   }
 */

/** Inputs for {@link runInteractive}. All UI primitives stay in the surface;
 *  this driver only knows about typed config + a `PromptSource` port. */
export interface RunInteractiveInput {
  /** Per-turn deps as assembled by the surface (env → deps mapping is
   *  surface-specific). Re-used verbatim each iteration; the surface is
   *  responsible for any per-turn signal composition (e.g. CLI's Esc-Esc
   *  turn-scoped `AbortSignal.any([outer, turn])` lives in the surface's
   *  `turn()` wrapper, see `apps/cli/repl.ts`). */
  deps: OrchestrateDeps
  /** Build the final per-turn `AgentConfig` from `(messages, deps)`. Passed
   *  through to `runOnce` unchanged. */
  assembleConfig: RunOnceInput["assembleConfig"]
  /** Surface-supplied prompt source — see {@link PromptSource}. The driver
   *  treats a `null` resolution as "loop exit" and a non-null string as the
   *  next user prompt. Blank strings are forwarded verbatim — the surface
   *  is the right place to filter empty input if desired. */
  promptSource: PromptSource
  /** Conversation history at loop entry. Typically the result of the resume
   *  FSM (`@/runner/orchestrate#resolveResume`). Mutated through the loop:
   *  each turn's post-condition replaces this list with the new history. */
  history: Message[]
  /** Path-mode transcript save path (`--state <p>`). Default OFF (undefined).
   *  Forwarded to `runOnce` each iteration. */
  state: string | undefined
  /** Id-mode session meta resolved by the resume FSM. Default OFF.
   *  Forwarded to `runOnce` each iteration. */
  idMeta: SessionMeta | undefined
  /** Loop-scoped abort signal. The loop exits as soon as `signal.aborted`
   *  becomes true (either between turns or via the promptSource's own
   *  cancellation handling). */
  signal: AbortSignal
  /** Optional images attached to the FIRST iteration only (mirrors the CLI's
   *  `pendingImages` drain pattern: `--image <p>` seeds the first turn,
   *  subsequent turns are text-only — byte-identical for empty/undefined). */
  seedImages?: ImageBlock[]
  /** Optional post-turn hook for the surface to render metrics dashboards,
   *  update UI state, or persist external view models. Fires AFTER `runOnce`
   *  resolves and BEFORE the next prompt is solicited. */
  onTurnEnd?: (event: { outcome: AgentOutcome; messages: Message[] }) => void | Promise<void>
  /** Optional per-turn wrapper for surface concerns that need install/dispose
   *  AROUND each `runOnce` call — e.g. the CLI's Esc-Esc keypress listener
   *  (raw-mode terminal state to restore) and per-turn `AbortSignal.any([
   *  outer, turnAbort])` composition. Web/Tauri usually leave this undefined
   *  (no per-turn surface state). Default: identity (`run()`).
   *
   *  Contract:
   *   - The wrapper MUST call `run(turnDeps)` exactly once and return its
   *     resolution. If it suppresses the call, return `undefined`; the loop
   *     counts the iteration but does NOT update history.
   *   - Turn-scoped cancellation should return `{cancelled:true}` so the
   *     driver replays the turn payload (e.g. seed images) on the retry.
   *   - The wrapper is responsible for catch/return on surface-scoped aborts
   *     (e.g. Esc-Esc per-turn cancel). Unhandled throws bubble out of the
   *     driver to the surface's outer try/catch. */
  wrapTurn?: (
    run: (turnDeps: OrchestrateDeps) => Promise<{
      outcome: AgentOutcome
      messages: Message[]
    }>,
  ) => Promise<
    | { outcome: AgentOutcome; messages: Message[] }
    | { readonly cancelled: true }
    | undefined
  >
  /** Optional MCP clients to stop after the loop exits (mirrors the CLI's
   *  `shutdownMcp` in the `finally` of `runRepl`). Default empty. */
  mcpClients?: Array<{ stop: () => Promise<void> }>
}

/** Stop every MCP client, swallowing per-client errors. Mirrors the CLI's
 *  `shutdownMcp` shape. Extracted to keep `runInteractive` under the biome
 *  cognitive-complexity budget. */
const stopMcpClients = async (
  clients: ReadonlyArray<{ stop: () => Promise<void> }> | undefined,
): Promise<void> => {
  if (clients === undefined) return
  for (const c of clients) await c.stop().catch(() => undefined)
}

/**
 * Run the interactive REPL-style loop end-to-end. Returns when the loop
 * exits cleanly (either `signal.aborted` or `promptSource.next()` ⇒ null).
 * A `promptSource.next()` throw after the loop signal aborts is treated as a
 * clean exit; other prompt/read errors and errors thrown by `runOnce` bubble
 * up to the surface — the CLI's `turn()` wrapper paints a red error and
 * returns so the loop continues; a Web/Tauri surface might convert them to a
 * structured response and reconnect.
 */
export const runInteractive = async (input: RunInteractiveInput): Promise<void> => {
  const { deps, assembleConfig, promptSource, state, idMeta, signal } = input
  let history = input.history
  // First-turn image attachment (drained after the first call so subsequent
  // turns are text-only — byte-identical to today's CLI behavior).
  let pendingImages: ImageBlock[] = input.seedImages ?? []
  try {
    while (!signal.aborted) {
      let payload
      try {
        payload = await promptSource.next(signal)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
      if (payload === null || signal.aborted) return
      // Normalize: a surface that returns a plain string is widened into
      // `{ text, images: [] }` (backward-compat — pre-multi-modal `PromptSource`
      // implementations keep working byte-identically). A multi-modal surface
      // returns `{ text, images }`; we MERGE its per-turn images with the
      // first-turn `pendingImages` carryover so seed images (`--image` argv)
      // and inline `/image add` queues can coexist on the same turn.
      const { text: prompt, images: payloadImages } = normalizePromptPayload(payload)
      const seedImages = pendingImages
      pendingImages = []
      // First turn ⇒ seed + payload; subsequent turns ⇒ payload only.
      // Argv seed is drained on the first iteration; from there on, every
      // turn's images come ONLY from the per-call payload (single-shot
      // queue semantics — the surface is responsible for clearing the
      // queue after handing it to `next()`).
      const turnImages: ImageBlock[] =
        seedImages.length > 0 ? [...seedImages, ...payloadImages] : payloadImages
      const runTurn = async (
        turnDeps: OrchestrateDeps,
      ): Promise<{ outcome: AgentOutcome; messages: Message[] }> =>
        runOnce({
          deps: turnDeps,
          assembleConfig,
          history,
          prompt,
          ...(turnImages.length > 0 ? { pendingImages: turnImages } : {}),
          state,
          idMeta,
        })
      const result = input.wrapTurn ? await input.wrapTurn(runTurn) : await runTurn(deps)
      if (result && "cancelled" in result) {
        pendingImages = turnImages
        continue
      }
      // wrapTurn may swallow a per-turn cancel (e.g. CLI Esc-Esc); in that
      // case history stays unchanged and the loop solicits the next prompt.
      if (result === undefined) continue
      history = result.messages
      if (input.onTurnEnd) await input.onTurnEnd({ outcome: result.outcome, messages: history })
    }
  } finally {
    await stopMcpClients(input.mcpClients)
  }
}
