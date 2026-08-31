/**
 * Verbatim fixture — `workspace-write-net` profile, workspace placeholder
 * `__WORKSPACE__`. Baseline + workspace write + network allow.
 */
export const WORKSPACE_WRITE_NET_FIXTURE = `(version 1)
(deny default)
;; subprocess + tty (codex-verbatim baseline)
(allow process-exec)
(allow process-fork)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow user-preference-read)
;; Bun reads the compatibility page size during startup; keep this to the exact key.
(allow sysctl-read (sysctl-name "hw.pagesize_compat"))
;; file reads (read-only by write denial)
(allow file-read*)
;; workspace + extra writes
(allow file-write* (subpath "__WORKSPACE__"))
(allow network*)
`
