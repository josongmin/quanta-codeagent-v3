/**
 * ADVERSARIAL audit ROUND 3 — E2E INTEGRATION lens (deliverable 1).
 *
 * SEAM-ONLY confirmation + safe-wire proof for the 5 `DefaultToolPorts` slots
 * that round-2 found are NEVER populated by the production composition root
 * (`src/host/runtime/agent-arg-builder.ts` + `src/apps/cli/internal.ts`):
 *
 *     imageGen | officeAuthoring | mcpResources | progressUpdate | ptySession
 *
 * For EACH port this file proves the seam is SOUND by driving the SAME real
 * composition path the host would use — `buildDefaultTools({ <port> })` →
 * `ToolRegistry` → `dispatchTool` — with a FAKE leaf adapter, asserting the
 * gated tool (a) does NOT appear when the port is absent (default-OFF byte-
 * identity), (b) DOES appear when the port is wired, and (c) ACTIVATES + behaves
 * correctly through the REAL dispatch seam (permission + execute). This means a
 * future production host binding is a one-liner — the seam already holds.
 *
 * It does NOT modify production wiring (agent-arg-builder / internal). The
 * round-3 REPORT classifies each as deferred-by-design (the fc/RFC notes for
 * every one of the 5 document the composition-root host wire as the explicit
 * deferred follow-up, each behind its own env knob).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { ImageGenOutcome, ImageGenRequest } from "@/tool"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import type { ResourcesHandle } from "@/tool/mcp_resources"
import type { PtyHandleInfo, PtySessionPort } from "@/tool/pty"

const BYPASS: PermissionContext = { mode: "bypass" }

const config = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

/** Drive ONE call through the REAL `buildDefaultTools` → registry → dispatch
 *  path with the given port wired. `bypass` permission so a mutating tool
 *  reaches `execute` (the seam-proving goal is activation, not the gate). */
const dispatchVia = async (
  ports: Parameters<typeof buildDefaultTools>[0],
  toolName: string,
  input: unknown,
  cwd = "/repo",
) => {
  const tools = buildDefaultTools(ports)
  const registry = new ToolRegistry(tools)
  return dispatchTool(call(toolName, input), config({ registry, cwd }), BYPASS)
}

const names = (ports: Parameters<typeof buildDefaultTools>[0]): string[] =>
  buildDefaultTools(ports).map((t) => t.name)

/* ───────────────────────────── imageGen (H14a) ─────────────────────────── */

