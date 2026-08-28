/**
 * The candidate-fork override cell, as a LEAF.
 *
 * ## Why it lives alone
 *
 * `tests/setup.ts` is a `bunfig.toml` preload, so it runs before every test file
 * in the repo. It needs exactly one symbol from here —
 * `__setBranchRunAgentForTest` — to reset the slot between cases. Reaching it
 * through `@/agent/branch-search-runner` pulled that module's own imports along:
 * `@/agent/loop` → `@/agent/loop/entry` → `@/agent/session-resources` →
 * `@/tool`, and from there **284 files under `src/tool`** landed in the preload's
 * runtime closure.
 *
 * That is not merely wasteful. It made a whole class of test infrastructure
 * impossible: a mirror of the repo with `src/tool` emptied — the ground-truth
 * oracle for "would this guard notice its corpus vanishing?" — could not start,
 * because the preload died with `Cannot find module '@/tool'` before any guard
 * ran. Two attempts to work around it from the outside failed the same way (a
 * static closure restored 281 of the 284; an execution-driven fixpoint took 107
 * seconds to restore the same set).
 *
 * ## Why this file has no value imports
 *
 * `runAgent` is referenced with `import type` only, so nothing here is loaded at
 * runtime and the cell cannot drag a graph behind it. That is the property the
 * preload depends on, and it is what `tests/meta/preload-runtime-closure-hellgate.test.ts`
 * pins — a value import added here would silently reopen the hole.
 */

import type { runAgent } from "@/agent/loop"

/**
 * `runAgent` is a process-wide module export, and a test that mocks that module
 * leaks its fake into unrelated loop consumers when Bun reuses a worker. The sole
 * fork boundary is locally swappable instead.
 *
 * Deliberately NOT initialised with `runAgent`: this slot is read from a module
 * inside a tolerated `loop → features → runner → loop` cycle, so the imported
 * binding can still be in its TDZ during module initialisation.
 */
let override: typeof runAgent | null = null

export const __setBranchRunAgentForTest = (candidate: typeof runAgent | null): void => {
  override = candidate
}

/** The override if a test installed one, else `null`. */
export const branchRunAgentOverride = (): typeof runAgent | null => override
