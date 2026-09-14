/**
 * Hellgate — a tool presented under a subagent namespace is still gated as itself.
 *
 * THE DEFECT (round-10 audit A2, reproduced). `namespaceRegistry` renamed each tool to
 * `<agent>__<name>`. Every policy at the dispatch seam is keyed by the tool's own name —
 * the ownership fence's tables, the deny-all permitted table, plan-mode rows, permission
 * rules — so a renamed tool matched none of them: `agent1__apply_patch` wrote outside a
 * fenced child's owned set, and `agent1__shadow_verify` ran under the deny-all posture.
 *
 * The registry now maps the presented name to the tool's own name, and dispatch runs every
 * gate under that name. Each arm dispatches through the REAL pipeline, with the same call
 * on the un-renamed registry as its paired control.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildNetworkDispatchGuard } from "@/agent/dispatch-guard"
import { buildOwnershipPolicy } from "@/agent/ownership-policy"
import { buildEffectiveConfig } from "@/agent/session-resources"
import { namespaceRegistry, prefixToolNamespace } from "@/agent/subagent-tool-namespace"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { REPO_ROOT } from "../_helpers/repo-root"

let executed: string[] = []
const mkTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    executed.push(name)
    yield { type: "result", result: { ok: true, output: "ran" } } satisfies ToolEvent
  },
})

const perm: PermissionContext = { mode: "bypass" }
const raw = (): ToolRegistry =>
  new ToolRegistry([
    mkTool("apply_patch", false),
    mkTool("shadow_verify", false),
    mkTool("read", true),
  ])
const renamed = (): ToolRegistry => namespaceRegistry(raw(), prefixToolNamespace, "agent1")
const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}`,
  name,
  input,
})
const cfg = (registry: ToolRegistry, over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry,
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig

const escapingPatch = {
  patch: "*** Begin Patch\n*** Add File: OUTSIDE.txt\n+x\n*** End Patch",
}

describe("the registry maps a presented name to the tool's own name", () => {
  test("policyNameOf and lookups by either name", () => {
    const r = renamed()
    expect(r.has("agent1__apply_patch")).toBe(true)
    expect(r.policyNameOf("agent1__apply_patch")).toBe("apply_patch")
    expect(r.policyNameOf("read")).toBe("read")
    expect(r.get("apply_patch")?.name).toBe("agent1__apply_patch")
    expect(raw().policyNameOf("apply_patch")).toBe("apply_patch")
  })
})

describe("a renamed tool is gated as itself", () => {
  const fenced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })
  if (fenced === undefined) throw new Error("fixture: an enforced policy")

  test("RED: a renamed apply_patch outside the owned set is denied by the fence", async () => {
    executed = []
    const res = await dispatchTool(
      call("agent1__apply_patch", escapingPatch),
      cfg(renamed(), { ownershipPolicy: fenced }),
      perm,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.preview).toBe("ownership-policy-denied")
    expect(executed).toEqual([])
  })

  test("PAIRED CONTROL: the same call on the un-renamed registry is denied the same way", async () => {
    executed = []
    const res = await dispatchTool(
      call("apply_patch", escapingPatch),
      cfg(raw(), { ownershipPolicy: fenced }),
      perm,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.preview).toBe("ownership-policy-denied")
  })

  test("RED: a renamed shadow_verify is refused under the deny-all posture; a renamed read runs", async () => {
    const guard = buildNetworkDispatchGuard({ posture: "denied" })
    if (guard === undefined) throw new Error("fixture: the denied posture builds a guard")
    executed = []
    const refused = await dispatchTool(
      call("agent1__shadow_verify", {}),
      cfg(renamed(), { dispatchGuard: guard }),
      perm,
    )
    expect(refused.ok).toBe(false)
    const allowed = await dispatchTool(
      call("agent1__read", {}),
      cfg(renamed(), { dispatchGuard: guard }),
      perm,
    )
    expect(allowed.ok).toBe(true)
    // `executed` records the name the tool was built with.
    expect(executed).toEqual(["read"])
  })
})

// ROUND-11 AUDIT A3: the gates above ran on the tool's own name, but everything after
// execution still used the presented one, and the rename dropped the origin map. An MCP
// tool presented as `agent1__…` was classified `builtin`/internal, so with the untrusted
// envelope on its output reached the model unwrapped; `agent1__read` was not `file`; post
// hooks saw a name the pre hooks never did. Registries derived by filtering or merging
// (a tool-filtered child, feature tools, side conversations) dropped origin the same way.
describe("after execution, a renamed tool is still itself", () => {
  const withEnvelope = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prior = process.env.QUANTA_UNTRUSTED_ENVELOPE
    process.env.QUANTA_UNTRUSTED_ENVELOPE = "1"
    __resetRuntimeConfig()
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.QUANTA_UNTRUSTED_ENVELOPE
      else process.env.QUANTA_UNTRUSTED_ENVELOPE = prior
      __resetRuntimeConfig()
    }
  }
  const withMcp = (): ToolRegistry =>
    new ToolRegistry(
      [mkTool("mcp__srv__fetch", true), mkTool("read", true)],
      new Map([["mcp__srv__fetch", "mcp" as const]]),
    )
  const outputOf = async (registry: ToolRegistry, name: string): Promise<string> => {
    const res = await dispatchTool(call(name, {}), cfg(registry, {}), perm)
    return res.block.content
  }

  test("RED: an MCP tool presented under a namespace keeps its untrusted-source envelope", async () => {
    await withEnvelope(async () => {
      const renamedOut = await outputOf(
        namespaceRegistry(withMcp(), prefixToolNamespace, "agent1"),
        "agent1__mcp__srv__fetch",
      )
      expect(renamedOut).toContain('<untrusted-source name="mcp">')
      // PAIRED CONTROL: the same tool, un-renamed.
      expect(await outputOf(withMcp(), "mcp__srv__fetch")).toContain(
        '<untrusted-source name="mcp">',
      )
    })
  })

  test("RED: a renamed `read` is file content, as `read` is", async () => {
    await withEnvelope(async () => {
      const renamed = namespaceRegistry(withMcp(), prefixToolNamespace, "agent1")
      expect(await outputOf(renamed, "agent1__read")).toContain('<untrusted-source name="file">')
      expect(await outputOf(withMcp(), "read")).toContain('<untrusted-source name="file">')
    })
  })

  test("RED: post_tool_use hooks see the name pre_tool_use hooks saw", async () => {
    const seen: { type: string; name: string }[] = []
    const hooks = {
      emit: async (e: { type: string; name?: string }) => {
        if (e.type === "pre_tool_use" || e.type === "post_tool_use") {
          seen.push({ type: e.type, name: e.name ?? "" })
        }
        return {}
      },
    } as unknown as NonNullable<AgentConfig["hooks"]>
    await dispatchTool(
      call("agent1__read", {}),
      cfg(namespaceRegistry(withMcp(), prefixToolNamespace, "agent1"), { hooks }),
      perm,
    )
    expect(seen).toEqual([
      { type: "pre_tool_use", name: "read" },
      { type: "post_tool_use", name: "read" },
    ])
  })

  test("RED: a registry derived by filtering or merging keeps each tool's origin", () => {
    const source = withMcp()
    const filtered = source.derive(source.all().filter((t) => t.name !== "read"))
    expect(filtered.originOf("mcp__srv__fetch")).toBe("mcp")
    const merged = source.derive([...source.all(), mkTool("feature_tool", false)])
    expect(merged.originOf("mcp__srv__fetch")).toBe("mcp")
    expect(merged.originOf("feature_tool")).toBe("builtin")
    const effective = buildEffectiveConfig(cfg(source, {}), [mkTool("spawn_agent", false)])
    expect(effective.registry.originOf("mcp__srv__fetch")).toBe("mcp")
  })
})

describe("every registry built from another registry's tools is derived", () => {
  // The origin map lives on the registry instance, so a plain `new ToolRegistry(tools)` over
  // tools taken from another registry reads every one of them as `builtin`. Roots build from
  // fresh tool arrays; every other construction goes through `ToolRegistry.derive`.
  const ROOTS: Readonly<Record<string, string>> = {
    "src/host/runtime/agent-arg-builder/gated-tool-ports.ts":
      "the CLI's composed tool surface, with its origin map",
    "src/runner/assemble/tooling.ts": "the runner's composed tool surface, with its origin map",
    "src/runner/batch/eval/driver/config-build.ts": "the bench attempt's fresh tool list",
    "src/sdk/embed.ts": "the SDK embed's consumer + default tools",
    "src/apps/terminal/brain-mode-session-scaffold.ts": "brain mode's fresh tool list",
    "src/apps/agent/mode-presets/daemon.ts": "buildDefaultTools() when no registry was passed",
    "src/apps/agent/mode-presets/ci-bot.ts": "the ci-bot git + gh tools",
    "src/apps/agent/mode-presets/interactive.ts": "buildDefaultTools() when no registry was passed",
    "src/apps/agent/mode-presets/ide.ts": "buildDefaultTools() when no registry was passed",
    "src/apps/agent/mode-presets/batch.ts": "buildDefaultTools() when no registry was passed",
    "src/apps/agent/mode-presets/headless.ts": "buildDefaultTools() when no registry was passed",
    "src/apps/cli/mcp-server-setup.ts": "the MCP server surface, with its origin map",
    "src/apps/cli/serve-stdio-cmd.ts": "buildDefaultTools()",
    "src/apps/web-daemon/runtime-factory/agent-config-base.ts": "the web daemon's fresh tool list",
    "src/apps/headless/fake-deps.ts": "the headless fake's fresh tool list",
    "src/apps/eval/trajectory/replay.ts": "buildDefaultTools()",
    "src/apps/eval/synthetic/runner.ts": "buildDefaultTools()",
    "src/side-agent/worker-charter-runner.ts": "buildDefaultTools()",
    "src/tool/registry.ts": "ToolRegistry.derive itself",
  }

  test("the construction sites are exactly the classified roots", () => {
    const found = new Set<string>()
    for (const rel of new Bun.Glob("src/**/*.ts").scanSync({ cwd: REPO_ROOT })) {
      if (rel.endsWith(".test.ts") || rel.includes("/__tests__/")) continue
      const text = readFileSync(join(REPO_ROOT, rel), "utf8")
      // Code only: a doc comment may show the old shape.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      if (/new\s+ToolRegistry\s*\(/.test(code)) found.add(rel)
    }
    expect(found.size, "ANTI-VACUITY: the scan reached the tree").toBeGreaterThan(10)
    expect([...found].sort()).toEqual(Object.keys(ROOTS).sort())
  })
})
