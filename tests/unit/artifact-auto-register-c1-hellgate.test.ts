// Hellgate — C1 Canvas auto-register loop (jun-05 §7).
//
// The generation tools (`image_gen`, `xlsx_write` / `docx_write` / `pptx_write`)
// AUTO-REGISTER the file they produce into the session artifact registry, so
// `artifact_list` / `artifact_get` surface generated outputs and downstream
// tools can reference them by id.
//
// Seals (fake/real ArtifactRegistryPort injected — NO real network):
//   A. image_gen writes the PNG AND registers it (kind:image + image mime +
//      jailed abs path); the minted id appears in the tool output.
//   B. xlsx_write writes the .xlsx AND registers it (kind:spreadsheet + the
//      OOXML media type); driven through the REAL registry, `artifact_list`
//      then shows it.
//   C. docx_write / pptx_write register kind:document / kind:presentation with
//      their OOXML media types.
//   D. A `register()` that THROWS does NOT break the write — result is still
//      ok:true (best-effort side-channel).
//   E. Port ABSENT ⇒ NO register call AND byte-identical output to the
//      historical const tool (no extra line).
//
// All provider + write I/O for image_gen is injected; the authoring tools write
// real bytes to a tmp jail (then we inspect the registry, not the file).

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Artifact, createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import type { ArtifactRegistryPort, ArtifactSpecInput, ArtifactView } from "@/tool"
import {
  docxWriteTool,
  makeDocxWriteTool,
  makePptxWriteTool,
  makeXlsxWriteTool,
  OOXML_MEDIA_TYPES,
  pptxWriteTool,
  xlsxWriteTool,
} from "@/tool"
import {
  type GeneratedImage,
  type ImageGenOutcome,
  type ImageGenPort,
  type ImageGenRequest,
  type ImageWritePort,
  imageGenTool,
} from "@/tool/image-gen"
import type { ToolContext, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                            */
/* ------------------------------------------------------------------ */

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const runTool = async (
  tool: {
    execute: (
      input: never,
      ctx: ToolContext,
    ) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result" && ev.result) last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result")
  return last
}

/** Recording fake port (structurally an ArtifactRegistryPort). */
class RecordingRegistry implements ArtifactRegistryPort {
  readonly registered: ArtifactSpecInput[] = []
  private n = 0
  private readonly store = new Map<string, ArtifactView>()
  register(spec: ArtifactSpecInput): ArtifactView {
    this.registered.push(spec)
    this.n += 1
    const view: ArtifactView = {
      id: `fake-${this.n}`,
      kind: spec.kind,
      path: spec.path,
      mediaType: spec.mediaType,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      createdAt: this.n,
    }
    this.store.set(view.id, view)
    return view
  }
  get(id: string): ArtifactView | undefined {
    return this.store.get(id)
  }
  list(): readonly ArtifactView[] {
    return [...this.store.values()]
  }
  destroy(id: string): boolean {
    return this.store.delete(id)
  }
}

/** A registry whose register() THROWS — proves best-effort failure handling. */
const throwingRegistry: ArtifactRegistryPort = {
  register(): ArtifactView {
    throw new Error("boom: registry rejected the spec")
  },
  get: () => undefined,
  list: () => [],
  destroy: () => false,
}

/* image_gen fakes ------------------------------------------------- */

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const pngImage: GeneratedImage = {
  b64: Buffer.from(PNG_1x1).toString("base64"),
  mediaType: "image/png",
}

class MemWritePort implements ImageWritePort {
  readonly files = new Map<string, Uint8Array>()
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }
}

const okPort = (images: readonly GeneratedImage[]): ImageGenPort => ({
  async generate(_req: ImageGenRequest): Promise<ImageGenOutcome> {
    return { kind: "ok", images }
  },
})

const tmp = (): string => mkdtempSync(join(tmpdir(), "c1-auto-reg-"))

/* ------------------------------------------------------------------ */
/* A — image_gen registers the image                                  */
/* ------------------------------------------------------------------ */

