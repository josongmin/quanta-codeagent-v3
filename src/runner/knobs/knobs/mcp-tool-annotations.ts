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
 * SSOT (Finding 2): the SOLE LIVE channel is the env var, read by the
 * composition root via `runtimeConfig().mcpToolAnnotations` when assembling the
 * `loadMcpTools` opts (`annotationsHonored`). That parse shares THIS knob's
 * truthy vocabulary (`{1,on,true}`, via `parseBool`), so the knob registry /
 * telemetry can never disagree with the consumer. The previous `apply` wrote
 * `AgentConfig.mcpToolAnnotations`, but NOBODY read it (the bridge uses the
 * runtime-config path) — so `apply` is now an identity no-op (it still
 * advertises the knob in the registry for telemetry / `--help`, but mutates no
 * config field). No `costMultiplier` (pure policy selection — zero added matrix
 * budget).
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

/** SSOT (Finding 2) — identity no-op: the live channel is `runtimeConfig`
 *  (env→`mcpToolAnnotations`), NOT `AgentConfig`. The knob stays registered (so
 *  the env var is discoverable + telemetered) but writes no config field, since
 *  the former `AgentConfig.mcpToolAnnotations` write was dead. */
const applyMcpToolAnnotations = (cfg: AgentConfig, _value: true): AgentConfig => cfg

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
