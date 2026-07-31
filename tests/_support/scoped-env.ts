import { __resetRuntimeConfig } from "@/shared"

const hasOwn = (obj: Record<string, string | undefined>, key: string): boolean =>
  Object.hasOwn(obj, key)

const writeEnv = (vars: ReadonlyMap<string, string | undefined>): void => {
  for (const [key, value] of vars) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetRuntimeConfig()
}

const snapshotEnv = (keys: readonly string[]): Map<string, string | undefined> =>
  new Map(keys.map((key) => [key, process.env[key]]))

let envLock: Promise<void> = Promise.resolve()

const acquireEnvLock = async (): Promise<() => void> => {
  const prior = envLock
  let release!: () => void
  envLock = new Promise<void>((resolve) => {
    release = resolve
  })
  await prior
  return release
}

/** Scoped env helper for tests that drive cached runtime knobs. Every write
 *  re-pins `runtimeConfig()` so later reads cannot observe stale env. */
export const scopedEnv = (
  keys: readonly string[],
  initial: Record<string, string | undefined> = {},
): {
  readonly beforeEach: () => void
  readonly afterEach: () => void
  readonly set: (vars: Record<string, string | undefined>) => void
  readonly run: <T>(body: () => Promise<T>) => () => Promise<T>
} => {
  let saved = new Map<string, string | undefined>()

  return {
    beforeEach: () => {
      saved = snapshotEnv(keys)
      writeEnv(new Map(keys.map((key) => [key, hasOwn(initial, key) ? initial[key] : undefined])))
    },
    afterEach: () => {
      writeEnv(saved)
    },
    set: (vars: Record<string, string | undefined>) => {
      for (const key of keys) {
        if (!hasOwn(vars, key)) continue
        const value = vars[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      __resetRuntimeConfig()
    },
    run:
      <T>(body: () => Promise<T>) =>
      async (): Promise<T> => {
        const release = await acquireEnvLock()
        saved = snapshotEnv(keys)
        writeEnv(new Map(keys.map((key) => [key, hasOwn(initial, key) ? initial[key] : undefined])))
        try {
          return await body()
        } finally {
          writeEnv(saved)
          release()
        }
      },
  }
}
