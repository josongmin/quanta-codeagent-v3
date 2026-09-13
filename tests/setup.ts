// Preloaded by bun test (see bunfig.toml). Keep global test setup here.
import { afterEach, beforeEach } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// The LEAF, not the runner: the runner reaches `@/agent/loop` and from there
// `@/tool`, which put 284 files into this preload's runtime closure.
import { __setBranchRunAgentForTest } from "@/agent/branch-search-runner/run-agent-override"
// The leaf, not the `@/agent/lsp-bridge` barrel: the barrel reaches
// `diagnostics.ts` and from there all of `src/tool`.
import { __setLspAvailabilityOverrideForTest } from "@/agent/lsp-bridge/availability"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import { __resetSpanSink } from "@/observability/spans"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import { quantaHomeDirFrom } from "@/shared/quanta-home"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { setTerminalIo } from "@/shared/terminal-io"
import { decideBenchResultsDir } from "./_support/bench-results-fence"
import { decideQuantaHomeFence, scratchPrefixesFor } from "./_support/quanta-home-fence"

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
// per-test dir (see `tests/unit/apps/bench/canonical-report-envelope.test.ts`)
// and the `off`/`0` sentinels still win.
//
// aug-22 audit: this used to fill only an ABSENT value, which two ordinary
// states walked straight through — a BLANK value (not absent, and the resolver
// reads blank as absent ⇒ live corpus) and an operator shell that already
// exports the real corpus (read as "an explicit override, respect it"). So the
// rule cannot key on whether the variable is set; it keys on WHERE the value
// points. That decision is a pure function in `_support/bench-results-fence.ts`
// with its own hellgate — a fence living only inside a preload is a fence no
// test can drive.
//
// The reset is load-bearing, not defensive: ES imports run BEFORE this
// statement, so any module above that touched `runtimeConfig()` during its own
// initialisation has already frozen a config snapshot taken WITHOUT the
// redirect. Measured: without this line `tests/unit/bench-write-artifacts.test.ts`
// still deposited one artifact into the live corpus on every run.
// `quantaHomeDirFrom` (the DI twin), NOT `quantaHomePath`: the latter resolves
// through `runtimeConfig()`, which would CREATE and cache the frozen config
// snapshot here — at preload, before any test has arranged its environment. The
// injected-env twin answers the same question while touching no singleton.
const benchResultsFence = decideBenchResultsDir({
  configured: process.env.QUANTA_BENCH_RESULTS_DIR,
  liveSsotDir: join(quantaHomeDirFrom(process.env), "bench", "results"),
  fallbackDir: join(tmpdir(), "quanta-bench-test-results"),
})
if (benchResultsFence.action === "redirect") {
  process.env.QUANTA_BENCH_RESULTS_DIR = benchResultsFence.dir
  __resetRuntimeConfig()
}

// FENCE (sep-13): the Quanta home roots. Forty-nine test files wrote Quanta state into
// the HOME the test process started with — on a normal run, the developer's. The policy
// and the measurement live in `_support/quanta-home-fence.ts`; this applies it before any
// test runs. The scratch root is per process, created lazily by whatever writes into it,
// and removed at exit so a run leaves nothing in TMPDIR.
{
  const scratchRoot = join(tmpdir(), "quanta-test-home", String(process.pid))
  const fence = decideQuantaHomeFence({
    env: process.env,
    scratchRoot,
    scratchPrefixes: scratchPrefixesFor(tmpdir()),
  })
  for (const key of fence.unset) delete process.env[key]
  for (const [key, value] of Object.entries(fence.set)) process.env[key] = value
  if (fence.unset.length > 0 || Object.keys(fence.set).length > 0) __resetRuntimeConfig()
  process.on("exit", () => {
    try {
      rmSync(scratchRoot, { recursive: true, force: true })
    } catch {
      // Best effort at process exit; there is no later point to report from.
    }
  })
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
