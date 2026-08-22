/**
 * LEAF — the `promax` family's dataset reader, owned by the profile layer.
 *
 * Adapts PMX-02's ProMax corpus reader to the generic {@link FamilyCorpusRow}
 * shape every dataset consumer speaks. Three things happen here and nowhere else:
 *
 *  1. FORMAT — the official corpus is a JSON ARRAY, and Quanta's own slices are
 *     JSONL; `readProMaxCorpusRows` accepts both plus the sealed public artifact.
 *  2. PROJECTION — the `task` half is built from the NARROW public view, so the
 *     `Instance` an agent run receives cannot carry gold. This is the invariant-3
 *     floor and it holds on the LOCAL path too, where no preflight runs.
 *  3. SLICE SAFETY — `sourceLine` is the PUBLIC projection, never the source row.
 *     A chunk file is scp'd to the box the agent runs on, so re-serializing the
 *     source row verbatim (what the JSONL families correctly do) would ship gold.
 *
 * `record` stays the row as it appeared in the file, ON PURPOSE: the preflight's
 * gold-leak check has to be able to SEE `patch` in order to refuse it.
 */
import { projectProMaxRowForAgent } from "@/apps/bench/profiles/promax-projection"
import { readProMaxCorpusRows } from "@/apps/bench/promax/corpus"
import { publicTaskToInstance } from "@/runner/batch/corpus/public-task"
import type { FamilyCorpusReader, FamilyCorpusRow } from "./corpus-row"

/** The official snake_case spelling of a PUBLIC ProMax row — the wire form a
 *  chunk slice carries, so the generic readers downstream (which key on
 *  `instance_id`) keep working unchanged. */
const publicWireRecord = (row: {
  readonly instanceId: string
  readonly record: Record<string, unknown>
  readonly view?: {
    readonly repo: string
    readonly baseCommit: string
    readonly problemStatement: string
    readonly language: string
  }
}): Record<string, unknown> => {
  if (row.view === undefined) {
    // A row that does not form a task still gets a gold-FREE wire form, via the
    // deny-list projection, so a malformed row cannot smuggle gold into a slice.
    return projectProMaxRowForAgent(row.record)
  }
  return {
    instance_id: row.instanceId,
    repo: row.view.repo,
    base_commit: row.view.baseCommit,
    problem_statement: row.view.problemStatement,
    language: row.view.language,
  }
}

/** The row's own PUBLIC `language` column, or undefined. Never widened to any
 *  other key — this must stay a strictly public signal. */
const proMaxRowLanguage = (record: Record<string, unknown>): string | undefined => {
  const raw = record.language
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined
}

export const promaxFamilyCorpusReader: FamilyCorpusReader = (
  text: string,
): readonly FamilyCorpusRow[] =>
  readProMaxCorpusRows(text).map((row): FamilyCorpusRow => {
    const view = row.view
    // aug-22 G3 — the SANCTIONED toolchain-preflight signal. `language` is PUBLIC
    // upstream metadata (it is on the agent view and required by the ProMax shape
    // check), so publishing it here is what lets the strict-grounding preflight
    // stop deriving a task's language from the GOLD PATCH. Taken from the view
    // when the row forms a task, and otherwise from the row's own public
    // `language` column, so a view-less row still never falls back to gold.
    const publicLanguage = view?.language ?? proMaxRowLanguage(row.record)
    return {
      instanceId: row.instanceId,
      record: row.record,
      sourceLine: JSON.stringify(publicWireRecord(row)),
      ...(publicLanguage !== undefined ? { publicLanguage } : {}),
      ...(view !== undefined
        ? {
            task: {
              // NOTE: no `environmentSetupCommit`. Upstream ProMax ships a
              // per-instance IMAGE that owns environment setup, and PMX-02
              // classifies `environment_setup_commit` as GRADER metadata — so the
              // agent-side checkout is base_commit only, by construction.
              checkout: {
                instanceId: view.instanceId,
                repo: view.repo,
                baseCommit: view.baseCommit,
              },
              toInstance: (repoPath: string) => publicTaskToInstance(view, repoPath),
            },
          }
        : {}),
    }
  })
