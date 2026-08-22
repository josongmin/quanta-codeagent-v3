/**
 * TB21-03 / TB21-01 — `quanta-bench terminal doctor`.
 *
 * The doctor answers exactly one question: *would a paid Terminal-Bench run be
 * meaningful right now?* It is a PRECONDITION gate, so a required failure exits
 * non-zero and `terminal run` refuses to spend on a red doctor.
 *
 * ── Design constraints that are load-bearing ─────────────────────────────────
 *
 *  - **Injected ports.** Every external probe goes through `DoctorPorts.run`, so
 *    the FAILURE arms are provable without a Docker daemon and the doctor itself
 *    never becomes a thing that only works on the operator's laptop.
 *  - **Presence, never value.** Credentials are checked for PRESENCE by NAME. No
 *    check detail, and no rendered receipt line, may contain a credential value
 *    or enumerate the environment — a diagnostic that leaks a key is worse than
 *    no diagnostic. `doctor.test.ts` asserts both directions.
 *  - **Bounded receipts.** `git rev-parse` output is truncated to a sha, not
 *    pasted; an unbounded subprocess dump in a diagnostic is how secrets escape.
 *
 * ── What this module deliberately does NOT re-check ──────────────────────────
 *
 * The harbor PIN, the README's single custom-agent flag and the canonical
 * dataset naming already have byte-level rails in
 * `adapters/terminal-bench/tests/test_harbor_pin.py`. Duplicating them here
 * would create a second, drifting authority; the doctor instead checks the
 * things only a live machine can answer.
 */

import type { ReasoningEffortRecord, TerminalProvider, TerminalSandbox } from "./config"
import { EXPECTED_TASK_COUNT, TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import {
  ADAPTER_PROJECT,
  CREDENTIAL_ENV_NAMES,
  HARBOR_AGENT_SELECTOR,
  isSecretEnvName,
} from "./harbor-command"

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DoctorPorts {
  readonly run: (bin: string, args: readonly string[]) => RunResult
  readonly env: NodeJS.ProcessEnv
  readonly canWriteDir: (path: string) => boolean
}

export interface DoctorCheck {
  readonly id: string
  /** A failing REQUIRED check makes the doctor non-zero and blocks a paid run. */
  readonly required: boolean
  readonly ok: boolean
  /** Operator-facing, BOUNDED, and never a credential value. */
  readonly detail: string
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
  readonly ok: boolean
  readonly exitCode: number
}

export interface DoctorInput {
  readonly model: string
  readonly provider: TerminalProvider
  readonly effort: ReasoningEffortRecord
  readonly sandbox: TerminalSandbox
  readonly outputRoot: string
}

/** The inventory of checks the doctor must always produce. Exported so the
 *  hellgate can assert a known FLOOR: a doctor that silently stopped emitting a
 *  subject would otherwise stay green with fewer checks. */
export const REQUIRED_DOCTOR_CHECKS = [
  "repo-sha",
  "repo-dirty",
  "bun",
  "python",
  "uv",
  "harbor",
  "docker",
  "docker-daemon",
  "agent-import",
  "brain-shim",
  "dataset-identity",
  "sandbox",
  "credentials",
  "model-effort",
  "output-dir",
] as const

const MAX_DETAIL = 100
const bound = (s: string): string => {
  const oneLine = s.replace(/\s+/g, " ").trim()
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL)}…` : oneLine
}

const firstLine = (s: string): string => (s.split("\n")[0] ?? "").trim()

/** The python probe. Prints ONE json object describing the agent class; it never
 *  echoes the environment. Kept as a `-c` script so the doctor has no second
 *  file to keep in sync with the adapter. */
const AGENT_PROBE = [
  "import json",
  "from harbor.agents.base import BaseAgent",
  "import quanta_agent",
  "k = quanta_agent.QuantaAgent",
  "print(json.dumps({",
  " 'module': 'quanta_agent',",
  " 'klass': k.__name__,",
  " 'isBaseAgentSubclass': issubclass(k, BaseAgent),",
  " 'abstractMethods': sorted(getattr(k, '__abstractmethods__', set())),",
  " 'supportsAtif': bool(getattr(k, 'SUPPORTS_ATIF', False)),",
  "}))",
].join("\n")

interface AgentProbe {
  readonly module?: unknown
  readonly klass?: unknown
  readonly isBaseAgentSubclass?: unknown
  readonly abstractMethods?: unknown
  readonly supportsAtif?: unknown
}

const checkAgentImport = (ports: DoctorPorts): DoctorCheck => {
  const r = ports.run("uv", ["run", "--project", ADAPTER_PROJECT, "python", "-c", AGENT_PROBE])
  if (r.code !== 0) {
    return {
      id: "agent-import",
      required: true,
      ok: false,
      detail: bound(`${HARBOR_AGENT_SELECTOR} did not import: ${r.stderr || r.stdout}`),
    }
  }
  let probe: AgentProbe
  try {
    probe = JSON.parse(firstLine(r.stdout) === "" ? r.stdout : r.stdout) as AgentProbe
  } catch {
    return {
      id: "agent-import",
      required: true,
      ok: false,
      detail: bound(`agent probe produced no JSON: ${r.stdout}`),
    }
  }
  const abstract = Array.isArray(probe.abstractMethods) ? probe.abstractMethods : ["<unknown>"]
  const problems: string[] = []
  if (probe.klass !== "QuantaAgent") problems.push(`class is ${String(probe.klass)}`)
  if (probe.isBaseAgentSubclass !== true) problems.push("not a BaseAgent subclass")
  if (abstract.length > 0) problems.push(`abstract methods open: ${abstract.join(",")}`)
  if (probe.supportsAtif !== true) problems.push("SUPPORTS_ATIF is not True")
  return {
    id: "agent-import",
    required: true,
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${HARBOR_AGENT_SELECTOR}: BaseAgent subclass, 0 abstract, SUPPORTS_ATIF`
        : bound(`${HARBOR_AGENT_SELECTOR}: ${problems.join("; ")}`),
  }
}

