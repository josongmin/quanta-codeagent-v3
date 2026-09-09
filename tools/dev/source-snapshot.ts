import { createHash } from "node:crypto"

export interface SourceSnapshotFile {
  readonly path: string
  readonly contentSha: string
  readonly text: string
}

export interface SourceSnapshot {
  readonly head: string
  read(path: string, loader: () => string): SourceSnapshotFile
  clone(): SourceSnapshot
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex")

export const createSourceSnapshot = (head: string): SourceSnapshot => {
  const files = new Map<string, SourceSnapshotFile>()
  const read = (path: string, loader: () => string): SourceSnapshotFile => {
    const cached = files.get(path)
    if (cached !== undefined) return cached
    const text = loader()
    const row = { path, contentSha: sha(text), text }
    files.set(path, row)
    return row
  }
  return {
    head,
    read,
    clone(): SourceSnapshot {
      const copy = createSourceSnapshot(head)
      for (const [path, row] of files) copy.read(path, () => row.text)
      return copy
    },
  }
}
