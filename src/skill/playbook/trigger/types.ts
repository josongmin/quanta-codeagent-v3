/**
 * Inline-trigger sub-slice TYPES (ADR-0250).
 *
 * Why a separate slice from the sibling `inline-trigger-watcher.ts`?
 *
 * - The sibling (`../inline-trigger-watcher.ts`, born with ADR-0203) is a
 *   per-playbook-spec watcher — one root, one glob, one marker, callback
 *   bound at start time. It exists to drive `auto-dispatch`.
 * - THIS sub-slice (ADR-0250) is the smaller, composable primitive: scan
 *   ANY saved file under ANY of N roots for ANY of M markers and emit a
 *   typed `TriggerEvent` to a single shared callback. The same primitive
 *   the ADR-0203 playbook plays on TOP of — and that downstream hosts
 *   (status flash, repl, side-conv) reach for directly when they want a
 *   plain `AIDER!`/`CLAUDE!`/`QUANTA!`/`TODO!` source-comment hook
 *   without dragging in the full playbook envelope.
 *
 * Slice discipline (leaf-level): types live here, depending only on
 * runtime-free `node:*`-style primitives. NO imports from @/agent,
 * @/tool, @/permission, @/storage, or even the sibling `../port.ts` /
 * `../types.ts` — the playbook frontmatter pulls THIS shape via its
 * own narrowing if it wants, not the reverse.
 *
 * Default-OFF posture: this slice ships behind an explicit `watch()`
 * call. No production code path constructs the watcher unless a host
 * wires it. Byte-identical pre-/post-landing is verified by
 * HELL-IT-12 in `inline-trigger-hellgate.test.ts`.
 */

/**
 * Result of a single comment-marker hit in a scanned file.
 *
 * `line` is 1-based (same convention {@link findMarkerLine} in the
 * sibling watcher uses, and what every IDE renders in its gutter).
 */
export interface TriggerEvent {
  /** Absolute path of the file that contained the marker. */
  readonly file: string
  /** The literal marker substring that matched (so the host can route). */
  readonly marker: string
  /** 1-based line number of the FIRST occurrence of `marker` in `file`. */
  readonly line: number
}

/**
 * Discriminated union of operational failures. Public watcher surfaces
 * NEVER throw — they surface failure as `{ ok: false, error }` so the
 * caller can render a typed reason (the same pattern the sibling
 * `InlineTriggerWatcherPort` uses for its `start` result).
 *
 * - `root-missing`   — supplied root does not exist or is not a directory.
 * - `watch-failed`   — fs.watch threw (EMFILE, ENOSPC, EPERM, etc.).
 * - `unsupported-encoding` — file was not UTF-8 decodable (treated as
 *   binary; the caller may surface a debug log but the scan is dropped
 *   silently in the watcher hot-path).
 */
export type TriggerError =
  | { readonly kind: "root-missing"; readonly root: string }
  | { readonly kind: "watch-failed"; readonly root: string; readonly detail: string }
  | { readonly kind: "unsupported-encoding"; readonly file: string }

/**
 * Default debounce window (milliseconds) for coalescing same-file fires.
 *
 * 100ms was picked because the hellgate pins it (HELL-IT-07). The window
 * MUST be longer than a typical editor's atomic-write rename burst
 * (`.tmp` → rename, which fires `fs.watch` twice in ~5-30ms) but short
 * enough that a user editing the same file in two keystrokes still gets
 * two scans, not one. The sibling watcher uses 200ms; this slice opts
 * for 100ms because the scanner is pure + cheap — there's less reason
 * to coalesce aggressively.
 */
export const DEFAULT_DEBOUNCE_MS = 100
