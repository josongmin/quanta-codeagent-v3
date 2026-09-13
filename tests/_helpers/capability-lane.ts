/**
 * `tests/_helpers/capability-lane` — the one way a capability-lane test is
 * allowed to say "I did not run".
 *
 * # The defect
 *
 * `tests/unit/llm/local-preset-live-real-e2e.test.ts` did this, verbatim:
 *
 *     console.warn("…live tool-call smoke SKIPPED (documented no-server
 *                   outcome, not a pass).")
 *     expect(true).toBe(true)
 *     return
 *
 * The comment says "not a pass" and the code says PASS. Bun's reporter prints
 * `1 pass`, the junit carries a passing testcase, `unit-speed-budget` sees a
 * fast green case, and the aggregate `test:real-toolchain` line is the same one
 * a host that really ran the inference produces. The prose was the only place
 * the truth existed, and prose is not a verdict.
 *
 * Every other file in the lane had a milder version of the same shape: the
 * capability probe collapsed to `describe.skip`, which IS visible in the
 * reporter, but nothing recorded WHICH capability was missing, so a job could
 * skip all 17 files and still print a green.
 *
 * # The four outcomes
 *
 *   executed             the capability was present and the assertions ran.
 *                        The only outcome that is evidence.
 *   skipped-unsupported  this lane was not selected (env gate off), or the host
 *                        platform cannot ever have the capability (bwrap on
 *                        macOS). A visible, policy-explicit non-selection.
 *   blocked-missing      the lane WAS selected and the capability is absent.
 *                        In a required job this is RED — see `capability()`
 *                        in `tools/dev/capability-receipt-consumer.ts`.
 *   failed-setup         the capability is present but its fixture could not be
 *                        built (an install failed, a clone failed). Never a
 *                        skip: a broken fixture is a defect in the lane, not a
 *                        property of the host.
 *
 * # Why this never calls `expect`
 *
 * Emitting a result must not create a passing assertion. `reportCapability` only
 * writes a machine-readable line; turning an outcome into a verdict is the
 * caller's explicit choice (a required capability, or `describe.skip`).
 */

import { describe as describeFn } from "bun:test"
import {
  CAPABILITY_LINE_PREFIX,
  CAPABILITY_REQUIRE_ENV,
  capabilityRequiredFor,
} from "../../tools/dev/capability-receipt"
import { CAPABILITY_GROUPS } from "../../tools/dev/test-capability-manifest"

export type CapabilityOutcome =
  | "executed"
  | "skipped-unsupported"
  | "blocked-missing"
  | "failed-setup"

export interface CapabilityResult {
  /** A group id from `tools/dev/test-capability-manifest.ts`. */
  readonly group: string
  /** Repo-relative id of the file reporting. */
  readonly file: string
  readonly outcome: CapabilityOutcome
  /** Which need decided it, and how it was probed. Never empty. */
  readonly detail: string
  /** Group-specific receipt fields (upstream sha, model name, versions). */
  readonly receipt?: Readonly<Record<string, string>>
}

const KNOWN_GROUPS: ReadonlySet<string> = new Set(CAPABILITY_GROUPS.map((group) => group.id))

/**
 * Marker the CI aggregator greps for. Stable, one line, parseable.
 *
 * Re-exported, not defined: the receipt consumer writes the same prefix, and a
 * second literal would let the two halves drift into two greps.
 */
export { CAPABILITY_LINE_PREFIX }

/**
 * Record an outcome. Writes one line to stdout and returns the result so a
 * caller can assert on it.
 *
 * An unknown group id THROWS rather than logging: a result attributed to a
 * group the manifest does not know is not counted by the fan-out, so it would
 * silently vanish from exactly the tally it exists to feed.
 */
export const reportCapability = (result: CapabilityResult): CapabilityResult => {
  if (!KNOWN_GROUPS.has(result.group)) {
    throw new Error(
      `[capability-lane] unknown group "${result.group}" — declare it in ` +
        "tools/dev/test-capability-manifest.ts, or the outcome is counted by nothing",
    )
  }
  if (result.detail.trim() === "") {
    throw new Error(`[capability-lane] ${result.group}: an outcome with no detail explains nothing`)
  }
  const receipt =
    result.receipt === undefined || Object.keys(result.receipt).length === 0
      ? ""
      : ` receipt=${JSON.stringify(result.receipt)}`
  process.stdout.write(
    `${CAPABILITY_LINE_PREFIX} group=${result.group} file=${result.file} ` +
      `outcome=${result.outcome} detail=${JSON.stringify(result.detail)}${receipt}\n`,
  )
  return result
}

