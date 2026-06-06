/**
 * Knob: `mcp-tool-annotations` — §19.1 MCP `ToolAnnotations` ingestion.
 *
 * When set, the MCP→Tool bridge (`@/agent/mcp-bridge`) is authorized to HONOR a
 * server's self-declared `ToolAnnotations` (`readOnlyHint` / `idempotentHint`)
 * when deriving the `isReadOnly` / `isConcurrencySafe` predicates of a bridged
 * MCP tool — but ONLY for servers the host marked `trusted:true` in their
 * `McpServerConfig`. The actual elevation is gated TWICE (knob ON **and** server
 * trusted) inside `annotationPredicates`; this knob is just the global master
 * switch.
 *
 * SECURITY / default-OFF: annotations are SELF-DECLARED by the server, so a
 * hostile/untrusted server's `readOnlyHint:true` must NEVER let its tool skip
 * HITL or run concurrently. With the knob ABSENT (default) every MCP tool stays
 * `isReadOnly:()=>false, isConcurrencySafe:()=>false` — byte-identical to the
 * pre-§19.1 bridge. Even with the knob ON, an untrusted server is unaffected.
 * Annotations can only ever ELEVATE a trusted server's tool, never downgrade
 * safety.
 *
 * STRICT truthy gate — only `"1"`, `"on"`, `"true"` parse to `true`. Falsy /
 * garbage / empty / whitespace return `undefined` so the caller falls through to
 * the next layer (NOT a silent "off"). No heuristics.
 *
 * `apply` sets `AgentConfig.mcpToolAnnotations`, which the composition root reads
 * when assembling the `loadMcpTools` opts (`annotationsHonored`). No
 * `costMultiplier` (pure policy selection — zero added matrix budget).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]
const TRUTHY = new Set(["1", "on", "true"])

const parseMcpToolAnnotations = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? true : undefined
}

const applyMcpToolAnnotations = (
  cfg: AgentConfig,
  value: true,
  ctx: { surface: Surface },
): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, mcpToolAnnotations: true }
}

export const mcpToolAnnotationsKnob: Knob<true> = {
  id: "mcp-tool-annotations",
  envKey: "QUANTA_MCP_TOOL_ANNOTATIONS",
  category: "agent",
  surfaces: SURFACES,
  parse: parseMcpToolAnnotations,
  apply: applyMcpToolAnnotations,
  describe: "Honor trusted MCP servers' ToolAnnotations (readOnly/idempotent hints)",
  source: "§19.1 MCP ToolAnnotations ingestion",
}

registerKnob(mcpToolAnnotationsKnob)
