/**
 * Default {@link DispatchGuard} (ADR-0229). Single pure composer that wraps
 * the three already-shipped detectors:
 *
 *   - `gitWriteProtectReason(path)`             (`@/permission`)
 *   - `decideBranchOnly(cmd, protected, head)`   (`@/permission`)
 *   - `isHostAllowed(urlOrHost, allowlist)`      (`@/runtime`)
 *
 * Composition rule (HELL-DG-06): MOST-CONSERVATIVE wins. The contributions
 * are collected, then the winner is `deny > ask > allow`. `hardDeny` rides
 * along on the winning deny and is `true` whenever a deny was produced by
 * `gitWriteProtectReason` or `isHostAllowed` (both are security boundaries
 * a retry cannot satisfy). `decideBranchOnly` deny is `hardDeny:false`
 * because a branch switch is a recoverable user action.
 *
 * Input extraction is intentionally narrow (v1): the composer only looks at
 * obvious string fields on the input object. Anything else degrades to "no
 * contribution" — the dispatch path has additional gates downstream.
 *
 * Plane-clean: imports only `@/permission` + `@/runtime` (peer slices already
 * imported elsewhere in `@/agent`) + sibling files.
 */

import { decideBranchOnly, gitWriteProtectReason } from "@/permission"
import { isHostAllowed } from "@/runtime/network-allowlist"
import type { DispatchGuard } from "./port"
import type { GuardDecision } from "./types"

export interface DefaultDispatchGuardOptions {
  /** Branches `decideBranchOnly` treats as protected. Absent ⇒ the detector
   *  uses its `DEFAULT_PROTECTED_BRANCHES` (main / master / develop / production).
   */
  readonly protectedBranches?: readonly string[]
  /** Current branch HEAD points to. Used by `decideBranchOnly` to classify
   *  `git commit` / `git push` (no refspec) etc. Absent ⇒ those checks degrade
   *  to "no contribution" (the detector is partial without a current branch). */
  readonly currentBranch?: string
  /** Allowlist of hosts the tool is permitted to talk to. Absent ⇒ the host
   *  check is SKIPPED entirely (no deny on missing-allowlist). This keeps the
   *  default-on path safe: a host filter only fires when the operator wired
   *  one. An EMPTY array (`[]`) means "deny everything", per the detector. */
  readonly networkAllowlist?: readonly string[]
  /** ADR-0135 `NetworkPolicy.perRequestApproval` honoring. When `true`, an
   *  egress-bearing call whose host is NOT on `networkAllowlist` routes to an
   *  `ask` decision (HITL confirmation) instead of a terminal `deny`. The
   *  dispatch wire collapses `ask` to the `"guard-ask"` preview tag. Absent /
   *  `false` ⇒ legacy behavior (off-allowlist host ⇒ hard `deny`). Only
   *  consulted when `networkAllowlist` is also present (the host check is
   *  SKIPPED entirely when the allowlist is absent). */
  readonly perRequestApproval?: boolean
}

/** Pull a string field from an unknown record, narrow-typed. Returns null when
 *  the key is absent or the value is not a non-empty string. */
