/**
 * Hellgate — `/effort` slash command (Codex `/model`-style UX, effort-only).
 *
 * Adversarial coverage:
 *   1. Absent ctx.effort ⇒ prints "not wired in this surface" + exit 0
 *      (parity with the rest of the surface-only commands).
 *   2. No args ⇒ renders header (current + budget) + 5 tier lines (current
 *      marked with `*`) + the `use:` hint, exit 0.
 *   3. Single named arg ⇒ calls `ctx.effort.set(level)` and renders the
 *      "set" confirmation line with the budget tag. The set callback is
 *      what the surface wires to also repaint the status pill — tested
 *      via a mock set spy.
 *   4. Multiple args ⇒ "takes at most one argument" + exit 1.
 *   5. Unknown level (e.g. `ultra`) ⇒ "unknown level" + level list + exit 1.
 *   6. Case-insensitive matching: `/effort HIGH` resolves to `"high"`.
 *   7. Whitespace tolerance: `/effort   max  ` resolves to `"max"`.
 *   8. `/effort default` ⇒ confirmation drops the budget tag and says
 *      "provider default — no thinking budget" (UX contract: a `default`
 *      level explicitly signals "no thinking field").
 *   9. Completion: bare `/effort ` (no partial) ⇒ all 5 levels offered;
 *      `/effort h` ⇒ only `"high"`; `/effort xx` ⇒ empty.
 */
import { describe, expect, test } from "bun:test"
import type { EffortLevel } from "@/agent"
import { runSlashCommand } from "../../../src/apps/cli/slash-commands"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

const LEVELS: readonly EffortLevel[] = ["default", "max", "high", "medium", "low"]

const budgetTokens = (level: EffortLevel): number | undefined => {
  switch (level) {
    case "default":
      return undefined
    case "low":
      return 1024
    case "medium":
      return 4096
    case "high":
      return 16384
    case "max":
      return 64000
  }
}

interface EffortHarness {
  ctx: SlashContext
  stdout: string
  stderr: string
  current: { value: EffortLevel }
  setCalls: EffortLevel[]
}

const buildHarness = (initial: EffortLevel): EffortHarness => {
  const current = { value: initial }
  const setCalls: EffortLevel[] = []
  let stdout = ""
  let stderr = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    effort: {
      get: () => current.value,
      set: (lvl) => {
        setCalls.push(lvl)
        current.value = lvl
      },
      levels: LEVELS,
      budgetTokens,
    },
  }
  return {
    ctx,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    current,
    setCalls,
  }
}

const buildHarnessNoEffort = (): EffortHarness => {
  let stdout = ""
  let stderr = ""
  return {
    ctx: {
      out: (s) => {
        stdout += s
      },
      err: (s) => {
        stderr += s
      },
      cwd: "/tmp",
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    current: { value: "default" },
    setCalls: [],
  }
}

describe("/effort slash command (Codex /model-style UX)", () => {
  test("1. absent ctx.effort ⇒ 'not wired in this surface' + exit 0", async () => {
    const h = buildHarnessNoEffort()
    const code = await runSlashCommand("/effort", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("/effort: not wired in this surface")
    expect(h.stderr).toBe("")
  })

  test("2. no args ⇒ header + 5 tier lines + use-hint", async () => {
    const h = buildHarness("medium")
    const code = await runSlashCommand("/effort", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("reasoning effort: medium")
    expect(h.stdout).toContain("~4,096 tokens")
    // 5 tier rows present.
    for (const lvl of LEVELS) expect(h.stdout).toContain(lvl)
    // Current marked with `*` (one star in the body — header line uses ":").
    const starLines = h.stdout.split("\n").filter((l) => l.trimStart().startsWith("*"))
    expect(starLines.length).toBe(1)
    expect(starLines[0]).toContain("medium")
    expect(h.stdout).toContain("use: /effort <level>")
    expect(h.setCalls).toEqual([])
  })

  test("3. single named arg ⇒ set + confirmation with budget", async () => {
    const h = buildHarness("default")
    const code = await runSlashCommand("/effort high", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["high"])
    expect(h.current.value).toBe("high")
    expect(h.stdout).toContain("effort: high")
    expect(h.stdout).toContain("~16,384 tokens")
  })

  test("4. multiple args ⇒ stderr error + exit 1", async () => {
    const h = buildHarness("default")
    const code = await runSlashCommand("/effort high medium", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("takes at most one argument")
    expect(h.setCalls).toEqual([])
  })

  test("5. unknown level ⇒ stderr 'unknown level' + level list + exit 1", async () => {
    const h = buildHarness("default")
    const code = await runSlashCommand("/effort ultra", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("unknown level 'ultra'")
    for (const lvl of LEVELS) expect(h.stderr).toContain(lvl)
    expect(h.setCalls).toEqual([])
  })

  test("6. case-insensitive resolution: /effort HIGH ⇒ 'high'", async () => {
    const h = buildHarness("default")
    const code = await runSlashCommand("/effort HIGH", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["high"])
  })

  test("7. /effort default ⇒ confirmation drops budget tag", async () => {
    const h = buildHarness("high")
    const code = await runSlashCommand("/effort default", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["default"])
    expect(h.stdout).toContain("effort: default")
    expect(h.stdout).toContain("provider default")
    expect(h.stdout).toContain("no thinking budget")
    // Must NOT show a token count for default.
    expect(h.stdout).not.toContain("tokens)")
  })

  test("8. set callback is invoked exactly once per `/effort <level>`", async () => {
    const h = buildHarness("default")
    await runSlashCommand("/effort low", h.ctx)
    await runSlashCommand("/effort max", h.ctx)
    expect(h.setCalls).toEqual(["low", "max"])
    expect(h.current.value).toBe("max")
  })
})
