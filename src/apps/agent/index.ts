/**
 * `apps/agent/index.ts` — RFC may-22-unified-agent-runtime / Phase 4 entry.
 *
 * The single argv→mode dispatcher. Owns ZERO mode wiring: each mode-preset
 * module under `./mode-presets/<mode>.ts` exports its own `runMode(req)` and
 * builds its own surface-specific AgentConfig core. The entry just routes.
 *
 * Hard rules (RFC may-22 / Phase 4):
 *  • NO scattered `process.env.X` reads here. `runtimeConfig()` owns the
 *    typed env knobs; provider/key resolution is delegated to the `@/llm`
 *    factory, which receives `process.env` ONCE at this composition root
 *    (the factory itself never touches the global env — see factory.ts).
 *  • NO silent defaults. Defaults flow from `BUDGET_PRESETS` via
 *    `assembleAgentConfig`, not from this file.
 *  • mode-presets are loaded via DYNAMIC import so this file is decoupled
 *    from Worker B's per-mode wiring contract (different presets ship at
 *    different times).
 *
 * Exit codes are owned by `./run.ts` (POSIX-style); this file only emits
 *   • exit 64 (EX_USAGE) on argv error, plus a usage dump to stderr;
 *   • exit 0 on `--help` (after a usage dump to stdout).
 */

import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import * as readline from "node:readline/promises"
import { makeTrustPersistence } from "@/host/trust-persist"
import { installResolvedWorkspaceTrust } from "@/host/workspace-trust"
import { buildSearchPipelineFromEnv, clearSearchPipelineWireForTests } from "@/runner/assemble"
import { scrubUntrustedEgressRedirectsWithWarn } from "@/shared/egress-provenance-guard"
import { envFileSourceOf, loadEnvFiles } from "@/shared/env-files"

loadEnvFiles([".env.dev", ".env.local", ".env"])
// SEC-1 — quarantine dotenv-sourced API egress-redirect keys at the trust boundary.
scrubUntrustedEgressRedirectsWithWarn(process.env, envFileSourceOf, (m) => logger.warn(m))

import { loadNamedAgents } from "@/agent"
import { loadCommandHookBindings } from "@/agent/command-hooks"
import { bindingsFromHookEvents } from "@/agent/command-hooks/settings-loader"
import type { CommandHookBinding } from "@/agent/command-hooks/types"
import { installWorkspaceTrustAuthority, UNTRUSTED_EVERYWHERE } from "@/agent/workspace-trust"
import {
  canonicalizeTrustedPaths,
  mergeDiskLayers,
  osManagedSettingsPath,
  parseSettingSources,
  type ReadTextPort,
  readDiskLayers,
  type TrustPersistencePort,
  TrustStore,
} from "@/config"
// ADR-0303 thin-surface relocation — the env-READING "argv → AgentConfig base"
// composition builder + the pure argv parser moved DOWN into `@/host/runtime`
// so `apps/cli`'s `batch` subcommand reaches them without a sideways
// `cli → apps/agent` cross-surface import. This surface entry imports the
// symbols `runMain`/`liftToAssembleRequest` still call (a surface reaching DOWN
// into `@/host` is allowed) and re-exports the full public API below so the
// existing `@/apps/agent` barrel importers (mode-presets + the unit/hellgate
// tests) are byte-identical.
import {
  type AssembleRequestPartial,
  buildBaseFromArgs,
  resolveLocalEnvSelection,
  toAssembleRequest,
} from "@/host/runtime/agent-arg-builder"
import {
  type AgentArgs,
  AgentArgsError,
  formatHelp,
  parseAgentArgs,
} from "@/host/runtime/agent-args"
import { installOtelSpanExportFromEnv } from "@/observability/otel-span-export"
import { errMessage, gateOn, logger, quantaHomeDir, runtimeConfig, setTerminalIo } from "@/shared"
import type { AssembleRequest } from "./assemble"

export { buildSearchPipelineFromEnv, clearSearchPipelineWireForTests }

import type { RunOutcome } from "./run"

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

