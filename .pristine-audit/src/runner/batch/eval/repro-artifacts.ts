/**
 * Bench-owned reproduction artifacts that may live inside the sandbox worktree
 * during repair/proof, but must never be treated as submitted source edits.
 */

// Repro scaffold/sidecar basenames now come from the LEAF SSOT (scaffold-patterns) so the
// artifact filter, snapshot strip, patch hygiene, anchor synth, and the ReproAdapter share ONE
// definition — a polyglot repro can't drift these out of sync with the executor (RFC Phase 1b).
// Re-exported for back-compat with existing importers.
export {
  REPRO_PY_REPORT_BASENAME_RE as REPRO_PYTEST_REPORT_BASENAME_RE,
  REPRO_PY_SCRIPT_BASENAME_RE as REPRO_SCRIPT_BASENAME_RE,
} from "@/agent/repro-test/scaffold-patterns"

import { isReproArtifactBasename } from "@/agent/repro-test/scaffold-patterns"

const basenameOf = (path: string): string => {
  const normalized = path.split("\\").join("/")
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

export const isBenchReproArtifactBasename = (name: string): boolean => isReproArtifactBasename(name)

export const isBenchReproArtifactPath = (path: string): boolean =>
  isBenchReproArtifactBasename(basenameOf(path))
