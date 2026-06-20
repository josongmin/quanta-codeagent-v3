/**
 * Multi-Auth Fleet (jun-20) — T-2 AuthLeaseManager (pure in-memory core).
 *
 * Owns per-account capacity, per-account cooldown, and release accounting for a
 * multi-account bench fleet. It answers, deterministically and with NO I/O:
 *  - which account can take a new chunk now,
 *  - how many slots it may consume,
 *  - whether a 429 cools down ONLY that account,
 *  - whether the next worker should wait, pick another account, or give up.
 *
 * The whole point is throttle ISOLATION: account A's 429 must never back off B.
 * So cooldown is per-account state, never a single global backoff lane.
 */
import type { AuthPoolEntry } from "./types"

/** Default base cooldown when an account omits `cooldownBaseSec`. */
export const DEFAULT_COOLDOWN_BASE_SEC = 60
/** Hard ceiling on exponential per-account cooldown. */
export const MAX_COOLDOWN_SEC = 900

export interface AcquireRequest {
  /** Slots this chunk would like (≈ per-box patch-gen concurrency). Clamped to
   *  the account's residual capacity; a granted lease never exceeds it. */
  readonly requestedSlots: number
  readonly runId: string
  /** Soft affinity — prefer reusing a same-account warm box if it has room. */
  readonly preferredAccountLabel?: string
}

export interface ReleaseResult {
  /** This chunk hit the shared-OAuth 429 ⇒ cool down THIS account only. */
  readonly rateLimited: boolean
  /** The box died mid-chunk; slots must still be returned. */
  readonly lostBox: boolean
  /** The chunk graded cleanly ⇒ reset this account's backoff streak. */
  readonly completed: boolean
}

export interface AuthLease {
  readonly accountLabel: string
  readonly authFile: string
  readonly grantedSlots: number
  /** Return capacity to the account. Idempotent: a double-release (e.g. a
   *  finally-block after an explicit release) is a no-op, so slots can't leak
   *  OR be returned twice. */
  release(result: ReleaseResult): void
}

/** Observable per-account state — feeds T-6 `auth status`. No token material. */
export interface AccountStatus {
  readonly label: string
  readonly maxParallel: number
  readonly maxBoxes?: number
  readonly activeSlots: number
  readonly activeBoxes: number
  readonly disabled: boolean
  /** Epoch ms until which the account is cooling; undefined ⇒ ready. */
  readonly cooldownUntil?: number
  readonly consecutiveRateLimited: number
}

interface AccountState {
  readonly entry: AuthPoolEntry
  activeSlots: number
  activeBoxes: number
  cooldownUntil: number
  consecutiveRateLimited: number
}

export interface LeaseManagerOpts {
  /** Injectable clock for deterministic tests. Defaults to wall time. */
  readonly now?: () => number
}

export class AuthLeaseManager {
  private readonly accounts: AccountState[]
  private readonly now: () => number

  constructor(entries: readonly AuthPoolEntry[], opts: LeaseManagerOpts = {}) {
    if (entries.length === 0) throw new Error("AuthLeaseManager: needs ≥1 account")
    this.now = opts.now ?? (() => Date.now())
    this.accounts = entries.map((entry) => ({
      entry,
      activeSlots: 0,
      activeBoxes: 0,
      cooldownUntil: 0,
      consecutiveRateLimited: 0,
    }))
  }

  /** Is this account schedulable right now (enabled, not cooling, has room)? */
  private isReady(s: AccountState, now: number): boolean {
    if (s.entry.disabled === true) return false
    if (now < s.cooldownUntil) return false
    if (s.activeSlots >= s.entry.maxParallel) return false
    if (s.entry.maxBoxes !== undefined && s.activeBoxes >= s.entry.maxBoxes) return false
    return true
  }

  /** Lower = less loaded. Normalised by maxParallel so heterogeneous accounts
   *  compare fairly; `weight` widens effective capacity. */
  private loadScore(s: AccountState): number {
    const weight = s.entry.weight ?? 1
    return s.activeSlots / (s.entry.maxParallel * weight)
  }

