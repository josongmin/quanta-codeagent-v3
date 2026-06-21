/**
 * `diffTouchedSymbols(patch)` → the set of code-symbol names a unified-diff
 * patch TOUCHES, for matching against issue/API symbols (api-surface contract
 * evaluation).
 *
 * Two complementary signals are unioned:
 *
 *   1. HUNK-HEADER CONTEXT — the trailing text of `@@ -x,y +a,b @@ <context>`.
 *      git emits the signature of the ENCLOSING function/class for the hunk as
 *      that trailing context. This is the ROBUST signal: it catches edits to a
 *      symbol's BODY that never redeclare the symbol (no `+def foo` line), which
 *      is the common case and the whole point of this module.
 *
 *   2. DECLARATION LINES — `+`/`-` lines that DECLARE a symbol
 *      (`def NAME`, `class NAME`, `function NAME`, `const NAME =`). This catches
 *      brand-new / renamed declarations whose name is not yet (or no longer) the
 *      enclosing context.
 *
 * Reuse note: diff *structure* parsing (splitting `+`/`-` runs into typed hunks)
 * is delegated to `parseUnifiedDiff` from `parse-unified-diff.ts` rather than
 * re-implemented here. The hunk-header *context* (the text after the second
 * `@@`) is parsed locally: `parse-unified-diff.ts`'s `parseHunkHeader`
 *   `const parseHunkHeader = (line: string): HunkHeader | null`
 * is module-private AND its regex (`… @@`) deliberately discards the trailing
 * context, so the enclosing-signature signal cannot be obtained from it — it is
 * extracted here with a dedicated header scan.
 *
 * PURE: deterministic, no I/O, no eval/exec — pure string scanning.
 *
 * Source-language-best-effort: Python (`def` / `class` / `async def`) and
 * JS/TS (`function` / `class` / `const NAME =`) are covered. Other languages may
 * yield partial results; the contract is "names it can recognize", never a
 * guarantee of completeness, and it must never hallucinate a name it did not see.
 */
import { parseUnifiedDiff } from "@/tool/git/moved-code/parse-unified-diff"

/**
 * Pull a declared identifier out of a single source-ish line (hunk context, or
 * the body of a `+`/`-` line with its polarity marker already stripped).
 * Returns the bare identifier, or `null` when the line declares nothing
 * recognizable. Order matters: more specific (`async def`) before generic.
 */
const declaredSymbol = (line: string): string | null => {
  const text = line.trim()
  // Python: `def NAME(`, `async def NAME(`, `class NAME(` / `class NAME:`.
  const py = /^(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (py?.[1] !== undefined) return py[1]
  const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (cls?.[1] !== undefined) return cls[1]
  // JS/TS: `function NAME(`, `async function NAME(`, `function* NAME(`.
  const fn = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text)
  if (fn?.[1] !== undefined) return fn[1]
  // Go/Rust-ish: `func NAME(` / `fn NAME(`.
  const func = /^(?:func|fn)\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (func?.[1] !== undefined) return func[1]
  // JS/TS arrow/value declarations: `const NAME = …` (also let/var).
  const decl = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text)
  if (decl?.[1] !== undefined) return decl[1]
  return null
}

/**
 * The trailing context after the second `@@` of a hunk header names the
 * enclosing function/class. git often emits a method/qualified form, so pull
 * the LAST recognizable declarator (e.g. `class Foo.bar(self):` → `bar`), and
 * fall back to the first bare identifier-after-keyword anywhere in the context.
 */
const hunkContextSymbol = (header: string): string | null => {
  const m = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(header)
  if (m?.[1] === undefined) return null
  const context = m[1]
  // Direct declarator at the (trimmed) start of the context.
  const direct = declaredSymbol(context)
  if (direct !== null) return direct
  // Otherwise scan for `def|class|function|func|fn NAME` anywhere in the context.
  const scan = /(?:async\s+)?(?:def|class|function|func|fn)\s+([A-Za-z_$][\w$]*)/.exec(context)
  if (scan?.[1] !== undefined) return scan[1]
  return null
}

/**
 * Returns the deduped, stably-sorted set of code-symbol names the `patch`
 * touches. Empty patch / no recognizable symbols ⇒ `[]`.
 */
export const diffTouchedSymbols = (patch: string): string[] => {
  if (patch.length === 0) return []
  const found = new Set<string>()

  // Signal 1: enclosing-symbol from hunk headers (robust; catches body edits).
  for (const line of patch.split("\n")) {
    if (!line.startsWith("@@")) continue
    const sym = hunkContextSymbol(line)
    if (sym !== null) found.add(sym)
  }

  // Signal 2: declarations on changed (`+`/`-`) lines — via the shared parser so
  // diff structure is not re-implemented here. `parseUnifiedDiff` returns typed
  // added/removed hunks whose `body` is the changed text (markers stripped).
  for (const hunk of parseUnifiedDiff(patch)) {
    for (const bodyLine of hunk.body.split("\n")) {
      const sym = declaredSymbol(bodyLine)
      if (sym !== null) found.add(sym)
    }
  }

  return [...found].sort()
}
