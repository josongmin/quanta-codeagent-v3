/**
 * Synthetic scenario schema. One JSON file per scenario, grouped under
 * `scenarios/<usecase-id>/<scenario-id>.json`.
 *
 * Keep the schema additive — older scenarios must remain runnable when a new
 * optional field is added. Breaking changes require a schema bump consumed by
 * `loadScenario`.
 *
 * Why JSON not YAML: no parser dep, hand-editable, diffs cleanly. The cost is
 * verbosity; pay it.
 */
import { readFileSync } from "node:fs"
import type { UseCaseId } from "../types"

export const SCENARIO_SCHEMA_VERSION = 1 as const

export interface RubricItem {
  /** Stable id within the scenario; used by the judge to map verdicts back. */
  id: string
  /** One-line description the judge will score against. */
  description: string
  /** Optional weight ∈ (0,1]. Default 1. Aggregate score = sum(weight×pass)/sum(weight). */
  weight?: number
}

export interface ScenarioFile {
  /** Pre-seeded files written into the sandbox root before the agent runs. */
  path: string
  content: string
}

export interface Scenario {
  schema: typeof SCENARIO_SCHEMA_VERSION
  /** Stable id local to its use case (filename stem). */
  id: string
  /** Which use case this scenario evidences. */
  usecase: UseCaseId
  /** Human-friendly title. */
  title: string
  /** The user-message handed to the agent verbatim. */
  prompt: string
  /** Optional setup files written to sandbox before the agent starts. */
  files?: readonly ScenarioFile[]
  /** Optional shell to run pre-agent (deps, build). Failures abort the run. */
  setupCmd?: string
  /** Rubric items the judge scores against. ≥1 required. */
  rubric: readonly RubricItem[]
  /** Forbidden substrings in tool inputs (e.g. `rm -rf`, `git push --force`).
   *  ANY hit → verdict `fail` regardless of judge score. */
  forbidden?: readonly string[]
  /** Optional ceiling on agent turns. Default 8. */
  maxTurns?: number
}

/** Tolerant loader: validates required fields, fills defaults, throws on shape error. */
export const parseScenario = (raw: unknown): Scenario => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("scenario must be an object")
  }
  const r = raw as Record<string, unknown>
  const schema = r.schema
  if (schema !== SCENARIO_SCHEMA_VERSION) {
    throw new Error(
      `scenario schema mismatch: got ${String(schema)}, want ${SCENARIO_SCHEMA_VERSION}`,
    )
  }
  const id = r.id
  const usecase = r.usecase
  const title = r.title
  const prompt = r.prompt
  const rubric = r.rubric
  if (
    typeof id !== "string" ||
    typeof usecase !== "string" ||
    typeof title !== "string" ||
    typeof prompt !== "string" ||
    !Array.isArray(rubric) ||
    rubric.length === 0
  ) {
    throw new Error("scenario missing required fields: id, usecase, title, prompt, rubric[]")
  }
  // Validate optional `forbidden`/`maxTurns` strictly: a silently-dropped
  // non-string in `forbidden` would defeat the safety net (e.g. model emits
  // `[{pattern:"rm -rf"}]` → empty list → unguarded). `maxTurns` is the
  // loop ceiling, so a NaN/negative/zero value would either crash runAgent or
  // produce a zero-turn run scored as fail.
  const forbiddenRaw = r.forbidden
  let forbidden: readonly string[] | undefined
  if (forbiddenRaw !== undefined) {
    if (!Array.isArray(forbiddenRaw)) {
      throw new Error("scenario.forbidden must be a string array when present")
    }
    for (const x of forbiddenRaw) {
      if (typeof x !== "string") {
        throw new Error(`scenario.forbidden contains non-string entry: ${JSON.stringify(x)}`)
      }
    }
    forbidden = forbiddenRaw as readonly string[]
  }
  const maxTurnsRaw = r.maxTurns
  let maxTurns: number | undefined
  if (maxTurnsRaw !== undefined) {
    if (typeof maxTurnsRaw !== "number" || !Number.isInteger(maxTurnsRaw) || maxTurnsRaw < 1) {
      throw new Error(`scenario.maxTurns must be a positive integer (got ${String(maxTurnsRaw)})`)
    }
    maxTurns = maxTurnsRaw
  }
  const out: Scenario = {
    schema: SCENARIO_SCHEMA_VERSION,
    id,
    usecase,
    title,
    prompt,
    rubric: rubric.map(parseRubric),
    ...(Array.isArray(r.files) ? { files: r.files.map(parseFile) } : {}),
    ...(typeof r.setupCmd === "string" ? { setupCmd: r.setupCmd } : {}),
    ...(forbidden !== undefined ? { forbidden } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  }
  return out
}

const parseRubric = (raw: unknown): RubricItem => {
  if (typeof raw !== "object" || raw === null) throw new Error("rubric item must be object")
  const r = raw as Record<string, unknown>
  const id = r.id
  const description = r.description
  if (typeof id !== "string" || typeof description !== "string") {
    throw new Error("rubric item requires id, description")
  }
  return {
    id,
    description,
    ...(typeof r.weight === "number" && r.weight > 0 && r.weight <= 1 ? { weight: r.weight } : {}),
  }
}

const parseFile = (raw: unknown): ScenarioFile => {
  if (typeof raw !== "object" || raw === null) throw new Error("file entry must be object")
  const r = raw as Record<string, unknown>
  const path = r.path
  const content = r.content
  if (typeof path !== "string" || typeof content !== "string") {
    throw new Error("file entry requires path, content")
  }
  return { path, content }
}

export const loadScenarioFile = (path: string): Scenario => {
  const text = readFileSync(path, "utf8")
  return parseScenario(JSON.parse(text))
}
