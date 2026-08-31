/**
 * Verbatim fixture — `read-only` profile, workspace placeholder `__WORKSPACE__`.
 * Mirrors the Codex `codex-seatbelt-sandbox-profile` baseline shape minus
 * any file-write* line (the read-only invariant).
 *
 * The hellgate substitutes `__WORKSPACE__` and compares byte-for-byte
 * against `compileSeatbeltProfile({ profile: "read-only" }, "/ws")`.
 */
export const READ_ONLY_FIXTURE = `(version 1)
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
(deny network*)
`
