/**
 * C1 — Canvas / artifact persistence store (backlog §7).
 *
 * A session-scoped registry for NON-CODE artifacts — the binary outputs of the
 * generation axis (`image_gen` PNGs, `xlsx_write`/`docx_write`/`pptx_write`
 * Office files) live OUTSIDE the transcript. An agent registers each artifact
 * once → gets a stable id + a preview URL → references / lists / destroys it by
 * id instead of pasting bytes back into the conversation.
 *
 * Reference: Cursor `agent.v1.Canvas{Register, GetUrl, Destroy}`.
 *
 * Slice posture (RFC §3.1): PURE leaf — imports only `@/shared` (byteCompare for
 * deterministic ordering). NO clock / RNG inside: the registry takes an injected
 * `now()` + `idFactory()` so the core is byte-deterministically testable (mirrors
 * the no-sketchy-code discipline — no `Date.now()` / `Math.random()` here).
 * NO-THROW: every method returns a value, never throws.
 *
 * DEFAULT-OFF: nothing constructs a registry unless the host opts in
 * (`QUANTA_ARTIFACT_STORE`); an unset deployment never instantiates it and the
 * artifact tools surface a typed `not_wired` failure ⇒ byte-identical.
 */

import { byteCompare } from "@/shared"

/** Closed artifact-kind vocabulary. `other` is the escape hatch; the generation
 *  tools map to the specific kinds. */
export type ArtifactKind = "image" | "spreadsheet" | "document" | "presentation" | "other"

/** All kinds in stable order — for exhaustiveness + drift guards. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "image",
  "spreadsheet",
  "document",
  "presentation",
  "other",
]

/** A registered artifact. `id` is registry-minted; `path` is the on-disk
 *  (jailed) location the producing tool wrote; `createdAt` is caller-supplied
 *  (the injected clock). */
export interface Artifact {
  readonly id: string
  readonly kind: ArtifactKind
  readonly path: string
  readonly mediaType: string
  readonly label?: string
  readonly createdAt: number
}

/** Caller spec for {@link ArtifactRegistry.register} — everything but the
 *  registry-owned `id` + `createdAt`. */
export interface ArtifactSpec {
  readonly kind: ArtifactKind
  readonly path: string
  readonly mediaType: string
  readonly label?: string
}

/** The artifact-store port. Pure in-memory default below; a future disk-backed
 *  impl can satisfy the same contract. NO-THROW. */
export interface ArtifactRegistry {
  /** Register a new artifact; mints + returns it (with id + createdAt). */
  register(spec: ArtifactSpec): Artifact
  /** Look up by id, or undefined. */
  get(id: string): Artifact | undefined
  /** All artifacts, insertion-ordered, as an immutable snapshot. */
  list(): readonly Artifact[]
  /** Remove by id; true when something was removed, false for an unknown id. */
  destroy(id: string): boolean
}

/** The preview-URL scheme. A stable opaque reference the model/host can resolve
 *  to the artifact (the host maps `quanta-artifact://<id>` → the jailed path /
 *  a served preview). Chosen over a bare `file://` so the reference stays valid
 *  even if the file is later moved, and never leaks the absolute fs path into
 *  the transcript. PURE. */
export const ARTIFACT_URL_SCHEME = "quanta-artifact://"
export const previewUrl = (artifact: Artifact): string => `${ARTIFACT_URL_SCHEME}${artifact.id}`

/**
 * Default upper bound on live registry entries. A long session that keeps
 * generating artifacts (every `*_write` / `image_gen` best-effort registers one)
 * must NOT grow the in-memory store without bound — that is a slow memory leak
 * AND a `list()` token-explosion vector. At the cap the OLDEST-inserted entry is
 * FIFO-evicted (its id deterministically falls out of `get` / `list` as a clean
 * not-found; a tool reference to it yields the normal `not_found` failure, never
 * a crash). 1000 generated artifacts in one session is already far past any real
 * workflow; the cap is injectable so a host can tune it.
 */
export const DEFAULT_ARTIFACT_REGISTRY_MAX = 1000

export interface ArtifactRegistryOptions {
  /** Injected clock — the ONLY time source (no `Date.now()` in the core). */
  readonly now: () => number
  /** Injected id factory — deterministic in tests; the default host impl uses a
   *  monotonic counter + a host-supplied prefix (no `Math.random()` here). */
  readonly idFactory: () => string
  /** UNBOUNDED-GROWTH guard. Max live entries before the oldest-inserted is
   *  FIFO-evicted on the next `register`. Absent ⇒ {@link DEFAULT_ARTIFACT_REGISTRY_MAX}.
   *  A non-finite / <1 value clamps to 1 (the store always holds at least the
   *  most-recent artifact; it can never be a no-op store nor grow without bound). */
  readonly maxEntries?: number
}

/**
 * In-memory {@link ArtifactRegistry}. One instance per session. Insertion order
 * preserved (a `Map` iterates in insertion order); `list()` returns a frozen
 * snapshot sorted by `createdAt` then `id` (`byteCompare`) so ties are
 * deterministic regardless of insertion timing.
 *
 * BOUNDED: at most {@link ArtifactRegistryOptions.maxEntries} live entries — a
 * `register` at the cap FIFO-evicts the oldest-inserted artifact first, so a
 * long generation-heavy session cannot leak memory or explode `list()` output.
 * An evicted id is a clean not-found on `get` (no throw); `destroy` frees a slot
 * immediately so destroyed artifacts never count toward the cap.
 */
export const createArtifactRegistry = (opts: ArtifactRegistryOptions): ArtifactRegistry => {
  const store = new Map<string, Artifact>()
  // Clamp the cap to a finite integer >= 1. A non-finite / <1 cap would either
  // overflow (never evict) or zero out the store; both are defects. Min 1 keeps
  // the most-recent artifact always retrievable.
  const cap = (() => {
    const m = opts.maxEntries
    if (m === undefined || !Number.isFinite(m)) return DEFAULT_ARTIFACT_REGISTRY_MAX
    return Math.max(1, Math.floor(m))
  })()
  return {
    register(spec) {
      const artifact: Artifact = {
        id: opts.idFactory(),
        kind: spec.kind,
        path: spec.path,
        mediaType: spec.mediaType,
        ...(spec.label !== undefined ? { label: spec.label } : {}),
        createdAt: opts.now(),
      }
      // UNBOUNDED-GROWTH guard: evict oldest-inserted entries until inserting
      // the new one stays within the cap. A `while` (not `if`) is defensive in
      // case the cap was somehow shrunk; Map iteration order is insertion order
      // so `keys().next()` is the FIFO head. A forged/duplicate id that collides
      // with an existing key OVERWRITES it (Map.set) — no double-count, no leak.
      if (!store.has(artifact.id)) {
        while (store.size >= cap) {
          const oldest = store.keys().next().value
          if (oldest === undefined) break
          store.delete(oldest)
        }
      }
      store.set(artifact.id, artifact)
      return artifact
    },
    get(id) {
      return store.get(id)
    },
    list() {
      return [...store.values()].sort(
        (a, b) => a.createdAt - b.createdAt || byteCompare(a.id, b.id),
      )
    },
    destroy(id) {
      return store.delete(id)
    },
  }
}

/** Default host id factory: a monotonic counter behind a caller prefix
 *  (`art-1`, `art-2`, …). Stable + collision-free within a session WITHOUT a
 *  clock or RNG. The composition root calls this once per session. */
export const monotonicIdFactory = (prefix = "art"): (() => string) => {
  let n = 0
  return () => {
    n += 1
    return `${prefix}-${n}`
  }
}
