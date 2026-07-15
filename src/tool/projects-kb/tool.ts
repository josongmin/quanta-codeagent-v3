/**
 * `projects_kb` — Projects KNOWLEDGE-BASE tool (A3, ABSENT → land).
 *
 * Context-offloading KB: the agent WRITES a local file into a session KB
 * (`project_write`), then SEARCHES / inspects it WITHOUT the raw bytes ever
 * entering its own context window. The whole value prop is the "never enters
 * context" invariant — `project_write` returns ONLY metadata (`doc_uuid` + byte
 * size); `project_search` returns pipeline-chosen SNIPPETS + `doc_uuid`s; NO op
 * ever places a doc's raw body into `ToolResult.output` / `structured`.
 *
 * Ops (op-dispatch, NO-THROW — a thrown store/port/pipeline collapses to a
 * leak-safe `ok:false`, never propagates past the loop):
 *   - `project_info`   — knowledge{} byte-budget accounting.
 *   - `project_read`   — METADATA for one doc by uuid (NOT the body).
 *   - `project_search` — delegate to the wired SearchPipeline (KB namespace),
 *                        else lexical-substring fallback; hits → {name, doc_uuid, text}.
 *   - `project_write`  — resolve local_path THROUGH resolveJailedDoc, read bytes,
 *                        index, return {doc_uuid, bytes} ONLY.
 *   - `project_delete` — drop a doc by uuid.
 *
 * READ-ish bookkeeping (records into the SESSION store; the raw file is READ,
 * never mutated) — self-reports `isReadOnly: true` / `hitlTier: none` like
 * `ci_finding` / `communicate_update`.
 *
 * LEAK DISCIPLINE: error branches use FIXED, doc-content-free messages. We never
 * interpolate `errMessage(e)` from an index/read/pipeline throw into the model
 * surface, because a backend error message could echo the doc bytes. Only the
 * op label + a stable reason leave the tool.
 */

import { z } from "zod"
import type { SearchHit } from "@/retrieval/pipeline"
import { sliceWholeChars } from "@/shared"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import type { ProjectsKbSlot } from "./port"
import { type ProjectsKbHit, type ProjectsKbStore, renderKnowledge } from "./store"

const DEFAULT_K = 10
const MAX_K = 50
const MAX_SNIPPET = 160

export const projectsKbSchema = z
  .object({
    op: z
      .enum(["project_info", "project_read", "project_search", "project_write", "project_delete"])
      .describe("info | read (metadata) | search | write (index a local file) | delete"),
    /** project_write */
    local_path: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe("Workspace-relative path of the local file to index (project_write)"),
    /** project_read / project_delete */
    doc_uuid: z.string().min(1).optional().describe("Doc id (project_read / project_delete)"),
    /** project_search */
    query: z.string().min(1).max(4_000).optional().describe("Search query (project_search)"),
    k: z
      .number()
      .int()
      .positive()
      .max(MAX_K)
      .optional()
      .describe(`Max hits (project_search; default ${DEFAULT_K}, max ${MAX_K})`),
    /** project_info — bypass the rag threshold gate. */
    force: z.boolean().optional().describe("project_info: bypass the rag_active threshold gate"),
  })
  .describe(
    "Projects knowledge-base: index local files + search them WITHOUT their bytes entering context.",
  )
export type ProjectsKbInput = z.infer<typeof projectsKbSchema>

type Outcome = ToolResult

/** A leak-safe error result — a FIXED reason string, never the doc body / a
 *  backend throw's message. */
const errOut = (reason: string): Outcome => ({
  ok: false,
  output: reason,
  failure: { mode: "error", modelVisibleError: reason },
})

/** project_info — knowledge{} accounting (no doc body). */
const doInfo = (store: ProjectsKbStore, d: ProjectsKbInput): Outcome => {
  const k = store.knowledge(d.force ?? false)
  return {
    ok: true,
    // Shared serializer — the SAME format a report/status site emits.
    output: renderKnowledge(k),
    structured: { knowledge: k, docs: store.size() },
  }
}

/** project_read — METADATA only. */
const doRead = (store: ProjectsKbStore, d: ProjectsKbInput): Outcome => {
  if (d.doc_uuid === undefined) return errOut("project_read requires: doc_uuid")
  const meta = store.get(d.doc_uuid)
  if (meta === undefined) return errOut(`no doc with id '${d.doc_uuid}'`)
  return {
    ok: true,
    output: `${meta.docUuid} name=${meta.name} bytes=${meta.bytes}`,
    structured: { doc: meta },
  }
}

/** project_delete — drop by uuid. */
const doDelete = (store: ProjectsKbStore, d: ProjectsKbInput): Outcome => {
  if (d.doc_uuid === undefined) return errOut("project_delete requires: doc_uuid")
  const removed = store.remove(d.doc_uuid)
  if (!removed) return errOut(`no doc with id '${d.doc_uuid}'`)
  return { ok: true, output: `deleted ${d.doc_uuid}` }
}

/** project_write — resolve THROUGH resolveJailedDoc, read bytes, index, return
 *  ONLY metadata. LEAK-SAFE on every failure (jail escape / read fail / backend
 *  throw ⇒ FIXED reason, never the bytes). */
