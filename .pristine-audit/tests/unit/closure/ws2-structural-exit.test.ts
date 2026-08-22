/**
 * WS2 structural-exit hellgate. End-to-end on a #14315-like tree (real ripgrep,
 * no LLM): a localized owner whose issue-mentioned method has a co-change sibling
 * must drive ownerResolved → owner-admission `owner-family` →
 * decideEscalation `sibling_coverage_missing`. Pinned as ONE chain so a break
 * anywhere (feeder anchor logic, packet provenance, owner-admission, gate) trips.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveOwnerSiblings } from "@/agent/closure"
import { decideEscalation } from "@/agent/repair-escalation"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"

describe("WS2 structural exit (feeder → owner-family → sibling_coverage_missing)", () => {
  test("localizing the parent surfaces the child override and fires the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws2-struct-"))
    try {
      // Two backends define the SAME method `runshell` (the #14315 shape).
      writeFileSync(
        join(dir, "base.py"),
        "class Base:\n    def runshell(self, parameters):\n        pass\n",
      )
      writeFileSync(
        join(dir, "pg.py"),
        "class PG(Base):\n    def runshell(self, parameters):\n        pass\n",
      )
      // Issue mentions `runshell` in PROSE (extractSymbols would return []).
      const problemStatement = "database client runshell doesn't respect os.environ values"
      const stage1Files = [{ file: "base.py", score: 5 }]
      const readSource = (rel: string): string | null => {
        try {
          return readFileSync(join(dir, rel), "utf8")
        } catch {
          return null
        }
      }

      // 1. feeder: owner-def(runshell) ∩ issue-mention → grep → sibling pg.py
      const resolved = await resolveOwnerSiblings()({
        stage1Files,
        issueText: problemStatement,
        cwd: dir,
        readSource,
      })
      expect(resolved).toEqual([{ file: "pg.py", forSymbol: "runshell" }])

      // 2. closure session: ownerResolved → packet candidate (owner-resolve) →
      //    owner-admission sees an owner-family.
      const session = buildClosureSession({
        problemStatement,
        stage1Files,
        ownerResolved: resolved,
        posture: { lspNav: true, primaryRail: true, faultEvidence: true },
      })
      // pg.py enters the packet with owner-resolve provenance (the feeder signal
      // the gate keys off — not the overloaded owner-admission boolean).
      const pg = session.bundle.evidence.candidates.find((c) => c.file === "pg.py")
      expect(pg?.sources).toContain("owner-resolve")

      // 3. gate: rail red + feeder siblingFiles ⇒ sibling_coverage_missing.
      const esc = decideEscalation({
        candidates: session.bundle.evidence.candidates.map((c) => ({
          file: c.file,
          score: c.score,
          sources: c.sources,
        })),
        primaryRailRedAfterRepair: true,
        siblingFiles: resolved.map((o) => o.file),
      })
      expect(esc.escalate).toBe(true)
      expect(esc.reason).toContain("sibling_coverage_missing")
      expect(esc.owners).toContain("pg.py")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
