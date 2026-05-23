import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "@/tool/read";
const dir = mkdtempSync(join(tmpdir(), "read-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = (cwd) => ({
  cwd,
  signal: new AbortController().signal
});
const run = async (input) => {
  let result;
  for await (const ev of readTool.execute(input, ctx(dir))) {
    if (ev.type === "result")
      result = ev.result;
  }
  if (!result)
    throw new Error("no result");
  return result;
};
describe("readTool", () => {
  test("metadata: read-only and concurrency-safe", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.isReadOnly()).toBe(true);
    expect(readTool.isConcurrencySafe({ path: "x" })).toBe(true);
  });
  test("reads a file with 1-based line numbers", async () => {
    const f = join(dir, "lines.txt");
    writeFileSync(f, `alpha
beta
gamma`);
    const r = await run({ path: f });
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`1	alpha
2	beta
3	gamma`);
  });
  test("empty file yields a single numbered blank line", async () => {
    const f = join(dir, "empty.txt");
    writeFileSync(f, "");
    const r = await run({ path: f });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("1\t");
  });
  test("offset past EOF produces the (empty file) sentinel", async () => {
    const f = join(dir, "past-eof.txt");
    writeFileSync(f, `only
`);
    const r = await run({ path: f, offset: 99 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("(empty file)");
  });
  test("offset starts from the given 1-based line", async () => {
    const f = join(dir, "offset.txt");
    writeFileSync(f, `l1
l2
l3
l4`);
    const r = await run({ path: f, offset: 3 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`3	l3
4	l4`);
  });
  test("limit caps lines and appends a more-lines note", async () => {
    const f = join(dir, "limit.txt");
    writeFileSync(f, `a
b
c
d
e`);
    const r = await run({ path: f, limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`1	a
2	b
\u2026 (3 more lines, use offset)`);
  });
  test("offset + limit windows the file without a note when reaching EOF", async () => {
    const f = join(dir, "window.txt");
    writeFileSync(f, `x1
x2
x3
x4`);
    const r = await run({ path: f, offset: 3, limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`3	x3
4	x4`);
  });
  test("directory path returns ok:false", async () => {
    const sub = join(dir, "adir");
    mkdirSync(sub);
    const r = await run({ path: sub });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("is a directory");
  });
  test("directory path \u2192 failure.mode not_found with path (absorb #2)", async () => {
    const sub = join(dir, "adir-typed");
    mkdirSync(sub);
    const r = await run({ path: sub });
    expect(r.ok).toBe(false);
    expect(r.failure).toEqual({ mode: "not_found", path: sub });
    expect(r.output).toContain("is a directory");
  });
  test("FS jail escape \u2192 failure.mode permission_denied isReadonly:false (absorb #2)", async () => {
    const jail = mkdtempSync(join(tmpdir(), "read-jail-typed-"));
    const outside = mkdtempSync(join(tmpdir(), "read-outside-typed-"));
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "top-secret");
    try {
      const prev = process.env.QUANTA_FS_JAIL;
      delete process.env.QUANTA_FS_JAIL;
      let result;
      for await (const ev of readTool.execute({ path: victim }, ctx(jail))) {
        if (ev.type === "result")
          result = ev.result;
      }
      expect(result?.ok).toBe(false);
      expect(result?.failure).toEqual({
        mode: "permission_denied",
        path: victim,
        isReadonly: false
      });
      if (prev !== undefined)
        process.env.QUANTA_FS_JAIL = prev;
    } finally {
      rmSync(jail, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("missing file \u21D2 typed not_found (gap closure, absorb #2 extension)", async () => {
    const ghost = join(dir, "ghost.txt");
    const r = await run({ path: ghost });
    expect(r.ok).toBe(false);
    expect(r.failure).toEqual({ mode: "not_found", path: ghost });
    expect(r.output).toContain("File not found");
  });
  test("schema rejects a non-string path", () => {
    expect(readTool.inputSchema.safeParse({ path: 123 }).success).toBe(false);
  });
  test("schema rejects limit:0 / negative / non-int (avoids misleading empty read)", () => {
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 0 }).success).toBe(false);
    expect(readTool.inputSchema.safeParse({ path: "x", limit: -5 }).success).toBe(false);
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1.5 }).success).toBe(false);
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1 }).success).toBe(true);
  });
  test("schema rejects a negative / non-int offset, accepts 0 and positive ints", () => {
    expect(readTool.inputSchema.safeParse({ path: "x", offset: -1 }).success).toBe(false);
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 2.5 }).success).toBe(false);
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 0 }).success).toBe(true);
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 3 }).success).toBe(true);
  });
  test("a relative path resolves against ctx.cwd, not process.cwd()", async () => {
    writeFileSync(join(dir, "relative-read.txt"), "from-ctx-cwd");
    const r = await run({ path: "relative-read.txt" });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("1\tfrom-ctx-cwd");
  });
});
