/**
 * HELLGATE — #18 (jun-11) clipboard IMAGE paste.
 *
 * Before: `/paste` could only COUNT an image on the clipboard and refuse it
 * ("save to disk then /image add"). Now it DECODES the bytes and attaches them to
 * the next turn via the image queue (the SAME queue `/image add` feeds).
 *
 * Coverage:
 *   - `imageBlockFromBytes` — real PNG bytes → a correct base64 ImageBlock;
 *     round-trips; enforces the media-type allowlist and the 20 MB cap at its
 *     EXACT boundary (NO-SILENT-CAP).
 *   - `parseOsascriptPngfHex` — decodes the `«data PNGf…»` literal osascript
 *     prints; rejects garbage / odd-length / non-PNG hex (paired control).
 *   - `/paste` REAL-EFFECT + FRESH-READBACK — an image clipboard with the queue
 *     wired ENQUEUES (drain returns the block whose base64 decodes to the exact
 *     bytes); PAIRED with the no-queue degrade + the over-cap refusal.
 *   - WIRING-PROOF — `projectSlashCtx` (the seam between the surface ctx and the
 *     contract ctx `/paste` reads) actually carries `imageQueue`.
 *   - Platform reader is exercised by a VISIBLE skipIf smoke test on darwin.
 */

import { describe, expect, test } from "bun:test"
import {
  imageBlockFromBytes,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
} from "../../../src/apps/cli/image-loader"
import { createImageQueue } from "../../../src/apps/cli/image-queue"
import {
  __test,
  type BinarySpawn,
  type ClipboardReader,
  defaultClipboardReader,
  pasteCmd,
  tryImageProbe,
} from "../../../src/apps/cli/paste-cmd"
import { projectSlashCtx } from "../../../src/apps/cli/repl/slash-surface"

// A real, minimal 1×1 transparent PNG (starts with the 0x89 'PNG' signature).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

const fakeReader =
  (content: Awaited<ReturnType<ClipboardReader>>): ClipboardReader =>
  async () =>
    content

describe("#18 imageBlockFromBytes — bytes → ImageBlock", () => {
  test("real PNG bytes → a base64 block that round-trips to the EXACT bytes", () => {
    const block = imageBlockFromBytes(PNG_1X1, "image/png")
    expect(block.type).toBe("image")
    expect(block.mediaType).toBe("image/png")
    // REAL-EFFECT: decode the produced base64 back — it must equal the input bytes.
    expect(Buffer.from(block.data, "base64").equals(PNG_1X1)).toBe(true)
  })

  test("every supported media type is accepted; an unsupported one throws", () => {
    for (const mt of SUPPORTED_IMAGE_MEDIA_TYPES) {
      expect(imageBlockFromBytes(PNG_1X1, mt).mediaType).toBe(mt)
    }
    expect(() => imageBlockFromBytes(PNG_1X1, "image/tiff")).toThrow(/unsupported media type/)
  })

  test("empty buffer is rejected (a failed clipboard read makes 0 bytes)", () => {
    expect(() => imageBlockFromBytes(Buffer.alloc(0), "image/png")).toThrow(/empty/)
  })

  test("the 20 MB cap holds at its EXACT boundary (NO-SILENT-CAP)", () => {
    // At the cap: accepted. one byte over: rejected.
    const atCap = Buffer.alloc(MAX_IMAGE_BYTES, 0x89)
    expect(imageBlockFromBytes(atCap, "image/png").type).toBe("image")
    const overCap = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89)
    expect(() => imageBlockFromBytes(overCap, "image/png")).toThrow(/max 20MB/)
  })
})