const doWrite = async (
  store: ProjectsKbStore,
  d: ProjectsKbInput,
  ctx: ToolContext,
): Promise<Outcome> => {
  if (d.local_path === undefined) return errOut("project_write requires: local_path")
  // Path safety — a jail escape / empty / NUL throws FsJailError; convert to a
  // fixed reason (the message is path-shaped, contains no doc body, but we still
  // keep it stable and content-free).
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, d.local_path, "projects_kb")
  } catch {
    return errOut(`project_write: path is not allowed: ${d.local_path}`)
  }
  // Read the file bytes. A read failure must NOT echo any partial content.
  let bytes: Uint8Array
  try {
    const file = Bun.file(abs)
    if (!(await file.exists())) return errOut(`project_write: file not found: ${d.local_path}`)
    bytes = await file.bytes()
  } catch {
    return errOut(`project_write: could not read: ${d.local_path}`)
  }
  // Index. A backend port throw here could carry the doc bytes in its message —
  // we DISCARD the message and return a fixed reason (leak-safe).
  let docUuid: string
  let indexedBytes: number
  try {
    const meta = store.index(d.local_path, bytes)
    docUuid = meta.docUuid
    indexedBytes = meta.bytes
  } catch {
    return errOut("project_write: index backend rejected the document")
  }
  // METADATA ONLY — the raw contents never appear in output/structured.
  return {
    ok: true,
    output: `indexed ${docUuid} (${indexedBytes} bytes)`,
    structured: { doc_uuid: docUuid, bytes: indexedBytes },
  }
}

/** Map a pipeline SearchHit → the KB-namespace hit shape {name, doc_uuid, text}.
 *  `text` is the pipeline's chosen SNIPPET (already public), bounded again here
 *  as belt-and-braces. */
const mapHit = (h: SearchHit): ProjectsKbHit => {
  const md = h.metadata as Record<string, unknown> | undefined
  const name = typeof md?.name === "string" ? md.name : h.id
  const docUuid = typeof md?.docUuid === "string" ? md.docUuid : h.id
  const text = sliceWholeChars(h.text ?? "", MAX_SNIPPET)
  return { name, doc_uuid: docUuid, text }
}

const renderHits = (query: string, hits: readonly ProjectsKbHit[]): string => {
  if (hits.length === 0) return `No KB hits for: ${query}`
  const lines = [`Found ${hits.length} KB hit(s) for: ${query}`]
  for (const h of hits) lines.push(`  [${h.doc_uuid}] ${h.name}: ${h.text}`)
  return lines.join("\n")
}

/** project_search — delegate to the wired pipeline (KB namespace) else lexical
 *  fallback. NO-THROW / leak-safe: a thrown pipeline collapses to ok:false with
 *  a fixed reason (never the doc body). */
const doSearch = async (slot: ProjectsKbSlot, d: ProjectsKbInput): Promise<Outcome> => {
  if (d.query === undefined) return errOut("project_search requires: query")
  const k = d.k ?? DEFAULT_K
  if (slot.pipeline !== undefined) {
    let outcome: Awaited<ReturnType<typeof slot.pipeline.search>>
    try {
      // Scope to the KB namespace via the filter seam the pipeline passes through.
      outcome = await slot.pipeline.search({
        text: d.query,
        k,
        filter: { namespace: "projects_kb" },
      })
    } catch {
      return errOut("project_search: retrieval pipeline failed")
    }
    if (!outcome.ok) return errOut(`project_search: ${outcome.error.kind}`)
    const hits = outcome.value.map(mapHit)
    return { ok: true, output: renderHits(d.query, hits), structured: { hits } }
  }
  // Lexical-substring fallback (fail-soft when no pipeline).
  const hits = slot.store.searchLexical(d.query, k)
  return { ok: true, output: renderHits(d.query, hits), structured: { hits } }
}

/** Pure op-dispatcher — NO-THROW: a thrown store/port/pipeline collapses to a
 *  leak-safe ok:false. The catch NEVER interpolates the error message (a backend
 *  throw could carry the doc body). */
const runProjectsKb = async (
  slot: ProjectsKbSlot,
  d: ProjectsKbInput,
  ctx: ToolContext,
): Promise<Outcome> => {
  try {
    switch (d.op) {
      case "project_info":
        return doInfo(slot.store, d)
      case "project_read":
        return doRead(slot.store, d)
      case "project_delete":
        return doDelete(slot.store, d)
      case "project_write":
        return await doWrite(slot.store, d, ctx)
      case "project_search":
        return await doSearch(slot, d)
    }
  } catch {
    // Fixed reason — no error-message interpolation (leak-safe).
    return errOut(`projects_kb: op '${d.op}' failed`)
  }
}

export const projectsKbTool = (slot: ProjectsKbSlot): Tool<ProjectsKbInput> => ({
  name: "projects_kb",
  description:
    "Projects knowledge-base: index a LOCAL file into a session KB (project_write) then " +
    "search / inspect it WITHOUT its raw contents ever entering your context. " +
    "op: project_info | project_read | project_search | project_write | project_delete. " +
    "project_write returns ONLY the doc_uuid + byte size (the file bytes are NEVER returned); " +
    "project_search returns bounded snippets + doc_uuids. Reads the file (never mutates it).",
  inputSchema: projectsKbSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input: ProjectsKbInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = projectsKbSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    yield { type: "result", result: await runProjectsKb(slot, parsed.data, ctx) }
  },
})
