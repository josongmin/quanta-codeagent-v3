/** Identity slice barrel (ADR-0198). */
export { DEFAULT_IDENTITIES, UNKNOWN_MODE_IDENTITY } from "./default-identities"
export { defaultIdentityProvider } from "./lookup"
export {
  assertValidIdentityLines,
  IDENTITY_MODES,
  IdentityLineError,
  type IdentityMode,
  type IdentityProvider,
} from "./port"
