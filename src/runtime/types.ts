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
}
