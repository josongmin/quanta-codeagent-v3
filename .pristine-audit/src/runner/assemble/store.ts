import { CachingEmbedder, OpenAIEmbedder } from "@/agent"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort, SqliteStore } from "@/memory"

/**
 * Surface-agnostic store + embedder assembly. No env reads — the surface
 * resolves the requested kind/path/embedder model and passes a typed input.
 */

/** Inputs to {@link buildStoreCore}. Three states:
 *   - `kind: "sqlite"` → on-disk SqliteStore (path or default).
 *   - `kind: "memory"` → volatile InMemoryStore.
 *   - `kind: undefined` (or anything else) → no store. */
export interface StoreAssembleInput {
  /** `QUANTA_MEMORY` equivalent — `"sqlite" | "memory" | undefined`. */
  kind?: string | undefined
  /** SqliteStore path. Ignored when `kind !== "sqlite"`. Defaults to
   *  `.quanta/memory.sqlite` when omitted (same as prior CLI default). */
  path?: string | undefined
}

/** Build the long-term memory store. Default OFF so plain runs are unchanged:
 *  `kind="sqlite"` → on-disk SqliteStore; `kind="memory"` → volatile
 *  InMemoryStore; otherwise (incl. undefined) → no store. */
export const buildStoreCore = (input: StoreAssembleInput): PersistentStorePort | undefined => {
  if (input.kind === "sqlite") {
    return new SqliteStore(input.path ?? ".quanta/memory.sqlite")
  }
  if (input.kind === "memory") return new InMemoryStore()
  return undefined
}

/** Inputs to {@link buildEmbedderCore}. The embedder is on only when:
 *   - a `store` exists, AND
 *   - `disabled !== true`, AND
 *   - an `apiKey` is provided.
 *  All three are surface-agnostic mirrors of the prior env-driven gates
 *  (`QUANTA_MEMORY_EMBED=off`, `OPENAI_API_KEY` presence). */
export interface EmbedderAssembleInput {
  store: PersistentStorePort | undefined
  /** Equivalent of `QUANTA_MEMORY_EMBED === "off"` — surface decides the gate
   *  semantics. */
  disabled?: boolean
  /** OpenAI api key. Absent ⇒ no embedder (preserves the prior gate). */
  apiKey?: string | undefined
  /** Optional OpenAI base-URL override (`OPENAI_BASE_URL`). */
  baseURL?: string | undefined
  /** Optional embedding-model override (`QUANTA_MEMORY_EMBED_MODEL`). */
  model?: string | undefined
}

/** Build the semantic embedder. Default OFF so lexical-only recall is
 *  unchanged: enabled only when all three gates above are satisfied. */
export const buildEmbedderCore = (input: EmbedderAssembleInput): EmbedderPort | undefined => {
  if (!input.store) return undefined
  if (input.disabled === true) return undefined
  if (input.apiKey === undefined) return undefined
  return new CachingEmbedder(
    new OpenAIEmbedder({
      apiKey: input.apiKey,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      ...(input.model ? { model: input.model } : {}),
    }),
  )
}
