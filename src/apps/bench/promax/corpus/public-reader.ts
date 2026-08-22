/**
 * PMX-02 — the AGENT-SIDE ProMax corpus reader.
 *
 * This is the reader a run uses. It opens ONE file — the public tasks artifact —
 * and it has no parameter, no environment read, and no field that could tell it
 * where a grader bundle lives. That is the point: "the agent runtime cannot
 * learn the grader-bundle path" is true because there is nothing to learn from.
 *
 * ## Formats accepted, and why more than one
 *
 *  1. the PUBLIC ARTIFACT envelope (`public-tasks.json`) — the canonical form
 *     trusted preparation emits, whose content digest is verified on read;
 *  2. a bare JSON ARRAY of rows — the OFFICIAL upstream shape. Accepting it is
 *     required by the ticket ("do not force it through the JSONL-only reader")
 *     and is also what makes the gold-leak preflight meaningful: an operator who
 *     points a run at the raw gold-bearing dataset gets a LOUD refusal from the
 *     preflight rather than a silent zero-row parse;
 *  3. JSONL of rows — the shape Quanta's own chunk slicer writes.
 *
 * ## What this reader does NOT do
 *
 * It does not refuse gold. That refusal belongs to the dataset preflight, which
 * can say "this chunk carries grader-only fields" with the right message at the
 * right moment. What this reader guarantees instead is stronger and unconditional:
 * the {@link PromaxAgentTaskView} it produces is a CLOSED struct built field by
 * field, so no amount of gold in the input can reach the agent through it — with
 * or without a preflight, on the local path as much as the remote one.
 */
import { errMessage, logger } from "@/shared"
import { parseProMaxPublicTasksArtifact } from "./artifacts"
import type { PromaxAgentTaskView } from "./types"

/** One row as read from a ProMax corpus file. */
export interface ProMaxPublicRow {
  readonly instanceId: string
  /**
   * The row EXACTLY as it appeared in the file. May carry grader-only fields
   * when the operator pointed at the raw official dataset — which is precisely
   * what the preflight inspects in order to refuse. Never handed to the agent:
   * the agent side gets {@link view}.
   */
  readonly record: Record<string, unknown>
  /**
   * The PUBLIC projection, present only when the row carries every field a
   * runnable task needs. Absent rows stay VISIBLE to preflight/selection, which
   * matches the historical, deliberately-permissive dataset reader.
   */
  readonly view?: PromaxAgentTaskView
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const str = (record: Record<string, unknown>, ...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

/** Identity, accepting both the typed camelCase view spelling and the official
 *  snake_case dataset spelling (plus the generic `id` fallback the rest of the
 *  bench dataset layer honours). */
const rowInstanceId = (record: Record<string, unknown>): string | undefined =>
  str(record, "instanceId", "instance_id", "id")

const rowView = (
  record: Record<string, unknown>,
  instanceId: string,
): PromaxAgentTaskView | undefined => {
  const repo = str(record, "repo")
  const baseCommit = str(record, "baseCommit", "base_commit")
  const problemStatement = str(record, "problemStatement", "problem_statement")
  const language = str(record, "language")
  if (
    repo === undefined ||
    baseCommit === undefined ||
    problemStatement === undefined ||
    language === undefined
  ) {
    return undefined
  }
  // CLOSED construction: every field named explicitly. There is no spread of the
  // source row, so a new upstream key cannot silently become agent-visible.
  return { instanceId, repo, baseCommit, problemStatement, language }
}

const toRow = (value: unknown): ProMaxPublicRow | undefined => {
  if (!isRecord(value)) return undefined
  const instanceId = rowInstanceId(value)
  if (instanceId === undefined) return undefined
  const view = rowView(value, instanceId)
  return { instanceId, record: value, ...(view !== undefined ? { view } : {}) }
}

const rowsFromArray = (values: readonly unknown[]): ProMaxPublicRow[] => {
  const out: ProMaxPublicRow[] = []
  for (const value of values) {
    const row = toRow(value)
    if (row !== undefined) out.push(row)
  }
  return out
}

const rowsFromJsonl = (text: string): ProMaxPublicRow[] => {
  const out: ProMaxPublicRow[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const row = toRow(JSON.parse(trimmed))
      if (row !== undefined) out.push(row)
    } catch (e) {
      // Skip malformed line — same tolerance as the official JSONL reader, and
      // now the same attribution: a dropped line is a task the run will never
      // attempt, which used to leave no trace at all.
      logger.warn(`promax-public-reader.rowsFromJsonl: skipped malformed line: ${errMessage(e)}`)
    }
  }
  return out
}

/**
 * Read a ProMax corpus file's TEXT into ordered rows. Never throws for row-level
 * malformation (bad rows are skipped, matching the rest of the dataset layer);
 * DOES throw when a public ARTIFACT envelope fails its content-digest seal,
 * because that is tampering rather than a sloppy row.
 */
export const readProMaxCorpusRows = (text: string): readonly ProMaxPublicRow[] => {
  const trimmed = text.trim()
  if (trimmed === "") return []
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return Array.isArray(parsed) ? rowsFromArray(parsed) : []
    } catch (e) {
      // The text OPENS with `[`, so it is declaring itself the bare-JSON-array
      // form; a parse fault is a corrupt corpus, not a format mismatch. Returning
      // `[]` unattributed made a corrupt dataset indistinguishable from an empty
      // one — the exact silence the gold-leak preflight (header, format 2) relies
      // on NOT happening. Control flow is unchanged; the fault is now nameable.
      logger.warn(
        `promax-public-reader.readProMaxCorpusRows: corpus array unparseable: ${errMessage(e)}`,
      )
      return []
    }
  }
  if (trimmed.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Not one JSON object — fall through to the line-oriented reader, which is
      // what a JSONL file starting with `{` actually is.
      return rowsFromJsonl(text)
    }
    if (isRecord(parsed) && parsed.artifact === "promax-public-tasks") {
      // Digest-verified read. Throws on tampering.
      return rowsFromArray(parseProMaxPublicTasksArtifact(trimmed).tasks)
    }
    return rowsFromArray(isRecord(parsed) ? [parsed] : [])
  }
  return rowsFromJsonl(text)
}

/** The agent-visible views only. Rows that do not form a runnable task are
 *  dropped, exactly as the official reader drops rows missing required fields. */
export const readProMaxPublicTasks = (text: string): readonly PromaxAgentTaskView[] =>
  readProMaxCorpusRows(text).flatMap((row) => (row.view !== undefined ? [row.view] : []))
