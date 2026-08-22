import type { SandboxPolicy } from "./types"

/**
 * Pure compiler: SandboxPolicy → `landlock-cli` argv flags.
 *
 * Phase 2 second backend (companion to {@link compileBubblewrapArgs} —
 * ADR-0159 — Linux Landlock+seccomp adapter). `landlock-cli` is a
 * file-system-only wrapper around the Linux Landlock LSM (no network
 * enforcement, no PID/IPC namespace). It is meaningfully weaker than
 * bubblewrap; we only fall back to it when `bwrap` is absent.
 *
 * Returns `null` for the explicit opt-out arms (`off`, `danger-full-access`)
 * — caller must NOT wrap the spawn (identical contract to
 * {@link compileBubblewrapArgs} and {@link compileSeatbeltProfile}).
 *
 * Profile mapping:
 *  - `read-only`           → `--ro-paths <system + workspace>`
 *  - `workspace-write`     → `--ro-paths <system>` + `--rw-paths <workspace>`
 *  - `workspace-write-net` → same as `workspace-write` PLUS a
 *                            `--network-deferred` marker (see note below).
 *  - `extraReadPaths`      → merged into `--ro-paths`
 *  - `extraWritePaths`     → merged into `--rw-paths` on EVERY compiled arm,
 *                            `read-only` included (see the cross-backend
 *                            contract on `SandboxPolicy.extraWritePaths`).
 *
 * Network enforcement note (deliberate gap):
 *   Landlock as of Linux 6.7+ has a partial `network.bind`/`network.connect`
 *   ruleset, but `landlock-cli` (the user-space tool we wrap here) does NOT
 *   surface those flags as of the binaries shipping on Debian/Ubuntu/Fedora
 *   stable channels. When the policy *demands* network deny but only
 *   landlock-cli is available, we emit a `--network-deferred` marker (NOT a
 *   real landlock-cli flag — it gets filtered before spawn in
 *   `compileLinuxSandboxArgv`) so {@link linuxOsSandbox} can attach a typed
 *   `degradeReason: "landlock-network-policy-not-enforced"` warning. The
 *   spawn still happens (don't block the user) but the operator is told
 *   honestly that network was not enforced. This is the same "honest
 *   degradation" pattern as `linux-bwrap-missing`.
 *
 * The returned argv list does NOT include `landlock-cli` as argv[0] and does
 * NOT include `--` + the user command. Caller assembles
 * `[landlock-cli, ...policyArgs, "--", ...userCommand]`.
 *
 * Comma-joined path lists are used to match landlock-cli's documented CLI
 * shape (`--ro-paths /usr,/lib,/etc`). Empty path list ⇒ flag omitted
 * entirely (defensive; passing an empty value to landlock-cli is rejected
 * with EINVAL).
 */
export const compileLandlockCliArgs = (
  policy: SandboxPolicy,
  workspace: string,
): string[] | null => {
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return null
  }

  // Always-on ambient system read paths. Mirrors the bubblewrap `--ro-bind /`
  // intent but enumerated explicitly because landlock-cli has no "bind /"
  // primitive — it only takes path lists. The enumeration covers libc /
  // language-runtime / ssl-cert reads on all major distros (glibc + musl):
  //  - /usr  : binaries + shared libs (mainstream distros)
  //  - /lib  : flat libc layout (Alpine, embedded)
  //  - /lib64: x86_64 multilib symlinks
  //  - /etc  : ssl certs, nsswitch, hostname, timezone
  //  - /bin  : core utilities on systems without /usr merge
  //  - /sbin : system tools (rare but cheap to allow read-only)
  const SYSTEM_RO_PATHS = ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin"] as const

  // Filter extras: relative paths skipped (landlock-cli requires absolute);
  // /proc and /sys skipped (landlock cannot govern those — kernel reserves).
  const filterExtras = (paths: ReadonlyArray<string> | undefined): string[] => {
    if (!paths) return []
    const out: string[] = []
    for (const p of paths) {
      if (!p.startsWith("/")) continue
      if (p.startsWith("/proc") || p.startsWith("/sys")) continue
      out.push(p)
    }
    return out
  }

  const extraReads = filterExtras(policy.extraReadPaths)
  const extraWrites = filterExtras(policy.extraWritePaths)

  const args: string[] = []

  // Always emit system RO list.
  const roList: string[] = [...SYSTEM_RO_PATHS]

  if (policy.profile === "read-only") {
    // Workspace itself joins the RO list.
    roList.push(workspace)
    for (const p of extraReads) roList.push(p)
    // extraWritePaths on a read-only profile are HONORED — `read-only` denies
    // ambient writes (workspace included, which stays on the RO list above),
    // not the caller-owned scratch scopes named by the policy. Seatbelt and
    // bubblewrap have always honored them (`(allow file-write* ...)` /
    // `--bind p p`); dropping them here made `bash(mode:"read")` here-docs and
    // `mktemp` fail with EACCES on landlock-only hosts alone. The old comment
    // claiming this "mirrors bubblewrap behavior" was factually wrong —
    // `compileBubblewrapArgs` binds extras RW on every compiled arm.
    if (extraWrites.length > 0) {
      args.push("--rw-paths", extraWrites.join(","))
    }
  } else {
    // workspace-write / workspace-write-net
    for (const p of extraReads) roList.push(p)
    const rwList: string[] = [workspace, ...extraWrites]
    args.push("--rw-paths", rwList.join(","))
  }

  if (roList.length > 0) {
    args.unshift("--ro-paths", roList.join(","))
  }

  // Network policy: profile demands deny ⇒ emit deferred marker (see note).
  // `workspace-write-net` and explicit `allowNetwork: true` allow net ⇒ no
  // marker needed (landlock would not have blocked it anyway).
  const allowNetwork = policy.profile === "workspace-write-net" || policy.allowNetwork === true
  if (!allowNetwork) {
    args.push("--network-deferred")
  }

  return args
}

/**
 * Sentinel marker emitted by {@link compileLandlockCliArgs} when the policy
 * requires network deny but landlock-cli cannot enforce it. Exported so
 * `linuxOsSandbox` can detect-and-filter without string sharing.
 */
export const LANDLOCK_CLI_NETWORK_DEFERRED_MARKER = "--network-deferred"
