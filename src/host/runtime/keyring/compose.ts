/** jun-06 — `composeTokenStore`: a `TokenStorePort` DECORATOR that backs the
 *  H18 MCP OAuth store with the OS keyring when available, falling back to the
 *  existing 0600 file store otherwise.
 *
 *  Drop-in: the returned value satisfies the SAME `TokenStorePort` the H18
 *  provider/rotator already consume, so the swap is a composition-root wiring
 *  change with ZERO change to the provider, the rotator, or the flow.
 *
 *  Properties:
 *    - **keyring-first read, file fallback** — read prefers the keyring; with no
 *      keyring available every op delegates to the file store (byte-identical to
 *      today's H18 store path).
 *    - **one-directional migration (file → keyring)** — on the first read where
 *      a keyring is available but holds no entry, an existing file token is
 *      MOVED into the keyring (set, then best-effort file delete). Idempotent: a
 *      later read finds the keyring copy and never re-touches the file.
 *    - **write goes to the keyring** when available, else the file.
 *    - **delete spans BOTH** stores so a logout/invalidate leaves no residue in
 *      either (matters during/after the migration window).
 *    - **NO-THROW everywhere** — a keyring error is swallowed; `read` then
 *      returns the file value (or `undefined`), so the H18 provider's TOTAL
 *      `tokenFor` re-runs the OAuth flow rather than crashing the load.
 */

import type { TokenRecord, TokenStorePort } from "@/connectors"
import type { KeyringPort } from "./port"
import { parseRecord, serializeRecord } from "./serialize"

export const DEFAULT_KEYRING_SERVICE = "quanta.mcp-oauth"

/** Best-effort keyring availability: a thrown probe ⇒ treat as unavailable. */
const safeAvailable = async (keyring: KeyringPort): Promise<boolean> => {
  try {
    return await keyring.available()
  } catch {
    return false
  }
}

export const composeTokenStore = (
  keyring: KeyringPort,
  file: TokenStorePort,
  service: string = DEFAULT_KEYRING_SERVICE,
): TokenStorePort => ({
  async read(id: string): Promise<TokenRecord | undefined> {
    if (!(await safeAvailable(keyring))) return file.read(id)
    // Keyring available — prefer it.
    let fromKeyring: string | undefined
    try {
      fromKeyring = await keyring.get(service, id)
    } catch {
      // Keyring read failed (locked/denied) ⇒ degrade to the file value so the
      // provider re-auths rather than crashing. Do NOT migrate on a failed read.
      return file.read(id)
    }
    const parsed = parseRecord(fromKeyring)
    if (parsed !== undefined) return parsed
    // MIGRATION: nothing (usable) in the keyring → move a file token in ONCE.
    const fromFile = await file.read(id)
    if (fromFile === undefined) return undefined
    try {
      await keyring.set(service, id, serializeRecord(fromFile))
      // Best-effort delete of the file copy — a failure here is non-fatal; the
      // record is already returned and a later read re-attempts the move.
      await file.delete(id).catch(() => undefined)
    } catch {
      // Keyring set failed → leave the file copy in place (no data loss) and
      // still serve the record. A later read re-attempts the migration.
    }
    return fromFile
  },

  async write(id: string, record: TokenRecord): Promise<void> {
    if (await safeAvailable(keyring)) {
      try {
        await keyring.set(service, id, serializeRecord(record))
        return
      } catch {
        // Keyring write failed → fall through to the file store so the token is
        // still persisted (degrade, never lose).
      }
    }
    await file.write(id, record)
  },

  async delete(id: string): Promise<void> {
    // Remove from BOTH stores so a logout/invalidate leaves no residue in
    // either (defense against a stale file lingering through the migration
    // window). NO-THROW on the absent side.
    if (await safeAvailable(keyring)) {
      try {
        await keyring.delete(service, id)
      } catch {
        // ignore — fall through to the file delete
      }
    }
    await file.delete(id).catch(() => undefined)
  },
})
