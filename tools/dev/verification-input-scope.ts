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
