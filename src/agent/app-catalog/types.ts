/**
 * ADR-0336 — App catalog types.
 *
 * "App" in quanta = a named binding into the multi-surface model
 * defined in memory `surface-model.md`. quanta runs on three
 * surfaces (CLI / Web-Tauri / CLI-embedded browser); each surface
 * may expose zero or more user-mentionable apps that the model can
 * activate via the `@@app` mention sigil (ADR-0325 — closed 3-kind
 * mention enum).
 *
 * The {@link AppSurface} enum mirrors the three quanta surfaces
 * verbatim. It is **frozen** by this ADR; adding a new surface
 * requires a new ADR. ROI of an absorbed feature is NOT gated by
 * surface availability (per `surface-model.md`) — a missing
 * surface ⇒ the catalog simply does not list that app.
 *
 * Closed-port + closed-enum surface. The catalog is read-only
 * from the resolver's perspective; future ADRs may add a writeable
 * surface (plugin-declared apps, per-workspace overrides, …).
 */

/**
 * Closed set of quanta runtime surfaces. Mirrors `surface-model.md`
 * verbatim. **Frozen.**
 *
 *   - `cli`         — terminal CLI (the canonical surface).
 *   - `web-tauri`   — Tauri desktop shell hosting the web frontend.
 *   - `cli-browser` — embedded browser surface inside the CLI
 *                     (headless / DevTools-attached). Distinct from
 *                     `web-tauri` — the CLI surface owns the lifecycle.
 */
export type AppSurface = "cli" | "web-tauri" | "cli-browser"

/**
 * A single mentionable app descriptor. The `id` is the kebab-case
 * token following `@@` in the user input (e.g. `@@browser` ⇒
 * `id === "browser"`). The `surface` is informational — it tells
 * the resolver which runtime would actually host this app, which
 * the resolver embeds in the mention body so the model can reason
 * about availability.
 *
 * `description` is optional but recommended — it is the user-facing
 * tagline the resolver emits into the mention body (progressive-
 * disclosure parity with skill / plugin resolvers).
 */
export interface AppDescriptor {
  /** Kebab-case app id (the `@@<id>` mention token). */
  readonly id: string
  /** Closed-enum runtime surface this app binds to. */
  readonly surface: AppSurface
  /** Optional human-readable tagline. */
  readonly description?: string
}

/**
 * Closed read-only catalog port. Mirrors the shape of
 * `PluginRegistryPort` so callers can adopt the identical
 * lookup/list seam.
 *
 * NO-THROW contract: implementations MUST swallow errors and
 * return `null` / `[]`.
 */
export interface AppCatalogPort {
  /** Returns the descriptor or `null` for unknown / malformed ids. */
  lookup(id: string): AppDescriptor | null
  /** Returns all known app descriptors. Ordering is implementation-
   *  defined (insertion order for the in-memory adapter, the order
   *  the `DEFAULT_APP_CATALOG` array declares for the default). */
  list(): readonly AppDescriptor[]
}
