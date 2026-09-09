export type SelectionFlagError = {
  readonly kind: "exclusive" | "missing"
  readonly message: string
}

export const parseSelectionArgv = (
  argv: readonly string[],
):
  | {
      readonly ok: true
      readonly mode: "base-head" | "working" | "staged"
      readonly base?: string
      readonly head?: string
    }
  | { readonly ok: false; readonly error: SelectionFlagError } => {
  const hasBase = argv.some((arg) => arg.startsWith("--base="))
  const hasHead = argv.some((arg) => arg.startsWith("--head="))
  const working = argv.includes("--working")
  const staged = argv.includes("--staged")
  const modes = Number(hasBase || hasHead) + Number(working) + Number(staged)
  if (modes > 1) {
    return {
      ok: false,
      error: { kind: "exclusive", message: "selection modes are mutually exclusive" },
    }
  }
  if ((hasBase && !hasHead) || (hasHead && !hasBase)) {
    return { ok: false, error: { kind: "missing", message: "--base and --head must be paired" } }
  }
  if (hasBase && hasHead) {
    const base = argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length) ?? ""
    const head = argv.find((arg) => arg.startsWith("--head="))?.slice("--head=".length) ?? ""
    if (base === "" || head === "") {
      return { ok: false, error: { kind: "missing", message: "empty base or head" } }
    }
    return { ok: true, mode: "base-head", base, head }
  }
  if (working) return { ok: true, mode: "working" }
  return { ok: true, mode: "staged" }
}
