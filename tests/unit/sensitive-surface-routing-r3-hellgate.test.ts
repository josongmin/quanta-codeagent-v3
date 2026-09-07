/**
 * ★ ROUND 3 (jun-05) — SENSITIVE-DATA SURFACE ROUTING audit.
 *
 * Companion to `redaction-deep-security-r7-hellgate.test.ts` (which sealed the
 * redaction ENGINE) and `dispatch-pii-redaction-hellgate.test.ts` (which sealed
 * the dispatch SEAM). This battery seals the LAST mile for the sensitive-data
 * surfaces added this session: that each surface emits its external / secret-
 * bearing payload through the REDACTED channel (`ToolResult.output` → dispatch
 * `applyRedaction`), NOT through a side-channel (a `failure` field, a log, or a
 * raw on-disk write) that bypasses masking.
 *
 * The audited surfaces and the leak that would slip past the engine if a future
 * refactor moved their payload off `output`:
 *   - `mcp_read_resource` — a resource whose CONTENT is a token (third-party,
 *     adversary-controllable). Verified: the secret is rendered RAW by the pure
 *     `renderResourceContent` (group A) but the DISPATCH seam masks it (group D).
 *     A regression that surfaced resource content outside `output` (e.g. a
 *     content-block side-channel carrying the raw string) would make D fail.
 *   - `pty_read` — terminal capture showing `export TOKEN=…`. The capture flows
 *     to the model via `output`; group D proves the dispatch seam masks it. (The
 *     terminal data is the user's own screen, but a secret-SHAPED token in it is
 *     still masked by the same closed pattern set — documented, not raw-by-design
 *     for known secret formats.)
 *   - `side_agent_findings` — a background CHILD agent's finding can carry a
 *     secret it read; the finding reaches the PARENT transcript only via this
 *     tool's `output`, which the dispatch seam masks (group D).
 *
 * Every assertion is deterministic — no Date.now / randomness / thresholds.
 *
 * Slice fence: imports the public dispatch entry point + the real surface tool
 * factories + the pure render helper. Fake ports carry the secrets in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"
import type { ResourcesHandle } from "@/tool/mcp_resources/port"
import { mcpReadResourceTool } from "@/tool/mcp_resources/read_resource"
import { renderResourceContent } from "@/tool/mcp_resources/render"
import type { PtySessionPort } from "@/tool/pty/port"
import { ptyTools } from "@/tool/pty/tools"
import type { SideAgentDaemonPort, SideAgentFindingView } from "@/tool/side-agent"
import { sideAgentTools } from "@/tool/side-agent"

// ─── Fake secrets the surfaces must NOT pass through raw ────────────────────
const OPENAI_KEY = "sk-ABC123DEF456GHI789JKL012MNO345PQR678STU90"
const GH_PAT = "ghp_1234567890abcdefghijklmnopqrstuvwxyz12"
const AWS_ID = "AKIAIOSFODNN7EXAMPLE"

// ─── Dispatch harness (mirrors dispatch-pii-redaction-hellgate.test.ts) ─────
const baseConfig = (tool: Tool): AgentConfig =>
  ({
    registry: new ToolRegistry([tool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
  }) as AgentConfig

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "sens-surface-perm-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

// ─── Fake ports that inject a secret into each surface's output ─────────────
const resourceHandleReturning = (secretText: string): ResourcesHandle => ({
  async listResources() {
    return { ok: true, value: [{ uri: "mem://creds" }] }
  },
  async listResourceTemplates() {
    return { ok: true, value: [{ uriTemplate: "mem://creds/{id}", description: secretText }] }
  },
  async readResource(uri: string) {
    return { ok: true, value: [{ uri, mimeType: "text/plain", text: secretText }] }
  },
  async readResourceDir() {
    return { ok: true, value: [] }
  },
  async listPrompts() {
    return { ok: true, value: [] }
  },
  async getPrompt() {
    return { ok: true, value: { messages: [] } }
  },
})

/** In-memory blob write double (the D4 blob test cwd `/repo` is not writable). */
const memWritePort = (): import("@/tool/image-gen/store").ImageWritePort => {
  const writes = new Map<string, Uint8Array>()
  return {
    exists: async (p) => writes.has(p),
    writeBytes: async (p, b) => void writes.set(p, b),
  }
}