  /**
   * Acquire a lease for one chunk. Returns null when NO account can take work
   * now (all disabled, cooling, or saturated) — the caller then waits/requeues.
   *
   * Tie-break (deterministic): preferred (if ready) > least-loaded > stable
   * manifest order.
   */
  acquire(req: AcquireRequest): AuthLease | null {
    const now = this.now()
    const ready = this.accounts.filter((s) => this.isReady(s, now))
    if (ready.length === 0) return null

    let chosen: AccountState | undefined
    if (req.preferredAccountLabel !== undefined) {
      chosen = ready.find((s) => s.entry.label === req.preferredAccountLabel)
    }
    if (chosen === undefined) {
      // least-loaded; ties resolve by manifest order (filter preserves it, and
      // a strict `<` comparison keeps the first-seen winner on equal score).
      for (const s of ready) {
        if (chosen === undefined || this.loadScore(s) < this.loadScore(chosen)) chosen = s
      }
    }
    if (chosen === undefined) return null

    const residual = chosen.entry.maxParallel - chosen.activeSlots
    const grantedSlots = Math.max(1, Math.min(Math.floor(req.requestedSlots) || 1, residual))
    chosen.activeSlots += grantedSlots
    chosen.activeBoxes += 1

    const state = chosen
    let released = false
    return {
      accountLabel: state.entry.label,
      authFile: state.entry.authFile,
      grantedSlots,
      release: (result: ReleaseResult): void => {
        if (released) return // idempotent — no double-return / no leak
        released = true
        state.activeSlots = Math.max(0, state.activeSlots - grantedSlots)
        state.activeBoxes = Math.max(0, state.activeBoxes - 1)
        if (result.rateLimited) {
          state.consecutiveRateLimited += 1
          const baseSec = state.entry.cooldownBaseSec ?? DEFAULT_COOLDOWN_BASE_SEC
          const sec = Math.min(
            MAX_COOLDOWN_SEC,
            baseSec * 2 ** (state.consecutiveRateLimited - 1),
          )
          state.cooldownUntil = this.now() + sec * 1000
        } else if (result.completed) {
          state.consecutiveRateLimited = 0
        }
        // lostBox without rateLimited: slots returned, streak untouched.
      },
    }
  }

  /** Snapshot for observability. Pure read; cooldownUntil omitted once expired. */
  snapshot(): readonly AccountStatus[] {
    const now = this.now()
    return this.accounts.map((s) => ({
      label: s.entry.label,
      maxParallel: s.entry.maxParallel,
      ...(s.entry.maxBoxes !== undefined ? { maxBoxes: s.entry.maxBoxes } : {}),
      activeSlots: s.activeSlots,
      activeBoxes: s.activeBoxes,
      disabled: s.entry.disabled === true,
      ...(s.cooldownUntil > now ? { cooldownUntil: s.cooldownUntil } : {}),
      consecutiveRateLimited: s.consecutiveRateLimited,
    }))
  }

  /** True iff at least one account could accept work now. Lets a worker loop
   *  distinguish "wait and retry" (some account is merely cooling) from "give
   *  up" (every account is disabled). */
  hasSchedulableAccount(): boolean {
    const now = this.now()
    return this.accounts.some((s) => this.isReady(s, now))
  }

  /** Soonest epoch-ms a cooling account becomes ready, or undefined if none are
   *  merely cooling (i.e. nothing to wait for). Ignores saturated/disabled. */
  nextReadyAt(): number | undefined {
    const now = this.now()
    let soonest: number | undefined
    for (const s of this.accounts) {
      if (s.entry.disabled === true) continue
      if (s.cooldownUntil > now && (soonest === undefined || s.cooldownUntil < soonest)) {
        soonest = s.cooldownUntil
      }
    }
    return soonest
  }
}