describe("C1 auto-register — image_gen", () => {
  test("writes the PNG AND registers kind:image with the image mime + abs path", async () => {
    const registry = new RecordingRegistry()
    const writePort = new MemWritePort()
    const cwd = tmp()
    const tool = imageGenTool({ port: okPort([pngImage]), writePort, artifactRegistry: registry })

    const res = await runTool(tool, { prompt: "a cat", outputPath: "out/cat.png" }, ctx(cwd))

    expect(res.ok).toBe(true)
    // file written
    expect(writePort.files.size).toBe(1)
    const writtenPath = [...writePort.files.keys()][0] as string
    // artifact registered with the image's mediaType + the SAME abs path written
    expect(registry.registered).toHaveLength(1)
    const spec = registry.registered[0] as ArtifactSpecInput
    expect(spec.kind).toBe("image")
    expect(spec.mediaType).toBe("image/png")
    expect(spec.path).toBe(writtenPath)
    // minted id surfaced in the output (additive line)
    expect(registry.list()).toHaveLength(1)
    const id = (registry.list()[0] as ArtifactView).id
    expect(res.output).toContain(id)
    expect(res.output).toContain("Registered artifact")
  })

  test("n>1 registers every written sibling", async () => {
    const registry = new RecordingRegistry()
    const writePort = new MemWritePort()
    const tool = imageGenTool({
      port: okPort([pngImage, pngImage]),
      writePort,
      artifactRegistry: registry,
    })
    const res = await runTool(tool, { prompt: "x", outputPath: "a.png", n: 2 }, ctx(tmp()))
    expect(res.ok).toBe(true)
    expect(writePort.files.size).toBe(2)
    expect(registry.registered).toHaveLength(2)
    expect(registry.registered.every((s) => s.kind === "image")).toBe(true)
  })

  test("heterogeneous batch registers EACH image with ITS OWN provider mediaType", async () => {
    // A provider may legitimately return mixed formats in one batch. The artifact
    // mediaType MUST reflect the per-image bytes, not be flattened to image[0]'s.
    const jpegImage: GeneratedImage = {
      b64: Buffer.from(PNG_1x1).toString("base64"),
      mediaType: "image/jpeg",
    }
    const registry = new RecordingRegistry()
    const writePort = new MemWritePort()
    const tool = imageGenTool({
      port: okPort([pngImage, jpegImage]),
      writePort,
      artifactRegistry: registry,
    })
    const res = await runTool(tool, { prompt: "x", outputPath: "m.png", n: 2 }, ctx(tmp()))
    expect(res.ok).toBe(true)
    expect(registry.registered).toHaveLength(2)
    expect(registry.registered[0]?.mediaType).toBe("image/png")
    expect(registry.registered[1]?.mediaType).toBe("image/jpeg")
  })
})

/* ------------------------------------------------------------------ */
/* B — xlsx_write registers + artifact_list (real registry) shows it  */
/* ------------------------------------------------------------------ */

describe("C1 auto-register — xlsx_write through the REAL registry", () => {
  test("writes the .xlsx AND registers kind:spreadsheet; artifact_list shows it", async () => {
    let clock = 0
    const real = createArtifactRegistry({
      now: () => (clock += 1),
      idFactory: monotonicIdFactory(),
    })
    const tool = makeXlsxWriteTool({ artifactRegistry: real })
    const res = await runTool(
      tool,
      { path: "report.xlsx", sheets: [{ name: "S1", rows: [["a", 1]] }] },
      ctx(tmp()),
    )
    expect(res.ok).toBe(true)
    const all = real.list()
    expect(all).toHaveLength(1)
    const a = all[0] as Artifact
    expect(a.kind).toBe("spreadsheet")
    expect(a.mediaType).toBe(OOXML_MEDIA_TYPES.xlsx)
    expect(a.path.endsWith("report.xlsx")).toBe(true)
    expect(res.output).toContain(a.id)
  })
})

/* ------------------------------------------------------------------ */
/* C — docx / pptx kind + media-type mapping                          */
/* ------------------------------------------------------------------ */

