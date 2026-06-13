/**
 * T05 — partial-apply executor (atomic write + mode preservation + staleness
 * re-check on the RESTING tree). Real-disk tests with FRESH-READBACK: every
 * "did it land" assertion re-reads the file from disk, never trusts a return
 * value. Mode preservation is asserted by red-on-injection (a 0o755 file must
 * still be 0o755 after a partial apply).
 */
import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyHunkSelection } from "@/runner/hunk-apply"

const fresh = (): string => mkdtempSync(join(tmpdir(), "hunk-apply-"))

const B = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
const A = ["line1", "L2X", "line3", "line5", "L6X", "line7"].join("\n")

describe("applyHunkSelection — partial apply to disk", () => {
  it("UC1: applies ONLY the selected hunk to disk; rest stays at `before` (fresh-readback)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1"] })
    expect(res.status).toBe("applied")
    // FRESH-READBACK from disk — not the return value.
    const onDisk = readFileSync(path, "utf8")
    expect(onDisk).toBe(
      ["line1", "L2X", "line3", "line4", "line5", "line6", "line7"].join("\n"),
    )
  })

  it("UC1 control: selecting ALL hunks reproduces `after` on disk", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection({
      path,
      before: B,
      after: A,
      selectedHunkIds: ["h1", "h2", "h3"],
    })
    expect(res.status).toBe("applied")
    expect(readFileSync(path, "utf8")).toBe(A)
  })

  it("UC2: rejecting a hunk (selecting the others) leaves the rejected change unapplied", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    // Accept h1 + h3, reject h2 (the line4 deletion) → line4 survives.
    await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1", "h3"] })
    const onDisk = readFileSync(path, "utf8")
    expect(onDisk).toContain("line4")
    expect(onDisk).toBe(
      ["line1", "L2X", "line3", "line4", "line5", "L6X", "line7"].join("\n"),
    )
  })

  it("UC4: aborts (no write) when disk drifted from `before` since preview", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    // Simulate a concurrent edit AFTER the diff was computed.
    const drifted = `${B}\nSNUCK_IN`
    writeFileSync(path, drifted)
    const res = await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1"] })
    expect(res.status).toBe("stale")
    // Zero write — disk is byte-identical to the drifted content.
    expect(readFileSync(path, "utf8")).toBe(drifted)
  })

  it("UC5: preserves file mode across a partial apply (red-on-injection: 0o755 stays 0o755)", async () => {
    const dir = fresh()
    const path = join(dir, "script.sh")
    writeFileSync(path, B)
    chmodSync(path, 0o755)
    const before = statSync(path).mode & 0o777
    expect(before).toBe(0o755) // guard: the fixture really is executable
    await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1"] })
    const after = statSync(path).mode & 0o777
    expect(after).toBe(0o755)
  })

  it("error status when the atomic write throws (injected) — no false success", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection(
      { path, before: B, after: A, selectedHunkIds: ["h1"] },
      {
        writeFile: async () => {
          throw new Error("EACCES: permission denied")
        },
      },
    )
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.reason).toContain("EACCES")
    // The real disk was never touched (the injected write threw before any I/O).
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  it("UC5b: preserves a restrictive 0o600 mode across the partial apply", async () => {
    const dir = fresh()
    const path = join(dir, "secret.txt")
    writeFileSync(path, B)
    chmodSync(path, 0o600)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1"] })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("UC5c: preserves a read-only 0o444 mode (rename replaces the dir entry, mode carried)", async () => {
    const dir = fresh()
    const path = join(dir, "frozen.txt")
    writeFileSync(path, B)
    chmodSync(path, 0o444)
    expect(statSync(path).mode & 0o777).toBe(0o444)
    const res = await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: ["h1"] })
    expect(res.status).toBe("applied")
    expect(statSync(path).mode & 0o777).toBe(0o444)
  })

  it("no-op when no hunks selected — disk stays at `before` (still passes the staleness gate)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection({ path, before: B, after: A, selectedHunkIds: [] })
    // Reconstruction === before → still a clean write, content unchanged.
    expect(res.status).toBe("applied")
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  it("appliedHunkIds is deduped + diff-ordered even for duplicate/unordered input", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection({
      path,
      before: B,
      after: A,
      selectedHunkIds: ["h3", "h1", "h1", "h99"],
    })
    expect(res.status).toBe("applied")
    if (res.status === "applied") {
      // deduped, unknown dropped, restored to diff order h1<h3.
      expect(res.appliedHunkIds).toEqual(["h1", "h3"])
    }
  })

  it("reports the applied hunk ids and the partial content on success", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const res = await applyHunkSelection({
      path,
      before: B,
      after: A,
      selectedHunkIds: ["h2"],
    })
    expect(res.status).toBe("applied")
    if (res.status === "applied") {
      expect(res.appliedHunkIds).toEqual(["h2"])
      expect(res.content).toBe(readFileSync(path, "utf8"))
    }
  })
})
