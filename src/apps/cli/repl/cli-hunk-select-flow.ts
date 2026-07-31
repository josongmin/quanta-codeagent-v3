import { isAbsolute, resolve } from "node:path"
import type { ConfirmDecision } from "@/agent"
import type { ToolAction } from "@/permission"
import { splitHunks } from "@/runner/diff-ops"
import { applyHunkSelection } from "@/runner/hunk-apply"
import { runtimeConfig } from "@/shared"
import { type ActionDiff, computeActionDiff } from "../diff-preview"
import { parseHunkSelection, renderHunkChoices, shapePartialDecision } from "./hunk-select"
import type { CliHitlDeps } from "./cli-approval-prompt"

export const maybeHunkOption = async (
  deps: Pick<CliHitlDeps, "cwd">,
  action: ToolAction,
): Promise<{ diff: ActionDiff; ids: string[] } | undefined> => {
  if (!runtimeConfig().hunkApproval) return undefined
  try {
    const reader = (p: string): Promise<string> => {
      const abs = isAbsolute(p) ? p : resolve(deps.cwd, p)
      return Bun.file(abs).text()
    }
    const diff = await computeActionDiff(action, { readFile: reader })
    if (diff === undefined) return undefined
    const ids = splitHunks(diff.before, diff.after).map((h) => h.id)
    if (ids.length < 2) return undefined
    return { diff, ids }
  } catch {
    return undefined
  }
}

export const runHunkSelect = async (
  deps: CliHitlDeps,
  diff: ActionDiff,
  ids: string[],
  askLine: (channel: CliHitlDeps["channel"], prompt: string, label?: string) => Promise<string>,
): Promise<boolean | ConfirmDecision> => {
  const raw = await askLine(
    deps.channel,
    `${renderHunkChoices(diff.before, diff.after)}\nAccept which hunks? [1-${ids.length}] (e.g. "1,3" / "all" / "none"): `,
  )
  deps.idleMonitor.markActive()
  const selected = parseHunkSelection(raw, ids)
  if (selected.length === ids.length) {
    deps.rejectCounter.recordAccept()
    return true
  }
  if (selected.length === 0) {
    deps.rejectCounter.recordDeny()
    return false
  }
  const path = isAbsolute(diff.path) ? diff.path : resolve(deps.cwd, diff.path)
  const result = await applyHunkSelection({
    path,
    before: diff.before,
    after: diff.after,
    selectedHunkIds: selected,
  })
  if (result.status === "applied") deps.rejectCounter.recordAccept()
  else deps.rejectCounter.recordDeny()
  return shapePartialDecision(result, selected, ids, diff.path)
}
