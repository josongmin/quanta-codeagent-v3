/**
 * Host-owned terminal ports for non-app slices.
 *
 * Non-app modules MUST NOT reach for `process.stdout` / `process.stderr`
 * directly. The app/composition root registers the real terminal sinks; every
 * other slice writes through these ports. Default is no-op so a library/test
 * host can opt in explicitly without accidental terminal ownership.
 */

export type TerminalWriter = (chunk: string) => void

export interface TerminalIo {
  readonly stdout: TerminalWriter
  readonly stderr: TerminalWriter
  readonly stdoutIsTTY?: boolean
  readonly stderrIsTTY?: boolean
}

const NOOP_WRITER: TerminalWriter = (_chunk) => {}

const NOOP_TERMINAL_IO: TerminalIo = Object.freeze({
  stdout: NOOP_WRITER,
  stderr: NOOP_WRITER,
  stdoutIsTTY: false,
  stderrIsTTY: false,
})

let activeTerminalIo: TerminalIo = NOOP_TERMINAL_IO

/** Register the active terminal ports. Pass `null` to clear back to no-op. */
export const setTerminalIo = (io: TerminalIo | null): void => {
  activeTerminalIo = io ?? NOOP_TERMINAL_IO
}

export const getTerminalIo = (): TerminalIo => activeTerminalIo

export const writeStdout = (chunk: string): void => {
  activeTerminalIo.stdout(chunk)
}

export const writeStderr = (chunk: string): void => {
  activeTerminalIo.stderr(chunk)
}

/** Test-only reset. Production code should use `setTerminalIo(null)` instead. */
export const __resetTerminalIo = (): void => {
  activeTerminalIo = NOOP_TERMINAL_IO
}
