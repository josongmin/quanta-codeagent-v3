/**
 * FD-held exclusive lock for migration persist/ledger. Colocated — no `@/auth` import.
 */

import { withPosixFileLock } from "@/shared"

export const withMigrationFileLock = async <T>(
  path: string,
  fn: () => Promise<T>,
  opts: { readonly timeoutMs?: number | undefined } = {},
): Promise<T> => {
  return withPosixFileLock(path, fn, opts)
}
