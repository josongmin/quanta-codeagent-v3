import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pdfReadTool, sniffPdfMagic } from "@/tool/document/pdf-read"
import type { ToolContext, ToolResult } from "@/tool"

const tool = pdfReadTool

const mkTmp = async (): Promise<string> => {
  const dir = path.join(tmpdir(), `quanta-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const exec = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let last: ToolResult | null = null
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") last = ev.result
  }
  if (last === null) throw new Error("no result")
  return last
}

// Minimal valid PDF (1-page, ~250 bytes). Verified opens in Preview.
const minimalPdfBytes = (): Uint8Array => {
  const header = "%PDF-1.4\n%\xff\xff\xff\xff\n"
  const body =
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
  const trailer = "xref\n0 4\n0000000000 65535 f\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n200\n%%EOF\n"
  return new TextEncoder().encode(header + body + trailer)
}

describe("pdf_read — metadata", () => {
  test("HELL-1: name", () => expect(tool.name).toBe("pdf_read"))
  test("HELL-2: isReadOnly", () => expect(tool.isReadOnly?.()).toBe(true))
  test("HELL-3: isConcurrencySafe", () =>
    expect(tool.isConcurrencySafe?.({ path: "x.pdf" } as never)).toBe(true))
})

describe("pdf_read — magic-byte sniff (pure)", () => {
  test("HELL-4: valid PDF magic → true", () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
    expect(sniffPdfMagic(buf)).toBe(true)
  })
  test("HELL-5: PNG magic → false", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    expect(sniffPdfMagic(buf)).toBe(false)
  })
  test("HELL-6: empty bytes → false", () => {
    expect(sniffPdfMagic(new Uint8Array(0))).toBe(false)
  })
})

describe("pdf_read — happy path", () => {
  test("HELL-7: minimal valid PDF → ok:true with DocumentBlock", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(path.join(dir, "ok.pdf"), minimalPdfBytes())
      const r = await exec({ path: "ok.pdf" }, dir)
      expect(r.ok).toBe(true)
      expect(r.output).toContain("Read PDF")
      expect(r.documents).toBeDefined()
      expect(r.documents).toHaveLength(1)
      expect(r.documents?.[0]?.mediaType).toBe("application/pdf")
      expect(typeof r.documents?.[0]?.data).toBe("string")
      expect(r.documents?.[0]?.data.length).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("pdf_read — guards", () => {
  test("HELL-8: non-PDF (PNG bytes in .pdf file) → ok:false magic-byte mismatch", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(path.join(dir, "fake.pdf"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
      const r = await exec({ path: "fake.pdf" }, dir)
      expect(r.ok).toBe(false)
      expect(r.output.toLowerCase()).toContain("magic-byte")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-9: '..' traversal rejected", async () => {
    const dir = await mkTmp()
    try {
      const r = await exec({ path: "../escape.pdf" }, dir)
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("permission_denied")
      expect(r.failure?.isReadonly).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-10: leaf symlink rejected", async () => {
    const dir = await mkTmp()
    try {
      const target = path.join(dir, "t.pdf")
      await writeFile(target, minimalPdfBytes())
      const link = path.join(dir, "link.pdf")
      await symlink(target, link)
      const r = await exec({ path: "link.pdf" }, dir)
      expect(r.ok).toBe(false)
      expect(r.output.toLowerCase()).toMatch(/symlink/)
      expect(r.failure?.mode).toBe("permission_denied")
      expect(r.failure?.isReadonly).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-11: missing file → ok:false; no DocumentBlock", async () => {
    const dir = await mkTmp()
    try {
      const r = await exec({ path: "nope.pdf" }, dir)
      expect(r.ok).toBe(false)
      expect(r.documents).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
