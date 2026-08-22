/**
 * TB21-03 — Harbor argv construction. The ONLY place a `harbor run` command is
 * built.
 *
 * ⚠️ This module BUILDS a command; it never runs one. Execution is a port the
 * command layer injects, so every rail in `harbor-command.test.ts` can assert on
 * a real argv without provisioning a container or billing a provider.
 *
 * ── Why the flags are what they are ──────────────────────────────────────────
 *
 * Every spelling below was read out of the PINNED harbor 0.21.0 CLI
 * (`harbor/cli/jobs.py` `start`), not from memory:
 *
 *   -d/--dataset  `name@version`      -a/--agent  `module:Class` (0.16's
 *   -m/--model                        `--agent-import-path` is retired)
 *   --ak/--agent-kwarg `k=v`          --ae/--agent-env `K=V`
 *   -e/--env  environment type        -k/--n-attempts   -n/--n-concurrent
 *   -o/--jobs-dir                     -i/--include-task-name
 *   --timeout-multiplier              --upload  --public/--private
 *
 * ── The two delivery channels, and why both are used ─────────────────────────
 *
 *  - `--ak reasoning_effort=<v>` is the AGENT KWARG. It has to be a kwarg because
 *    the upstream leaderboard reads a submission's effort from
 *    `config.agents[].kwargs.reasoning_effort` (`leaderboard/flows/filter.py`);
 *    delivering it only through the env produces a row that reads `"none"`.
 *  - `--ae KEY=VALUE` is the AGENT ENV. Harbor hands it to the agent as
 *    `extra_env`, and the adapter overlays it ON TOP of `os.environ`
 *    (`QuantaAgent._brain_run_env`), so an `--ae` value WINS over an operator's
 *    stale shell export. That is precisely the property that makes a profile
 *    authoritative, so every resolved knob rides this channel.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 *
 * Credentials are NEVER placed in argv: a command line is visible in `ps`, in
 * shell history and in any log that echoes the invocation. They reach the brain
 * by inheritance through the host env. The dry-run receipt therefore prints
 * NAMES with redacted values, and `buildHarborRunCommand` refuses outright if any
 * argv token would carry a live credential value.
 */
import { encodeKnobValue } from "./config"
import { TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import { AGENT_VERSION_ENV, type TerminalBenchRunManifest } from "./manifest"

// Re-exported so the delivery layer stays the one place a caller has to look at
// for "what goes on the wire"; the DECLARATION lives with the provenance it
// names (`./manifest`), which is also the knob-inventory readSite.
export { AGENT_VERSION_ENV }

/** The custom-agent selector harbor 0.21.0 accepts (a `:` in `--agent` is an
 *  import path — `AgentFactory.create_agent_from_config`). */
export const HARBOR_AGENT_SELECTOR = "quanta_agent:QuantaAgent"

/** The locked adapter project. Running harbor any other way bypasses `uv.lock`. */
export const ADAPTER_PROJECT = "adapters/terminal-bench"

/** The knob the brain's LLM composition root reads for reasoning effort. */
export const REASONING_EFFORT_ENV = "QUANTA_REASONING_EFFORT"

/** Env NAME suffixes that mark a credential. Mirrors the adapter's redaction
 *  authority (`quanta_terminal_atif.SECRET_ENV_NAME_SUFFIXES`) so both halves
 *  scrub the same set. */
export const SECRET_ENV_NAME_SUFFIXES = [
  "_API_KEY",
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
] as const

/** Credential env names the adapter documents as the minimum a box must supply. */
export const CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "QUANTA_API_KEY",
] as const

export const isSecretEnvName = (name: string): boolean =>
  SECRET_ENV_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))

export interface HarborRunCommand {
  readonly bin: string
  readonly argv: readonly string[]
  /** The manifest the command was built from — carried so a receipt renderer
   *  never has to re-derive an identity. */
  readonly manifest: TerminalBenchRunManifest
}

/**
 * The env delivered to the brain via `--ae`. Derived ONLY from the typed
 * manifest — no ambient read — so the delivered values are exactly the recorded
 * ones.
 */
export const buildBrainDeliveryEnv = (
  manifest: TerminalBenchRunManifest,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(manifest.resolvedKnobs)) {
    out[key] = encodeKnobValue(value)
  }
  out[AGENT_VERSION_ENV] = manifest.agentVersion
  out[REASONING_EFFORT_ENV] = manifest.reasoningEffort
  return out
}

/** Refuse an argv that would put a live credential VALUE on a command line. */
export const assertNoSecretValuesInArgv = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void => {
  const line = argv.join("\x00")
  for (const [name, value] of Object.entries(env)) {
    if (!isSecretEnvName(name)) continue
    if (value === undefined || value.length < 8) continue
    if (line.includes(value)) {
      throw new Error(
        `terminal: REFUSING to build a harbor command that carries the value of ${name} in argv. ` +
          "A command line is visible in `ps`, in shell history and in any log that echoes the " +
          "invocation; credentials reach the brain by env inheritance, never as an argument.",
      )
    }
  }
}

