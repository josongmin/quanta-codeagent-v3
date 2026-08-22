/**
 * PMX-02 — the GRADER side of the boundary.
 *
 * This module is imported by the harness adapter and by NOTHING on the agent
 * side. It exists so the grader has exactly one way to obtain a
 * `PromaxGraderTaskView`: by `instanceId`, from a bundle that was opened
 * explicitly, after model-patch capture.
 *
 * There is deliberately no "resolve everything" accessor that hands back the
 * whole gold corpus as one object, and no cache keyed anywhere an agent-side
 * module could reach: the only export is a resolver closure.
 */
import { parseProMaxGraderBundleArtifact } from "./artifacts"
import type { PromaxArtifactSource, PromaxGraderTaskView } from "./types"

export interface ProMaxGraderBundle {
  /** Which verified upstream bytes this bundle was prepared from. */
  readonly source: PromaxArtifactSource
  readonly contentSha256: string
  /** Ids this bundle covers, in preparation order. Identity only — no gold. */
  readonly instanceIds: readonly string[]
  /** The ONE way to obtain a private view. Throws for an unknown id. */
  readonly resolve: (instanceId: string) => PromaxGraderTaskView
}

/**
 * Open a grader bundle from its serialized bytes. The envelope's content digest
 * is verified first (see `artifacts.ts`), so a hand-edited gold corpus cannot be
 * graded against.
 */
export const openProMaxGraderBundle = (text: string): ProMaxGraderBundle => {
  const artifact = parseProMaxGraderBundleArtifact(text)
  const byId = new Map<string, PromaxGraderTaskView>()
  for (const task of artifact.tasks) byId.set(task.instanceId, task)
  return {
    source: artifact.source,
    contentSha256: artifact.contentSha256,
    instanceIds: artifact.tasks.map((t) => t.instanceId),
    resolve: (instanceId) => {
      const view = byId.get(instanceId)
      if (view === undefined) {
        throw new Error(
          `promax grader bundle: no eval record for instance "${instanceId}" ` +
            `(bundle covers ${byId.size} instance(s) from upstream ${artifact.source.upstreamGitCommit.slice(0, 12)}). ` +
            "REFUSING to grade an instance the verified bundle does not cover.",
        )
      }
      return view
    },
  }
}
