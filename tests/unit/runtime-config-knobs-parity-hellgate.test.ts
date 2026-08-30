// source-grep allowed: compares the declared runtime-config contract to its loader implementation.
/**
 * RUNTIME-CONFIG-KNOBS ↔ runtimeConfigFromEnv PARITY (ADR-0503 P3 drift guard).
 *
 * `@/shared/runtime-config-knobs.ts` (the catalog's declaration of the typed
 * runtime-config knobs) and `runtime-config.ts`'s `runtimeConfigFromEnv` (the actual
 * reads) are TWO hand-maintained lists of the SAME knob set. Without a parity
 * gate they drift silently: a knob added to `runtimeConfigFromEnv` but not the registry →
 * the catalog (`/knobs all`, web `/api/knobs`) silently omits it; a knob removed
 * from `runtimeConfigFromEnv` but left in the registry → a phantom catalog entry.
 *
 * This asserts the two sets are EXACTLY equal (symmetric difference empty). The
 * discovery regex covers every read form `runtimeConfigFromEnv` uses — `env.QUANTA_X`
 * (dot), `env["QUANTA_X"]` (bracket), and `gate*(env, "QUANTA_X")` / quoted —
 * so a dot-access read can't hide (the bug that let QUANTA_RATELIMIT_NOTICE slip
 * past the older discovery regex).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import { stripComments } from "./_shared/strip-comments"

/** Slice the exported runtime-config loader out of runtime-config.ts source. */
const runtimeConfigFromEnvBody = (src: string): string => {
  const start = src.indexOf("export const runtimeConfigFromEnv = ")
  if (start < 0) throw new Error("runtimeConfigFromEnv not found")
  // ends at the module-level `let cached` that follows the function
  const end = src.indexOf("\nlet cached", start)
  return src.slice(start, end < 0 ? undefined : end)
}

/** Every `QUANTA_*` knob read in the body, across all forms. */
const discoverFromLoadEnv = (body: string): ReadonlySet<string> => {
  const found = new Set<string>()
  // env.X (dot) | env[`/"/'X] (bracket incl. template) | "X"/`X` (quoted gate) |
  // { X } = env (destructure). Covers every read form loadFromEnv could use.
  const re =
    /env\.(QUANTA_[A-Z0-9_]+)|env\[\s*[`"'](QUANTA_[A-Z0-9_]+)[`"']|[`"'](QUANTA_[A-Z0-9_]+)[`"']/g
  const destruct = /\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g
  for (const clean of stripComments(body).split("\n")) {
    for (const m of clean.matchAll(re)) {
      const name = m[1] ?? m[2] ?? m[3]
      if (name !== undefined) found.add(name)
    }
    for (const d of clean.matchAll(destruct)) {
      for (const t of (d[1] as string).matchAll(/\bQUANTA_[A-Z0-9_]+/g)) found.add(t[0])
    }
  }
  return found
}

describe("runtime-config-knobs ↔ runtimeConfigFromEnv parity (ADR-0503 P3)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "..", "src/shared/runtime-config.ts"),
    "utf8",
  )
  const read = discoverFromLoadEnv(runtimeConfigFromEnvBody(src))
  const declared = new Set<string>(RUNTIME_CONFIG_KNOBS.map((k) => k.envKey))

  test("every runtimeConfigFromEnv knob is declared in runtime-config-knobs.ts", () => {
    const missing = [...read].filter((k) => !declared.has(k)).sort()
    expect(missing).toEqual([])
  })

  test("no phantom registry entries (every declared knob is read by runtimeConfigFromEnv)", () => {
    const phantom = [...declared].filter((k) => !read.has(k)).sort()
    expect(phantom).toEqual([])
  })

  test("discovery regex catches dot-access (the RATELIMIT_NOTICE blind spot)", () => {
    expect(
      discoverFromLoadEnv("x = env.QUANTA_RATELIMIT_NOTICE").has("QUANTA_RATELIMIT_NOTICE"),
    ).toBe(true)
    expect(discoverFromLoadEnv('gateOn(env, "QUANTA_FOO")').has("QUANTA_FOO")).toBe(true)
    expect(discoverFromLoadEnv('env["QUANTA_BAR"]').has("QUANTA_BAR")).toBe(true)
  })

  test("loader boundary rejects a renamed or removed runtime-config export", () => {
    expect(() => runtimeConfigFromEnvBody("const loadFromEnv = () => ({})\nlet cached")).toThrow(
      "runtimeConfigFromEnv not found",
    )
  })
})
