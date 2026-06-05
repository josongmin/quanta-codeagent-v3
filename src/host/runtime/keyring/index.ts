/** jun-06 — keyring slice barrel. The composition root reaches the OS-secret
 *  backend for the H18 MCP OAuth `TokenStorePort` through here. Default-OFF:
 *  nothing is constructed unless `QUANTA_MCP_OAUTH_KEYRING=1` AND the OS keyring
 *  `available()`. */

export { composeTokenStore, DEFAULT_KEYRING_SERVICE } from "./compose"
export { createLibsecretKeyring } from "./libsecret"
export { createMacosKeyring } from "./macos"
export { createNullKeyring } from "./null"
export type {
  KeyringExec,
  KeyringExecInput,
  KeyringExecResult,
  KeyringPlatform,
  KeyringPort,
} from "./port"
export { bunKeyringExec, selectKeyring } from "./select"
export { parseRecord, serializeRecord } from "./serialize"
