/**
 * `apps/cli/webhook-server-setup.ts` — ADR-0312 webhook HOST composition root.
 *
 * The slice (`@/integrations/github` — `createWebhookEventSource`,
 * `createBun/NodeWebhookTransport`, `verifyHubSignature256`) is fully LIVE and
 * tested, but NOTHING drains its `poll()` into the reactor. This file is that
 * missing HOST/SURFACE: `quanta webhook` binds a real HTTP listener, runs the
 * verified-HMAC + dedup + mention-filter pipeline, and PUMPS each accepted
 * `ProactiveTrigger` into the EXISTING reactor-watch IPC seam
 * (`publishReactorWatchTrigger` in `reactor-watch-bridge.ts`).
 *
 * `quanta webhook` opens an INBOUND-NETWORK socket that drives the agent — an
 * RCE-adjacent surface, so it mirrors `mcp-server-setup.ts`'s posture:
 *
 *   - GATE: `gateOnStrict(env,'QUANTA_GITHUB_WEBHOOK')` — exact `=1` (a stray
 *     `on`/`true` is REFUSED). Off ⇒ exit 64, NOTHING bound, ZERO IO.
 *   - SECRET REQUIRED: an empty `QUANTA_GITHUB_WEBHOOK_SECRET` ⇒ exit 64, bind
 *     NOTHING. The slice itself throws on an empty secret (no open bypass); the
 *     host refuses to even attempt a boot so a misconfigured operator never
 *     opens a port (the slice's boot-fence + a host-level pre-check, doubled).
 *
 * No-throw at the boundary: {@link runWebhookServerCmd} returns a numeric exit
 * code and NEVER rejects (mirrors `runMcpServerCmd`). A transport bind fault or
 * a source.start() throw → exit 64 with a logged reason; the poll→publish pump
 * is no-throw by construction (a failed publish is logged, never re-thrown).
 */

import { errMessage, gateOnStrict } from "@/shared"
import {
  createBunWebhookTransport,
  createNodeWebhookTransport,
  createWebhookEventSource,
  type WebhookEventSource,
  type WebhookEventSourceOpts,
  type WebhookTransportPort,
} from "@/integrations/github"
import type { ProactiveTrigger } from "@/reactor"
import { publishReactorWatchTrigger } from "./reactor-watch-bridge"

/** EX_USAGE — gate-off / missing-secret / bind fault (BSD sysexits). */
const EXIT_USAGE = 64
const EXIT_OK = 0

const DEFAULT_PORT = 8787
const DEFAULT_SESSION = "webhook"
/** Poll cadence (ms) — how often the pump drains `source.poll()`. Low enough to
 *  feel live; the queue itself is the buffer, so a missed beat just batches. */
const DEFAULT_POLL_INTERVAL_MS = 250

/** Minimal IO seam — injected so the hellgate drives the command without
 *  touching real process streams. */
export interface WebhookServerCmdIo {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}

/** The downstream publish sink. Production = the real reactor-watch IPC bridge;
 *  the hellgate injects a spy to observe the poll→publish wiring without a live
 *  reactor process. */
export type PublishReactorWatchTriggerFn = (opts: {
  readonly sessionId: string
  readonly trigger: ProactiveTrigger
}) => Promise<void> | void

/** Composition-root dependency seam (test-injectable). Production leaves every
 *  field unset so the real builders / IPC sink are used. */
