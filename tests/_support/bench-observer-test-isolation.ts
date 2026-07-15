/**
 * `BenchObserver.prototype.patchGenerated` is a process-global spy seam. Bun's
 * `test.serial` only serializes cases in one file, so cross-file observation
 * degradation rails must lease this mutex while installing/restoring the spy.
 */
let benchObserverTestTail: Promise<void> = Promise.resolve()

export const withBenchObserverTestIsolation = <T>(body: () => Promise<T>): (() => Promise<T>) => {
  return async (): Promise<T> => {
    const prior = benchObserverTestTail
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    benchObserverTestTail = prior.then(() => held)
    await prior
    try {
      return await body()
    } finally {
      release?.()
    }
  }
}