export {
  buildProfileDefinitionRegistry,
  installCommandHooksIntoBase,
  PERMISSION_PROFILE_SESSION_THREAD,
  pickMcpNegotiator,
  resolveLayeredProfileSlots,
  resolveObservabilityWire,
  resolvePermissionModeFromProfile,
  resolvePermissionProfileManager,
  resolvePolicyMergeStrategy,
} from "@/host/runtime/agent-arg-builder"
export type {
  IdentityModeToken,
  PermissionProfileToken,
  ProviderToken,
  ToolProfileToken,
} from "@/host/runtime/agent-args"
// ADR-0303 thin-surface relocation — re-export the moved composition-builder +
// parser symbols so existing `@/apps/agent` barrel importers (mode-presets and
// the unit/hellgate tests) resolve them unchanged. The definitions now live in
// `@/host/runtime/{agent-arg-builder,agent-args}`. Symbols `runMain` already
// imports above are re-exported as LOCAL bindings; the rest are pass-through
// `export … from` re-exports.
export type { AgentArgs, AssembleRequestPartial }
export {
  AgentArgsError,
  buildBaseFromArgs,
  formatHelp,
  parseAgentArgs,
  resolveLocalEnvSelection,
  toAssembleRequest,
}

/** The `headless` extras block for a parsed argv that carries a prompt.
 *  A unit because P26's structured-output flags only ever reach the request
 *  through THIS block: absent ⇒ each spread is `{}` ⇒ exactly `{ prompt }`,
 *  the byte-identical legacy text path. `prompt` is passed narrowed so the
 *  caller's presence check stays the single gate. */
const headlessExtrasFrom = (
  p: AssembleRequestPartial,
  prompt: string,
): NonNullable<AssembleRequest["headless"]> => ({
  prompt,
  ...(p.outputFormat ? { output: p.outputFormat } : {}),
  ...(p.includePartial ? { includePartial: true } : {}),
})

/** The `batch` extras block for a parsed argv that names a corpus. A unit
 *  because every optional batch path (instance filter, predictions, report) is
 *  omitted-when-absent under the SAME rule, so the corpus-only invocation stays
 *  exactly `{ corpus }`. */
const batchExtrasFrom = (
  p: AssembleRequestPartial,
  corpus: NonNullable<AssembleRequestPartial["corpus"]>,
): NonNullable<AssembleRequest["batch"]> => ({
  corpus,
  ...(p.instance !== undefined ? { instance: p.instance } : {}),
  ...(p.predictions !== undefined ? { predictionsPath: p.predictions } : {}),
  ...(p.report !== undefined ? { reportPath: p.report } : {}),
})

/** The `ci-bot` extras block for a parsed argv that names a PR. A unit for the
 *  same reason as its siblings: dry-run is omitted-when-false so the plain
 *  invocation stays exactly `{ pr }`. */
const ciBotExtrasFrom = (
  p: AssembleRequestPartial,
  pr: NonNullable<AssembleRequestPartial["pr"]>,
): NonNullable<AssembleRequest["ciBot"]> => ({
  pr,
  ...(p.ciBotDryRun ? { dryRun: true } : {}),
  ...(typeof process.env.GITHUB_RUN_ID === "string" && process.env.GITHUB_RUN_ID.trim() !== ""
    ? { runId: process.env.GITHUB_RUN_ID }
    : {}),
  ...(typeof process.env.GITHUB_REPOSITORY === "string" &&
  process.env.GITHUB_REPOSITORY.trim() !== ""
    ? { repoSlug: process.env.GITHUB_REPOSITORY }
    : {}),
})

const applyModeSpecificRequestFields = (out: AssembleRequest, p: AssembleRequestPartial): void => {
  if (p.mode === "headless" && p.prompt !== undefined) {
    out.headless = headlessExtrasFrom(p, p.prompt)
    return
  }
  if (p.mode === "batch" && p.corpus !== undefined) {
    out.batch = batchExtrasFrom(p, p.corpus)
    return
  }
  if (p.mode === "ci-bot" && p.pr !== undefined) {
    out.ciBot = ciBotExtrasFrom(p, p.pr)
  }
}

/** Per-mode dispatcher contract. Each `./mode-presets/<mode>.ts` exports this. */
export interface ModeDispatcher {
  runMode: (req: AssembleRequest) => Promise<RunOutcome>
}

