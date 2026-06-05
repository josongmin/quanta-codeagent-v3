/**
 * ADVERSARIAL audit ROUND 3 — E2E INTEGRATION lens (deliverable 2).
 *
 * Real dispatch + permission integration for the ALREADY-wired session tools:
 *   coverage_check | prompt_cache_status | side_agent_* | mcp_connector_* | artifact_*
 *
 * Each is driven through the REAL `dispatchTool` (permission gate + plan-mode
 * seam + execute) with FAKE leaf adapters. Hunts:
 *   - a permission classification that BLOCKS a tool that should pass (or vice-versa)
 *   - a tool whose risk routes it to the wrong HITL tier
 *   - a mutating tool that slips through in plan mode (cross-check the round-2
 *     MUTATING_TOOL_TABLE classification takes effect at the dispatch seam)
 *
 * NOTE on permission posture: the dispatch seam classifies via `inferToolTier`
 * (read-only ⇒ "none"; mutating-without-`hitlTier` ⇒ secure-by-default
 * "always-confirm") and the legacy mode policy (default ⇒ ask; acceptEdits/
 * bypass ⇒ allow). These tests pin the OBSERVED routing so a regression that
 * flips a read-only tool to mutating (or lets a mutating tool through in
 * default/plan mode) is caught.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { isMutatingTool } from "@/agent/mode"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import type { ToolUseBlock } from "@/llm"
import { defaultPromptCacheObserver } from "@/observability/prompt-cache"
import type { PermissionContext } from "@/permission"
import {
  buildDefaultTools,
  type SideAgentDaemonPort,
  sideAgentTools,
  type Tool,
  ToolRegistry,
} from "@/tool"
import { artifactTools } from "@/tool/artifact"
import { coverageCheckTool } from "@/tool/coverage_check"
import type { McpConnectorDiscoveryPort, McpInstallOutcome } from "@/tool/mcp-connector"
import { mcpConnectorTools } from "@/tool/mcp-connector"
import { promptCacheStatusTool } from "@/tool/prompt_cache_status"

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

const config = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

/** Dispatch ONE call against a registry of the given tools, with explicit
 *  permission mode + optional plan/onConfirm overrides. */
const dispatch = async (
  tools: Tool[],
  name: string,
  input: unknown,
  over: Partial<AgentConfig> & { permMode?: PermissionContext["mode"] } = {},
) => {
  const { permMode, ...cfg } = over
  const mode = permMode ?? "acceptEdits"
  return dispatchTool(
    call(name, input),
    config({ registry: new ToolRegistry(tools), permission: { mode }, ...cfg }),
    { mode },
  )
}

/* ─────────────────── fake leaf adapters for the wired tools ─────────────── */

const fakeSideAgentPort = (): SideAgentDaemonPort & { spawned: number; stopped: string[] } => {
  let spawned = 0
  const stopped: string[] = []
  const port = {
    get spawned() {
      return spawned
    },
    stopped,
    spawn() {
      spawned++
      return `da-${spawned}`
    },
    findings() {
      return []
    },
    list() {
      return []
    },
    stop(id: string) {
      stopped.push(id)
      return true
    },
  }
  return port as SideAgentDaemonPort & { spawned: number; stopped: string[] }
}

const fakeConnectorPort = (): McpConnectorDiscoveryPort & { installed: string[] } => {
  const installed: string[] = []
  return {
    installed,
    list() {
      return [{ id: "fs", name: "Filesystem", description: "local fs", transport: "stdio" }]
    },
    install(id: string): McpInstallOutcome {
      if (id !== "fs") return { ok: false, error: "unknown-id" }
      installed.push(id)
      return { ok: true, name: id }
    },
  }
}

/* ─────────────────────── coverage_check (read-only) ────────────────────── */

describe("coverage_check — read-only ⇒ permission allows without confirm", () => {
  test("default mode (would ask a mutating tool) ⇒ read-only coverage_check NOT asked", async () => {
    let asked = 0
    // coverage_check reads its own V8 source; with no coverage JSON present it
    // yields a typed ok:false — but the PERMISSION path must let it RUN (never
    // an ask / deny), because it is read-only. We assert onConfirm is untouched.
    const res = await dispatch(
      [coverageCheckTool as Tool],
      "coverage_check",
      {},
      {
        permMode: "default",
        onConfirm: async () => {
          asked++
          return true
        },
      },
    )
    expect(asked).toBe(0) // read-only ⇒ "none" tier ⇒ no confirm
    expect(res.block.type).toBe("tool_result") // ran (ok or typed-fail), never blocked
  })

  test("read-only coverage_check is ALLOWED in plan mode (not in mutating table block)", async () => {
    const res = await dispatch(
      [coverageCheckTool as Tool],
      "coverage_check",
      {},
      {
        planMode: true,
        permMode: "default",
      },
    )
    // plan-mode seam must NOT block it (classified `null` in MUTATING_TOOL_TABLE)
    // and must NOT throw UnknownToolError. preview is never "mode-blocked".
    expect(res.preview).not.toBe("mode-blocked")
    expect(res.block.type).toBe("tool_result")
  })
})

