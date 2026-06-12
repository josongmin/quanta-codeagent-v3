#!/usr/bin/env bun
/**
 * One-shot FC prose normalizer — stale context-binding.ts:LINE / 6-event bridge
 * citations → session-host-turn-event-bridge SSOT vocabulary (jun-11).
 *
 * Safe to re-run: idempotent replacements only.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const FC_DIR = join(ROOT, "tools/feature-catalog/features")

const BRIDGE_DEFAULT =
  "session-host-turn-event-bridge.ts default arm (outside 7-tag AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES)"

/** @type {Array<[RegExp, string]>} */
const REPLACEMENTS = [
  [/6-event web bridge/g, "7-tag session-host-turn-event bridge"],
  [/6-event context-binding bridge/g, "7-tag session-host-turn-event-bridge"],
  [/6-event bridge/g, "7-tag session-host-turn-event bridge"],
  [/the 6 bridged events/g, "the 7-tag bridged AgentEvent types"],
  [/not one of the 6 bridged events/g, "not in AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES"],
  [/not in the 6-event bridge/g, "not in the 7-tag session-host-turn-event bridge"],
  [/no stop\/decision event in the 6-event bridge/g, "no stop/decision event in the 7-tag bridge"],
  [
    /context-binding\.ts:1079-1096/g,
    "session-host-turn-event-bridge.ts (tool_call/tool_result → tool.invoked/tool.completed via context-binding)",
  ],
  [
    /context-binding\.ts:1086/g,
    "session-host-turn-event-bridge.ts tool_result arm (via context-binding)",
  ],
  [/context-binding\.ts:1104 default arm/g, BRIDGE_DEFAULT],
  [/context-binding\.ts:1105(?: default arm)?/g, BRIDGE_DEFAULT],
  [/context-binding\.ts:1104(?!\d)/g, BRIDGE_DEFAULT],
  [/context-binding\.ts:1061 default arm/g, BRIDGE_DEFAULT],
  [/context-binding\.ts:1052 default arm/g, BRIDGE_DEFAULT],
  [/context-binding\.ts:1061(?!\d)/g, BRIDGE_DEFAULT],
  [/default arm context-binding\.ts:1104/g, BRIDGE_DEFAULT],
  [
    /the only AgentEvent→web bridge context-binding\.ts:1061 default arm/g,
    "the AgentEvent→web bridge default arm (7-tag whitelist in session-host-turn-event-bridge.ts only)",
  ],
  [
    /context-binding\.ts:1052-1106/g,
    "session-host-turn-event-bridge.ts (outside 7-tag whitelist)",
  ],
  [/context-binding\.ts:1052(?!\d)/g, BRIDGE_DEFAULT],
  [
    /context-binding\.ts:1052 toSessionHostTurnEvent/g,
    "session-host-turn-event-bridge.ts (toSessionHostTurnEvent default arm)",
  ],
  [
    /\(context-binding\.ts toSessionHostTurnEvent\)/g,
    "(session-host-turn-event-bridge.ts toSessionHostTurnEvent via context-binding)",
  ],
  [
    /extractTurnErrorMessage at context-binding\.ts:1049/g,
    "extractTurnErrorMessage in context-binding.ts",
  ],
  [/context-binding\.ts:1131/g, "context-binding preview clamp (tool.completed resultPreview head-only cap)"],
]

function walkYaml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkYaml(p, out)
    else if (name.endsWith(".yaml")) out.push(p)
  }
  return out
}

let touched = 0
for (const file of walkYaml(FC_DIR)) {
  const before = readFileSync(file, "utf8")
  let after = before
  for (const [re, sub] of REPLACEMENTS) {
    after = after.replace(re, sub)
  }
  if (after !== before) {
    writeFileSync(file, after)
    touched++
  }
}

console.log(`fix-fc-bridge-prose: updated ${touched} yaml file(s)`)
