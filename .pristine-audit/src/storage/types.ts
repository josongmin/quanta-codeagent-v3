export interface FileInfo {
  path: string
  size: number
  isDirectory: boolean
  /** Last-modified time in epoch ms (`stat().mtimeMs`). Used by the
   *  stale-read-guard (ADR-0474) to detect external modification between a
   *  read and a later write/edit. */
  mtimeMs: number
  /** True iff the target is a named pipe (FIFO). Reading one BLOCKS forever
   *  when no writer is attached (or streams unbounded otherwise), so the
   *  `read` tool (B5 device guard) rejects it BEFORE opening — a `read()` on a
   *  FIFO is the canonical "tool hangs the loop" DoS. Populated from
   *  `stat().isFIFO()`, additive sibling of {@link mtimeMs}. */
  isFIFO: boolean
  /** True iff the target is a character device (`/dev/random`, `/dev/zero`,
   *  `/dev/tty`, …). Reading produces infinite / blocking output → the `read`
   *  tool rejects it (B5 device guard). Populated from
   *  `stat().isCharacterDevice()`. */
  isCharacterDevice: boolean
  /** True iff the target is a block device (`/dev/disk0`, …). Reading raw
   *  block storage is never a legitimate text read and can dump gigabytes →
   *  the `read` tool rejects it (B5 device guard). Populated from
   *  `stat().isBlockDevice()`. */
  isBlockDevice: boolean
}