/**
 * Is this job REQUIRED to actually exercise the capability?
 *
 * Delegates to `capabilityRequiredFor`, which owns the one name and the one
 * grammar. This helper read `QUANTA_REQUIRE_CAPABILITY` (singular) while the
 * receipt consumer read `QUANTA_REQUIRE_CAPABILITIES` (plural) with a different
 * grammar, so arming one armed half the corpus. A required job that cannot reach
 * its capability is `blocked-missing` and must go RED — "the tool was not
 * installed" is the failure a required capability job exists to report, not an
 * excuse for a pass.
 */
export const capabilityRequired = (
  group: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => capabilityRequiredFor(group, env)

/** Is the `*-real-e2e` capability lane selected at all? */
export const capabilityLaneSelected = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const raw = env.QUANTA_REAL_TOOLCHAIN_E2E
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false"
}

/* ── bounded probes ─────────────────────────────────────────────────────── */

/**
 * PATH resolution, no subprocess.
 *
 * The lane's own helper was `Bun.spawnSync([bin, "--version"])` at MODULE LOAD,
 * copy-pasted into 16 files — an unbounded spawn per tool, per file, paid on
 * every ordinary `bun test tests/unit` run where all of it then skipped. A
 * wedged `xcrun` or a cold `gopls` hangs the whole suite with no diagnostic, and
 * `--version` proves nothing that PATH resolution does not.
 */
export const hasBinary = (name: string): boolean =>
  Bun.which(name, { PATH: process.env.PATH ?? "" }) !== null

/** Absolute candidates for binaries not exposed on PATH under their own name. */
export const hasBinaryAt = (candidates: readonly string[]): string | null => {
  for (const candidate of candidates) {
    if (Bun.file(candidate).size > 0) return candidate
  }
  return null
}

/** macOS keeps `lldb-dap` inside the Xcode / CLT toolchain, never on PATH. */
export const LLDB_DAP_CANDIDATES = [
  "/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap",
  "/Library/Developer/CommandLineTools/usr/bin/lldb-dap",
] as const

export const hasLldbDap = (): boolean =>
  hasBinary("lldb-dap") || hasBinaryAt(LLDB_DAP_CANDIDATES) !== null

/**
 * A capability that genuinely needs to run something (a python import cannot be
 * answered by a stat). ALWAYS deadlined — `Bun.spawnSync` accepts `timeout`
 * (verified on Bun 1.3.14: a 5s sleep under `timeout: 300` returns in 302ms
 * with SIGTERM), so there is no reason for an unbounded probe to exist.
 */
export const probeBounded = (
  argv: readonly string[],
  timeoutMs = 5_000,
  cwd?: string,
): { readonly ok: boolean; readonly timedOut: boolean; readonly stderr: string } => {
  try {
    const result = Bun.spawnSync([...argv], {
      stdout: "ignore",
      stderr: "pipe",
      timeout: timeoutMs,
      ...(cwd === undefined ? {} : { cwd }),
    })
    return {
      ok: result.exitCode === 0,
      timedOut: result.signalCode === "SIGTERM",
      stderr: result.stderr.toString().slice(-600),
    }
  } catch (error) {
    return { ok: false, timedOut: false, stderr: String(error).slice(0, 600) }
  }
}

/**
 * A version string for a receipt field, BOUNDED.
 *
 * Only ever called from inside a selected capability lane (an `afterAll`), never
 * at module load — the point of the receipt is to say what actually ran, so
 * paying for it on a host that skipped would be the old defect wearing a new
 * name.
 */
export const boundedVersion = (argv: readonly string[], timeoutMs = 10_000): string => {
  const binary = Bun.which(argv[0] ?? "", { PATH: process.env.PATH ?? "" }) ?? argv[0]
  if (binary === undefined) return "<missing>"
  try {
    const result = Bun.spawnSync([binary, ...argv.slice(1)], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    })
    const text = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
    if (result.signalCode === "SIGTERM") return "<timeout>"
    return text.split("\n")[0]?.trim() ?? "<empty>"
  } catch {
    return "<unreadable>"
  }
}

export const hasPythonModule = (moduleName: string, timeoutMs = 5_000): boolean => {
  const python = Bun.which("python3", { PATH: process.env.PATH ?? "" })
  if (python === null) return false
  return probeBounded([python, "-c", `import ${moduleName}`], timeoutMs).ok
}

/* ── turning an outcome into a verdict ──────────────────────────────────── */

