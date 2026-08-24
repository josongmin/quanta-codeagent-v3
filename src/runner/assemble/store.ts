import { homedir } from "node:os"
import { CachingEmbedder, OpenAIEmbedder } from "@/agent"
import { type EmbedderPort, InMemoryStore, type PersistentStorePort, SqliteStore } from "@/memory"
import { defaultDurableStorePath } from "@/memory/store-path"

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
  /** SqliteStore path. Ignored when `kind !== "sqlite"`. Defaults to the
   *  ADR-0557 home-scoped `~/.quanta/memory/memory.sqlite` when omitted (the
   *  factory always passes a resolved path; this fallback is for direct
   *  callers, and is the ONLY place this slice touches `os.homedir()`). */
  path?: string | undefined
}

/** Build the long-term memory store. `kind="sqlite"` → on-disk SqliteStore
 *  (ADR-0557: the parent directory is created on open); `kind="memory"` →
 *  volatile InMemoryStore; otherwise (incl. undefined) → no store. A sqlite
 *  open failure THROWS here — the factory (`buildMemoryForSession`) owns the
 *  attributed fallback to the volatile kind so the reported `kind` stays true. */
export const buildStoreCore = (input: StoreAssembleInput): PersistentStorePort | undefined => {
  if (input.kind === "sqlite") {
    return new SqliteStore(input.path ?? defaultDurableStorePath(homedir()))
  }
  if (input.kind === "memory") return new InMemoryStore()
  return undefined
}

/** ADR-0555 — where the embedder's egress-relevant credentials CAME FROM.
 *  Each field is the absolute path of the dotenv file that supplied the key,
 *  or absent when the value came from the real environment (or is unset).
 *  Never carries a value — file paths only, safe to print in a banner. */
export interface EmbedderProvenance {
  /** Dotenv file that supplied `OPENAI_API_KEY`, if any. */
  readonly apiKeyFrom?: string | undefined
  /** Dotenv file that supplied `OPENAI_BASE_URL`, if any. */
  readonly baseUrlFrom?: string | undefined
}

/** Project a `key → source file` lookup (the surface passes its dotenv
 *  provenance reader) into the two credentials the embedder egresses with.
 *  Pure: the lookup is injected, so this slice still reads no process state. */
export const resolveEmbedderProvenance = (
  sourceOf: (key: string) => string | undefined,
): EmbedderProvenance => {
  const apiKeyFrom = sourceOf("OPENAI_API_KEY")
  const baseUrlFrom = sourceOf("OPENAI_BASE_URL")
  return {
    ...(apiKeyFrom !== undefined ? { apiKeyFrom } : {}),
    ...(baseUrlFrom !== undefined ? { baseUrlFrom } : {}),
  }
}

/** Inputs to {@link buildEmbedderCore}. The embedder is on only when:
 *   - a `store` exists, AND
 *   - `disabled !== true`, AND
 *   - an `apiKey` is provided, AND
 *   - (ADR-0555) the key did NOT come from a dotenv file — or the operator
 *     EXPLICITLY opted in (`embedExplicitlyOn`).
 *  All are surface-agnostic mirrors of the env-driven gates
 *  (`QUANTA_MEMORY_EMBED`, `OPENAI_API_KEY` presence + provenance). */
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
  /** ADR-0555 — origin of the credentials. When `apiKeyFrom` names a dotenv
   *  file, the embedder is armed ONLY if `embedExplicitlyOn` is true. Absent ⇒
   *  treated as real-env (byte-identical to the pre-0555 gate). */
  provenance?: EmbedderProvenance | undefined
  /** ADR-0555 — true iff `QUANTA_MEMORY_EMBED` was set to a truthy token
   *  (`gateOn` vocab: 1/on/true/yes), NOT merely present and NOT the knob's
   *  default. A defaulted (unset) knob never counts as consent to egress a
   *  key the operator may not know was loaded. */
  embedExplicitlyOn?: boolean | undefined
  /** ADR-0555 — attributed notice sink for the refusal (`logger.warn` on the
   *  CLI). Called at most once per build; the line names the FILE, never the
   *  key. Absent ⇒ the refusal is silent (non-CLI surfaces route their own). */
  onNotArmed?: ((line: string) => void) | undefined
}

/** Build the semantic embedder. Default OFF so lexical-only recall is
 *  unchanged: enabled only when every gate above is satisfied. */
export const buildEmbedderCore = (input: EmbedderAssembleInput): EmbedderPort | undefined => {
  if (!input.store) return undefined
  if (input.disabled === true) return undefined
  if (input.apiKey === undefined) return undefined
  // ADR-0555 egress gate: a key that arrived via a repo's `.env*` (resolved
  // against the LAUNCH cwd, not `--cwd`) must not silently arm a POST of memory
  // text to `${OPENAI_BASE_URL ?? api.openai.com}/embeddings`. Real-env keys are
  // untouched — this branch is unreachable for them (no provenance entry).
  const keyFrom = input.provenance?.apiKeyFrom
  if (keyFrom !== undefined && input.embedExplicitlyOn !== true) {
    input.onNotArmed?.(
      `memory embedder NOT armed: OPENAI_API_KEY came from ${keyFrom}; set QUANTA_MEMORY_EMBED=1 to opt in`,
    )
    return undefined
  }
  return new CachingEmbedder(
    new OpenAIEmbedder({
      apiKey: input.apiKey,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      ...(input.model ? { model: input.model } : {}),
    }),
  )
}
