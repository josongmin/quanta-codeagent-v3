import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUILTINS,
  isSlashCommand,
  runSlashCommand,
  type SlashContext,
} from "../../src/apps/cli/slash-commands"

interface Captured {
  out: string
  err: string
  ctx: SlashContext
  prefsPath: string
}

const buildCtx = (
  cwd: string,
  prefsPath: string,
  sleepImpl?: (ms: number) => Promise<void>,
): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    prefsPath,
    ctx: {
      out: (s) => {
        captured.out += s
      },
      err: (s) => {
        captured.err += s
      },
      cwd,
      prefsPath,
      sleep: sleepImpl,
    },
  }
  return captured
}

let tmp: string
let originalPrefsHome: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "slash-"))
  originalPrefsHome = process.env.QUANTA_PREFS_HOME
  // Scope env-fallback at tmp so `/usage` (which reads via env, not ctx.prefsPath)
  // is per-test isolated.
  process.env.QUANTA_PREFS_HOME = tmp
})

afterEach(() => {
  if (originalPrefsHome === undefined) delete process.env.QUANTA_PREFS_HOME
  else process.env.QUANTA_PREFS_HOME = originalPrefsHome
  rmSync(tmp, { recursive: true, force: true })
})

describe("BUILTINS table", () => {
  test("registers exactly 5 commands in documented order", () => {
    expect(BUILTINS.map((c) => c.name)).toEqual([
      "/context",
      "/usage",
      "/color",
      "/navigate",
      "/wait",
    ])
  })
})

describe("isSlashCommand", () => {
  test("/<letter> ⇒ true", () => {
    expect(isSlashCommand("/context")).toBe(true)
    expect(isSlashCommand("/wait")).toBe(true)
  })

  test("filesystem path (`/path/to/file`) ⇒ false", () => {
    expect(isSlashCommand("/path/to/file")).toBe(false)
    expect(isSlashCommand("/usr/local")).toBe(false)
  })

  test("non-slash and bare slash ⇒ false", () => {
    expect(isSlashCommand("hello")).toBe(false)
    expect(isSlashCommand("/")).toBe(false)
    expect(isSlashCommand("/1foo")).toBe(false)
  })
})

describe("runSlashCommand", () => {
  test("unknown command ⇒ exit 1 + 'unknown'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    const code = await runSlashCommand("/nope", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown")
  })

  test("empty line ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("   ", c.ctx)).toBe(1)
  })
})

describe("/context", () => {
  test("exit 0 + emits placeholder", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/context", c.ctx)).toBe(0)
    expect(c.out).toContain("context:")
  })
})

describe("/usage", () => {
  test("no usage.jsonl ⇒ exit 0 + '(no usage recorded yet)'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/usage", c.ctx)).toBe(0)
    expect(c.out).toContain("no usage recorded")
  })

  test("seeded usage.jsonl ⇒ correct tally", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(tmp, ".quanta"), { recursive: true })
    writeFileSync(
      join(tmp, ".quanta", "usage.jsonl"),
      [
        JSON.stringify({ input_tokens: 100, output_tokens: 20 }),
        JSON.stringify({ input_tokens: 50, output_tokens: 10 }),
        "garbage line",
        "",
      ].join("\n"),
    )
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/usage", c.ctx)).toBe(0)
    expect(c.out).toContain("input_tokens:  150")
    expect(c.out).toContain("output_tokens: 30")
    expect(c.out).toContain("total_tokens:  180")
    expect(c.out).toContain("2 record")
  })
})

describe("/color", () => {
  test("no args + no file ⇒ prints 'auto'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/color", c.ctx)).toBe(0)
    expect(c.out.trim()).toBe("auto")
  })

  test("set valid theme persists to prefs file", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json")
    const c = buildCtx(tmp, prefs)
    expect(await runSlashCommand("/color dark", c.ctx)).toBe(0)
    const stored = JSON.parse(readFileSync(prefs, "utf8"))
    expect(stored.theme).toBe("dark")
  })

  test("invalid theme ⇒ exit 1 + err", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/color blue", c.ctx)).toBe(1)
    expect(c.err).toContain("invalid theme")
  })
})

describe("/navigate", () => {
  test("existing path ⇒ persists", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json")
    const c = buildCtx(tmp, prefs)
    expect(await runSlashCommand(`/navigate ${tmp}`, c.ctx)).toBe(0)
    const stored = JSON.parse(readFileSync(prefs, "utf8"))
    expect(stored.preferredCwd).toBe(tmp)
  })

  test("missing path ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/navigate /no/such/dir/here/maybe", c.ctx)).toBe(1)
    expect(c.err).toContain("does not exist")
  })

  test("`-` clears preferredCwd", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json")
    const c1 = buildCtx(tmp, prefs)
    await runSlashCommand(`/navigate ${tmp}`, c1.ctx)
    const c2 = buildCtx(tmp, prefs)
    expect(await runSlashCommand("/navigate -", c2.ctx)).toBe(0)
    const stored = JSON.parse(readFileSync(prefs, "utf8"))
    expect(stored.preferredCwd).toBeUndefined()
  })

  test("wrong arg count ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/navigate", c.ctx)).toBe(1)
  })
})

describe("/wait", () => {
  test("positive seconds ⇒ exit 0 (sleep injected)", async () => {
    let called = 0
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"), async (ms) => {
      called = ms
    })
    expect(await runSlashCommand("/wait 0.1", c.ctx)).toBe(0)
    expect(called).toBe(100)
  })

  test("non-numeric ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/wait abc", c.ctx)).toBe(1)
  })

  test("non-positive ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/wait -5", c.ctx)).toBe(1)
    expect(await runSlashCommand("/wait 0", c.ctx)).toBe(1)
  })

  test("above 3600 cap ⇒ exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"))
    expect(await runSlashCommand("/wait 4000", c.ctx)).toBe(1)
  })
})

// Confirm the prefs file is created with mkdir -p semantics
test("prefs writes mkdir -p the .quanta dir", async () => {
  const prefs = join(tmp, "nested", "deep", "preferences.json")
  const c = buildCtx(tmp, prefs)
  await runSlashCommand("/color dark", c.ctx)
  expect(existsSync(prefs)).toBe(true)
})
