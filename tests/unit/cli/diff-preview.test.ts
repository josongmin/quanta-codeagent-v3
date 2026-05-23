import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  diffPreviewEnabled,
  renderActionDiff,
  renderUnified,
  resolveEnvCaps,
} from "../../../src/apps/cli/diff-preview"
import type { ToolAction } from "../../../src/permission"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

/**
 * Tests for the inline confirm-prompt diff preview.
 *
 * Strategy:
 *   - Pin colour mode ON for the suite so ANSI escapes are deterministic,
 *     then `stripAnsi` for content assertions (mirrors the auth-ui test
 *     pattern in tests/unit/ui).
 *   - File reads are injected via `opts.readFile` so the suite never
 *     touches the real filesystem — covers the "missing file" path
 *     without race-prone tempdir mgmt.
 *
 * Coverage matrix matches the four supported tools (write/edit/apply_patch/
 * scripted_replace) plus the graceful-fallback paths (missing input keys,
 * binary content, oversize, read-failure, unsupported tool, ENV knobs).
 */

const action = (tool: string, input: unknown): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
  shellCommand: null,
})

/** Assert the preview rendered + return the string. Avoids the forbidden
 *  `noNonNullAssertion` warning every `stripAnsi(out!)` callsite would
 *  trigger; codebase convention prefers a narrowing helper. */
const mustRender = (out: string | undefined): string => {
  expect(out).toBeDefined()
  if (out === undefined) throw new Error("unreachable: previous expect guards")
  return out
}

beforeEach(() => {
  setColorPolicy("on") // force ANSI so escape assertions are deterministic
})

afterEach(() => {
  setColorPolicy(null)
  delete process.env.QUANTA_DIFF_PREVIEW
  delete process.env.QUANTA_DIFF_MAX_BYTES
  delete process.env.QUANTA_DIFF_MAX_LINES
})

describe("renderActionDiff — write", () => {
  test("new file (read miss) renders + lines with 'new file' note", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/new.ts", content: "line A\nline B" }),
      {
        readFile: async () => {
          throw new Error("ENOENT")
        },
      },
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("/x/new.ts")
    expect(plain).toContain("(new file)")
    expect(plain).toContain("+ line A")
    expect(plain).toContain("+ line B")
  })

  test("existing file → diff with + and - lines", async () => {
    const out = await renderActionDiff(action("write", { path: "/x/f.ts", content: "kept\nNEW" }), {
      readFile: async () => "kept\nOLD",
    })
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("- OLD")
    expect(plain).toContain("+ NEW")
    expect(plain).toContain("  kept")
  })

  test("contains ANSI escapes when colour ON", async () => {
    const out = await renderActionDiff(action("write", { path: "/x/f.ts", content: "B" }), {
      readFile: async () => "A",
    })
    const rendered = mustRender(out)
    // ESC byte present somewhere in the rendered output.
    expect(rendered.includes(String.fromCharCode(27))).toBe(true)
  })
})

describe("renderActionDiff — edit", () => {
  test("renders fragment swap (- old / + new) without touching fs", async () => {
    const out = await renderActionDiff(
      action("edit", { path: "/x/e.ts", old_string: "foo\nbar", new_string: "baz" }),
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("/x/e.ts")
    expect(plain).toContain("- foo")
    expect(plain).toContain("- bar")
    expect(plain).toContain("+ baz")
  })

  test("missing required keys → undefined (graceful)", async () => {
    const out = await renderActionDiff(action("edit", { path: "/x/e.ts" }))
    expect(out).toBeUndefined()
  })
})

describe("renderActionDiff — apply_patch", () => {
  test("passthrough V4A patch with +/- colourisation", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /x/f.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const out = await renderActionDiff(action("apply_patch", { patch }))
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("*** Begin Patch")
    expect(plain).toContain("*** Update File: /x/f.ts")
    expect(plain).toContain("-old")
    expect(plain).toContain("+new")
  })
})

