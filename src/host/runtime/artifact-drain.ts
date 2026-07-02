/**
 * A2 — artifact PREVIEW CHANNEL producer bridge.
 *
 * The MISSING PRODUCER for the `artifact.ready` protocol emit
 * (`src/kernel/session/scheduler.ts` — `readyEvents`/`onTurnCompleted`). When the
 * Canvas store is on (`QUANTA_ARTIFACT_STORE`), the composition root lifts the
 * SINGLE per-session {@link ArtifactRegistry} (the SAME instance the
 * `artifact_*` tools + generation-tool `artifactSink` write into) onto the
 * runtime base; the turn host drains newly-registered artifacts through this
 * mapper into `result.artifacts` as protocol {@link ArtifactRef}s. The kernel
 * scheduler then emits one `artifact.ready` per ref.
 *
 * This does NOT fork a parallel artifact system: it reuses the existing
 * `@/artifact` `ArtifactRegistry` SSOT (via `registry.list()`) and the existing
 * `artifact.ready` channel. It is a PURE mapping + a de-dup drain over an
 * injected `seenIds` set so a multi-turn session only emits each artifact ONCE.
 *
 * DEFAULT-OFF: an unset store never lifts a registry ⇒ `drainNewArtifacts`
 * receives `undefined` ⇒ returns `[]` ⇒ no producer ⇒ byte-identical (the
 * scheduler's `readyEvents` maps an empty list to zero events).
 */

import type { Artifact, ArtifactRegistry } from "@/artifact"
import { previewUrl } from "@/artifact"
import type { ArtifactRef } from "@/protocol/session"

/** Map a `@/artifact` {@link Artifact} to a protocol {@link ArtifactRef}. Pure.
 *
 *  - `id`         → `artifactId`
 *  - `kind`       → `kind` (the closed ArtifactKind string is carried verbatim)
 *  - `mediaType`  → `mimeType`
 *  - `previewUrl` → `locator` (the opaque `quanta-artifact://<id>` scheme —
 *                   never the absolute fs path, so the jailed path never leaks
 *                   onto the wire)
 *  - `label`      → `name` (omitted when absent, `exactOptionalPropertyTypes`)
 *  - `createdAt`  → ISO string (the protocol carries an ISO timestamp; the
 *                   registry stores an injected epoch-ms number). A non-finite
 *                   timestamp clamps to epoch 0 so the map is TOTAL (no throw). */
export const toArtifactRef = (artifact: Artifact): ArtifactRef => ({
  artifactId: artifact.id,
  kind: artifact.kind,
  mimeType: artifact.mediaType,
  locator: previewUrl(artifact),
  ...(artifact.label !== undefined ? { name: artifact.label } : {}),
  createdAt: new Date(Number.isFinite(artifact.createdAt) ? artifact.createdAt : 0).toISOString(),
})

/**
 * Drain artifacts registered since the last drain into protocol refs.
 *
 * `seenIds` is the per-SESSION de-dup ledger (mutated in place): only artifacts
 * whose id is NOT already in it are returned, and every returned id is recorded
 * so the NEXT turn does not re-emit an artifact registered on an earlier turn.
 * A FIFO-evicted id that later reappears (registry cap) is not re-emitted — the
 * ledger is monotonic per session, matching the "each artifact ready once"
 * contract.
 *
 * `registry === undefined` (store OFF) ⇒ `[]` — the default-OFF byte-identical
 * path: no registry lifted ⇒ no producer.
 */
export const drainNewArtifacts = (
  registry: ArtifactRegistry | undefined,
  seenIds: Set<string>,
): readonly ArtifactRef[] => {
  if (registry === undefined) return []
  const refs: ArtifactRef[] = []
  for (const artifact of registry.list()) {
    if (seenIds.has(artifact.id)) continue
    seenIds.add(artifact.id)
    refs.push(toArtifactRef(artifact))
  }
  return refs
}