const stringField = (input: unknown, key: string): string | null => {
  if (typeof input !== "object" || input === null) return null
  const rec = input as Record<string, unknown>
  const v = rec[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Extract a file-path candidate from the input. Covers the common shapes used
 *  by write/edit/patch-like tools. */
const extractPath = (input: unknown): string | null =>
  stringField(input, "path") ??
  stringField(input, "file_path") ??
  stringField(input, "target") ??
  stringField(input, "file")

/** Extract a shell-command candidate. Covers `bash` (`command`) and `shell`
 *  (`cmd`) shapes; nothing else (a tool that ships a custom field is opted out
 *  — the legacy `extractShellCommand` registry method is the place to extend
 *  that vocabulary, not this composer). */
const extractShellCommand = (input: unknown): string | null =>
  stringField(input, "command") ?? stringField(input, "cmd")

/** Extract a host/URL candidate. Covers `web_fetch`/`web_search` family
 *  (`url`), an explicit `host` field, and the patch-tool `target_url`. */
const extractUrlOrHost = (input: unknown): string | null =>
  stringField(input, "url") ?? stringField(input, "host") ?? stringField(input, "target_url")

const checkGitWrite = (input: unknown): GuardDecision | null => {
  const path = extractPath(input)
  if (path === null) return null
  const reason = gitWriteProtectReason(path)
  if (reason === null) return null
  return {
    kind: "deny",
    reason: `git-write protection: ${reason} on '${path}'`,
    // hardDeny: a retry cannot satisfy a path-pattern security boundary.
    hardDeny: true,
  }
}

const checkBranchOnly = (
  input: unknown,
  opts: DefaultDispatchGuardOptions,
): GuardDecision | null => {
  const command = extractShellCommand(input)
  if (command === null) return null
  // `decideBranchOnly` is total: it returns `{allowed:true}` for non-git
  // commands. The three optional knobs are forwarded verbatim — undefined
  // currentBranch degrades exactly as the detector documents.
  const verdict = decideBranchOnly(command, opts.protectedBranches, opts.currentBranch)
  if (verdict.allowed) return null
  return {
    kind: "deny",
    reason: verdict.reason,
    // hardDeny: false — branch posture is operator-recoverable (switch branches).
    hardDeny: false,
  }
}

/**
 * Egress-class refusal for the DENY-ALL network posture.
 *
 * When the operator wired an EMPTY `networkAllowlist` (`[]`), every host is
 * off-list — the posture is "deny every egress-bearing tool call" (the
 * `denied` mode lever, and the strictest reading of an empty `allowlist`
 * lever). `checkHostAllowlist` already refuses URL-bearing tools, but a
 * shell-equivalent call (`bash`/`shell`/`exec`/MCP-`run`) is the single most
 * common egress vector (`curl`/`wget`/`nc`) and ships NO inspectable host
 * field — so it would otherwise slip the host filter entirely.
 *
 * Mirror the HARD_DENY shell-equivalence signal (`extractShellCommand !== null`,
 * i.e. the tool exposes a shell command) rather than an allowlist of tool
 * names: ANY shell-class tool is treated as egress-bearing and DENIED
 * fail-closed under the deny-all posture. A pure non-egress tool (no shell
 * command, no URL) carries no contribution and still runs.
 *
 * Scope is intentionally the EMPTY allowlist only. Under a NON-empty allowlist
 * we cannot inspect which host a shell command will reach, so we defer to the
 * downstream gates (preserving the documented "harmless `ls` allows under a
 * configured allowlist" behavior, HELL-DG-05). The deny-all posture has no
 * such ambiguity: NO host is reachable, therefore no shell egress is.
 */
const checkShellEgressUnderDenyAll = (
  input: unknown,
  opts: DefaultDispatchGuardOptions,
): GuardDecision | null => {
  if (opts.networkAllowlist === undefined || opts.networkAllowlist.length > 0) return null
  const command = extractShellCommand(input)
  if (command === null) return null
  return {
    kind: "deny",
    reason: `shell-equivalent command blocked under deny-all network posture (no egress permitted): '${command}'`,
    // hardDeny: a deny-all egress posture is a security boundary a retry of the
    // same shell call cannot satisfy.
    hardDeny: true,
  }
}

const checkHostAllowlist = (
  input: unknown,
  opts: DefaultDispatchGuardOptions,
): GuardDecision | null => {
  if (opts.networkAllowlist === undefined) return null
  const urlOrHost = extractUrlOrHost(input)
  if (urlOrHost === null) return null
  if (isHostAllowed(urlOrHost, opts.networkAllowlist)) return null
  // ADR-0135 `perRequestApproval`: an off-allowlist host routes to HITL `ask`
  // rather than a terminal `deny`. The composer keeps `ask` (never collapses
  // it to `allow`); the dispatch wire surfaces it as the `"guard-ask"` tag.
  if (opts.perRequestApproval === true) {
    return {
      kind: "ask",
      reason: `host '${urlOrHost}' not in network allowlist (size=${opts.networkAllowlist.length}); per-request approval required.`,
    }
  }
  return {
    kind: "deny",
    reason: `host '${urlOrHost}' not in network allowlist (size=${opts.networkAllowlist.length}).`,
    // hardDeny: an off-allowlist host crosses an egress boundary.
    hardDeny: true,
  }
}

/** Compose the three contributions with the documented precedence
 *  (deny > ask > allow; hardDeny rides on the winning deny). The today
 *  detectors never emit `ask`, so the `ask` branch is dead in v1 — kept in the
 *  composer so a future detector that returns `ask` is wired-in without
 *  touching the wire site (HELL-DG-06 still asserts the precedence). */
const composeContributions = (
  contributions: ReadonlyArray<GuardDecision | null>,
): GuardDecision => {
  let askDecision: GuardDecision | null = null
  for (const c of contributions) {
    if (c === null) continue
    if (c.kind === "deny") return c
    if (c.kind === "ask" && askDecision === null) askDecision = c
  }
  return askDecision ?? { kind: "allow" }
}

/** Construct a default dispatch guard. The returned `check` is pure (no
 *  closure over mutable state — the opts are read verbatim each call). */
export const defaultDispatchGuard = (opts: DefaultDispatchGuardOptions = {}): DispatchGuard => ({
  check(_tool, input): GuardDecision {
    return composeContributions([
      checkGitWrite(input),
      // Egress-class refusal for the deny-all posture is checked BEFORE the
      // (soft, recoverable) branch-only contribution so a shell call under a
      // fully-denied network surfaces the hard egress deny, not a softer one.
      checkShellEgressUnderDenyAll(input, opts),
      checkBranchOnly(input, opts),
      checkHostAllowlist(input, opts),
    ])
  },
})
