import { homedir } from "node:os"
import { join } from "node:path"
import { runtimeConfig } from "@/shared"

/**
 * Surface-agnostic session-root port (Audit-W blocker #2).
 *
 * The legacy `sessionsRoot()` resolves to a single process-wide directory
 * (`runtimeConfig().sessionsDir ?? ~/.quanta/sessions`). That is correct for
 * the CLI surface where one OS user owns the whole process, but it does NOT
 * compose with multi-tenant surfaces:
 *
 *   - **Web (Tauri/server)**: a single daemon serves many authenticated
 *     users. If the session store keys off a process-wide path, user A's
 *     `loadSessionById("abc")` would read user B's `<root>/abc.json` —
 *     a cross-tenant data-leak.
 *   - **Tauri**: each install (per-OS-user) should write under its own
 *     app-data dir, not the OS-user's `$HOME`.
 *
 * `SessionRootProvider` inverts the dependency: the surface (CLI / Web /
 * Tauri) supplies the rooting strategy, and the session slice asks the
 * provider per call. The CLI default is the legacy resolver — passing no
 * provider is byte-identical to today.
 *
 * `resolve()` is async so a Web provider can do an IPC / DB lookup off the
 * authenticated request without blocking the event loop. Returning a
 * relative path is allowed; callers resolve against `process.cwd()` if
 * needed (matches `node:path`'s `join` semantics).
 *
 * Layering: this file imports only `@/shared` and Node built-ins, so it
 * respects the `@/session` slice override in `biome.json` (which allows
 * `@/llm`, `@/storage`, `@/shared`).
 */
export interface SessionRootProvider {
  resolve(): Promise<string>
}

/**
 * Legacy-equivalent provider. Resolves the same way the synchronous
 * `sessionsRoot()` does, so injecting it (or omitting a provider entirely)
 * yields the identical on-disk layout. Used as the implicit default in
 * every `*Async` overload below.
 *
 * NOTE: this re-reads `runtimeConfig()` on each call rather than caching,
 * matching `sessionsRoot()` so `__resetRuntimeConfig()` in tests is honored
 * the same way through both code paths.
 */
export const defaultSessionRootProvider: SessionRootProvider = {
  async resolve(): Promise<string> {
    return runtimeConfig().sessionsDir ?? join(homedir(), ".quanta", "sessions")
  },
}

/**
 * Inline constructor for a fixed-root provider. Useful for tests and for
 * Web-tenant code that pre-computed the root path elsewhere.
 *
 *     const provider = staticSessionRootProvider("/var/quanta/sessions/u-42")
 *
 * The returned object is a fresh value each call, so two surfaces holding
 * different `staticSessionRootProvider(...)` instances are guaranteed to
 * stay isolated.
 */
export const staticSessionRootProvider = (root: string): SessionRootProvider => ({
  async resolve(): Promise<string> {
    return root
  },
})
