/**
 * Credential-specific atomic file commit.
 *
 * `@/auth` cannot import `@/storage`. This primitive mirrors the storage
 * random-temp / fsync / rename algorithm inside the credential owner.
 * Callers serialize their own schema; this module only commits opaque bytes.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto"
import { mkdir, open, rename, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"

export interface PrivateFileHandle {
  write(content: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface PrivateFileIoPort {
  mkdirParent(dir: string): Promise<void>
  statKind(path: string): Promise<"file" | "dir" | "absent">
  openExclusive(path: string): Promise<PrivateFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  syncDir(dir: string): Promise<void>
}

export interface PrivateAtomicWriteDeps {
  readonly randomBytes?: (size: number) => Uint8Array
  readonly io?: PrivateFileIoPort
}

const toHex = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT"

export const defaultPrivateFileIo: PrivateFileIoPort = {
  mkdirParent: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  },
  statKind: async (path) => {
    try {
      const s = await stat(path)
      return s.isDirectory() ? "dir" : "file"
    } catch (e) {
      if (isEnoent(e)) return "absent"
      throw e
    }
  },
  openExclusive: async (path) => {
    const handle = await open(path, "wx", 0o600)
    return {
      write: async (content) => {
        await handle.writeFile(content, "utf8")
      },
      sync: async () => {
        await handle.sync()
      },
      close: async () => {
        await handle.close()
      },
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  syncDir: async (dir) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(dir, "r")
      await handle.sync()
    } catch (e) {
      // Directory fsync is best-effort on platforms that reject it.
      void e
    } finally {
      if (handle !== undefined) {
        await handle.close().catch((closeErr: unknown) => {
          void closeErr
        })
      }
    }
  },
}

export const writePrivateFileAtomic = async (
  path: string,
  content: string,
  deps: PrivateAtomicWriteDeps = {},
): Promise<void> => {
  if (path.endsWith("/") || path.endsWith("\\")) {
    throw new Error("private atomic write target must be a file path")
  }
  const io = deps.io ?? defaultPrivateFileIo
  const random = deps.randomBytes ?? ((n: number) => nodeRandomBytes(n))
  const parent = dirname(path)
  const kind = await io.statKind(path)
  if (kind === "dir") {
    throw new Error("private atomic write target is a directory")
  }
  await io.mkdirParent(parent)
  const temp = `${path}.quanta-token-${toHex(random(8))}`
  let handle: PrivateFileHandle | undefined
  let renamed = false
  try {
    handle = await io.openExclusive(temp)
    await handle.write(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await io.rename(temp, path)
    renamed = true
    await io.syncDir(parent)
  } catch (e) {
    if (handle !== undefined) {
      await handle.close().catch((closeErr: unknown) => {
        void closeErr
      })
    }
    if (!renamed) {
      await io.unlink(temp).catch((unlinkErr: unknown) => {
        void unlinkErr
      })
    }
    throw e
  }
}