/**
 * Test seam — `runMain` accepts injected `argv`, `loadDispatcher`, and IO
 * sinks so unit tests can route to spy dispatchers without forking a process.
 */
export interface MainDeps {
  argv?: readonly string[]
  loadDispatcher?: (mode: AssembleRequest["mode"]) => Promise<ModeDispatcher>
  stdout?: (s: string) => void
  stderr?: (s: string) => void
  exit?: (code: number) => void
  /** T01 (audit L5 H-2): test seam to inject the cancellation signal instead of
   *  letting `runMain` own a SIGINT-wired controller. Tests that don't want a
   *  real `process.on("SIGINT")` side effect pass their own signal here. */
  signal?: AbortSignal
}

/** Default loader — dynamic import keeps `index.ts` decoupled from preset shape. */
const defaultLoadDispatcher = async (mode: AssembleRequest["mode"]): Promise<ModeDispatcher> => {
  const mod = (await import(`./mode-presets/${mode}`)) as ModeDispatcher
  return mod
}

// ── ADR-0497 jun-7-misc 05 — central-config disk loader + per-project trust
//    gate host wire. The concrete closed ports the composition root injects into
//    the (pure) `@/config` slice: a `node:fs` text read and a `~/.quanta/trust.json`
//    persistence read/write. These are constructed ONLY on the central (knob-ON)
//    branch — the default-OFF legacy path never allocates them, never touches the
//    trust file, never reads a config layer. ──────────────────────────────────

/** Concrete `node:fs` ReadTextPort for the @/config loader. ENOENT/ENOTDIR ⇒
 *  absent (undefined), parity with the legacy `loadCommandHookBindings` reader. */
const fsReadText: ReadTextPort = async (path) => {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    // Audit R1 #4 — a present-but-unreadable layer (EACCES, e.g. a root-owned
    // `/etc/quanta/managed-settings.json` with 600 perms) must NOT crash boot.
    // Treat it as absent (no contribution) + log; ticket-05-③ made `managedPath`
    // always-returned, so without this a stray perms bit would DoS every session.
    if (code === "EACCES" || code === "EISDIR" || code === "EPERM") {
      logger.warn(`[quanta] central config: cannot read ${path} (${code}) — skipping layer`)
      return undefined
    }
    throw err
  }
}

/** §P7 (ticket-05-①) — the concrete interactive trust prompt. A one-shot
 *  readline `[y/N]` ONLY on a real interactive terminal (both stdin+stdout
 *  TTYs); a non-TTY (headless / piped / CI) returns `false` WITHOUT reading, so
 *  boot never blocks on input. Grant ⇒ the caller persists trust + re-resolves. */
const defaultTrustPrompt = async (info: {
  cwd: string
  droppedLayers: readonly string[]
}): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `\n[quanta] This project ships settings (${info.droppedLayers.join(", ")}) that are IGNORED ` +
        `because it is untrusted:\n  ${info.cwd}\nTrust this project and apply its settings? [y/N] `,
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * ADR-0497 jun-7-misc 05 — resolve the agent's `CommandHookBinding[]` at the
 * async composition root, gating on `runtimeConfig().centralConfig`:
 *
 *   • OFF (knob unset / loose-truthy): the BYTE-IDENTICAL legacy path — exactly
 *     `loadCommandHookBindings(join(process.cwd(),"settings.json"))` (ADR-0454).
 *     No disk-config read, no trust-store read, no port allocation.
 *   • ON (strict `=== "1"`): the trust-gated central path — realpath the cwd,
 *     consult the `~/.quanta/trust.json` TrustStore (+ the headless
 *     `QUANTA_TRUSTED_PATHS` allow-list, NEVER auto-trusting cwd), run the real
 *     `resolveDiskConfig` over the layered settings (an UNTRUSTED repo's
 *     repo-layer hook grants are DROPPED by the merge), then flatten via
 *     `bindingsFromHookEvents`. A hostile cloned repo's `PreToolUse` command
 *     NEVER becomes a live binding unless the repo is explicitly trusted.
 *
 * Mirrors `tests/unit/central-config-trust-e2e-hellgate.test.ts`'s
 * `hostResolveCommandHooks` byte-for-byte; that E2E exercises every callee here
 * with the real modules, this is the production wire landing it.
 *
 * `deps` is a TEST SEAM ONLY (the wire-level hellgate injects a call-counting
 * read port + an in-memory trust persistence to prove the OFF branch consults
 * NEITHER). Production passes nothing ⇒ the concrete `node:fs` ports above.
 */