export interface CapabilityGateInput {
  readonly group: string
  readonly file: string
  /** Every declared need with the boolean that decides it. Order is reported. */
  readonly needs: Readonly<Record<string, boolean>>
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface CapabilityGateVerdict {
  readonly available: boolean
  readonly outcome: CapabilityOutcome
  readonly missing: readonly string[]
  readonly detail: string
}

/**
 * Decide, report, and hand back a typed verdict.
 *
 * Called at module scope by each lane file, so the reported line exists even
 * when every case is skipped — which is the whole point: a job that skipped all
 * 17 files used to be textually identical to one that ran them.
 */
export const capabilityGate = (input: CapabilityGateInput): CapabilityGateVerdict => {
  const env = input.env ?? process.env
  const missing = Object.entries(input.needs)
    .filter(([, present]) => !present)
    .map(([need]) => need)
    .sort()
  const selected = capabilityLaneSelected(env)
  const available = selected && missing.length === 0
  const outcome: CapabilityOutcome = available
    ? "executed"
    : !selected
      ? "skipped-unsupported"
      : "blocked-missing"
  const detail = available
    ? `all declared needs present: ${Object.keys(input.needs).sort().join(", ")}`
    : !selected
      ? "QUANTA_REAL_TOOLCHAIN_E2E is not set; the capability lane was not selected"
      : `absent on this host: ${missing.join(", ")}`
  reportCapability({ group: input.group, file: input.file, outcome, detail })
  return { available, outcome, missing, detail }
}

/**
 * `executed` plus a receipt, for an `afterAll`.
 *
 * TAKES THE VERDICT, and no-ops when the lane did not run. MEASURED while
 * landing this: with a REQUIRED-but-blocked group the `beforeAll` correctly
 * threw and the case went RED, and then `afterAll` printed
 * `outcome=executed … goplsVersion="<unreadable>"` anyway — an "executed" line
 * for a lane that executed nothing, which is the exact false receipt this whole
 * module exists to remove.
 *
 * The receipt is a THUNK so a blocked lane also pays none of the
 * `boundedVersion` subprocesses it would have needed.
 */
export const reportExecuted = (
  verdict: CapabilityGateVerdict,
  group: string,
  file: string,
  detail: string,
  receipt: () => Readonly<Record<string, string>>,
): void => {
  if (!verdict.available) return
  reportCapability({ group, file, outcome: "executed", detail, receipt: receipt() })
}

/**
 * The describe-selector every lane file uses.
 *
 * THE HOLE THIS CLOSES. `const D = GATE.available ? describe : describe.skip`
 * reads correctly and is wrong in exactly the case that matters: when a REQUIRED
 * capability job cannot reach its capability, `describe.skip` means `beforeAll`
 * never runs, so `assertCapabilityNotBlocked` never fires and the job exits 0
 * having executed nothing. "the tool was not installed" would go back to
 * printing the same green as "the tool ran" — the defect the whole ticket is
 * about, reintroduced one level down.
 *
 * So a blocked REQUIRED group selects the REAL `describe`: its `beforeAll`
 * throws, every case in it is reported FAILED, and the failure text names the
 * group and the missing need. A blocked OPTIONAL group still gets the visible
 * skip, with its `[capability]` line already written by `capabilityGate`.
 */
export const laneDescribe = (
  group: string,
  verdict: CapabilityGateVerdict,
  env: Readonly<Record<string, string | undefined>> = process.env,
): typeof describeFn =>
  verdict.available || capabilityRequired(group, env) ? describeFn : describeFn.skip

/**
 * The RED half. A required capability job that reaches this has proven the one
 * thing it was asked to prove: the capability is not there.
 *
 * Deliberately an `Error`, not an `expect` — so it is usable from `beforeAll`
 * and from a setup step, where a failed expectation is not always attributed.
 */
export const assertCapabilityNotBlocked = (
  input: { readonly group: string; readonly file: string },
  verdict: CapabilityGateVerdict,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  if (verdict.available) return
  if (!capabilityRequired(input.group, env)) return
  throw new Error(
    `[capability] REQUIRED group ${input.group} is ${verdict.outcome} in ${input.file}: ` +
      `${verdict.detail}. ${CAPABILITY_REQUIRE_ENV} names this group, so an absent capability ` +
      "is the failure, not a reason to pass.",
  )
}

/**
 * A fixture that could not be built while the capability WAS present.
 * Always a throw: `failed-setup` is a defect in the lane, never a host property.
 */
export const capabilitySetupFailed = (
  group: string,
  file: string,
  detail: string,
  receipt?: Readonly<Record<string, string>>,
): never => {
  reportCapability({
    group,
    file,
    outcome: "failed-setup",
    detail,
    ...(receipt === undefined ? {} : { receipt }),
  })
  throw new Error(`[capability] ${group} setup failed in ${file}: ${detail}`)
}
