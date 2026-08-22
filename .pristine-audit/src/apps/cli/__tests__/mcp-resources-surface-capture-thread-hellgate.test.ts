/**
 * jul-04 CLI `/mcp-resources` LIVE-DATA hellgate (B4) — closes the "landed-but-
 * empty" gap for the MCP resource-fetch surface command.
 *
 * PRIOR STATE (the gap this pins):
 *   - `mcp_read_resource_dir` (children enumeration) + `mcp_read_resource` (blob-
 *     to-disk) are model-invoke-only. Nothing recorded WHERE the model fetched or
 *     WHICH blobs landed on disk, so the `/mcp-resources` slash `mcpResources` ctx
 *     slot was never populated — it printed "not wired" even when the tools ran.
 *
 * THE CONTRACT (surface-mints → down-thread, ONE holder):
 *   1. A surface-minted `McpResourceCaptureHolder` is threaded INTO the two fetch
 *      tools (producer) AND read by the slash (consumer) — the SAME instance.
 *   2. A dispatch of `mcp_read_resource_dir` records the fetched dir + its DIRECT
 *      children (METADATA only); `/mcp-resources` over the SAME holder then renders
 *      the LIVE fetched-dir rows (> 0), proving one holder / no split-brain.
 *   3. A `mcp_read_resource` blob read records the blob-to-disk PATH; the slash
 *      surfaces it.
 *   4. LEAK: the slash NEVER prints a resource BODY / blob bytes — uri + child
 *      metadata + jailed path only.
 *   5. Absent holder (gate off ⇒ tools not registered) ⇒ `/mcp-resources` prints
 *      "not wired" (default-OFF byte-identical).
 *
 * Boundary: drives the REAL `mcpResourcesTools(port, capture)` producer wire (the
 * exact factory the CLI `buildMcpResourceTools` calls) + the REAL surface adapter
 * shape, so a broken thread turns the slash red.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import {
  createMcpResourceCaptureHolder,
  mcpResourcesTools,
  type ResourceBlock,
  type ResourceEntry,
  type ResourcesHandle,
} from "@/tool"
import { ToolRegistry } from "@/tool/registry"
import { renderMcpResources } from "../slash/mcp-resources-cmd"
import { runSlashCommand } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

const BYPASS: PermissionContext = { mode: "bypass" }

/** A resource BODY sentinel — MUST never appear on the `/mcp-resources` render. */
const BODY_SENTINEL = "ZZ_MCP_BODY_SENTINEL_7f1a_NEVER_LEAK"

/** A single-server handle: fixed dir children + fixed read blocks. */
const handleWith = (opts: {
  children?: ResourceEntry[]
  blocks?: ResourceBlock[]
}): ResourcesHandle => ({
  listResources: async () => ({ ok: true, value: opts.children ?? [] }),
  listResourceTemplates: async () => ({ ok: true, value: [] }),
  readResource: async () => ({ ok: true, value: opts.blocks ?? [] }),
  readResourceDir: async (uri) => ({
    ok: true,
    value: (opts.children ?? []).filter((e) => e.uri.startsWith(uri) && e.uri !== uri),
  }),
  listPrompts: async () => ({ ok: true, value: [] }),
  getPrompt: async () => ({ ok: true, value: { messages: [] } }),
})

/** Fresh jailed cwd per test — the blob-to-disk write refuses to overwrite (a
 *  security invariant), so a fixed path would fail on a re-run. */
const jails: string[] = []
const freshJail = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `mcp-surf-${label}-`))
  jails.push(d)
  return d
}
afterEach(() => {
  for (const d of jails.splice(0)) rmSync(d, { recursive: true, force: true })
})

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "mcp-1",
  name,
  input,
})

const config = (registry: AgentConfig["registry"], cwd: string): AgentConfig =>
  ({
    cwd,
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
  }) as AgentConfig

/** A `/mcp-resources` ctx over the SAME holder — mirrors the surface adapter
 *  (`mcpResources: () => holder.snapshot()`). */
const slashCtxOverHolder = (
  holder: ReturnType<typeof createMcpResourceCaptureHolder> | undefined,
): { ctx: SlashContext; out: () => string } => {
  let stdout = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: () => {},
    cwd: "/tmp",
    ...(holder !== undefined ? { mcpResources: () => holder.snapshot() } : {}),
  }
  return { ctx, out: () => stdout }
}

