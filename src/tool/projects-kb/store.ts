/**
 * `@/tool/projects-kb` — Projects KNOWLEDGE-BASE store (A3, ABSENT → land).
 *
 * A session-scoped registry of INDEXED documents whose RAW CONTENTS are held
 * ENTIRELY inside this store and are NEVER handed back to the tool layer that
 * feeds the model context. The value prop (mirroring a "context offloading" KB
 * like Cursor/Claude project-knowledge): the agent can WRITE a large local file
 * into the KB, then SEARCH it, without ever paying for the raw bytes in its own
 * context window. Only METADATA (a `doc_uuid` + byte size) and pipeline-chosen
 * SNIPPETS leave the store.
 *
 * Shape cloned from `@/tool/ci-finding`:
 *   - pure in-memory, oldest-evicted ring (bounded retention).
 *   - injected clock + id-factory ⇒ deterministic in tests (no Date.now /
 *     Math.random).
 *   - a duck-typed backend `port` (see `./port`) the store OPTIONALLY delegates
 *     indexing/reads to; a thrown port is surfaced upstream as `ok:false`
 *     (NO-THROW is enforced at the tool op-dispatcher, not here).
 *
 * Plane-clean: imports only `@/shared`. The store DOES retain the decoded text
 * of each doc internally (so lexical-substring fallback search works when no
 * pipeline is wired), but that text is exposed by NO public method — `get`
 * returns METADATA only, and there is deliberately no `readBody`.
 */

import { byteCompare } from "@/shared"
import type { ProjectsKbBackendPort } from "./port"

/**
 * Measure-first knob DEFAULT for the `rag_active` byte threshold.
 *
 * `rag_active` is meant to flip when the indexed corpus grows large enough that
 * the agent should switch from "read the whole KB" to "retrieval-only". The
 * exact byte cutoff is a TUNING parameter with NO validated value yet — this
 * default is a deliberately-round placeholder (~256 KiB) that the composition
 * root / a future knob MUST override once we have A/B evidence.
 *
 * TODO(measure-first): tune against real KB-corpus / context-budget data. Do
 * NOT treat 262144 as a validated cutoff — it is an un-measured default.
 */
export const DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES = 262_144

/**
 * Measure-first knob DEFAULT for the total KB byte budget (`max_knowledge_size`).
 *
 * TODO(measure-first): tune. ~4 MiB placeholder; the accounting is real (a live
 * byte count of the indexed corpus), only the cap value is un-measured.
 */
export const DEFAULT_PROJECTS_KB_MAX_KNOWLEDGE_BYTES = 4_194_304

/** Metadata for one indexed doc — the ONLY doc shape that leaves the store.
 *  NOTE: the raw decoded text is NOT a field here; it is held privately. */
export interface ProjectsKbDocMeta {
  readonly docUuid: string
  /** Monotonic insertion sequence (stable ordering independent of clock skew). */
  readonly seq: number
  /** Epoch-ms the doc was indexed (from the injected clock). */
  readonly indexedAt: number
  /** The logical name the doc was indexed under (a basename / label). */
  readonly name: string
  /** Byte size of the indexed content. */
  readonly bytes: number
}

/** Real byte-budget accounting snapshot — the `knowledge{}` object surfaced to
 *  the model (project_info) and serialized to report/status. */
export interface ProjectsKbKnowledge {
  readonly knowledge_size: number
  readonly max_knowledge_size: number
  readonly search_threshold: number
  readonly rag_active: boolean
  readonly remaining_budget: number
}

/** One lexical-fallback hit — shape parallel to the pipeline-mapped hit. */
export interface ProjectsKbHit {
  readonly name: string
  readonly doc_uuid: string
  /** A bounded snippet the pipeline / lexical fallback chose to surface. */
  readonly text: string
}

export interface ProjectsKbStore {
  /** Index a doc's bytes; returns METADATA only (never the raw content). May
   *  throw if a wired backend `port.indexDoc` throws — the tool dispatcher
   *  converts that to `ok:false`. */
  index(name: string, bytes: Uint8Array): ProjectsKbDocMeta
  /** Metadata by uuid (undefined if absent). NEVER returns the doc body. */
  get(docUuid: string): ProjectsKbDocMeta | undefined
  /** Delete a doc by uuid; true if it existed. */
  remove(docUuid: string): boolean
  /** Lexical-substring FALLBACK search over the indexed corpus (used when no
   *  SearchPipeline is wired). Returns hits with a bounded snippet — never the
   *  full body. */
  searchLexical(query: string, k: number): readonly ProjectsKbHit[]
  /** Real byte-budget accounting. `force` bypasses the threshold gate (rag stays
   *  OFF regardless of corpus size). */
  knowledge(force: boolean): ProjectsKbKnowledge
  /** Current doc count. */
  size(): number
}

export interface ProjectsKbStoreOpts {
  /** Injected clock (epoch-ms). Defaults to `Date.now` in production. */
  readonly now?: () => number
  /** Injected id factory. Defaults to a monotonic `pkb-<seq>` (deterministic —
   *  the store is single-session). */
  readonly idFactory?: (seq: number) => string
  /** Hard cap on retained docs — oldest-evicted ring. Default 500. */
  readonly maxDocs?: number
  /** Byte threshold at which `rag_active` flips true. Defaults to the
   *  measure-first {@link DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES}. */
  readonly ragThresholdBytes?: number
  /** Total KB byte budget. Defaults to {@link DEFAULT_PROJECTS_KB_MAX_KNOWLEDGE_BYTES}. */
  readonly maxKnowledgeBytes?: number
  /** OPTIONAL duck-typed backend the store delegates indexing/reads to. A thrown
   *  port propagates (the tool dispatcher converts it to `ok:false`). Absent ⇒
   *  the store is a self-contained in-memory index. */
  readonly port?: ProjectsKbBackendPort
}

