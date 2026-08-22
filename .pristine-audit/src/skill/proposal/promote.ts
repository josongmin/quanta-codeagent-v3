/**
 * RFC03-2/3 — content-addressed staging + CAS promote for
 * {@link SkillProposalArtifactPort}.
 *
 * SLICE FENCE (RFC 3.1): `@/skill` may only reach `@/tool` / `@/shared`, NOT
 * `@/storage`. So this module NEVER imports `@/storage`; instead the host
 * (`@/agent` composition) injects the storage primitives it already owns
 * (`sha256Hex`, `resolveJailed`, `writeFileAtomic`, `readFile`) through
 * {@link PromoteStorageIo}. The port therefore contains NO hash / jail /
 * atomic-write reimplementation — those stay owned by `@/storage`, threaded in.
 *
 * Staging store is content-addressed (key == sha256 of value) and injectable.
 * Immutability: `put` is idempotent by content; `get(hash)` returns exactly the
 * bytes whose sha256 == hash. `promote` fails closed on every precondition miss.
 */

import type { PromoteResult, SkillProposalArtifactPort, StagedArtifact } from "./port"
import { ABSENT_PREIMAGE } from "./types"

/** A content-addressed staging store. Default is an in-memory Map; the key is
 *  the sha256 of the value, so puts are idempotent by content. */
export type StagingStore = Map<string, string>

/**
 * Storage primitives the host injects (host reuses `@/storage`):
 *   - `sha256(content)`               — content hash (staging key + CAS re-verify).
 *   - `resolveJailed(rel, root)`      — realpath jail; THROWS on `../escape`.
 *   - `writeFileAtomic(abs, content)` — atomic temp+rename commit.
 *   - `readFile(abs)`                 — read target bytes (throws on ENOENT).
 *   - `isJailError(e)`                — classify a thrown jail escape.
 */
export interface PromoteStorageIo {
  sha256(content: string): string
  resolveJailed(rel: string, root: string): string
  writeFileAtomic(abs: string, content: string): Promise<void>
  readFile(abs: string): Promise<string>
  isJailError(e: unknown): boolean
  errMessage(e: unknown): string
}

/**
 * Build the host artifact port. `skillsDir` is the live user skills directory
 * (the jail root for promotion). `io` supplies storage primitives (host reuses
 * `@/storage`). `staging` defaults to a fresh in-memory store.
 */
export const createSkillProposalArtifactPort = (
  skillsDir: string,
  io: PromoteStorageIo,
  staging: StagingStore = new Map(),
): SkillProposalArtifactPort => {
  const readTargetHash = async (abs: string): Promise<string> => {
    try {
      return io.sha256(await io.readFile(abs))
    } catch {
      // ENOENT (or any read failure) ⇒ treat as absent for the preimage compare.
      return ABSENT_PREIMAGE
    }
  }

  return {
    async put(bytes: string): Promise<StagedArtifact> {
      const hash = io.sha256(bytes)
      // Idempotent by content: re-putting identical bytes overwrites the SAME
      // key with the SAME value.
      staging.set(hash, bytes)
      return { hash, bytes }
    },

    async get(hash: string): Promise<StagedArtifact | null> {
      const bytes = staging.get(hash)
      if (bytes === undefined) return null
      // Tamper-evidence: a staged entry whose recomputed hash no longer matches
      // its key is treated as absent (the store was corrupted).
      if (io.sha256(bytes) !== hash) return null
      return { hash, bytes }
    },

    async promote(args): Promise<PromoteResult> {
      const staged = staging.get(args.hash)
      if (staged === undefined) {
        return { ok: false, reason: "unknown_artifact", detail: `no staged artifact ${args.hash}` }
      }
      // Re-verify the staged bytes still hash to the approved id (tamper guard).
      if (io.sha256(staged) !== args.hash) {
        return { ok: false, reason: "hash_mismatch", detail: "staged bytes hash changed" }
      }
      // Jail the target — a `../escape` throws → typed refusal.
      let abs: string
      try {
        abs = io.resolveJailed(args.targetPath, skillsDir)
      } catch (e) {
        const detail = io.isJailError(e) ? "target escapes skills dir" : io.errMessage(e)
        return { ok: false, reason: "jail_escape", detail }
      }
      // TOCTOU guard — re-read the live target and refuse if it drifted from the
      // preimage the proposal was compiled against.
      const currentHash = await readTargetHash(abs)
      if (currentHash !== args.expectedPreimageHash) {
        return {
          ok: false,
          reason: "preimage_drift",
          detail: `target changed since compile (expected ${args.expectedPreimageHash}, found ${currentHash})`,
        }
      }
      // CAS write — atomic temp+rename.
      try {
        await io.writeFileAtomic(abs, staged)
      } catch (e) {
        return { ok: false, reason: "write_error", detail: io.errMessage(e) }
      }
      return { ok: true, path: abs }
    },
  }
}
