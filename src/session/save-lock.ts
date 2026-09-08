/**
 * Per-session in-process mutation queue. Shared by save and delete so a
 * terminal delete cannot race a snapshot write for the same id.
 */
const saveSessionQueues = new Map<string, Promise<void>>()

export const withSessionSaveLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = saveSessionQueues.get(id) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  saveSessionQueues.set(id, tail)
  void tail.then(() => {
    if (saveSessionQueues.get(id) === tail) saveSessionQueues.delete(id)
  })
  return run
}
