/**
 * ADR-0222 — hellgate for the OTel emit unification across 4 new slices.
 *
 * 12 cases sealing the contract:
 *
 *   HELL-OT-01: vocabulary registers the 6 canonical keys + canonical format.
 *   HELL-OT-02: each slice's `metric-port.ts` lives in the slice — and the
 *               slice never imports `@/observability` (AST-scanned).
 *   HELL-OT-03: each no-op metric is silent (zero side-effect, frozen).
 *   HELL-OT-04: each observability-backed adapter satisfies the slice port
 *               AND routes to the registry via `new-slice-instruments.ts`.
 *   HELL-OT-05: orphan-literal scan — only `vocabulary.ts` and the
 *               `new-slice-instruments.ts` helpers reference any of the
 *               6 new keys directly.
 *   HELL-OT-06: error-routing — `recordClassified` emits a counter with
 *               label `kind`.
 *   HELL-OT-07: error-routing — `recordAction` emits a counter with
 *               label `action`.
 *   HELL-OT-08: stream-timeout — `recordIdle` emits a histogram observation.
 *   HELL-OT-09: stream-timeout — `recordAction` emits a counter with
 *               label `action`.
 *   HELL-OT-10: shell-snapshot — `recordCapture` emits TWO histogram
 *               observations (duration_ms + bytes).
 *   HELL-OT-11: git-directives — `recordDirective` emits a counter with
 *               label `kind`.
 *   HELL-OT-12: instrument cache — once a metric name is recorded as a
 *               counter, observing it as a histogram throws
 *               `MetricsError("name-mismatch-kind")` (parity with the
 *               `otel-sink HELL-7` invariant).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { noopErrorRoutingMetric } from "@/agent/error-routing/no-op-metric"
import { noopGitDirectiveMetric } from "@/agent/git-directives/no-op-metric"
import { noopStreamTimeoutMetric } from "@/agent/stream-timeout/no-op-metric"
import {
  defaultMetricsRegistry,
  type MetricSample,
  type MetricSink,
  MetricsError,
} from "@/observability/metrics/index"
import {
  wireErrorRoutingMetric,
  wireGitDirectiveMetric,
  wireShellSnapshotMetric,
  wireStreamTimeoutMetric,
} from "@/observability/metrics/wire-new-slices"
import { ALL_ATTR_KEYS, ATTR_KEY_SET, QUANTA_ATTRS } from "@/observability/vocabulary"
import { noopShellSnapshotMetric } from "@/runtime/shell-snapshot/no-op-metric"

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const sinkOf = (): { sink: MetricSink; samples: MetricSample[] } => {
  const samples: MetricSample[] = []
  const sink: MetricSink = {
    send(s) {
      samples.push(s)
    },
  }
  return { sink, samples }
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

const readSliceFiles = (sliceRelDir: string): Array<{ path: string; text: string }> => {
  const dir = join(SRC_ROOT, sliceRelDir)
  const out: Array<{ path: string; text: string }> = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isFile() && name.endsWith(".ts")) {
      out.push({ path: full, text: readFileSync(full, "utf8") })
    }
  }
  return out
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const importsObservability = (text: string): boolean => {
  const stripped = stripComments(text)
  // Match runtime imports of `@/observability` (not `import type` which is
  // erased at compile time and creates no runtime coupling).
  const re = /^\s*import\s+(?!type\b)[^\n;]*?from\s+["']@\/observability(?:\/[^"']*)?["']/gm
  return re.test(stripped)
}

const SIX_KEYS = [
  "quanta.error.kind",
  "quanta.error.action",
  "quanta.stream.idle_ms",
  "quanta.stream.timeout_action",
  "quanta.shell.snapshot_duration_ms",
  "quanta.shell.snapshot_bytes",
  "quanta.git.directive",
] as const

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-01  vocabulary registration
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-01 — vocabulary registers 6 new canonical keys", () => {
  test("all 6 keys present in ATTR_KEY_SET", () => {
    for (const k of SIX_KEYS) {
      expect(ATTR_KEY_SET.has(k)).toBe(true)
    }
  })

  test("keys exposed via QUANTA_ATTRS sub-tree", () => {
    expect(QUANTA_ATTRS.error.kind).toBe("quanta.error.kind")
    expect(QUANTA_ATTRS.error.action).toBe("quanta.error.action")
    expect(QUANTA_ATTRS.stream.idleMs).toBe("quanta.stream.idle_ms")
    expect(QUANTA_ATTRS.stream.timeoutAction).toBe("quanta.stream.timeout_action")
    expect(QUANTA_ATTRS.shell.snapshotDurationMs).toBe("quanta.shell.snapshot_duration_ms")
    expect(QUANTA_ATTRS.shell.snapshotBytes).toBe("quanta.shell.snapshot_bytes")
    expect(QUANTA_ATTRS.git.directive).toBe("quanta.git.directive")
  })

  test("every new key matches the canonical quanta.* format", () => {
    const re = /^quanta\.[a-z_]+(\.[a-z0-9_]+)+$/
    for (const k of SIX_KEYS) {
      expect(re.test(k)).toBe(true)
    }
  })

  test("each key appears exactly once in ALL_ATTR_KEYS (no aliasing)", () => {
    for (const k of SIX_KEYS) {
      expect(ALL_ATTR_KEYS.filter((x) => x === k).length).toBe(1)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-02  slice-fence preservation
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-02 — narrow ports live in their slice and never import @/observability", () => {
  const SLICES: ReadonlyArray<string> = [
    "agent/error-routing",
    "agent/git-directives",
    "agent/stream-timeout",
    "runtime/shell-snapshot",
  ]

  for (const slice of SLICES) {
    test(`metric-port.ts + no-op-metric.ts exist under src/${slice}/`, () => {
      const portStat = statSync(join(SRC_ROOT, slice, "metric-port.ts"))
      const noopStat = statSync(join(SRC_ROOT, slice, "no-op-metric.ts"))
      expect(portStat.isFile()).toBe(true)
      expect(noopStat.isFile()).toBe(true)
    })

    test(`no file under src/${slice}/ runtime-imports @/observability`, () => {
      const offenders: string[] = []
      for (const { path, text } of readSliceFiles(slice)) {
        if (importsObservability(text)) offenders.push(path)
      }
      if (offenders.length > 0) {
        throw new Error(
          `slice src/${slice} runtime-imports @/observability:\n${offenders.join("\n")}`,
        )
      }
      expect(offenders.length).toBe(0)
    })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-03  no-op silence + frozen
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-03 — every no-op metric is silent and frozen", () => {
  test("noopErrorRoutingMetric is frozen and side-effect free", () => {
    expect(Object.isFrozen(noopErrorRoutingMetric)).toBe(true)
    // Side-effect free: invoking both methods does not throw and does not
    // touch any spy-observable surface. The call returns void.
    expect(noopErrorRoutingMetric.recordClassified("internalServerError")).toBeUndefined()
    expect(noopErrorRoutingMetric.recordAction("retry-with-backoff")).toBeUndefined()
  })

  test("noopGitDirectiveMetric is frozen and silent", () => {
    expect(Object.isFrozen(noopGitDirectiveMetric)).toBe(true)
    expect(noopGitDirectiveMetric.recordDirective("commit")).toBeUndefined()
  })

  test("noopStreamTimeoutMetric is frozen and silent", () => {
    expect(Object.isFrozen(noopStreamTimeoutMetric)).toBe(true)
    expect(noopStreamTimeoutMetric.recordIdle(123)).toBeUndefined()
    expect(noopStreamTimeoutMetric.recordAction("abort")).toBeUndefined()
  })

  test("noopShellSnapshotMetric is frozen and silent", () => {
    expect(Object.isFrozen(noopShellSnapshotMetric)).toBe(true)
    expect(noopShellSnapshotMetric.recordCapture(42, 1024)).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-04  adapter satisfies port + routes to registry
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-04 — adapter factories return objects implementing the slice port", () => {
  test("wireErrorRoutingMetric returns a port impl that records via the registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    const port = wireErrorRoutingMetric(r)
    port.recordClassified("contextWindowExceeded")
    port.recordAction("retry-same-turn")
    expect(samples.length).toBe(2)
  })

  test("wireStreamTimeoutMetric returns a port impl that records via the registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    const port = wireStreamTimeoutMetric(r)
    port.recordIdle(50)
    port.recordAction("abort")
    expect(samples.length).toBe(2)
  })

  test("wireShellSnapshotMetric returns a port impl that records via the registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    const port = wireShellSnapshotMetric(r)
    port.recordCapture(25, 4096)
    expect(samples.length).toBe(2)
  })

  test("wireGitDirectiveMetric returns a port impl that records via the registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    const port = wireGitDirectiveMetric(r)
    port.recordDirective("create-branch")
    expect(samples.length).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-05  orphan literal scan — only authorised files name the 6 keys
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-05 — only vocabulary.ts + new-slice-instruments.ts reference the 6 keys", () => {
  const AUTHORISED = new Set<string>([
    join(SRC_ROOT, "observability", "vocabulary.ts"),
    join(SRC_ROOT, "observability", "metrics", "new-slice-instruments.ts"),
  ])

  const walkSrc = (root: string, out: string[]): void => {
    for (const name of readdirSync(root)) {
      if (name === "node_modules" || name === "dist") continue
      const full = join(root, name)
      const st = statSync(full)
      if (st.isDirectory()) walkSrc(full, out)
      else if (st.isFile() && full.endsWith(".ts")) out.push(full)
    }
  }

  test("no other src/ file contains a raw literal for any of the 6 keys", () => {
    const all: string[] = []
    walkSrc(SRC_ROOT, all)
    const offenders: Array<{ file: string; key: string }> = []
    for (const f of all) {
      if (AUTHORISED.has(f)) continue
      const text = readFileSync(f, "utf8")
      for (const key of SIX_KEYS) {
        if (text.includes(`"${key}"`)) offenders.push({ file: f, key })
      }
    }
    if (offenders.length > 0) {
      const report = offenders.map((o) => `  ${o.file}: "${o.key}"`).join("\n")
      throw new Error(`orphan literal for ADR-0222 key:\n${report}`)
    }
    expect(offenders.length).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-06  error-routing recordClassified
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-06 — error-routing recordClassified emits a counter with label kind", () => {
  test("emits one counter sample with the correct name + label", () => {
    const { sink, samples } = sinkOf()
    const port = wireErrorRoutingMetric(defaultMetricsRegistry({ sink }))
    port.recordClassified("usageLimitExceeded")
    expect(samples.length).toBe(1)
    const [s] = samples
    expect(s?.name).toBe(QUANTA_ATTRS.error.kind)
    expect(s?.kind).toBe("counter")
    expect(s?.value).toBe(1)
    expect(s?.labels?.kind).toBe("usageLimitExceeded")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-07  error-routing recordAction
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-07 — error-routing recordAction emits a counter with label action", () => {
  test("emits one counter sample with the correct name + label", () => {
    const { sink, samples } = sinkOf()
    const port = wireErrorRoutingMetric(defaultMetricsRegistry({ sink }))
    port.recordAction("swap-fallback")
    expect(samples.length).toBe(1)
    const [s] = samples
    expect(s?.name).toBe(QUANTA_ATTRS.error.action)
    expect(s?.kind).toBe("counter")
    expect(s?.value).toBe(1)
    expect(s?.labels?.action).toBe("swap-fallback")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-08  stream-timeout recordIdle
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-08 — stream-timeout recordIdle emits a histogram observation", () => {
  test("emits one histogram sample on the canonical idle_ms key", () => {
    const { sink, samples } = sinkOf()
    const port = wireStreamTimeoutMetric(defaultMetricsRegistry({ sink }))
    port.recordIdle(75)
    expect(samples.length).toBe(1)
    const [s] = samples
    expect(s?.name).toBe(QUANTA_ATTRS.stream.idleMs)
    expect(s?.kind).toBe("histogram")
    expect(s?.value).toBe(75)
  })

  test("non-finite / negative idle ms are coerced to 0", () => {
    const { sink, samples } = sinkOf()
    const port = wireStreamTimeoutMetric(defaultMetricsRegistry({ sink }))
    port.recordIdle(Number.NaN)
    port.recordIdle(-1)
    expect(samples.length).toBe(2)
    expect(samples[0]?.value).toBe(0)
    expect(samples[1]?.value).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-09  stream-timeout recordAction
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-09 — stream-timeout recordAction emits a counter with label action", () => {
  test("emits one counter sample with the correct name + label", () => {
    const { sink, samples } = sinkOf()
    const port = wireStreamTimeoutMetric(defaultMetricsRegistry({ sink }))
    port.recordAction("degrade")
    expect(samples.length).toBe(1)
    const [s] = samples
    expect(s?.name).toBe(QUANTA_ATTRS.stream.timeoutAction)
    expect(s?.kind).toBe("counter")
    expect(s?.labels?.action).toBe("degrade")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-10  shell-snapshot recordCapture
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-10 — shell-snapshot recordCapture emits two histogram observations", () => {
  test("emits exactly two histogram samples on the canonical keys", () => {
    const { sink, samples } = sinkOf()
    const port = wireShellSnapshotMetric(defaultMetricsRegistry({ sink }))
    port.recordCapture(30, 2048)
    expect(samples.length).toBe(2)
    const byName = new Map(samples.map((s) => [s.name, s]))
    const dur = byName.get(QUANTA_ATTRS.shell.snapshotDurationMs)
    const bytes = byName.get(QUANTA_ATTRS.shell.snapshotBytes)
    expect(dur?.kind).toBe("histogram")
    expect(dur?.value).toBe(30)
    expect(bytes?.kind).toBe("histogram")
    expect(bytes?.value).toBe(2048)
  })

  test("non-finite / negative values coerce to 0 (both axes)", () => {
    const { sink, samples } = sinkOf()
    const port = wireShellSnapshotMetric(defaultMetricsRegistry({ sink }))
    port.recordCapture(Number.NaN, -7)
    expect(samples.length).toBe(2)
    for (const s of samples) expect(s.value).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-11  git-directives recordDirective
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-11 — git-directives recordDirective emits a counter with label kind", () => {
  test("emits one counter sample with the correct name + label", () => {
    const { sink, samples } = sinkOf()
    const port = wireGitDirectiveMetric(defaultMetricsRegistry({ sink }))
    port.recordDirective("push")
    expect(samples.length).toBe(1)
    const [s] = samples
    expect(s?.name).toBe(QUANTA_ATTRS.git.directive)
    expect(s?.kind).toBe("counter")
    expect(s?.value).toBe(1)
    expect(s?.labels?.kind).toBe("push")
  })

  test("each of the 5 GitDirectiveKind values keys into its own time-series", () => {
    const { sink, samples } = sinkOf()
    const port = wireGitDirectiveMetric(defaultMetricsRegistry({ sink }))
    for (const k of ["create-branch", "stage", "commit", "push", "create-pr"] as const) {
      port.recordDirective(k)
    }
    expect(samples.length).toBe(5)
    const seen = new Set(samples.map((s) => s.labels?.kind))
    expect(seen.size).toBe(5)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HELL-OT-12  instrument cache locks kind per metric name
// ────────────────────────────────────────────────────────────────────────────

describe("HELL-OT-12 — metric name commits to kind (counter vs histogram lock)", () => {
  test("counter then histogram on same name throws MetricsError('name-mismatch-kind')", () => {
    const r = defaultMetricsRegistry()
    // Re-use one of the new canonical keys to prove the lock applies here too.
    r.increment(QUANTA_ATTRS.error.kind, 1, { kind: "internalServerError" })
    expect(() => r.observe(QUANTA_ATTRS.error.kind, 5)).toThrow(MetricsError)
  })

  test("histogram then counter on same name throws MetricsError('name-mismatch-kind')", () => {
    const r = defaultMetricsRegistry()
    r.observe(QUANTA_ATTRS.stream.idleMs, 10)
    expect(() => r.increment(QUANTA_ATTRS.stream.idleMs, 1)).toThrow(MetricsError)
  })
})
