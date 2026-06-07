/**
 * RUNTIME-CONFIG-KNOBS ↔ loadFromEnv PARITY (ADR-0503 P3 drift guard).
 *
 * `@/shared/runtime-config-knobs.ts` (the catalog's declaration of the typed
 * runtime-config knobs) and `runtime-config.ts`'s `loadFromEnv` (the actual
 * reads) are TWO hand-maintained lists of the SAME knob set. Without a parity
 * gate they drift silently: a knob added to `loadFromEnv` but not the registry →
 * the catalog (`/knobs all`, web `/api/knobs`) silently omits it; a knob removed
 * from `loadFromEnv` but left in the registry → a phantom catalog entry.
 *
 * This asserts the two sets are EXACTLY equal (symmetric difference empty). The
 * discovery regex covers every read form `loadFromEnv` uses — `env.QUANTA_X`
 * (dot), `env["QUANTA_X"]` (bracket), and `gate*(env, "QUANTA_X")` / quoted —
 * so a dot-access read can't hide (the bug that let QUANTA_RATELIMIT_NOTICE slip
 * past the older discovery regex).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"

/** Slice the `loadFromEnv` function body out of runtime-config.ts source. */
const loadFromEnvBody = (src: string): string => {
  const start = src.indexOf("const loadFromEnv = ")
  if (start < 0) throw new Error("loadFromEnv not found")
  // ends at the module-level `let cached` that follows the function
  const end = src.indexOf("\nlet cached", start)
  return src.slice(start, end < 0 ? undefined : end)
}

const stripComment = (l: string): string => {
  const t = l.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l
}

/** Every `QUANTA_*` knob read in the body, across all forms. */
const discoverFromLoadEnv = (body: string): ReadonlySet<string> => {
  const found = new Set<string>()
  // env.X (dot) | env[`/"/'X] (bracket incl. template) | "X"/`X` (quoted gate) |
  // { X } = env (destructure). Covers every read form loadFromEnv could use.
  const re =
    /env\.(QUANTA_[A-Z0-9_]+)|env\[\s*[`"'](QUANTA_[A-Z0-9_]+)[`"']|[`"'](QUANTA_[A-Z0-9_]+)[`"']/g
  const destruct = /\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g
  for (const line of body.split("\n")) {
    const clean = stripComment(line)
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

describe("runtime-config-knobs ↔ loadFromEnv parity (ADR-0503 P3)", () => {
  const src = readFileSync("src/shared/runtime-config.ts", "utf8")
  const read = discoverFromLoadEnv(loadFromEnvBody(src))
  const declared = new Set<string>(RUNTIME_CONFIG_KNOBS.map((k) => k.envKey))

  test("every loadFromEnv knob is declared in runtime-config-knobs.ts", () => {
    const missing = [...read].filter((k) => !declared.has(k)).sort()
    expect(missing).toEqual([])
  })

  test("no phantom registry entries (every declared knob is read by loadFromEnv)", () => {
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
})
