/**
 * `quanta-bench terminal <doctor|canary|run|report>` — TB21-00A registration.
 *
 * This file is the NESTED ACTION DISPATCH and the composition root for the
 * Terminal-Bench branch, and nothing else. It:
 *
 *   1. resolves the BFND-01 suite branch + the ONE typed run config (which is
 *      also where a SWE `--dataset-family` selector is refused);
 *   2. reads provenance (git sha / dirty / package version) through ports;
 *   3. builds the ONE typed run manifest;
 *   4. hands that manifest to the pure Harbor argv builder;
 *   5. for a PAID run only, gates on a green doctor before spawning.
 *
 * Everything substantive lives in `../terminal/*` as pure modules. There is no
 * second CLI, no `tools/terminal-bench` execution tree, and package scripts may
 * only be thin aliases to this entry (`commands/terminal.test.ts` enforces it).
 *
 * ⚠️ SPEND. `run` without `--dry-run` executes `harbor run`, which provisions
 * containers and bills a provider for 89 tasks × k trials. The executor is an
 * INJECTED port so tests can prove the gate without ever spending, and the
 * doctor gate is checked BEFORE the port is called.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { writeReport } from "@/runner/batch/report"
import { errMessage, logger } from "@/shared"
import { TERMINAL_CANARY_MANIFEST } from "../terminal/canary"
import {
  assertNoSweDatasetFamilySelector,
  resolveTerminalRunConfig,
  type TerminalRunConfig,
} from "../terminal/config"
import {
  type DoctorPorts,
  formatDoctorReceipt,
  type RunResult,
  runTerminalDoctor,
} from "../terminal/doctor"
import {
  ADAPTER_PROJECT,
  buildHarborRunCommand,
  formatHarborDryRunReceipt,
} from "../terminal/harbor-command"
import {
  buildTerminalRunManifest,
  type RepoProvenance,
  readPinnedHarborVersion,
  validateTerminalRunManifest,
} from "../terminal/manifest"

const USAGE = `usage: quanta-bench terminal <doctor|canary|run|report>

  doctor   verify this machine can produce a meaningful Terminal-Bench 2.1 run
  canary   print the revision-bound oracle/canary selection
  run      build (and, without --dry-run, execute) the pinned harbor job
  report   build the canonical 2.1 report from finished harbor job directories
           (--manifest <run-manifest.json> --job-dir <dir> … --out <report.json>);
           persisted through the ONE canonical bench writer + result mirror

run options (all explicit — nothing about a paid run is inferred):
  --profile <control|quanta-full>   REQUIRED; arms are scored separately
  --model <name>                    REQUIRED
  --effort <none|minimal|low|medium|high|xhigh>   REQUIRED
  --provider <openai|chatgpt-oauth|anthropic>     default openai
  --sandbox <docker|daytona|modal>  default docker
  --k <n>                           trials per task (default 5)
  --concurrency <n>                 concurrent trials (default 1)
  --tasks <oracle|canary>           the ONLY accepted include sets
  --out <dir>                       harbor jobs dir
  --knob KEY=VALUE                  override a REGISTERED knob (repeatable)
  --upload --public|--private       never inferred; both flags required
  --promote                         clean-SHA promotion mode (fails when dirty)
  --dry-run                         print the receipt; spend nothing`

export interface CmdTerminalDeps {
  /** The FULL argv. Required, never defaulted from `process.argv` here: the
   *  composition root (`cli.ts`) owns the ambient read, and this module must be
   *  drivable from a test without a process. */
  readonly argv: readonly string[]
  /** The env this run observes. Required for the same reason — and because the
   *  ticket's rule is that no layer below the composition root re-reads ambient
   *  `process.env` to override a resolved decision. */
  readonly env: NodeJS.ProcessEnv
  /** Executes the built harbor command. INJECTED so a test can prove the gate. */
  readonly spawnHarbor?: (bin: string, argv: readonly string[], env: NodeJS.ProcessEnv) => number
  readonly write?: (text: string) => void
  readonly exit?: (code: number) => void
  /** The doctor's subprocess port. */
  readonly doctorRun?: DoctorPorts["run"]
  readonly canWriteDir?: (path: string) => boolean
  readonly fileExists?: (path: string) => boolean
  /** Persist a text file (the run manifest). Injected so the handoff is
   *  provable without touching the filesystem. */
  readonly writeFile?: (path: string, text: string) => void
  readonly readText?: (path: string) => string
  readonly now?: () => string
}

