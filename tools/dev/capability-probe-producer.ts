/**
 * CAPABILITY PROBE PRODUCER (TVH-11) — the ONLY place that may spawn to answer
 * "can this host do X?".
 *
 * Runs ONCE per tier, before any test module is loaded, and writes an immutable
 * `capability-receipt.v1`. Test modules read that file (see
 * `capability-receipt-consumer.ts`) and never probe.
 *
 * ## What the old per-file probes got wrong, and what replaces it
 *
 * SERIAL CANDIDATE SEARCH. `lance-real-wire.test.ts` walked four Python
 * candidates at 5,000ms each, one after another, so an absent lancedb cost 20
 * SECONDS OF DISCOVERY. Candidates here start TOGETHER and the capability is
 * decided by PRIORITY once they settle, so the wall cost is one candidate's
 * timeout, not their sum, and the answer is still "the most-preferred
 * interpreter that works" rather than "whichever finished first".
 *
 * UNCANCELLED TIMERS. The old probes wrote
 * `Promise.race([proc.exited, new Promise(r => setTimeout(r, 5000))])` and never
 * cleared the timer on the winning path — every probe left a live 5s timer
 * behind, which keeps the loop alive and defers process exit. Every timer here
 * is created by `withDeadline`, which clears it in `finally` on BOTH paths.
 *
 * UNDRAINED LOSERS. A killed child that is never awaited is a zombie for the
 * rest of the run. Losers are killed AND drained, with the drain itself bounded.
 *
 * NO TOTAL BOUND. Nothing stopped a wedged host from stalling the whole suite.
 * There is one total deadline for the producer; when it fires, every
 * still-running capability is recorded `probe-timeout` (a VALUE, distinct from
 * `unavailable`) and every child is killed and drained.
 *
 * ## Accounting
 *
 * `probeLedger()` reports processes started, processes confirmed exited, and
 * timers created vs cleared. The adversarial test asserts survivors === 0 and
 * timers outstanding === 0 against a hung fake on a fake PATH — an invariant a
 * comment cannot carry.
 */

import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_VERDICTS_ENV,
  type CapabilityBinding,
  type CapabilityFinding,
  type CapabilityReceipt,
  type CapabilityStatus,
  DEFAULT_CAPABILITY_RECEIPT_TTL_MS,
  mintCapabilityReceipt,
} from "./capability-receipt"
import { externalToolchainFingerprint } from "./external-toolchain"

// ── ledger (observability the invariants are asserted against) ──────────────

interface ProbeLedger {
  processesStarted: number
  processesExited: number
  timersCreated: number
  timersCleared: number
}

const ledger: ProbeLedger = {
  processesStarted: 0,
  processesExited: 0,
  timersCreated: 0,
  timersCleared: 0,
}

export const probeLedger = (): Readonly<ProbeLedger> => ({ ...ledger })
export const resetProbeLedger = (): void => {
  ledger.processesStarted = 0
  ledger.processesExited = 0
  ledger.timersCreated = 0
  ledger.timersCleared = 0
}

/**
 * A bounded await whose timer is ALWAYS cleared — on the win path and the
 * timeout path alike. The un-cleared variant of exactly this expression is what
 * the old probes shipped, five of them, once per candidate.
 */
const withDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<{ value: T; timedOut: boolean }> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMED_OUT = Symbol("timed-out")
  ledger.timersCreated += 1
  try {
    const raced = await Promise.race<T | typeof TIMED_OUT>([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
    return raced === TIMED_OUT
      ? { value: onTimeout(), timedOut: true }
      : { value: raced, timedOut: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    ledger.timersCleared += 1
  }
}

// ── candidate execution ─────────────────────────────────────────────────────

export interface CandidateSpec {
  readonly label: string
  readonly argv: readonly string[]
  /**
   * Some binaries exit non-zero for `--version` yet prove they resolve and run.
   * Default: exit code 0.
   */
  readonly acceptExit?: (exitCode: number) => boolean
  /** For probes whose ANSWER is on stdout (`xcrun -f lldb-dap` prints a path). */
  readonly resolveFromStdout?: boolean
}

export interface CapabilitySpec {
  readonly id: string
  readonly description: string
  /** Priority order: the earliest successful candidate wins, not the fastest. */
  readonly candidates: readonly CandidateSpec[]
  readonly perCandidateTimeoutMs: number
}

interface CandidateOutcome {
  readonly label: string
  readonly ok: boolean
  readonly detail: string
  readonly resolved?: string
  readonly timedOut: boolean
  /**
   * The spawn itself threw — ENOENT, EACCES, a vanished interpreter.
   *
   * Distinct from `timedOut` and from a non-zero exit, and it was collapsed into
   * neither: `runCandidate` caught the throw, returned `timedOut: false`, and
   * `probeCapability` then reported `unavailable`. "We could not run the probe"
   * became "this host does not have the tool", which is the same laundering as
   * `probe-timeout` into absence, one layer down.
   */
  readonly threw?: boolean
}

export interface SpawnedProbe {
  readonly exited: Promise<number>
  readonly stdout: Promise<string>
  kill(): void
}

export type ProbeSpawner = (argv: readonly string[], env: Record<string, string>) => SpawnedProbe

const bunSpawner: ProbeSpawner = (argv, env) => {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    env,
  })
  return {
    exited: proc.exited,
    stdout: new Response(proc.stdout).text(),
    kill: () => {
      try {
        proc.kill()
      } catch {
        // already exited — killing twice is not an error here
      }
    },
  }
}

