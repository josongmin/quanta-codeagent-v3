/**
 * Artifact slice barrel (C1 — Canvas / artifact persistence store, backlog §7).
 * Pure in-memory registry for non-code generation outputs. See `./registry.ts`.
 */

export {
  ARTIFACT_KINDS,
  ARTIFACT_URL_SCHEME,
  type Artifact,
  type ArtifactKind,
  type ArtifactRegistry,
  type ArtifactRegistryOptions,
  type ArtifactSpec,
  createArtifactRegistry,
  monotonicIdFactory,
  previewUrl,
} from "./registry"