export interface ResolveCommandHooksDeps {
  /** Central-loader text read (default: the concrete `fsReadText`). */
  readonly read?: ReadTextPort
  /** Trust-store persistence factory keyed by the resolved trust-file path
   *  (default: the concrete `~/.quanta/trust.json` reader/writer). */
  readonly makeTrustPersistence?: (trustFilePath: string) => TrustPersistencePort
  /** §P7 (ticket-05) — sink for the "settings dropped because the project is
   *  untrusted" notice + malformed-layer warnings. Default: `logger.warn`. The
   *  gate was previously SILENT (an empty sink), so a user never learned their
   *  repo-local `.quanta/settings.json` hooks/permissions were ignored. */
  readonly warn?: (msg: string) => void
  /** §P7 (ticket-05-①) — interactive trust elevation prompt. Invoked ONLY when
   *  the project is untrusted AND has dropped loosening grants. Returning `true`
   *  persists the trust grant + re-resolves as trusted (this session honors the
   *  settings, no restart). Absent ⇒ no prompt (the warn path runs) — the headless
   *  / non-TTY / CI default, so boot never blocks on input. */
  readonly confirmTrust?: (info: {
    cwd: string
    droppedLayers: readonly string[]
  }) => Promise<boolean>
}

export const resolveCommandHookBindings = async (
  cwd: string,
  deps: ResolveCommandHooksDeps = {},
): Promise<CommandHookBinding[]> => {
  const rc = runtimeConfig()
  if (!rc.centralConfig) {
    // DEFAULT-OFF byte-identity — the ADR-0454 legacy read, verbatim. The
    // injected central `read` / trust persistence are NEVER referenced here, so
    // their call counters stay at ZERO (the wire test pins this).
    return loadCommandHookBindings(join(cwd, "settings.json"))
  }
  // ON: trust-gated central path. Realpath the cwd so symlinked / aliased repo
  // spellings canonicalize to the SAME trust key (the store stays purely
  // lexical; symlink resolution is the host's job). A realpath failure
  // (e.g. cwd removed) falls back to the raw path — still untrusted by default.
  let realCwd: string
  try {
    realCwd = await realpath(cwd)
  } catch {
    realCwd = cwd
  }
  const userConfigDir = quantaHomeDir()
  const persist = deps.makeTrustPersistence ?? makeTrustPersistence
  const store = await TrustStore.load(persist(join(userConfigDir, "trust.json")))
  const trustedFromEnv = canonicalizeTrustedPaths(
    (rc.trustedPaths ?? "").split(",").map((s) => s.trim()),
  )
  const trusted = store.isTrusted(realCwd) || trustedFromEnv.has(realCwd)
  // §P7 (ticket-05) — real warn sink (was an empty `() => {}`): surfaces both
  // malformed-layer skips AND the "dropped because untrusted" notice below.
  const warn = deps.warn ?? ((m: string) => logger.warn(m))
  // Build the resolve input ONCE so the post-trust re-resolve reuses it verbatim
  // (only `trusted` flips). §P7 ticket-05-③ managedPath = the OS lockdown file.
  const resolveInput = {
    cwd: realCwd,
    userConfigDir,
    managedPath: osManagedSettingsPath(
      process.platform,
      rc.managedSettingsPath,
      process.env.PROGRAMDATA,
    ),
    trusted,
    sources: parseSettingSources(rc.centralConfigSources),
    read: deps.read ?? fsReadText,
    warn,
  }
  // Audit R1 #5 — read the layers ONCE; merge at the two trust levels off the
  // SAME bytes (no read→prompt→re-read TOCTOU window where a repo swaps its
  // settings between the check and the post-grant re-merge).
  const layers = await readDiskLayers(resolveInput)
  const resolved = mergeDiskLayers(layers, trusted)
  if (trusted || resolved.droppedForUntrust.length === 0) {
    return bindingsFromHookEvents(resolved.hooks)
  }
  // UNTRUSTED with dropped loosening grants. §P7 ticket-05-① — offer interactive
  // elevation: if a `confirmTrust` prompt is wired AND the user grants, persist
  // the trust + RE-MERGE as trusted so THIS session honors the settings (no
  // restart, no re-read). Declined / no prompt ⇒ fall through to the warn.
  if (deps.confirmTrust !== undefined) {
    const granted = await deps.confirmTrust({
      cwd: realCwd,
      droppedLayers: resolved.droppedForUntrust,
    })
    if (granted) {
      store.setTrusted(realCwd, Date.now())
      await store.flush()
      return bindingsFromHookEvents(mergeDiskLayers(layers, true).hooks)
    }
  }
  // §P7 ticket-05-② — no longer SILENT: tell the user which untrusted layers had
  // their loosening grants (allow / hooks / mcp launchers) dropped, and how to
  // trust the project. Tightening (deny) still applied; only loosening dropped.
  warn(
    `[quanta] ${resolved.droppedForUntrust.length} setting layer(s) ignored for the untrusted ` +
      `project ${realCwd} (${resolved.droppedForUntrust.join(", ")}): allow/hooks/mcp grants are ` +
      `not honored until you trust it (add to QUANTA_TRUSTED_PATHS or the trust store).`,
  )
  return bindingsFromHookEvents(resolved.hooks)
}

