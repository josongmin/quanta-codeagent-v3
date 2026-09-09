/**
 * Canonical POSIX `flock(2)` primitive for file-transaction adapters.
 *
 * `@/shared` is the dependency-floor slice, so auth, permission, and migration
 * can share the OS primitive without crossing peer-library fences. Policy
 * (timeouts, reentrancy, critical-section ownership) remains in each caller.
 */
import { dlopen, FFIType, suffix } from "bun:ffi"
import { AsyncLocalStorage } from "node:async_hooks"
import { closeSync, constants, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"

export const LOCK_EX = 2
export const LOCK_UN = 8
export const LOCK_NB = 4

const cloexec: number = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0
export const OPEN_LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | cloexec
export const POSIX_FLOCK_SUPPORTED = process.platform !== "win32"

const libcName = (): string =>
  process.platform === "darwin" ? "libSystem.B.dylib" : `libc.${suffix}`

type FlockFn = (fd: number, operation: number) => number

let cached: FlockFn | undefined
const heldPaths = new AsyncLocalStorage<ReadonlySet<string>>()

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })

export const posixFlock = (fd: number, operation: number): number => {
  if (cached === undefined) {
    const { symbols } = dlopen(libcName(), {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    cached = (fileFd, op) => symbols.flock(fileFd, op)
  }
  return cached(fd, operation)
}

/** Canonical fd-lifetime transaction wrapper. The pathname is stable and is
 * never unlinked; process death releases the kernel lock. */
export const withPosixFileLock = async <T>(
  path: string,
  fn: () => Promise<T>,
  opts: {
    readonly timeoutMs?: number | undefined
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<T> => {
  if (!POSIX_FLOCK_SUPPORTED) throw new Error("POSIX flock is unavailable on win32")
  const normalized = resolve(path)
  if (heldPaths.getStore()?.has(normalized) === true) {
    throw new Error(`reentrant exclusive lock forbidden: ${normalized}`)
  }
  mkdirSync(dirname(normalized), { recursive: true, mode: 0o700 })
  const fd = openSync(normalized, OPEN_LOCK_FLAGS, 0o600)
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  try {
    for (;;) {
      if (opts.signal?.aborted === true) throw new Error("exclusive lock aborted")
      if (posixFlock(fd, LOCK_EX | LOCK_NB) === 0) break
      if (Date.now() > deadline) throw new Error("exclusive lock timeout")
      await sleep(10)
    }
    const next = new Set(heldPaths.getStore())
    next.add(normalized)
    try {
      return await heldPaths.run(next, fn)
    } finally {
      posixFlock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
  }
}