/** Bounded drain: a killed child that is never awaited stays a zombie. */
const killAndDrain = async (probe: SpawnedProbe): Promise<void> => {
  probe.kill()
  const drained = await withDeadline(
    probe.exited.then(() => true),
    2_000,
    () => false,
  )
  if (drained.value) ledger.processesExited += 1
}

const runCandidate = async (
  candidate: CandidateSpec,
  timeoutMs: number,
  spawn: ProbeSpawner,
  env: Record<string, string>,
): Promise<{ outcome: CandidateOutcome; probe: SpawnedProbe | null }> => {
  let probe: SpawnedProbe
  try {
    probe = spawn(candidate.argv, env)
    ledger.processesStarted += 1
  } catch (error) {
    // ENOENT IS ABSENCE. `Bun.spawn` throws synchronously for a binary that is
    // not there, so "this host does not have the tool" arrives as a throw. The
    // commit that introduced `threw` classified every throw as `probe-error`,
    // and an audit measured the regression on this host: `ast-grep`, which is
    // simply not installed, went from `unavailable` to `probe-error` →
    // `failed-setup`, and a Linux-shaped host with no Homebrew python3.11 turned
    // `debugpy` the same way while `python3` had definitively said no. Under the
    // strictness switch that is a red for a tool that is correctly absent.
    //
    // Only a throw that is NOT "no such file" means the probe could not run —
    // EACCES, EMFILE, a spawn implementation failure.
    const code = (error as { readonly code?: unknown }).code
    const absent = code === "ENOENT"
    return {
      outcome: {
        label: candidate.label,
        ok: false,
        detail: absent ? `not found (ENOENT): ${String(error)}` : `spawn threw: ${String(error)}`,
        timedOut: false,
        threw: !absent,
      },
      probe: null,
    }
  }
  const SENTINEL = -1
  const exit = await withDeadline(probe.exited, timeoutMs, () => SENTINEL)
  if (exit.timedOut) {
    return {
      outcome: {
        label: candidate.label,
        ok: false,
        detail: `did not answer within ${timeoutMs}ms`,
        timedOut: true,
      },
      probe,
    }
  }
  ledger.processesExited += 1
  const accept = candidate.acceptExit ?? ((code: number) => code === 0)
  const ok = accept(exit.value)
  let resolved: string | undefined
  if (ok && candidate.resolveFromStdout === true) {
    const out = await withDeadline(probe.stdout, 1_000, () => "")
    const trimmed = out.value.trim()
    resolved = trimmed.length > 0 ? trimmed : undefined
    if (resolved === undefined) {
      return {
        outcome: {
          label: candidate.label,
          ok: false,
          detail: "succeeded but printed no path",
          timedOut: false,
        },
        probe,
      }
    }
  }
  const winner = resolved ?? (ok ? candidate.argv[0] : undefined)
  return {
    outcome: {
      label: candidate.label,
      ok,
      detail: ok ? `exit ${exit.value}` : `exit ${exit.value} (rejected)`,
      ...(winner === undefined ? {} : { resolved: winner }),
      timedOut: false,
    },
    probe,
  }
}

/**
 * All candidates start TOGETHER; the winner is the earliest in PRIORITY order
 * that succeeded. Wall cost is one candidate's timeout instead of their sum,
 * and preference order is still honoured.
 */
