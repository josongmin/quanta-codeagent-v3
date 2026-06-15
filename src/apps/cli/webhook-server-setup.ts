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

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createBunWebhookTransport,
  createDurableDeliveryStore,
  createNodeWebhookTransport,
  createWebhookEventSource,
  type DeliveryStore,
  loadWebhookSecretConfig,
  type SecretResolverPort,
  type WebhookEventSource,
  type WebhookEventSourceOpts,
  type WebhookSecretConfig,
  type WebhookTransportPort,
} from "@/integrations/github"
import type { ProactiveTrigger } from "@/reactor"
import { errMessage, gateOnStrict, quantaHomeDirFrom } from "@/shared"
import { publishReactorWatchTrigger } from "./reactor-watch-bridge"

/** EX_USAGE — gate-off / missing-secret / bind fault (BSD sysexits). */
const EXIT_USAGE = 64
const EXIT_OK = 0

const DEFAULT_PORT = 8787
const DEFAULT_SESSION = "webhook"
/** Poll cadence (ms) — how often the pump drains `source.poll()`. Low enough to
 *  feel live; the queue itself is the buffer, so a missed beat just batches. */
const DEFAULT_POLL_INTERVAL_MS = 250

/** Per-publish liveness backstop (ms) — see {@link WebhookServerCmdDeps.publishTimeoutMs}. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000

/** Durable delivery-dedup dump path (audit B1). `QUANTA_CONFIG_DIR` override ⇒
 *  that dir, else `~/.quanta`. Survives a host restart so a re-delivered
 *  `X-GitHub-Delivery` is recognised and the trigger is NOT re-fired. */
const deliveryDumpPath = (env: NodeJS.ProcessEnv): string =>
  join(quantaHomeDirFrom(env), "webhook-deliveries.json")

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
  /** Delivery-dedup store override. Default = a DURABLE store (audit B1): a
   *  long-lived host MUST persist delivery-id dedup so a GitHub re-delivery
   *  after a restart is not re-fired. The hellgate injects an in-memory or
   *  tmp-path store. */
  readonly buildDeliveryStore?: () => DeliveryStore
  /** Per-publish liveness backstop (ms): a publish that never settles (e.g. a
   *  reactor that accepts the socket but never closes it) must not wedge the
   *  pump. NOT a perf tuning knob — a generous ceiling. Default
   *  {@link DEFAULT_PUBLISH_TIMEOUT_MS}. */
  readonly publishTimeoutMs?: number
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
  const hasBun = typeof (globalThis as { Bun?: { serve?: unknown } }).Bun?.serve === "function"
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
  QUANTA_GITHUB_WEBHOOK_SECRET     The shared HMAC secret (single-installation).
                                  REQUIRED unless a multi-installation map is
                                  set below. Empty + no map ⇒ exit 64, no port
                                  is bound (no open bypass).
  QUANTA_GITHUB_WEBHOOK_SECRETS    Multi-installation map for hosting several
                                  GitHub Apps on one host: 'key1=secret1,
                                  key2=secret2'. Each App's webhook URL must
                                  post to /webhook/<key> (PATH routing — the key
                                  selects the secret BEFORE the body is parsed).
                                  An unknown key ⇒ 401, body never parsed.
  QUANTA_GITHUB_WEBHOOK_SECRETS_FILE
                                  Alternative to the inline map: a path to a
                                  JSON file '{ "key1": "secret1", ... }'. The
                                  inline map wins if both are set.
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

  // 3. Secret REQUIRED before any bind. Resolve the secret CONFIG (single shared
  //    secret OR a multi-installation map via QUANTA_GITHUB_WEBHOOK_SECRETS /
  //    _FILE). Mode `none` (no secret of any kind configured, or a map that
  //    parsed to zero usable entries) ⇒ refuse to boot (no open port). Secret
  //    VALUES are never logged — only the mode + app-key count.
  const secretConfig = loadWebhookSecretConfig({
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
    onError: io.err,
  })
  if (secretConfig.mode === "none") {
    io.err(
      "github webhook server: no webhook SECRET configured " +
        "(set QUANTA_GITHUB_WEBHOOK_SECRET, or QUANTA_GITHUB_WEBHOOK_SECRETS / _FILE) — no open bypass\n",
    )
    return EXIT_USAGE
  }

  const port = parsePort(process.env)
  const sessionId = parseSessionId(argv, process.env)
  const publish: PublishReactorWatchTriggerFn = deps?.publish ?? publishReactorWatchTrigger
  const pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const publishTimeoutMs = deps?.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS
  // B1 — durable dedup store (a long-lived host MUST persist; default real-fs
  // at the config dir). Injected override in tests.
  const deliveryStore: DeliveryStore =
    deps?.buildDeliveryStore?.() ??
    createDurableDeliveryStore({ persistPath: deliveryDumpPath(process.env), onError: io.err })

  return await bindAndServe({
    io,
    deps,
    secretConfig,
    port,
    sessionId,
    publish,
    pollIntervalMs,
    publishTimeoutMs,
    deliveryStore,
  })
}

