import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadPolicyOverrides } from "./test-policy"

export type InputScopeKind = "whole-tree" | "declared-v1"

export type Certification =
  | {
      readonly kind: "declared-v1"
      readonly files: readonly string[]
      readonly reason: string
    }
  | {
      readonly kind: "whole-tree"
      readonly reason: string
    }

const FORBIDDEN = /\bfs\b|\bspawn\b|\bprocess\.env\b|import\s*\(|Bun\.Glob|child_process/

const OVERRIDES_PATH = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "tools/dev/test-policy-overrides.json",
)

const digestOf = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

export const certifyDeclaredInputs = (input: {
  readonly id: string
  readonly source: string
  readonly optIn: ReadonlySet<string>
}): Certification => {
  if (!input.optIn.has(input.id)) {
    return { kind: "whole-tree", reason: "not-opted-in" }
  }
  if (FORBIDDEN.test(input.source)) {
    return { kind: "whole-tree", reason: "forbidden-edge" }
  }
  return { kind: "declared-v1", files: [input.id], reason: "certified" }
}

export const hashDeclaredInputs = (certifications: readonly Certification[]): string => {
  if (certifications.length === 0 || certifications.some((row) => row.kind === "whole-tree")) {
    return digestOf("whole-tree")
  }
  return digestOf(JSON.stringify(certifications))
}

export const WHOLE_TREE_INPUT_SCOPE_SHA256 = hashDeclaredInputs([])

export const declaredInputOptIn = (overridesPath = OVERRIDES_PATH): ReadonlySet<string> =>
  new Set(
    loadPolicyOverrides(overridesPath)
      .overrides.filter((row) => row.inputScope === "declared")
      .map((row) => row.id),
  )

export const chunkInputScopeSha256 = (
  repoRoot: string,
  ids: readonly string[],
  optIn: ReadonlySet<string> = declaredInputOptIn(),
): string =>
  hashDeclaredInputs(
    ids.map((id) => {
      if (!optIn.has(id)) return certifyDeclaredInputs({ id, source: "", optIn })
      let source = "import("
      try {
        source = readFileSync(join(repoRoot, id), "utf8")
      } catch {
        source = "import("
      }
      return certifyDeclaredInputs({ id, source, optIn })
    }),
  )
