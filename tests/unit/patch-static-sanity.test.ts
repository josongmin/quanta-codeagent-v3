import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { probePatchStaticSanity } from "@/runner/batch/eval/patch-static-sanity"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

const probe = async (
  files: Readonly<Record<string, string>>,
  targetFiles: readonly string[] = Object.keys(files),
): Promise<string[] | null> => {
  const cwd = mkdtempSync(join(tmpdir(), "patch-static-sanity-"))
  tempDirs.push(cwd)
  for (const [file, source] of Object.entries(files)) {
    const abs = join(cwd, file)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, source)
  }
  return probePatchStaticSanity({
    cwd,
    files: targetFiles,
    timeoutMs: 5_000,
  })
}

describe("probePatchStaticSanity", () => {
  it("rejects a variable assigned None and then mutated through subscript", async () => {
    const reasons = await probe({
      "pkg/client.py": `
class Client:
    def build(self, password):
        env = None
        if password:
            env["PASSWORD"] = password
        return env
`,
    })
    expect(reasons).toContain("hard:staticSanity=pythonNoneSubscriptMutation(env)")
  })

  it("allows subscript mutation after a non-None rebinding", async () => {
    const reasons = await probe({
      "pkg/client.py": `
class Client:
    def build(self, password):
        env = None
        if password:
            env = {}
            env["PASSWORD"] = password
        return env
`,
    })
    expect(reasons).toEqual([])
  })

  it("rejects sqlite create_function arity that disagrees with callback definition", async () => {
    const reasons = await probe({
      "pkg/sqlite_base.py": `
class Wrapper:
    def get_new_connection(self, params):
        conn = Database.connect(**params)
        conn.create_function("django_datetime_cast_date", 3, _sqlite_datetime_cast_date)
        conn.create_function("django_datetime_extract", 4, _sqlite_datetime_extract)
        return conn

def _sqlite_datetime_cast_date(dt, tzname):
    return dt

def _sqlite_datetime_extract(lookup_type, dt, tzname=None):
    return dt
`,
    })
    expect(reasons).toContain(
      "hard:staticSanity=pythonCallbackArityMismatch(_sqlite_datetime_cast_date:2->3)",
    )
    expect(reasons).toContain(
      "hard:staticSanity=pythonCallbackArityMismatch(_sqlite_datetime_extract:3->4)",
    )
  })

  it("matches the runtime positional-only callback semantics", async () => {
    const reasons = await probe({
      "pkg/sqlite_base.py": `
class Wrapper:
    def get_new_connection(self, params):
        conn = Database.connect(**params)
        conn.create_function("demo", 2, _cb)
        return conn

def _cb(dt, /, tzname=None):
    return dt
`,
    })
    expect(reasons).toEqual([])
  })

  it("allows sqlite create_function arity when callbacks match", async () => {
    const reasons = await probe({
      "pkg/sqlite_base.py": `
class Wrapper:
    def get_new_connection(self, params):
        conn = Database.connect(**params)
        conn.create_function("django_datetime_cast_date", 3, _sqlite_datetime_cast_date)
        conn.create_function("django_datetime_extract", 4, _sqlite_datetime_extract)
        return conn

def _sqlite_datetime_cast_date(dt, tzname, conn_tzname):
    return dt

def _sqlite_datetime_extract(lookup_type, dt, tzname=None, conn_tzname=None):
    return dt
`,
    })
    expect(reasons).toEqual([])
  })
})
