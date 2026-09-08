/**
 * FD-held exclusive lock. Nested reentrancy is forbidden. Concurrent
 * waiters serialize on flock. Release does not unlink.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { ExclusiveFileLockPort } from "./port"
import { LOCK_EX, LOCK_NB, LOCK_UN, OPEN_LOCK_FLAGS, posixFlock } from "./posix-flock"

const DEFAULT_TIMEOUT_MS = 10_000
const nest = new AsyncLocalStorage<Set<string>>()

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })

export const withExclusiveFileLock: ExclusiveFileLockPort["withExclusiveLock"] = async (
  path,
  opts,
  fn,
) => {
  const normalized = resolve(path)
  if (nest.getStore()?.has(normalized) === true) {
    throw new Error(`reentrant exclusive lock forbidden: ${normalized}`)
  }
  mkdirSync(dirname(normalized), { recursive: true, mode: 0o700 })
  const fd = openSync(normalized, OPEN_LOCK_FLAGS, 0o600)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      if (opts.signal?.aborted === true) {
        throw new Error("exclusive lock aborted")
      }
      if (posixFlock(fd, LOCK_EX | LOCK_NB) === 0) break
      if (Date.now() > deadline) {
        throw new Error("exclusive lock timeout")
      }
      await sleep(10)
    }
    const held = new Set(nest.getStore())
    held.add(normalized)
    try {
      return await nest.run(held, fn)
    } finally {
      posixFlock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
  }
}

export const createExclusiveFileLockPort = (): ExclusiveFileLockPort => ({
  withExclusiveLock: withExclusiveFileLock,
})
