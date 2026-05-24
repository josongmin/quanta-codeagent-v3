/**
 * Built-in stderr sink (ADR-0144).
 *
 * Writes one human-readable line per sample to `process.stderr` for local
 * development. NOT suitable for production — every sample is a sync write and
 * the format is not machine-parseable. Use `jsonlMetricsSink` for replayable
 * recordings and a proper OTel adapter for production export.
 */

import type { MetricSample, MetricSink } from "./port"

const formatLabels = (labels: Readonly<Record<string, string>> | undefined): string => {
  if (labels === undefined) return ""
  const keys = Object.keys(labels)
  if (keys.length === 0) return ""
  const parts: string[] = []
  for (const k of keys.sort()) parts.push(`${k}:${labels[k] ?? ""}`)
  return ` labels={${parts.join(",")}}`
}

const formatSample = (s: MetricSample): string =>
  `[metric] name=${s.name} kind=${s.kind} val=${s.value}${formatLabels(s.labels)}`

export const consoleMetricsSink: MetricSink = {
  send(sample) {
    // Direct stderr write so test capture (Bun's `Bun.spawn` stderr stream)
    // sees the exact bytes. No-throw — a failed stderr write is non-fatal.
    try {
      process.stderr.write(`${formatSample(sample)}\n`)
    } catch {
      // Swallow — observability must not crash callers.
    }
  },
}
