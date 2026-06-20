import { __resetRuntimeConfig } from "@/shared"

const hasOwn = (obj: Record<string, string | undefined>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

const writeEnv = (vars: ReadonlyMap<string, string | undefined>): void => {
  for (const [key, value] of vars) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetRuntimeConfig()
}

const snapshotEnv = (keys: readonly string[]): Map<string, string | undefined> =>
  new Map(keys.map((key) => [key, process.env[key]]))

/** Scoped env helper for tests that drive cached runtime knobs. Every write
 *  re-pins `runtimeConfig()` so later reads cannot observe stale env. */
export const scopedEnv = (
  keys: readonly string[],
  initial: Record<string, string | undefined> = {},
): {
  readonly beforeEach: () => void
  readonly afterEach: () => void
  readonly set: (vars: Record<string, string | undefined>) => void
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
  }
}