describe("SEAM imageGen — DefaultToolPorts.imageGen (unwired in composition root)", () => {
  test("absent ⇒ image_gen NOT registered (default-OFF byte-identity)", () => {
    expect(names({})).not.toContain("image_gen")
  })

  test("wired fake port ⇒ image_gen registered + ACTIVATES through dispatch (ok path)", async () => {
    let received: ImageGenRequest | undefined
    const fakePort = {
      async generate(req: ImageGenRequest): Promise<ImageGenOutcome> {
        received = req
        // 1×1 transparent PNG (valid base64) — the tool writes it via FS jail.
        return {
          kind: "ok",
          images: [
            {
              b64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/1uwAAAAAElFTkSuQmCC",
              mediaType: "image/png",
            },
          ],
        }
      },
    }
    expect(names({ imageGen: fakePort })).toContain("image_gen")
    const dir = mkdtempSync(join(tmpdir(), "seam-imagegen-"))
    try {
      const res = await dispatchVia(
        { imageGen: fakePort },
        "image_gen",
        { prompt: "a red square", outputPath: "out.png", n: 1 },
        dir,
      )
      // The fake port was actually consulted (the wired seam reached the adapter).
      expect(received?.prompt).toBe("a red square")
      // dispatch produced a well-formed ok tool_result — the wired port flowed
      // through buildDefaultTools → registry → dispatch → execute end-to-end.
      expect(res.block.type).toBe("tool_result")
      expect(res.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("key-less fake port ⇒ typed no_key failure (never a crash; seam stays safe)", async () => {
    const noKeyPort = {
      async generate(): Promise<ImageGenOutcome> {
        return { kind: "no_key" }
      },
    }
    const dir = mkdtempSync(join(tmpdir(), "seam-imagegen-nokey-"))
    try {
      const res = await dispatchVia(
        { imageGen: noKeyPort },
        "image_gen",
        { prompt: "x", outputPath: "out.png", n: 1 },
        dir,
      )
      expect(res.ok).toBe(false)
      expect(res.block.type).toBe("tool_result")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ─────────────────────────── officeAuthoring (H14b) ────────────────────── */

describe("SEAM officeAuthoring — DefaultToolPorts.officeAuthoring (unwired)", () => {
  test("absent ⇒ xlsx_write/docx_write/pptx_write NOT registered", () => {
    const off = names({})
    expect(off).not.toContain("xlsx_write")
    expect(off).not.toContain("docx_write")
    expect(off).not.toContain("pptx_write")
  })

  test("wired (boolean port) ⇒ the 3 authoring tools registered", () => {
    const on = names({ officeAuthoring: true })
    expect(on).toContain("xlsx_write")
    expect(on).toContain("docx_write")
    expect(on).toContain("pptx_write")
  })

  test("xlsx_write ACTIVATES through dispatch + writes a real .xlsx (ok:true)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-xlsx-"))
    try {
      const res = await dispatchVia(
        { officeAuthoring: true },
        "xlsx_write",
        {
          path: "book.xlsx",
          sheets: [
            {
              name: "S1",
              rows: [
                ["a", "b"],
                [1, 2],
              ],
            },
          ],
        },
        dir,
      )
      expect(res.ok).toBe(true)
      expect(res.block.type).toBe("tool_result")
      expect(await Bun.file(join(dir, "book.xlsx")).exists()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ─────────────────────────── mcpResources (N3) ─────────────────────────── */

describe("SEAM mcpResources — DefaultToolPorts.mcpResources (unwired)", () => {
  const fakeHandle = (): ResourcesHandle => ({
    async listResources() {
      return { ok: true, value: [{ uri: "file:///a.txt", name: "a" }] }
    },
    async readResource(uri: string) {
      return { ok: true, value: [{ uri, text: "hello" }] }
    },
    async listPrompts() {
      return { ok: true, value: [{ name: "greet" }] }
    },
    async getPrompt() {
      return { ok: true, value: { messages: [{ role: "user", content: "hi" }] } }
    },
  })

  test("absent ⇒ mcp_list_resources NOT registered", () => {
    expect(names({})).not.toContain("mcp_list_resources")
  })

  test("wired ⇒ the 4 mcp resource/prompt tools registered", () => {
    const on = names({ mcpResources: fakeHandle() })
    expect(on).toEqual(
      expect.arrayContaining([
        "mcp_list_resources",
        "mcp_read_resource",
        "mcp_list_prompts",
        "mcp_get_prompt",
      ]),
    )
  })

  test("mcp_list_resources ACTIVATES through dispatch (read-only ⇒ allowed, ok:true)", async () => {
    const res = await dispatchVia({ mcpResources: fakeHandle() }, "mcp_list_resources", {})
    expect(res.ok).toBe(true)
    expect(res.block.content).toContain("a.txt")
  })
})

/* ────────────────────────── progressUpdate (C2) ────────────────────────── */

describe("SEAM progressUpdate — DefaultToolPorts.progressUpdate (unwired)", () => {
  test("absent ⇒ communicate_update NOT registered", () => {
    expect(names({})).not.toContain("communicate_update")
  })

  test("wired (boolean) ⇒ communicate_update registered", () => {
    expect(names({ progressUpdate: true })).toContain("communicate_update")
  })

  test("communicate_update ACTIVATES through dispatch + emits onto ctx.progressSink", async () => {
    const emitted: unknown[] = []
    const tools = buildDefaultTools({ progressUpdate: true })
    const registry = new ToolRegistry(tools)
    // The dispatch seam surfaces AgentConfig.progressSink onto ctx.progressSink.
    const res = await dispatchTool(
      call("communicate_update", { current_step: "halfway done" }),
      config({ registry, progressSink: { emit: (e: unknown) => emitted.push(e) } }),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    expect(emitted.length).toBe(1)
  })

  test("communicate_update with NO sink ⇒ no-op + ok:true (best-effort)", async () => {
    const res = await dispatchVia({ progressUpdate: true }, "communicate_update", {
      current_step: "no sink wired",
    })
    expect(res.ok).toBe(true)
  })
})

/* ───────────────────────────── ptySession (N6) ─────────────────────────── */

describe("SEAM ptySession — DefaultToolPorts.ptySession (unwired)", () => {
  const fakePort = (handles: PtyHandleInfo[]): PtySessionPort => ({
    async list() {
      return handles
    },
    async attach(handle: string) {
      return { ok: true, value: { handle, cursor: 0 } }
    },
    async write() {
      return { ok: true, value: undefined }
    },
    async read() {
      return { ok: true, value: { chunks: [], nextSeq: 0 } }
    },
    async resize() {
      return { ok: true, value: undefined }
    },
    async detach() {
      return { ok: true, value: undefined }
    },
    async kill() {
      return { ok: true, value: undefined }
    },
  })

  test("absent ⇒ pty_* NOT registered", () => {
    expect(names({})).not.toContain("pty_list")
    expect(names({})).not.toContain("pty_attach")
  })

  test("wired ⇒ the 6 pty tools registered", () => {
    const on = names({ ptySession: fakePort([]) })
    expect(on).toEqual(
      expect.arrayContaining([
        "pty_list",
        "pty_attach",
        "pty_write",
        "pty_read",
        "pty_resize",
        "pty_kill",
      ]),
    )
  })

  test("pty_list ACTIVATES through dispatch (read-only ⇒ allowed, ok:true)", async () => {
    const port = fakePort([{ handle: "quanta-a", kind: "tmux", owned: true, title: "zsh" }])
    const res = await dispatchVia({ ptySession: port }, "pty_list", {})
    expect(res.ok).toBe(true)
    expect(res.block.content).toContain("quanta-a")
  })
})
