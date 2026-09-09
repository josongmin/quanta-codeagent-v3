/**
 * Per-session mutation transaction. The promise queue orders work in this
 * process; the stable fd-held flock extends the same critical section across
 * processes sharing a session root.
 */
import { POSIX_FLOCK_SUPPORTED, withPosixFileLock } from "@/shared"

const saveSessionQueues = new Map<string, Promise<void>>()

export const withSessionSaveLock = <T>(
  queueKey: string,
  lockPath: string | Promise<string>,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = saveSessionQueues.get(queueKey) ?? Promise.resolve()
  const run = prev.then(async () =>
    POSIX_FLOCK_SUPPORTED ? withPosixFileLock(await lockPath, fn) : fn(),
  )
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  saveSessionQueues.set(queueKey, tail)
  void tail.then(() => {
    if (saveSessionQueues.get(queueKey) === tail) saveSessionQueues.delete(queueKey)
  })
  return run
}
