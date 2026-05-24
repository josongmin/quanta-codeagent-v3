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
(allow process-fork)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow user-preference-read)
;; system framework reads (always-on)
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences")
  (subpath "/Library/Preferences/Logging")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/private/var/db")
  (subpath "/private/var/db/timezone")
  (subpath "/var/db")
  (literal "/etc")
  (literal "/tmp")
  (literal "/private/etc/localtime"))
;; workspace + extra reads
(allow file-read* (subpath "__WORKSPACE__"))
(deny network*)
`
