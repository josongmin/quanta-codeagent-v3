/**
 * `apps/agent/assemble.ts` — surface shim over the shared host assembler.
 *
 * ADR-0303 thin-surface relocation: the actual `ModePolicy → AgentConfig`
 * wiring now lives BELOW `src/apps/**` in
 * {@link file://./../../host/runtime/agent-config-assembler.ts} so every
 * surface (this CLI launcher AND `apps/web-daemon`) shares ONE assembler by
 * reaching down into `@/host`, never sideways into a sibling surface.
 *
 * This file keeps the surface's job: read the `process.env` global (allowed in
 * `src/apps/**`) and thread it into the env-pure host core. The public
 * 1-argument `assembleAgentConfig(req)` API is preserved verbatim so the
 * mode-presets and the contract test (`tests/unit/apps/agent/assemble.test.ts`)
 * are unchanged.
 */

import type { AgentConfig } from "@/agent"
import {
  type AssembleRequest,
  assembleAgentConfig as assembleAgentConfigWithEnv,
} from "@/host/runtime/agent-config-assembler"

// Re-export the assembler's typed surface unchanged so mode-presets keep
// importing it from `../assemble`.
export type {
  AssembleRequest,
  AssembleRequestSeams,
  AssemblerEnv,
  BatchExtras,
  CiBotExtras,
  HeadlessExtras,
  InteractiveTurnAssemblerRequest,
  RunOutcome,
} from "@/host/runtime/agent-config-assembler"
export { resolveRunAgent } from "@/host/runtime/agent-config-assembler"

/** Single source of truth for "config for this mode" assembly. Surface wrapper:
 *  binds the launch-time `process.env` into the env-pure host core. */
export const assembleAgentConfig = (req: AssembleRequest): AgentConfig =>
  assembleAgentConfigWithEnv(req, process.env)
