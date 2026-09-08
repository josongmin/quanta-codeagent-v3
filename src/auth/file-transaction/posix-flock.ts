/**
 * POSIX `flock(2)` via bun:ffi → libc / libSystem. No npm native dependency.
 *
 * Darwin spike (W0.3): live holder LOCK_NB fails; SIGKILL releases; leftover
 * pathname (no unlink) remains flockable; same-process second fd is exclusive.
 * Hold the fd for the whole critical section. Never unlink the lock path.
 * Never steal by mtime/age.
 */

import { dlopen, FFIType, suffix } from "bun:ffi"
import { constants } from "node:fs"

export const LOCK_EX = 2
export const LOCK_UN = 8
export const LOCK_NB = 4

const cloexec: number = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0
export const OPEN_LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | cloexec

const libcName = (): string =>
  process.platform === "darwin" ? "libSystem.B.dylib" : `libc.${suffix}`

type FlockFn = (fd: number, operation: number) => number

let cached: FlockFn | undefined

export const posixFlock = (fd: number, operation: number): number => {
  if (cached === undefined) {
    const { symbols } = dlopen(libcName(), {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    cached = (fileFd, op) => symbols.flock(fileFd, op)
  }
  return cached(fd, operation)
}
