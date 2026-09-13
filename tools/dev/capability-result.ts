/**
 * `tools/dev/capability-result` — turn one capability lane's JUnit into the
 * `quanta.capability-result.v2` artifact the required aggregator consumes.
 *
 * # Why a success conclusion is not evidence
 *
 * Three producers behind the `required` check are capability lanes:
 *
 *   pty        — every describe in tests/e2e-pty is `skipIf(!PTY_AVAILABLE)`
 *   toolchain  — the `*-real-e2e` arms degrade to visible skips without
 *                clangd / lldb-dap / dlv / debugpy
 *   contract   — docker, language servers and a Python+LanceDB runtime
 *
 * On a runner missing the capability, each of these exits 0 having executed
 * nothing. GitHub reports `success`, the aggregator sees a green row, and the
 * merge gate has covered zero cases while reading exactly like a run that
 * covered all of them. No count of green rows can tell those apart, which is
 * why the aggregator asks for this artifact and treats its ABSENCE as failure.
 *
 * # What counts as executed
 *
 * A JUnit `<testcase>` that carries a `<skipped>` child did not run. Everything
 * else did, including failures — a failing case is coverage that found
 * something, and it is already fatal through the job's own exit code. A file
 * counts as executed when at least one of its cases ran, so a file whose every
 * case skipped does not inflate the floor.
 *
 * `blockedMissing` and `failedSetup` are NOT skips. A lane that declared a
 * dependency required and did not get it is blocked, and provisioning that
 * broke is a setup failure; both are hard failures at the aggregator.
 *
 * They were ONLY passed in by the caller, as flags, and no lane passed them: all
 * three `capability:*` scripts published `blocked=0 setup_failed=0` whatever
 * happened, so the aggregator's two hard-failure checks could not fire. They are
 * now also READ from the junit: every receipt consumer registers a skipped
 * `[capability] RECORD <id> <verdict>` testcase in the file that asked (see
 * `capabilityRecordName`). Records are not cases and are counted in neither
 * `executedCases` nor `skippedUnsupported`. The flags remain for a dependency
 * that is not a receipt capability.
 *
 * # Bounded by construction
 *
 * Reads one file, writes one file. No spawn, no network, no unbounded wait —
 * this runs at the end of a capability job whose real work has already
 * finished, and it must not be able to add a hang to it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseCapabilityRecordName } from "./capability-receipt"

export interface CapabilityResultV1 {
  readonly schema: "quanta.capability-result.v2"
  /** MUST equal the workflow job id the required aggregator expects. */
  readonly producer: string
  /** Exact paths with at least one case that actually ran. */
  readonly executedFiles: readonly string[]
  readonly executedCases: number
  /**
   * Executed cases PER FILE, which is what makes a per-group case floor
   * checkable.
   *
   * v1 counted this and threw it away, publishing only the file list and the
   * total. The consumer therefore enforced each capability group's FILE floor
   * and could only compare the producer's TOTAL cases — so `toolchain`, which
   * fans out to seven groups with case floors of 4, 2, 1, 1, 1, 2 and 3, was
   * satisfied by one group running fourteen cases while another contributed a
   * file that executed nothing. That is the zero-coverage green this rail exists
   * to refuse, one level down.
   */
  readonly executedCasesByFile: Readonly<Record<string, number>>
  /** Cases the host could not run (a visible skip). */
  readonly skippedUnsupported: number
  /** A dependency the lane declared REQUIRED was absent. Hard failure. */
  readonly blockedMissing: number
  /** Provisioning broke before the lane could run. Hard failure. */
  readonly failedSetup: number
}

export interface JunitCounts {
  readonly executedFiles: readonly string[]
  readonly executedCases: number
  readonly skippedCases: number
  /** Per-file executed case counts, in the same order as `executedFiles`. */
  readonly executedCasesByFile: Readonly<Record<string, number>>
  /** Distinct `file capability` pairs recorded as each non-executed verdict. */
  readonly recordedBlockedMissing: number
  readonly recordedFailedSetup: number
}

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)
  return match?.[1]
}

/**
 * Count executed vs skipped cases per file from a JUnit document.
 *
 * Deliberately a scan rather than a DOM parse: this runs in a CI job whose
 * purpose has already been served, and a 40MB suite report should not need a
 * tree in memory to answer two questions. Self-closing `<testcase …/>` and
 * `<testcase …>…</testcase>` are both handled, and a case is skipped only when
 * a `<skipped` element appears inside its own body.
 */
interface JunitCase {
  readonly file: string
  readonly skipped: boolean
  readonly name: string
}

