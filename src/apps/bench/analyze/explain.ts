/**
 * ADR-0536 P0 — automated agent-vs-gold failure analysis (PURE).
 *
 * Replaces the manual "open the gold patch, open the agent patch, eyeball which
 * files each touched, then read FAIL_TO_PASS" loop that produced the
 * pylint-8898 finding (the agent touched the RIGHT file but used the wrong
 * algorithm — a same-file/wrong-fix signal). This module computes the file-set
 * comparison mechanically so the human only reads the divergence.
 *
 * I/O is limited to reading the dataset jsonl and (optionally) the agent patch
 * file. Everything else is a pure string transform.
 */

import { readFileSync } from "node:fs"

export interface FailureExplanation {
  readonly instanceId: string
  readonly failToPass: readonly string[]
  readonly goldPatch: string
  readonly testPatch: string
  readonly agentPatch: string | undefined
  /** files touched by gold (from `diff --git` headers) */
  readonly goldFiles: readonly string[]
  /** files touched by agent */
  readonly agentFiles: readonly string[]
  /** did the agent touch the SAME file set as gold? (set equality) */
  readonly sameFiles: boolean
  readonly summary: string
}

/**
 * Extract the `b/<path>` target file of every `diff --git a/… b/…` header in a
 * unified-diff string. Returns paths in first-seen order with duplicates
 * removed. Pure; tolerant of paths containing spaces by taking everything after
 * the ` b/` marker to end-of-line.
 */
export const filesInDiff = (patch: string): string[] => {
  const files: string[] = []
  const seen = new Set<string>()
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue
    // Header form: `diff --git a/<x> b/<y>`. The b-side is the post-image path
    // (the file as it exists after the change). Find the ` b/` separator; the
    // remainder of the line is the path (may contain spaces).
    const marker = line.indexOf(" b/")
    if (marker === -1) continue
    const path = line.slice(marker + 3).trim()
    if (path.length === 0 || seen.has(path)) continue
    seen.add(path)
    files.push(path)
  }
  return files
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** FAIL_TO_PASS may be a real array OR a JSON-encoded string array (the
 *  upstream SWE-bench parquet→jsonl export double-encodes it). Both → string[]. */
const failToPass = (v: unknown): string[] => {
  const coerce = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.length > 0) : []
  if (Array.isArray(v)) return coerce(v)
  if (typeof v === "string") {
    try {
      return coerce(JSON.parse(v))
    } catch {
      return []
    }
  }
  return []
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** Find the dataset row for `instanceId`. Each line is one JSON object with an
 *  `instance_id` field; blank lines skipped. */
const findRow = (datasetText: string, instanceId: string): Record<string, unknown> => {
  for (const line of datasetText.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (isRecord(parsed) && parsed.instance_id === instanceId) return parsed
  }
  throw new Error(`explainFailure: instance "${instanceId}" not found in dataset`)
}

const setEq = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((x) => sb.has(x))
}

const renderSummary = (e: Omit<FailureExplanation, "summary">): string => {
  const f2p =
    e.failToPass.length === 0
      ? "  (none recorded)"
      : e.failToPass.map((t) => `  - ${t}`).join("\n")
  const goldF =
    e.goldFiles.length === 0 ? "  (none)" : e.goldFiles.map((f) => `  - ${f}`).join("\n")
  const agentF =
    e.agentPatch === undefined
      ? "  (no agent patch provided)"
      : e.agentFiles.length === 0
        ? "  (agent produced an empty / non-diff patch)"
        : e.agentFiles.map((f) => `  - ${f}`).join("\n")

  const overlap = e.goldFiles.filter((f) => e.agentFiles.includes(f))
  let verdict: string
  if (e.agentPatch === undefined) {
    verdict = "NO AGENT PATCH — agent produced nothing to compare."
  } else if (e.sameFiles) {
    verdict =
      "SAME FILE SET — agent edited exactly the gold files but did NOT pass. " +
      "Strong signal of a wrong fix in the right place (cf. pylint-8898: right file, wrong algorithm)."
  } else if (overlap.length > 0) {
    verdict =
      `PARTIAL OVERLAP — agent touched ${overlap.length}/${e.goldFiles.length} of the gold files ` +
      `(overlap: ${overlap.join(", ")}). Likely incomplete fix.`
  } else {
    verdict =
      "DISJOINT FILE SETS — agent edited entirely different files than gold. " +
      "Likely wrong localisation (looked in the wrong place)."
  }

  return [
    `=== Failure analysis: ${e.instanceId} ===`,
    "",
    "FAIL_TO_PASS tests:",
    f2p,
    "",
    "Gold touched files:",
    goldF,
    "",
    "Agent touched files:",
    agentF,
    "",
    `Verdict: ${verdict}`,
  ].join("\n")
}

export const explainFailure = (args: {
  datasetPath: string
  instanceId: string
  agentPatch?: string
  agentPatchPath?: string
}): FailureExplanation => {
  const datasetText = readFileSync(args.datasetPath, "utf8")
  const row = findRow(datasetText, args.instanceId)

  const goldPatch = str(row.patch)
  const testPatch = str(row.test_patch)
  const f2p = failToPass(row.FAIL_TO_PASS)

  // Agent patch: explicit string wins; else read the file if a path was given;
  // else undefined (no agent artifact available).
  const agentPatch =
    args.agentPatch !== undefined
      ? args.agentPatch
      : args.agentPatchPath !== undefined
        ? readFileSync(args.agentPatchPath, "utf8")
        : undefined

  const goldFiles = filesInDiff(goldPatch)
  const agentFiles = agentPatch === undefined ? [] : filesInDiff(agentPatch)
  // sameFiles is meaningful only when there IS an agent patch; with none we
  // report false (there is nothing matching the gold set).
  const sameFiles = agentPatch !== undefined && setEq(goldFiles, agentFiles)

  const partial: Omit<FailureExplanation, "summary"> = {
    instanceId: args.instanceId,
    failToPass: f2p,
    goldPatch,
    testPatch,
    agentPatch,
    goldFiles,
    agentFiles,
    sameFiles,
  }
  return { ...partial, summary: renderSummary(partial) }
}
