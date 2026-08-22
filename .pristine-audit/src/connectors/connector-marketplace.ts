/**
 * §1.6 — connector MARKETPLACE V1 (DirectoryApp lifecycle / installUrl).
 *
 * The existing `mcp-connector-catalog.ts` is a FLAT discovery list. The audit
 * (cf. Codex `imported-connector-apps` / Claude-Code's plugin install lifecycle)
 * wants a DirectoryApp with a real INSTALL LIFECYCLE: an app is discovered with
 * an `installUrl`, then installed → enabled/disabled → uninstalled, with install
 * metadata (`installedAt`/`lastUpdatedAt`) recorded from an injected clock.
 *
 * V1 SCOPE (shipped here):
 *   - `DirectoryAppSchema` — the strict app descriptor (id/name/installUrl/version).
 *   - the PURE lifecycle core `createConnectorMarketplace({store, clock})` over an
 *     injected {@link InstalledAppStorePort} (in-memory impl bundled; the host may
 *     back it with the connector JSONL store) + {@link ClockPort}.
 *   - `isConnectorMarketplaceEnabled` — the `QUANTA_CONNECTOR_MARKETPLACE` gate.
 *
 * DEFERRED (explicitly OUT of V1, needs separate ADR + a surface): the
 * marketplace browse UI, the REMOTE registry fetch of DirectoryApps, app
 * AUTO-UPDATE, and the actual `installUrl` fetch/OAuth handshake. This slice owns
 * the SCHEMA + lifecycle STATE MACHINE only — the host fetches `installUrl` and
 * feeds the descriptor in.
 *
 * Slice posture: pure leaf — imports only `@/shared` (gateOn, byteCompare) + zod.
 * NO-THROW: every lifecycle op returns a typed result. DEFAULT-OFF: nothing here
 * runs unless the host opts in via the gate; an empty store ⇒ `list()` is `[]`.
 */
import { z } from "zod"
import { byteCompare, gateOn } from "@/shared"
import type { ClockPort } from "./types"

/**
 * A DirectoryApp descriptor (the marketplace listing shape). Strict so a typo'd
 * key fails loudly. `installUrl` is the canonical install entrypoint the host
 * opens / fetches; `version` is the published version string.
 */
/** `installUrl` MUST be an http(s) URL. `z.string().url()` ALONE accepts
 *  `javascript:`/`data:`/`file:` schemes — the host OPENS/FETCHES this URL, so a
 *  non-http scheme is a code-execution / local-file-exfil vector. The refine
 *  fails-closed for any non-http(s) scheme (red-on-injection guard). */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => {
    try {
      const scheme = new URL(u).protocol
      return scheme === "https:" || scheme === "http:"
    } catch {
      return false
    }
  }, "installUrl must be an http(s) URL")

export const DirectoryAppSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    installUrl: httpsUrl,
    version: z.string().min(1),
  })
  .strict()
export type DirectoryApp = z.infer<typeof DirectoryAppSchema>

/** Lifecycle state of an installed app. Closed union — adding a state forces a
 *  sweep over every switch. */
export type InstalledAppState = "enabled" | "disabled"

/**
 * A persisted installed-app record. Carries the descriptor fields plus the
 * lifecycle `state` and install metadata timestamps (ms-since-epoch from the
 * injected clock — NOT `Date.now()`, so tests are deterministic).
 */
export interface InstalledApp {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly installUrl: string
  readonly version: string
  readonly state: InstalledAppState
  /** ms-epoch when first installed (never changes after install). */
  readonly installedAt: number
  /** ms-epoch of the last lifecycle mutation (install/enable/disable). */
  readonly lastUpdatedAt: number
}

/**
 * The injected store for installed apps. The bundled
 * {@link createInMemoryInstalledAppStore} is the default; the host may back it
 * with the connector JSONL store for persistence. Async surface so a file/db
 * impl fits without changing callers.
 */
