/**
 * Verbatim fixture — `workspace-write` profile, workspace placeholder
 * `__WORKSPACE__`. Baseline + workspace write subpath; network denied.
 */
export const WORKSPACE_WRITE_FIXTURE = `(version 1)
(deny default)
;; subprocess + tty (codex-verbatim baseline)
(allow process-exec)
(allow process-fork)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow user-preference-read)
;; file reads (read-only by write denial)
(allow file-read*)
;; workspace + extra writes
(allow file-write* (subpath "__WORKSPACE__"))
(deny network*)
`