interface ServeArgs {
  readonly io: WebhookServerCmdIo
  readonly deps: WebhookServerCmdDeps | undefined
  readonly secretConfig: WebhookSecretConfig
  readonly port: number
  readonly sessionId: string
  readonly publish: PublishReactorWatchTriggerFn
  readonly pollIntervalMs: number
  readonly publishTimeoutMs: number
  readonly deliveryStore: DeliveryStore
}

/** Duck-typed durable-store probe — the in-memory store has neither `ready` nor
 *  `flush`; the durable one has both. */
const asDurable = (s: DeliveryStore): { ready?: Promise<void>; flush?: () => Promise<void> } =>
  s as { ready?: Promise<void>; flush?: () => Promise<void> }

const bindAndServe = async (a: ServeArgs): Promise<number> => {
  // Build the transport + source. Any throw here (bind EADDRINUSE, empty-secret
  // re-check in the slice) is caught — NO-THROW contract: log + exit 64.
  let source: WebhookEventSource
  try {
    // B1 — hydrate the durable dedup store from disk BEFORE serving so a
    // re-delivery after a restart is recognised on the very first request.
    const durable = asDurable(a.deliveryStore)
    if (durable.ready !== undefined) await durable.ready
    const transport = (a.deps?.buildTransport ?? defaultBuildTransport)(a.port)
    const buildSource = a.deps?.buildSource ?? createWebhookEventSource
    const secretResolver: SecretResolverPort = a.secretConfig.resolver
    source = buildSource({
      transport,
      secretResolver,
      clockPort: { now: () => Date.now() },
      deliveryStore: a.deliveryStore,
    })
    await source.start()
  } catch (e) {
    a.io.err(`github webhook server: cannot start: ${errMessage(e)}\n`)
    return EXIT_USAGE
  }

  // Credential-free boot summary: mode + installation COUNT (keys/values stay
  // out of the log). `single` = legacy one-secret; `map` = N installations.
  const secretSummary =
    a.secretConfig.mode === "map"
      ? `${a.secretConfig.appKeys.length} installation secret(s)`
      : "single shared secret"
  a.io.err(
    `quanta webhook · listening on :${a.port} → reactor session '${a.sessionId}' (${secretSummary})\n`,
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
        // B2 — bound each publish: a sink that never settles (reactor accepts
        // the socket but never closes it) must not wedge the pump and silently
        // drop every later trigger. On timeout: log + continue.
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), a.publishTimeoutMs)
          if (typeof (timer as { unref?: () => void }).unref === "function") {
            ;(timer as { unref: () => void }).unref()
          }
        })
        const outcome = await Promise.race([
          Promise.resolve(a.publish({ sessionId: a.sessionId, trigger })).then(() => "ok" as const),
          timeout,
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (outcome === "timeout") {
          a.io.err(`quanta webhook: publish timed out after ${a.publishTimeoutMs}ms (dropped)\n`)
        }
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
    // B1 — flush any pending durable dedup save so the on-disk dump is current
    // before exit (a redelivery after this shutdown must be recognised).
    const durable = asDurable(a.deliveryStore)
    if (durable.flush !== undefined) {
      try {
        await durable.flush()
      } catch (e) {
        a.io.err(`quanta webhook: delivery-store flush failed: ${errMessage(e)}\n`)
      }
    }
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }

  return EXIT_OK
}
