/**
 * Browser slice — shared types (ADR-0427, jun-1-browser-automation).
 *
 * Plane-clean: this file imports nothing outside the slice. The browser is an
 * EXECUTION CHANNEL, not a tool and not a permission — tool-ization + security
 * gating live in `src/tool/browser/`, never here.
 *
 * `DomModel` is the SERIALIZED page perception handed to the pure
 * {@link `./snapshot`.buildSnapshot} — the adapter collects it (non-deterministic
 * IO), the pure function renders it (byte-stable). This split is what lets the
 * snapshot be hellgate-tested with fixtures.
 */

/** Opaque browser session identity. The adapter owns spawn/kill; the surface
 *  passes this back to `close()` unchanged. Internal process/socket state is
 *  kept in an adapter-side map keyed by `id`, NOT on this handle (keeps it
 *  serializable + leak-free). */
export interface BrowserHandle {
  readonly id: string
  readonly backend: string
}

/** Closed failure union — every {@link BrowserPort} method returns this in the
 *  `Err` arm. No throws: a programmer-bug input is also an `Err`. */
export type BrowserError =
  | { readonly kind: "backend-missing" }
  | { readonly kind: "spawn-failed"; readonly detail: string }
  // Produced by the headless stub (unknown fixture url) and reserved for a
  // future in-port navigation policy; the production tool layer denies SSRF/
  // protocol BEFORE calling the port and yields its own permission_denied
  // result, so the real CDP navigate path does not currently emit this (R2 [19]).
  | { readonly kind: "navigation-denied"; readonly reason: string }
  | { readonly kind: "element-not-found"; readonly ref: string }
  | { readonly kind: "cdp-method-denied"; readonly method: string }
  | { readonly kind: "cdp-error"; readonly detail: string }
  | { readonly kind: "timeout"; readonly ms: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "closed" }

export interface BrowserStartOpts {
  // The adapter always launches `--headless=new`; a headed mode + its flag are
  // a Phase-2 concern (R1 audit [2] — no dead `headless` field until honored).
  readonly signal?: AbortSignal
}

export interface SnapshotOpts {
  readonly interactive?: boolean
  readonly maxDepth?: number
}

export interface TypeOpts {
  readonly clear?: boolean
  readonly signal?: AbortSignal
}

export type ScrollDirection = "up" | "down" | "left" | "right"

export interface ScrollOpts {
  /** Scroll a specific element into view (ref from a snapshot); else scroll the page. */
  readonly ref?: string
  readonly direction?: ScrollDirection
  /** Pixels to scroll (default 400). Ignored when `ref` is set. */
  readonly amount?: number
}

/** Drag destination — either another snapshot ref or absolute viewport coords. */
export type DragTarget = { readonly ref: string } | { readonly x: number; readonly y: number }

/** Console log level — `consoleAPICalled.type` is normalized into this closed
 *  set; an uncaught exception maps to `error`; a `Log.entryAdded` keeps its own
 *  level. Anything unrecognized falls back to `log`. */
export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug"

/** One captured console / error entry. `text` is PAGE-CONTROLLED (untrusted) —
 *  the tool layer routes it through `guardPageText` before the model sees it. */
export interface ConsoleEntry {
  readonly level: ConsoleLevel
  readonly text: string
  readonly ts?: number
}

export interface ConsoleOpts {
  /** Drain the ring buffer (and reset the dropped counter) after reading. */
  readonly clear?: boolean
}

export interface WaitOpts {
  readonly selector: string
  /** Poll budget before `Err{timeout}` (default 5000). */
  readonly timeoutMs?: number
}

/** What `read` extracts from the resolved element. */
export type ReadWhat = "text" | "attribute" | "visible"

export interface ReadOpts {
  readonly what: ReadWhat
  /** Required when `what === "attribute"`. */
  readonly attr?: string
}

/** A single accessibility-tree node, already normalized by the in-page
 *  collector (name capped, hidden nodes dropped, iframes excluded). */
export interface DomNode {
  /** Stable identity within ONE page render (DOM tree path). Input to ref
   *  assignment — NOT exposed to the model. */
  readonly backendPath: string
  readonly role: string
  readonly name: string
  readonly tag?: string
  readonly states?: readonly string[]
  readonly value?: string
  readonly placeholder?: string
  /** Heading level 1-6 for h1..h6 / role=heading. */
  readonly level?: number
  readonly url?: string
  readonly children?: readonly DomNode[]
}

export interface DomModel {
  readonly title: string
  readonly root: DomNode
}

/** Rendered perception returned to the tool layer (which then routes it through
 *  `escapeReminderBoundary` + `capToolOutput` before the model sees it). */
export interface PageSnapshot {
  readonly yaml: string
  readonly url: string
  readonly title: string
}
