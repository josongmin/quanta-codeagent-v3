/**
 * HELLGATE — RFC03-2/3 immutable proposal compiler + approval-bound CAS promote.
 *
 * Invariants (anti-vacuous — real bytes / real disk / fresh-readback):
 *   - Vacuous invention is refused: empty evidence ⇒ `no_evidence`; an evidence
 *     path that does not resolve / escapes ⇒ `evidence_unresolved`. NO proposal.
 *   - Determinism: same draft+evidence ⇒ same `draftHash`/`proposalId`.
 *   - Admission: `new` name colliding with a system skill ⇒ `system_shadow`;
 *     `improvement` with an undiscovered target ⇒ `unknown_target`.
 *   - Staging is content-addressed + immutable: get(hash) returns exactly the
 *     bytes whose sha256 == hash.
 *   - Promote is fail-closed CAS: preimage drift ⇒ NO write; jail escape ⇒ NO
 *     write; happy path writes EXACTLY the approved bytes (fresh-readback).
 *   - Compiling a proposal does NOT touch the live skills dir (readback shows
 *     nothing written before promote).
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile as fsRead, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import {
  compileSkillProposal,
  createSkillProposalArtifactPort,
  type PromoteStorageIo,
  type ProposalIo,
} from "@/skill"
import {
  canonicalizePath,
  FsJailError,
  resolveJailed,
  sha256Hex,
  readFile as storageRead,
  writeFileAtomic,
} from "@/storage"

const GEN = "test-generator@1"

/** Real `@/storage`-backed io the host injects into the artifact port. */
const STORAGE_IO: PromoteStorageIo = {
  sha256: (c) => sha256Hex(c),
  resolveJailed: (rel, root) => resolveJailed(rel, root),
  writeFileAtomic: (abs, content) => writeFileAtomic(abs, content),
  readFile: (abs) => storageRead(abs),
  isJailError: (e) => e instanceof FsJailError,
  errMessage: (e) => errMessage(e),
}

/** Build a ProposalIo over a real temp dir. `roots` gates evidence + target. */
const makeIo = (roots: string[], system: string[] = [], discovered: string[] = []): ProposalIo => ({
  sha256: (c) => sha256Hex(c),
  resolveUnderRoots: (p) => {
    const canonical = canonicalizePath(p)
    return roots.some((r) => canonical === r || canonical.startsWith(`${r}/`)) ? canonical : null
  },
  readIfExists: async (p) => {
    try {
      return await fsRead(p, "utf8")
    } catch {
      return null
    }
  },
  systemSkillNames: new Set(system),
  discoveredSkillNames: new Set(discovered),
})

const DRAFT = {
  name: "pdf-extract",
  description: "Extract text from a PDF",
  body: "Read the pdf and extract text.",
  kind: "new" as const,
}

