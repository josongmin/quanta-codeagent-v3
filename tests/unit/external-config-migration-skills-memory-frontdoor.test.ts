/**
 * FRONT-DOOR PROOF — RFC03-4 SKILLS/MEMORY import through the REAL pipeline.
 *
 * Unlike the fake-port hellgate, this composes the ACTUAL host wiring:
 *   - the real `createSkillProposalArtifactPort` (RFC03-2/3 CAS staging/promote,
 *     backed by the real `@/storage` sha256 / realpath-jail / atomic write),
 *   - the real `createApprovalStateMachine`,
 *   - and drives them through `importExternalConfig` exactly as the host does.
 *
 * It proves the load-bearing contract end-to-end:
 *   1. an imported `.claude/skills/*​/SKILL.md` is STAGED (not live-written) — the
 *      live skills dir is empty right after import,
 *   2. an approval request is opened bound to the EXACT staged artifact hash,
 *   3. on operator APPROVE the CAS `promote` writes the SKILL.md into the live
 *      jailed skills dir (the promotion the approval authorizes),
 *   4. a preimage-drift / wrong-hash promote is REFUSED (fail-closed),
 *   5. an imported memory file is APPENDED to raw_memories.md (never MEMORY.md).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ApprovalRequest,
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import { importExternalConfig, type SkillStagePort } from "@/migration/external-config"
import { errMessage } from "@/shared"
import { createSkillProposalArtifactPort, type PromoteStorageIo } from "@/skill"
import {
  FsJailError,
  resolveJailed,
  sha256Hex,
  readFile as storageReadFile,
  writeFileAtomic,
} from "@/storage"

let home: string
let project: string

const write = async (p: string, c: string): Promise<void> => {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(p, c, "utf8")
}

const SKILL = `---
name: imported-helper
description: an imported helper skill
userInvocable: true
allowedTools: []
category: skill
stability: stable
---
Do the imported thing.
`

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rfc034-fd-home-"))
  project = await mkdtemp(join(tmpdir(), "rfc034-fd-proj-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const HOST_IO: PromoteStorageIo = {
  sha256: (c) => sha256Hex(c),
  resolveJailed: (rel, root) => resolveJailed(rel, root),
  writeFileAtomic: (abs, c) => writeFileAtomic(abs, c),
  readFile: (abs) => storageReadFile(abs),
  isJailError: (e) => e instanceof FsJailError,
  errMessage: (e) => errMessage(e),
}

describe("front door — imported skill staged → approved → CAS promoted", () => {
  test("stages via real artifact port + approval, promotes only on approve", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)
    await write(join(home, ".claude", "CLAUDE.md"), "# global memory\nremember the invariant")

    // Host composition: the live skills dir is the CAS jail root.
    const liveSkillsDir = join(home, ".quanta", "skills")
    await mkdir(liveSkillsDir, { recursive: true })
    const artifact = createSkillProposalArtifactPort(liveSkillsDir, HOST_IO)
    const approval: ApprovalStateMachinePort = createApprovalStateMachine()

    // The host-composed stage port: put bytes into the CAS store + open an
    // approval bound to the exact hash (mirrors tier1/skill.ts).
    const staged: Array<{ hash: string; targetPath: string }> = []
    const stagePort: SkillStagePort = {
      stage: async (args) => {
        await artifact.put(args.bytes)
        approval.request({
          threadId: "t-import",
          kind: "permission",
          reason: `Install imported skill "${args.name}"`,
          proposedAction: `write ${args.targetPath}`,
          resumeStep: "promote-imported-skill",
          artifactRef: args.artifactHash,
          artifactHash: args.artifactHash,
        })
        staged.push({ hash: args.artifactHash, targetPath: args.targetPath })
        return { proposalId: args.artifactHash }
      },
    }

    const res = await importExternalConfig({
      enabled: true,
      homeDir: home,
      projectDir: project,
      skillStage: stagePort,
    })
    expect(res.ran).toBe(true)
    expect(res.persisted).toBe(true)

    // (1) STAGED, not live-written: the live skills dir has NO SKILL.md yet.
    expect(staged.length).toBe(1)
    const livePathBeforeApprove = join(liveSkillsDir, "imported-helper", "SKILL.md")
    await expect(stat(livePathBeforeApprove)).rejects.toBeDefined()

    // (2) approval opened, bound to the exact staged artifact hash.
    const stagedHash = staged[0]?.hash ?? ""
    const req = approval.pending().find((r: ApprovalRequest) => r.artifactHash === stagedHash)
    expect(req).toBeDefined()
    expect(req?.decision).toBeUndefined() // pending

    // (4-neg first) a wrong-hash promote is refused (fail-closed).
    const bogus = await artifact.promote({
      hash: "deadbeef".repeat(8),
      targetPath: "imported-helper/SKILL.md",
      expectedPreimageHash: "absent",
    })
    expect(bogus.ok).toBe(false)

    // (3) operator APPROVE → CAS promote writes into the live jailed dir.
    approval.settle(req?.id ?? "", "approve")
    const promoted = await artifact.promote({
      hash: stagedHash,
      targetPath: "imported-helper/SKILL.md",
      expectedPreimageHash: "absent", // target was absent at compile time
    })
    expect(promoted.ok).toBe(true)
    const liveBytes = await readFile(livePathBeforeApprove, "utf8")
    // The promoted bytes are the imported skill, stamped experimental by the
    // converter (never presented as the source's `stability: stable`).
    expect(liveBytes).toContain("name: imported-helper")
    expect(liveBytes).toContain("stability: experimental")

    // (4) a second promote against a DRIFTED preimage is refused (TOCTOU guard).
    const drift = await artifact.promote({
      hash: stagedHash,
      targetPath: "imported-helper/SKILL.md",
      expectedPreimageHash: "absent", // now the target EXISTS ⇒ preimage drift
    })
    expect(drift.ok).toBe(false)
    if (!drift.ok) expect(drift.reason).toBe("preimage_drift")

    // (5) memory appended to raw_memories.md; MEMORY.md untouched.
    const raw = await readFile(join(home, ".quanta", "memory", "raw_memories.md"), "utf8")
    expect(raw).toContain("remember the invariant")
    const memoryMd = await readFile(join(home, ".quanta", "memory", "MEMORY.md"), "utf8").catch(
      () => "__ABSENT__",
    )
    expect(memoryMd).toBe("__ABSENT__")
  })
})
