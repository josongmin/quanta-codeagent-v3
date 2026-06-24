/**
 * Bench-owned reproduction artifacts that may live inside the sandbox worktree
 * during repair/proof, but must never be treated as submitted source edits.
 */

const REPRO_SCRIPT_BASENAME_RE = /^(__repro_\d+_[0-9a-fA-F-]+\.py|reproduce_issue\.py)$/
const REPRO_PYTEST_REPORT_BASENAME_RE =
  /^(__repro_\d+_[0-9a-fA-F-]+\.py|reproduce_issue\.py)\.pytest-report\.json$/

const basenameOf = (path: string): string => {
  const normalized = path.split("\\").join("/")
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

export const isBenchReproArtifactBasename = (name: string): boolean =>
  REPRO_SCRIPT_BASENAME_RE.test(name) || REPRO_PYTEST_REPORT_BASENAME_RE.test(name)

export const isBenchReproArtifactPath = (path: string): boolean =>
  isBenchReproArtifactBasename(basenameOf(path))