export interface InstalledAppStorePort {
  get(id: string): Promise<InstalledApp | undefined>
  put(app: InstalledApp): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<readonly InstalledApp[]>
}

/** Why a lifecycle op failed. Stable arm for callers. */
export type MarketplaceLifecycleError = "invalid-app" | "already-installed" | "not-installed"

export type LifecycleResult =
  | { readonly ok: true; readonly app: InstalledApp }
  | { readonly ok: false; readonly error: MarketplaceLifecycleError }

/** The marketplace lifecycle surface (V1). */
export interface ConnectorMarketplace {
  install(app: DirectoryApp): Promise<LifecycleResult>
  enable(id: string): Promise<LifecycleResult>
  disable(id: string): Promise<LifecycleResult>
  uninstall(
    id: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "not-installed" }>
  list(): Promise<readonly InstalledApp[]>
  get(id: string): Promise<InstalledApp | undefined>
}

/** Default in-memory {@link InstalledAppStorePort} — a Map keyed by app id. */
export const createInMemoryInstalledAppStore = (): InstalledAppStorePort => {
  const byId = new Map<string, InstalledApp>()
  return {
    async get(id) {
      return byId.get(id)
    },
    async put(app) {
      byId.set(app.id, app)
    },
    async delete(id) {
      byId.delete(id)
    },
    async list() {
      return [...byId.values()]
    },
  }
}

interface MarketplaceDeps {
  readonly store: InstalledAppStorePort
  readonly clock: ClockPort
}

/** Set the lifecycle state on an existing app, bumping lastUpdatedAt from the
 *  clock. Returns `not-installed` when absent. */
const transition = async (
  deps: MarketplaceDeps,
  id: string,
  state: InstalledAppState,
): Promise<LifecycleResult> => {
  const existing = await deps.store.get(id)
  if (existing === undefined) return { ok: false, error: "not-installed" }
  const updated: InstalledApp = { ...existing, state, lastUpdatedAt: deps.clock.now() }
  await deps.store.put(updated)
  return { ok: true, app: updated }
}

/**
 * Build the V1 connector marketplace lifecycle core. PURE over its injected
 * `store` + `clock`. NO-THROW: every op returns a typed result. This does NOT
 * read the gate itself — the HOST gates whether it constructs/exposes this
 * (`isConnectorMarketplaceEnabled`); default-OFF means it is never built, so the
 * store is never touched (byte-identical).
 */
export const createConnectorMarketplace = (deps: MarketplaceDeps): ConnectorMarketplace => ({
  async install(app) {
    const parsed = DirectoryAppSchema.safeParse(app)
    if (!parsed.success) return { ok: false, error: "invalid-app" }
    const d = parsed.data
    if ((await deps.store.get(d.id)) !== undefined) {
      return { ok: false, error: "already-installed" }
    }
    const now = deps.clock.now()
    const record: InstalledApp = {
      id: d.id,
      name: d.name,
      description: d.description,
      installUrl: d.installUrl,
      version: d.version,
      state: "enabled",
      installedAt: now,
      lastUpdatedAt: now,
    }
    await deps.store.put(record)
    return { ok: true, app: record }
  },
  enable(id) {
    return transition(deps, id, "enabled")
  },
  disable(id) {
    return transition(deps, id, "disabled")
  },
  async uninstall(id) {
    if ((await deps.store.get(id)) === undefined) return { ok: false, error: "not-installed" }
    await deps.store.delete(id)
    return { ok: true }
  },
  async list() {
    const all = await deps.store.list()
    return [...all].sort((a, b) => byteCompare(a.id, b.id))
  },
  get(id) {
    return deps.store.get(id)
  },
})

/**
 * The `QUANTA_CONNECTOR_MARKETPLACE` gate. DEFAULT-OFF: unset ⇒ false (the host
 * does NOT construct the marketplace; byte-identical to before). `env` is
 * injectable for tests.
 */
export const isConnectorMarketplaceEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => gateOn(env, "QUANTA_CONNECTOR_MARKETPLACE")
