/**
 * HELLGATE — T04 trust gate, FULL UC1 pipeline through the REAL migration
 * importer: an externally-imported hook (`src/migration/external-config`) lands
 * in `<project>/settings.json#hooks`, and when the command-hooks loader reads it
 * back the binding is REVIEW-GATED, so under an armed trust gate it does NOT
 * fire un-reviewed.
 *
 * Split from `command-hooks-trust-gate-hellgate.test.ts` because it imports the
 * migration persist module; the core UC1–UC5 security proofs live there and do
 * not depend on the migration slice.
 *
 * The load-bearing assertion is `needsReview:true` — guaranteed by the legacy
 * reader's REPO-provenance stamp REGARDLESS of whether the migration writes its
 * own `needsReview` marker, so the proof holds either way.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  loadCommandHookBindings,
  normalizeCommandHookGate,
  runCommandHooks,
} from "@/agent"
import { persistConvertedItems } from "@/migration/external-config/persist"

const fakeExec = (): { port: CommandHookExecPort; calls: CommandHookExecOpts[] } => {
  const calls: CommandHookExecOpts[] = []
  return {
    calls,
    port: {
      exec: async (opts): Promise<CommandHookExecResult> => {
        calls.push(opts)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false }
      },
    },
  }
}
const allowPermission: CommandHookPermissionPort = { isAllowed: () => true }

describe("T04 — migration-imported hook lands review-gated (import→persist→load→fire)", () => {
  test("persisted imported hook reads back needsReview and is HELD under the armed trust gate", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hook-import-"))
    const homeDir = await mkdtemp(join(tmpdir(), "hook-import-home-"))
    try {
      const result = await persistConvertedItems({
        enabled: true,
        homeDir,
        projectDir,
        converted: [
          {
            type: "hooks",
            ok: true,
            value: [{ event: "PreToolUse", commands: ["external-scan.sh"] }],
          },
        ],
      })
      expect(result.persisted).toBe(true)

      const bindings = await loadCommandHookBindings(join(projectDir, "settings.json"))
      const b = bindings.find((x) => x.command === "external-scan.sh")
      expect(b?.needsReview).toBe(true) // review-gated (repo provenance)
      expect(b?.source === "imported" || b?.source === "project").toBe(true)

      // FULL UC1 — under an armed trust gate this imported hook does NOT fire.
      const gate = normalizeCommandHookGate({
        enabled: true,
        acknowledgedRisk: "armed for migration e2e",
        bindings,
        trustGate: true,
      })
      const { port, calls } = fakeExec()
      await runCommandHooks(
        gate,
        { exec: port, permission: allowPermission, cwd: projectDir },
        { type: "pre_tool_use", toolName: "write", payload: {} },
      )
      expect(calls.length).toBe(0)

      // SECURITY (fail-closed by provenance) — the SAME imported hook is ALSO
      // held with the trust-gate knob OFF and no review port (the default-path
      // RCE hole this fix closes): provenance enforcement does not depend on the
      // opt-in knob.
      const knobOff = normalizeCommandHookGate({
        enabled: true,
        acknowledgedRisk: "armed for migration e2e, knob off",
        bindings,
        trustGate: false,
      })
      const offRun = fakeExec()
      await runCommandHooks(
        knobOff,
        { exec: offRun.port, permission: allowPermission, cwd: projectDir },
        { type: "pre_tool_use", toolName: "write", payload: {} },
      )
      expect(offRun.calls.length).toBe(0) // RED under the old bypass
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
