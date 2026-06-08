/** LANE 1 (ATOMIC-DEFAULT) — `@/storage` `writeFileAtomic` mode preservation.
 *
 *  The atomic write commits via a FRESH temp inode + rename, so without
 *  re-applying the ORIGINAL file's permission bits an existing `0o755` script
 *  silently drops to `0o644` across the temp+rename. This is the SAME
 *  regression already fixed in apply_patch's port (see
 *  `apply-patch-atomic-write.test.ts` "preserves the ORIGINAL file mode").
 *
 *  RED before the chmod-on-temp fix in `src/storage/atomic-write.ts`
 *  (file lands 0o644 after the rename); GREEN after.
 *
 *  Byte-identical contract: the file CONTENT result is unchanged on every
 *  path — only the mode is now preserved and the write mechanism is
 *  temp+rename (already true pre-fix). */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileAtomic } from "@/storage"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const mkdir = async (prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe("storage writeFileAtomic — mode preservation", () => {
  test("preserves an existing file's 0o755 mode across the atomic temp+rename", async () => {
    const dir = await mkdir("storage-atomic-mode-")
    const file = join(dir, "script.sh")
    await writeFile(file, "echo old\n", "utf8")
    await chmod(file, 0o755)

    await writeFileAtomic(file, "echo new\n")

    // Content updated AND the executable bits survived the temp+rename.
    expect(await readFile(file, "utf8")).toBe("echo new\n")
    const st = await stat(file)
    expect(st.mode & 0o777).toBe(0o755)
  })

  test("a NEW file gets default perms (mode preservation is a no-op without an original)", async () => {
    const dir = await mkdir("storage-atomic-new-")
    const file = join(dir, "fresh.txt")
    await writeFileAtomic(file, "hi")

    expect(await readFile(file, "utf8")).toBe("hi")
    // No spurious executable bit was added for a brand-new file (umask-default).
    const st = await stat(file)
    expect(st.mode & 0o111).toBe(0)
  })

  test("preserves a non-default but non-exec mode (0o600) too — not only the exec case", async () => {
    const dir = await mkdir("storage-atomic-600-")
    const file = join(dir, "secret.conf")
    await writeFile(file, "key=old\n", "utf8")
    await chmod(file, 0o600)

    await writeFileAtomic(file, "key=new\n")

    expect(await readFile(file, "utf8")).toBe("key=new\n")
    const st = await stat(file)
    expect(st.mode & 0o777).toBe(0o600)
  })

  test("byte-identical content result: the bytes landed are exactly what was passed", async () => {
    const dir = await mkdir("storage-atomic-bytes-")
    const file = join(dir, "round.txt")
    await writeFile(file, "before", "utf8")
    await chmod(file, 0o755)
    const content = "line1\nline2\n日本語\n"
    await writeFileAtomic(file, content)
    expect(await readFile(file, "utf8")).toBe(content)
    expect((await stat(file)).mode & 0o777).toBe(0o755)
  })
})