describe("C1 auto-register — docx_write / pptx_write", () => {
  test("docx_write registers kind:document with the WordprocessingML media type", async () => {
    const registry = new RecordingRegistry()
    const tool = makeDocxWriteTool({ artifactRegistry: registry })
    const res = await runTool(
      tool,
      { path: "doc.docx", paragraphs: [{ kind: "heading", level: 1, text: "Hi" }] },
      ctx(tmp()),
    )
    expect(res.ok).toBe(true)
    const spec = registry.registered[0] as ArtifactSpecInput
    expect(spec.kind).toBe("document")
    expect(spec.mediaType).toBe(OOXML_MEDIA_TYPES.docx)
  })

  test("pptx_write registers kind:presentation with the PresentationML media type", async () => {
    const registry = new RecordingRegistry()
    const tool = makePptxWriteTool({ artifactRegistry: registry })
    const res = await runTool(
      tool,
      { path: "deck.pptx", slides: [{ title: "T", body: ["b"] }] },
      ctx(tmp()),
    )
    expect(res.ok).toBe(true)
    const spec = registry.registered[0] as ArtifactSpecInput
    expect(spec.kind).toBe("presentation")
    expect(spec.mediaType).toBe(OOXML_MEDIA_TYPES.pptx)
  })
})

/* ------------------------------------------------------------------ */
/* D — a throwing register() never breaks the write                   */
/* ------------------------------------------------------------------ */

describe("C1 auto-register — best-effort (throwing registry)", () => {
  test("image_gen: throwing registry → write still ok:true, no register line", async () => {
    const writePort = new MemWritePort()
    const tool = imageGenTool({
      port: okPort([pngImage]),
      writePort,
      artifactRegistry: throwingRegistry,
    })
    const res = await runTool(tool, { prompt: "x", outputPath: "y.png" }, ctx(tmp()))
    expect(res.ok).toBe(true)
    expect(writePort.files.size).toBe(1)
    expect(res.output).not.toContain("Registered artifact")
  })

  test("xlsx_write: throwing registry → write still ok:true, no register line", async () => {
    const tool = makeXlsxWriteTool({ artifactRegistry: throwingRegistry })
    const res = await runTool(
      tool,
      { path: "r.xlsx", sheets: [{ name: "S", rows: [["a"]] }] },
      ctx(tmp()),
    )
    expect(res.ok).toBe(true)
    expect(res.output).not.toContain("Registered artifact")
  })
})

/* ------------------------------------------------------------------ */
/* E — port ABSENT ⇒ no register + byte-identical output              */
/* ------------------------------------------------------------------ */

describe("C1 auto-register — default-OFF byte-identity (no registry port)", () => {
  test("image_gen: no registry ⇒ output has no register line", async () => {
    const writePort = new MemWritePort()
    const tool = imageGenTool({ port: okPort([pngImage]), writePort })
    const res = await runTool(tool, { prompt: "x", outputPath: "z.png" }, ctx(tmp()))
    expect(res.ok).toBe(true)
    expect(res.output).not.toContain("Registered artifact")
    expect(res.output.startsWith("Wrote image to ")).toBe(true)
  })

  test("xlsx_write: const tool === makeXlsxWriteTool() output (byte-identical)", async () => {
    // Same input, same cwd → the const tool and the no-registry factory tool must
    // produce IDENTICAL output strings (no extra line, no register call).
    const cwd = tmp()
    const input = { path: "ident.xlsx", sheets: [{ name: "S", rows: [["a", 1]] }] }
    const fromConst = await runTool(xlsxWriteTool, input, ctx(cwd))
    const fromFactory = await runTool(
      makeXlsxWriteTool(),
      { ...input, path: "ident2.xlsx" },
      ctx(cwd),
    )
    expect(fromConst.ok).toBe(true)
    expect(fromConst.output).not.toContain("Registered artifact")
    // Normalize the filename so the comparison is purely about shape/extra lines.
    const norm = (s: string): string => s.replace(/ident2?\.xlsx/g, "F.xlsx")
    expect(norm(fromConst.output)).toBe(norm(fromFactory.output))
  })

  test("docx_write / pptx_write const tools emit no register line", async () => {
    const cwd = tmp()
    const d = await runTool(
      docxWriteTool,
      { path: "d.docx", paragraphs: [{ kind: "heading", level: 1, text: "H" }] },
      ctx(cwd),
    )
    const p = await runTool(pptxWriteTool, { path: "p.pptx", slides: [{ title: "T" }] }, ctx(cwd))
    expect(d.output).not.toContain("Registered artifact")
    expect(p.output).not.toContain("Registered artifact")
  })
})
