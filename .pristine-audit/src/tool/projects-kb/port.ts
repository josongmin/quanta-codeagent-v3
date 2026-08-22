/**
 * `@/tool/projects-kb` — duck-typed backend port + tool wiring slot.
 *
 * Slice posture (RFC §3.1): the `projects_kb` tool is a LEAF — it must never
 * import `@/agent` / a concrete KB backend. The store OPTIONALLY delegates the
 * durable index/read work to a host-wired backend through this MINIMAL
 * duck-typed port; when absent the store is a self-contained in-memory index.
 *
 * NO-THROW contract: every port method MAY throw; the tool's op-dispatcher wraps
 * the delegation and converts a throw into a leak-safe `ok:false` ToolResult
 * (an error message never echoes the doc body — see tool.ts).
 */

import type { SearchPipeline } from "@/retrieval/pipeline"
import type { ProjectsKbStore } from "./store"

/**
 * OPTIONAL durable KB backend. Every method is optional so a host can wire a
 * partial backend (e.g. index-only). The store calls `indexDoc` on write; the
 * tool never surfaces a backend method's return value verbatim to the model.
 */
export interface ProjectsKbBackendPort {
  /** Persist/index the raw doc bytes under `name`. May throw. */
  readonly indexDoc?: (name: string, bytes: Uint8Array) => void
}

/**
 * Host-wired projects-kb SLOT (the `DefaultToolPorts.projectsKb` value). Carries
 * the session store and — OPTIONALLY — the EXISTING retrieval `SearchPipeline`
 * seam (the same interface `search_codebase` injects) scoped to the KB
 * namespace. When no pipeline is wired the tool falls back to the store's
 * lexical-substring search (fail-soft).
 */
export interface ProjectsKbSlot {
  readonly store: ProjectsKbStore
  /** OPTIONAL retrieval pipeline (KB-namespace-scoped) — reuses the shared
   *  `@/retrieval/pipeline` seam; absent ⇒ lexical fallback. */
  readonly pipeline?: SearchPipeline
}