export const probeCapability = async (
  spec: CapabilitySpec,
  spawn: ProbeSpawner = bunSpawner,
  env: Record<string, string> = process.env as Record<string, string>,
): Promise<CapabilityFinding> => {
  const startedAt = Date.now()
  const settled = await Promise.all(
    spec.candidates.map((candidate) =>
      runCandidate(candidate, spec.perCandidateTimeoutMs, spawn, env),
    ),
  )
  await Promise.all(
    settled
      .filter((s) => s.probe !== null && s.outcome.timedOut)
      .map((s) => killAndDrain(s.probe as SpawnedProbe)),
  )
  const probeMs = Date.now() - startedAt
  const winner = settled.find((s) => s.outcome.ok)
  if (winner !== undefined) {
    return {
      status: "available",
      detail: `${winner.outcome.label}: ${winner.outcome.detail}`,
      ...(winner.outcome.resolved === undefined ? {} : { resolved: winner.outcome.resolved }),
      probeMs,
    }
  }
  // Three failure kinds, most-specific first. A throw means the probe never ran;
  // a timeout means it ran and did not answer; anything else is a definitive
  // negative, which is the only one that means "this host lacks it".
  const status: CapabilityStatus = settled.some((s) => s.outcome.threw === true)
    ? "probe-error"
    : settled.some((s) => s.outcome.timedOut)
      ? "probe-timeout"
      : "unavailable"
  return {
    status,
    detail:
      settled.map((s) => `${s.outcome.label}: ${s.outcome.detail}`).join("; ") || "no candidates",
    probeMs,
  }
}

// ── the capability catalogue ────────────────────────────────────────────────
//
// IDS ARE THE MANIFEST'S `needs[].id`, NOT A PRIVATE NAMESPACE.
//
// `tools/dev/test-capability-manifest.ts` (TVH-03) declares capability GROUPS
// whose `needs` are exactly these ids — `typescript-language-server`,
// `pyright-langserver`, `python3`, `debugpy`, `lldb-dap`, `cargo`, `go`. Its
// `contract-lsp-lance` group says, verbatim, that it exists "so the probe
// happens ONCE per job and the files consume its receipt": this producer is
// that probe and `capability-receipt-consumer.ts` is that consumption. Sharing
// the id space is what makes the two halves composable instead of parallel.
//
// `tests/unit/_arch/module-load-effect-guard.test.ts` holds the drift guard in
// BOTH directions: every `capability("<id>")` call in the corpus must name a
// catalogue entry, and every catalogue entry must be consumed by at least one
// file. A typo, a rename or a dead capability is red, not silent.

const PYTHON_CANDIDATES = (env: Record<string, string>): readonly string[] =>
  [
    env.QUANTA_LANCE_PYTHON,
    "/opt/homebrew/opt/python@3.11/Frameworks/Python.framework/Versions/3.11/bin/python3.11",
    "python3",
    "python",
  ].filter((v): v is string => v !== undefined && v !== "")

/** `--version` resolves-and-runs proof: a non-zero exit still proves the binary works. */
const RESOLVES_AND_RUNS = (): boolean => true

export const capabilityCatalogue = (
  env: Record<string, string> = process.env as Record<string, string>,
): readonly CapabilitySpec[] => [
  {
    // Deliberately PATH-only, and deliberately NOT the lancedb candidate list:
    // the tests that gate on this shell out to a bare `python3`, so a capability
    // satisfied by an interpreter those tests cannot reach would be a lie.
    id: "python3",
    description: "python3 on PATH",
    candidates: [
      { label: "python3", argv: ["python3", "--version"] },
      { label: "python", argv: ["python", "--version"] },
    ],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "lancedb",
    description: "a python interpreter that can `import lancedb`",
    candidates: PYTHON_CANDIDATES(env).map((cmd) => ({
      label: cmd,
      argv: [cmd, "-c", "import lancedb"],
    })),
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "debugpy",
    description: "a python interpreter that can `import debugpy`",
    candidates: PYTHON_CANDIDATES(env).map((cmd) => ({
      label: cmd,
      argv: [cmd, "-c", "import debugpy"],
    })),
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "typescript-language-server",
    description: "typescript-language-server on PATH",
    candidates: [
      {
        label: "typescript-language-server",
        argv: ["typescript-language-server", "--version"],
        acceptExit: RESOLVES_AND_RUNS,
      },
    ],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "pyright-langserver",
    description: "pyright-langserver on PATH",
    candidates: [
      {
        label: "pyright-langserver",
        argv: ["pyright-langserver", "--version"],
        acceptExit: RESOLVES_AND_RUNS,
      },
    ],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "ast-grep",
    description: "the ast-grep binary",
    candidates: [{ label: "ast-grep", argv: ["ast-grep", "--version"] }],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "git",
    description: "git",
    candidates: [{ label: "git", argv: ["git", "--version"] }],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "clang",
    description: "a C compiler for the lldb-dap battery",
    candidates: [{ label: "clang", argv: ["clang", "--version"] }],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "cargo",
    description: "the Rust toolchain driver",
    candidates: [{ label: "cargo", argv: ["cargo", "--version"] }],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "node",
    description: "node, for the CDP debug carrier",
    candidates: [{ label: "node", argv: ["node", "--version"] }],
    perCandidateTimeoutMs: 5_000,
  },
  {
    id: "lldb-dap",
    description: "the lldb-dap adapter (Xcode path preferred, then PATH)",
    candidates: [
      { label: "xcrun -f lldb-dap", argv: ["xcrun", "-f", "lldb-dap"], resolveFromStdout: true },
      { label: "lldb-dap --help", argv: ["lldb-dap", "--help"] },
    ],
    perCandidateTimeoutMs: 5_000,
  },
]

