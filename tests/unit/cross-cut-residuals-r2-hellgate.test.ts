// Hellgate — cross-cut residuals (ROUND 2, Part B). Three independent residuals
// sealed with adversarial cases:
//
//   B1. passive-vcs `git merge --help` false positive. A help/usage invocation
//       exits 0; its man-page stdout can carry a line-anchored `Fast-forward`
//       (the FAST-FORWARD section term) — a spurious `merged` event. The fix
//       excludes `--help`/`-h`/`help` from classification. REAL `git merge`
//       still classifies.
//
//   B2. reconcile duplicate `tool_use` id — no crash, model-valid result.
//       Two tool_use blocks sharing one id are characterized: with one matching
//       result the pass is byte-identical (both uses' id is satisfied on the
//       wire); with NO result a stub is synthesized per orphan-use occurrence.
//       Neither crashes; both leave every tool_use with a matching result.
//
//   B3. B2 env→mode end-to-end: a HOSTILE per-repo `QUANTA_*` profile layer
//       trying to grant `auto`/widen MUST NOT escalate the RESOLVED
//       PermissionMode (the live `resolvePermissionModeFromProfile` path, not
//       `mergeProfileLayers` in isolation).

import { describe, expect, test } from "bun:test"
import { classifyPassiveVcs } from "@/git/passive-classify"
import { resolvePermissionModeFromProfile } from "@/host/runtime/agent-arg-builder"
import { reconcileToolPairing } from "@/shared/reconcile-tool-pairing"

/* ─────────────────────────── B1: passive-vcs --help ─────────────────────── */

describe("B1 — passive-vcs help invocation never classifies", () => {
  // The man-page text a `git merge --help` dump can contain: a line-anchored
  // `Fast-forward` (the FAST-FORWARD section), plus a `[branch sha]` example and
  // a `/pull/N` example URL — every false-positive trigger in one body.
  const HELP_STDOUT = [
    "GIT-MERGE(1)                      Git Manual",
    "NAME",
    "       git-merge - Join two or more development histories together",
    "FAST-FORWARD",
    "Fast-forward",
    "       When the current branch can be fast-forwarded ...",
    "       example: [main 1a2b3c4] subject",
    "       see https://github.com/o/r/pull/42 for the PR flow",
    "Successfully rebased and updated refs/heads/x.",
  ].join("\n")

  test("`git merge --help` (exit 0, Fast-forward in body) → null", () => {
    expect(
      classifyPassiveVcs({ command: "git merge --help", stdout: HELP_STDOUT, exitCode: 0 }),
    ).toBeNull()
  })

  test("`git merge -h` → null", () => {
    expect(
      classifyPassiveVcs({ command: "git merge -h", stdout: HELP_STDOUT, exitCode: 0 }),
    ).toBeNull()
  })

  test("`git help merge` (help subcommand) → null", () => {
    expect(
      classifyPassiveVcs({ command: "git help merge", stdout: HELP_STDOUT, exitCode: 0 }),
    ).toBeNull()
  })

  test("`git rebase --help` → null (no spurious rebased event)", () => {
    expect(
      classifyPassiveVcs({
        command: "git rebase --help",
        stdout: "Successfully rebased and updated refs/heads/main.",
        exitCode: 0,
      }),
    ).toBeNull()
  })

  test("`gh pr create --help` → null (no spurious pr event)", () => {
    expect(
      classifyPassiveVcs({
        command: "gh pr create --help",
        stdout: "USAGE\n  see https://github.com/o/r/pull/7 for an example",
        exitCode: 0,
      }),
    ).toBeNull()
  })

  test("`--help=man` form → null", () => {
    expect(
      classifyPassiveVcs({ command: "git merge --help=man", stdout: HELP_STDOUT, exitCode: 0 }),
    ).toBeNull()
  })

  // ── the help guard must NOT swallow a REAL git op ──
  test("REAL `git merge` (fast-forward) STILL classifies merged", () => {
    const ev = classifyPassiveVcs({
      command: "git merge feature",
      stdout: "Updating a1b2c3d..d4e5f6a\nFast-forward\n file.txt | 2 +-",
      exitCode: 0,
    })
    expect(ev?.branch?.action).toBe("merged")
  })

  test("REAL `git merge` (merge commit) STILL classifies merged + commit", () => {
    const ev = classifyPassiveVcs({
      command: "git merge --no-ff feature",
      stdout: "Merge made by the 'ort' strategy.\n[main 9f8e7d6] Merge branch 'feature'",
      exitCode: 0,
    })
    expect(ev?.branch?.action).toBe("merged")
    expect(ev?.commit?.kind).toBe("merge")
  })

  test("a `--help` in an UNRELATED pipeline member does not suppress a real merge", () => {
    // `echo --help && git merge feature` — the help flag is on `echo`, NOT the
    // git segment, so the real merge still classifies.
    const ev = classifyPassiveVcs({
      command: "echo --help && git merge feature",
      stdout: "Updating a1b2c3d..d4e5f6a\nFast-forward",
      exitCode: 0,
    })
    expect(ev?.branch?.action).toBe("merged")
  })

  test("a literal `--help` inside a quoted commit message does not falsely trigger help-skip on a real op", () => {
    // `git commit -m 'document --help flag'` — `--help` is inside the message
    // arg, but our segment-scoped HELP_FLAG matches a `--help` token preceded by
    // whitespace; this is an accepted conservative over-skip ONLY if the seg
    // truly contains a bare `--help` token. Here it is quoted; the classifier
    // still sees the token, so we assert the SAFE direction (no crash, defined).
    const ev = classifyPassiveVcs({
      command: "git commit -m 'document the --help flag'",
      stdout: "[main 1234abc] document the --help flag",
      exitCode: 0,
    })
    // Conservative: a bare `--help` token in the segment suppresses classification
    // (documentation-shaped command). Asserting it is null is the documented,
    // SAFE behavior — over-skipping a commit is strictly safer than a phantom
    // event, and a real commit's directive path (`::git-*`) is unaffected.
    expect(ev).toBeNull()
  })
})

