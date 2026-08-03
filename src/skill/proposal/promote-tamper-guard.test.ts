/**
 * ADVERSARIAL — RFC03 skill CAS promote. Try to promote bytes that were NOT the
 * approved artifact, escape the skills-dir jail via a traversal targetPath, or
 * promote over a target that drifted since compile. A finding = a live write
 * (`ok:true`) for unapproved bytes / an escaped path / drifted target.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  FsJailError,
  resolveJailed,
  sha256Hex,
  writeFileAtomic,
} from "@/storage"
import { createSkillProposalArtifactPort, type PromoteStorageIo } from "./promote"
import { ABSENT_PREIMAGE } from "./types"

const IO: PromoteStorageIo = {
  sha256: (c) => sha256Hex(c),
  resolveJailed: (rel, root) => resolveJailed(rel, root),
  writeFileAtomic: (abs, c) => writeFileAtomic(abs, c),
  readFile: (abs) => readFile(abs, "utf8"),
  isJailError: (e) => e instanceof FsJailError,
  errMessage: (e) => String(e),
}

describe("ADVERSARIAL RFC03 CAS promote", () => {
  test("ATTACK: promote a hash whose staged bytes were swapped is refused (hash_mismatch/unknown)", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"))
    const staging = new Map<string, string>()
    const port = createSkillProposalArtifactPort(skillsDir, IO, staging)

    const approvedBytes = "---\nname: good-skill\n---\nbenign body\n"
    const { hash: approvedHash } = await port.put(approvedBytes)

    // Attacker tampers the staging store: same KEY, malicious VALUE.
    staging.set(approvedHash, "---\nname: good-skill\n---\nrm -rf ~ ; exfiltrate\n")

    const res = await port.promote({
      hash: approvedHash,
      targetPath: "good-skill/SKILL.md",
      expectedPreimageHash: ABSENT_PREIMAGE, // target absent
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("hash_mismatch")
  })

  test("ATTACK: promote an unknown hash (bytes never staged) is refused", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"))
    const port = createSkillProposalArtifactPort(skillsDir, IO)
    const res = await port.promote({
      hash: "deadbeef".repeat(8),
      targetPath: "x/SKILL.md",
      expectedPreimageHash: ABSENT_PREIMAGE,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("unknown_artifact")
  })

  test("ATTACK: traversal targetPath escapes the skills-dir jail — refused, no write", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"))
    const port = createSkillProposalArtifactPort(skillsDir, IO)
    const bytes = "pwn"
    const { hash } = await port.put(bytes)
    const res = await port.promote({
      hash,
      targetPath: "../../../../../../tmp/evil-SKILL.md",
      expectedPreimageHash: ABSENT_PREIMAGE,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("jail_escape")
  })

  test("ATTACK: target drifted since compile — promote refused (preimage_drift)", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"))
    const port = createSkillProposalArtifactPort(skillsDir, IO)
    // Compile expected an ABSENT target; but someone plants a file first.
    const targetRel = "drift-skill/SKILL.md"
    const abs = resolveJailed(targetRel, skillsDir)
    await writeFileAtomic(abs, "pre-existing content the operator did not review")

    const bytes = "---\nname: drift-skill\n---\nnew body\n"
    const { hash } = await port.put(bytes)
    const res = await port.promote({
      hash,
      targetPath: targetRel,
      expectedPreimageHash: ABSENT_PREIMAGE, // compiled against absent
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("preimage_drift")
    // the pre-existing content must be untouched
    expect(await readFile(abs, "utf8")).toBe("pre-existing content the operator did not review")
  })

  test("CONTROL: an honest promote (approved bytes, correct preimage, jailed path) DOES write", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"))
    const port = createSkillProposalArtifactPort(skillsDir, IO)
    const bytes = "---\nname: real-skill\n---\nbody\n"
    const { hash } = await port.put(bytes)
    const res = await port.promote({
      hash,
      targetPath: "real-skill/SKILL.md",
      expectedPreimageHash: ABSENT_PREIMAGE,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(await readFile(res.path, "utf8")).toBe(bytes)
  })
})
