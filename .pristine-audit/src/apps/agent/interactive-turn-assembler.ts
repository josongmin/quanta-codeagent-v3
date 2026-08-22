/**
 * `apps/agent/interactive-turn-assembler.ts` — surface shim.
 *
 * ADR-0303 thin-surface relocation: the interactive turn-assembler now lives
 * below `src/apps/**` in `@/host/runtime/agent-config-assembler` so the CLI
 * launcher AND `apps/web-daemon` share it by reaching DOWN into `@/host`
 * (web-daemon previously imported this file directly — a cross-surface edge).
 * This wrapper just binds the surface-owned `process.env` into the env-pure
 * host builder.
 */

import {
  buildInteractiveTurnAssembler as buildSharedInteractiveTurnAssembler,
  type InteractiveTurnAssemblerRequest,
} from "@/host/runtime/agent-config-assembler"
import type { RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"

export type { InteractiveTurnAssemblerRequest }

export const buildInteractiveTurnAssembler = (
  req: InteractiveTurnAssemblerRequest = {},
): RuntimeAgentTurnAssembler => buildSharedInteractiveTurnAssembler(req, process.env)
