/**
 * Per-project trust store for the central config slice (ADR-0497, jun-7-misc
 * 05, §4.c — the security crux).
 *
 * A persisted record keyed by CANONICAL repo path, default UNTRUSTED. Parity
 * with Claude's `hasTrustDialogAccepted` / `setPathTrusted` (per `projects[<path>]`)
 * and Codex's `[projects."<path>"] trust_level`.
 *
 * Discipline:
 *   - **Default UNTRUSTED.** A path with no record is untrusted. A never-seen
 *     repo's project/local capability grants are dropped (fail-closed).
 *   - **Path-pinned.** Trust is recorded against a CANONICAL absolute path.
 *     Trusting `/a` does NOT trust `/b`, and does NOT trust `/a/sub`. Aliased
 *     spellings (`./X`, `/a/./X`, trailing slash) canonicalize to ONE key, so
 *     trust cannot leak via path aliasing — and a child cannot be mistaken for
 *     a trusted parent.
 *   - **Explicit grant only.** {@link TrustStore.setTrusted} is the deliberate
 *     user action (the host wires it behind an interactive trust prompt /
 *     `--trust` flag / `QUANTA_TRUSTED_PATHS`). Enabling the loader is NOT a
 *     trust grant.
 *
 * Persistence IO (read/write of the trust file) is injected as a closed port so
 * the pure store is testable and the default-OFF path allocates nothing.
 */

import { isAbsolute, normalize, resolve, sep } from "node:path"

/** One persisted trust record. `grantedAt` is supplied by the host (an injected
 *  clock value) — the store never reads wall-clock itself. */
export interface TrustRecord {
  readonly trusted: boolean
  /** epoch-ms when trust was granted (host-supplied; informational). */
  readonly grantedAt: number
}

/** Persistence port: load the raw record map (path → record) and persist it.
 *  `undefined` from load ⇒ no trust file yet (everything untrusted). */
export interface TrustPersistencePort {
  readonly load: () => Promise<Readonly<Record<string, TrustRecord>> | undefined>
  /**
   * Persist ONLY the caller's dirty mutations. Adapters MUST re-read the
   * durable map, merge these keys, and atomically replace. A whole-map
   * overwrite of a stale in-memory snapshot is forbidden (F-12).
   */
  readonly commit: (mutations: Readonly<Record<string, TrustRecord>>) => Promise<void>
}

/**
 * Canonicalize a project path to its trust-store key. Purely lexical (no FS /
 * symlink resolution here — the host resolves symlinks via `realpath` BEFORE
 * handing the path in, so the store stays pure and deterministic). Collapses
 * `.`/`..` segments, strips a trailing separator, and requires an absolute
 * path. A relative path is resolved against `cwd` if supplied, else rejected.
 *
 * The result is the SINGLE canonical key, so `/a`, `/a/`, `/a/./`, `/a/sub/..`
 * all map to the same key, while `/a` and `/a/sub` map to DISTINCT keys (no
 * child-inherits-parent trust).
 */
export const canonicalizeProjectPath = (path: string, cwd?: string): string => {
  const abs = isAbsolute(path) ? path : cwd !== undefined ? resolve(cwd, path) : undefined
  if (abs === undefined) {
    throw new Error("canonicalizeProjectPath: relative path requires a cwd base")
  }
  let canon = normalize(abs)
  // Strip a trailing separator (but keep a bare root like "/" intact).
  while (canon.length > 1 && canon.endsWith(sep)) canon = canon.slice(0, -1)
  return canon
}

/** A pure, in-memory trust store hydrated from (optional) persisted records.
 *  Lookups are default-UNTRUSTED. Mutations are buffered until {@link flush}. */
export class TrustStore {
  private readonly records: Map<string, TrustRecord>
  private readonly dirtyMutations = new Map<string, TrustRecord>()

  private constructor(
    records: Map<string, TrustRecord>,
    private readonly persistence: TrustPersistencePort,
  ) {
    this.records = records
  }