export interface WebhookServerCmdDeps {
  /** Override the transport builder (the hellgate injects a loopback transport
   *  bound on an ephemeral port). Default = Bun transport, node fallback. */
  readonly buildTransport?: (port: number) => WebhookTransportPort
  /** Override the event-source builder (rarely needed; lets a test supply a
   *  pre-wired source). Default = `createWebhookEventSource`. */
  readonly buildSource?: (opts: WebhookEventSourceOpts) => WebhookEventSource
  /** The publish sink. Default = `publishReactorWatchTrigger`. */
  readonly publish?: PublishReactorWatchTriggerFn
  /** Poll cadence override (ms). Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number
}

const defaultIo = (): WebhookServerCmdIo => ({
  out: (s) => {
    process.stdout.write(s)
  },
  err: (s) => {
    process.stderr.write(s)
  },
})

/** Default transport: prefer Bun.serve under Bun, fall back to node:http. The
 *  Bun builder throws if not under Bun, so we probe the global first. */
const defaultBuildTransport = (port: number): WebhookTransportPort => {
  const hasBun =
    typeof (globalThis as { Bun?: { serve?: unknown } }).Bun?.serve === "function"
  return hasBun ? createBunWebhookTransport({ port }) : createNodeWebhookTransport({ port })
}

export const webhookServerUsage = (): string =>
  `quanta webhook — receive GitHub webhooks and drive the reactor (ADR-0312)

USAGE
  QUANTA_GITHUB_WEBHOOK=1 QUANTA_GITHUB_WEBHOOK_SECRET=<secret> quanta webhook

DESCRIPTION
  Binds an HTTP listener that ingests GitHub webhook POSTs, verifies the HMAC
  signature, dedups by delivery id, filters for an @quanta mention from a
  trusted author, and publishes each accepted event as a ProactiveTrigger to a
  running reactor session over the reactor-watch IPC socket. SECURITY: this is
  an inbound-network surface — an unsigned/forged payload is rejected (401) and
  never reaches the reactor.

GATE
  QUANTA_GITHUB_WEBHOOK=1          REQUIRED (strict === '1'; a loose 'on' is
                                  refused). Unset ⇒ this command exits 64 and
                                  binds nothing.

CONFIG
  QUANTA_GITHUB_WEBHOOK_SECRET     REQUIRED. The shared HMAC secret configured
                                  on the GitHub webhook. Empty ⇒ exit 64, no
                                  port is bound (no open bypass).
  QUANTA_GITHUB_WEBHOOK_PORT       Listen port (default ${DEFAULT_PORT}).
  QUANTA_GITHUB_WEBHOOK_SESSION    Reactor session id to drive (default
                                  '${DEFAULT_SESSION}'). Also: --session <id>.

  --help, -h                       Print this help and exit.
`

const parseSessionId = (argv: readonly string[], env: NodeJS.ProcessEnv): string => {
  const flagIdx = argv.indexOf("--session")
  if (flagIdx !== -1) {
    const v = argv[flagIdx + 1]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  const fromEnv = env.QUANTA_GITHUB_WEBHOOK_SESSION
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim()
  return DEFAULT_SESSION
}

const parsePort = (env: NodeJS.ProcessEnv): number => {
  const raw = env.QUANTA_GITHUB_WEBHOOK_PORT
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n
  }
  return DEFAULT_PORT
}

/**
 * Run the `quanta webhook` subcommand. NO-THROW: returns a numeric exit code,
 * never rejects. `argv` is `process.argv.slice(3)` (everything after
 * `quanta webhook`).
 *
 * Order is deliberate for the security posture:
 *   1. `--help` returns BEFORE any gate (no secret needed).
 *   2. The strict gate is checked BEFORE reading the secret or binding — gate-off
 *      does ZERO IO (no socket, no FS, stdout empty).
 *   3. The secret is required BEFORE we build the transport — an empty secret
 *      means we bind NOTHING (no open port that would accept all payloads).
 *   4. Only then do we build the transport, start the source, and run the
 *      poll→publish pump until SIGINT/SIGTERM.
 */
export const runWebhookServerCmd = async (
  argv: readonly string[],
  injected?: { io?: WebhookServerCmdIo; deps?: WebhookServerCmdDeps },
): Promise<number> => {
  const io = injected?.io ?? defaultIo()
  const deps = injected?.deps

  // 1. Help short-circuits before the gate.
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(webhookServerUsage())
    return EXIT_OK
  }

  // 2. STRICT security gate. Default-OFF byte-identity: ZERO IO, nothing bound.
  if (!gateOnStrict(process.env, "QUANTA_GITHUB_WEBHOOK")) {
    io.err("github webhook server disabled (set QUANTA_GITHUB_WEBHOOK=1)\n")
    return EXIT_USAGE
  }