/**
 * The default probe port.
 *
 * The try/catch is LOAD-BEARING, not defensive: `Bun.spawnSync` THROWS
 * `Executable not found in $PATH` instead of returning 127, so the first
 * `terminal doctor` on a machine without the brain shim died with a bare error
 * string — no receipt, no per-check verdict, no indication of WHICH probe
 * failed. A doctor whose entire job is diagnosing missing tooling must report a
 * missing binary as a red CHECK. Exported so that contract is testable.
 */
export const spawnSyncText = (bin: string, args: readonly string[]): RunResult => {
  try {
    const p = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" })
    return {
      code: p.exitCode ?? 1,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    }
  } catch (err) {
    // 127 is the shell's own "command not found", so downstream reads naturally.
    return { code: 127, stdout: "", stderr: errMessage(err) }
  }
}

const defaultSpawnHarbor = (
  bin: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): number => {
  const p = Bun.spawnSync([bin, ...argv], {
    env: env as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
  })
  return p.exitCode ?? 1
}

/**
 * Writability WITHOUT creating anything.
 *
 * The first version called `mkdirSync(path, { recursive: true })` and then
 * checked existence. That made a diagnostic have a side effect: running
 * `terminal doctor` in the repo root silently created an untracked `harbor-jobs/`
 * directory. A check that mutates the operator's tree is not a check. Walk up to
 * the nearest EXISTING ancestor and ask the OS whether it is writable.
 */
const defaultCanWriteDir = (path: string): boolean => {
  let probe = resolve(path)
  for (;;) {
    if (existsSync(probe)) {
      try {
        accessSync(probe, constants.W_OK)
        return true
      } catch (e) {
        // `false` stays the verdict, but this feeds a DOCTOR check, whose whole
        // job is an accurate diagnosis. `accessSync` throws for EACCES *and* for
        // ELOOP / EIO / a lost race with the ancestor's removal; collapsing all of
        // them to "not writable" hands the operator a plausible wrong cause.
        logger.warn(`terminal-doctor.canWriteDir: ${probe}: ${errMessage(e)}`)
        return false
      }
    }
    const parent = dirname(probe)
    if (parent === probe) return false
    probe = parent
  }
}

/** Repo root, derived from this module's location (`src/apps/bench/commands`) —
 *  never an ambient cwd, so a run launched from a sub-directory still finds the
 *  pinned adapter and `package.json`. */
const repoRoot = (): string => join(import.meta.dir, "..", "..", "..", "..")

const readProvenance = (
  run: DoctorPorts["run"],
  readText: (path: string) => string,
): RepoProvenance => {
  const head = run("git", ["rev-parse", "--short=12", "HEAD"])
  const sha = (head.stdout.split("\n")[0] ?? "").trim()
  if (head.code !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(
      "terminal: could not read the repo SHA (`git rev-parse --short=12 HEAD`). A run with no " +
        "provenance is unattributable — the leaderboard keys a submission on the agent version.",
    )
  }
  const status = run("git", ["status", "--porcelain"])
  if (status.code !== 0) {
    throw new Error("terminal: could not read the worktree state (`git status --porcelain`)")
  }
  const pkg = JSON.parse(readText(join(repoRoot(), "package.json"))) as { version?: unknown }
  if (typeof pkg.version !== "string") {
    throw new Error("terminal: package.json has no version to derive the agent version from")
  }
  return { packageVersion: pkg.version, sha, dirty: status.stdout.trim() !== "" }
}

/** Default manifest sink: create the output root if needed, then write. */
const defaultWriteFile = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
}

const doctorPorts = (deps: CmdTerminalDeps, env: NodeJS.ProcessEnv): DoctorPorts => ({
  run: deps.doctorRun ?? spawnSyncText,
  env,
  canWriteDir: deps.canWriteDir ?? defaultCanWriteDir,
  // PRESENCE only — the credential check stats the chatgpt-oauth token bundle
  // and must never open it.
  fileExists: deps.fileExists ?? ((path: string) => existsSync(path)),
})