/** Resolve the three inputs that can only be loaded at the ASYNC composition
 *  root — the local-env selection, the settings.json command-hook bindings, and
 *  the named-agent registry — and thread them onto the flat partial.
 *
 *  A unit because all three obey the SAME contract: default-OFF and
 *  absent-means-absent. An unset knob, a missing config file, or an empty
 *  registry leaves its field unset, so a plain boot yields a partial that is
 *  byte-identical to the legacy no-config path. They are also the only disk IO
 *  on this path, so grouping them keeps `runMain` itself pure routing.
 *
 *  Mutates `p` in place rather than returning a copy, because every later step
 *  in `runMain` reads the SAME partial object. */
const applyAsyncRootConfigSources = async (p: AssembleRequestPartial): Promise<void> => {
  // ADR-0455 jun-02 wire — load the local-env config at the async composition
  // root and thread the resolved selection onto the partial. Default-OFF: no
  // config / no selection ⇒ field stays absent ⇒ ambient env byte-identical.
  const localEnvSelection = await resolveLocalEnvSelection(process.env, process.cwd())
  if (localEnvSelection !== undefined) p.localEnv = localEnvSelection
  // ADR-0454 jun-02 wire — load command-hook bindings from settings.json#hooks at
  // the async root, ONLY when opted in, and thread onto the partial. Default-OFF:
  // knob unset ⇒ not loaded ⇒ no command hooks. The enabled-without-ack fail-fast
  // throw happens later in buildBaseFromArgs (startup, never mid-turn).
  if (gateOn(process.env, "QUANTA_COMMAND_HOOKS")) {
    // ADR-0497 jun-7-misc 05 wire — the source of the bindings is gated on
    // `runtimeConfig().centralConfig` inside `resolveCommandHookBindings`:
    // knob OFF ⇒ the EXACT ADR-0454 legacy `loadCommandHookBindings(
    // <cwd>/settings.json)` read (byte-identical, no disk-config / trust read);
    // knob ON ⇒ the trust-gated central loader (an UNTRUSTED repo's hook
    // commands are dropped before they can become live bindings).
    p.commandHookBindings = await resolveCommandHookBindings(process.cwd(), {
      // Audit R1 #6 — TTY-guard at the WIRE (defense-in-depth): only arm the
      // interactive prompt on a real terminal, so a headless / piped / CI boot
      // never even constructs a readline (the prompt ALSO self-guards, but the
      // wire-site gate means removing the inner check can't regress into a hang).
      ...(process.stdin.isTTY && process.stdout.isTTY ? { confirmTrust: defaultTrustPrompt } : {}),
    })
  }
  // Named-agent registry — load `.quanta/agents` (+ native dir) ONCE per session
  // at the async root and thread the resolver onto the partial; `buildBaseFromArgs`
  // lifts it onto `AgentConfig.namedAgentResolver` (read by the subagent runner per
  // spawn). Default-OFF byte-identical: no agent dir ⇒ EMPTY registry ⇒ field stays
  // absent ⇒ no named agent ever resolves. FAIL-OPEN: the loader already swallows an
  // absent/unreadable dir, but we guard defensively so a registry-load fault can
  // NEVER throw on the assembly path — a thrown loader yields an empty resolver.
  const namedAgents = await loadNamedAgents(process.cwd()).catch(() => undefined)
  if (namedAgents !== undefined && namedAgents.size > 0) {
    p.namedAgentResolver = namedAgents
  }
}

