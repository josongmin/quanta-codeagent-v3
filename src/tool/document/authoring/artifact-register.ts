/**
 * C1 — best-effort artifact registration for the Office authoring tools.
 *
 * After a SUCCESSFUL `*_write`, the tool optionally registers the produced file
 * into the session artifact registry so `artifact_list` / `artifact_get` surface
 * it and downstream tools can reference it by id. This is a SIDE-CHANNEL: it must
 * NEVER break the primary write.
 *
 *   - When no registry port is wired (default — `QUANTA_ARTIFACT_STORE` off),
 *     `registerArtifactBestEffort` is never invoked (the factory only calls it
 *     when a port is present), so the tool output is BYTE-IDENTICAL to today.
 *   - When a port IS wired, a `register()` that THROWS is swallowed — the write
 *     already happened; registration failure is logged into the returned `note`
 *     only as ABSENCE (no extra line), so the model still gets `ok:true`.
 *
 * Slice posture: imports only the duck-typed {@link ArtifactRegistryPort} TYPE
 * from the sibling `@/tool/artifact` slice (fence-clean — `@/tool` internal,
 * same as `src/tool/index.ts`). No `@/artifact`, no `@/agent`.
 */

import type { ArtifactKind, ArtifactRegistryPort } from "../../artifact"

/** OOXML package-level media types for the three authoring outputs. */
export const OOXML_MEDIA_TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const

/**
 * Best-effort register a written artifact. Returns an additive output line
 * (`\nRegistered artifact …`) on success, or `""` when no registry is wired OR
 * the register call failed (best-effort — never throws, never breaks the write).
 */
export const registerArtifactBestEffort = (
  registry: ArtifactRegistryPort | undefined,
  spec: { kind: ArtifactKind; path: string; mediaType: string; label?: string },
): string => {
  if (registry === undefined) return ""
  try {
    const artifact = registry.register(spec)
    return `\nRegistered artifact ${artifact.id} (quanta-artifact://${artifact.id})`
  } catch {
    // Registration is a side-channel; a throwing registry must NOT fail the
    // primary write. Swallow → the model still sees ok:true with no extra line.
    return ""
  }
}
