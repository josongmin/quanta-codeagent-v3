/**
 * Multi-Auth Fleet (jun-20) — public surface for the bench auth-pool module.
 * Entrypoints import from here, not from individual files.
 */
export type { AuthPoolEntry, AuthSource } from "./types"
export {
  type AccountStatus,
  type AcquireRequest,
  type AuthLease,
  AuthLeaseManager,
  DEFAULT_COOLDOWN_BASE_SEC,
  type LeaseManagerOpts,
  MAX_COOLDOWN_SEC,
  type ReleaseResult,
} from "./lease-manager"
export {
  defaultAuthFile,
  describeAuthSource,
  loadAuthPoolFile,
  parseAuthPoolManifest,
  type ResolveAuthOpts,
  resolveAuthSource,
} from "./load"
