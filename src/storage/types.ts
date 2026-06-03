export interface FileInfo {
  path: string
  size: number
  isDirectory: boolean
  /** Last-modified time in epoch ms (`stat().mtimeMs`). Used by the
   *  stale-read-guard (ADR-0474) to detect external modification between a
   *  read and a later write/edit. */
  mtimeMs: number
}
