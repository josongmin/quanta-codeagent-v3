import type { ObjectiveDomainSnapshot } from "./model"
import {
  MAX_PROGRESS_RECEIPTS,
  normalizeProgressReceipt,
  type ProgressReceipt,
} from "./progress-receipt"
import type { ObjectiveCore } from "./store"

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

/** Restore constructor-time domains, including revision-only tombstones. */
export const hydrateDomains = (
  core: ObjectiveCore,
  revisions: Map<string, number>,
  domains: readonly ObjectiveDomainSnapshot[] | undefined,
): void => {
  if (domains === undefined) return
  for (const domain of domains) plantDomain(core, revisions, domain)
}

export const plantDomain = (
  core: ObjectiveCore,
  revisions: Map<string, number>,
  domain: ObjectiveDomainSnapshot,
): boolean => {
  const threadId = isNonEmptyString(domain?.threadId) ? domain.threadId : ""
  if (threadId === "") return false
  const revision = Number.isFinite(domain.revision) && domain.revision >= 0 ? domain.revision : 1
  if (domain.state === null) {
    if (revision <= 0) return false
    core.clear(threadId)
    revisions.set(threadId, revision)
    return true
  }
  if (!core.restoreThread(threadId, domain.state)) return false
  revisions.set(threadId, revision)
  return true
}

const normalizeProgressReceipts = (
  receipts: readonly ProgressReceipt[] | undefined,
): readonly ProgressReceipt[] =>
  Object.freeze(
    (receipts ?? [])
      .map(normalizeProgressReceipt)
      .filter((receipt): receipt is ProgressReceipt => receipt !== null)
      .slice(-MAX_PROGRESS_RECEIPTS),
  )

/** Keep only receipts bound to the live objective generation. */
export const receiptsForGeneration = (
  core: ObjectiveCore,
  threadId: string,
  receipts: readonly ProgressReceipt[] | undefined,
): readonly ProgressReceipt[] => {
  const live = core.get(threadId)?.objectiveId
  return Object.freeze(
    normalizeProgressReceipts(receipts).filter((receipt) => receipt.objectiveId === live),
  )
}

export const hydrateProgressReceipts = (
  core: ObjectiveCore,
  progress: Map<string, readonly ProgressReceipt[]>,
  domains: readonly ObjectiveDomainSnapshot[] | undefined,
): void => {
  for (const domain of domains ?? []) {
    if (isNonEmptyString(domain.threadId) && domain.progressReceipts !== undefined) {
      progress.set(
        domain.threadId,
        receiptsForGeneration(core, domain.threadId, domain.progressReceipts),
      )
    }
  }
}
