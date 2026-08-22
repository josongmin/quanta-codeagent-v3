// Preloaded by bun test (see bunfig.toml). Keep global test setup here.
import { afterEach, beforeEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __setBranchRunAgentForTest } from "@/agent/branch-search-runner"
import { __setLspAvailabilityOverrideForTest } from "@/agent/lsp-bridge"
import { __resetSpanSink } from "@/observability"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import { __resetKnobOverrides, __resetRuntimeConfig, setTerminalIo } from "@/shared"

// FORCING FUNCTION (aug-22 incident): `writeReport`/`writeArtifacts` fan out to
// `mirrorReportToSsot`, whose DEFAULT sink is the operator's LIVE
// `~/.quanta/bench/results` corpus — the same trove the leaderboard dashboard
// reads. Any test that writes a report therefore deposits synthetic runs into
// real benchmark data: one suite left 80 artifacts there (32 of them carrying
// `benchmarkSuite:"terminal-bench"`, i.e. fake Terminal-Bench runs in the
// leaderboard corpus), another added 4 per invocation, and an audit found 11
// test files on that path. Per-file `QUANTA_BENCH_RESULTS_DIR` discipline is a
// convention every new test must remember, so redirect the mirror ONCE here:
// the leak becomes structurally impossible instead of per-file convention.
//
// A temp DIR (not `off`) is deliberate — the mirror stays fully exercised, so
// tests that assert mirror behaviour still observe a real effect. An explicit
// operator/test-local override still wins: this only fills an ABSENT value, and
// a test that sets its own per-test dir (see
// `tests/unit/apps/bench/canonical-report-envelope.test.ts`) overrides it.
// The reset is load-bearing, not defensive: ES imports run BEFORE this
// statement, so any module above that touched `runtimeConfig()` during its own
// initialisation has already frozen a config snapshot taken WITHOUT the
// redirect. Measured: without this line `tests/unit/bench-write-artifacts.test.ts`
// still deposited one artifact into the live corpus on every run.
if (process.env.QUANTA_BENCH_RESULTS_DIR === undefined) {
  process.env.QUANTA_BENCH_RESULTS_DIR = join(tmpdir(), "quanta-bench-test-results")
  __resetRuntimeConfig()
}

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
  // Branch-search candidate execution is injectable only through its local
  // runner seam. Reset it here so a test cannot replace the real loop for a
  // later file in a reused Bun worker.
  __setBranchRunAgentForTest(null)
})