const buildManifestFor = (
  cfg: TerminalRunConfig,
  deps: CmdTerminalDeps,
  ports: DoctorPorts,
): ReturnType<typeof buildTerminalRunManifest> => {
  const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"))
  const manifest = buildTerminalRunManifest({
    cfg,
    provenance: readProvenance(ports.run, readText),
    harborVersion: readPinnedHarborVersion(
      readText(join(repoRoot(), ADAPTER_PROJECT, "pyproject.toml")),
    ),
    timestamp: deps.now?.() ?? new Date().toISOString(),
  })
  // Decode-validate what we just built: the manifest that leaves this root is
  // the same object the report will carry, so it passes the SAME boundary a
  // reader would apply. A builder that drifted from the validator is exactly how
  // an unreadable report ships.
  return validateTerminalRunManifest(JSON.parse(JSON.stringify(manifest)))
}

const actionDoctor = (
  deps: CmdTerminalDeps,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): number => {
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`))
  // The doctor answers "would a PAID run with THIS configuration be meaningful",
  // so it consumes the same `--model` / `--effort` / `--sandbox` the run does and
  // goes through the SAME resolver — there is no second parse and no second set
  // of defaults. `--profile` is the one thing the machine checks do not need, so
  // it is defaulted rather than demanded.
  const cfg = resolveTerminalRunConfig({
    argv: [...argv, ...(argv.includes("--profile") ? [] : ["--profile", "control"])],
    env,
  })
  const report = runTerminalDoctor(doctorPorts(deps, env), {
    model: cfg.model,
    provider: cfg.provider,
    effort: cfg.effort,
    sandbox: cfg.sandbox,
    outputRoot: cfg.outputRoot,
  })
  write(formatDoctorReceipt(report))
  return report.exitCode
}

const actionCanary = (deps: CmdTerminalDeps): number => {
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`))
  write(JSON.stringify(TERMINAL_CANARY_MANIFEST, null, 2))
  return 0
}

const actionRun = (
  deps: CmdTerminalDeps,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): number => {
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`))
  const cfg = resolveTerminalRunConfig({ argv, env })
  const ports = doctorPorts(deps, env)
  const manifest = buildManifestFor(cfg, deps, ports)
  const command = buildHarborRunCommand(manifest, { outputRoot: cfg.outputRoot, env })

  if (cfg.dryRun) {
    write(formatHarborDryRunReceipt(command, env))
    return 0
  }

  // PAID from here on. The doctor is the precondition gate.
  const doctor = runTerminalDoctor(ports, {
    model: cfg.model,
    provider: cfg.provider,
    effort: cfg.effort,
    sandbox: cfg.sandbox,
    outputRoot: cfg.outputRoot,
  })
  if (!doctor.ok) {
    write(formatDoctorReceipt(doctor))
    write(
      "terminal: REFUSING to start a paid Terminal-Bench run — the doctor is red. Fix the checks " +
        "above (or run with --dry-run to inspect the command).",
    )
    return 2
  }

  write(formatHarborDryRunReceipt(command, env))

  // THE HANDOFF. `terminal report` takes `--manifest <run-manifest.json>` as its
  // authority for the dataset ref, agent version, effort decision, knob set and
  // promotion blockers. Until aug-22 this manifest lived only in memory, so after
  // a real run the last hop of the pipeline had no input at all — each half was
  // only ever tested against a hand-built fixture, so nothing noticed.
  //
  // Written BEFORE the spawn on purpose: a harbor job that dies halfway is
  // precisely when an operator needs to know what was launched.
  const manifestPath = join(
    cfg.outputRoot,
    `run-manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`,
  )
  ;(deps.writeFile ?? defaultWriteFile)(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  write(`  run manifest      ${manifestPath}`)

  return (deps.spawnHarbor ?? defaultSpawnHarbor)(command.bin, command.argv, env)
}

/**
 * The LAST hop of the TB21-04 pipeline:
 *
 *   scanHarborJobDirs → parseHarborTrialResult → partition by isTrialDefect
 *     → buildTerminalRunReport → writeReport
 *
 * `writeReport` is the CANONICAL owner (BFND-02): it serializes the branch and
 * fans out to the one `~/.quanta/bench/results` mirror. This command must never
 * `Bun.write` a report itself — a second sink is how a results root splinters,
 * and `report-persistence.test.ts` fails if one appears.
 *
 * `--out` is REQUIRED. Deriving a destination from a job directory would mean
 * guessing where an operator's artifact belongs, and a report that silently
 * lands somewhere is a report nobody reconciles.
 */
const actionReport = async (deps: CmdTerminalDeps, argv: readonly string[]): Promise<number> => {
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`))
  const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"))
  const manifestPath = argValueOf(argv, "--manifest")
  const jobDirs = argValuesOf(argv, "--job-dir")
  const out = argValueOf(argv, "--out")
  if (manifestPath === undefined || jobDirs.length === 0 || out === undefined) {
    write(
      "usage: quanta-bench terminal report --manifest <run-manifest.json> --job-dir <dir> … " +
        "--out <report.json>",
    )
    return 2
  }
  const manifest = validateTerminalRunManifest(JSON.parse(readText(manifestPath)))
  const { scanHarborJobDirs } = await import("../terminal/harbor-results")
  const { buildTerminalRunReport, isTrialDefect, parseHarborTrialResult } = await import(
    "../terminal/report"
  )
  const parsed = scanHarborJobDirs(jobDirs).map(parseHarborTrialResult)
  const defects = parsed.filter(isTrialDefect)
  const trials = parsed.flatMap((p) => (isTrialDefect(p) ? [] : [p]))
  const report = buildTerminalRunReport({
    datasetRef: manifest.datasetRef,
    timestamp: manifest.timestamp,
    arm: manifest.arm,
    k: manifest.k,
    harborJobIds: manifest.harborJobIds,
    sourcePaths: jobDirs,
    model: manifest.model,
    preset: manifest.preset,
    trials,
    defects,
    manifest,
  })
  await writeReport(out, report)
  write(
    `terminal report: ${report.trials.length} trial receipt(s), ${report.defects.length} defect(s), ` +
      `verdict=${report.admission.verdict} → ${out}`,
  )
  return 0
}