describe("#18 parseOsascriptPngfHex — decode the «data PNGf…» literal", () => {
  test("a real PNGf hex literal decodes to the exact PNG bytes", () => {
    const literal = `«data PNGf${PNG_1X1.toString("hex").toUpperCase()}»`
    const out = __test.parseOsascriptPngfHex(literal)
    expect(out).not.toBeNull()
    expect((out as Buffer).equals(PNG_1X1)).toBe(true)
  })

  test("non-PNGf garbage ⇒ null (paired control)", () => {
    expect(__test.parseOsascriptPngfHex("hello clipboard text")).toBeNull()
    expect(__test.parseOsascriptPngfHex("«data RTF 4869»")).toBeNull()
  })

  test("odd-length hex ⇒ null (cannot byte-decode)", () => {
    expect(__test.parseOsascriptPngfHex("«data PNGf89504E4»")).toBeNull()
  })

  test("valid hex that is NOT a PNG ⇒ null (magic check rejects a masquerade)", () => {
    // 8 bytes of zeros — decodes fine, but no PNG signature.
    expect(__test.parseOsascriptPngfHex("«data PNGf0000000000000000»")).toBeNull()
  })

  test("looksLikePng is true only for the real signature", () => {
    expect(__test.looksLikePng(PNG_1X1)).toBe(true)
    expect(__test.looksLikePng(Buffer.from("not a png"))).toBe(false)
  })
})

describe("#18 /paste — clipboard image enqueues to the image queue", () => {
  test("image + queue wired ⇒ ENQUEUED; drain returns a block decoding to the bytes (fresh-readback)", async () => {
    const io = collectOut()
    const queue = createImageQueue()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "image", bytes: PNG_1X1, mediaType: "image/png" }),
      imageQueue: queue,
    })
    expect(code).toBe(0)
    // FRESH-READBACK: read the queue through its real accessor, not the local var.
    expect(queue.size()).toBe(1)
    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.path).toBe("clipboard")
    expect(drained[0]?.block.mediaType).toBe("image/png")
    expect(Buffer.from(drained[0]?.block.data ?? "", "base64").equals(PNG_1X1)).toBe(true)
    expect(io.out.join("")).toContain("queued clipboard image")
  })

  test("PAIRED: image + NO queue ⇒ NOT enqueued, hint + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "image", bytes: PNG_1X1, mediaType: "image/png" }),
      // imageQueue deliberately absent
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("/image add")
  })

  test("queue already at cap ⇒ image paste refused (exit 1, 'queue full'), queue unchanged", async () => {
    const queue = createImageQueue({ maxSize: 1 })
    queue.add({ path: "pre", block: { type: "image", data: "AA==", mediaType: "image/png" } })
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "image", bytes: PNG_1X1, mediaType: "image/png" }),
      imageQueue: queue,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("queue full")
    expect(queue.size()).toBe(1) // the pre-existing entry, no clipboard image added
  })

  test("unsupported media type from the reader ⇒ caught, exit 1 (no crash)", async () => {
    const queue = createImageQueue()
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "image", bytes: PNG_1X1, mediaType: "image/bmp" }),
      imageQueue: queue,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unsupported media type")
    expect(queue.size()).toBe(0)
  })
})

describe("#18 WIRING-PROOF — the contract projector carries imageQueue", () => {
  test("projectSlashCtx forwards imageQueue (present) / omits it (absent)", () => {
    const queue = createImageQueue()
    // The seam `/paste` reads: a ReplSlashCtx with imageQueue must project it onto
    // the contract ctx. (Partial cast — projectSlashCtx is a presence-gated spread.)
    const withQ = projectSlashCtx({ imageQueue: queue } as never)
    expect(withQ.imageQueue).toBe(queue)
    const withoutQ = projectSlashCtx({} as never)
    expect("imageQueue" in withoutQ).toBe(false)
  })
})

// A fake binary spawn so the Linux/Windows image-probe branch is deterministic
// without a real clipboard tool. Defaults to a successful empty result; override
// any field per case.
const fakeSpawn = (
  over: Partial<{ code: number; stdout: Buffer; stderr: string; spawnError: string | null }>,
) =>
  (async () => ({
    code: 0,
    stdout: Buffer.alloc(0),
    stderr: "",
    spawnError: null,
    ...over,
  })) as BinarySpawn