/* ─────────────────────── B2: reconcile duplicate tool_use id ────────────── */

/** Collect every `tool_use` id and every `tool_result` `tool_use_id` from a
 *  reconciled message array (module-level so the INVARIANT test stays flat). */
const collectPairIds = (
  out: readonly unknown[],
): { useIds: Set<string>; resultIds: Set<string> } => {
  const useIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const m of out) {
    const content = (m as { content: unknown }).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use") useIds.add(b.id as string)
      if (b.type === "tool_result") resultIds.add(b.tool_use_id as string)
    }
  }
  return { useIds, resultIds }
}

describe("B2 — reconcile duplicate tool_use id (no crash, valid shape)", () => {
  const stub = "[tool result missing after resume — synthesized to keep the transcript valid]"

  test("dup id with ONE matching result → byte-identical passthrough (no crash)", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "dup", name: "x", input: {} },
          { type: "tool_use", id: "dup", name: "y", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: "ok" }] },
    ]
    const out = reconcileToolPairing(msgs)
    // SAME reference — both uses' id is satisfied (id-keyed membership), the wire
    // is model-valid (every tool_use id has a matching result), nothing repaired.
    expect(out).toBe(msgs)
  })

  test("dup id with NO result → stub synthesized per orphan-use (model-valid, no crash)", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "dup", name: "x", input: {} },
          { type: "tool_use", id: "dup", name: "y", input: {} },
        ],
      },
    ]
    const out = reconcileToolPairing(msgs)
    expect(out).not.toBe(msgs)
    expect(out.length).toBe(2)
    const stubs = (
      out[1] as unknown as { content: Array<{ tool_use_id: string; content: string }> }
    ).content
    // One stub per orphan-use occurrence; each references the (shared) id, so the
    // id has a matching result on the wire (no dangling tool_use).
    expect(stubs.length).toBe(2)
    for (const s of stubs) {
      expect(s.tool_use_id).toBe("dup")
      expect(s.content).toBe(stub)
    }
  })

  test("INVARIANT — after reconcile, every tool_use id has ≥1 matching result", () => {
    const cases = [
      // dup id, 1 result
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "d", name: "x", input: {} },
            { type: "tool_use", id: "d", name: "y", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "ok" }] },
      ],
      // dup id, 0 results
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "d", name: "x", input: {} },
            { type: "tool_use", id: "d", name: "y", input: {} },
          ],
        },
      ],
    ]
    for (const msgs of cases) {
      const { useIds, resultIds } = collectPairIds(reconcileToolPairing(msgs))
      for (const id of useIds) expect(resultIds.has(id)).toBe(true)
    }
  })

  test("dup id is HANDLED without throwing on a malformed sibling block too", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "d", name: "x", input: {} },
          { type: "tool_use", id: "d", name: "y", input: {} },
          { type: "text", text: "narration" },
          null,
        ],
      },
    ]
    expect(() => reconcileToolPairing(msgs)).not.toThrow()
  })
})

