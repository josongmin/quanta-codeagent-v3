/**
 * Surface-agnostic assembler for the `@/retrieval` stack (ADR-0159 wire).
 *
 * `@/retrieval` ships five orthogonal axes (reranker registry / chunk-bucket /
 * commit-embedder / multi-vendor embedding port / hybrid-query funnel). The
 * primitives landed without a composition-root wire — every consumer who wants
 * to use them must construct a registry + select a default strategy + (for
 * the hybrid funnel) decide on a final-stage reranker. That bag of choices
 * is a SURFACE-AGNOSTIC composition concern: every front (CLI / Web / Tauri /
 * bench) needs the same wire, just with different env / config inputs. This
 * module owns that wire.
 *
 * Design discipline:
 *   - DEFAULT-OFF: callers who do NOT pass {@link RetrievalAssembleInput} (or
 *     pass `{ enabled: false }`) get `undefined` back, and the loop is byte-
 *     identical (no allocation, no registry, no funnel). The opt-in is a SINGLE
 *     surface decision; the registry decides which rerankers are wired AT
 *     CONSTRUCTION (closed by default — adding a strategy is a code edit, not
 *     a runtime knob).
 *   - SOLID:
 *       · SRP — this module ONLY assembles. It does not read env, parse
 *         config, or own runtime state.
 *       · OCP — adding a {@link RerankerKind} is a 1-file edit in `@/retrieval`
 *         + the `register(...)` call below. No edit to consumers.
 *       · LSP — every reranker satisfies the same {@link RerankPort} contract.
 *       · ISP — the input shape exposes ONLY the knobs needed to BUILD the
 *         stack; consumer plumbing (memory ranking, localize) accepts the
 *         returned {@link RetrievalStack} via DI, not via a global.
 *       · DIP — every external dep (clock / git / embedding HTTP) enters as
 *         a closed port. This module imports `@/retrieval` and `@/shared`
 *         only — same fence the retrieval slice itself respects.
 *   - Slice fence — `@/runner/**` is forbidden from importing `@/apps/**`
 *     (biome rule). This file lives here so apps reach `@/runner` for the
 *     assembler, not the other way around.
 *
 * Consumers: none in-tree today. The ADR-0159 memory↔retrieval bridge and the
 * localize bridge (both formerly under `@/runner/assemble/`) were DELETED —
 * ADR-0553 records why (unread `AgentConfig` slot + memory's `rankEntries`
 * clips BEFORE any rerank stage + `identity` default reranker ⇒ measured
 * no-op). This builder stays as the surface-agnostic assembler for
 * `@/retrieval`; a future consumer must rerank BEFORE its own clip and pick a
 * non-identity default, and `@/memory` may still NOT import `@/retrieval`
 * (RFC §3.1 fence) — bridge from `@/runner`, not from the memory slice.
 */
import {
  type CommitEmbedder,
  createBm25SecondaryReranker,
  createCommitEmbedder,
  createTierAwareReranker,
  type EmbeddingPort,
  type GitLogPort,
  identityReranker,
  type RerankerKind,
  type RerankPort,
  RerankRegistry,
  rrfReranker,
  type TierClassifierPort,
} from "@/retrieval"

/** Default reranker kind when the caller does not pin one. `identity` is the
 *  safe pass-through — preserves first-stage ordering exactly. The operator
 *  promotes a more aggressive strategy explicitly. */
export const DEFAULT_RETRIEVAL_RERANKER: RerankerKind = "identity"

/** Closed enum of rerankers this builder may wire. Adding a new strategy is
 *  an OCP edit: add the kind to `@/retrieval`'s `RerankerKind` union, then
 *  add the construction branch in {@link buildRegistry}. Consumers do not
 *  change. */
const BUILTIN_RERANKERS: readonly RerankerKind[] = [
  "identity",
  "bm25-secondary",
  "score-fusion-rrf",
  // `tier-aware` is NOT in the default set — it requires a caller-supplied
  // `TierClassifierPort`. The assembler accepts one via `tierClassifier` and
  // registers `tier-aware` only when the port is present (compile-time
  // exhaustiveness is preserved via the discriminated union).
] as const

/**
 * Inputs to {@link buildRetrievalStackCore}. Every field is surface-agnostic
 * — the caller (CLI env reader, Web JSON body, Tauri IPC) projects whatever
 * source it owns onto this plain typed bag.
 *
 * `enabled` is the single opt-in. Absent or `false` ⇒ the builder returns
 * `undefined` (byte-identical default-OFF). When `true`, the builder always
 * wires the BUILTIN set; optional fields wire OPTIONAL extras (e.g.
 * `tierClassifier` ⇒ tier-aware reranker registered).
 */
