/**
 * The ASSEMBLED tool universe — every tool a real builder mints, gathered from as many
 * builders as can run without a live service.
 *
 * WHY THIS EXISTS. The tool-surface manifest's completeness was proven by a SOURCE
 * census, and docstrings in `tools/dev/tool-name-literals.ts` and the manifest hellgate
 * named `tests/unit/tool-surface-runtime-parity-hellgate.test.ts` as the assembled-registry
 * authority for what a source census cannot see. That file did not exist — not in the
 * tree, not in `git log --all`. An adversarial audit found it by following the reference,
 * and found what its absence hid: SEVEN live LSP tools (`lsp_definition`, `lsp_hover`,
 * `lsp_type_definition`, `lsp_implementation`, `lsp_rename_preview`,
 * `lsp_incoming_calls`, `lsp_outgoing_calls`) are built with a COMPUTED name by
 * `positionTool`, registered on the CLI, and absent from the manifest.
 *
 * WHAT IS ASSEMBLED, and why each source is real rather than a list:
 *  - `buildBroadlyWiredTools()` and `buildTerminalTools` over the exhaustive port plan;
 *  - `gitTools` / `ghTools` with every opt on (stub runners; nothing runs at build);
 *  - `lspNavToolList`, the CLI's own LSP builder (it spawns no server until a call);
 *  - the six-tool router, objective, mailbox and introspect factories;
 *  - `buildSessionFeatures` over an `AgentConfig` whose slots are the ones the MANIFEST
 *    DECLARES for its config-slot rows. The fixture follows the catalogue's own claims,
 *    so a row whose declared slot mints nothing is visible as unassembled.
 *
 * WHAT IS NOT: tools whose builders need a live resource at construction (a browser,
 * an MCP handshake, a spawned subagent). The parity gate pins those BY NAME as a ledger
 * that may only shrink.
 */

import { buildSessionFeatures } from "@/agent/features"
import { lspNavToolList } from "@/agent/lsp-bridge/tools"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { createObjectiveCapabilities, createObjectiveStore } from "@/objective"
import { createIntrospectTools, createSubagent6Tools, TaskRegistry } from "@/subagent"
import { buildTerminalTools, GATED_TOOLS, ghTools, gitTools, type Tool, ToolRegistry } from "@/tool"
import { objectiveTools } from "@/tool/objective"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"
import { buildBroadlyWiredTools, PORT_PLAN, portsFromPlan } from "./wired-tool-ports"

const STUB = {} as never

/** `AgentConfig` slots named by the manifest's config-slot rows, as a config object. */
export const manifestDeclaredSessionConfig = (): Record<string, unknown> => {
  const cfg: Record<string, unknown> = {
    registry: new ToolRegistry([]),
    permission: { mode: "default" },
    cwd: "/tmp",
    sessionId: "assembled-tool-universe",
    llm: { model: "m", stream: async function* () {} },
    subagent: {} as Record<string, unknown>,
  }
  const subagent = cfg.subagent as Record<string, unknown>
  for (const entry of GATED_TOOLS) {
    if (entry.gate.kind !== "config-slot") continue
    const slot = entry.gate.slot.replace(/^AgentConfig\./, "")
    if (slot.startsWith("subagent.")) {
      const key = slot.slice("subagent.".length)
      subagent[key] = key.startsWith("enable") ? true : STUB
      continue
    }
    // Only a plain `camelCase` AgentConfig field. `DefaultToolPorts.*` rows are covered
    // by the port plan; free-text slots ("TasksHandle (apps MCP wire)") name no field.
    if (/^[a-z][A-Za-z0-9]*$/.test(slot)) cfg[slot] = cfg[slot] ?? STUB
  }
  return cfg
}

export interface AssembledUniverse {
  readonly tools: readonly Tool[]
  /** Source label → names it minted, so a failure can say where a name came from. */
  readonly bySource: ReadonlyMap<string, readonly string[]>
}

export const assembleToolUniverse = async (): Promise<AssembledUniverse> => {
  const bySource = new Map<string, readonly string[]>()
  const tools: Tool[] = []
  const add = (label: string, minted: readonly Tool[]): void => {
    bySource.set(
      label,
      minted.map((t) => t.name),
    )
    tools.push(...minted)
  }
  add("buildDefaultTools (port plan)", buildBroadlyWiredTools())
  add("buildTerminalTools (port plan)", buildTerminalTools(portsFromPlan(PORT_PLAN)))
  add(
    "gitTools (all opts)",
    gitTools(undefined, { coChange: true, authorLLM: STUB, gitDirectiveEmitter: STUB }),
  )
  add(
    "ghTools (all opts)",
    ghTools(undefined, { codeTour: true, ciFindingStore: STUB, authorLLM: STUB, gitRunner: STUB }),
  )
  add(
    "lspNavToolList",
    lspNavToolList(() => "/tmp"),
  )
  add(
    "createSubagent6Tools",
    createSubagent6Tools({
      runner: async () => ({ ok: true, finalText: "", turns: 0, messages: [] }),
      registry: new TaskRegistry(),
    } as never).tools,
  )
  const caps = createObjectiveCapabilities(createObjectiveStore())
  add(
    "objectiveTools (+verify)",
    objectiveTools({
      model: caps.model,
      read: caps.read,
      verify: {
        verify: async () => ({ kind: "no-checks" as const }),
        reconcile: async () => ({ kind: "no-objective" as const }),
      },
    } as never),
  )
  add("subagentMailboxTools", subagentMailboxTools(createSubagentMailbox()))
  add(
    "createIntrospectTools",
    createIntrospectTools({ registry: new TaskRegistry(), enableIntrospect: true }),
  )
  const features = await buildSessionFeatures(manifestDeclaredSessionConfig() as never)
  add("buildSessionFeatures (manifest-declared slots)", features.extraTools)
  return { tools, bySource }
}
