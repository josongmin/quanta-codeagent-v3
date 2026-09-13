/**
 * ADR-0400 — Real adapter barrel for the wave-1 `@/agent/shadow-verify` slice.
 *
 * Each adapter is a composition-root assembler that crosses into a single
 * host capability (`@/runtime` worktree, `@/patch` V4A applier, `@/lsp`
 * diagnostics + `@/runtime` shell test). The wave-1 sealed slice imports none
 * of these; this barrel is the only place that wires them into the closed
 * port contract.
 *
 * `createShadowVerifyAdapters(repoRoot)` returns the three-port bag in the
 * shape `createShadowVerify(deps)` expects. Hosts that want to substitute one
 * adapter (e.g. inject a fake checker in tests) can build the bag manually
 * from the individual factories.
 */

import type { ShadowVerifyDeps } from "../shadow-verify"
import { createV4AApplyPort } from "./apply-v4a"
import { createLspTestCheckPort } from "./check-lsp-test"
import { createScratchWorktreePort } from "./scratch-worktree"

export { createV4AApplyPort } from "./apply-v4a"
export { createLspTestCheckPort } from "./check-lsp-test"
export { createScratchWorktreePort } from "./scratch-worktree"

/**
 * One-shot factory that returns the real `ShadowVerifyDeps` bag for a host
 * repo. Pair with `createShadowVerify(deps)` from `@/agent/shadow-verify`:
 *
 *   const adapters = createShadowVerifyAdapters(cwd)
 *   const verifier = createShadowVerify(adapters)
 *
 * @param repoRoot   the host repo root (typically the session `cwd`); the
 *                   scratch worktree is forked off HEAD of this repo.
 */
export const createShadowVerifyAdapters = (repoRoot: string): ShadowVerifyDeps => ({
  scratch: createScratchWorktreePort(repoRoot),
  applier: createV4AApplyPort(),
  checker: createLspTestCheckPort({ trustRoot: repoRoot }),
})
