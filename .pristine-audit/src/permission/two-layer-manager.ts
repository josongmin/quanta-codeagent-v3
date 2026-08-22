/**
 * 2-layer permission manager (ADR-0135).
 *
 * In-memory companion to {@link PermissionStore} for the ADR-0135 layered
 * model. Carries the per-thread {@link PermissionProfile} + per-thread
 * {@link FileSystemSandboxPolicy} that compose with the existing
 * {@link PermissionStore} axes (HARD_DENY > read-only > post-denial > per-
 * thread sandbox > per-host > global default).
 *
 * Why a SEPARATE module instead of bolting onto `PermissionStore`?
 *   - The on-disk persistence format ({@link PermissionState} v1) does NOT
 *     yet carry profile/sandbox state — versioning a JSON file with a new
 *     mandatory shape is a security-sensitive migration, and the rules say
 *     "Backward compat 100%". The two-layer manager is in-memory only; a
 *     follow-up ADR can choose to persist it once shape lands.
 *   - It keeps the slice fence trivially intact: this module imports the
 *     pure types from `permission-profile.ts` + the leaf access checker, and
 *     never touches the persistence engine.
 *
 * The {@link getEffectiveAccess} priority resolver extends the documented
 * `evaluateStack` precedence table:
 *
 *     1. HARD_DENY                         (security boundary; nothing wins)
 *     2. read-only fast-path               (action.isReadOnly)
 *     3. post-denial user override         (existing)
 *     4. **ADR-0135: PermissionProfile AND sandbox** (this module's gate)
 *     5. per-thread permission             (existing)
 *     6. per-host agent mode               (existing)
 *     7. global default                    (existing)
 *
 * Step 4 ONLY fires when a profile (or sandbox) is registered for the thread;
 * absent thread state passes through untouched (backward compat 100%).
 *
 * Slice rules: pure facade; uses the access checker + permission types.
 * No IO.
 */

import { canAccess } from "./access-check"
import { resolveProfileByName } from "./named-profiles"
import type {
  FileSystemAccess,
  FileSystemSandboxPolicy,
  PermissionProfile,
} from "./permission-profile"
import {
  DEFAULT_FILE_SYSTEM_SANDBOX_POLICY,
  DEFAULT_PERMISSION_PROFILE,
} from "./permission-profile"
import type { ProfileDefinitionRegistry, ResolveInheritanceOpts } from "./profile-inheritance"
import { resolveProfileInheritance } from "./profile-inheritance"
import type { CachedResolver } from "./special-path-resolver"

/** Verdict + the layer that produced it — surfaces drift to the gate's
 *  inspector + audit trail. */
export interface EffectiveAccessResult {
  readonly allow: boolean
  readonly reason?: string
  /** Which axis decided. `"profile-and-sandbox"` is the ADR-0135 layer;
   *  `"no-policy"` means no profile was set so the manager abstained (the
   *  caller should fall through to the legacy stack). */
  readonly decidedBy: "profile-and-sandbox" | "no-policy"
}

/** Per-thread layered state. Either field may be absent — the gate only
 *  enforces what's present. When BOTH are absent the manager abstains
 *  (`decidedBy: "no-policy"`) so legacy callers see no behavior change. */
interface ThreadLayered {
  profile?: PermissionProfile
  sandbox?: FileSystemSandboxPolicy
}

export interface TwoLayerManager {
  /** Register / replace the {@link PermissionProfile} for `threadId`. */
  setPermissionProfile(threadId: string, profile: PermissionProfile): void
  /** Track A2 — register / replace the profile for `threadId` BY NAME, resolved
   *  through {@link NAMED_PROFILES}. Throws on an unknown / `custom` name (use
   *  the struct API for bespoke `custom` profiles). Backward-compat: this is a
   *  thin sugar over {@link setPermissionProfile} — the struct API is unchanged. */
  setPermissionProfileByName(threadId: string, name: string): void
  /** ADR-0438 — register / replace the profile for `threadId` resolved through
   *  the inheritance graph: `resolveProfileInheritance(name, registry)` folds the
   *  `extends` chain (monotone-narrowing + Managed ceiling), then the merged
   *  concrete {@link PermissionProfile} flows through the SAME single write site
   *  as {@link setPermissionProfile}. A name with no registry entry resolves to a
   *  built-in (via `opts.builtins`, default `NAMED_PROFILES`) byte-identically, so
   *  this is a strict superset of {@link setPermissionProfileByName}. Throws a
   *  {@link ProfileInheritanceError} on a cycle / self-extend / unknown base /
   *  managed-widen (when `onManagedWiden:"throw"`) — fail-closed, never a silent
   *  permissive fallback. */
  setPermissionProfileFromRegistry(
    threadId: string,
    name: string,
    registry: ProfileDefinitionRegistry,
    opts?: ResolveInheritanceOpts,
  ): void
  /** Register / replace the {@link FileSystemSandboxPolicy} for `threadId`. */
  setFileSystemSandboxPolicy(threadId: string, sandbox: FileSystemSandboxPolicy): void
  /** Forget the layered state for `threadId`. After this, the gate abstains. */
  clearThread(threadId: string): void