const junitCases = (xml: string): JunitCase[] => {
  const cases: JunitCase[] = []
  const caseTag = /<testcase\b([^>]*?)(\/?)>/gu
  for (let match = caseTag.exec(xml); match !== null; match = caseTag.exec(xml)) {
    const attrs = match[1] ?? ""
    let skipped = false
    if (match[2] !== "/") {
      const closeAt = xml.indexOf("</testcase>", caseTag.lastIndex)
      const body = closeAt === -1 ? "" : xml.slice(caseTag.lastIndex, closeAt)
      skipped = /<skipped\b/u.test(body)
    }
    cases.push({
      // Bun writes the file path as `file`; other emitters use `classname`.
      file: attribute(attrs, "file") ?? attribute(attrs, "classname") ?? "<unknown>",
      skipped,
      // Undecoded: the record prefix has nothing XML escapes, and the id and verdict
      // are read only up to the first ": ".
      name: attribute(attrs, "name") ?? "",
    })
  }
  return cases
}

export const countJunitExecution = (xml: string): JunitCounts => {
  const executedByFile = new Map<string, number>()
  let executedCases = 0
  let skippedCases = 0
  const recorded = { "blocked-missing": new Set<string>(), "failed-setup": new Set<string>() }
  for (const one of junitCases(xml)) {
    // A record is a SKIPPED case with the record name. A case that ran is a case,
    // whatever it is called, so a name cannot hide coverage or invent a record.
    const record = one.skipped ? parseCapabilityRecordName(one.name) : undefined
    if (record !== undefined) {
      if (record.verdict === "blocked-missing" || record.verdict === "failed-setup") {
        recorded[record.verdict].add(`${one.file} ${record.capability}`)
      }
    } else if (one.skipped) {
      skippedCases += 1
    } else {
      executedCases += 1
      executedByFile.set(one.file, (executedByFile.get(one.file) ?? 0) + 1)
    }
  }
  const files = [...executedByFile.keys()].sort((left, right) => left.localeCompare(right))
  return {
    executedFiles: files,
    executedCases,
    skippedCases,
    executedCasesByFile: Object.fromEntries(
      files.map((file) => [file, executedByFile.get(file) ?? 0]),
    ),
    recordedBlockedMissing: recorded["blocked-missing"].size,
    recordedFailedSetup: recorded["failed-setup"].size,
  }
}

export const capabilityResultFromJunit = (input: {
  readonly producer: string
  readonly xml: string
  readonly blockedMissing?: number
  readonly failedSetup?: number
}): CapabilityResultV1 => {
  const counts = countJunitExecution(input.xml)
  return {
    schema: "quanta.capability-result.v2",
    producer: input.producer,
    executedFiles: counts.executedFiles,
    executedCases: counts.executedCases,
    executedCasesByFile: counts.executedCasesByFile,
    skippedUnsupported: counts.skippedCases,
    blockedMissing: (input.blockedMissing ?? 0) + counts.recordedBlockedMissing,
    failedSetup: (input.failedSetup ?? 0) + counts.recordedFailedSetup,
  }
}

/**
 * A lane whose JUnit never appeared.
 *
 * The run died before the reporter wrote anything — a provisioning step that
 * failed, a runner that ran out of disk, a command that was never reached. That
 * is `failedSetup`, not "zero cases skipped": the difference is whether the lane
 * chose not to run or never got the chance, and only the second is a setup
 * defect. Either way the aggregator fails; this exists so the artifact says
 * WHICH, instead of the job publishing nothing and the failure reading as a
 * missing upload.
 */
export const capabilityResultForMissingJunit = (producer: string): CapabilityResultV1 => ({
  schema: "quanta.capability-result.v2",
  producer,
  executedFiles: [],
  executedCases: 0,
  executedCasesByFile: {},
  skippedUnsupported: 0,
  blockedMissing: 0,
  failedSetup: 1,
})

const usage =
  "usage: capability-result.ts --producer=<job-id> --junit=<path> --out=<path> " +
  "[--blocked-missing=N] [--failed-setup=N]"

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const value = (flag: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const count = (flag: string): number => {
    const raw = value(flag)
    if (raw === undefined) return 0
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      process.stderr.write(`capability-result: ${flag} must be a non-negative integer\n`)
      process.exit(2)
    }
    return parsed
  }
  const producer = value("--producer")
  const junit = value("--junit")
  const out = value("--out")
  if (producer === undefined || junit === undefined || out === undefined) {
    process.stderr.write(`${usage}\n`)
    process.exit(2)
  }
  let xml: string | undefined
  try {
    xml = readFileSync(junit, "utf8")
  } catch {
    xml = undefined
  }
  const result =
    xml === undefined
      ? capabilityResultForMissingJunit(producer)
      : capabilityResultFromJunit({
          producer,
          xml,
          blockedMissing: count("--blocked-missing"),
          failedSetup: count("--failed-setup"),
        })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  process.stdout.write(
    `capability-result: producer=${result.producer} executed_files=${result.executedFiles.length} ` +
      `executed_cases=${result.executedCases} skipped=${result.skippedUnsupported} ` +
      `blocked=${result.blockedMissing} setup_failed=${result.failedSetup} -> ${out}\n`,
  )
}
