import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { yamlReadTool } from "@/tool/document/yaml-read"

const tool = yamlReadTool

const mkTmp = async (): Promise<string> => {
  const dir = path.join(
    tmpdir(),
    `quanta-yaml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(dir, { recursive: true })
  return dir
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const exec = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let last: ToolResult | null = null
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") last = ev.result
  }
  return last ?? { ok: false, output: "no result emitted" }
}

describe("yaml_read — metadata", () => {
  test("HELL-1: name", () => expect(tool.name).toBe("yaml_read"))
  test("HELL-2: isReadOnly", () => expect(tool.isReadOnly?.()).toBe(true))
  test("HELL-3: isConcurrencySafe", () =>
    expect(tool.isConcurrencySafe?.({ path: "x.yaml" } as never)).toBe(true))
})

describe("yaml_read — happy + parsing", () => {
  test("HELL-4: valid YAML → JSON-stringified output", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(path.join(dir, "c.yaml"), "name: Alice\nage: 30\n")
      const r = await exec({ path: "c.yaml" }, dir)
      expect(r.ok).toBe(true)
      expect(r.output).toContain('"name": "Alice"')
      expect(r.output).toContain('"age": 30')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-5: YAML anchors + refs expand", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(
        path.join(dir, "a.yaml"),
        "defaults: &d\n  retry: 3\n  timeout: 10\n\nservice_a:\n  <<: *d\n  name: A\n",
      )
      const r = await exec({ path: "a.yaml" }, dir)
      expect(r.ok).toBe(true)
      expect(r.output).toContain('"retry": 3')
      expect(r.output).toContain('"name": "A"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-6: invalid YAML → ok:false with parse error", async () => {
    const dir = await mkTmp()
    try {
      // unclosed bracket — definitive parse fail
      await writeFile(path.join(dir, "bad.yaml"), "items: [1, 2, 3\n")
      const r = await exec({ path: "bad.yaml" }, dir)
      expect(r.ok).toBe(false)
      expect(r.output.toLowerCase()).toMatch(/parse|yaml|error/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-7: empty file → ok:true output 'null'", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(path.join(dir, "e.yaml"), "")
      const r = await exec({ path: "e.yaml" }, dir)
      expect(r.ok).toBe(true)
      // yaml parses empty document to null
      expect(r.output).toContain("null")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("yaml_read — path safety", () => {
  test("HELL-8: '..' traversal rejected", async () => {
    const dir = await mkTmp()
    try {
      const r = await exec({ path: "../escape.yaml" }, dir)
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("permission_denied")
      if (r.failure?.mode !== "permission_denied") throw new Error("expected permission_denied")
      expect(r.failure.isReadonly).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-9: absolute path accepted (explicit consent)", async () => {
    const dir = await mkTmp()
    try {
      const abs = path.join(dir, "abs.yaml")
      await writeFile(abs, "k: v\n")
      const r = await exec({ path: abs }, dir)
      expect(r.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-10: missing file → ok:false", async () => {
    const dir = await mkTmp()
    try {
      const r = await exec({ path: "nope.yaml" }, dir)
      expect(r.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HELL-11: leaf symlink rejected", async () => {
    const dir = await mkTmp()
    try {
      const target = path.join(dir, "target.yaml")
      await writeFile(target, "k: v\n")
      const link = path.join(dir, "link.yaml")
      await symlink(target, link)
      const r = await exec({ path: "link.yaml" }, dir)
      expect(r.ok).toBe(false)
      expect(r.output.toLowerCase()).toMatch(/symlink/)
      expect(r.failure?.mode).toBe("permission_denied")
      if (r.failure?.mode !== "permission_denied") throw new Error("expected permission_denied")
      expect(r.failure.isReadonly).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("yaml_read — input schema + determinism", () => {
  test("HELL-12: same input yields byte-identical output", async () => {
    const dir = await mkTmp()
    try {
      await writeFile(path.join(dir, "d.yaml"), "a: 1\nb: 2\n")
      const a = await exec({ path: "d.yaml" }, dir)
      const b = await exec({ path: "d.yaml" }, dir)
      expect(a.output).toBe(b.output)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
