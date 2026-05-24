/** ADR-0197 — default `ElicitationPrompter` for non-interactive sessions.
 *
 *  Every method resolves to `{ ok: false, reason: "headless-denied" }`. This
 *  is the SAFE default: silently synthesizing an answer is worse than
 *  deterministic rejection, and waiting on stdin that will never come hangs
 *  the loop. */

import type { ElicitationPrompter, ElicitationResult } from "./port"

const deny = <T>(): ElicitationResult<T> => ({ ok: false, reason: "headless-denied" })

export const headlessRejecter: ElicitationPrompter = {
  promptString: async () => deny<string>(),
  promptNumber: async () => deny<number>(),
  promptInteger: async () => deny<number>(),
  promptBoolean: async () => deny<boolean>(),
  promptEnum: async () => deny<string>(),
  promptMultiEnum: async () => deny<ReadonlyArray<string>>(),
  promptSingleEnum: async () => deny<string>(),
}