const versionCheck = (
  id: string,
  ports: DoctorPorts,
  bin: string,
  args: readonly string[],
): DoctorCheck => {
  const r = ports.run(bin, args)
  return {
    id,
    required: true,
    ok: r.code === 0,
    detail:
      r.code === 0 ? bound(firstLine(r.stdout)) : bound(`${bin} failed: ${r.stderr || r.stdout}`),
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/

const checkRepo = (ports: DoctorPorts): readonly DoctorCheck[] => {
  const head = ports.run("git", ["rev-parse", "--short=12", "HEAD"])
  const sha = firstLine(head.stdout)
  const shaOk = head.code === 0 && SHA_RE.test(sha)
  const status = ports.run("git", ["status", "--porcelain"])
  const dirty = status.stdout.trim() !== ""
  return [
    {
      id: "repo-sha",
      required: true,
      ok: shaOk,
      // BOUNDED: a sha, never the subprocess dump.
      detail: shaOk
        ? `HEAD ${sha}`
        : bound(`git rev-parse did not yield a sha: ${sha.slice(0, 40)}`),
    },
    {
      id: "repo-dirty",
      required: false,
      ok: true,
      detail: dirty
        ? "worktree is DIRTY — the run is usable for development but is NOT promotable"
        : "worktree is clean",
    },
  ]
}

const checkCredentials = (ports: DoctorPorts): DoctorCheck => {
  // PRESENCE ONLY. Values are never read into a detail, and the names are the
  // documented minimum the adapter needs.
  const present = CREDENTIAL_ENV_NAMES.filter((name) => {
    const v = ports.env[name]
    return typeof v === "string" && v.trim() !== ""
  })
  return {
    id: "credentials",
    required: true,
    ok: present.length > 0,
    detail:
      present.length > 0
        ? `present (values redacted): ${present.join(", ")}`
        : `none of ${CREDENTIAL_ENV_NAMES.join(", ")} is set`,
  }
}

const checkSandbox = (sandbox: TerminalSandbox, dockerOk: boolean): DoctorCheck => {
  if (sandbox === "docker") {
    return {
      id: "sandbox",
      required: true,
      ok: dockerOk,
      detail: dockerOk ? "docker environment reachable" : "docker daemon is not reachable",
    }
  }
  return {
    id: "sandbox",
    required: true,
    ok: false,
    detail: `${sandbox} availability cannot be attested by this doctor (only docker is verifiable)`,
  }
}

/** Run every check. PURE with respect to the injected ports. */
export const runTerminalDoctor = (ports: DoctorPorts, input: DoctorInput): DoctorReport => {
  const dockerDaemon = ports.run("docker", ["info", "--format", "{{.ServerVersion}}"])
  const dockerDaemonOk = dockerDaemon.code === 0
  const brainCmd = ports.env.QUANTA_TERMINAL_BRAIN_CMD ?? "quanta-terminal-brain"

  const checks: DoctorCheck[] = [
    ...checkRepo(ports),
    versionCheck("bun", ports, "bun", ["--version"]),
    versionCheck("python", ports, "python3", ["--version"]),
    versionCheck("uv", ports, "uv", ["--version"]),
    versionCheck("harbor", ports, "uv", [
      "run",
      "--project",
      ADAPTER_PROJECT,
      "harbor",
      "--version",
    ]),
    versionCheck("docker", ports, "docker", ["--version"]),
    {
      id: "docker-daemon",
      required: true,
      ok: dockerDaemonOk,
      detail: dockerDaemonOk
        ? bound(`daemon reachable: ${firstLine(dockerDaemon.stdout)}`)
        : bound(`daemon unreachable: ${dockerDaemon.stderr || dockerDaemon.stdout}`),
    },
    checkAgentImport(ports),
    versionCheck("brain-shim", ports, brainCmd, ["--version"]),
    {
      id: "dataset-identity",
      required: true,
      ok: true,
      // The pinned identity, spelled out. Never a shorthand and never `latest`.
      detail: `${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF} (${EXPECTED_TASK_COUNT} tasks)`,
    },
    checkSandbox(input.sandbox, dockerDaemonOk),
    checkCredentials(ports),
    {
      id: "model-effort",
      required: true,
      ok: input.model.trim() !== "" && input.effort.delivered !== null,
      detail:
        input.effort.delivered === null
          ? `model ${input.model} / ${input.provider}: no reasoning effort would reach the provider`
          : `model ${input.model} / ${input.provider}, effort ${input.effort.delivered}`,
    },
    {
      id: "output-dir",
      required: true,
      ok: ports.canWriteDir(input.outputRoot),
      detail: ports.canWriteDir(input.outputRoot)
        ? `writable: ${input.outputRoot}`
        : `NOT writable: ${input.outputRoot}`,
    },
  ]

  // Defence in depth: no detail may carry a credential VALUE, whatever a
  // subprocess printed. This is a scrub, not a hope.
  const scrubbed = checks.map((c) => ({ ...c, detail: scrubSecrets(c.detail, ports.env) }))
  const failed = scrubbed.filter((c) => c.required && !c.ok)
  return { checks: scrubbed, ok: failed.length === 0, exitCode: failed.length === 0 ? 0 : 1 }
}

/** Replace any live credential VALUE with a `[redacted:NAME]` marker. */
export const scrubSecrets = (text: string, env: NodeJS.ProcessEnv): string => {
  let out = text
  for (const [name, value] of Object.entries(env)) {
    if (!isSecretEnvName(name)) continue
    if (typeof value !== "string" || value.length < 8) continue
    out = out.split(value).join(`[redacted:${name}]`)
  }
  return out
}

/** Render the doctor's verdict. Prints CHECKS ONLY — never the environment. */
export const formatDoctorReceipt = (report: DoctorReport): string => {
  const lines = ["terminal-bench 2.1 doctor"]
  for (const c of report.checks) {
    const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn"
    lines.push(`  [${mark}] ${c.id.padEnd(18)} ${c.detail}`)
  }
  lines.push(
    report.ok
      ? "  → ready"
      : `  → BLOCKED: ${report.checks
          .filter((c) => c.required && !c.ok)
          .map((c) => c.id)
          .join(", ")}`,
  )
  return lines.join("\n")
}
