/**
 * Tier-1 per-subsystem builder: BROWSER block (ADR-0427).
 *
 * Returns the `browser_*` tools when `config.browser?.port` is wired, plus the
 * session `dispose` to register into teardown; an empty block otherwise.
 *
 * DEFAULT-OFF: `config.browser` absent ⇒ `tools: []` + noop dispose, so the loop
 * sees no extra tools and the ToolRegistry stays byte-identical. Mirrors
 * `buildSubagentBgBlock` posture.
 *
 * DUCK-TYPED CONFIG ACCESS: `browser` is read through a narrow structural slot
 * so this module stays standalone and can land before the caller-wire step (the
 * composition root appends `config.browser` + pushes `dispose` into its disposer
 * collector separately).
 */

import type { BrowserPort } from "@/browser"
import { type BrowserToolset, createBrowserToolset, type DnsResolver } from "@/tool/browser"
import type { AgentConfig } from "../types"

/** Narrow structural slot the composition root appends onto `AgentConfig`. */
interface BrowserConfigSlot {
  browser?: {
    readonly port: BrowserPort
    readonly resolver?: DnsResolver
    /** TICKET-24 — per-feature default-OFF gates (QUANTA_BROWSER_BOUNDS/_HIGHLIGHT/_TABS). */
    readonly bounds?: boolean
    readonly highlight?: boolean
    readonly tabs?: boolean
    /** S1 strengthen — default-OFF gate (QUANTA_BROWSER_NETWORK). */
    readonly network?: boolean
  }
}

const EMPTY: BrowserToolset = { tools: [], dispose: async () => {} }

/** Build the browser tools + dispose when the slot is wired. */
export const buildBrowserBlock = (config: AgentConfig): BrowserToolset => {
  const slot = (config as AgentConfig & BrowserConfigSlot).browser
  if (slot?.port === undefined) return EMPTY
  return createBrowserToolset(slot.port, {
    ...(slot.resolver !== undefined ? { resolver: slot.resolver } : {}),
    ...(slot.bounds === true ? { bounds: true } : {}),
    ...(slot.highlight === true ? { highlight: true } : {}),
    ...(slot.tabs === true ? { tabs: true } : {}),
    ...(slot.network === true ? { network: true } : {}),
  })
}
