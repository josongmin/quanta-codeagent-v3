/**
 * ADR-0336 — `discoverPlugins` hellgate.
 *
 *   A. Empty / missing root                      (2)
 *   B. Single plugin discovered                  (1)
 *   C. Multiple plugins discovered               (1)
 *   D. Missing .codex-plugin path                (1)
 *   E. Partial malformed plugins                 (1)
 *   F. fs throws ⇒ NO-THROW degradation          (2)
 *   G. id override = directory name              (1)
 *
 * Total = 9 cases (>= the required 6).
 */

import { describe, expect, test } from "bun:test"
import { discoverPlugins } from "../discovery"
import type { FilesystemPort } from "../types"

/** Build an in-memory FilesystemPort over a {path → content} map. */
const fakeFs = (
  fileMap: ReadonlyMap<string, string>,
  dirMap: ReadonlyMap<string, readonly string[]>,
): FilesystemPort => ({
  readDir(dir) {
    return dirMap.get(dir) ?? []
  },
  readFile(path) {
    return fileMap.get(path) ?? null
  },
})

describe("discoverPlugins — ADR-0336 hellgate", () => {
  // -------- A. empty / missing root -------------------------------

  test("A1 — empty rootDir string ⇒ []", () => {
    const fs = fakeFs(new Map(), new Map())
    expect(discoverPlugins("", fs)).toEqual([])
  })

  test("A2 — root directory has no children ⇒ []", () => {
    const fs = fakeFs(new Map(), new Map([["/plugins", []]]))
    expect(discoverPlugins("/plugins", fs)).toEqual([])
  })

  // -------- B. single plugin --------------------------------------

  test("B1 — one child with valid manifest ⇒ one manifest", () => {
    const fs = fakeFs(
      new Map([
        [
          "/plugins/github/.codex-plugin/plugin.json",
          '{"id": "github", "name": "GitHub", "capabilities": ["Read"]}',
        ],
      ]),
      new Map([["/plugins", ["github"]]]),
    )
    const out = discoverPlugins("/plugins", fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("github")
    expect(out[0]?.name).toBe("GitHub")
    expect(out[0]?.capabilities).toEqual(["Read"])
  })

  // -------- C. multiple plugins -----------------------------------

  test("C1 — multiple children with valid manifests preserved in dir order", () => {
    const fs = fakeFs(
      new Map([
        ["/p/alpha/.codex-plugin/plugin.json", '{"name": "Alpha"}'],
        ["/p/beta/.codex-plugin/plugin.json", '{"name": "Beta"}'],
        ["/p/gamma/.codex-plugin/plugin.json", '{"name": "Gamma"}'],
      ]),
      new Map([["/p", ["alpha", "beta", "gamma"]]]),
    )
    const out = discoverPlugins("/p", fs)
    expect(out.map((m) => m.id)).toEqual(["alpha", "beta", "gamma"])
  })

  // -------- D. missing .codex-plugin path -------------------------

  test("D1 — children without .codex-plugin/plugin.json ⇒ skipped", () => {
    const fs = fakeFs(
      new Map([["/p/has-plugin/.codex-plugin/plugin.json", '{"name": "OK"}']]),
      new Map([["/p", ["has-plugin", "no-plugin", "also-not"]]]),
    )
    const out = discoverPlugins("/p", fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("has-plugin")
  })

  // -------- E. partial malformed ----------------------------------

  test("E1 — some manifests malformed JSON ⇒ others survive", () => {
    const fs = fakeFs(
      new Map([
        ["/p/good/.codex-plugin/plugin.json", '{"name": "Good"}'],
        ["/p/bad/.codex-plugin/plugin.json", "not valid json"],
        ["/p/empty/.codex-plugin/plugin.json", "{}"],
      ]),
      new Map([["/p", ["good", "bad", "empty"]]]),
    )
    const out = discoverPlugins("/p", fs)
    expect(out.map((m) => m.id)).toEqual(["good"])
  })

  // -------- F. fs NO-THROW degradation ----------------------------

  test("F1 — readDir throws ⇒ []", () => {
    const fs: FilesystemPort = {
      readDir() {
        throw new Error("EACCES")
      },
      readFile() {
        return null
      },
    }
    expect(discoverPlugins("/p", fs)).toEqual([])
  })

  test("F2 — readFile throws on some children ⇒ healthy ones survive", () => {
    const okMap = new Map([["/p/ok/.codex-plugin/plugin.json", '{"name": "OK"}']])
    const fs: FilesystemPort = {
      readDir() {
        return ["ok", "evil"]
      },
      readFile(path) {
        if (path.includes("evil")) throw new Error("boom")
        return okMap.get(path) ?? null
      },
    }
    const out = discoverPlugins("/p", fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("ok")
  })

  // -------- G. directory name overrides manifest id ---------------

  test("G1 — discovered id derives from directory name (overrides manifest id)", () => {
    const fs = fakeFs(
      new Map([
        [
          "/p/canonical-dir/.codex-plugin/plugin.json",
          '{"id": "manifest-says-other", "name": "X"}',
        ],
      ]),
      new Map([["/p", ["canonical-dir"]]]),
    )
    const out = discoverPlugins("/p", fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("canonical-dir")
    expect(out[0]?.name).toBe("X")
  })
})
