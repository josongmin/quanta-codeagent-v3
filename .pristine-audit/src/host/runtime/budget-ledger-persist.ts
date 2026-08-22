/**
 * Persistence wrapper for the cross-run cost {@link BudgetLedger} (ADR-0136).
 *
 * The ledger itself is a PURE in-memory store (contract #1: 0 I/O) so it stays
 * testable and slice-clean. Persistence is the CALLER's job — this wrapper, in
 * the composition root (where I/O is allowed), gives a campaign / daemon a
 * `~/.quanta/budget.json`-backed ledger so several runs share one daily budget:
 *
 *   - On construction it HYDRATES from `path` (if the file exists), restoring
 *     the prior runs' cumulative spend + fired-breach memory.
 *   - It WRITE-THROUGHs after every `record(...)` (and `clear(...)`), serializing
 *     the full state back to `path`. Write-through (vs serialize-only-at-
 *     teardown) is deliberate: a cost guard must survive a CRASH — if the
 *     process OOMs mid-run, the spend that pushed it there is already on disk so
 *     the next run still sees it, instead of resetting the budget every crash.
 *
 * Best-effort + NO-THROW: a read/write failure (missing dir, permissions, full
 * disk) NEVER propagates into the loop — the wrapper degrades to in-memory-only
 * for that operation. The ledger is a guard rail, not a transaction log.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { BudgetLedger } from "@/agent/budget-ledger"
import { errMessage, logger } from "@/shared"

/** Minimal fs surface — injectable so tests run without touching disk. */
export interface LedgerFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, data: string): void
}

const nodeFs: LedgerFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf8"),
  write: (p, d) => writeFileSync(p, d),
}

/**
 * Wrap `inner` so its state is hydrated from `path` on construction and written
 * back after every mutating call. Returns a `BudgetLedger` with the SAME surface
 * (every method delegates); only `record`/`clear` add the write-through. `fs` is
 * injectable for tests; production passes the real node:fs adapter.
 */
export const persistBudgetLedger = (
  inner: BudgetLedger,
  path: string,
  fs: LedgerFs = nodeFs,
): BudgetLedger => {
  // Hydrate prior cross-run state. Absent file ⇒ start empty (first run). Any
  // read/parse failure is swallowed by the ledger's own hydrate (contract #7)
  // or by this guard — never blocks session start.
  try {
    if (fs.exists(path)) inner.hydrate(fs.read(path))
  } catch (e) {
    logger.warn(`budget-ledger persist: hydrate from ${path} failed: ${errMessage(e)}`)
  }

  const flush = (): void => {
    try {
      fs.write(path, inner.serialize())
    } catch (e) {
      logger.warn(`budget-ledger persist: write to ${path} failed: ${errMessage(e)}`)
    }
  }

  return {
    record(event) {
      const r = inner.record(event)
      flush()
      return r
    },
    clear(scope) {
      const n = inner.clear(scope)
      flush()
      return n
    },
    snapshot: () => inner.snapshot(),
    serialize: () => inner.serialize(),
    hydrate: (jsonl) => {
      inner.hydrate(jsonl)
      flush()
    },
    hardBreach: () => inner.hardBreach(),
  }
}
