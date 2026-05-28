/**
 * Tier-1 per-subsystem builder: SHADOW VERIFY block (ADR-0400).
 *
 * Returns the `shadow_verify` tool when `config.shadowVerify` is wired; empty
 * array otherwise.
 *
 * DEFAULT-OFF: `config.shadowVerify` absent ⇒ this builder returns [], so the
 * loop sees no extra tools and the ToolRegistry stays byte-identical for
 * every legacy caller (RFC §1.2).
 *
 * The producer `ShadowVerifyPort` (closed contract in `@/agent/shadow-verify`)
 * is a structural superset of the tool-side `ShadowVerifyPortMirror` (only the
 * `verify(req, signal)` method is consumed) — the assignment narrows it to
 * the consumed surface. Same composition-root pattern `buildDelegateBlock`
 * uses for `DelegationPort` (ADR-0393).
 */

import type { Tool } from "@/tool"
import { type ShadowVerifyPortMirror, shadowVerifyTool } from "@/tool/shadow-verify"
import type { AgentConfig } from "../types"

/** Build the shadow-verify tool when the port slot is wired. */
export const buildShadowVerifyBlock = (config: AgentConfig): Tool[] => {
  const port = config.shadowVerify
  if (port === undefined) return []
  // Producer (`ShadowVerifyPort`, ADR-0396) is a structural superset of the
  // tool-side mirror (`ShadowVerifyPortMirror`, ADR-0400). The cast narrows
  // to the consumed surface (`verify`-only).
  return [shadowVerifyTool(port as ShadowVerifyPortMirror) as Tool]
}
