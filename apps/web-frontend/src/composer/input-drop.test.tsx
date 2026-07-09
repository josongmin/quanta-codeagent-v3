/**
 * UUX-4-24 — composer image drag-drop rides the SAME attachment path as paste.
 *
 * The InputBar had paste extraction (3-tier WebKit DataTransfer sniffing) but
 * no onDrop. The fix extracts that sniffing into ONE shared pure helper
 * (`extractImageFileFromTransfer`) consumed by BOTH the paste and the drop
 * handlers, and the drop funnels into the same `normalizeFile` →
 * `useImageAttachment.attachFile` path (MIME/size caps enforced uniformly —
 * the validation contract at the top of image-attachment.ts).
 *
 * Node env (no DOM): the extraction takes a structural DataTransfer-like view
 * so a dropped-file payload is simulated with plain objects, and the
 * "attachment added" leg is proven by running the extracted file through the
 * REAL `normalizeFile` (the exact function `attachFile` calls). The InputBar
 * render is pinned via `renderToStaticMarkup` (drop-affordance copy).
 */

import { createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { InputBar } from "../components/InputBar"
import {
  type DataTransferLike,
  extractImageFileFromTransfer,
  normalizeFile,
  resolveComposerDrop,
} from "./image-attachment"

const pngFile = (name = "shot.png"): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" })

const itemOf = (file: File | null, kind: string, type: string) => ({
  kind,
  type,
  getAsFile: () => file,
})

describe("UUX-4-24 — extractImageFileFromTransfer (shared paste/drop sniffing)", () => {
  it("DD-01: file-kind image item wins (tier 1)", () => {
    const file = pngFile()
    const dt: DataTransferLike = {
      items: [itemOf(null, "string", "text/plain"), itemOf(file, "file", "image/png")],
      files: [],
    }
    expect(extractImageFileFromTransfer(dt)).toBe(file)
  })

  it("DD-02: falls back to files[] (tier 2) then any image-typed item (tier 3)", () => {
    const fromFiles = pngFile("files.png")
    expect(extractImageFileFromTransfer({ items: [], files: [fromFiles] })).toBe(fromFiles)
    const fromItem = pngFile("item.png")
    expect(
      extractImageFileFromTransfer({
        items: [itemOf(fromItem, "string", "image/png")],
        files: [],
      }),
    ).toBe(fromItem)
  })

  it("DD-03: non-image payloads (text drags, html) yield null", () => {
    const textFile = new File(["hi"], "note.txt", { type: "text/plain" })
    expect(
      extractImageFileFromTransfer({
        items: [itemOf(textFile, "file", "text/plain")],
        files: [textFile],
      }),
    ).toBe(null)
    expect(extractImageFileFromTransfer(null)).toBe(null)
    expect(extractImageFileFromTransfer({})).toBe(null)
  })
})

describe("UUX-4-24 — dropped file lands in the SAME attachment path as paste", () => {
  it("DD-04: extracted drop file passes the real normalizeFile ⇒ attachment added", async () => {
    const dt: DataTransferLike = {
      items: [itemOf(pngFile("dropped.png"), "file", "image/png")],
      files: [],
    }
    const file = extractImageFileFromTransfer(dt)
    if (file === null) throw new Error("expected a file")
    // The EXACT normalize call `useImageAttachment.attachFile(file, "drop")`
    // performs — proving the drop source is a first-class attachment source.
    const result = await normalizeFile(file, "drop")
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`)
    expect(result.attachment.mediaType).toBe("image/png")
    expect(result.attachment.title).toBe("dropped.png")
    expect(result.attachment.subtitle).toContain("dropped")
  })

  it("DD-05: oversized dropped image is rejected by the same cap as paste", async () => {
    const big = new File([new Uint8Array(1)], "big.png", { type: "image/png" })
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 })
    const result = await normalizeFile(big, "drop")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("too large")
  })

  it("DD-07: drop routing — image ⇒ attach; non-image FILE ⇒ claim+reject (never browser-navigate); text ⇒ ignore", async () => {
    const img = pngFile("route.png")
    expect(resolveComposerDrop({ items: [itemOf(img, "file", "image/png")], files: [] })).toEqual({
      kind: "attach",
      file: img,
    })
    // A non-image FILE must still be CLAIMED: an unhandled file drop makes
    // the browser navigate away from the SPA. It rides the same validator,
    // which produces the honest unsupported-type error.
    const txt = new File(["hi"], "notes.txt", { type: "text/plain" })
    const rejected = resolveComposerDrop({ items: [], files: [txt] })
    expect(rejected).toEqual({ kind: "reject-file", file: txt })
    if (rejected.kind !== "reject-file") throw new Error("unreachable")
    const validated = await normalizeFile(rejected.file, "drop")
    expect(validated.ok).toBe(false)
    if (!validated.ok) expect(validated.error).toContain("unsupported image type")
    // No files at all (text/selection drag) ⇒ leave the browser default.
    expect(resolveComposerDrop({ items: [itemOf(null, "string", "text/plain")] })).toEqual({
      kind: "ignore",
    })
    expect(resolveComposerDrop(null)).toEqual({ kind: "ignore" })
  })

  it("DD-06: the composer advertises drop (footer copy) — affordance is visible", () => {
    const markup = renderToStaticMarkup(
      <InputBar
        value=""
        disabled={false}
        inputRef={createRef<HTMLTextAreaElement>()}
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        attachmentError={null}
        onAttachImageFile={() => {}}
        onRemovePendingImage={() => {}}
        onClearAllPendingImages={() => {}}
      />,
    )
    expect(markup.toLowerCase()).toContain("drop")
  })
})