/**
 * Workspace trust for the headless agent process (`@/agent/workspace-trust`). ci-bot and
 * daemon run in trees an outsider wrote (a PR checkout, a webhook worktree), so nothing
 * there is trusted, whatever the operator recorded. Every other mode uses the recorded
 * decisions (`~/.quanta/trust.json`, `QUANTA_TRUSTED_PATHS`); there is no terminal to ask.
 * An argv this cannot parse leaves the fail-closed default; `runMain` reports the error.
 */
export const AGENT_MODE_WORKSPACE_TRUST: Record<AgentArgs["mode"], "recorded" | "never"> = {
  interactive: "recorded",
  headless: "recorded",
  ide: "recorded",
  batch: "recorded",
  "ci-bot": "never",
  daemon: "never",
}

const installAgentWorkspaceTrust = async (argv: readonly string[]): Promise<void> => {
  let mode: AgentArgs["mode"]
  try {
    mode = parseAgentArgs([...argv]).mode
  } catch (e) {
    if (e instanceof AgentArgsError) return
    throw e
  }
  if (AGENT_MODE_WORKSPACE_TRUST[mode] === "never") {
    installWorkspaceTrustAuthority(UNTRUSTED_EVERYWHERE)
    return
  }
  await installResolvedWorkspaceTrust({
    cwd: process.cwd(),
    trustedPaths: runtimeConfig().trustedPaths,
    warn: (message) => process.stderr.write(`${message}\n`),
  })
}

/**
 * The entry function. Pure routing — every effectful concern (IO, exit) is
 * injectable via {@link MainDeps}. Production caller at the bottom of this
 * file wires the defaults: real argv, dynamic import, stdout/stderr writers,
 * `process.exit`.
 */
export const runMain = async (deps: MainDeps = {}): Promise<void> => {
  // Touch runtimeConfig once so any startup-validation env errors surface
  // here (not deep inside a mode-preset). Result is intentionally unused —
  // we only want the validator side-effect of `loadFromEnv`. This is the
  // ONLY env touchpoint in this file, and it goes through `@/shared`.
  runtimeConfig()

  const argv = deps.argv ?? process.argv.slice(2)
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s))
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s))
  const exit = deps.exit ?? ((code) => process.exit(code))
  const loadDispatcher = deps.loadDispatcher ?? defaultLoadDispatcher

  let args: AgentArgs
  try {
    args = parseAgentArgs(argv)
  } catch (e) {
    if (e instanceof AgentArgsError) {
      stderr(`${e.message}\n${formatHelp()}\n`)
      exit(64) // POSIX EX_USAGE
      return
    }
    throw e
  }

  if (args.help) {
    stdout(formatHelp())
    return
  }

  const dispatcher = await loadDispatcher(args.mode)
  const partial = toAssembleRequest(args)
  await applyAsyncRootConfigSources(partial)

  // T01 (audit L5 H-2 / M-6): the composition root owns ONE real cancellation
  // controller and wires SIGINT to it exactly once — previously every preset
  // inherited a dead `new AbortController().signal` so Ctrl+C was silently
  // ignored in 5 of 6 modes. Tests inject `deps.signal` to avoid the real
  // `process.on` side effect; production installs the handler and detaches it
  // in `finally` so a long-lived host process never leaks listeners.
  let owned: AbortController | undefined
  let signal: AbortSignal
  let onSigint: (() => void) | undefined
  if (deps.signal !== undefined) {
    signal = deps.signal
  } else {
    owned = new AbortController()
    signal = owned.signal
    onSigint = (): void => owned?.abort()
    process.on("SIGINT", onSigint)
  }

  // Translate flat CLI shape → nested AssembleRequest the runners consume
  // (each runner reads its own mode-specific extras: req.headless / req.batch
  // / req.ciBot). The `base` is a stub — runners build the real AgentConfig
  // internally; assemble.ts only needs `base` populated for modePolicy +
  // budgetMeter, which the runners assemble themselves.
  // L5 M-11 — process-lifetime disposer registry. The search wire built inside
  // `buildBaseFromArgs` pushes its per-wire `dispose` (delta-scan setInterval +
  // indexer) here; `runMain` runs each in `finally` so this composition root
  // tears down THE wire it built, threaded per-process instead of via the
  // module singleton. Each disposer is idempotent + surfaces (does not rethrow)
  // its failure so one leaky teardown cannot mask the SIGINT-listener detach.
  const disposers: Array<() => void> = []
  const fullReq = liftToAssembleRequest(partial, signal, disposers)
  try {
    const outcome = await dispatcher.runMode(fullReq)
    exit(outcome.exitCode)
  } finally {
    runProcessDisposers(disposers, stderr)
    if (onSigint !== undefined) process.off("SIGINT", onSigint)
  }
}