export interface HarborCommandOptions {
  readonly outputRoot: string
  /** The env the command will INHERIT. Used only for the secret-leak guard and
   *  the receipt's name list — never as a value source. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Build the full `uv run --project … harbor run …` invocation. Pure. */
export const buildHarborRunCommand = (
  manifest: TerminalBenchRunManifest,
  options: HarborCommandOptions,
): HarborRunCommand => {
  const argv: string[] = [
    "run",
    "--project",
    ADAPTER_PROJECT,
    "harbor",
    "run",
    "-d",
    `${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF}`,
    "--agent",
    HARBOR_AGENT_SELECTOR,
    "-m",
    manifest.model,
    "--ak",
    `reasoning_effort=${manifest.reasoningEffort}`,
    "-e",
    manifest.sandbox,
    "-k",
    String(manifest.k),
    "-n",
    String(manifest.concurrency),
    "--timeout-multiplier",
    String(manifest.timeoutMultiplier),
    "-o",
    options.outputRoot,
  ]

  if (manifest.taskSelection !== "full") {
    for (const id of manifest.taskSelection.ids) argv.push("-i", id)
  }

  for (const [key, value] of Object.entries(buildBrainDeliveryEnv(manifest))) {
    argv.push("--ae", `${key}=${value}`)
  }

  if (manifest.upload.enabled) {
    argv.push("--upload")
    argv.push(manifest.upload.visibility === "public" ? "--public" : "--private")
  }

  assertNoSecretValuesInArgv(argv, options.env ?? {})
  return { bin: "uv", argv, manifest }
}

/** Shell-safe-ish rendering for the receipt. Not an executor — the command is
 *  spawned as an argv vector, never through a shell. */
const quote = (tok: string): string => (/^[A-Za-z0-9@:/._=+-]+$/.test(tok) ? tok : `'${tok}'`)

/**
 * The dry-run receipt: the FINAL argv plus the env NAMES that will be inherited,
 * with every value redacted. Values never appear — the point of the receipt is
 * that an operator can audit a paid command without the audit itself becoming a
 * credential leak.
 */
export const formatHarborDryRunReceipt = (
  command: HarborRunCommand,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const { manifest } = command
  const inherited = CREDENTIAL_ENV_NAMES.filter((name) => env[name] !== undefined)
  const lines: string[] = [
    "terminal-bench 2.1 dry-run receipt",
    `  profile / arm     ${manifest.profile}`,
    `  dataset           ${manifest.dataset}@${manifest.datasetRef}`,
    `  harbor            ${manifest.harborVersion} (pinned, ${ADAPTER_PROJECT}/uv.lock)`,
    `  agent version     ${manifest.agentVersion}`,
    `  model / provider  ${manifest.model} / ${manifest.provider}`,
    `  reasoning effort  ${manifest.reasoningEffort} (requested ${manifest.reasoningEffortDecision.requested}, ${manifest.reasoningEffortDecision.kind})`,
    `  sandbox           ${manifest.sandbox}`,
    `  k / concurrency   ${manifest.k} / ${manifest.concurrency}`,
    `  tasks             ${manifest.taskSelection === "full" ? "full dataset (89)" : `${manifest.taskSelection.purpose}: ${manifest.taskSelection.ids.join(", ")}`}`,
    `  upload            ${manifest.upload.enabled ? `yes (${manifest.upload.visibility})` : "no"}`,
    `  promotable        ${manifest.promotable}${manifest.promotionBlockers.length > 0 ? ` (blocked: ${manifest.promotionBlockers.join(", ")})` : ""}`,
    "",
    "final command:",
    `  ${quote(command.bin)} ${command.argv.map(quote).join(" ")}`,
    "",
    "inherited credential env (NAMES only — values REDACTED, never printed):",
    ...(inherited.length > 0
      ? inherited.map((name) => `  ${name}=<redacted>`)
      : [
          // PROVIDER-AWARE, like the doctor's credentials check. `chatgpt-oauth`
          // authenticates from an on-disk token bundle and reads no env key, so
          // "none present" there is the NORMAL state — printing "the run would
          // have no provider credential" told an operator with a perfectly good
          // setup to abort. The env-key providers keep the warning, because for
          // them an empty list really does mean the run cannot authenticate.
          manifest.provider === "chatgpt-oauth"
            ? "  (none — chatgpt-oauth authenticates from its on-disk token bundle, not env)"
            : "  (none present — the run would have no provider credential)",
        ]),
  ]
  return lines.join("\n")
}