describe("renderActionDiff — scripted_replace", () => {
  test("preview applies literal substitution against existing file", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", { file: "/x/s.ts", pattern: "foo", replacement: "FOO" }),
      { readFile: async () => "a foo b\nfoo line" },
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("- a foo b")
    expect(plain).toContain("+ a FOO b")
  })

  test("invalid regex → graceful 'invalid regex' notice", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", {
        file: "/x/s.ts",
        pattern: "([",
        replacement: "X",
        isRegex: true,
      }),
      { readFile: async () => "anything" },
    )
    expect(stripAnsi(mustRender(out))).toContain("[invalid regex; preview skipped]")
  })

  test("missing file → graceful 'file not found' notice", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", { file: "/x/s.ts", pattern: "foo", replacement: "bar" }),
      {
        readFile: async () => {
          throw new Error("ENOENT")
        },
      },
    )
    expect(stripAnsi(mustRender(out))).toContain("[file not found; preview skipped]")
  })
})

describe("renderActionDiff — fallback / caps", () => {
  test("unknown tool → undefined", async () => {
    const out = await renderActionDiff(action("bash", { command: "ls" }))
    expect(out).toBeUndefined()
  })

  test("write of binary content (NUL byte) → preview skipped", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/bin", content: `head${String.fromCharCode(0)}tail` }),
      { readFile: async () => "" },
    )
    expect(stripAnsi(mustRender(out))).toContain("too large or binary")
  })

  test("oversize content (> maxBytes) → preview skipped", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/big", content: "x".repeat(2000) }),
      { readFile: async () => "", maxBytes: 100 },
    )
    expect(stripAnsi(mustRender(out))).toContain("too large or binary")
  })

  test("diff clipped at maxLines with '… N more' suffix", async () => {
    const before = ""
    const after = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const out = await renderActionDiff(action("write", { path: "/x/f", content: after }), {
      readFile: async () => before,
      maxLines: 10,
    })
    const plain = stripAnsi(mustRender(out))
    expect(plain).toMatch(/… \(\d+ more lines?\)/)
    // 10 visible diff lines + 1 header line + 1 clip line = 12 newlines (11 \n).
    expect(plain.split("\n").length).toBe(12)
  })
})

describe("renderUnified — direct LCS coverage", () => {
  test("empty → empty produces empty body", () => {
    expect(renderUnified("", "", 100)).toBe("")
  })

  test("keep lines rendered with two-space prefix", () => {
    const out = stripAnsi(renderUnified("same", "same", 100))
    expect(out).toBe("  same")
  })

  test("interleaved keep / del / add ordering", () => {
    const out = stripAnsi(renderUnified("a\nb\nc", "a\nB\nc", 100))
    expect(out.split("\n")).toEqual(["  a", "- b", "+ B", "  c"])
  })
})

describe("ENV knobs", () => {
  test("diffPreviewEnabled: explicit '0' disables even on TTY", () => {
    process.env.QUANTA_DIFF_PREVIEW = "0"
    expect(diffPreviewEnabled()).toBe(false)
  })

  test("diffPreviewEnabled: explicit '1' enables even off TTY", () => {
    process.env.QUANTA_DIFF_PREVIEW = "1"
    expect(diffPreviewEnabled()).toBe(true)
  })

  test("resolveEnvCaps reads QUANTA_DIFF_MAX_BYTES / _LINES at call time", () => {
    process.env.QUANTA_DIFF_MAX_BYTES = "1234"
    process.env.QUANTA_DIFF_MAX_LINES = "7"
    expect(resolveEnvCaps()).toEqual({ maxBytes: 1234, maxLines: 7 })
  })

  test("resolveEnvCaps falls back to defaults for invalid values", () => {
    process.env.QUANTA_DIFF_MAX_BYTES = "garbage"
    process.env.QUANTA_DIFF_MAX_LINES = "-5"
    const caps = resolveEnvCaps()
    expect(caps.maxBytes).toBeGreaterThan(0)
    expect(caps.maxLines).toBeGreaterThan(0)
  })
})
