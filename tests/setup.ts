// Preloaded by bun test (see bunfig.toml). Keep global test setup here.
import { afterEach, beforeEach } from "bun:test"
import { __resetSpanSink } from "@/observability"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import { setTerminalIo } from "@/shared"

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
})
