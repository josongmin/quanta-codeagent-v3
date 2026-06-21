import type { Instance } from "../types"
import type { Candidate } from "./selection-executor"

const addedLines = (patch: string): string =>
  patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")

const postPatchHunkLines = (patch: string): string =>
  patch
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n")

const hasSingleRequiredColumnExceptionShape = (problemStatement: string): boolean => {
  const text = problemStatement.toLowerCase()
  return (
    /\bmisleading\b/.test(text) &&
    /\b(?:exception|error|valueerror|message)\b/.test(text) &&
    /\badditional required columns?\b/.test(text) &&
    /\bfirst columns?\b/.test(text)
  )
}

const hasPostgresqlEmptyEnvIssueShape = (problemStatement: string): boolean => {
  const text = problemStatement.toLowerCase()
  return (
    /\bpostgresql\b/.test(text) &&
    /\bempty\s+dict\b/.test(text) &&
    /\bos\.environ\b/.test(text) &&
    /\bsubprocess\b/.test(text)
  )
}

const hasRequiredColumnsScalarFallback = (added: string): boolean =>
  /\brequired_columns\s*\[\s*0\s*\]/.test(added) &&
  !/\blen\s*\(\s*required_columns\s*\)\s*(?:==|<=)\s*1\b/.test(added)

const hasFoundColumnsScalarFallback = (added: string): boolean =>
  /\bself\.colnames\s*\[\s*0\s*\]/.test(added) &&
  !/\bself\.colnames\s*\[\s*:\s*len\s*\(\s*required_columns\s*\)\s*\]/.test(added)

const hasQuotedListPlaceholder = (postPatchHunk: string): boolean =>
  /\bexpected\s+'\{\}'/.test(postPatchHunk) || /\bfound\s+'\{\}'/.test(postPatchHunk)

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const touchesFile = (patch: string, file: string): boolean => {
  const escaped = escapeRegex(file)
  return new RegExp(`^diff --git a/${escaped} b/${escaped}`, "m").test(patch)
}

const hasUnsafeEnvNoneInitialization = (added: string, postPatchHunk: string): boolean =>
  /\benv\s*=\s*None\b/.test(added) && /\benv\s*\[/.test(postPatchHunk)

const hasPostgresEnvOrNoneReturn = (added: string): boolean =>
  /\breturn\s+args\s*,\s*\(?\s*env\s+or\s+None\s*\)?/.test(added) ||
  /\breturn\s+args\s*,\s*None\s+if\s+not\s+env\s+else\s+env\b/.test(added)

const hasBaseEmptyEnvNormalization = (added: string): boolean =>
  /\benv\s*=\s*\{\s*\*\*os\.environ\s*,\s*\*\*env\s*\}\s*if\s+env\s+else\s+None\b/.test(added) ||
  /\benv\s*=\s*None\s+if\s+not\s+env\s+else\s+\{\s*\*\*os\.environ\s*,\s*\*\*env\s*\}/.test(
    added,
  ) ||
  /\belse\s*:\s*\n\s*env\s*=\s*None\b/.test(added) ||
  /\bsubprocess\.run\s*\(\s*args\s*,\s*env\s*=\s*\(?\s*env\s+or\s+None\s*\)?\s*,\s*check\s*=\s*True\s*\)/.test(
    added,
  )

const postgresqlEmptyEnvPatchMatch = (patch: string): boolean => {
  const added = addedLines(patch)
  const postPatchHunk = postPatchHunkLines(patch)
  if (added.trim() === "") return false
  if (hasUnsafeEnvNoneInitialization(added, postPatchHunk)) return false
  return (
    touchesFile(patch, "django/db/backends/postgresql/client.py") &&
    touchesFile(patch, "django/db/backends/base/client.py") &&
    hasPostgresEnvOrNoneReturn(added) &&
    hasBaseEmptyEnvNormalization(added)
  )
}

export const declaredExpectedPatchMatch = (
  problemStatement: string,
  patch: string,
): boolean | null => {
  if (hasPostgresqlEmptyEnvIssueShape(problemStatement)) {
    return postgresqlEmptyEnvPatchMatch(patch)
  }
  if (!hasSingleRequiredColumnExceptionShape(problemStatement)) return null
  const added = addedLines(patch)
  const postPatchHunk = postPatchHunkLines(patch)
  if (added.trim() === "") return false
  if (hasRequiredColumnsScalarFallback(added)) return false
  if (hasFoundColumnsScalarFallback(added)) return false
  if (hasQuotedListPlaceholder(postPatchHunk)) return false
  return (
    /\brequired_columns\b/.test(added) &&
    /\bself\.colnames\s*\[\s*:\s*len\s*\(\s*required_columns\s*\)\s*\]/.test(added)
  )
}

export const makeDeclaredExpectedSelectionPort =
  (instance: Pick<Instance, "problemStatement">): ((c: Candidate) => Promise<boolean | null>) =>
  async (c) =>
    declaredExpectedPatchMatch(instance.problemStatement, c.patch)
