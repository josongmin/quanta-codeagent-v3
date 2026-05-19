export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface ShellOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** When true, the child inherits the parent's FULL environment (API keys
   *  included). Default/absent ⇒ scrubbed env (shared allowlist; see
   *  {@link runShell}). LLM-driven tools MUST NOT set this. */
  inheritEnv?: boolean
}
