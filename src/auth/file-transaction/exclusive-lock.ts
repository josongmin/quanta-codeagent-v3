/**
 * FD-held exclusive lock. Nested reentrancy is forbidden. Concurrent
 * waiters serialize on flock. Release does not unlink.
 */

import { withPosixFileLock } from "@/shared"
import type { ExclusiveFileLockPort } from "./port"

export const withExclusiveFileLock: ExclusiveFileLockPort["withExclusiveLock"] = async (
  path,
  opts,
  fn,
) => {
  return withPosixFileLock(path, fn, opts)
}

export const createExclusiveFileLockPort = (): ExclusiveFileLockPort => ({
  withExclusiveLock: withExclusiveFileLock,
})