  // 3. Secret REQUIRED before any bind. Empty ⇒ refuse to boot (no open port).
  const secret = process.env.QUANTA_GITHUB_WEBHOOK_SECRET
  if (typeof secret !== "string" || secret.length === 0) {
    io.err("github webhook server: QUANTA_GITHUB_WEBHOOK_SECRET is required (no open bypass)\n")
    return EXIT_USAGE
  }

  const port = parsePort(process.env)
  const sessionId = parseSessionId(argv, process.env)
  const publish: PublishReactorWatchTriggerFn = deps?.publish ?? publishReactorWatchTrigger
  const pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  return await bindAndServe({ io, deps, secret, port, sessionId, publish, pollIntervalMs })
}

interface ServeArgs {
  readonly io: WebhookServerCmdIo
  readonly deps: WebhookServerCmdDeps | undefined
  readonly secret: string
  readonly port: number
  readonly sessionId: string
  readonly publish: PublishReactorWatchTriggerFn
  readonly pollIntervalMs: number
}

const bindAndServe = async (a: ServeArgs): Promise<number> => {
  // Build the transport + source. Any throw here (bind EADDRINUSE, empty-secret
  // re-check in the slice) is caught — NO-THROW contract: log + exit 64.
  let source: WebhookEventSource
  try {
    const transport = (a.deps?.buildTransport ?? defaultBuildTransport)(a.port)
    const buildSource = a.deps?.buildSource ?? createWebhookEventSource
    source = buildSource({
      transport,
      secret: a.secret,
      clockPort: { now: () => Date.now() },
    })
    await source.start()
  } catch (e) {
    a.io.err(`github webhook server: cannot start: ${errMessage(e)}\n`)
    return EXIT_USAGE
  }

  a.io.err(
    `quanta webhook · listening on :${a.port} → reactor session '${a.sessionId}'\n`,
  )

  // POLL→PUBLISH PUMP — the one new piece of host logic. Drain source.poll() on
  // a cancellable cadence; for each ProactiveTrigger, publish to the reactor.
  // A failed publish is LOGGED, never re-thrown (one bad event must not kill the
  // pump, which would silently drop every subsequent trigger).
  let stopped = false
  const drainOnce = async (): Promise<void> => {
    let triggers: readonly ProactiveTrigger[]
    try {
      triggers = await source.poll()
    } catch (e) {
      a.io.err(`quanta webhook: poll failed: ${errMessage(e)}\n`)
      return
    }
    for (const trigger of triggers) {
      try {
        await a.publish({ sessionId: a.sessionId, trigger })
      } catch (e) {
        a.io.err(`quanta webhook: publish failed: ${errMessage(e)}\n`)
      }
    }
  }

  // Cancellable cadence. We loop with awaited drains so a slow publish never
  // overlaps itself (no unbounded concurrency), and `stopped` short-circuits the
  // wait so SIGINT exits promptly.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      // Don't keep the event loop alive solely for the timer.
      if (typeof (t as { unref?: () => void }).unref === "function") {
        ;(t as { unref: () => void }).unref()
      }
    })

  const ac = new AbortController()
  const onSig = (): void => {
    stopped = true
    ac.abort()
  }
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)

  try {
    while (!stopped) {
      await drainOnce()
      if (stopped) break
      await Promise.race([
        sleep(a.pollIntervalMs),
        new Promise<void>((resolve) => {
          if (ac.signal.aborted) resolve()
          else ac.signal.addEventListener("abort", () => resolve(), { once: true })
        }),
      ])
    }
  } finally {
    // FINAL DRAIN: a trigger may have arrived after the last sleep started but
    // before SIGINT — drain it before stopping so it isn't lost. Then stop the
    // listener (closes the socket; no zombie port) and detach signal handlers.
    try {
      await drainOnce()
    } catch {
      // drainOnce is itself no-throw, but belt-and-braces.
    }
    await source.stop()
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }

  return EXIT_OK
}
