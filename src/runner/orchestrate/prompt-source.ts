import type { ImageBlock } from "@/llm"

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
 *   1. `next(signal)` resolves with the next user prompt as a
 *      {@link PromptPayload}. Surfaces that don't support multi-modal input
 *      MAY return a plain string — see backward-compat note below.
 *   2. `next` resolves with `null` to signal LOOP EXIT — e.g. CLI typed
 *      `/exit`, WebSocket disconnected, IPC channel closed.
 *   3. `next` throws (or returns null) if the optional `signal` aborts mid-
 *      read — the surface owns the cancellation gesture (Ctrl+C, browser tab
 *      close, OS shutdown).
 *
 * BACKWARD-COMPAT (type widening — NO behavior change for existing surfaces):
 *
 *   A pre-multi-modal surface returns a `string`. The loop driver
 *   (`runInteractive`) normalizes that into `{ text: <string> }` BEFORE
 *   handing it to `runOnce`, so a CLI/Web/Tauri surface that only knows about
 *   `string` keeps compiling AND running byte-identically. Adding
 *   multi-modal support is an OPT-IN — return a structured
 *   {@link PromptPayload} from `next()` only when the surface has image
 *   blocks to attach to THIS turn.
 *
 * Adapter sketches:
 *
 *   - CLI: `apps/cli/repl.ts` wraps {@link readLine} (raw-line-reader). On
 *     `AbortError` it returns `null` so the outer loop exits cleanly. Inline
 *     `/image add <path>` slash queues an `ImageBlock`; the next `next()`
 *     returns `{ text, images: [...] }` and drains the queue.
 *
 *   - Web: an HTTP/WebSocket handler can wrap an async-iterable message bus.
 *     `next()` awaits the next inbound JSON `{ prompt: string }` envelope;
 *     channel close ⇒ `null`. Multi-modal: include a `{ text, images }`
 *     envelope instead.
 *
 *   - Tauri: bridge `invoke_user_prompt` events onto a Bun async generator
 *     in the parent process; `null` on channel teardown.
 *
 * NON-GOAL: line-editing UX (Tab completion, history, palette). That stays
 * in the surface (raw-line-reader, browser <input>, Tauri frontend).
 */

/**
 * Structured multi-modal prompt envelope. A surface that doesn't support
 * images returns a plain `string` (the original shape — backward-compat);
 * a multi-modal surface returns the object form so the loop driver attaches
 * the images to THIS turn's user message (drain semantics: images attach
 * once per `next()` call, not carried across turns by the driver).
 */
export type PromptPayload = string | { readonly text: string; readonly images?: ImageBlock[] }

export interface PromptSource {
  /**
   * Resolve the next user prompt as a {@link PromptPayload}, or `null` to
   * exit the interactive loop. If `signal` is supplied and aborts mid-read,
   * the implementation should either return `null` (preferred — clean loop
   * exit) or throw a domain-neutral error the loop driver swallows on
   * `signal.aborted`.
   */
  next(signal?: AbortSignal): Promise<PromptPayload | null>
}

/**
 * Normalize a {@link PromptPayload} into the `{ text, images }` shape the
 * loop driver feeds to `runOnce`. Pure: `string` ⇒ `{ text }`; structured
 * payload ⇒ returned verbatim with `images` defaulted to `[]`. Kept here
 * (next to the type) so every consumer normalizes identically.
 */
export const normalizePromptPayload = (
  p: PromptPayload,
): { text: string; images: ImageBlock[] } => {
  if (typeof p === "string") return { text: p, images: [] }
  return { text: p.text, images: p.images ?? [] }
}
