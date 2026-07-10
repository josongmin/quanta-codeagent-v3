/**
 * UUX-4-14 hellgate — `/mcp` full lifecycle with WRITE-THROUGH.
 *
 * RED-CORE (pre-implementation): `/mcp enable|disable|reload` do not exist —
 * the dispatcher rejects them as unknown sub-commands. This suite pins the
 * SOTA contract:
 *
 *   - `enable <server>` / `disable <server>` WRITE THROUGH to the config file
 *     the loader reads (`ctx.mcp.configPath`) — read-modify-write, atomic
 *     tmp+rename, unknown fields preserved, other servers untouched;
 *   - a config that is not valid JSON (comments / JSONC) is REFUSED and the
 *     file is left byte-identical (never a lossy rewrite);
 *   - `enable` of an unknown server fails (exit 1) listing the servers the
 *     FILE declares, file byte-identical;
 *   - `reload` is honest: no live MCP reload seam exists in this surface —
 *     exit 2 (NOT_WIRED_EXIT) + "takes effect next session" copy;
 *   - concurrent-edit guard: a file whose mtime moved between read and write
 *     is refused (last-write honesty, never a silent clobber).
 *
 * Strong-test rules: real fs effects (temp dir), fresh readback after every
 * mutation, paired controls (idempotent enable/disable), red-on-injection
 * (parse refusal), no vacuous assertions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setColorPolicy } from "@/ui/ui-helpers"
import { type McpSurfaceInfo, runMcpRender } from "../../../src/apps/cli/mcp-cmd"
import { applyMcpServerToggle, writeMcpConfigAtomic } from "../../../src/apps/cli/mcp-config-rmw"
import { NOT_WIRED_EXIT } from "../../../src/apps/cli/not-wired"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

interface Captured {
  readonly ctx: SlashContext
  readonly out: () => string
  readonly err: () => string
}

const buildCtx = (mcp?: McpSurfaceInfo): Captured => {
  const cap = { out: "", err: "" }
  const ctx = {
    out: (s: string) => {
      cap.out += s
    },
    err: (s: string) => {
      cap.err += s
    },
    cwd: "/tmp",
    ...(mcp !== undefined ? { mcp } : {}),
  } as SlashContext
  return { ctx, out: () => cap.out, err: () => cap.err }
}

const surfaceFor = (configPath: string): McpSurfaceInfo => ({
  servers: [],
  configPath,
})

/** Plugin-style config with TWO servers + an unknown per-server field the
 *  RMW must round-trip untouched. */
const PLUGIN_CONFIG = {
  mcpServers: {
    alpha: { command: "run-alpha", args: ["--x"], customNote: "keep-me" },
    beta: { url: "https://beta.example" },
  },
}

/** Legacy wrapper config with an unknown ROOT field + an unknown server
 *  field, both of which must survive the RMW byte-for-data. */
const LEGACY_CONFIG = {
  servers: [
    { name: "alpha", command: ["run-alpha"], vendorExtra: { a: 1 } },
    { name: "beta", command: ["run-beta"] },
  ],
  futureTopLevelKnob: true,
}

let dir: string
beforeEach(() => {
  setColorPolicy("off")
  dir = mkdtempSync(join(tmpdir(), "mcp-lifecycle-"))
})
afterEach(() => {
  setColorPolicy(null)
  rmSync(dir, { recursive: true, force: true })
})

const writeConfig = (obj: unknown): string => {
  const p = join(dir, "mcp.json")
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8")
  return p
}

const readConfig = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>

/* ------------------------------------------------------------------ */
/* /mcp disable — write-through (plugin format)                        */
/* ------------------------------------------------------------------ */