const argValueOf = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  if (i >= 0) return argv[i + 1]
  const pref = `${flag}=`
  const eq = argv.find((a) => a.startsWith(pref))
  return eq === undefined ? undefined : eq.slice(pref.length)
}

const argValuesOf = (argv: readonly string[], flag: string): string[] => {
  const out: string[] = []
  const pref = `${flag}=`
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
      out.push(argv[i + 1] as string)
      i++
    } else if (argv[i]?.startsWith(pref) === true) {
      out.push((argv[i] as string).slice(pref.length))
    }
  }
  return out
}

const ACTIONS = ["doctor", "canary", "run", "report"] as const
type TerminalAction = (typeof ACTIONS)[number]
const isTerminalAction = (raw: string): raw is TerminalAction =>
  (ACTIONS as readonly string[]).includes(raw)

/** EXHAUSTIVE over the registered actions — adding one to `ACTIONS` without a
 *  branch here is a COMPILE error, not a silent fall-through to usage. */
const dispatchAction = async (
  action: TerminalAction,
  deps: CmdTerminalDeps,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): Promise<number> => {
  switch (action) {
    case "doctor":
      return actionDoctor(deps, env, argv)
    case "canary":
      return actionCanary(deps)
    case "run":
      return actionRun(deps, env, argv)
    case "report":
      return await actionReport(deps, argv)
  }
}

/**
 * Nested action dispatch. Every action shares the ONE config resolution, so the
 * `--dataset-family` refusal happens on every terminal invocation, not only on
 * `run`.
 */
export const cmdTerminal = async (deps: CmdTerminalDeps): Promise<void> => {
  const { argv, env } = deps
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`))
  const exit = deps.exit ?? ((c: number) => process.exit(c))

  // The action is the token IMMEDIATELY after the `terminal` subcommand. Using
  // "the first non-flag token" instead would let a value leak into the action
  // slot (`terminal --profile control` ⇒ action "control"), which is the exact
  // positional-shift class `commands/shared.ts` documents.
  const start = argv.indexOf("terminal")
  const rest = argv.slice(start >= 0 ? start + 1 : 0)
  const head = rest[0]
  const action = head !== undefined && !head.startsWith("-") ? head : undefined

  try {
    // The SWE family axis is refused on EVERY terminal invocation, before the
    // action even matters — a `--dataset-family` on `terminal canary` is the
    // same category error as on `terminal run`.
    assertNoSweDatasetFamilySelector(argv, env)
    if (action === undefined) {
      write(USAGE)
      exit(0)
      return
    }
    if (!isTerminalAction(action)) {
      write(USAGE)
      exit(2)
      return
    }
    exit(await dispatchAction(action, deps, env, argv))
  } catch (err) {
    write(`quanta-bench terminal: ${errMessage(err)}`)
    exit(2)
  }
}
