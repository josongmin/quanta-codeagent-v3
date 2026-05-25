/** Identity-pool slice barrel (ADR-0247).
 *
 *  Closed surface — only the port types, the error classes, the default-impl
 *  factory, the frozen pool table, and the `NONE_NICKNAME` sentinel are
 *  exported. Internal cursor state is encapsulated by `createDefaultIdentity
 *  Minter()` so importing this barrel has no side effects (HELL-IP-12).
 */
export { createDefaultIdentityMinter } from "./default-minter"
export { NICKNAME_TABLE, POOL_SIZE } from "./nickname-table"
export { type IdentityMinter, MintError, ReleaseError } from "./port"
export { type AgentNickname, type AgentRole, type MintedIdentity, NONE_NICKNAME } from "./types"
