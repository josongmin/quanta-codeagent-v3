/**
 * ADR-0290 — `quanta remote ...` CLI subcommand.
 *
 * Four leaf actions:
 *   - `quanta remote run "<task>"`        → spawn + print handle JSON
 *   - `quanta remote status <handle>`     → status JSON
 *   - `quanta remote logs <handle>`       → streaming stdout
 *   - `quanta remote cancel <handle>`     → cancel handle
 *
 * Default-OFF posture (HELL-CR-08):
 *   - When the composition root has NOT wired a runner (env unset / unknown),
 *     EVERY subcommand exits with code `EXIT_NOT_CONFIGURED` (=64) and emits
 *     `remote-not-configured` to stderr. NO subprocess is ever spawned.
 *
 * Signal handling (HELL-CR-11):
 *   - The dispatcher accepts an injected AbortController; the host wires
 *     Ctrl-C to call `controller.abort()` which cascades to cancel.
 *
 * I/O injection: the dispatcher accepts an `out` / `err` writer and a
 * runner instance. The CLI entry (`index.ts`) supplies process IO and
 * resolves the runner via {@link selectRemoteRunner}. Tests drive the
 * dispatcher directly with a string buffer + a stub runner.
 */

import type { RemoteHandle, RemoteRunner, RemoteSpec, RemoteStatus } from "@/remote"
import { errMessage } from "@/shared"

/** Exit codes — fixed integers used by tests for HELL-CR-05 / HELL-CR-08. */
export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_NOT_CONFIGURED = 64
export const EXIT_UNKNOWN_HANDLE = 65
export const EXIT_TRANSPORT = 66

export interface RemoteCmdIO {
  out(s: string): void
  err(s: string): void
}

export interface RemoteCmdDeps {
  readonly runner: RemoteRunner | null
  readonly io: RemoteCmdIO
  /** AbortController bound to OS signals (host-wired). Optional for tests. */
  readonly signal?: AbortSignal | undefined
  /** Default image when `--image` is omitted from `run`. */
  readonly defaultImage?: string | undefined
  /** Default timeoutMs when `--timeout-ms` is omitted. */
  readonly defaultTimeoutMs?: number | undefined
}

const HELP = [
  "quanta remote — remote execution plane",
  "",
  "Usage:",
  '  quanta remote run "<task>"            Spawn workload (handle JSON to stdout)',
  "    [--image <img>] [--timeout-ms <ms>] [--workdir <wd>]",
  "  quanta remote status <handle>           Status snapshot JSON",
  "  quanta remote logs <handle>             Stream logs to stdout",
  "  quanta remote cancel <handle>           Cancel + reap handle",
  "  quanta remote --help                    Show this help",
  "",
  "Env:",
  "  QUANTA_REMOTE_RUNNER=docker|lima|apple-vz|headless|none  (default: none)",
  "  QUANTA_REMOTE_DEFAULT_IMAGE=<img>                        Spawn default image",
  "  QUANTA_REMOTE_TIMEOUT_MS=<ms>                            Default timeout (3600000)",
  "",
].join("\n")

const notConfigured = (io: RemoteCmdIO): number => {
  io.err("remote-not-configured\n")
  return EXIT_NOT_CONFIGURED
}

/* ------------------------------------------------------------------ */
/* Tiny argv parser — flag + value pairs only                          */
/* ------------------------------------------------------------------ */

interface ParsedRunArgs {
  readonly task: string
  readonly image: string | undefined
  readonly timeoutMs: number | undefined
  readonly workdir: string | undefined
}

/** Mutable accumulator for the three value-taking flags. Separate from the
 *  frozen {@link ParsedRunArgs} so a flag handler can write one axis without
 *  the parser threading three `let`s through every branch. */
interface RunArgsAcc {
  image?: string
  timeoutMs?: number
  workdir?: string
}

/** A flag handler: write `raw` into `acc`, or return the error string that
 *  rejects it. Returning `undefined` means "accepted". */
