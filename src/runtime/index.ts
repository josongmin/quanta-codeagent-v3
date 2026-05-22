export type { EscalatingKill, GuardedSpawnHooks, KillableChild } from "./guarded-spawn"
export { escalatingKill, KILL_GRACE_MS, withSpawnedChild } from "./guarded-spawn"
export type { DockerSandboxOptions, Sandbox, SandboxPolicy } from "./sandbox"
export {
  DEFAULT_ENV_ALLOWLIST,
  DockerSandbox,
  LocalSandbox,
  SandboxPolicyError,
  SandboxUnavailableError,
  scrubEnv,
} from "./sandbox"
export { runShell } from "./shell"
export type { RunShellEvent, ShellOptions, ShellResult } from "./types"
export {
  isGitRepo,
  isTransientWorktreeLockError,
  MAX_WORKTREE_LOCK_RETRIES,
  runWorktreeAddWithRetry,
  WORKTREE_LOCK_BACKOFF_MS,
  withWorktree,
} from "./worktree"
export type { PersistentWorktree } from "./worktree-fork"
export { createPersistentWorktree, removeWorktree, WorktreeForkError } from "./worktree-fork"
