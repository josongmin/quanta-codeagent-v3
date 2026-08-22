/**
 * TB21-05 — the SWE-bench preset-label fallback chain, extracted out of the page
 * shell and given to the suite that owns it.
 *
 * The versioned preset (`agentless-v2`, `v3-thin-strict`, …) is a `--preset` CLI
 * arg that is NOT persisted in `report.json`, so a SWE campaign's label is
 * RECOVERED from the file path and the knob fingerprint — the ground truth of how
 * it was launched. A trailing `*` marks a label inferred rather than read.
 *
 * That is suite knowledge, and it was the last of it left in `server.ts`. A suite
 * whose reports label their own presets supplies `ProjectedRun.presetLabel` and
 * never reaches this chain at all (Terminal-Bench 2.1 does exactly that: TB21-03
 * persists the profile, so nothing about a Terminal run is ever inferred from a
 * filename).
 *
 * PURE: path + knobs in, label out. No fs, no clock, no globals.
 */

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null ? (value as JsonRecord) : null

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null)

const baseName = (path: string): string => path.split("/").pop() ?? path

const presetFromEncodedFileName = (name: string): string | undefined => {
  if (/v3.?thin.*strict|strict/.test(name)) return "agentless-v3-thin-strict*"
  if (/v3.?thin|v3thin/.test(name)) return "agentless-v3-thin*"
  if (/norepair/.test(name)) return "agentless-v2 · norepair*"
  if (/reprovote/.test(name)) return "agentless-v2 · reprovote*"
  if (/v2.?repair|[-_]repair/.test(name)) return "agentless-v2 · repair*"
  if (/v2/.test(name)) return "agentless-v2*"
  if (/v1/.test(name)) return "agentless-v1*"
  if (/^local-/.test(name)) return "local"
  return undefined
}

const presetFromSidecar = (name: string, knobs: JsonRecord | null): string | undefined => {
  if (!/^report-i-/.test(name)) return undefined
  const preset = asString(knobs?.preset)
  return typeof preset === "string" && preset.trim()
    ? `${preset} · full-remote`
    : "full-remote · preset 미기록"
}

const presetFromFingerprint = (knobs: JsonRecord | null): string => {
  try {
    const resolved = asRecord(knobs?.resolved) ?? {}
    const issueHint = asRecord(resolved["issue-hint"])
    const reproVote = asRecord(resolved["repro-vote"])
    const bits = [
      asString(issueHint?.value),
      asString(reproVote?.display) ?? asString(reproVote?.value),
    ].filter((bit): bit is string => !!bit)
    return bits.length > 0 ? `${bits.join("/")}*` : "preset 미기록"
  } catch {
    return "preset 미기록"
  }
}

/** Recover a SWE campaign's preset label from its file path + persisted knobs. */
export const swePresetLabel = (file: string, knobs: JsonRecord | null): string => {
  const name = baseName(file).toLowerCase()
  const dir = baseName(file.replace(/\/[^/]+$/, "")).toLowerCase()
  const encoded = presetFromEncodedFileName(name)
  if (encoded !== undefined) return encoded
  if (dir === "sota" || /shard/.test(name)) return "agentless-v2 (SOTA)*"
  const sidecar = presetFromSidecar(name, knobs)
  if (sidecar !== undefined) return sidecar
  return presetFromFingerprint(knobs)
}
