import { readFileSync } from "node:fs"
import { matchesInstanceFilter } from "@/runner/batch/instance-selection"
import type { DatasetFamily } from "./dataset-family"
import { readFamilyCorpusText } from "./profiles/corpus-read"
import { type FamilyCorpusRow, type FamilyCorpusTask, runnableTasksOf } from "./profiles/corpus-row"
import { applySelectionOrder, resolveFamilySelectedInstanceIds } from "./profiles/selection"
import { argValue } from "./run-args"

export type SwebenchRunnableRow = FamilyCorpusRow & { readonly task: FamilyCorpusTask }

/** Parse a family-owned SWE-bench corpus once for both plan and execution. */
export const readSwebenchTasks = (
  datasetFile: string,
  family: DatasetFamily,
): SwebenchRunnableRow[] => [
  ...runnableTasksOf(readFamilyCorpusText(readFileSync(datasetFile, "utf8"), family)),
]

/** Apply family selection authority first, then the legacy instance filter. */
export const filterSwebenchTasks = (
  parsed: readonly SwebenchRunnableRow[],
  selection: { readonly family: DatasetFamily; readonly env: NodeJS.ProcessEnv },
): SwebenchRunnableRow[] => {
  const instanceFilter = argValue("--instance")
  const ids = resolveFamilySelectedInstanceIds({
    family: selection.family,
    rows: parsed,
    env: selection.env,
    surface: "local-run",
    ...(instanceFilter !== undefined ? { instanceFilter } : {}),
  })
  if (ids !== undefined) return applySelectionOrder(parsed, ids, "local-run")
  return instanceFilter !== undefined && instanceFilter !== ""
    ? parsed.filter((task) => matchesInstanceFilter(task.instanceId, instanceFilter))
    : [...parsed]
}
