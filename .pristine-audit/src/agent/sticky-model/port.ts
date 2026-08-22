/**
 * Sticky model-per-mode port (ADR-0212).
 *
 * The closed-port surface for the sticky-model store. A store remembers the
 * last-chosen `modelId` for each `AgentMode` so that the user's choice of
 * "use gpt-5 for plan mode, use a fast model for editor mode" survives
 * across turns and sessions.
 *
 * Pure-by-contract for the IN-MEMORY default impl; the fs-backed impl
 * (separate file) performs IO and is the only port surface allowed to
 * touch disk. The {@link StickyModelResolver} composes the store with the
 * caller's explicit override + global default — its result is the
 * effective modelId for the current mode.
 *
 * No-throw public surface: every store method returns Promises that
 * RESOLVE with a typed result rather than reject. Corruption / IO errors
 * surface via {@link StickyModelLoadResult.error} so the resolver can fall
 * back to the global default deterministically.
 */

import type { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"

/** The sticky-model store port. Two methods: read a per-mode modelId,
 *  write one. Reads return `undefined` (NOT throw) when no entry exists —
 *  "no preference yet" is the canonical empty state. */
export interface StickyModelStore {
  /** Return the sticky modelId for `mode`, or `undefined` if no entry
   *  exists (no preference). MUST NOT throw on IO errors — implementations
   *  surface those via the {@link load} method instead so the read path is
   *  always quick and predictable. */
  get(input: { readonly mode: AgentMode }): Promise<string | undefined>
  /** Record a sticky modelId for `mode`. Idempotent — writing the same
   *  value twice is a no-op. MUST NOT throw on IO errors; implementations
   *  surface those via the returned {@link StickyModelSetResult}. */
  set(input: { readonly mode: AgentMode; readonly modelId: string }): Promise<StickyModelSetResult>
  /** Snapshot the whole store as a plain map. Used by `/status` and tests.
   *  Never throws; returns an empty record on IO error (with the error
   *  payload in {@link StickyModelLoadResult}). */
  load(): Promise<StickyModelLoadResult>
}

/** Result of {@link StickyModelStore.set}. `ok` discriminates success vs. a
 *  recorded IO error; the error is a {@link QuantaError} subclass so the
 *  caller's typed-error union holds. */
export type StickyModelSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: QuantaError }

/** Result of {@link StickyModelStore.load}. `ok=true` carries the snapshot;
 *  `ok=false` carries the typed error AND an empty snapshot so callers
 *  defensively reading `result.snapshot` always get a Record. */
export type StickyModelLoadResult =
  | { readonly ok: true; readonly snapshot: Readonly<Record<string, string>> }
  | {
      readonly ok: false
      readonly snapshot: Readonly<Record<string, string>>
      readonly error: QuantaError
    }

/** Sticky-model resolver port (ADR-0212). Compose the store with the
 *  explicit caller override and the global default in ONE call site so
 *  precedence is enforced by ONE function, not by every caller. */
export interface StickyModelResolver {
  /** Resolve the effective modelId for `mode`. Precedence:
   *    1. `explicitOverride` (caller-supplied; user CLI flag, slash command)
   *    2. sticky store entry for `mode`
   *    3. `globalDefault`
   *
   *  `globalDefault` is REQUIRED — the resolver never returns `undefined`.
   *  Any IO error from the store falls through to the global default
   *  silently (recorded via the store's `load()` result for callers that
   *  want to observe). */
  resolve(input: {
    readonly mode: AgentMode
    readonly globalDefault: string
    readonly explicitOverride?: string
  }): Promise<string>
}