const DEFAULT_MAX_DOCS = 500

interface StoredDoc {
  readonly meta: ProjectsKbDocMeta
  /** PRIVATE decoded text — never exposed by a public method. */
  readonly text: string
}

/** Build a fresh in-memory ProjectsKbStore. Each call is independent. */
export const createProjectsKbStore = (opts: ProjectsKbStoreOpts = {}): ProjectsKbStore => {
  const now = opts.now ?? (() => Date.now())
  const idFactory = opts.idFactory ?? ((seq: number) => `pkb-${seq}`)
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS
  const ragThreshold = opts.ragThresholdBytes ?? DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES
  const maxKnowledge = opts.maxKnowledgeBytes ?? DEFAULT_PROJECTS_KB_MAX_KNOWLEDGE_BYTES
  const port = opts.port
  const docs: StoredDoc[] = []
  let seqCounter = 0
  let byteTotal = 0

  const recount = (): void => {
    byteTotal = docs.reduce((n, d) => n + d.meta.bytes, 0)
  }

  return {
    index(name: string, bytes: Uint8Array): ProjectsKbDocMeta {
      // Delegate to the backend FIRST when wired — a thrown port bubbles out
      // (the tool dispatcher converts it to a leak-safe ok:false). We pass the
      // raw bytes to the backend; the backend owns any external persistence.
      port?.indexDoc?.(name, bytes)
      const seq = seqCounter++
      const meta: ProjectsKbDocMeta = {
        docUuid: idFactory(seq),
        seq,
        indexedAt: now(),
        name,
        bytes: bytes.byteLength,
      }
      // Decode for the lexical fallback ONLY; the text stays private.
      const text = new TextDecoder().decode(bytes)
      docs.push({ meta, text })
      // Oldest-evicted ring — bound retention.
      while (docs.length > maxDocs) docs.shift()
      recount()
      return meta
    },
    get(docUuid: string): ProjectsKbDocMeta | undefined {
      return docs.find((d) => d.meta.docUuid === docUuid)?.meta
    },
    remove(docUuid: string): boolean {
      const i = docs.findIndex((d) => d.meta.docUuid === docUuid)
      if (i < 0) return false
      docs.splice(i, 1)
      recount()
      return true
    },
    searchLexical(query: string, k: number): readonly ProjectsKbHit[] {
      const needle = query.toLowerCase()
      const hits: ProjectsKbHit[] = []
      // Deterministic order: by seq (insertion), then uuid.
      const ordered = [...docs].sort((a, b) =>
        a.meta.seq !== b.meta.seq
          ? a.meta.seq - b.meta.seq
          : byteCompare(a.meta.docUuid, b.meta.docUuid),
      )
      for (const d of ordered) {
        if (hits.length >= k) break
        if (needle === "") continue
        // Count matches WITHOUT slicing the body into the result. THE INVARIANT:
        // the store's own fallback must never surface raw doc bytes to the model
        // (a snippet centered on the match would leak whatever adjacent text the
        // doc holds — the hellgate proved this). We emit a body-FREE match
        // indicator (name + doc_uuid + match count); the model must project_read
        // metadata / act on the uuid, not read the body out of the search result.
        let count = 0
        let from = 0
        const hay = d.text.toLowerCase()
        for (let i = hay.indexOf(needle, from); i >= 0; i = hay.indexOf(needle, from)) {
          count++
          from = i + needle.length
        }
        if (count === 0) continue
        hits.push({
          name: d.meta.name,
          doc_uuid: d.meta.docUuid,
          text: `match (${count}× in ${d.meta.bytes}B)`,
        })
      }
      return hits
    },
    knowledge(force: boolean): ProjectsKbKnowledge {
      const remaining = Math.max(0, maxKnowledge - byteTotal)
      // rag_active is a REAL byte-budget crossing (not a guessed constant): the
      // live indexed byte count vs the (knob-defaulted) threshold. `force`
      // bypasses the gate entirely.
      const ragActive = force ? false : byteTotal >= ragThreshold
      return {
        knowledge_size: byteTotal,
        max_knowledge_size: maxKnowledge,
        search_threshold: ragThreshold,
        rag_active: ragActive,
        remaining_budget: remaining,
      }
    },
    size(): number {
      return docs.length
    },
  }
}

/**
 * Stable, doc-body-FREE serialization of the `knowledge{}` accounting — exported
 * so the tool (project_info) AND any report/status site share ONE format
 * (co-located with the usage/knob serialization discipline; mirrors ci_finding's
 * `renderFinding`). Emits ONLY the byte-budget counters — never a doc name or
 * body — so wiring it into a status line can never leak KB contents.
 */
export const renderKnowledge = (k: ProjectsKbKnowledge): string =>
  `knowledge_size=${k.knowledge_size} max_knowledge_size=${k.max_knowledge_size} ` +
  `search_threshold=${k.search_threshold} rag_active=${k.rag_active} ` +
  `remaining_budget=${k.remaining_budget}`
