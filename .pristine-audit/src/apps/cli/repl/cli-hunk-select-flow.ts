import { isAbsolute, resolve } from "node:path"
import type { ConfirmDecision } from "@/agent"
import type { ToolAction } from "@/permission"
import { splitHunks } from "@/runner/diff-ops"
import { applyHunkSelection, type HunkApplyResult } from "@/runner/hunk-apply"
import { applyHunkSelectionWithReceipt } from "@/runner/hunk-mutation-journal"
import { runtimeConfig } from "@/shared"
import { type ActionDiff, computeActionDiff } from "../diff-preview"
import type { CliHitlDeps } from "./cli-approval-prompt"
import { parseHunkSelection, renderHunkChoices, shapePartialDecision } from "./hunk-select"

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
  const result = await applyAccepted(deps, path, diff, selected)
  if (result.status === "applied") deps.rejectCounter.recordAccept()
  else deps.rejectCounter.recordDeny()
  return shapePartialDecision(result, selected, ids, diff.path)
}

/** Apply the accepted subset through the single hunk-mutation owner. When
 *  RFC06-4's `hunkMutationReceipt` gate is ON and a durable journal store is
 *  wired into composition, the apply is wrapped so it persists a CAS undo
 *  receipt (`@/runner/hunk-mutation-journal`) — the SAME `applyHunkSelection`
 *  engine is called exactly once inside the wrapper. Gate OFF or no store ⇒ the
 *  identical direct `applyHunkSelection` call as before (byte-identical). */
const applyAccepted = async (
  deps: CliHitlDeps,
  path: string,
  diff: ActionDiff,
  selected: readonly string[],
): Promise<HunkApplyResult> => {
  // Persist a durable receipt when a journal store is wired AND either the
  // receipt gate OR the `/undo` gate is on. `mutationJournal` is only ever wired
  // under `QUANTA_HUNK_UNDO=1` (see runtime-context-compose), so the `hunkUndo`
  // arm makes `/undo` self-sufficient: enabling undo alone records applies (a
  // journal with no persisted applies would be a silent dead surface).
  const cfg = runtimeConfig()
  if ((cfg.hunkMutationReceipt || cfg.hunkUndo) && deps.mutationJournal !== undefined) {
    const out = await applyHunkSelectionWithReceipt(
      {
        operationId: crypto.randomUUID(),
        path,
        before: diff.before,
        after: diff.after,
        selectedHunkIds: selected,
      },
      { store: deps.mutationJournal },
    )
    // Project the receipt wrapper's result back onto the engine's own result
    // shape so `shapePartialDecision` (and the reject counter) are unchanged.
    if (out.status === "applied") {
      return { status: "applied", appliedHunkIds: out.receipt.appliedHunks, content: out.content }
    }
    return out
  }
  return applyHunkSelection({
    path,
    before: diff.before,
    after: diff.after,
    selectedHunkIds: selected,
  })
}