/** L5 M-11 — run each process-lifetime disposer (today: the search wire's
 *  delta-scan interval + indexer teardown) exactly once on shutdown. Each is
 *  idempotent; a throw is surfaced to stderr (NOT rethrown) so one leaky
 *  teardown cannot mask the rest or the SIGINT-listener detach. Kept as a free
 *  function so the loop lives OUTSIDE `runMain`'s cognitive-complexity budget. */
const runProcessDisposers = (
  disposers: ReadonlyArray<() => void>,
  stderr: (s: string) => void,
): void => {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch (e) {
      stderr(`[teardown] search wire dispose failed: ${errMessage(e)}\n`)
    }
  }
}

/** Translate the flat CLI projection to the nested AssembleRequest shape
 *  the mode runners consume. Per-mode extras are populated only for the
 *  active mode; other slots stay undefined. The `base` is populated with
 *  an LLM built from provider/model (operator flags + env API keys) so the
 *  per-mode runner can rely on `req.base.llm` being a real adapter. */
const liftToAssembleRequest = (
  p: AssembleRequestPartial,
  signal?: AbortSignal,
  /** L5 M-11 — forwarded to `buildBaseFromArgs` so the search wire's teardown
   *  is collected for the composition root to run on process shutdown. */
  disposers?: Array<() => void>,
): AssembleRequest => {
  const base = buildBaseFromArgs(p, signal, disposers)
  const out: AssembleRequest = { mode: p.mode, base }
  if (p.dials !== undefined) out.dials = p.dials
  if (p.exhaustion !== undefined) out.exhaustion = p.exhaustion
  applyModeSpecificRequestFields(out, p)
  return out
}

// Production entry — only fires when this module is the process entry point.
// We guard so `import "./index"` in tests does NOT trigger the real loop.
// `import.meta.main` is the Bun-native check (also true under `bun run`).
if (import.meta.main) {
  // OTLP span export (ADR-0268) — boot wire for the headless/batch/ci-bot agent
  // process (separate from the CLI binary). Installed here (not in runMain) so
  // the tested `runMain(deps)` stays env-pure; Default-OFF no-op unless
  // QUANTA_OTEL_ENDPOINT is set. The unref'd flush timer ships steady-state; a
  // best-effort final flush drains on natural exit.
  const otelExport = installOtelSpanExportFromEnv(process.env)
  process.on("beforeExit", () => {
    void otelExport.teardown()
  })
  installAgentWorkspaceTrust(process.argv.slice(2))
    .then(() => runMain())
    .catch((e) => {
      process.stderr.write(`fatal: ${errMessage(e)}\n`)
      // ADR-0303 — honor a typed launcher error's exit code (e.g.
      // ProviderKeyMissingError ⇒ 2, preserving the prior missing-credentials
      // POSIX exit); generic errors stay exit 1.
      const code =
        typeof (e as { exitCode?: unknown })?.exitCode === "number"
          ? (e as { exitCode: number }).exitCode
          : 1
      process.exit(code)
    })
}
