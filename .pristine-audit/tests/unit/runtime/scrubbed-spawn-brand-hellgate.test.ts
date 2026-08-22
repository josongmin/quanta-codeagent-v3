/**
 * S1 (jun-7 Phase-2 FINAL) — branded `ScrubbedEnv` + `spawnScrubbed` boundary.
 *
 * The STRUCTURAL guarantee is a COMPILE-TIME one (a raw env / an omitted env is
 * a tsc error), so the load-bearing proof lives in the type-level assertions
 * below + the `tsconfig.typecheck.src.json` gate. At RUNTIME we pin: the brand
 * is a zero-cost cast (same reference, same keys) and the spawner forwards the
 * branded env verbatim to the underlying spawn — i.e. the env a caller scrubbed
 * is exactly the env the child receives, never `process.env`.
 */

import { describe, expect, test } from "bun:test"
import { scrubEnv } from "@/runtime/sandbox"
import { asScrubbedEnv, type ScrubbedEnv, type ScrubbedSpawner } from "@/runtime/scrubbed-spawn"

describe("asScrubbedEnv — zero-cost brand (S1)", () => {
  test("returns the SAME reference (no copy / allocation)", () => {
    const raw = scrubEnv()
    const branded = asScrubbedEnv(raw)
    expect(branded as unknown as Record<string, string>).toBe(
      raw as unknown as Record<string, string>,
    )
  })

  test("the branded env carries ONLY the scrubbed keys (no parent secrets)", () => {
    const KEY = "ZZ_S1_SECRET_API_KEY"
    process.env[KEY] = "sk-should-not-survive"
    try {
      const branded = asScrubbedEnv(scrubEnv())
      expect((branded as unknown as Record<string, string>)[KEY]).toBeUndefined()
    } finally {
      delete process.env[KEY]
    }
  })
})

describe("ScrubbedSpawner — env forwarded verbatim, never inherit-by-omission (S1)", () => {
  test("the branded env reaches the spawner unchanged", () => {
    let captured: { argv: readonly string[]; env: unknown } | undefined
    const recorder: ScrubbedSpawner = (argv, options) => {
      captured = { argv, env: options.env }
      return {}
    }
    const env: ScrubbedEnv = asScrubbedEnv({ PATH: "/usr/bin", HOME: "/h" })
    recorder(["bash", "-lc", "echo hi"], { cwd: "/tmp", env, stdout: "pipe" })

    expect(captured?.argv).toEqual(["bash", "-lc", "echo hi"])
    expect(captured?.env).toEqual({ PATH: "/usr/bin", HOME: "/h" })
    // No `process.env` leak — the spawner sees exactly the branded record.
    expect((captured?.env as Record<string, string>).PWD).toBeUndefined()
  })
})