/* ────────────────── prompt_cache_status (read-only) ────────────────────── */

describe("prompt_cache_status — read-only ⇒ allowed everywhere", () => {
  const tool = promptCacheStatusTool(defaultPromptCacheObserver()) as Tool

  test("default mode ⇒ runs ok:true without confirm", async () => {
    let asked = 0
    const res = await dispatch(
      [tool],
      "prompt_cache_status",
      {},
      {
        permMode: "default",
        onConfirm: async () => {
          asked++
          return true
        },
      },
    )
    expect(asked).toBe(0)
    expect(res.ok).toBe(true)
    expect(res.block.content).toContain("Prompt cache report")
  })

  test("allowed in plan mode (classified read-only)", async () => {
    const res = await dispatch(
      [tool],
      "prompt_cache_status",
      {},
      {
        planMode: true,
        permMode: "default",
      },
    )
    expect(res.preview).not.toBe("mode-blocked")
    expect(res.ok).toBe(true)
  })
})

/* ───────────────────────── side_agent_* tools ──────────────────────────── */

describe("side_agent_* — read/write split honored at the permission + plan seam", () => {
  test("side_agent_list (read-only) ⇒ allowed in default mode without confirm", async () => {
    let asked = 0
    const res = await dispatch(
      sideAgentTools(fakeSideAgentPort()),
      "side_agent_list",
      {},
      {
        permMode: "default",
        onConfirm: async () => {
          asked++
          return true
        },
      },
    )
    expect(asked).toBe(0)
    expect(res.ok).toBe(true)
  })

  test("side_agent_spawn (subagent_spawn) ⇒ BLOCKED in plan mode at the dispatch seam", async () => {
    const port = fakeSideAgentPort()
    const res = await dispatch(
      sideAgentTools(port),
      "side_agent_spawn",
      {
        task: "monitor",
        trigger: { kind: "interval", every_ms: 1000 },
        max_wakes: 3,
        max_turns_per_wake: 1,
      },
      { planMode: true, permMode: "bypass" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(res.block.content).toContain("blocked in plan collaboration mode")
    // CRITICAL: the seam blocked BEFORE execute — the daemon was never spawned.
    expect(port.spawned).toBe(0)
  })

  test("side_agent_stop (subagent_control) ⇒ BLOCKED in plan mode (never reaches stop)", async () => {
    const port = fakeSideAgentPort()
    const res = await dispatch(
      sideAgentTools(port),
      "side_agent_stop",
      { id: "x" },
      {
        planMode: true,
        permMode: "bypass",
      },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(port.stopped).toEqual([])
  })

  test("side_agent_spawn (mutating, no hitlTier) ⇒ secure-by-default always-confirm under HITL", async () => {
    // inferToolTier fallback for a mutating tool with no hitlTier() is
    // "always-confirm" — so with HITL enabled, even bypass mode calls onConfirm.
    let confirmed = 0
    const res = await dispatch(
      sideAgentTools(fakeSideAgentPort()),
      "side_agent_spawn",
      {
        task: "monitor",
        trigger: { kind: "interval", every_ms: 1000 },
        max_wakes: 3,
        max_turns_per_wake: 1,
      },
      {
        permMode: "bypass",
        hitl: { enabled: true },
        onConfirm: async () => {
          confirmed++
          return true
        },
      },
    )
    expect(confirmed).toBe(1) // always-confirm tier fired even under bypass
    expect(res.ok).toBe(true)
  })
})

/* ───────────────────────── mcp_connector_* tools ───────────────────────── */

describe("mcp_connector_* — list read-only / install config-WRITE", () => {
  test("mcp_connector_list (read-only) ⇒ allowed in default mode without confirm", async () => {
    let asked = 0
    const res = await dispatch(
      mcpConnectorTools(fakeConnectorPort()),
      "mcp_connector_list",
      {},
      {
        permMode: "default",
        onConfirm: async () => {
          asked++
          return true
        },
      },
    )
    expect(asked).toBe(0)
    expect(res.ok).toBe(true)
    expect(res.block.content).toContain("fs")
  })

  test("mcp_connector_install (write_filesystem) ⇒ BLOCKED in plan mode (no .mcp.json write)", async () => {
    const port = fakeConnectorPort()
    const res = await dispatch(
      mcpConnectorTools(port),
      "mcp_connector_install",
      { id: "fs" },
      {
        planMode: true,
        permMode: "bypass",
      },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(res.block.content).toContain("blocked in plan collaboration mode")
    // CRITICAL: the seam blocked BEFORE execute — nothing was installed.
    expect(port.installed).toEqual([])
  })

  test("mcp_connector_install ⇒ asks in default mode (mutating ⇒ ask), declined when no onConfirm", async () => {
    const port = fakeConnectorPort()
    const res = await dispatch(
      mcpConnectorTools(port),
      "mcp_connector_install",
      { id: "fs" },
      {
        permMode: "default", // no onConfirm wired
      },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(port.installed).toEqual([]) // never executed
  })

  test("mcp_connector_install ⇒ runs in acceptEdits (mutating allowed) and installs", async () => {
    const port = fakeConnectorPort()
    const res = await dispatch(
      mcpConnectorTools(port),
      "mcp_connector_install",
      { id: "fs" },
      {
        permMode: "acceptEdits",
      },
    )
    expect(res.ok).toBe(true)
    expect(port.installed).toEqual(["fs"])
  })
})

/* ───────────────────────────── artifact_* tools ────────────────────────── */

describe("artifact_* — list/get read-only, register/destroy mutating", () => {
  const registry = () => createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory() })

  test("artifact_list (read-only) ⇒ allowed in default mode without confirm", async () => {
    let asked = 0
    const res = await dispatch(
      artifactTools(registry()),
      "artifact_list",
      {},
      {
        permMode: "default",
        onConfirm: async () => {
          asked++
          return true
        },
      },
    )
    expect(asked).toBe(0)
    expect(res.ok).toBe(true)
  })

  test("artifact_destroy (mutating) ⇒ BLOCKED in plan mode at the dispatch seam", async () => {
    const reg = registry()
    const a = reg.register({ kind: "image", path: "/x.png", mediaType: "image/png" })
    const res = await dispatch(
      artifactTools(reg),
      "artifact_destroy",
      { id: a.id },
      {
        planMode: true,
        permMode: "bypass",
      },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    // CRITICAL: blocked before execute — the artifact still exists.
    expect(reg.get(a.id)).not.toBeUndefined()
  })

  test("artifact_get (read-only) ⇒ allowed in plan mode (round-trip register→get)", async () => {
    const reg = registry()
    const a = reg.register({ kind: "image", path: "/x.png", mediaType: "image/png" })
    const res = await dispatch(
      artifactTools(reg),
      "artifact_get",
      { id: a.id },
      {
        planMode: true,
        permMode: "default",
      },
    )
    expect(res.preview).not.toBe("mode-blocked")
    expect(res.ok).toBe(true)
    expect(res.block.content).toContain(a.id)
  })

  test("artifact_register (mutating) ⇒ asks in default mode; declined ⇒ NOT registered", async () => {
    const reg = registry()
    const res = await dispatch(
      artifactTools(reg),
      "artifact_register",
      { kind: "image", path: "/y.png", media_type: "image/png" },
      { permMode: "default" }, // no onConfirm ⇒ declined
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(reg.list()).toHaveLength(0) // never executed
  })

  test("R3 FIX: artifact_destroy plan-block uses the CORRECT PlanModeMutating reason (not 'not classified')", async () => {
    const reg = registry()
    const a = reg.register({ kind: "image", path: "/x.png", mediaType: "image/png" })
    const res = await dispatch(
      artifactTools(reg),
      "artifact_destroy",
      { id: a.id },
      {
        planMode: true,
        permMode: "bypass",
      },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    // Before the fix this said "not classified in the plan-mode mutating table"
    // (UnknownToolError); now it is the correct PlanModeMutatingBlockedError.
    expect(res.block.content).toContain("blocked in plan collaboration mode")
    expect(res.block.content).not.toContain("not classified")
  })
})

/* ─────── R3 FIX: MUTATING_TOOL_TABLE covers ALL wired buildDefaultTools ──── */

describe("MUTATING_TOOL_TABLE — every conditionally-wired tool is classified (no UnknownToolError)", () => {
  test("a fully-wired buildDefaultTools has NO tool missing from the plan-mode table", () => {
    const noKeyImageGen = { generate: async () => ({ kind: "no_key" as const }) }
    const fakeResources = {
      listResources: async () => ({ ok: true as const, value: [] }),
      readResource: async () => ({ ok: true as const, value: [] }),
      listPrompts: async () => ({ ok: true as const, value: [] }),
      getPrompt: async () => ({ ok: true as const, value: { messages: [] } }),
    }
    const fakePty = {
      list: async () => [],
      attach: async () => ({ ok: true as const, value: { handle: "h", cursor: 0 } }),
      write: async () => ({ ok: true as const, value: undefined }),
      read: async () => ({ ok: true as const, value: { chunks: [], nextSeq: 0 } }),
      resize: async () => ({ ok: true as const, value: undefined }),
      detach: async () => ({ ok: true as const, value: undefined }),
      kill: async () => ({ ok: true as const, value: undefined }),
    }
    const fakeConnectors = { list: () => [], install: () => ({ ok: false as const, error: "x" }) }
    const fakeArtifact = createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory() })
    const tools = buildDefaultTools({
      structuredPatch: true,
      coverageCheck: true,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake leaf ports
      imageGen: noKeyImageGen as any,
      officeAuthoring: true,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake leaf ports
      mcpResources: fakeResources as any,
      progressUpdate: true,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake leaf ports
      ptySession: fakePty as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake leaf ports
      mcpConnectors: fakeConnectors as any,
      artifactRegistry: fakeArtifact,
    })
    const missing = tools
      .map((t) => t.name)
      .filter((n) => {
        try {
          isMutatingTool(n)
          return false
        } catch {
          return true
        }
      })
    expect(missing).toEqual([])
  })
})