describe("RFC03-2 compiler — anti-vacuous evidence gate", () => {
  test("empty evidence ⇒ no_evidence (no proposal)", async () => {
    const io = makeIo(["/nonexistent"])
    const r = await compileSkillProposal(io, DRAFT, [], GEN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("no_evidence")
  })

  test("evidence path that does not resolve ⇒ evidence_unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "prop-ev-"))
    try {
      const io = makeIo([canonicalizePath(root)])
      const r = await compileSkillProposal(io, DRAFT, [join(root, "ghost.md")], GEN)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("evidence_unresolved")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("evidence path escaping the roots ⇒ evidence_unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "prop-esc-"))
    try {
      await writeFile(join(root, "ok.md"), "real evidence")
      const io = makeIo([canonicalizePath(root)])
      // an absolute path clearly outside the root
      const r = await compileSkillProposal(io, DRAFT, ["/etc/hosts"], GEN)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("evidence_unresolved")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("valid evidence ⇒ proposal with hashed anchors + determinism", async () => {
    const root = await mkdtemp(join(tmpdir(), "prop-ok-"))
    try {
      const ev = join(root, "raw_memories.md")
      await writeFile(ev, "I did X three times")
      const io = makeIo([canonicalizePath(root)])
      const r1 = await compileSkillProposal(io, DRAFT, [ev], GEN)
      const r2 = await compileSkillProposal(io, DRAFT, [ev], GEN)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r1.proposal.draftHash).toBe(r2.proposal.draftHash)
        expect(r1.proposal.proposalId).toBe(r1.proposal.draftHash)
        expect(r1.proposal.sources).toHaveLength(1)
        expect(r1.proposal.sources[0]?.sha256).toBe(sha256Hex("I did X three times"))
        expect(r1.proposal.targetPath).toBe("pdf-extract/SKILL.md")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("RFC03-2 compiler — admission", () => {
  test("new name colliding with a system skill ⇒ system_shadow", async () => {
    const root = await mkdtemp(join(tmpdir(), "prop-sys-"))
    try {
      const ev = join(root, "e.md")
      await writeFile(ev, "evidence")
      const io = makeIo([canonicalizePath(root)], ["localize-fault"])
      const r = await compileSkillProposal(io, { ...DRAFT, name: "localize-fault" }, [ev], GEN)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("system_shadow")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("improvement with an undiscovered target ⇒ unknown_target", async () => {
    const root = await mkdtemp(join(tmpdir(), "prop-tgt-"))
    try {
      const ev = join(root, "e.md")
      await writeFile(ev, "evidence")
      const io = makeIo([canonicalizePath(root)], [], ["known-skill"])
      const r = await compileSkillProposal(
        io,
        { ...DRAFT, name: "unknown-one", kind: "improvement", target: "unknown-one" },
        [ev],
        GEN,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("unknown_target")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("RFC03-2/3 staging + CAS promote", () => {
  test("staging is content-addressed + immutable", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "prop-stage-"))
    try {
      const port = createSkillProposalArtifactPort(skillsDir, STORAGE_IO)
      const bytes = "---\nname: x\n---\nbody"
      const a = await port.put(bytes)
      expect(a.hash).toBe(sha256Hex(bytes))
      const got = await port.get(a.hash)
      expect(got?.bytes).toBe(bytes)
      // unknown hash ⇒ null (never a phantom)
      expect(await port.get("deadbeef")).toBeNull()
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  test("compile does NOT write live; promote writes exactly the approved bytes", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "prop-promote-"))
    const evRoot = await mkdtemp(join(tmpdir(), "prop-ev2-"))
    try {
      const ev = join(evRoot, "e.md")
      await writeFile(ev, "evidence")
      const io = makeIo([canonicalizePath(evRoot), canonicalizePath(skillsDir)])
      const r = await compileSkillProposal(io, DRAFT, [ev], GEN)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // compile must NOT have written the live target.
      expect(existsSync(join(skillsDir, "pdf-extract", "SKILL.md"))).toBe(false)

      const port = createSkillProposalArtifactPort(skillsDir, STORAGE_IO)
      await port.put(r.proposal.draftBytes)
      const promoted = await port.promote({
        hash: r.proposal.draftHash,
        targetPath: r.proposal.targetPath,
        expectedPreimageHash: r.proposal.targetPreimageHash,
      })
      expect(promoted.ok).toBe(true)
      if (promoted.ok) {
        // fresh-readback: exactly the approved bytes are on disk.
        const onDisk = await fsRead(promoted.path, "utf8")
        expect(onDisk).toBe(r.proposal.draftBytes)
        expect(sha256Hex(onDisk)).toBe(r.proposal.draftHash)
      }
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
      await rm(evRoot, { recursive: true, force: true })
    }
  })

  test("promote refuses on preimage drift (target changed since compile)", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "prop-drift-"))
    const evRoot = await mkdtemp(join(tmpdir(), "prop-ev3-"))
    try {
      const ev = join(evRoot, "e.md")
      await writeFile(ev, "evidence")
      const io = makeIo([canonicalizePath(evRoot), canonicalizePath(skillsDir)])
      const r = await compileSkillProposal(io, DRAFT, [ev], GEN)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const port = createSkillProposalArtifactPort(skillsDir, STORAGE_IO)
      await port.put(r.proposal.draftBytes)
      // Simulate a concurrent write to the target AFTER compile (preimage was
      // ABSENT; now it exists with different bytes).
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(skillsDir, "pdf-extract"), { recursive: true })
      await writeFile(join(skillsDir, "pdf-extract", "SKILL.md"), "SOMEONE ELSE WROTE THIS")
      const promoted = await port.promote({
        hash: r.proposal.draftHash,
        targetPath: r.proposal.targetPath,
        expectedPreimageHash: r.proposal.targetPreimageHash,
      })
      expect(promoted.ok).toBe(false)
      if (!promoted.ok) expect(promoted.reason).toBe("preimage_drift")
      // the concurrent bytes are NOT overwritten.
      const onDisk = await fsRead(join(skillsDir, "pdf-extract", "SKILL.md"), "utf8")
      expect(onDisk).toBe("SOMEONE ELSE WROTE THIS")
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
      await rm(evRoot, { recursive: true, force: true })
    }
  })

  test("promote refuses an unknown artifact (never staged)", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "prop-unk-"))
    try {
      const port = createSkillProposalArtifactPort(skillsDir, STORAGE_IO)
      const promoted = await port.promote({
        hash: "never-staged",
        targetPath: "x/SKILL.md",
        expectedPreimageHash: "absent",
      })
      expect(promoted.ok).toBe(false)
      if (!promoted.ok) expect(promoted.reason).toBe("unknown_artifact")
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  test("promote refuses a jail-escaping target path", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "prop-jail-"))
    try {
      const port = createSkillProposalArtifactPort(skillsDir, STORAGE_IO)
      const bytes = "content"
      const a = await port.put(bytes)
      const promoted = await port.promote({
        hash: a.hash,
        targetPath: "../escape/SKILL.md",
        expectedPreimageHash: "absent",
      })
      expect(promoted.ok).toBe(false)
      if (!promoted.ok) expect(promoted.reason).toBe("jail_escape")
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })
})
