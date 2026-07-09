/**
 * `/doctor` real-probe wiring (RFC jun-6-doctor-selfcheck §5 "Probes wiring").
 *
 * THIS is the surface adapter that builds {@link DoctorProbes} over the
 * existing accessors — it legitimately imports `@/auth` / `@/llm` / `@/shared`
 * / `@/session` and reads `process.env` / `Date.now` (the surface is where
 * ambient access is allowed). The pure check-registry leaf
 * (`registry.ts` / `render.ts`) NEVER touches any of these — it only sees the
 * injected probe shape.
 *
 * Each probe REUSES the §3.2 accessors (it does not re-implement them):
 *   - auth     → `/status`'s resolvers (`readResolvedToken`, `isExpired`,
 *                `pickProvider`) + BYOK env presence.
 *   - terminal → `process.stdout` (read here, injected as a value).
 *   - mcp      → the `SlashContext.mcp` structural surface `/mcp` consumes.
 *   - config   → `runtimeConfig()` + the documented dead-knob conditions.
 *   - stateDb  → `listSessions()` (the corrupt-tolerant index/session reader).
 */

import { isExpired, readResolvedToken, resolveChatgptTokenCandidates } from "@/auth/chatgpt-oauth"
import { pickProvider } from "@/llm"
import { checkSessionStoreHealth, listSessions } from "@/session"
import { errMessage, runtimeConfig } from "@/shared"
import type { SlashContext } from "../slash-contract"
import type { DoctorProbes } from "./types"

/** Near-expiry window mirrored from `/status` (5 min). */
const EXPIRY_SOON_MS = 5 * 60 * 1000

const envOf = (): Record<string, string | undefined> => process.env

/** Build the real probe set for a `/doctor` run, reading the live ctx. */
export const defaultDoctorProbes = (ctx: SlashContext): DoctorProbes => {
  const now = (): number => (ctx.now ? ctx.now() : Date.now())

  return {
    now,
    auth: async () => {
      const env: Record<string, string | undefined> = {
        ...envOf(),
        ...(ctx.prefsHome !== undefined ? { QUANTA_PREFS_HOME: ctx.prefsHome } : {}),
      }
      const provider = pickProvider(env)
      const keyPresent = env.OPENAI_API_KEY !== undefined || env.ANTHROPIC_API_KEY !== undefined
      // ChatGPT-OAuth token state (presence/expiry only — never the value).
      let tokenExpired: boolean | undefined
      let tokenExpiringSoon: boolean | undefined
      try {
        const resolved = await readResolvedToken(env)
        const rec = resolved?.record
        if (rec !== undefined) {
          const nowMs = now()
          tokenExpired = isExpired(rec, nowMs, 0)
          tokenExpiringSoon = !tokenExpired && isExpired(rec, nowMs, EXPIRY_SOON_MS)
        } else if (resolveChatgptTokenCandidates(env).length === 0) {
          // no candidate file at all — nothing to report on the token axis.
        }
      } catch {
        // tolerate token read errors (mirrors /status) — fall through to
        // key-presence; a missing token is not itself a hard failure unless
        // there is also no BYOK key.
      }
      const result: {
        provider: string
        keyPresent: boolean
        tokenExpired?: boolean
        tokenExpiringSoon?: boolean
      } = { provider, keyPresent }
      if (tokenExpired !== undefined) result.tokenExpired = tokenExpired
      if (tokenExpiringSoon !== undefined) result.tokenExpiringSoon = tokenExpiringSoon
      return result
    },
    terminal: () => {
      const stdout = process.stdout
      const isTTY = stdout.isTTY === true
      const columns = typeof stdout.columns === "number" ? stdout.columns : 80
      // raw-mode is available iff stdin is a TTY exposing setRawMode.
      const rawModeAvailable =
        process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function"
      return { isTTY, columns, rawModeAvailable }
    },
    mcp: async () => {
      const surface = ctx.mcp
      if (surface === undefined) return []
      return surface.servers.map((s) => ({
        name: s.name,
        connected: s.status === "connected" || s.status === "degraded",
        toolCount: s.toolCount,
        ...(s.errorMessage !== undefined ? { error: s.errorMessage } : {}),
      }))
    },
    config: () => {
      try {
        const cfg = runtimeConfig()
        const warnings: string[] = []
        // Documented dead-knob condition (runtime-config.ts:169) — `mcpSampling`
        // ON has zero production consumers until the composition lands.
        if (cfg.mcpSampling) {
          warnings.push("QUANTA_MCP_SAMPLING=1 set but no sampling handler is composed (no-op)")
        }
        return { loaded: true, warnings }
      } catch (e) {
        return { loaded: false, warnings: [], error: errMessage(e) }
      }
    },
    stateDb: async () => {
      try {
        // listSessions reads the index map; a corrupt index/session self-heals
        // or surfaces here. A successful read ⇒ index valid + sessions readable.
        await listSessions({ includeArchived: true })
        return { sessionsReadable: true, indexValid: true }
      } catch (e) {
        return { sessionsReadable: false, indexValid: false, error: errMessage(e) }
      }
    },
    // UUX-4-05 — the AGGREGATE store scan. `checkSessionStoreHealth` never
    // throws (fs errors are folded into the report) and is read-only, so
    // this probe is a straight pass-through; the check maps its verdict to
    // warn/fail with the report's own recovery guidance.
    storeHealth: async () => await checkSessionStoreHealth(),
  }
}
