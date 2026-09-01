import { access, readdir } from "node:fs/promises"
import { resolve } from "node:path"

/** Immutable filesystem view owned by one feature-catalog validation command. */
export interface FeatureEvidenceSnapshot {
  readonly pathExists: (repoRelative: string) => Promise<boolean>
  readonly adrExists: (padded: string) => Promise<boolean>
}

/**
 * De-duplicate evidence probes within one exact validation input.
 *
 * The cache is deliberately command-scoped rather than process-global. A later
 * validation in the same Bun process constructs a new snapshot and therefore
 * observes create/delete mutations used by RED-injection tests.
 */
export const createFeatureEvidenceSnapshot = (repoRoot: string): FeatureEvidenceSnapshot => {
  const pathSnapshots = new Map<string, Promise<boolean>>()
  const directorySnapshots = new Map<string, Promise<readonly string[]>>()

  const pathExists = (repoRelative: string): Promise<boolean> => {
    const absolute = resolve(repoRoot, repoRelative)
    const cached = pathSnapshots.get(absolute)
    if (cached !== undefined) return cached
    const snapshot = access(absolute).then(
      () => true,
      () => false,
    )
    pathSnapshots.set(absolute, snapshot)
    return snapshot
  }

  const readDirectory = (dir: string): Promise<readonly string[]> => {
    const cached = directorySnapshots.get(dir)
    if (cached !== undefined) return cached
    const snapshot = readdir(dir).catch((error: unknown) => {
      throw new Error(
        `feature catalog: cannot read ${dir} — an unreachable decisions directory is ` +
          `not an absent ADR. (${error instanceof Error ? error.message : String(error)})`,
      )
    })
    directorySnapshots.set(dir, snapshot)
    return snapshot
  }

  const adrExists = async (padded: string): Promise<boolean> => {
    const dir = resolve(repoRoot, "docs/decisions")
    return (await readDirectory(dir)).some(
      (name) => name.startsWith(`${padded}-`) && name.endsWith(".md"),
    )
  }

  return { pathExists, adrExists }
}
