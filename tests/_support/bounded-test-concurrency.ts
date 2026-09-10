/** Run independent heavyweight test probes with a fixed, shared concurrency cap. */
export const createBoundedTestExecutor = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("test concurrency limit must be >= 1")
  let active = 0
  const waiters: Array<() => void> = []

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }

  const release = (): void => {
    const next = waiters.shift()
    if (next !== undefined) next()
    else active -= 1
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
