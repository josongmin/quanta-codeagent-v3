/**
 * DATA-INTEGRITY HELLGATE (jul-27, stream-surface audit F1): `sanitizeLogText`
 * used a `[\ud800-\udfff]` char-class that stripped BOTH halves of every VALID
 * surrogate pair — destroying all astral characters (emoji, CJK-Ext-B, math
 * alphanumerics), not just the lone/unpaired surrogates it intended. Blast radius
 * was every consumer (logger, all stdout renderers, the peer-message body). It
 * silently contradicted the project's own `sliceWholeChars`/surrogate-truncation
 * defense that exists to PRESERVE these characters at cap boundaries.
 *
 * FIX: split surrogate handling into LONE_SURROGATE_RE (lookaround: unpaired
 * halves only), leaving valid pairs intact. The control/ANSI/bidi/ZW stripping is
 * unchanged — terminal-injection defense is not weakened.
 *
 * RED-first: revert to `[\ud800-\udfff]` in BIDI_ZW_RE (drop LONE_SURROGATE_RE) ⇒
 * the "emoji preserved" assertions go RED (emoji becomes "").
 */
import { describe, expect, test } from "bun:test"
import { sanitizeLogText } from "@/shared"

describe("sanitizeLogText — valid astral chars survive; only LONE surrogates stripped", () => {
  test("emoji (astral) is preserved", () => {
    expect(sanitizeLogText("deploy 🚀 done ✅")).toBe("deploy 🚀 done ✅")
    expect(sanitizeLogText("💩💩💩")).toBe("💩💩💩")
  })

  test("CJK Extension-B (astral) is preserved", () => {
    // 𠮷 = U+20BB7 (surrogate pair D842 DFB7)
    expect(sanitizeLogText("author 𠮷 ok")).toBe("author 𠮷 ok")
  })

  test("BMP text (CJK/accents) still preserved", () => {
    expect(sanitizeLogText("中文 éü")).toBe("中文 éü")
  })

  test("a LONE high surrogate is stripped (corruption removed)", () => {
    const lone = `x${String.fromCharCode(0xd83d)}y` // high surrogate, no low
    expect(sanitizeLogText(lone)).toBe("xy")
  })

  test("a LONE low surrogate is stripped", () => {
    const lone = `x${String.fromCharCode(0xdc00)}y` // low surrogate, no high
    expect(sanitizeLogText(lone)).toBe("xy")
  })

  test("a valid pair adjacent to a lone surrogate: pair kept, lone dropped", () => {
    const s = `🚀${String.fromCharCode(0xd83d)}ok`
    expect(sanitizeLogText(s)).toBe("🚀ok")
  })

  // paired control: the injection defense is NOT weakened by the astral fix
  test("control/ANSI/bidi still stripped (defense intact)", () => {
    expect(sanitizeLogText("a\x1b[2Jb")).not.toContain("\x1b")
    expect(sanitizeLogText("a\x1b]0;title\x07b")).not.toContain("\x1b")
    expect(sanitizeLogText("a‮b")).toBe("ab") // RLO bidi
    expect(sanitizeLogText("a​b")).toBe("ab") // zero-width
    expect(sanitizeLogText("a\nb")).toBe("a?b") // C0 → ?
  })
})
