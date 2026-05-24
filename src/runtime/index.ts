export type { EscalatingKill, GuardedSpawnHooks, KillableChild } from "./guarded-spawn"
export { escalatingKill, KILL_GRACE_MS, withSpawnedChild } from "./guarded-spawn"
// S1: re-export from the os-sandbox sub-barrel so the wire surface uses a
// single @/runtime import (keeps apps/cli/sandbox-wire from reaching past
// the runtime slice boundary into @/runtime/os-sandbox).
export {
  DEFAULT_SANDBOX_EXEC_PATH,
  type SandboxPolicy as OsSandboxPolicy,
  type SandboxProfile as OsSandboxProfile,
  type WrappedShellArgv,
  wrapShellArgv,
} from "./os-sandbox"
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
export { runShellExeca } from "./shell-execa"
export {
  __resetShellSandbox,
  getShellSandbox,
  installShellSandbox,
  type ShellSandboxSlot,
} from "./shell-sandbox-holder"
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
