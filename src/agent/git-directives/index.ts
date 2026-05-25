/**
 * ADR-0205 — Git directive emit protocol barrel.
 *
 * Out-of-band `::git-*` channel for UI sync after successful mutating git
 * operations. See ADR-0205 for the wire format, default-OFF posture, and
 * the 15-case hellgate that pins the contract.
 */

export { type DirectiveSink, defaultStdoutEmitter } from "./default-stdout-emitter"
export { noopEmitter } from "./no-op-emitter"
export { parse } from "./parser"
export type { GitDirectiveEmitter } from "./port"
export { serialize } from "./serializer"
export {
  GIT_DIRECTIVE_KINDS,
  type GitDirective,
  type GitDirectiveKind,
  type GitDirectiveParseError,
} from "./types"