const ptyPortReturning = (paneText: string): PtySessionPort =>
  ({
    async list() {
      return []
    },
    async attach(handle: string) {
      return { ok: true, value: { handle, cursor: 0 } }
    },
    async write() {
      return { ok: true, value: undefined }
    },
    async read() {
      return { ok: true, value: { chunks: [{ seq: 1, data: paneText }], nextSeq: 2 } }
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
  }) as PtySessionPort

const findingsRegistryReturning = (
  findings: readonly SideAgentFindingView[],
): SideAgentDaemonPort =>
  ({
    spawn() {
      return "d1"
    },
    list() {
      return []
    },
    stop() {
      return true
    },
    findings() {
      return findings
    },
  }) as unknown as SideAgentDaemonPort

const toolByName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not found`)
  return t
}

// ─────────────────────────────────────────────────────────────────────────
// A. The PURE renderers emit the secret RAW — proving masking MUST happen at
//    the dispatch seam (it is not the renderer's job; see render.ts header).
// ─────────────────────────────────────────────────────────────────────────
describe("A. pure renderers are raw (masking is a downstream seam)", () => {
  test("A1 — renderResourceContent passes resource text VERBATIM", () => {
    const out = renderResourceContent("mem://creds", [
      { uri: "mem://creds", text: `OPENAI_API_KEY=${OPENAI_KEY}` },
    ])
    // Raw here — the dispatch seam (group D) is what masks it.
    expect(out).toContain(OPENAI_KEY)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D. END-TO-END: dispatch each surface's secret-bearing output. The model-
//    visible block (`res.preview`) MUST be masked and MUST NOT carry the raw
//    secret. A refactor that moved any surface's payload off `output` would
//    fail here.
// ─────────────────────────────────────────────────────────────────────────
describe("D. surface output is masked at the dispatch seam", () => {
  test("D1 — mcp_read_resource: token in resource content is masked", async () => {
    const tool = mcpReadResourceTool(resourceHandleReturning(`OPENAI_API_KEY=${OPENAI_KEY}`))
    const res = await dispatchTool(
      call("mcp_read_resource", { uri: "mem://creds" }),
      baseConfig(tool),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).not.toContain(OPENAI_KEY)
    expect(res.preview).toContain("[REDACTED:openai_api_key]")
  })

  test("D2 — pty_read: `export TOKEN=ghp_…` in terminal capture is masked", async () => {
    const tools = ptyTools(ptyPortReturning(`user@host$ export TOKEN=${GH_PAT}\n`))
    const res = await dispatchTool(
      call("pty_read", { handle: "tmux:work" }),
      baseConfig(toolByName(tools, "pty_read")),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).not.toContain(GH_PAT)
    // Unattributed pre-existing PTY scrollback is now producer-classified as
    // secret. Layer 1 must therefore replace the entire payload before the
    // weaker token-pattern classifier can name an individual credential.
    expect(res.preview).toContain("[REDACTED:source_class_secret]")
    expect(res.preview).toContain("origin: <pty:tmux:work>")
  })

  test("D3 — side_agent_findings: a child's secret-bearing finding is masked", async () => {
    const registry = findingsRegistryReturning([
      {
        daemonId: "watcher",
        wake: 1,
        summary: `found leaked AWS id ${AWS_ID} in config`,
        at: 1,
      },
    ])
    const tools = sideAgentTools(registry)
    const res = await dispatchTool(
      call("side_agent_findings", {}),
      baseConfig(toolByName(tools, "side_agent_findings")),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).not.toContain(AWS_ID)
    expect(res.preview).toContain("[REDACTED:aws_access_key_id]")
  })

  test("D4 — mcp_read_resource: a BLOB block is NEVER inlined (B4: saved to disk)", async () => {
    // Defensive: a blob that DECODES to a secret must not be inlined raw either.
    // B4 writes the blob to a jailed file instead of a placeholder — the raw
    // base64 (and thus the decoded secret) still never reaches the transcript.
    const tool = mcpReadResourceTool(
      {
        ...resourceHandleReturning(""),
        async readResource(uri: string) {
          return {
            ok: true,
            value: [{ uri, mimeType: "application/octet-stream", blob: "QUtJQQ==" }],
          }
        },
      },
      { writePort: memWritePort() },
    )
    const res = await dispatchTool(
      call("mcp_read_resource", { uri: "mem://blob" }),
      baseConfig(tool),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).not.toContain("QUtJQQ==")
    expect(res.preview).toContain("blobSavedTo:")
  })
})
