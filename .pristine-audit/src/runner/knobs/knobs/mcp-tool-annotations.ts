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
 * Truthy gate — `"1"` / `"on"` / `"true"` (CASE-INSENSITIVE) parse to `true`;
 * falsy / garbage / empty return `undefined` so the caller falls through to the
 * next layer (NOT a silent "off"). No heuristics.
 *
 * SSOT (Finding 2 / SSOT): the SOLE LIVE channel is the env var, read by the
 * composition root via `runtimeConfig().mcpToolAnnotations` when assembling the
 * `loadMcpTools` opts (`annotationsHonored`). This knob's `parse` reuses the
 * EXACT SAME `parseBool` predicate that `runtimeConfig` uses for this env var, so
 * the two channels are BYTE-EQUAL on every value — including case variants like
 * `"TRUE"` / `"ON"`, which previously diverged (the knob's old case-SENSITIVE
 * Set reported OFF while the bridge read ON). The previous `apply` wrote
 * `AgentConfig.mcpToolAnnotations`, but NOBODY read it (the bridge uses the
 * runtime-config path) — so that field is now removed and `apply` is an identity
 * no-op (it still advertises the knob in the registry for telemetry / `--help`,
 * but mutates no config field). No `costMultiplier` (pure policy selection —
 * zero added matrix budget).
 */

import type { AgentConfig } from "@/agent"
import { parseBool } from "@/shared"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

const parseMcpToolAnnotations = (raw: string | undefined): true | undefined =>
  // SSOT — reuse the SAME predicate `runtimeConfig().mcpToolAnnotations` uses, so
  // the knob registry/telemetry can NEVER disagree with the live bridge read.
  parseBool(raw) ? true : undefined

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