  /** Read the current profile for `threadId` (if any). */
  getPermissionProfile(threadId: string): PermissionProfile | undefined
  /** Read the current sandbox for `threadId` (if any). */
  getFileSystemSandboxPolicy(threadId: string): FileSystemSandboxPolicy | undefined

  /** Resolve `(path, op)` against the layered state.
   *  - Both profile + sandbox absent ⇒ `{decidedBy: "no-policy"}` (caller
   *    should fall through to the legacy stack).
   *  - Either present ⇒ run the 2-layer AND check, filling absent layers
   *    with {@link DEFAULT_PERMISSION_PROFILE.fileSystem} /
   *    {@link DEFAULT_FILE_SYSTEM_SANDBOX_POLICY} (deny-by-default — strictest
   *    sensible behavior when a partial config is supplied). */
  getEffectiveAccess(
    threadId: string,
    path: string,
    op: FileSystemAccess,
    resolver: CachedResolver,
  ): EffectiveAccessResult

  /** Test seam. */
  clear(): void
}

export const createTwoLayerManager = (): TwoLayerManager => {
  const byThread = new Map<string, ThreadLayered>()

  const upsert = (threadId: string, mut: (s: ThreadLayered) => void): void => {
    const existing = byThread.get(threadId) ?? {}
    mut(existing)
    byThread.set(threadId, existing)
  }

  return {
    setPermissionProfile(threadId, profile) {
      upsert(threadId, (s) => {
        s.profile = profile
      })
    },
    setPermissionProfileByName(threadId, name) {
      // Resolve through the registry (throws on unknown / `custom`), then reuse
      // the struct path so there is ONE write site.
      const profile = resolveProfileByName(name)
      upsert(threadId, (s) => {
        s.profile = profile
      })
    },
    setPermissionProfileFromRegistry(threadId, name, registry, opts) {
      // Resolve the `extends` graph (fail-closed throws on cycle/unknown/widen),
      // then reuse the struct path so there is ONE write site.
      const profile = resolveProfileInheritance(name, registry, opts)
      upsert(threadId, (s) => {
        s.profile = profile
      })
    },
    setFileSystemSandboxPolicy(threadId, sandbox) {
      upsert(threadId, (s) => {
        s.sandbox = sandbox
      })
    },
    clearThread(threadId) {
      byThread.delete(threadId)
    },
    getPermissionProfile: (threadId) => byThread.get(threadId)?.profile,
    getFileSystemSandboxPolicy: (threadId) => byThread.get(threadId)?.sandbox,
    getEffectiveAccess(threadId, path, op, resolver) {
      const layered = byThread.get(threadId)
      if (layered === undefined) return { allow: false, decidedBy: "no-policy" }
      const { profile, sandbox } = layered
      if (profile === undefined && sandbox === undefined) {
        return { allow: false, decidedBy: "no-policy" }
      }
      const effProfile = profile ?? DEFAULT_PERMISSION_PROFILE
      const effSandbox = sandbox ?? DEFAULT_FILE_SYSTEM_SANDBOX_POLICY
      const verdict = canAccess(path, op, {
        profile: effProfile,
        sandbox: effSandbox,
        resolver,
      })
      const result: EffectiveAccessResult = {
        allow: verdict.allow,
        decidedBy: "profile-and-sandbox",
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      }
      return result
    },
    clear() {
      byThread.clear()
    },
  }
}
