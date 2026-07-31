/**
 * `EvalMeta` sidecar — the AUTHORITATIVE source for "what prompt produced this
 * trajectory" (and any other context the JSONL trajectory itself doesn't
 * carry: cwd, scenario id, use case label when known at record time).
 *
 * Why a sidecar instead of reading the trajectory:
 *   - `JsonlRecorder` is a shared producer (RFC-0002 §5.2) — adding fields
 *     would break the trajectory contract for non-eval consumers.
 *   - The seed user prompt lives in `AgentConfig.messages`, not in any
 *     emitted `AgentEvent`. Recovering it from `assistant_text` deltas would
 *     be a heuristic; we don't do heuristics here.
 *
 * Path convention: `<jsonl_basename>.meta.json` next to the JSONL file.
 *
 * Writer: `synthetic/runner.ts` (Tier 1) and `trajectory/freeze.ts` (manual
 * promotion of a real session). Reader: `trajectory/source.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { errMessage } from "@/shared"

export const EVAL_META_SCHEMA = 1 as const

export interface EvalMeta {
  schema: typeof EVAL_META_SCHEMA
  /** Seed user message text (concatenated `text` blocks of message[0]). */
  userPrompt: string
  /** Working directory the agent ran in. */
  cwd: string
  /** Model id (taken from `LLMPort.model` at run time). */
  model?: string
  /** Scenario id when produced by Tier 1 synthetic. */
  scenarioId?: string
  /** Use case id when known at record time (Tier 1 always; freeze on demand). */
  usecase?: string
  /** Recorder identity (mirrors `TrajectoryEvent.producer`). */
  producer: { name: string; version?: string }
  /** ISO-8601 timestamp at record time. */
  recordedAt: string
}

/** Append the canonical sidecar suffix to a JSONL trajectory path. */
export const metaPathFor = (jsonlPath: string): string => `${jsonlPath}.meta.json`

/** Write the meta sidecar. Caller decides the JSONL path; we derive the sibling. */
export const writeMeta = (jsonlPath: string, meta: EvalMeta): void => {
  writeFileSync(metaPathFor(jsonlPath), JSON.stringify(meta, null, 2))
}

/** Discriminated read result so callers can tell "operator hasn't recorded
 *  meta" (`missing`) from "operator wrote broken meta" (`malformed`). The
 *  prior `EvalMeta | null` surface conflated the two and prevented a
 *  meaningful error message when meta drifted out of spec. */
export type MetaReadResult =
  | { kind: "ok"; meta: EvalMeta }
  | { kind: "missing" }
  | { kind: "malformed"; error: string }

/** Rich read result — preferred entry point for new callers. */
export const readMetaResult = (jsonlPath: string): MetaReadResult => {
  const p = metaPathFor(jsonlPath)
  if (!existsSync(p)) return { kind: "missing" }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p, "utf8"))
  } catch (e) {
    return { kind: "malformed", error: `JSON parse: ${errMessage(e)}` }
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "malformed", error: "sidecar root is not an object" }
  }
  const o = raw as Record<string, unknown>
  if (o.schema !== EVAL_META_SCHEMA) {
    return {
      kind: "malformed",
      error: `schema mismatch: got ${String(o.schema)}, want ${EVAL_META_SCHEMA}`,
    }
  }
  const userPrompt = o.userPrompt
  const cwd = o.cwd
  const producer = o.producer
  const recordedAt = o.recordedAt
  if (typeof userPrompt !== "string") {
    return { kind: "malformed", error: "userPrompt missing or not a string" }
  }
  if (typeof cwd !== "string") {
    return { kind: "malformed", error: "cwd missing or not a string" }
  }
  if (typeof recordedAt !== "string") {
    return { kind: "malformed", error: "recordedAt missing or not a string" }
  }
  if (typeof producer !== "object" || producer === null) {
    return { kind: "malformed", error: "producer missing or not an object" }
  }
  const prodName = (producer as Record<string, unknown>).name
  if (typeof prodName !== "string") {
    return { kind: "malformed", error: "producer.name missing or not a string" }
  }
  const prodVer = (producer as Record<string, unknown>).version
  const meta: EvalMeta = {
    schema: EVAL_META_SCHEMA,
    userPrompt,
    cwd,
    producer: {
      name: prodName,
      ...(typeof prodVer === "string" ? { version: prodVer } : {}),
    },
    recordedAt,
    ...(typeof o.model === "string" ? { model: o.model } : {}),
    ...(typeof o.scenarioId === "string" ? { scenarioId: o.scenarioId } : {}),
    ...(typeof o.usecase === "string" ? { usecase: o.usecase } : {}),
  }
  return { kind: "ok", meta }
}

/** Backwards-compatible thin wrapper. Prefer `readMetaResult` in new code. */
export const readMeta = (jsonlPath: string): EvalMeta | null => {
  const r = readMetaResult(jsonlPath)
  return r.kind === "ok" ? r.meta : null
}
