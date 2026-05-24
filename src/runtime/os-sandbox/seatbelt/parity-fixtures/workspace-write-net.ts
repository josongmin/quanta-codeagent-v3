/**
 * Verbatim fixture — `workspace-write-net` profile, workspace placeholder
 * `__WORKSPACE__`. Baseline + workspace write + network allow.
 */
export const WORKSPACE_WRITE_NET_FIXTURE = `(version 1)
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
;; workspace + extra writes
(allow file-write* (subpath "__WORKSPACE__"))
(allow network*)
`