describe("B4 /mcp-resources LIVE — capture holder threaded into the fetch tools", () => {
  test("read_resource_dir → /mcp-resources lists the fetched dir + children over the SAME holder (single-instance)", async () => {
    const holder = createMcpResourceCaptureHolder()
    const port = handleWith({
      children: [
        { uri: "file:///proj/readme.md", name: "readme.md", mimeType: "text/markdown" },
        { uri: "file:///proj/src", name: "src", mimeType: "inode/directory" },
      ],
    })
    // The REAL producer factory the CLI uses, with the surface holder threaded in.
    const registry = new ToolRegistry(mcpResourcesTools(port, holder))
    // Before any fetch: nothing captured ⇒ the slash shows the empty line.
    expect(holder.size()).toBe(0)

    const jail = freshJail("dir")
    const res = await dispatchTool(
      call("mcp_read_resource_dir", { uri: "file:///proj/" }),
      config(registry, jail),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // The write landed on the SAME holder the surface reads — one instance.
    expect(holder.size()).toBe(1)

    const { ctx, out } = slashCtxOverHolder(holder)
    const code = await runSlashCommand("/mcp-resources", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("MCP resources")
    expect(out()).toContain("file:///proj/")
    expect(out()).toContain("readme.md")
    // subdir child surfaced as a dir row.
    expect(out()).toContain("src")
  })

  test("read_resource blob-to-disk → /mcp-resources surfaces the jailed blob path, NEVER the bytes (leak)", async () => {
    const holder = createMcpResourceCaptureHolder()
    // A blob block whose base64 must never appear on the render.
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const b64 = Buffer.from(raw).toString("base64")
    const port = handleWith({
      blocks: [{ uri: "file:///data/logo.png", mimeType: "image/png", blob: b64 }],
    })
    const registry = new ToolRegistry(mcpResourcesTools(port, holder))

    const jail = freshJail("blob")
    const res = await dispatchTool(
      call("mcp_read_resource", { uri: "file:///data/logo.png" }),
      config(registry, jail),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    expect(holder.size()).toBe(1)

    const { ctx, out } = slashCtxOverHolder(holder)
    expect(await runSlashCommand("/mcp-resources", ctx)).toBe(0)
    // The jailed on-disk path is surfaced …
    expect(out()).toContain("blob →")
    expect(out()).toContain(jail)
    // … but the raw blob bytes / base64 NEVER appear (leak guard).
    expect(out()).not.toContain(b64)
  })

  // ── Adversarial round 1 — no leak of resource bodies on read-dir ────────────
  test("LEAK: a child whose name/mime carry a sentinel still surfaces metadata only (no body)", async () => {
    const holder = createMcpResourceCaptureHolder()
    // The children metadata are legitimately surfaced (uri/name), but a resource
    // BODY (only reachable via read_resource TEXT) is never part of a read-dir
    // capture. Prove the dir capture carries no body field at all.
    const port = handleWith({
      children: [{ uri: "file:///proj/notes.txt", name: "notes.txt", mimeType: "text/plain" }],
      blocks: [{ uri: "file:///proj/notes.txt", mimeType: "text/plain", text: BODY_SENTINEL }],
    })
    const registry = new ToolRegistry(mcpResourcesTools(port, holder))
    await dispatchTool(
      call("mcp_read_resource_dir", { uri: "file:///proj/" }),
      config(registry, freshJail("leak")),
      BYPASS,
    )
    const snap = holder.snapshot()
    expect(snap.length).toBe(1)
    expect(JSON.stringify(snap)).not.toContain(BODY_SENTINEL)
    const { ctx, out } = slashCtxOverHolder(holder)
    await runSlashCommand("/mcp-resources", ctx)
    expect(out()).not.toContain(BODY_SENTINEL)
  })

  // ── Adversarial round 2 — text read does NOT record (no blob) ───────────────
  test("read_resource of a TEXT block records NOTHING (only blob-to-disk fetches are captured)", async () => {
    const holder = createMcpResourceCaptureHolder()
    const port = handleWith({
      blocks: [{ uri: "file:///notes.txt", mimeType: "text/plain", text: "hello world" }],
    })
    const registry = new ToolRegistry(mcpResourcesTools(port, holder))
    const res = await dispatchTool(
      call("mcp_read_resource", { uri: "file:///notes.txt" }),
      config(registry, freshJail("text")),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // A text read writes no file ⇒ nothing captured (no phantom blob rows).
    expect(holder.size()).toBe(0)
  })

  // ── Adversarial round 3 — red-on-injection: broken thread ⇒ "not wired" ─────
  test("holder ABSENT (thread broken) ⇒ /mcp-resources prints 'not wired' + exit 0", async () => {
    const { ctx, out } = slashCtxOverHolder(undefined)
    const code = await runSlashCommand("/mcp-resources", ctx)
    expect(code).toBe(0)
    expect(out().toLowerCase()).toContain("not wired")
  })

  // ── Adversarial round 4 — captured but NOT threaded to the tool ⇒ empty ─────
  test("holder wired but NO fetch ran ⇒ slash renders the empty line (live, not stale)", async () => {
    const holder = createMcpResourceCaptureHolder()
    const { ctx, out } = slashCtxOverHolder(holder)
    expect(await runSlashCommand("/mcp-resources", ctx)).toBe(0)
    expect(out().toLowerCase()).toContain("no resource dirs fetched yet")
  })

  // ── render-purity: the render carries no bodies for arbitrary records ───────
  test("renderMcpResources over a record with children shows the child rows (pure)", () => {
    const out = renderMcpResources([
      {
        uri: "file:///d/",
        children: [{ uri: "file:///d/a.txt", name: "a.txt", mimeType: "text/plain" }],
        at: 1,
      },
    ])
    expect(out).toContain("file:///d/")
    expect(out).toContain("a.txt")
  })
})
