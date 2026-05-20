/** First-class git tool slice (Wave B3 — SOTA++ Codex `may-20-codex-signal.md`
 *  absorption, ADR-0016).
 *
 *  Exposes four READ-ONLY, CONCURRENCY-SAFE tools — `git_diff`, `git_status`,
 *  `git_log`, `git_blame` — that shell out to `git` via an injected
 *  {@link GitRunner}. The default runner is `Bun.spawn`-backed; tests pass a
 *  fake runner to assert behavior without a real repo.
 *
 *  Mutating git operations (commit / restore / checkout / push) deliberately
 *  stay on `bash` so the HARD_DENY / HITL pipeline keeps governing them. */

import type { Tool } from "../types"
import { gitBlameTool } from "./blame"
import { gitDiffTool } from "./diff"
import { gitLogTool } from "./log"
import { defaultGitRunner } from "./runner"
import { gitStatusTool } from "./status"
import type { GitRunner } from "./types"

export { gitBlameTool } from "./blame"
export { gitDiffTool } from "./diff"
export { gitLogTool } from "./log"
export { defaultGitRunner } from "./runner"
export { gitStatusTool } from "./status"
export type {
  GitBlameInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
} from "./types"

/** Build the four git tools wired to a runner. When omitted, the default
 *  Bun.spawn-backed runner is used. */
export const gitTools = (runner: GitRunner = defaultGitRunner): Tool[] => [
  gitDiffTool(runner) as Tool,
  gitStatusTool(runner) as Tool,
  gitLogTool(runner) as Tool,
  gitBlameTool(runner) as Tool,
]
