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
import type { DialTarget } from "./loopback-proxy"
import { LoopbackEgressProxy } from "./loopback-proxy"
import type { NetworkProxyPort } from "./port"
import type { NetworkProxyConfig } from "./types"

/** Optional DI for the lifecycle (tests inject a clock / hermetic dial). */
export interface EgressProxyDeps {
  readonly now?: () => number
  /** Hermetic dial-target resolver — tests map routable names to a loopback
   *  origin. Production omits it ⇒ identity dial + active peer SSRF re-check. */
  readonly dial?: DialTarget
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
