// Preloaded by bun test (see bunfig.toml). Keep global test setup here.
import { afterEach, beforeEach } from "bun:test"
import { __setLspAvailabilityOverrideForTest } from "@/agent/lsp-bridge"
import { __resetSpanSink } from "@/observability"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import { __resetKnobOverrides, __resetRuntimeConfig, setTerminalIo } from "@/shared"

beforeEach(() => {
  setTerminalIo({
    stdout: (chunk) => {
      void process.stdout.write(chunk)
    },
    stderr: (chunk) => {
      void process.stderr.write(chunk)
    },
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
  })
})

// FORCING FUNCTION (audit): the span sink + the process-default metric sink are
// module-level globals. A test that wires either (e.g. installOtelSpanExportFromEnv)
// and forgets to reset would silently route EVERY later sink-less
// `defaultMetricsRegistry()` / `startSpan` in the run to a stale sink — a broad,
// hard-to-trace cross-file flake. Reset both after every test so the leak is
// structurally impossible, not just per-file convention.
afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
  // The runtime-config singleton reads process.env ONCE and freezes it (cached).
  // A test that mutates env (or a knob override), reads `runtimeConfig()`, then
  // restores env leaves the STALE frozen config cached for every later test in
  // the run — a broad, hard-to-trace cross-file flake (verify-select/bench/loop
  // suites that pass in isolation but fail in the full run). Clear the cache so
  // the next `runtimeConfig()` re-reads the then-current env/overrides; the leak
  // is structurally impossible, not a per-file convention.
  __resetRuntimeConfig()
  // Same hazard one layer down: the live knob-override store (`/config set`) is a
  // module-global keyed by a monotonic version that `runtimeConfig()` caches on.
  // A test that sets an override and forgets to clear it leaks the override (and
  // its version bump) into every later test's `runtimeConfig()` / knob read.
  __resetKnobOverrides()
  // LSP availability overrides are test-only process globals. Reset both the
  // override and its cache so an omitted local teardown cannot turn every later
  // real binary probe into a fabricated unavailable result.
  __setLspAvailabilityOverrideForTest(null)
})