export interface RetrievalAssembleInput {
  /** Master opt-in. The surface maps its own typed input onto this boolean.
   *  Absent / false ⇒ no stack. (The former host env gate for this flag was
   *  deleted together with the memory bridge — ADR-0553.) */
  enabled?: boolean
  /** Default reranker kind promoted by the operator. Must be one of the
   *  registered kinds (`identity` always available; `bm25-secondary` and
   *  `score-fusion-rrf` always wired; `tier-aware` only when
   *  `tierClassifier` is supplied). Absent ⇒ {@link DEFAULT_RETRIEVAL_RERANKER}. */
  defaultReranker?: RerankerKind
  /** Optional embedding adapter for the multi-vendor port. When supplied,
   *  also feeds {@link CommitEmbedder} if `gitLog` is set. Absent ⇒ the
   *  stack still works for BM25-only consumers; embedding-only / hybrid
   *  consumers MUST verify the port exists before calling. */
  embedding?: EmbeddingPort
  /** Optional git-log port. When supplied with `embedding`, the builder
   *  wires a {@link CommitEmbedder} for the commit-history axis (ADR-0159
   *  Axis C). Absent ⇒ `commitEmbedder` is `undefined`. */
  gitLog?: GitLogPort
  /** Optional tier classifier — when present, the tier-aware reranker is
   *  registered (ADR-0159 Axis A, tier strategy). Absent ⇒ tier-aware is
   *  NOT registered (looking it up throws RetrievalError — closed by default). */
  tierClassifier?: TierClassifierPort
  /** Override the BM25-secondary blend (default α=0.5). Surface knob for
   *  callers that want to bias toward the first-stage signal. */
  bm25Alpha?: number
  /** Override the commit-embedder LRU cap (default 1024). */
  commitCacheMax?: number
}

/**
 * The assembled retrieval stack. Returned by {@link buildRetrievalStackCore}
 * when enabled; surface-agnostic so any consumer (memory ranking, localize,
 * future tool) accepts a single typed handle. Threaded into `AgentConfig`
 * via an optional slot; the dispatch seam reads it onto `ToolContext` only
 * when wired.
 */
export interface RetrievalStack {
  /** Registry keyed by {@link RerankerKind}. Lookup throws RetrievalError on
   *  unknown kind (closed by default — caller asks for a strategy by name). */
  readonly registry: RerankRegistry
  /** The reranker the operator chose as the default. `registry.get(...)`
   *  on the chosen kind, cached for the hot path. */
  readonly defaultReranker: RerankPort
  /** Multi-vendor embedding port (if wired). Absent ⇒ no embedding-side
   *  retrieval; BM25-only consumers still work. */
  readonly embedding?: EmbeddingPort
  /** Commit-history embedder (Axis C). Present only when BOTH `gitLog` and
   *  `embedding` were supplied. */
  readonly commitEmbedder?: CommitEmbedder
}

/** Construct the registry with every builtin reranker, plus the conditional
 *  `tier-aware` strategy when a classifier port is supplied. Separate from
 *  the main builder so a test can assert the registered set in isolation. */
const buildRegistry = (input: RetrievalAssembleInput): RerankRegistry => {
  const reg = new RerankRegistry()
  reg.register(identityReranker)
  reg.register(rrfReranker)
  reg.register(createBm25SecondaryReranker({ alpha: input.bm25Alpha ?? 0.5 }))
  if (input.tierClassifier) {
    reg.register(createTierAwareReranker({ classifier: input.tierClassifier }))
  }
  return reg
}

/**
 * Build the retrieval stack (or return `undefined`).
 *
 * Default-OFF: `input` absent OR `input.enabled !== true` ⇒ returns
 * `undefined` immediately. Every legacy caller (every CLI flow that doesn't
 * pass the flag) is byte-identical.
 *
 * On opt-in:
 *   - The 3 builtin rerankers (`identity` / `bm25-secondary` /
 *     `score-fusion-rrf`) are always registered.
 *   - `tier-aware` is registered iff `input.tierClassifier` is supplied.
 *   - The `defaultReranker` slot is populated from `input.defaultReranker` or
 *     {@link DEFAULT_RETRIEVAL_RERANKER}. An UNREGISTERED kind throws — caller
 *     asked for a strategy by name with no classifier.
 *   - `embedding` flows through verbatim (caller built the adapter).
 *   - `commitEmbedder` is wired iff BOTH `gitLog` and `embedding` are set.
 *
 * The function NEVER reads env / argv / process state. Every input is a plain
 * value handed in by the surface.
 */
export const buildRetrievalStackCore = (
  input?: RetrievalAssembleInput,
): RetrievalStack | undefined => {
  if (!input || input.enabled !== true) return undefined
  const registry = buildRegistry(input)
  const chosen = input.defaultReranker ?? DEFAULT_RETRIEVAL_RERANKER
  // get() throws RetrievalError on unknown kind — surface that LOUDLY rather
  // than degrading to identity silently (the operator asked for a specific
  // strategy, falling back would hide the misconfiguration).
  const defaultReranker = registry.get(chosen)
  const out: { -readonly [K in keyof RetrievalStack]: RetrievalStack[K] } = {
    registry,
    defaultReranker,
  }
  if (input.embedding !== undefined) out.embedding = input.embedding
  if (input.embedding !== undefined && input.gitLog !== undefined) {
    out.commitEmbedder = createCommitEmbedder({
      git: input.gitLog,
      embed: input.embedding,
      ...(input.commitCacheMax !== undefined ? { cacheMax: input.commitCacheMax } : {}),
    })
  }
  return out as RetrievalStack
}

/** List of every reranker kind the builder MAY wire when enabled. Test
 *  exposure: assert the closed set + that consumers don't silently lose a
 *  strategy. */
export const RETRIEVAL_BUILTIN_RERANKERS = BUILTIN_RERANKERS
