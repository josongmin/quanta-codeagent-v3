/**
 * `tools/dev/capability-receipt-files` — where a campaign's capability receipt is
 * written, and removing the ones no process can still read.
 *
 * # The defect
 *
 * Receipts are named per process (`<name>-<pid>.receipt.json`) so two campaigns
 * never share one file. Each writer removes its own on the way out, and two exits
 * skipped that: the shard runner's signal path, which ends in `process.exit` and
 * never reaches its `finally`, and a SIGKILL, which reaches nothing. MEASURED in
 * the shared cache of this clone: fourteen leftovers, six from runner campaigns
 * killed on 09-12 and seven from this repo's own test arms, which wrote into the
 * real shared cache because they had no way to name another.
 *
 * # What may be removed
 *
 * Only what nothing can read:
 *
 *  - a receipt whose writer is DEAD. Its readers are that writer's children. A
 *    runner's surviving children quarantine its lane, so a campaign that holds the
 *    lease has outlived them; a wrapper has no lease, and a child it left behind
 *    would lose its receipt mid-run — in a run whose verdict nothing collects;
 *  - a receipt that has EXPIRED, whoever wrote it. `validateCapabilityReceipt`
 *    refuses it, so a reader that finds it answers exactly as if it were gone;
 *  - a dead writer's staging file.
 *
 * A live pid's unexpired receipt stays, including under pid reuse: that leaks one
 * file until it expires, and the alternative deletes a running campaign's receipt.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export const capabilityReceiptDirectory = (cacheRoot: string): string =>
  join(cacheRoot, "capability")

export const capabilityReceiptPathFor = (
  cacheRoot: string,
  name: string,
  pid: number = process.pid,
): string => join(capabilityReceiptDirectory(cacheRoot), `${name}-${pid}.receipt.json`)

const RECEIPT = /-(\d+)\.receipt\.json$/u
/** `writeCapabilityReceipt` stages at `<path>.<pid>.tmp`. */
const STAGING = /\.receipt\.json\.(\d+)\.tmp$/u

/** EPERM means the pid exists and belongs to someone else — still alive. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface SweepCapabilityReceiptsInput {
  readonly directory: string
  readonly nowMs: number
  readonly isAlive?: (pid: number) => boolean
  readonly selfPid?: number
  /** Where a failure is said. Housekeeping never throws: see `sweepCapabilityReceipts`. */
  readonly log?: (line: string) => void
}

const expired = (path: string, nowMs: number): boolean => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly expiresAtMs?: unknown }
    return typeof parsed.expiresAtMs === "number" && parsed.expiresAtMs <= nowMs
  } catch {
    // Unreadable is not expired: a live writer's receipt is never half-written
    // (it is renamed into place), so this is someone else's file.
    return false
  }
}

const pidOf = (pattern: RegExp, name: string): number | undefined => {
  const pid = Number.parseInt(pattern.exec(name)?.[1] ?? "", 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Removes what nothing can read (see the module doc); returns the removed names.
 *
 * NEVER throws. It is housekeeping before a campaign, and a directory it cannot
 * list (EACCES, ENOTDIR) or an entry it cannot remove killed the runner, the
 * wrapper and the matrix worker before they ran anything (measured). A disk that
 * really cannot hold a receipt fails the receipt write that follows, by name.
 */
export const sweepCapabilityReceipts = (input: SweepCapabilityReceiptsInput): readonly string[] => {
  const isAlive = input.isAlive ?? processIsAlive
  const selfPid = input.selfPid ?? process.pid
  let names: readonly string[]
  try {
    names = readdirSync(input.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      input.log?.(
        `[capability] WARN cannot list ${input.directory} to sweep receipts: ${String(error)}\n`,
      )
    }
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const path = join(input.directory, name)
    const stagingPid = pidOf(STAGING, name)
    const receiptPid = pidOf(RECEIPT, name)
    const owner = stagingPid ?? receiptPid
    if (owner === undefined || owner === selfPid) continue
    const dead = !isAlive(owner)
    if (!dead && !(receiptPid !== undefined && expired(path, input.nowMs))) continue
    try {
      rmSync(path, { force: true })
      removed.push(name)
    } catch (error) {
      input.log?.(`[capability] WARN cannot remove ${path}: ${String(error)}\n`)
    }
  }
  return removed.sort()
}
