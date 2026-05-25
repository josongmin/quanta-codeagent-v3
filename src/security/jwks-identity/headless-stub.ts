/**
 * Headless JWKS stub (ADR-0248). Typed no-op client for surfaces that
 * explicitly skip JWKS verification (e.g. fully-local headless mode where
 * no external dispatcher is configured).
 *
 * The stub is NOT a security bypass — it returns `{ ok: false, reason:
 * "cache-miss" }` on every verify so a caller that accidentally wires the
 * stub into a surface that DOES expect verification gets a deterministic
 * failure rather than a silent allow.
 */

import type { JwksClient } from "./port"
import { type JwksSet, JwksFetchError, type VerifyResult } from "./types"

/**
 * Build the headless stub. Holds no state.
 */
export function headlessJwksClient(): JwksClient {
  return {
    async fetchJwks(url: string): Promise<JwksSet> {
      throw new JwksFetchError("headless stub — no network configured", url)
    },
    cacheGet(_url: string): JwksSet | null {
      return null
    },
    async verify(_jwt: string): Promise<VerifyResult> {
      return { ok: false, reason: "cache-miss" }
    },
    async refresh(url: string): Promise<JwksSet> {
      throw new JwksFetchError("headless stub — no network configured", url)
    },
  }
}