/** Chrome is not a `<binary> --version` question — see `probeChromeBringUp`. */
export const CHROME_CAPABILITY_ID = "chrome-cdp"

/**
 * Every capability id a CAMPAIGN receipt will carry.
 *
 * The drift guard — "every capability the corpus ASKS for is one the producer
 * PROBES" — built its `known` set as `capabilityCatalogue(...).ids` plus a
 * hardcoded `CHROME_CAPABILITY_ID`. That hardcode was the whole reason the guard
 * stayed green while chrome was in no receipt any production path could mint:
 * the guard's own docstring says an unprobed id "returns blocked-missing, which
 * is a VISIBLE SKIP, so the suite stays green and the cases quietly stop
 * running", and that was chrome's live state.
 *
 * One list, read by the producer and by the guard, so an id can only be
 * "expected" while something actually produces it.
 */
export const campaignCapabilityIds = (
  env: Record<string, string> = process.env as Record<string, string>,
): readonly string[] => [...capabilityCatalogue(env).map((spec) => spec.id), CHROME_CAPABILITY_ID]

/**
 * A REAL CDP bring-up, because presence is not usability: `availability()`
 * only proves the binary exists, and the sandboxed-CI failure this replaces was
 * a Chrome that was present and could not come up. Done ONCE here instead of
 * once per browser test file.
 */
