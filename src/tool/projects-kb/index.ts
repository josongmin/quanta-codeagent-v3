/** `@/tool/projects-kb` — Projects knowledge-base slice (A3). Context-offloading
 *  KB: index local files, search them, WITHOUT their bytes entering context. */

export type { ProjectsKbBackendPort, ProjectsKbSlot } from "./port"
export type {
  ProjectsKbDocMeta,
  ProjectsKbHit,
  ProjectsKbKnowledge,
  ProjectsKbStore,
  ProjectsKbStoreOpts,
} from "./store"
export {
  createProjectsKbStore,
  DEFAULT_PROJECTS_KB_MAX_KNOWLEDGE_BYTES,
  DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES,
  renderKnowledge,
} from "./store"
export { type ProjectsKbInput, projectsKbSchema, projectsKbTool } from "./tool"
