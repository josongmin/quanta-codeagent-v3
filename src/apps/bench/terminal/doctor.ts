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

import { quantaHomeDirFrom } from "@/shared"
import { sliceWholeChars } from "@/shared/slice-whole-chars"
import type { ReasoningEffortRecord, TerminalProvider, TerminalSandbox } from "./config"
import { EXPECTED_TASK_COUNT, TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import { ADAPTER_PROJECT, HARBOR_AGENT_SELECTOR, isSecretEnvName } from "./harbor-command"

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DoctorPorts {
  readonly run: (bin: string, args: readonly string[]) => RunResult
  readonly env: NodeJS.ProcessEnv
  readonly canWriteDir: (path: string) => boolean
  /** PRESENCE of a file, never its contents. Used for the `chatgpt-oauth` token
   *  bundle: the doctor must be able to say "the credential is there" without
   *  ever opening a file that holds a bearer token. */
  readonly fileExists: (path: string) => boolean
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
  // Surrogate-safe: `detail` carries arbitrary probe output (docker/python
  // stderr, dataset ids) that can contain astral code points; a raw
  // `.slice(0, MAX_DETAIL)` can cut a surrogate PAIR in half and emit a lone
  // high surrogate (→ U+FFFD on the wire). Pinned by the surrogate-safe
  // truncation ratchet.
  return oneLine.length > MAX_DETAIL ? `${sliceWholeChars(oneLine, MAX_DETAIL)}…` : oneLine
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
  /** The command that fixes this check, for the FAILURE detail only. A
   *  precondition gate that says "missing" without saying "run this" costs an
   *  operator a source dive before every paid run. */
  remedy?: string,
): DoctorCheck => {
  const r = ports.run(bin, args)
  const probe = `${bin} failed: ${r.stderr || r.stdout}`
  // The remedy goes FIRST. `bound` truncates at MAX_DETAIL, and a probe error
  // ("Executable not found in $PATH: …") is easily long enough on its own to eat
  // the whole budget — measured: appending the remedy rendered it as a bare "—…".
  // The actionable half must be the half that survives; the probe text is the
  // part an operator can lose without losing the fix.
  const failure = remedy === undefined ? probe : `${remedy} · probe: ${probe}`
  return {
    id,
    required: true,
    ok: r.code === 0,
    detail: bound(r.code === 0 ? firstLine(r.stdout) : failure),
  }
}

/**
 * Harbor launches the Python hands ON THE HOST, so the brain shim must be on the
 * host's PATH. Until aug-22 the shim's only definition was inside the adapter
 * Dockerfile, so no host had one and this check could not pass anywhere — the
 * reason no 2.1 canary had ever started. Name the install command here so the
 * next operator spends a second on it, not an afternoon.
 */
const BRAIN_SHIM_REMEDY = "run `bun run install:terminal-brain`"

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

/**
 * WHERE each terminal provider's credential lives. Exhaustive
 * `Record<TerminalProvider, …>`, so adding a provider is a compile error here
 * rather than a silent fall-through to "any env key will do".
 *
 * aug-22 audit — this used to be one hardcoded list of three env names applied
 * to every provider, and it was wrong in both directions against the real CLI:
 *
 *  - `--provider openai` with only `ANTHROPIC_API_KEY` set rendered `[ok]`. The
 *    gate exists to answer "would a paid run be meaningful right now?" and it
 *    greenlit a run that 401s on its first call — the jul-03 crater shape, where
 *    a box dying on auth is indistinguishable from a model scoring zero.
 *  - `--provider chatgpt-oauth` was REFUSED for lacking env keys that provider
 *    never reads; its credential is the on-disk token bundle, and that is how
 *    every other quanta bench path authenticates.
 *
 * The `kind` field is cross-checked against `PROVIDER_CREDENTIALS`
 * (`@/llm/provider-metadata`, the credential-model SSOT) by `doctor.test.ts`, so
 * this table cannot drift away from what the provider layer actually does.
 */
export const TERMINAL_CREDENTIAL_REQUIREMENT: Record<
  TerminalProvider,
  { readonly kind: "env"; readonly envName: string } | { readonly kind: "file" }
> = {
  openai: { kind: "env", envName: "OPENAI_API_KEY" },
  anthropic: { kind: "env", envName: "ANTHROPIC_API_KEY" },
  "chatgpt-oauth": { kind: "file" },
}

/** The token bundle `chatgpt-oauth` authenticates from, under the resolved
 *  quanta home. Resolved from the INJECTED env, never a global singleton. */
const chatgptBundlePath = (env: NodeJS.ProcessEnv): string =>
  `${quantaHomeDirFrom(env as Record<string, string | undefined>)}/auth/chatgpt.json`

const checkCredentials = (ports: DoctorPorts, provider: TerminalProvider): DoctorCheck => {
  // PRESENCE ONLY, on every arm. No value is read into a detail, and the file
  // arm stats the bundle rather than opening it.
  const req = TERMINAL_CREDENTIAL_REQUIREMENT[provider]
  if (req.kind === "file") {
    const path = chatgptBundlePath(ports.env)
    const ok = ports.fileExists(path)
    return {
      id: "credentials",
      required: true,
      ok,
      detail: bound(
        ok
          ? `${provider}: token bundle present at ${path}`
          : `${provider} authenticates from ${path}, which is absent — run \`quanta login\``,
      ),
    }
  }
  const raw = ports.env[req.envName]
  const ok = typeof raw === "string" && raw.trim() !== ""
  return {
    id: "credentials",
    required: true,
    ok,
    detail: ok
      ? `present (value redacted): ${req.envName}`
      : `${provider} needs ${req.envName}, which is not set`,
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
    versionCheck("brain-shim", ports, brainCmd, ["--version"], BRAIN_SHIM_REMEDY),
    {
      id: "dataset-identity",
      required: true,
      ok: true,
      // The pinned identity, spelled out. Never a shorthand and never `latest`.
      detail: `${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF} (${EXPECTED_TASK_COUNT} tasks)`,
    },
    checkSandbox(input.sandbox, dockerDaemonOk),
    checkCredentials(ports, input.provider),
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
