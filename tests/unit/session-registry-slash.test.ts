/**
 * ★ ADR-0370 — `/session-registry` slash command wire test.
 *
 * Lives in `tests/unit/` (NOT under `src/agent/.../​__tests__/`) because
 * the slice fence forbids library slices importing `@/apps/cli/*`.
 * The companion inspector hellgate
 * (`src/agent/session-resource-registry/__tests__/inspector.hellgate.test.ts`)
 * pins the inspector contract; this file pins ONLY the CLI registration
 * + the `run`-path NO-THROW invariant.
 *
 * Coverage (5 cases):
 *   1.  `/session-registry` is present in `BUILTINS`
 *   2.  command has `run` + `describe` + correct category
 *   3.  `run [no args]` writes a stats block to `out` + exits 0
 *   4.  `run ["help"]` writes the help menu + exits 0
 *   5.  `run ["unknown"]` writes to `err` + exits 1
 */

import { describe, expect, test } from "bun:test"
import { BUILTINS } from "@/apps/cli/slash-commands"
import type { SlashContext } from "@/apps/cli/slash-contract"

const findCmd = () => BUILTINS.find((c) => c.name === "/session-registry")

interface CapturedCtx extends SlashContext {
  readonly outBuf: string[]
  readonly errBuf: string[]
}

const makeCtx = (): CapturedCtx => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    cwd: process.cwd(),
  }
}

describe("ADR-0370 /session-registry slash wire", () => {
  test("[1] BUILTINS contains /session-registry", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/session-registry")
  })

  test("[2] command has run + describe + category=other", () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    expect(typeof cmd?.run).toBe("function")
    expect(typeof cmd?.describe).toBe("string")
    expect(cmd?.describe.length).toBeGreaterThan(0)
    expect(cmd?.category).toBe("other")
  })

  test("[3] run [no args] → stats block + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run([], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("Session Registry")
    expect(out).toContain("Sessions:")
    expect(ctx.errBuf).toEqual([])
  })

  test("[4] run [help] → help menu + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["help"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("/session-registry")
    expect(out).toContain("stats")
  })

  test("[5] run [unknown] → stderr + exit 1", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["bogus"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err).toContain("unknown subcommand")
    expect(err).toContain("bogus")
  })
})
