import type { SandboxPolicy } from "./types"

/**
 * Compile a {@link SandboxPolicy} to a `bwrap` (bubblewrap) argv list. Pure
 * function — no I/O.
 *
 * Mirrors {@link compileSeatbeltProfile} INTENT (same denylist semantics, same
 * 5-arm closed enum) but expressed in bubblewrap CLI syntax. Bubblewrap is
 * the Phase 2 Linux backend (ADR-0150). A future Phase 3 ADR may replace
 * this with a native Landlock FFI; the policy → backend boundary is
 * intentionally narrow so backend swap is local.
 *
 * Returns `null` for profiles the caller should NOT sandbox (verbatim spawn
 * instead): `"off"`, `"danger-full-access"` — identical contract to
 * {@link compileSeatbeltProfile}.
 *
 * Profile mapping:
 *  - `read-only`           : RO bind whole `/` and workspace, no network,
 *                            die-with-parent.
 *  - `workspace-write`     : RO bind `/`, RW bind workspace, no network,
 *                            die-with-parent + `/proc` + `/dev`.
 *  - `workspace-write-net` : same as `workspace-write` MINUS `--unshare-net`.
 *  - `danger-full-access` / `off` : return null (caller bypass entirely).
 *
 * `extraReadPaths` → `--ro-bind <p> <p>` per path (filtered for `/proc`,
 * `/sys` which are already specially handled).
 * `extraWritePaths` → `--bind <p> <p>` per path.
 *
 * NOTE: the returned argv list does NOT include `bwrap` as argv[0] and does
 * NOT include `--` + the user command. The caller is responsible for
 * assembling `[bwrap, ...policyArgs, "--", ...userCommand]`. This keeps the
 * compiler pure and easy to test.
 *
 * Design notes (deliberate):
 *  - `--ro-bind / /` chosen over per-path RO-binds because: (a) `bash`/`node`/
 *    `python` need `/usr/lib`, `/usr/share`, `/etc`, `/lib64`, `/System...`-
 *    analogue paths that vary across distros; enumerating is fragile. (b)
 *    The intent is "no FS WRITE outside workspace", not "no FS READ outside
 *    workspace" — read-only ambient is the documented Codex semantics. The
 *    `--bind workspace workspace` shadows the RO bind so workspace remains
 *    writable.
 *  - `--die-with-parent` ensures sandboxed child dies when the spawning
 *    process exits — prevents orphan escape after harness crash.
 *  - `--unshare-net` + no `--share-net` → empty network namespace, equivalent
 *    to Seatbelt's `(deny network*)`.
 *  - `--proc /proc` + `--dev /dev` ONLY in workspace-write{,-net} because
 *    interactive tools need them; read-only can run without (and giving
 *    /proc to a read-only sandbox leaks the host process table).
 *  - `extraReadPaths` filtering: paths starting with `/proc` or `/sys` are
 *    skipped — bubblewrap's `--proc`/`--dev` handle these specially and
 *    re-binding causes EBUSY.
 */
export const compileBubblewrapArgs = (
  policy: SandboxPolicy,
  workspace: string,
): string[] | null => {
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return null
  }
  const args: string[] = ["--die-with-parent", "--ro-bind", "/", "/"]
  appendWorkspaceBindings(args, policy.profile, workspace)
  appendNetworkPolicy(args, policy)
  appendExtraPathBindings(args, "--ro-bind", policy.extraReadPaths)
  appendExtraPathBindings(args, "--bind", policy.extraWritePaths)
  return args
}

/** Workspace bind: RO for read-only, RW + /proc + /dev for write profiles.
 *  The workspace mount shadows the earlier `--ro-bind / /` for that subtree. */
const appendWorkspaceBindings = (
  args: string[],
  profile: SandboxPolicy["profile"],
  workspace: string,
): void => {
  if (profile === "read-only") {
    args.push("--ro-bind", workspace, workspace)
    return
  }
  // workspace-write{,-net}
  args.push("--bind", workspace, workspace, "--proc", "/proc", "--dev", "/dev")
}

/** Network unshare unless profile is *-net OR explicit `allowNetwork: true`.
 *  Profile dictates; extras don't apply (intentional Seatbelt parallel). */
const appendNetworkPolicy = (args: string[], policy: SandboxPolicy): void => {
  const allow = policy.profile === "workspace-write-net" || policy.allowNetwork === true
  if (!allow) args.push("--unshare-net")
}

/** Append `--ro-bind p p` / `--bind p p` per absolute path. Relative paths and
 *  `/proc` / `/sys` prefixes silently skipped — bwrap handles these specially
 *  via `--proc`/`--dev` and re-binding causes EBUSY. */
const appendExtraPathBindings = (
  args: string[],
  flag: "--ro-bind" | "--bind",
  paths: ReadonlyArray<string> | undefined,
): void => {
  for (const p of paths ?? []) {
    if (!isAllowedExtraPath(p)) continue
    args.push(flag, p, p)
  }
}

const isAllowedExtraPath = (p: string): boolean =>
  p.startsWith("/") && !p.startsWith("/proc") && !p.startsWith("/sys")
