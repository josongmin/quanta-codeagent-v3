/**
 * `/rules` slash-command surface — hellgate tests against the fs-driven inventory.
 *
 * Each test seeds a temp dir with `.git` sentinel + AGENTS.md / .quanta/rules/*
 * fixtures, then invokes the command through {@link runSlashCommand} (NOT a
 * direct `.run()` call) so the dispatch path itself is exercised.
 *
 * Capture out/err via a small sink that records every chunk; assertions read
 * the joined stream so multi-write `ctx.out` calls don't mis-split.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RULE_INDICATOR_ENV } from "../../../src/apps/cli/rule-indicator"
import {
  isSlashCommand,
  runSlashCommand,
  type SlashContext,
} from "../../../src/apps/cli/slash-commands"

const makeCtx = (cwd: string): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const ctx: SlashContext = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    cwd,
  }
  return { ctx, out, err }
}

const newRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "quanta-rules-cmd-"))
  await mkdir(join(dir, ".git"), { recursive: true })
  return dir
}

// We mutate process.env to toggle the indicator knob — restore after each test
// so the global env stays clean for the rest of the suite.
let savedIndicator: string | undefined
beforeEach(() => {
  savedIndicator = process.env[RULE_INDICATOR_ENV]
})
afterEach(() => {
  if (savedIndicator === undefined) delete process.env[RULE_INDICATOR_ENV]
  else process.env[RULE_INDICATOR_ENV] = savedIndicator
})

describe("/rules · registry", () => {
  test("/rules is recognised as a slash command", () => {
    expect(isSlashCommand("/rules")).toBe(true)
  })
})

describe("/rules · no args (summary)", () => {
  test("empty rule env ⇒ '(no rules configured)' summary", async () => {
    const dir = await newRepo()
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("(no rules configured)")
  })

  test("one global rule ⇒ summary lists it", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# policy\n", "utf8")
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules", ctx)
    expect(code).toBe(0)
    const joined = out.join("")
    expect(joined).toContain("rules: 1/1 matched")
    expect(joined).toContain("AGENTS.md")
  })

  test("inactive rule hints '/rules list' for full inventory", async () => {
    const dir = await newRepo()
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "x.md"),
      "---\nglobs: '**/*.test.ts'\n---\nbody\n",
      "utf8",
    )
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain('"/rules list"')
  })
})

describe("/rules list · full inventory", () => {
  test("paints active + inactive rows + summary line", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# repo\n", "utf8")
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nbody\n",
      "utf8",
    )
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules list", ctx)
    expect(code).toBe(0)
    const joined = out.join("")
    expect(joined).toContain("AGENTS.md")
    expect(joined).toContain("tests.md")
    expect(joined).toContain("1 active · 1 inactive")
  })

  test("extra arguments after list ⇒ error exit 1", async () => {
    const dir = await newRepo()
    const { ctx, err } = makeCtx(dir)
    const code = await runSlashCommand("/rules list extra", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("takes no further arguments")
  })
})

describe("/rules path <pattern>", () => {
  test("simulates a path against the discovered rules", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# repo\n", "utf8")
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nbody\n",
      "utf8",
    )
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules path src/foo.test.ts", ctx)
    expect(code).toBe(0)
    const joined = out.join("")
    expect(joined).toContain("simulating: src/foo.test.ts")
    expect(joined).toContain("2 rules would fire")
  })

  test("non-matching path ⇒ only global rules fire", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# repo\n", "utf8")
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nbody\n",
      "utf8",
    )
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules path src/foo.ts", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("1 rule would fire")
  })

  test("missing pattern ⇒ error exit 1", async () => {
    const dir = await newRepo()
    const { ctx, err } = makeCtx(dir)
    const code = await runSlashCommand("/rules path", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("expected exactly one argument")
  })
})

describe("/rules · env gating", () => {
  test("indicator disabled ⇒ explicit message + exit 0", async () => {
    const dir = await newRepo()
    process.env[RULE_INDICATOR_ENV] = "0"
    const { ctx, out } = makeCtx(dir)
    const code = await runSlashCommand("/rules", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("indicator disabled")
  })
})

describe("/rules · unknown sub-command", () => {
  test("unknown verb ⇒ error + usage hint", async () => {
    const dir = await newRepo()
    const { ctx, out, err } = makeCtx(dir)
    const code = await runSlashCommand("/rules wat", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("unknown sub-command")
    expect(out.join("")).toContain("Usage: /rules")
  })
})
