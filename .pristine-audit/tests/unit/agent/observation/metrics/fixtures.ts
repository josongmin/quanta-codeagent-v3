/**
 * Synthetic trajectory fixtures for the S4 usage/overtrust metrics tests.
 * Kept separate so each test constructs event arrays declaratively and so the
 * vacuity/red-on-injection tests can permute read/edit/verify order cheaply.
 */

import type { ObservationBundle, OwnerHint } from "@/agent/observation/fragment"
import type { MetricEvent } from "@/agent/observation/metrics"

let seq = 0
export const resetSeq = (): void => {
  seq = 0
}

export const call = (name: string, input: Record<string, unknown>): MetricEvent => ({
  kind: "tool_call",
  seq: seq++,
  data: { id: `c${seq}`, name, input },
})

export const read = (path: string): MetricEvent => call("read", { path })
export const edit = (path: string): MetricEvent => call("edit", { path })
export const write = (path: string): MetricEvent => call("write", { path })
export const scriptedReplace = (file: string): MetricEvent => call("scripted_replace", { file })
export const lspDef = (path: string): MetricEvent => call("lsp_definition", { path })
export const bash = (command: string): MetricEvent => call("bash", { command })
export const testRunner = (): MetricEvent => call("test_runner", {})
export const assistantText = (delta: string): MetricEvent => ({
  kind: "assistant_text",
  seq: seq++,
  data: { delta },
})

export const owner = (file: string, extra: Partial<OwnerHint> = {}): OwnerHint => ({
  file,
  evidence: extra.evidence ?? "def-use edge",
  source: extra.source ?? "static-owner",
  ...(extra.symbol !== undefined ? { symbol: extra.symbol } : {}),
  ...(extra.strength !== undefined ? { strength: extra.strength } : {}),
})

export const bundle = (owners: readonly OwnerHint[]): ObservationBundle => ({
  owners,
  contributors: owners.length > 0 ? ["static-owner"] : [],
})

export const emptyBundle = (): ObservationBundle => ({ owners: [], contributors: [] })