describe("/mcp disable — write-through RMW (plugin format)", () => {
  test("RED-CORE: disable marks the server disabled in the FILE (fresh readback)", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["disable", "alpha"], cap.ctx)
    expect(code).toBe(0)
    const after = readConfig(p) as unknown as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(after.mcpServers.alpha?.disabled).toBe(true)
    // unknown per-server field preserved through the RMW
    expect(after.mcpServers.alpha?.customNote).toBe("keep-me")
    // sibling server untouched
    expect(after.mcpServers.beta).toEqual({ url: "https://beta.example" })
    // honest copy: the write is next-session, not live
    expect(cap.out()).toContain("next session")
  })

  test("enable removes the disabled marker (fresh readback) — round trip", async () => {
    const p = writeConfig({
      mcpServers: { alpha: { command: "run-alpha", disabled: true } },
    })
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["enable", "alpha"], cap.ctx)
    expect(code).toBe(0)
    const after = readConfig(p) as { mcpServers: Record<string, Record<string, unknown>> }
    expect("disabled" in (after.mcpServers.alpha ?? {})).toBe(false)
  })

  test("idempotent: enable of an already-enabled server ⇒ exit 0, file byte-identical", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const before = readFileSync(p, "utf8")
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["enable", "alpha"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("already enabled")
    expect(readFileSync(p, "utf8")).toBe(before)
  })

  test("no .tmp residue after a successful write (atomic rename)", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    await runMcpRender(["disable", "beta"], cap.ctx)
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"))
    expect(leftovers).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* /mcp disable — legacy {servers:[...]} format                        */
/* ------------------------------------------------------------------ */

describe("/mcp disable — legacy wrapper format", () => {
  test("disable sets disabled on the matching entry; unknown root + server fields preserved", async () => {
    const p = writeConfig(LEGACY_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["disable", "alpha"], cap.ctx)
    expect(code).toBe(0)
    const after = readConfig(p) as {
      servers: Array<Record<string, unknown>>
      futureTopLevelKnob: unknown
    }
    expect(after.futureTopLevelKnob).toBe(true)
    const alpha = after.servers.find((s) => s.name === "alpha")
    expect(alpha?.disabled).toBe(true)
    expect(alpha?.vendorExtra).toEqual({ a: 1 })
    const beta = after.servers.find((s) => s.name === "beta")
    expect(beta).toEqual({ name: "beta", command: ["run-beta"] })
  })
})

/* ------------------------------------------------------------------ */
/* adversarial arms                                                    */
/* ------------------------------------------------------------------ */

describe("/mcp enable|disable — adversarial", () => {
  test("unknown server ⇒ exit 1, lists servers from the FILE, file byte-identical", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const before = readFileSync(p, "utf8")
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["enable", "ghost"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err()).toContain("ghost")
    expect(cap.err()).toContain("alpha")
    expect(cap.err()).toContain("beta")
    expect(readFileSync(p, "utf8")).toBe(before)
  })

  test("JSONC / commented config ⇒ REFUSED, file byte-identical (never lossy)", async () => {
    const p = join(dir, "mcp.jsonc")
    const raw = `{\n  // my servers\n  "mcpServers": { "alpha": { "command": "x" } }\n}\n`
    writeFileSync(p, raw, "utf8")
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["disable", "alpha"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err()).toContain("not valid JSON")
    expect(readFileSync(p, "utf8")).toBe(raw)
  })

  test("missing config file ⇒ exit 1, honest error", async () => {
    const cap = buildCtx(surfaceFor(join(dir, "does-not-exist.json")))
    const code = await runMcpRender(["disable", "alpha"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err().length).toBeGreaterThan(0)
  })

  test("no configPath wired ⇒ NOT_WIRED_EXIT with a hint (never silent success)", async () => {
    const cap = buildCtx({ servers: [] })
    const code = await runMcpRender(["disable", "alpha"], cap.ctx)
    expect(code).toBe(NOT_WIRED_EXIT)
    expect(cap.out()).toContain("not wired")
  })

  test("missing server argument ⇒ usage error (exit 1)", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    expect(await runMcpRender(["enable"], cap.ctx)).toBe(1)
    expect(await runMcpRender(["disable", "a", "b"], cap.ctx)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* /mcp reload — honest half                                            */
/* ------------------------------------------------------------------ */

describe("/mcp reload — exit-2 honesty (no live reload seam)", () => {
  test("reload ⇒ NOT_WIRED_EXIT + 'next session' copy (never claims a live effect)", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["reload"], cap.ctx)
    expect(code).toBe(NOT_WIRED_EXIT)
    expect(cap.out()).toContain("next session")
  })

  test("reload <server> ⇒ same honest posture", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    const code = await runMcpRender(["reload", "alpha"], cap.ctx)
    expect(code).toBe(NOT_WIRED_EXIT)
  })

  test("reload with too many args ⇒ exit 1", async () => {
    const p = writeConfig(PLUGIN_CONFIG)
    const cap = buildCtx(surfaceFor(p))
    expect(await runMcpRender(["reload", "a", "b"], cap.ctx)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* pure RMW helper — applyMcpServerToggle                               */
/* ------------------------------------------------------------------ */

describe("applyMcpServerToggle (pure)", () => {
  test("plugin format: disable ⇒ changed, serialized JSON parses back with disabled:true", () => {
    const res = applyMcpServerToggle(JSON.stringify(PLUGIN_CONFIG), "alpha", "disable")
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`)
    expect(res.changed).toBe(true)
    const parsed = JSON.parse(res.next) as { mcpServers: Record<string, { disabled?: boolean }> }
    expect(parsed.mcpServers.alpha?.disabled).toBe(true)
  })

  test("unparseable input ⇒ typed parse failure (no throw)", () => {
    const res = applyMcpServerToggle("{ not json", "alpha", "disable")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("parse")
  })

  test("recognizable-neither shape ⇒ typed shape failure", () => {
    const res = applyMcpServerToggle(`{"something": 1}`, "alpha", "disable")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("shape")
  })
})

/* ------------------------------------------------------------------ */
/* concurrent-edit guard — writeMcpConfigAtomic                        */
/* ------------------------------------------------------------------ */

describe("writeMcpConfigAtomic — concurrent-edit guard", () => {
  test("mtime moved since read ⇒ REFUSED, concurrent content survives", async () => {
    const p = join(dir, "c.json")
    writeFileSync(p, `{"a":1}\n`, "utf8")
    const readAtMs = statSync(p).mtimeMs
    // a concurrent session edits the file after our read…
    await new Promise((r) => setTimeout(r, 5))
    writeFileSync(p, `{"a":2}\n`, "utf8")
    const res = await writeMcpConfigAtomic(p, `{"a":3}\n`, readAtMs)
    expect(res.ok).toBe(false)
    expect(readFileSync(p, "utf8")).toBe(`{"a":2}\n`)
  })

  test("unchanged mtime ⇒ written atomically", async () => {
    const p = join(dir, "c.json")
    writeFileSync(p, `{"a":1}\n`, "utf8")
    const readAtMs = statSync(p).mtimeMs
    const res = await writeMcpConfigAtomic(p, `{"a":3}\n`, readAtMs)
    expect(res.ok).toBe(true)
    expect(readFileSync(p, "utf8")).toBe(`{"a":3}\n`)
  })
})
