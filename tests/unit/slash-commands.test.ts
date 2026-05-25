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
      // `/usage` reads `prefsHome/.quanta/usage.jsonl`. Inject the per-test
      // tmp dir explicitly via the SlashContext seam so isolation does not
      // depend on `process.env.QUANTA_PREFS_HOME` mutation surviving past
      // `runtimeConfig()`'s validate-once snapshot (#6 runtime-config SSOT).
      prefsHome: cwd,
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
  test("registers the documented builtins (full table — R10 panels appended)", () => {
    // `/rewind` + `/fork` are env-gated (QUANTA_REWIND, default "1"). The
    // unit-test environment leaves the var unset → both commands are
    // registered. A separate test in `rewind-cmd.test.ts` covers the
    // disabled (`QUANTA_REWIND=0`) path. `/memory` is gated the same way
    // (QUANTA_MEMORY_SLASH, default "1") — see `memory-cmd.test.ts`.
    expect(BUILTINS.map((c) => c.name)).toEqual([
      "/help",
      "/context",
      "/usage",
      "/color",
      "/navigate",
      "/wait",
      "/retry-with",
      "/skills",
      "/reload-skills",
      "/login",
      "/logout",
      "/status",
      "/permission",
      "/mcp",
      "/snooze",
      "/resume",
      "/rewind",
      "/fork",
      "/rewind-tool",
      "/side",
      "/snapshot",
      "/rules",
      "/memory",
      "/cost",
      "/plan",
      "/state",
      "/working-state",
      "/history",
      "/branches",
      // Sibling appends — order matches the BUILTINS literal in
      // `slash-commands.ts`. ADR-0224 web/paste + ADR-0225 edit-plan/
      // edit-message land between fork-checkpoint and queue.
      "/fork-checkpoint",
      "/queue",
      "/web",
      "/paste",
      "/edit-plan",
      "/edit-message",
    ])
  })
})

describe("slashCompleter (Tab autocompletion)", () => {
  // Lazy import — the helper lives next to the registry it's completing.
  const importCompleter = async () =>
    (await import("../../src/apps/cli/slash-commands")).slashCompleter

  test("empty input → no candidates (don't pollute the agent prompt)", async () => {
    const c = await importCompleter()
    expect(c("")).toEqual([[], ""])
  })

  test("non-slash input → no candidates", async () => {
    const c = await importCompleter()
    expect(c("hello")).toEqual([[], "hello"])
  })

  test("bare `/` → every builtin + /exit + /quit", async () => {
    const c = await importCompleter()
    const [candidates, partial] = c("/")
    expect(partial).toBe("/")
    expect(candidates).toContain("/login")
    expect(candidates).toContain("/logout")
    expect(candidates).toContain("/status")
    expect(candidates).toContain("/exit")
    expect(candidates).toContain("/quit")
    // Sorted ⇒ deterministic display order.
    const sorted = [...candidates].sort()
    expect(candidates).toEqual(sorted)
  })

  test("`/lo` → /login + /logout only", async () => {
    const c = await importCompleter()
    const [candidates] = c("/lo")
    expect(candidates).toEqual(["/login", "/logout"])
  })

  test("`/login` → unique match (Tab completes to this exact string)", async () => {
    const c = await importCompleter()
    const [candidates, partial] = c("/login")
    expect(candidates).toEqual(["/login"])
    expect(partial).toBe("/login")
  })

  test("unknown slash prefix → empty list", async () => {
    const c = await importCompleter()
    const [candidates] = c("/zzz-no-such")
    expect(candidates).toEqual([])
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
