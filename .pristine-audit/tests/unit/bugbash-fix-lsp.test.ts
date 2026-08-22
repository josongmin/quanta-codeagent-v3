/**
 * Bugbash jun-20 — `lsp` group fixes (findings #4, #20, #21).
 *
 * #4  Availability probe must cache ONLY successes: a transient `false`
 *     (binary off `PATH` / 5s race timeout under load) must be EVICTED so it
 *     does not permanently disable every LSP surface process-wide. A first
 *     probe that resolves false must NOT poison a later successful probe.
 * #20 `file://` URI → path must use `fileURLToPath` (decodes `%20`/non-ASCII)
 *     instead of the hand-rolled `replace(/^file:\/\//,"")` (leaves the literal
 *     percent-encoding). Proven through `evidenceLspStatic.toLoc`.
 * #21 The import-scan line cap must NOT falsely mark a file verified-ready when
 *     its imports live past the cap — a truncated-without-probe scan re-attempts
 *     warm-up instead of claiming a warm-verified (maybe-cold) server.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  __findPyrightImportProbeForTest,
  __hasCachedLspAvailabilityForTest,
  __isLspAvailableForTest,
  __resetLspAvailabilityCacheForTest,
  evidenceLspStatic,
} from "@/agent/lsp-bridge"
import type { LspNavProvider, NavLocation } from "@/tool"

afterEach(() => {
  __resetLspAvailabilityCacheForTest()
})

describe("#4 availability probe caches only successes", () => {
  test("a transient false is EVICTED and does NOT poison a later successful probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-avail-"))
    // Probe an absolute path that does NOT exist yet ⇒ spawn ENOENT ⇒ false.
    const bin = join(dir, "quanta-fake-langserver")
    try {
      const first = await __isLspAvailableForTest(bin)
      expect(first).toBe(false)
      // RED-on-injection: the OLD code caches this false forever. The fix evicts
      // a settled false so the next call re-probes.
      expect(__hasCachedLspAvailabilityForTest(bin)).toBe(false)

      // Now the binary becomes reachable (PATH was "not ready" before).
      writeFileSync(bin, "#!/bin/sh\necho 'fake 1.0'\n")
      chmodSync(bin, 0o755)
      const second = await __isLspAvailableForTest(bin)
      // With the bug the cached `false` would short-circuit here and the whole
      // LSP surface stays dead. The fix re-probes and discovers it IS available.
      expect(second).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a successful probe is RETAINED in the cache (dedup invariant preserved)", async () => {
    // `node` is always present ⇒ probe resolves true and must STAY cached so a
    // later call does not re-spawn `--version`.
    const ok = await __isLspAvailableForTest("node")
    expect(ok).toBe(true)
    expect(__hasCachedLspAvailabilityForTest("node")).toBe(true)
  })
})

describe("#20 file:// uri decodes percent-encoding via fileURLToPath", () => {
  // A scriptable nav session that returns a definition Location whose URI has an
  // encoded space — exercising `evidenceLspStatic`'s `toLoc`.
  const makeProvider = (encodedDefUri: string): LspNavProvider => ({
    unavailableReason: () => "n/a",
    open: async () => ({
      hover: async () => ({ contents: "x: int" }),
      definition: async (): Promise<NavLocation[]> => [
        {
          uri: encodedDefUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ],
      references: async (): Promise<NavLocation[]> => [],
      typeDefinition: async () => null,
      implementation: async () => null,
      documentSymbol: async () => null,
      workspaceSymbol: async () => null,
      prepareRename: async () => null,
      incomingCalls: async () => null,
      outgoingCalls: async () => null,
      stop: async () => {},
    }),
  })

  test("an encoded `%20` in the definition uri resolves to the DECODED path", async () => {
    // pathToFileURL encodes the space as %20 — the same shape a real LSP server
    // emits for a workspace path with a space.
    const decodedPath = "/tmp/a b/c.py"
    const encodedUri = pathToFileURL(decodedPath).href
    expect(encodedUri).toContain("%20") // sanity: the input really is encoded

    const ev = evidenceLspStatic(20_000, makeProvider(encodedUri))
    const out = await ev("/tmp/a b/c.py", 1, "/tmp/a b")
    expect(out).not.toBeNull()
    // RED-on-injection: the hand-rolled strip yields "/tmp/a%20b/c.py" (literal
    // %20). fileURLToPath decodes it back to the real "/tmp/a b/c.py".
    expect(out?.definition_chain[0]?.file).toBe(decodedPath)
    expect(out?.definition_chain[0]?.file).not.toContain("%20")
  })
})

describe("#21 import scan past the line cap does not falsely mark verified-ready", () => {
  // 200 = PYRIGHT_IMPORT_SCAN_LINE_CAP (module-private). Files use a long header
  // so the ONLY import lands past it.
  const headerLines = (n: number): string =>
    Array.from({ length: n }, (_, i) => `# header line ${i}`).join("\n")

  test("imports past the cap ⇒ no probe BUT truncated=true (not falsely ready)", () => {
    const source = `${headerLines(250)}\nfrom exc import MyError\n\ndef g():\n    return MyError\n`
    const scan = __findPyrightImportProbeForTest(source)
    // The import at line ~251 is beyond the 200-line cap, so no probe position.
    expect(scan.pos).toBeNull()
    // RED-on-injection: the OLD code returned a bare `null` here, which
    // ensurePyrightFileReady treats as verified-ready. `truncated` must be true
    // so the caller refuses the false warm-verified status and re-attempts.
    expect(scan.truncated).toBe(true)
  })

  test("a genuinely import-less file under the cap ⇒ no probe AND truncated=false", () => {
    const source = "def f(x):\n    return x\n\nclass C:\n    pass\n"
    const scan = __findPyrightImportProbeForTest(source)
    expect(scan.pos).toBeNull()
    // Whole file scanned, no import exists ⇒ legitimately verified-ready. This
    // proves the fix discriminates on `truncated`, not blanket `pos === null`.
    expect(scan.truncated).toBe(false)
  })

  test("an import WITHIN the cap still yields a probe position (no regression)", () => {
    const source = "from exc import MyError\n\ndef g():\n    return MyError\n"
    const scan = __findPyrightImportProbeForTest(source)
    expect(scan.pos).not.toBeNull()
    expect(scan.truncated).toBe(false)
    // The probe points at the `MyError` symbol on line 0.
    expect(scan.pos?.line).toBe(0)
    expect(scan.pos?.character).toBeGreaterThan(0)
  })

  test("a long file whose first import is within the cap is NOT truncated", () => {
    // 150 header lines (< cap) then an import at line ~150 ⇒ found in-window.
    const source = `${headerLines(150)}\nimport os\n`
    const scan = __findPyrightImportProbeForTest(source)
    expect(scan.pos).not.toBeNull()
    expect(scan.truncated).toBe(false)
  })
})
