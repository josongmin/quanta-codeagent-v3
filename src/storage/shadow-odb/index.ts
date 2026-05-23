/** Shadow git ODB slice (ADR-0108).
 *
 *  Public surface: the `ShadowOdb` closed port, its config seam, and the
 *  default factory `defaultShadowOdb`. Tests reach in for `workspaceHash`
 *  and `evictLru` to exercise the bare utilities in isolation. */

export { evictLru } from "./cleanup"
export { defaultShadowOdb } from "./default"
export { workspaceHash } from "./hash"
export type {
  ShadowInitResult,
  ShadowOdb,
  ShadowOdbConfig,
  ShadowOdbErrorCode,
} from "./types"
export {
  DEFAULT_SHADOW_ODB_MAX_BYTES,
  SHADOW_LAST_REF,
  ShadowOdbError,
} from "./types"
