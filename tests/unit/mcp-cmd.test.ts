/**
 * Unit tests for the `/mcp` slash command (MCP server explorer).
 *
 *  Tests focus on the rendering contract — the slash command consumes a
 *  structural surface (`McpSurfaceInfo`) so the LIVE MCP wiring is never
 *  invoked. Color is forced OFF (`setColorPolicy("off")`) so assertions can
 *  match against plain ASCII without ANSI escapes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setColorPolicy } from "@/ui/ui-helpers"
import { CLI_KNOBS, type CliKnob } from "../../src/apps/cli/cli-knobs"
import {
  __resetCliKnobOverrides,
  readCliKnob,
  setCliKnobOverride,
} from "../../src/apps/cli/cli-knobs-accessor"
import {
  formatUptime,
  type McpServerInfo,
  type McpSurfaceInfo,
  runMcpRender,
} from "../../src/apps/cli/mcp-cmd"
import type { SlashContext } from "../../src/apps/cli/slash-commands"

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (mcp?: McpSurfaceInfo): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        captured.out += s
      },
      err: (s) => {
        captured.err += s
      },
      cwd: "/tmp",
      ...(mcp !== undefined ? { mcp } : {}),
    },
  }
  return captured
}

const server = (overrides: Partial<McpServerInfo> & { name: string }): McpServerInfo => ({
  status: "connected",
  toolCount: 0,
  tools: [],
  ...overrides,
})

let tmp: string
let originalVerbose: string | undefined

beforeEach(() => {
  // Plain-ASCII assertions — disable ANSI globally for the test process.
  setColorPolicy("off")
  tmp = mkdtempSync(join(tmpdir(), "mcp-cmd-"))
  originalVerbose = process.env.QUANTA_MCP_VERBOSE
  delete process.env.QUANTA_MCP_VERBOSE
})

afterEach(() => {
  setColorPolicy(null)
  if (originalVerbose === undefined) delete process.env.QUANTA_MCP_VERBOSE
  else process.env.QUANTA_MCP_VERBOSE = originalVerbose
  rmSync(tmp, { recursive: true, force: true })
})

describe("/mcp — empty / not-wired surface", () => {
  test("no surface ⇒ prints 'not wired in this surface' (exit 0)", async () => {
    const cap = buildCtx()
    const code = await runMcpRender([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired in this surface")
    expect(cap.err).toBe("")
  })

  test("empty servers ⇒ renders box with 'no MCP servers configured'", async () => {
    const cap = buildCtx({ servers: [] })
    const code = await runMcpRender([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP servers")
    expect(cap.out).toContain("no MCP servers configured")
  })
})

describe("/mcp — 1 server, multi-server, tool counts", () => {
  test("1 connected server renders name + tool count + footer", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "filesystem",
          status: "connected",
          toolCount: 3,
          tools: [
            { name: "read_file", description: "read file contents", required: [] },
            { name: "write_file", description: "write to file", required: [] },
            { name: "list_directory", description: "list directory entries", required: [] },
          ],
          pid: 12345,
          startedAtMs: 0,
        }),
      ],
      now: () => 60_000,
    })
    const code = await runMcpRender([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("filesystem")
    expect(cap.out).toContain("3 tools")
    expect(cap.out).toContain("pid 12345")
    expect(cap.out).toContain("uptime 1m")
    // Footer reports connected/total + total tools.
    expect(cap.out).toContain("1/1 connected")
    expect(cap.out).toContain("3 tools")
  })

  test("multi-server: tool counts and total in footer", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 12,
          tools: Array.from({ length: 12 }, (_, i) => ({
            name: `t${i}`,
            description: "",
            required: [],
          })),
        }),
        server({
          name: "git",
          toolCount: 8,
          tools: Array.from({ length: 8 }, (_, i) => ({
            name: `g${i}`,
            description: "",
            required: [],
          })),
        }),
      ],
    })
    const code = await runMcpRender([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("fs")
    expect(cap.out).toContain("12 tools")
    expect(cap.out).toContain("git")
    expect(cap.out).toContain("8 tools")
    expect(cap.out).toContain("2/2 connected")
    expect(cap.out).toContain("20 tools")
  })
})

describe("/mcp — failed server rendering", () => {
  test("failed server shows '--' for tools and surfaces error message", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "playwright",
          status: "failed",
          toolCount: 0,
          tools: [],
          errorMessage: "spawn ENOENT",
        }),
      ],
    })
    const code = await runMcpRender([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("playwright")
    expect(cap.out).toContain("--")
    expect(cap.out).toContain("failed: spawn ENOENT")
    // Footer reports zero connected.
    expect(cap.out).toContain("0/1 connected")
  })
})

describe("/mcp tools — list across servers", () => {
  test("'/mcp tools' lists every server's tools with separators", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 2,
          tools: [
            { name: "read_file", description: "read file contents", required: [] },
            { name: "write_file", description: "write to file", required: [] },
          ],
        }),
        server({
          name: "git",
          toolCount: 1,
          tools: [{ name: "git_status", description: "show working tree status", required: [] }],
        }),
      ],
    })
    const code = await runMcpRender(["tools"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP tools (3 across 2 servers)")
    expect(cap.out).toContain("read_file")
    expect(cap.out).toContain("write_file")
    expect(cap.out).toContain("git_status")
    expect(cap.out).toContain("read file contents")
  })

  test("'/mcp tools <name>' lists tools for one server only", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 1,
          tools: [{ name: "read_file", description: "read file contents", required: [] }],
        }),
        server({
          name: "git",
          toolCount: 1,
          tools: [{ name: "git_status", description: "show working tree status", required: [] }],
        }),
      ],
    })
    const code = await runMcpRender(["tools", "fs"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP tools · fs (1)")
    expect(cap.out).toContain("read_file")
    // The 'git' server's tool MUST be absent from the filtered output.
    expect(cap.out).not.toContain("git_status")
  })

  test("'/mcp tools <unknown>' ⇒ exit 1 + hint listing known servers", async () => {
    const cap = buildCtx({
      servers: [
        server({ name: "fs", toolCount: 0, tools: [] }),
        server({ name: "git", toolCount: 0, tools: [] }),
      ],
    })
    const code = await runMcpRender(["tools", "nope"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("unknown server 'nope'")
    expect(cap.err).toContain("known: fs, git")
  })

  test("'/mcp tools' with too many args ⇒ exit 1", async () => {
    const cap = buildCtx({ servers: [] })
    const code = await runMcpRender(["tools", "a", "b"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("expected at most one argument")
  })
})

describe("/mcp config — file content render", () => {
  test("no configPath ⇒ renders discovery hint (exit 0)", async () => {
    const cap = buildCtx({ servers: [] })
    const code = await runMcpRender(["config"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP config")
    expect(cap.out).toContain("no QUANTA_MCP_CONFIG configured")
    expect(cap.out).toContain("QUANTA_BROWSER_MCP_PLUGIN_DIR")
  })

  test("missing file ⇒ renders 'file does not exist'", async () => {
    const cap = buildCtx({
      servers: [],
      configPath: join(tmp, "does-not-exist.json"),
    })
    const code = await runMcpRender(["config"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP config")
    expect(cap.out).toContain("file does not exist")
  })

  test("readable file ⇒ renders path + raw content", async () => {
    const file = join(tmp, "mcp.json")
    const body = '{"servers":[{"name":"fs","command":["bun","fs.ts"]}]}'
    writeFileSync(file, body)
    const cap = buildCtx({ servers: [], configPath: file })
    const code = await runMcpRender(["config"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("MCP config")
    expect(cap.out).toContain(file)
    expect(cap.out).toContain("fs")
    expect(cap.out).toContain("bun")
  })
})

describe("/mcp — color OFF byte-purity", () => {
  test("no ANSI escapes when color policy is off", async () => {
    const cap = buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 1,
          tools: [{ name: "t", description: "d", required: [] }],
        }),
      ],
    })
    await runMcpRender([], cap.ctx)
    // ESC () MUST NOT appear when color is off.
    expect(cap.out).not.toContain("[")
  })
})

describe("/mcp — verbose mode", () => {
  test("QUANTA_MCP_VERBOSE=1 includes cmd + env-key list (no values)", async () => {
    process.env.QUANTA_MCP_VERBOSE = "1"
    const cap = buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 1,
          tools: [{ name: "t", description: "d", required: [] }],
          command: ["bun", "fs.ts"],
          envKeys: ["MCP_TOKEN"],
        }),
      ],
    })
    await runMcpRender([], cap.ctx)
    expect(cap.out).toContain("cmd:")
    expect(cap.out).toContain("bun fs.ts")
    expect(cap.out).toContain("env:")
    expect(cap.out).toContain("MCP_TOKEN")
    expect(cap.out).toContain("values hidden")
  })

  /**
   * `QUANTA_MCP_VERBOSE` is declared in `cli-knobs.ts` with this file as its
   * `readSite`, but the read was `process.env` directly — so the knob the
   * surface advertises was unreachable from `/knobs set`, and its documented
   * boolean vocabulary was not the one enforced.
   *
   * Surfaced by `no-raw-process-env-knob-ratchet`, which had been RED at 44/43
   * on origin/main itself. Nothing reported it because the only gate that runs
   * it is the full suite.
   */
  const verboseFixture = (): Captured =>
    buildCtx({
      servers: [
        server({
          name: "fs",
          toolCount: 1,
          tools: [{ name: "t", description: "d", required: [] }],
          command: ["bun", "fs.ts"],
          envKeys: ["MCP_TOKEN"],
        }),
      ],
    })

  test("the knob is REGISTERED, which is what makes unset mean off", () => {
    // `isVerbose` reads `=== true` with no local fallback, so quiet-by-default
    // is the registry's `default: false` and nothing else. If the declaration
    // were dropped the accessor would return undefined, and this states that
    // out loud instead of letting a `??` swallow it.
    const knob = CLI_KNOBS.find((k: CliKnob) => k.envKey === "QUANTA_MCP_VERBOSE")
    expect(knob).toBeDefined()
    expect({ kind: knob?.kind, default: knob?.default }).toEqual({ kind: "bool", default: false })
    expect(process.env.QUANTA_MCP_VERBOSE).toBeUndefined()
    expect(readCliKnob("QUANTA_MCP_VERBOSE", "bool")).toBe(false)
  })

  test("a session override reaches it with no env var set", async () => {
    // The whole point of the registry: `/knobs set` participates. With the raw
    // read this assertion could not pass, because nothing consulted the store.
    expect(process.env.QUANTA_MCP_VERBOSE).toBeUndefined()
    expect(setCliKnobOverride("QUANTA_MCP_VERBOSE", "1")).toBe(true)
    try {
      const cap = verboseFixture()
      await runMcpRender([], cap.ctx)
      expect(cap.out).toContain("cmd:")
    } finally {
      __resetCliKnobOverrides()
    }

    // PAIRED CONTROL: cleared override, still no env — back to quiet.
    const quiet = verboseFixture()
    await runMcpRender([], quiet.ctx)
    expect(quiet.out).not.toContain("cmd:")
  })

  test("an unrecognized value is not consent", async () => {
    // The replaced local helper was truthy-unless-explicitly-falsy, so this
    // turned verbose output ON. The registry vocabulary is 1/on/true/yes, and
    // anything else falls back to the declared default of false.
    process.env.QUANTA_MCP_VERBOSE = "banana"
    const cap = verboseFixture()
    await runMcpRender([], cap.ctx)
    expect(cap.out).not.toContain("cmd:")

    // ANTI-VACUITY: the fixture DOES render `cmd:` when the knob is really on,
    // so "absent" above is a verdict rather than a fixture that never shows it.
    process.env.QUANTA_MCP_VERBOSE = "yes"
    const on = verboseFixture()
    await runMcpRender([], on.ctx)
    expect(on.out).toContain("cmd:")
  })
})

describe("/mcp — unknown sub-command", () => {
  test("'/mcp wat' ⇒ exit 1 + valid list", async () => {
    const cap = buildCtx({ servers: [] })
    const code = await runMcpRender(["wat"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("unknown sub-command")
    expect(cap.err).toContain("tools | login | config")
  })
})

describe("formatUptime helper", () => {
  test("<1s ⇒ '0s'", () => {
    expect(formatUptime(0)).toBe("0s")
    expect(formatUptime(500)).toBe("0s")
    expect(formatUptime(-100)).toBe("0s")
  })
  test("seconds / minutes / hours / days roll-up", () => {
    expect(formatUptime(5_000)).toBe("5s")
    expect(formatUptime(60_000)).toBe("1m")
    expect(formatUptime(60 * 60_000)).toBe("1h")
    expect(formatUptime(24 * 60 * 60_000)).toBe("1d")
  })
})