export const probeChromeBringUp = async (
  profileRoot: string,
  timeoutMs: number,
): Promise<CapabilityFinding> => {
  const startedAt = Date.now()
  const browser = await import("@/browser")
  const port = browser.createCdpBrowser({
    spawner: browser.defaultProcessSpawner,
    transport: browser.defaultCdpTransport,
    fs: browser.defaultBrowserFs,
    scheduler: browser.realScheduler,
    clock: browser.realClock,
    profileRoot,
    endpointTimeoutMs: Math.min(timeoutMs, 15_000),
    commandTimeoutMs: Math.min(timeoutMs, 30_000),
  })
  // `resolved` carries what `availability()` answers — a browser NAME such as
  // "chromium", not a binary path — on every branch where one was found,
  // including the failing ones. "no chrome" and "chrome that will not come up"
  // are different facts, and the browser suites assert on the difference
  // (chrome present + not usable is a regression, not an absence).
  const binary = port.availability()
  if (binary === null) {
    return {
      status: "unavailable",
      detail: "no chrome binary found",
      probeMs: Date.now() - startedAt,
    }
  }
  // ABORTED on timeout, and a success that lands AFTER the race is closed. The
  // race used to pass no signal, so a bring-up that finished late left a live
  // Chrome for the rest of the runner's life.
  const abort = new AbortController()
  const pending = port.spawn({ signal: abort.signal })
  const spawned = await withDeadline(pending, timeoutMs, () => null)
  if (spawned.timedOut || spawned.value === null) {
    abort.abort()
    void pending.then(
      (late) => (late.ok ? port.close(late.value) : undefined),
      () => undefined,
    )
    return {
      status: "probe-timeout",
      detail: `chrome bring-up did not finish within ${timeoutMs}ms`,
      resolved: binary,
      probeMs: Date.now() - startedAt,
    }
  }
  const result = spawned.value
  if (!result.ok) {
    return {
      status: "unavailable",
      detail: `chrome present but the CDP session would not come up: ${result.error.kind}`,
      resolved: binary,
      probeMs: Date.now() - startedAt,
    }
  }
  // The producer proves bring-up and then RELEASES it. A probe that leaves a
  // live Chrome behind is the double-spawn defect wearing a new hat.
  await withDeadline(
    port.close(result.value).then(() => true),
    10_000,
    () => false,
  )
  return {
    status: "available",
    detail: "CDP session established and closed",
    resolved: binary,
    probeMs: Date.now() - startedAt,
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

export const DEFAULT_TOTAL_DEADLINE_MS = 60_000

export interface ProduceOptions {
  readonly tier: string
  readonly binding: CapabilityBinding
  readonly totalDeadlineMs?: number
  readonly specs?: readonly CapabilitySpec[]
  readonly spawn?: ProbeSpawner
  /**
   * Probe chrome, with a profile root and an optional probe override — ONE field.
   *
   * These were three: `includeChrome`, `chromeProfileRoot`, `probeChrome`. Three
   * independent optionals encode states nobody means — "include, no root" was a
   * SILENT AND that dropped chrome from the receipt with no diagnostic, and the
   * patch for it was a runtime throw that an audit then showed could be
   * reintroduced as a different conjunct with every arm green. As one object,
   * "chrome without a root" cannot be written.
   */
  readonly chrome?: ChromeProbeOptions
  readonly env?: Record<string, string>
  readonly ttlMs?: number
}

/** The chrome bring-up, injectable: it drives the real browser port and ignores `spawn`. */
export type ChromeProbe = (profileRoot: string, timeoutMs: number) => Promise<CapabilityFinding>

export interface ChromeProbeOptions {
  readonly profileRoot: string
  readonly probe?: ChromeProbe
}

const timedOutFinding = (spec: CapabilitySpec, deadlineMs: number): CapabilityFinding => ({
  status: "probe-timeout",
  detail: `the producer's total deadline (${deadlineMs}ms) fired before "${spec.id}" answered`,
  probeMs: deadlineMs,
})

export const produceCapabilityReceipt = async (
  options: ProduceOptions,
): Promise<CapabilityReceipt> => {
  const deadlineMs = options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS
  const env = options.env ?? (process.env as Record<string, string>)
  const specs = options.specs ?? capabilityCatalogue(env)
  const capabilities: Record<string, CapabilityFinding> = {}

  // ONE total deadline over the WHOLE set, not one per capability: N bounded
  // probes still add up to an unbounded producer.
  const all = Promise.all(
    specs.map(async (spec) => {
      // ONE probe must not kill the producer. A rejected probe used to reject
      // the whole `Promise.all`, so a spawner that throws — an interpreter that
      // vanished between resolution and spawn, a permissions error — took the
      // campaign's entire receipt with it, and the workers then got no receipt
      // at all: every gated describe skipped, every file green.
      //
      // `probe-error` is also the one `CapabilityStatus` nothing ever produced.
      // It was declared, classified by the consumer as `failed-setup`, and
      // unreachable — a closed union with a dead arm, which is a classification
      // nobody can test. This is the shape that produces it.
      try {
        capabilities[spec.id] = await probeCapability(spec, options.spawn ?? bunSpawner, env)
      } catch (error) {
        capabilities[spec.id] = {
          status: "probe-error",
          detail: `the probe itself threw: ${error instanceof Error ? error.message : String(error)}`,
          probeMs: 0,
        }
      }
    }),
  ).then(() => true)
  // Chrome runs INSIDE the one total deadline, concurrently with the rest. It
  // used to run after the deadline had already been spent, with its own 45s
  // bring-up and 10s close on top — so the documented "ONE total deadline"
  // became ~115s, and every campaign on a host with Chrome paid it serially.
  const chrome = options.chrome
  const chromeDone =
    chrome === undefined
      ? Promise.resolve(true)
      : (async () => {
          try {
            capabilities[CHROME_CAPABILITY_ID] = await (chrome.probe ?? probeChromeBringUp)(
              chrome.profileRoot,
              Math.min(deadlineMs, 45_000),
            )
          } catch (error) {
            // Outside the per-probe catch, a throw here still took the whole
            // receipt with it.
            capabilities[CHROME_CAPABILITY_ID] = {
              status: "probe-error",
              detail: `the chrome probe itself threw: ${error instanceof Error ? error.message : String(error)}`,
              probeMs: 0,
            }
          }
          return true
        })()
  const finished = await withDeadline(
    Promise.all([all, chromeDone]).then(() => true),
    deadlineMs,
    () => false,
  )
  if (!finished.value) {
    for (const spec of specs) {
      if (capabilities[spec.id] === undefined)
        capabilities[spec.id] = timedOutFinding(spec, deadlineMs)
    }
    if (chrome !== undefined && capabilities[CHROME_CAPABILITY_ID] === undefined) {
      capabilities[CHROME_CAPABILITY_ID] = {
        status: "probe-timeout",
        detail: `the producer's total deadline (${deadlineMs}ms) fired before chrome answered`,
        probeMs: deadlineMs,
      }
    }
  }

  return mintCapabilityReceipt({
    binding: options.binding,
    tier: options.tier,
    capabilities,
    deadlineMs,
    ttlMs: options.ttlMs ?? DEFAULT_CAPABILITY_RECEIPT_TTL_MS,
  })
}

export const toolchainSha256 = (): string =>
  createHash("sha256").update(JSON.stringify(externalToolchainFingerprint())).digest("hex")

/**
 * Written atomically and then made READ-ONLY. "Immutable" that is only a
 * comment is a file anyone can edit mid-run; the mode makes the intent
 * enforceable and a partially-written receipt unobservable.
 */
export const writeCapabilityReceipt = (path: string, receipt: CapabilityReceipt): void => {
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(receipt, null, 2)}\n`)
  renameSync(staging, path)
  chmodSync(path, 0o444)
}

export const defaultCapabilityReceiptPath = (repoRoot: string, tier: string): string =>
  join(repoRoot, ".quanta-cache", "capability", `${tier}.capability-receipt.json`)

/**
 * The POLICY half of the binding: the capability ids this producer answers plus
 * the test-policy overrides in force. Adding a capability, renaming one, or
 * re-tiering a file all move this hash, so a receipt minted under the old
 * policy cannot decide runs under the new one.
 */
export const capabilityPolicySha256 = (
  repoRoot: string,
  specs: readonly CapabilitySpec[],
  readText: (path: string) => string,
): string => {
  const ids = [...specs.map((s) => s.id), CHROME_CAPABILITY_ID].sort().join(",")
  let overrides = "<absent>"
  try {
    overrides = readText(join(repoRoot, "tools", "dev", "test-policy-overrides.json"))
  } catch {
    // absent is a value, not a reason to bind to nothing
  }
  return createHash("sha256").update(`${ids}\n${overrides}`).digest("hex")
}

/**
 * The receipt a campaign's workers read, and the env that points them at it.
 *
 * # The defect this closes
 *
 * This module had FIFTEEN consumers and no producer. Nothing invoked its CLI —
 * not `package.json`, not `.github/workflows/`, not `gate-manifest.ts`, not the
 * shard runner — and nothing set `QUANTA_CAPABILITY_RECEIPT`. So every
 * `capability("<id>")` answered `blocked-missing`, `canExecute` turned that into
 * `describe.skip`, and the affected files reported PASS having executed nothing,
 * on every host, forever.
 *
 * MEASURED on this box, the same files with and without a receipt:
 *
 *   glob-gitignore-mtime-hellgate        0 pass / 8 skip  ->  8 pass
 *   cha-multisite-hellgate               5 pass / 9 skip  -> 14 pass
 *   project-env-snapshot-wiring          0 pass / 3 skip  ->  3 pass
 *   contract/lsp-{pyright,typescript}    0 pass / 1 skip  ->  3 pass each
 *   sphinx-ra-shim                       0 pass / 3 skip  ->  2 pass
 *   ast-grep {bugs,e2e,scenarios}       23 pass / 31 skip -> 28 pass
 *
 * Thirty-three cases that never ran anywhere. The ones that still skip —
 * browser and sandbox — skip because this host genuinely lacks chromium and
 * bwrap, which is the answer the receipt exists to give.
 *
 * debugpy is NOT one of those, and calling it "genuinely absent" was wrong.
 * MEASURED: `/usr/bin/python3 -c 'import debugpy'` succeeds (1.8.21) and resolves
 * to `~/Library/Python/3.9/lib/python/site-packages/debugpy` — a USER site
 * directory, i.e. a path under `$HOME`. Under the scratch HOME the workers get,
 * the same import raises `ModuleNotFoundError`. So `unavailable` is the correct
 * verdict FOR A WORKER and a wrong description of the host, and the two only
 * agree because the probe now runs under a worker-shaped HOME.
 *
 * # Why a function and not more CLI
 *
 * A decision buried in a `cliMain` can only be guarded by asserting that some
 * string appears in a source file, and this campaign has now been bitten by that
 * exact shape four times. This is importable, so the round trip — produce, then
 * have the real consumer read it — is a test rather than a grep.
 *
 * # The receipt must describe the WORKERS' environment, not the runner's
 *
 * The first version of this probed in the runner's process and handed the answer
 * to workers that run with `HOME` set to a fresh scratch directory
 * (`run-test-shards.ts` gives every worker `runRoot/worker-N/home`, and lends the
 * real `~/Library` only to the `browser` class). MEASURED, same probes, two
 * HOMEs:
 *
 *   HOME=~            debugpy=ok    cargo=ok    lancedb=ok
 *   HOME=<scratch>    debugpy=FAIL  cargo=FAIL  lancedb=FAIL
 *
 * So the receipt said "available", `canExecute` returned true, the gated describe
 * RAN, and the body then reached for a toolchain that is not there where the
 * worker runs. Before the wiring those cases skipped; after it they would go red
 * on a clean checkout. `probeEnv` is REQUIRED for exactly that reason: the
 * environment the answer is about is not a detail the caller may omit.
 *
 * Under-claiming is the safe direction and is deliberate: a `browser` worker that
 * is lent `~/Library` may have MORE than the receipt says, and the cost of that
 * is a skip recorded as `skipped-capability`, never a false green.
 */
/**
 * What the workers could actually DO, as one comparable value.
 *
 * NOT the binding. `bindingSha256` is `sha256(head + policySha256 +
 * toolchainSha256)`, and feeding it into the shard cache identity put two things
 * back that do not belong there:
 *
 *   - the git HEAD, which `testShardCacheIdentitySha256` deliberately excludes
 *     for certified chunks ("not inputs to THIS chunk, properties of the
 *     campaign that happened to schedule it") — measured, two heads produced two
 *     identities for the same chunk;
 *   - the whole 27-entry external-toolchain fingerprint, each entry
 *     `path dev:ino size mtime`, which `toolScopeSha256` had narrowed the same
 *     day precisely because a `cargo install` changed the identity of every
 *     `pure` chunk that cannot spawn a subprocess at all.
 *
 * The coverage-relevant fact is the VERDICT per capability: which gated describes
 * will run. That is what belongs in the identity, and it is stable across commits
 * and across an unrelated tool's mtime.
 */
export const capabilityVerdictsSha256 = (receipt: CapabilityReceipt): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(receipt.capabilities)
          .map(([id, finding]) => [id, finding.status] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex")

/** The env key the shard cache identity hashes. Distinct from the binding on
 *  purpose: the binding refuses a foreign receipt, this decides cache reuse. */
export { CAPABILITY_VERDICTS_ENV }

/**
 * Whether a campaign probes chrome. Exported so its truth table is PINNED.
 *
 * The inline expression it replaces could be narrowed to
 * `input.includeChrome ?? input.probeChrome !== undefined` with every arm green,
 * because the only arm that reached the campaign default injected `probeChrome`
 * — and the shard runner passes neither `spawn` nor `probeChrome`, so that
 * mutant silently returned chrome to "in no receipt at all".
 *
 * On by default. Off when a `spawn` override is supplied (a unit test testing
 * the wiring must not launch a browser the spawner cannot reach), unless the
 * caller also supplies `probeChrome`.
 */
export const campaignIncludesChrome = (input: {
  readonly includeChrome?: boolean
  readonly spawn?: ProbeSpawner
  readonly probeChrome?: ChromeProbe
}): boolean => input.includeChrome ?? (input.spawn === undefined || input.probeChrome !== undefined)

/**
 * Ids the corpus is told to expect that a campaign receipt does not carry.
 *
 * A pure function so the check can be DRIVEN. Inline, it could never fire
 * through the public API — the producer always writes every id it was given —
 * which made it a guard that cannot fail, and an audit's neuter of it left every
 * arm green. What it protects against is a producer change, so an arm hands it a
 * receipt that is missing one.
 */
export const campaignReceiptMissingIds = (
  receipt: Pick<CapabilityReceipt, "capabilities">,
  includesChrome: boolean,
  env: Record<string, string>,
): readonly string[] =>
  (includesChrome
    ? campaignCapabilityIds(env)
    : capabilityCatalogue(env).map((spec) => spec.id)
  ).filter((id) => receipt.capabilities[id] === undefined)

export const capabilityReceiptEnvForCampaign = async (input: {
  readonly repoRoot: string
  readonly tier: string
  readonly head: string
  readonly outPath: string
  /**
   * The environment the probes run under, which must be the one the CONSUMERS
   * get. REQUIRED: an optional environment is an environment a caller forgets,
   * and this exact field is what made the first version answer about the wrong
   * host.
   */
  readonly probeEnv: Record<string, string>
  readonly readText?: (path: string) => string
  readonly totalDeadlineMs?: number
  /** Campaign ceiling. The one-hour default expires mid-campaign on a long run
   *  and sends every later worker back to skipping everything, silently green. */
  readonly ttlMs?: number
  readonly spawn?: ProbeSpawner
  /**
   * Probe chrome too. Defaults to TRUE for a real campaign.
   *
   * # Why it defaults on, and why `spawn` decides
   *
   * `chrome-cdp` is in the corpus's capability vocabulary — 17 gated tests
   * across two browser files ask for it — and it was in NO receipt any
   * production path could mint. This function had no chrome parameter at all,
   * `cliMain` was the only caller that set one, and the CLI is invoked by
   * nothing. So `capability("chrome-cdp")` answered `blocked-missing` on every
   * host, every gated describe skipped, and all 17 reported PASS. That is the
   * defect this whole artifact exists to end, surviving inside its own fix.
   *
   * Costed before defaulting it on: `probeChromeBringUp` calls
   * `port.availability()` first and returns `unavailable` with NO spawn when
   * there is no binary, so a host without chrome pays a stat, not a launch.
   *
   * It is excluded when a `spawn` override is supplied, because the chrome probe
   * does not go through that spawner — it drives the real browser port. A caller
   * injecting a fake spawner is testing the wiring, and launching a real browser
   * underneath it would be the opposite of hermetic.
   */
  readonly includeChrome?: boolean
  /** Where the chrome probe puts its throwaway profile. Defaults beside the receipt. */
  readonly chromeProfileRoot?: string
  /** Injected so an arm can prove chrome is in the receipt without a browser. */
  readonly probeChrome?: ChromeProbe
}): Promise<{
  readonly path: string
  readonly bindingSha256: string
  readonly env: Record<string, string>
  readonly receipt: CapabilityReceipt
}> => {
  const env = input.probeEnv
  const specs = capabilityCatalogue(env)
  const readText = input.readText ?? ((path: string): string => readFileSync(path, "utf8"))
  const receipt = await produceCapabilityReceipt({
    tier: input.tier,
    binding: {
      head: input.head.length > 0 ? input.head : "<unknown-head>",
      policySha256: capabilityPolicySha256(input.repoRoot, specs, readText),
      toolchainSha256: toolchainSha256(),
    },
    specs,
    env,
    ...(campaignIncludesChrome(input)
      ? {
          chrome: {
            profileRoot:
              input.chromeProfileRoot ?? join(dirname(input.outPath), "chrome-probe-profile"),
            ...(input.probeChrome === undefined ? {} : { probe: input.probeChrome }),
          },
        }
      : {}),
    ...(input.totalDeadlineMs === undefined ? {} : { totalDeadlineMs: input.totalDeadlineMs }),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
  })
  // The id SSOT is READ here, not only by the drift guard. "One list, read by
  // the producer and by the guard" was a docstring: the producer used `specs`
  // and `CHROME_CAPABILITY_ID` separately and never consulted the list, so the
  // guard could expect an id the producer had stopped minting. A campaign
  // receipt that lacks an id the corpus is told to expect is a producer bug,
  // and it fails HERE rather than as seventeen quiet skips.
  const missing = campaignReceiptMissingIds(receipt, campaignIncludesChrome(input), env)
  if (missing.length > 0) {
    throw new Error(
      `[capability] the campaign receipt is missing ${missing.join(", ")}. Every gated describe ` +
        "that asks for one would answer blocked-missing and skip green.",
    )
  }
  writeCapabilityReceipt(input.outPath, receipt)
  return {
    path: input.outPath,
    bindingSha256: receipt.bindingSha256,
    // BOTH halves. The binding is what makes the receipt refuse a foreign host;
    // an audit found the consumer comparing it only when this second variable
    // happened to be set, so shipping one without the other is shipping the
    // unbound version.
    env: {
      [CAPABILITY_RECEIPT_PATH_ENV]: input.outPath,
      [CAPABILITY_RECEIPT_BINDING_ENV]: receipt.bindingSha256,
      // Separate from the binding, and it is the one the cache identity hashes.
      [CAPABILITY_VERDICTS_ENV]: capabilityVerdictsSha256(receipt),
    },
    receipt,
  }
}

// ── CLI (the runner's call site; see docs/plans/.../handoff-tvh11.md) ───────

const cliMain = async (): Promise<number> => {
  const { readFileSync } = await import("node:fs")
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const repoRoot = flag("repo-root") ?? process.cwd()
  const tier = flag("tier") ?? "local"
  const head =
    flag("head") ??
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim()
  const specs = capabilityCatalogue(process.env as Record<string, string>)
  const out = flag("out") ?? defaultCapabilityReceiptPath(repoRoot, tier)
  const chromeProfileRoot = flag("chrome-profile-root")
  const receipt = await produceCapabilityReceipt({
    tier,
    binding: {
      head: head.length > 0 ? head : "<unknown-head>",
      policySha256: capabilityPolicySha256(repoRoot, specs, (p) => readFileSync(p, "utf8")),
      toolchainSha256: toolchainSha256(),
    },
    specs,
    ...(argv.includes("--chrome")
      ? {
          chrome: {
            profileRoot:
              chromeProfileRoot ??
              (() => {
                throw new Error("--chrome needs --chrome-profile-root <dir>")
              })(),
          },
        }
      : {}),
    ...(flag("total-deadline-ms") === undefined
      ? {}
      : { totalDeadlineMs: Number(flag("total-deadline-ms")) }),
  })
  writeCapabilityReceipt(out, receipt)
  process.stdout.write(`${out}\n`)
  for (const [id, finding] of Object.entries(receipt.capabilities).sort()) {
    process.stdout.write(`  ${id.padEnd(28)} ${finding.status.padEnd(14)} ${finding.probeMs}ms\n`)
  }
  // Through the constants the CONSUMER reads, not literals beside them.
  process.stdout.write(`export ${CAPABILITY_RECEIPT_PATH_ENV}=${out}\n`)
  process.stdout.write(`export ${CAPABILITY_RECEIPT_BINDING_ENV}=${receipt.bindingSha256}\n`)
  const ledgerNow = probeLedger()
  process.stdout.write(
    `  ledger started=${ledgerNow.processesStarted} exited=${ledgerNow.processesExited} timers=${ledgerNow.timersCreated}/${ledgerNow.timersCleared}\n`,
  )
  return 0
}

if (import.meta.main) {
  process.exitCode = await cliMain()
}