type RunFlagHandler = (acc: RunArgsAcc, raw: string) => string | undefined

/**
 * The value-taking flags, as a TABLE.
 *
 * ONE unit because all three flags share the identical three-step gate —
 * "advance the cursor, demand a value, apply it" — and spelling that gate out
 * per flag WAS this parser's cognitive-complexity score. Only the apply step
 * differs, so only the apply step is tabulated.
 *
 * A `Map` (not a plain object) on purpose: an object literal resolves
 * `toString` / `constructor` off `Object.prototype`, which would silently turn
 * a task named `toString` into a flag lookup.
 */
const RUN_FLAGS: ReadonlyMap<string, RunFlagHandler> = new Map<string, RunFlagHandler>([
  [
    "--image",
    (acc, raw) => {
      acc.image = raw
      return undefined
    },
  ],
  [
    "--timeout-ms",
    (acc, raw) => {
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n < 0) return `invalid --timeout-ms: ${raw}`
      acc.timeoutMs = n
      return undefined
    },
  ],
  [
    "--workdir",
    (acc, raw) => {
      acc.workdir = raw
      return undefined
    },
  ],
])

const parseRunArgs = (
  argv: readonly string[],
): { ok: true; value: ParsedRunArgs } | { ok: false; error: string } => {
  const acc: RunArgsAcc = {}
  let task: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] ?? ""
    const handler = RUN_FLAGS.get(tok)
    if (handler !== undefined) {
      i += 1
      const v = argv[i]
      if (v === undefined) return { ok: false, error: `missing value for ${tok}` }
      const rejected = handler(acc, v)
      if (rejected !== undefined) return { ok: false, error: rejected }
      continue
    }
    if (tok.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${tok}` }
    }
    if (task !== undefined) {
      return { ok: false, error: "multiple positional args (use a quoted task string)" }
    }
    task = tok
  }
  if (task === undefined) return { ok: false, error: "missing <task>" }
  return {
    ok: true,
    value: { task, image: acc.image, timeoutMs: acc.timeoutMs, workdir: acc.workdir },
  }
}

/* ------------------------------------------------------------------ */
/* Per-subcommand handlers                                             */
/* ------------------------------------------------------------------ */

const handleRun = async (argv: readonly string[], deps: RemoteCmdDeps): Promise<number> => {
  if (deps.runner === null) return notConfigured(deps.io)
  const parsed = parseRunArgs(argv)
  if (!parsed.ok) {
    deps.io.err(`error: ${parsed.error}\n`)
    return EXIT_USAGE
  }
  const image = parsed.value.image ?? deps.defaultImage
  if (image === undefined || image === "") {
    deps.io.err("error: --image required (or set QUANTA_REMOTE_DEFAULT_IMAGE)\n")
    return EXIT_USAGE
  }
  const cmd = ["sh", "-c", parsed.value.task]
  const spec: RemoteSpec = {
    image,
    cmd,
    ...(parsed.value.timeoutMs !== undefined
      ? { timeoutMs: parsed.value.timeoutMs }
      : deps.defaultTimeoutMs !== undefined
        ? { timeoutMs: deps.defaultTimeoutMs }
        : {}),
    ...(parsed.value.workdir !== undefined ? { workdir: parsed.value.workdir } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  }
  const r = await deps.runner.spawn(spec)
  if (!r.ok) {
    deps.io.err(`error: ${r.error.message}\n`)
    return r.error.kind === "invalid-spec" ? EXIT_USAGE : EXIT_TRANSPORT
  }
  deps.io.out(`${JSON.stringify(r.value)}\n`)
  return EXIT_OK
}

const renderStatus = (s: RemoteStatus): string => JSON.stringify(s)

const reconstructHandle = (id: string): RemoteHandle | null => {
  const dash = id.indexOf("-")
  if (dash < 0) return null
  const prefix = id.slice(0, dash)
  if (prefix === "docker" || prefix === "lima" || prefix === "apple-vz" || prefix === "headless") {
    return { id, backend: prefix }
  }
  // Composite prefix like `quanta-remote-<uuid>` — peek for `apple-vz` first.
  if (id.startsWith("apple-vz-")) return { id, backend: "apple-vz" }
  // Fallback: use docker (the most common path); the adapter validates.
  return { id, backend: "docker" }
}

const handleStatus = async (argv: readonly string[], deps: RemoteCmdDeps): Promise<number> => {
  if (deps.runner === null) return notConfigured(deps.io)
  const id = argv[0]
  if (id === undefined) {
    deps.io.err("error: missing <handle>\n")
    return EXIT_USAGE
  }
  const handle = reconstructHandle(id)
  if (handle === null) {
    deps.io.err(`error: invalid handle id: ${id}\n`)
    return EXIT_USAGE
  }
  const r = await deps.runner.status(handle)
  if (!r.ok) {
    deps.io.err(`error: ${r.error.message}\n`)
    return r.error.kind === "unknown-handle" ? EXIT_UNKNOWN_HANDLE : EXIT_TRANSPORT
  }
  deps.io.out(`${renderStatus(r.value)}\n`)
  return EXIT_OK
}

const handleCancel = async (argv: readonly string[], deps: RemoteCmdDeps): Promise<number> => {
  if (deps.runner === null) return notConfigured(deps.io)
  const id = argv[0]
  if (id === undefined) {
    deps.io.err("error: missing <handle>\n")
    return EXIT_USAGE
  }
  const handle = reconstructHandle(id)
  if (handle === null) {
    deps.io.err(`error: invalid handle id: ${id}\n`)
    return EXIT_USAGE
  }
  const r = await deps.runner.cancel(handle)
  if (!r.ok) {
    deps.io.err(`error: ${r.error.message}\n`)
    return r.error.kind === "unknown-handle" ? EXIT_UNKNOWN_HANDLE : EXIT_TRANSPORT
  }
  deps.io.out("ok\n")
  return EXIT_OK
}

const handleLogs = async (argv: readonly string[], deps: RemoteCmdDeps): Promise<number> => {
  if (deps.runner === null) return notConfigured(deps.io)
  const id = argv[0]
  if (id === undefined) {
    deps.io.err("error: missing <handle>\n")
    return EXIT_USAGE
  }
  const handle = reconstructHandle(id)
  if (handle === null) {
    deps.io.err(`error: invalid handle id: ${id}\n`)
    return EXIT_USAGE
  }
  try {
    const opts: { signal?: AbortSignal } = {}
    if (deps.signal !== undefined) opts.signal = deps.signal
    for await (const line of deps.runner.logs(handle, opts)) {
      deps.io.out(`${line}\n`)
    }
    return EXIT_OK
  } catch (e) {
    deps.io.err(`error: ${errMessage(e)}\n`)
    return EXIT_TRANSPORT
  }
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run the `remote` subcommand. `args` is the post-`quanta remote` argv slice
 * (i.e. `process.argv.slice(3)`).
 */
export const runRemoteCmd = async (
  args: readonly string[],
  deps: RemoteCmdDeps,
): Promise<number> => {
  const sub = args[0]
  if (sub === undefined || sub === "--help" || sub === "-h") {
    deps.io.out(HELP)
    return EXIT_OK
  }
  const rest = args.slice(1)
  switch (sub) {
    case "run":
      return handleRun(rest, deps)
    case "status":
      return handleStatus(rest, deps)
    case "logs":
      return handleLogs(rest, deps)
    case "cancel":
      return handleCancel(rest, deps)
    default:
      deps.io.err(`unknown subcommand: ${sub}\n`)
      deps.io.err(HELP)
      return EXIT_USAGE
  }
}

/** Help string for the top-level usage block to advertise the subcommand. */
export const remoteUsageLine = (): string =>
  "  quanta remote <subcommand> ...       Remote execution plane (see `quanta remote --help`)"
