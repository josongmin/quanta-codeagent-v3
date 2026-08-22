/**
 * Tier-1 per-subsystem builder: APPSHOT block (G1, RFC jun-6-appgen-appshot).
 *
 * Returns the `appshot_verify` tool when `config.appshot` is wired (the
 * composition root assembled the real `AppshotPort` over the live `BrowserPort`
 * + judge `LLMPort` + jailed scaffold writer in `agent-config-assembler`), plus
 * the session `dispose` to register into teardown; an empty block otherwise.
 *
 * DEFAULT-OFF: `config.appshot` absent ⇒ `tools: []` + noop dispose, so the loop
 * sees no extra tool and the ToolRegistry stays byte-identical. Mirrors
 * `buildBrowserBlock` posture exactly (the appshot port lazily spawns a browser
 * session the same way the browser block does, so it carries the same teardown).
 *
 * DUCK-TYPED CONFIG ACCESS: `appshot` (+ the optional `appshotDispose`) is read
 * through a narrow structural slot so this module stays standalone — the
 * composition root appends `config.appshot` (+ `config.appshotDispose`)
 * separately.
 */

import { type AppshotSlot, appshotVerifyTool, type Tool } from "@/tool"
import type { AgentConfig } from "../types"

/** Narrow structural slot the composition root appends onto `AgentConfig`. The
 *  `appshotDispose` closes the browser session the appshot port lazily spawned;
 *  it is set alongside `appshot` by `maybeWireAppshot`. */
interface AppshotConfigSlot {
  appshot?: AppshotSlot
  appshotDispose?: () => Promise<void>
}

/** Materialized appshot block — the `appshot_verify` tool(s) + a session dispose
 *  (closes the lazily-spawned browser session). Empty ⇒ default-OFF. */
export interface AppshotBlock {
  readonly tools: Tool[]
  readonly dispose: () => Promise<void>
}

const NOOP = async (): Promise<void> => {}
const EMPTY: AppshotBlock = { tools: [], dispose: NOOP }

/** Build the appshot tool + dispose when the slot is wired. */
export const buildAppshotBlock = (config: AgentConfig): AppshotBlock => {
  const slot = (config as AgentConfig & AppshotConfigSlot).appshot
  if (slot === undefined) return EMPTY
  const tool = appshotVerifyTool({
    port: slot.port,
    now: slot.now,
    ...(slot.artifactSink !== undefined ? { artifactSink: slot.artifactSink } : {}),
  }) as Tool
  const dispose = (config as AgentConfig & AppshotConfigSlot).appshotDispose ?? NOOP
  return { tools: [tool], dispose }
}
