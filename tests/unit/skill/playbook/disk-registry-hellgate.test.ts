import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDiskPlaybookRegistry } from "@/skill/playbook"

const roots: string[] = []

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "playbook-disk-registry-"))
  roots.push(root)
  return root
}

const markdown = (name: string, marker = "QUANTA!", glob = "**/*.ts"): string =>
  [
    "---",
    `name: ${name}`,
    "trigger:",
    `  comment-marker: ${marker}`,
    `  watch-glob: "${glob}"`,
    "---",
    `Run ${name}.`,
  ].join("\n")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("DOF-14 disk playbook registry", () => {
  test("loads deterministic top-level markdown registrations", () => {
    const root = tempRoot()
    writeFileSync(join(root, "z.md"), markdown("z-last"))
    writeFileSync(join(root, "a.md"), markdown("a-first"))
    writeFileSync(join(root, "ignored.txt"), markdown("ignored"))

    const registry = createDiskPlaybookRegistry(root)
    expect(registry.lastReload()).toEqual({ ok: true, loaded: 2 })
    expect(registry.list().map((entry) => entry.name)).toEqual(["a-first", "z-last"])
  })

  test("successful reload replaces updates and removes deleted files", () => {
    const root = tempRoot()
    const alpha = join(root, "alpha.md")
    const beta = join(root, "beta.md")
    writeFileSync(alpha, markdown("alpha", "OLD!"))
    writeFileSync(beta, markdown("beta"))
    const registry = createDiskPlaybookRegistry(root)

    writeFileSync(alpha, markdown("alpha", "NEW!", "**/*.tsx"))
    unlinkSync(beta)
    expect(registry.reload()).toEqual({ ok: true, loaded: 1 })
    expect(registry.list()).toEqual([
      {
        name: "alpha",
        frontmatter: { trigger: { commentMarker: "NEW!", watchGlob: "**/*.tsx" } },
      },
    ])
  })

  test("invalid reload is typed, no-throw, and retains the last good snapshot", () => {
    const root = tempRoot()
    const path = join(root, "stable.md")
    writeFileSync(path, markdown("stable"))
    const registry = createDiskPlaybookRegistry(root)

    writeFileSync(path, "---\nname: stable\ntrigger: [not-a-map]\n---\n")
    let result: ReturnType<typeof registry.reload> | undefined
    expect(() => {
      result = registry.reload()
    }).not.toThrow()
    expect(result?.ok).toBe(false)
    if (result?.ok === false) expect(result.issues[0]?.code).toBe("invalid-frontmatter")
    expect(registry.list().map((entry) => entry.name)).toEqual(["stable"])
  })

  test("malformed YAML is an observable parse error without partial replacement", () => {
    const root = tempRoot()
    writeFileSync(join(root, "valid.md"), markdown("valid"))
    const registry = createDiskPlaybookRegistry(root)
    writeFileSync(join(root, "broken.md"), "---\nname: broken\ntrigger: [unterminated\n---\n")

    const result = registry.reload()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid-frontmatter failure")
    expect(result.issues[0]?.code).toBe("invalid-frontmatter")
    expect(registry.list().map((entry) => entry.name)).toEqual(["valid"])
  })

  test("duplicate names fail the whole snapshot with both paths identified", () => {
    const root = tempRoot()
    writeFileSync(join(root, "one.md"), markdown("same-name"))
    writeFileSync(join(root, "two.md"), markdown("same-name"))

    const registry = createDiskPlaybookRegistry(root)
    const result = registry.lastReload()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected duplicate-name failure")
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.code).toBe("duplicate-name")
    expect(result.issues[0]?.message).toContain("one.md")
    expect(registry.list()).toEqual([])
  })

  test("symlinked markdown escaping the canonical root is rejected", () => {
    const root = tempRoot()
    const outside = tempRoot()
    const target = join(outside, "outside.md")
    writeFileSync(target, markdown("escaped"))
    symlinkSync(target, join(root, "escaped.md"))

    const result = createDiskPlaybookRegistry(root).lastReload()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected path-escape failure")
    expect(result.issues[0]?.code).toBe("path-escape")
  })

  test("missing root and non-directory root return loud typed failures", () => {
    const root = tempRoot()
    const file = join(root, "not-a-directory")
    writeFileSync(file, "x")

    const missing = createDiskPlaybookRegistry(join(root, "missing")).lastReload()
    const notDir = createDiskPlaybookRegistry(file).lastReload()
    expect(missing.ok).toBe(false)
    expect(notDir.ok).toBe(false)
    if (missing.ok || notDir.ok) throw new Error("expected root failures")
    expect(missing.issues[0]?.code).toBe("root-not-found")
    expect(notDir.issues[0]?.code).toBe("root-not-dir")
  })
})