describe("#18 tryImageProbe — binary image probe classification (injected spawn)", () => {
  test("code 0 + real PNG bytes ⇒ image content with those exact bytes", async () => {
    const res = await tryImageProbe(fakeSpawn({ stdout: PNG_1X1 }), "tool", [])
    expect(res).not.toBeNull()
    expect(res?.kind).toBe("image")
    expect(res?.mediaType).toBe("image/png")
    expect((res?.bytes as Buffer).equals(PNG_1X1)).toBe(true)
  })

  test("PAIRED: non-PNG stdout ⇒ null (a tool printing an error can't masquerade)", async () => {
    const res = await tryImageProbe(
      fakeSpawn({ stdout: Buffer.from("usage: xclip ...") }),
      "tool",
      [],
    )
    expect(res).toBeNull()
  })

  test("non-zero exit ⇒ null (fall through to text)", async () => {
    const res = await tryImageProbe(fakeSpawn({ code: 1, stdout: PNG_1X1 }), "tool", [])
    expect(res).toBeNull()
  })

  test("spawnError (tool absent) ⇒ null", async () => {
    const res = await tryImageProbe(
      fakeSpawn({ spawnError: "ENOENT", stdout: PNG_1X1 }),
      "tool",
      [],
    )
    expect(res).toBeNull()
  })

  test("empty stdout (no image on clipboard) ⇒ null", async () => {
    const res = await tryImageProbe(fakeSpawn({ stdout: Buffer.alloc(0) }), "tool", [])
    expect(res).toBeNull()
  })
})

describe("#18 Windows image paste — probe → /paste enqueue (end-to-end via injected spawn)", () => {
  test("a Windows-style PNG probe flows through /paste into the image queue", async () => {
    // Reader built exactly like readWindows' image branch, but with a fake spawn
    // standing in for `powershell.exe` (unavailable off-Windows). Proves the
    // Windows path's image bytes reach the next turn's image queue.
    const winReader: ClipboardReader = async () =>
      (await tryImageProbe(fakeSpawn({ stdout: PNG_1X1 }), "powershell.exe", [])) ?? {
        kind: "empty",
      }
    const queue = createImageQueue()
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: winReader,
      imageQueue: queue,
    })
    expect(code).toBe(0)
    expect(queue.size()).toBe(1)
    const drained = queue.drain()
    expect(Buffer.from(drained[0]?.block.data ?? "", "base64").equals(PNG_1X1)).toBe(true)
  })

  test("the PowerShell command emits raw PNG to stdout (regression guard, not text/CRLF)", () => {
    const cmd = __test.WINDOWS_CLIPBOARD_IMAGE_PS1
    // The load-bearing pieces: read the clipboard IMAGE, save as PNG, write the
    // RAW bytes to the standard-output handle (never Get-Clipboard text).
    expect(cmd).toContain("Clipboard]::GetImage()")
    expect(cmd).toContain("ImageFormat]::Png")
    // It must actually WRITE the PNG bytes to the raw stdout handle — not merely
    // open it. (A regression to `Get-Clipboard` text would keep the handle but
    // drop the byte write; this pins the emit.)
    expect(cmd).toContain("OpenStandardOutput()")
    expect(cmd).toMatch(/\$out\.Write\(\$bytes,\s*0,\s*\$bytes\.Length\)/)
  })
})

describe("#18 platform reader smoke (darwin only — VISIBLE skip elsewhere)", () => {
  test.skipIf(process.platform !== "darwin")(
    "defaultClipboardReader returns a valid typed result without throwing",
    async () => {
      const res = await defaultClipboardReader()
      // Whatever is actually on the dev clipboard, the reader must yield a typed
      // discriminant (never throw, never a half-built value).
      expect(["text", "image", "empty", "no_backend", "error"]).toContain(res.kind)
      if (res.kind === "image") {
        expect(Buffer.isBuffer(res.bytes)).toBe(true)
        expect(res.mediaType).toBe("image/png")
      }
    },
  )

  // LIVE Windows e2e — runs ONLY on a real win32 host (powershell available).
  // Elsewhere it is a VISIBLE skip (never a silent pass). Drives the REAL reader:
  // whatever is on the clipboard, it must return a typed discriminant, and an
  // image must carry decoded PNG bytes.
  test.skipIf(process.platform !== "win32")(
    "defaultClipboardReader (win32) returns a valid typed result; image ⇒ real PNG bytes",
    async () => {
      const res = await defaultClipboardReader()
      expect(["text", "image", "empty", "no_backend", "error"]).toContain(res.kind)
      if (res.kind === "image") {
        expect(Buffer.isBuffer(res.bytes)).toBe(true)
        expect(__test.looksLikePng(res.bytes)).toBe(true)
        expect(res.mediaType).toBe("image/png")
      }
    },
  )
})