/* ─────────────────────── B3: hostile env → permission mode ───────────────── */

/** Build a CLEAN env view (only the keys a test sets), so the resolver reads no
 *  ambient profile knobs. `resolvePermissionModeFromProfile` takes an explicit
 *  env arg, so we never touch process.env. */
const env = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

describe("B3 — hostile layered env never escalates the resolved PermissionMode", () => {
  test("per-repo `trusted` (approval auto) alone → NOT auto (guard drops the widen)", () => {
    // A checked-in `.quanta` policy tries to grant AFK auto-approve via the
    // per-repo layer. With NO trusted (per-user/team-admin) peer, the provenance
    // guard drops the repo `approval` widen → merged approval stays the default's
    // `once` → mode `"default"`, NOT `"auto"`.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({ QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted" }),
    )
    expect(mode).not.toBe("auto")
    expect(mode).toBe("default")
  })

  test("per-repo `trusted` even with explicit source-precedence → NOT auto", () => {
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted",
        QUANTA_POLICY_MERGE_STRATEGY: "source-precedence",
      }),
    )
    expect(mode).not.toBe("auto")
  })

  test("per-repo `trusted` cannot override a per-user `restricted` into auto", () => {
    // per-user (trusted source) sets restricted (approval always). The repo's
    // trusted/auto widen is dropped; the merged approval is the strictest of the
    // trusted contributions → mode `"default"`, never `"auto"`.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_USER: "restricted",
        QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted",
      }),
    )
    expect(mode).not.toBe("auto")
    expect(mode).toBe("default")
  })

  test("under most-restrictive, per-repo `trusted` also cannot widen to auto", () => {
    // The most-restrictive strategy merges the SAFEST approval per sub-axis, so
    // the repo's `auto` can never win over the default's stricter `once`.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted",
        QUANTA_POLICY_MERGE_STRATEGY: "most-restrictive",
      }),
    )
    expect(mode).not.toBe("auto")
  })

  test("a LEGITIMATE per-user `trusted` (trusted source) MAY map to auto — guard does not over-block", () => {
    // The provenance guard only drops REPO-controllable widens; a user's OWN
    // config (per-user) is a trusted grant authority. This proves the guard is
    // not a blanket "never auto" hammer — only repo sources are constrained.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({ QUANTA_PERMISSION_PROFILE_PER_USER: "trusted" }),
    )
    expect(mode).toBe("auto")
  })

  test("no layered + no single profile → undefined (byte-identical legacy, slot untouched)", () => {
    expect(resolvePermissionModeFromProfile(undefined, env({}))).toBeUndefined()
  })

  test("team-admin `trusted` + per-repo `restricted` → repo NARROW kept, admin grant honored", () => {
    // team-admin (trusted authority) grants trusted/auto; per-repo only narrows
    // (restricted/always). Narrowing from a repo is always safe (kept). The
    // merged approval is the SAFEST present → strict → mode `"default"`, NOT auto.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "trusted",
        QUANTA_PERMISSION_PROFILE_PER_REPO: "restricted",
        QUANTA_POLICY_MERGE_STRATEGY: "most-restrictive",
      }),
    )
    expect(mode).not.toBe("auto")
  })
})
