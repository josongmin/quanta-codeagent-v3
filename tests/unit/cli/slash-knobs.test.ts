/**
 * `/knobs` slash command family — full subcommand coverage.
 *
 * Each test builds a fresh `KnobsSurfaceWire` over a fake `KnobValueMap` +
 * fake sessionOverrides bag. The `allKnobs()` registry must be populated for
 * `set / reset / preset / help <id>` to work; we ensure that by importing
 * the bootstrap module's side-effect file once at top.
 *
 * We do NOT rely on `__resetRegistry` here because the slash command consults
 * the global registry via `allKnobs()` — re-registering between every test
 * would just churn for no semantic gain. Tests assert behavior, not exact
 * registry membership.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KnobValue, KnobValueMap } from "@/runner/knobs"
import "../../../src/apps/cli/knobs-bootstrap" // populate registry via side-effect

import { buildKnobsSlash, type KnobsSurfaceWire } from "../../../src/apps/cli/slash-commands-knobs"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

interface Harness {
  readonly cmd: ReturnType<typeof buildKnobsSlash>
  readonly ctx: SlashContext
  readonly stdout: () => string
  readonly stderr: () => string
  readonly overrides: Record<string, string>
  readonly resolution: () => KnobValueMap
  readonly saveCalls: { count: number }
  readonly setCalls: Array<[string, string]>
}

let dir = ""
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "knobs-slash-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const mkValues = (
  pairs: ReadonlyArray<readonly [string, unknown, KnobValue<unknown>["source"]?]> = [],
): KnobValueMap => {
  const m = new Map<string, KnobValue<unknown>>()
  for (const [id, value, source] of pairs) m.set(id, { value, source: source ?? "env" })
  return m
}

const buildHarness = (initialValues: KnobValueMap = mkValues()): Harness => {
  let stdout = ""
  let stderr = ""
  const overrides: Record<string, string> = {}
  const saveCalls = { count: 0 }
  const setCalls: Array<[string, string]> = []
  let valuesRef = initialValues
  const wire: KnobsSurfaceWire = {
    resolution: () => valuesRef,
    setOverride: (id, raw) => {
      setCalls.push([id, raw])
      overrides[id] = raw
      // Mutate visible resolution so subsequent /knobs show reflects the new
      // session override (mimics the real wire's re-resolve).
      const next = new Map(valuesRef)
      next.set(id, { value: raw, source: "session" })
      valuesRef = next
      return undefined
    },
    resetOverride: (id) => {
      delete overrides[id]
      const next = new Map(valuesRef)
      next.delete(id)
      valuesRef = next
    },
    sessionOverrides: () => overrides,
    save: async () => {
      saveCalls.count += 1
    },
    configPath: join(dir, "knobs.json"),
  }
  const cmd = buildKnobsSlash(wire)
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
  }
  return {
    cmd,
    ctx,
    stdout: () => stdout,
    stderr: () => stderr,
    overrides,
    resolution: () => valuesRef,
    saveCalls,
    setCalls,
  }
}

describe("/knobs — name + dispatch", () => {
  test("registered as /knobs with config category", () => {
    const { cmd } = buildHarness()
    expect(cmd.name).toBe("/knobs")
    expect(cmd.category).toBe("config")
  })

  test("no subcommand ⇒ defaults to 'show'", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run([], h.ctx)
    expect(exit).toBe(0)
    expect(h.stdout()).toContain("Active knobs")
  })

  test("unknown subcommand ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["nonsense"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toContain("unknown subcommand: nonsense")
  })
})

describe("/knobs show", () => {
  test("0 active ⇒ '(none active)' line", async () => {
    const h = buildHarness(mkValues())
    await h.cmd.run(["show"], h.ctx)
    expect(h.stdout()).toContain("none active")
  })

  test("1 active ⇒ row appears with source", async () => {
    const h = buildHarness(mkValues([["persona", "pragmatic", "session"]]))
    await h.cmd.run(["show"], h.ctx)
    expect(h.stdout()).toContain("persona")
    expect(h.stdout()).toContain("pragmatic")
    expect(h.stdout()).toContain("session")
  })

  test("renders box with header + footer", async () => {
    const h = buildHarness(mkValues([["persona", "friendly"]]))
    await h.cmd.run(["show"], h.ctx)
    expect(h.stdout()).toMatch(/Active knobs/)
    expect(h.stdout()).toMatch(/╰/)
  })
})

describe("/knobs list", () => {
  test("renders the full registry with header counts", async () => {
    const h = buildHarness(mkValues([["persona", "pragmatic", "session"]]))
    await h.cmd.run(["list"], h.ctx)
    expect(h.stdout()).toMatch(/registered/)
    expect(h.stdout()).toMatch(/active/)
    // Active knob row should be marked with the ✓ glyph.
    expect(h.stdout()).toMatch(/✓\s+persona/)
  })

  test("includes bench-only knobs with a surface tag", async () => {
    const h = buildHarness()
    await h.cmd.run(["list"], h.ctx)
    // `lsp` surfaces are `["bench", "agent-batch", "agent-interactive"]` —
    // no `cli`. The renderer marks it with a surface tag.
    if (h.stdout().includes("lsp")) {
      // tag includes either "bench-only" or one of the surface ids
      expect(h.stdout()).toMatch(/lsp.+(bench|agent)/)
    }
  })
})

describe("/knobs set", () => {
  test("valid id+val ⇒ stored as session override + confirmation", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["set", "persona=pragmatic"], h.ctx)
    expect(exit).toBe(0)
    expect(h.overrides).toEqual({ persona: "pragmatic" })
    expect(h.setCalls).toEqual([["persona", "pragmatic"]])
    expect(h.stdout()).toMatch(/persona = pragmatic/)
  })

  test("missing argument ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["set"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/expected exactly one argument/)
  })

  test("argument without `=` ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["set", "persona"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/invalid argument/)
  })

  test("unknown knob id ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["set", "nonsense=x"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/unknown knob: nonsense/)
  })

  test("wire-returned warning is surfaced", async () => {
    let stdout = ""
    let stderr = ""
    const wire: KnobsSurfaceWire = {
      resolution: () => mkValues(),
      setOverride: () => "knob 'lsp' is not hot-toggleable",
      resetOverride: () => {},
      sessionOverrides: () => ({}),
      save: async () => {},
      configPath: join(dir, "knobs.json"),
    }
    const cmd = buildKnobsSlash(wire)
    const exit = await cmd.run(["set", "lsp=1"], {
      out: (s) => {
        stdout += s
      },
      err: (s) => {
        stderr += s
      },
      cwd: "/tmp",
    })
    expect(exit).toBe(0)
    expect(stdout).toMatch(/warning: knob 'lsp' is not hot-toggleable/)
    // Warnings ride stdout (not stderr) because exit 0 — verify nothing
    // leaked to the error stream.
    expect(stderr).toBe("")
  })
})

describe("/knobs reset", () => {
  test("clears existing override + confirmation", async () => {
    const h = buildHarness()
    await h.cmd.run(["set", "persona=friendly"], h.ctx)
    const exit = await h.cmd.run(["reset", "persona"], h.ctx)
    expect(exit).toBe(0)
    expect(h.overrides).toEqual({})
    expect(h.stdout()).toMatch(/session override cleared/)
  })

  test("no existing override ⇒ no-op message + exit 0", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["reset", "persona"], h.ctx)
    expect(exit).toBe(0)
    expect(h.stdout()).toMatch(/no session override/)
  })

  test("unknown knob id ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["reset", "nonsense"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/unknown knob: nonsense/)
  })

  test("missing argument ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["reset"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/expected exactly one argument/)
  })
})

describe("/knobs preset", () => {
  test("known preset ⇒ applies all known knobs in the bundle", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["preset", "everything"], h.ctx)
    expect(exit).toBe(0)
    // The "everything" preset includes lsp + subagent + skills + ... — at
    // least one of them will register because the bootstrap import side-
    // effect populated the registry. Verify the wire saw set calls.
    expect(h.setCalls.length).toBeGreaterThan(0)
    expect(h.stdout()).toMatch(/applied \d+ knob/)
  })

  test("unknown preset ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["preset", "nonsense"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/unknown preset: nonsense/)
  })

  test("missing argument ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["preset"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/expected exactly one argument/)
  })

  test("empty preset ('baseline') ⇒ empty-message + exit 0", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["preset", "baseline"], h.ctx)
    expect(exit).toBe(0)
    expect(h.stdout()).toMatch(/is empty/)
  })
})

describe("/knobs save", () => {
  test("calls wire.save and reports configPath", async () => {
    const h = buildHarness()
    await h.cmd.run(["set", "persona=friendly"], h.ctx)
    const exit = await h.cmd.run(["save"], h.ctx)
    expect(exit).toBe(0)
    expect(h.saveCalls.count).toBe(1)
    expect(h.stdout()).toMatch(/saved 1 override/)
    expect(h.stdout()).toContain("knobs.json")
  })

  test("extra args ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["save", "extra"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/takes no arguments/)
  })

  test("save() failure ⇒ stderr + exit 1", async () => {
    let stderr = ""
    const wire: KnobsSurfaceWire = {
      resolution: () => mkValues(),
      setOverride: () => undefined,
      resetOverride: () => {},
      sessionOverrides: () => ({}),
      save: async () => {
        throw new Error("disk full")
      },
      configPath: join(dir, "knobs.json"),
    }
    const cmd = buildKnobsSlash(wire)
    const exit = await cmd.run(["save"], {
      out: () => {},
      err: (s) => {
        stderr += s
      },
      cwd: "/tmp",
    })
    expect(exit).toBe(1)
    expect(stderr).toMatch(/disk full/)
  })
})

describe("/knobs help", () => {
  test("no arg ⇒ family help with all subcommands listed", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["help"], h.ctx)
    expect(exit).toBe(0)
    const out = h.stdout()
    for (const sub of ["show", "list", "set", "reset", "preset", "save", "help"]) {
      expect(out).toContain(`/knobs ${sub}`)
    }
  })

  test("known knob id ⇒ describe + envKey + surfaces", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["help", "persona"], h.ctx)
    expect(exit).toBe(0)
    const out = h.stdout()
    expect(out).toContain("persona")
    expect(out).toMatch(/envKey\s*:\s*QUANTA_PERSONA/)
    expect(out).toMatch(/surfaces\s*:\s*cli/)
  })

  test("unknown knob id ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["help", "nonsense"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/unknown knob: nonsense/)
  })

  test("more than one arg ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const exit = await h.cmd.run(["help", "a", "b"], h.ctx)
    expect(exit).toBe(1)
    expect(h.stderr()).toMatch(/expected at most one argument/)
  })
})

describe("/knobs completion", () => {
  test("empty partial ⇒ all 9 subcommands", () => {
    const h = buildHarness()
    const out = h.cmd.complete?.([], "", h.ctx) ?? []
    expect(out.map((c) => c.value).sort()).toEqual(
      ["all", "find", "help", "list", "preset", "reset", "save", "set", "show"].sort(),
    )
  })

  test("prefix 'l' ⇒ only 'list'", () => {
    const h = buildHarness()
    const out = h.cmd.complete?.([], "l", h.ctx) ?? []
    expect(out.map((c) => c.value)).toEqual(["list"])
  })

  test("'reset ' completes to knob ids", () => {
    const h = buildHarness()
    const out = h.cmd.complete?.(["reset"], "perso", h.ctx) ?? []
    expect(out.find((c) => c.value === "persona")).toBeDefined()
  })

  test("'preset ' completes to preset names", () => {
    const h = buildHarness()
    const out = h.cmd.complete?.(["preset"], "", h.ctx) ?? []
    const vals = out.map((c) => c.value)
    expect(vals).toContain("baseline")
    expect(vals).toContain("everything")
  })
})
