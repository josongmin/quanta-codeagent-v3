/**
 * Egress-proxy lifecycle helper (ADR-0428).
 *
 * The wiring keystone: turns a default-OFF {@link NetworkProxyConfig} into a
 * LIVE, listening {@link LoopbackEgressProxy}, hands the body the
 * {@link ProxyEnvInput} to thread through `withProxyEnv` into child spawns,
 * and ALWAYS closes the proxy socket on teardown (normal return or throw).
 *
 * WHY a dedicated helper — the proxy is useless until a child-spawn site
 * actually injects its env. Centralizing the construct → listen → run → close
 * dance here means each spawn site (shell / git / sandbox) gets the same
 * correct lifecycle by construction; forgetting `close()` (a socket leak) is
 * impossible because the leak-on-throw is folded into one `finally`.
 *
 * DEFAULT-OFF / byte-identical contract:
 *   - `config` absent OR `config.enabled !== true` ⇒ NO proxy is constructed,
 *     NO socket is bound, and the body runs with `proxyEnv = {}` — so
 *     `withProxyEnv(base, {})` returns the SAME base reference (byte-identical
 *     to the pre-slice spawn). This is the path every interactive turn takes.
 *   - `config.enabled === true` ⇒ a real loopback proxy is bound on an
 *     ephemeral port and the body receives `{ address, noProxy }` so its child
 *     env carries `HTTP_PROXY`/`HTTPS_PROXY` pointed at the proxy.
 *
 * The body owns the actual spawn; this helper owns ONLY the proxy lifecycle, so
 * it stays reusable across every spawn site and trivially testable.
 */

import type { ProxyEnvInput } from "./env"
import type { DialTarget, ResolvePeerHost } from "./loopback-proxy"
import { LoopbackEgressProxy } from "./loopback-proxy"
import type { NetworkProxyPort } from "./port"
import type { NetworkProxyConfig } from "./types"

/** Optional DI for the lifecycle (tests inject a clock / hermetic dial). */
export interface EgressProxyDeps {
  readonly now?: () => number
  /** Hermetic dial-target resolver — tests map routable names to a loopback
   *  origin. Production omits it ⇒ identity dial + active peer SSRF re-check. */
  readonly dial?: DialTarget
  /** jun-02 SSRF re-audit: peer-classification resolver. The post-connect SSRF
   *  re-check now ALWAYS runs; this seam picks which address it classifies so a
   *  hermetic `dial` no longer disables the rebinding defense. Production omits
   *  it ⇒ the real `sock.remoteAddress` is classified. */
  readonly resolvePeerHost?: ResolvePeerHost
}

/** What the body receives: the live proxy (for amendments / decision-log
 *  assertions) plus the {@link ProxyEnvInput} to feed `withProxyEnv`. When the
 *  config is OFF, `proxy` is `null` and `proxyEnv` is `{}` (byte-identical). */
export interface EgressProxyContext {
  readonly proxy: NetworkProxyPort | null
  readonly proxyEnv: ProxyEnvInput
}

/**
 * Run `body` with an egress proxy whose lifecycle is fully managed.
 *
 * @param config  the (possibly OFF) proxy config from `AgentConfig.networkProxy`.
 * @param body    consumes the {@link EgressProxyContext} (spawns children with
 *                `withProxyEnv(base, ctx.proxyEnv)`) and returns its result.
 * @param deps    optional clock + hermetic dial seam for tests.
 * @returns       whatever `body` resolves to.
 *
 * The proxy socket is closed in `finally` on EVERY exit path — so a throw in
 * `body` can never leak the bound port.
 */
export const withEgressProxy = async <T>(
  config: NetworkProxyConfig | undefined,
  body: (ctx: EgressProxyContext) => Promise<T>,
  deps: EgressProxyDeps = {},
): Promise<T> => {
  // DEFAULT-OFF: absent or disabled ⇒ no socket, byte-identical child env.
  if (config === undefined || config.enabled !== true) {
    return body({ proxy: null, proxyEnv: {} })
  }

  const proxy = new LoopbackEgressProxy(config, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.dial !== undefined ? { dial: deps.dial } : {}),
    ...(deps.resolvePeerHost !== undefined ? { resolvePeerHost: deps.resolvePeerHost } : {}),
  })
  const address = await proxy.listen()
  try {
    return await body({
      proxy,
      proxyEnv: {
        address,
        ...(config.noProxy !== undefined ? { noProxy: config.noProxy } : {}),
      },
    })
  } finally {
    await proxy.close()
  }
}

/** What {@link openSessionEgressProxy} hands back: the stable {@link ProxyEnvInput}
 *  to thread into PROCESS-LIFETIME child spawns (MCP stdio servers) plus an
 *  idempotent `close()` to release the bound socket on session teardown. When the
 *  config is OFF, `proxyEnv` is `{}` (byte-identical child env) and `close()` is a
 *  no-op. */
export interface SessionEgressProxy {
  readonly proxyEnv: ProxyEnvInput
  readonly close: () => Promise<void>
}

/**
 * Open a SESSION-SCOPED egress proxy (open/close, NOT callback-scoped).
 *
 * WHY a second shape vs {@link withEgressProxy} — `withEgressProxy` binds a FRESH
 * proxy per `runAgent` (per turn) and closes it on the callback's return, which is
 * correct for per-turn children (bash / docker / sandbox). But an MCP stdio server
 * is a PROCESS-LIFETIME child spawned ONCE at bootstrap (before any turn) and lives
 * across every turn — it cannot be re-pointed at a per-turn proxy whose ephemeral
 * port changes each turn. So MCP needs a proxy bound ONCE, BEFORE the spawn, whose
 * stable address is fixed into the child's env and stays valid for the whole
 * session. This helper provides exactly that: bind once, hand back the stable env,
 * and expose `close()` for the session-shutdown hook.
 *
 * DEFAULT-OFF / byte-identical: `config` absent OR `config.enabled !== true` ⇒ NO
 * proxy is constructed, NO socket bound, `proxyEnv = {}` (so `withProxyEnv(base,{})`
 * returns the SAME base ⇒ byte-identical MCP spawn env), and `close()` is a no-op.
 * This is the path every default run takes.
 *
 * @param config  the (possibly OFF) proxy config from `AgentConfig.networkProxy`.
 * @param deps    optional clock + hermetic dial seam for tests (same as
 *                {@link withEgressProxy}).
 */
export const openSessionEgressProxy = async (
  config: NetworkProxyConfig | undefined,
  deps: EgressProxyDeps = {},
): Promise<SessionEgressProxy> => {
  // DEFAULT-OFF: absent or disabled ⇒ no socket, byte-identical child env, no-op close.
  if (config === undefined || config.enabled !== true) {
    return { proxyEnv: {}, close: async () => {} }
  }

  const proxy = new LoopbackEgressProxy(config, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.dial !== undefined ? { dial: deps.dial } : {}),
    ...(deps.resolvePeerHost !== undefined ? { resolvePeerHost: deps.resolvePeerHost } : {}),
  })
  const address = await proxy.listen()
  return {
    proxyEnv: {
      address,
      ...(config.noProxy !== undefined ? { noProxy: config.noProxy } : {}),
    },
    close: () => proxy.close(),
  }
}
