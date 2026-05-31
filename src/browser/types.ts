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
  | { readonly kind: "navigation-denied"; readonly reason: string }
  | { readonly kind: "element-not-found"; readonly ref: string }
  | { readonly kind: "cdp-method-denied"; readonly method: string }
  | { readonly kind: "timeout"; readonly ms: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "closed" }

export interface BrowserStartOpts {
  readonly headless?: boolean
  readonly signal?: AbortSignal
}

export interface SnapshotOpts {
  readonly interactive?: boolean
  readonly maxDepth?: number
}

export interface TypeOpts {
  readonly clear?: boolean
  readonly submit?: boolean
  readonly signal?: AbortSignal
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