  /** Hydrate from the persistence port. Absent file ⇒ empty (all untrusted). */
  static async load(persistence: TrustPersistencePort): Promise<TrustStore> {
    const raw = await persistence.load()
    const records = new Map<string, TrustRecord>()
    if (raw !== undefined) {
      for (const [key, rec] of Object.entries(raw)) {
        if (rec === null || typeof rec !== "object" || typeof rec.trusted !== "boolean") continue
        // FAIL-SOFT (mirrors the loader's per-layer parse discipline): a
        // persisted key that does not canonicalize — a relative path, an empty
        // string, file corruption, or a forged map crafted to DoS hydration —
        // is SKIPPED, never thrown. A single bad key must not crash the store
        // nor discard the file's other, legitimately-trusted records.
        let canonKey: string
        try {
          canonKey = canonicalizeProjectPath(key)
        } catch {
          continue
        }
        records.set(canonKey, {
          trusted: rec.trusted,
          grantedAt: typeof rec.grantedAt === "number" ? rec.grantedAt : 0,
        })
      }
    }
    return new TrustStore(records, persistence)
  }

  /** DEFAULT UNTRUSTED: a path with no `trusted:true` record is untrusted.
   *
   *  FAIL-CLOSED (round-3 F4): this is the security GATE read, so a
   *  non-canonicalizable lookup path (a relative path / empty string handed in
   *  without a cwd base) resolves to UNTRUSTED rather than propagating a throw.
   *  A throwing gate is both an availability bug (it crashes the session at the
   *  trust check) and a fail-open risk (an upstream catch could mishandle it).
   *  This mirrors `canonicalizeTrustedPaths`, which already drops (never
   *  trusts) an un-canonicalizable path. Mutations (`setTrusted`/`setUntrusted`)
   *  deliberately still throw — an explicit grant against a bad path is a
   *  caller programming error, not a gate read. */
  isTrusted(path: string, cwd?: string): boolean {
    let key: string
    try {
      key = canonicalizeProjectPath(path, cwd)
    } catch {
      return false
    }
    const rec = this.records.get(key)
    return rec?.trusted === true
  }

  /** Record an explicit trust grant for a canonical path. `now` is the
   *  host-supplied epoch-ms (injected clock — the store never reads time). */
  setTrusted(path: string, now: number, cwd?: string): void {
    const key = canonicalizeProjectPath(path, cwd)
    const rec = { trusted: true, grantedAt: now }
    this.records.set(key, rec)
    this.dirtyMutations.set(key, rec)
  }

  /** Explicitly revoke trust (records `trusted:false`, an explicit untrust). */
  setUntrusted(path: string, now: number, cwd?: string): void {
    const key = canonicalizeProjectPath(path, cwd)
    const rec = { trusted: false, grantedAt: now }
    this.records.set(key, rec)
    this.dirtyMutations.set(key, rec)
  }

  /** Persist buffered mutations. No-op when nothing changed. */
  async flush(): Promise<void> {
    if (this.dirtyMutations.size === 0) return
    const snapshot: Record<string, TrustRecord> = {}
    for (const [k, v] of this.dirtyMutations) snapshot[k] = v
    await this.persistence.commit(snapshot)
    for (const [k, v] of Object.entries(snapshot)) {
      const live = this.dirtyMutations.get(k)
      if (live === v) this.dirtyMutations.delete(k)
    }
  }
}

/** Resolve a static allow-list of trusted paths (e.g. `QUANTA_TRUSTED_PATHS`
 *  for headless/CI, §9 Q3) into canonical keys. Empty list ⇒ empty set. This
 *  is the explicit, deliberate CI opt-in — NEVER an auto-trust of cwd. */
export const canonicalizeTrustedPaths = (
  paths: readonly string[],
  cwd?: string,
): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const p of paths) {
    if (p.trim().length === 0) continue
    try {
      out.add(canonicalizeProjectPath(p, cwd))
    } catch {
      // a relative path with no cwd base is dropped (never silently trusted)
    }
  }
  return out
}
