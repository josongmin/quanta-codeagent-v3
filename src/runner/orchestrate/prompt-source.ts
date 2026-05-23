/**
 * Surface-supplied prompt provider for interactive loops.
 *
 * The `@/runner` slice is Layer-2 surface-AGNOSTIC, so it must NOT know how a
 * line of user text is sourced. The CLI sources it via raw-mode keypress (Tab
 * completion, slash palette, Esc-Esc cancel); a future Web surface would
 * source it from a WebSocket `message` event; a Tauri surface would source it
 * from an IPC `invoke_user_prompt` channel. They all converge on the same
 * loop contract:
 *
 *   1. `next(signal)` resolves with the next user prompt as a string.
 *   2. `next` resolves with `null` to signal LOOP EXIT — e.g. CLI typed
 *      `/exit`, WebSocket disconnected, IPC channel closed.
 *   3. `next` throws (or returns null) if the optional `signal` aborts mid-
 *      read — the surface owns the cancellation gesture (Ctrl+C, browser tab
 *      close, OS shutdown).
 *
 * Adapter sketches:
 *
 *   - CLI: `apps/cli/repl.ts` wraps {@link readLine} (raw-line-reader). On
 *     `AbortError` it returns `null` so the outer loop exits cleanly.
 *
 *   - Web: an HTTP/WebSocket handler can wrap an async-iterable message bus.
 *     `next()` awaits the next inbound JSON `{ prompt: string }` envelope;
 *     channel close ⇒ `null`.
 *
 *   - Tauri: bridge `invoke_user_prompt` events onto a Bun async generator
 *     in the parent process; `null` on channel teardown.
 *
 * NON-GOAL: line-editing UX (Tab completion, history, palette). That stays
 * in the surface (raw-line-reader, browser <input>, Tauri frontend).
 */
export interface PromptSource {
  /**
   * Resolve the next user prompt, or `null` to exit the interactive loop.
   * If `signal` is supplied and aborts mid-read, the implementation should
   * either return `null` (preferred — clean loop exit) or throw a domain-
   * neutral error the loop driver swallows on `signal.aborted`.
   */
  next(signal?: AbortSignal): Promise<string | null>
}
