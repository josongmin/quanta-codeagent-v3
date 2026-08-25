/**
 * Strip env-applied dependency-pin contamination from a captured candidate patch.
 *
 * jun-28 root cause (sphinx false-ERROR class): to install an OLD repo under a
 * modern resolver, the env setup (box bootstrap / swebench install commands)
 * tightens the repo's manifest `install_requires`/`dependencies` — e.g.
 * `'docutils>=0.12'` → `'docutils>=0.12,<0.18'`, `'Jinja2>=2.3'` → `'…,<3.1'`.
 * That mutation happens in the SAME working tree we later capture with
 * `git diff --cached`, so the pins leak into the model_patch. At grade time the
 * base image ALREADY carries these pins, so GNU `patch` flags them as
 * already-applied/reversed → "Patch Apply Failed" → the whole instance ERRORs,
 * masking the agent's REAL fix (sphinx-8721 / -9711 flipped to RESOLVED once the
 * setup.py section was removed; measured jun-28).
 *
 * The fix is at the capture layer and SOURCE-AGNOSTIC (it doesn't matter which
 * env step applied the pins): drop a manifest file-section IFF it is PURELY a
 * constraint-rewording of the SAME set of packages — the env signature. A section
 * that changes code, adds/removes a package, or edits a non-manifest file is kept
 * verbatim, so a genuine agent manifest edit (rare, but possible) survives.
 * Empirically safe for the affected set: NONE of the 5 contaminated instances'
 * gold patches touch a manifest, so a constraint-only manifest diff is never the
 * actual fix.
 */

/**
 * Manifests the env pins — matched as the REPO-ROOT path (no `/`), NOT by
 * basename. The env only ever pins the root manifest; a repo's test fixtures
 * carry their own `tests/roots/…/setup.py` whose dep edits CAN be a real fix and
 * must never be stripped (audit Cat-1).
 */
const ROOT_MANIFESTS = new Set(["setup.py", "setup.cfg", "pyproject.toml"])

/**
 * A Python dependency-requirement string line (as it appears inside
 * `install_requires`/`dependencies`), e.g. `'pkg>=1.0,<2.0',` or `"pkg[extra]"`.
 * Captures the package name (group 1). Anything else (code, comments, blanks)
 * does NOT match — which is the guard that keeps real code edits.
 */
const REQUIREMENT_LINE =
  /^['"]([A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_,.\s-]*\])?\s*(?:[<>=!~][^'"]*)?['"]\s*,?\s*$/

const requirementPackage = (changedLine: string): string | null => {
  const m = REQUIREMENT_LINE.exec(changedLine.trim())
  return m?.[1]?.toLowerCase() ?? null
}

/**
 * The env-pin signature is ALWAYS the addition of an UPPER bound (`<`/`<=`) to
 * make an old repo resolvable: `'docutils>=0.12'` → `'docutils>=0.12,<0.18'`,
 * `'sphinxcontrib-applehelp'` → `'…<1.0.8'`. Requiring every ADDED line to carry
 * an upper bound is what separates env pinning from a real edit that reorders a
 * bare list, fixes a package-name case, or LOOSENS/changes a bound (audit Cat-2/3)
 * — none of which add a `<` bound.
 */
const addsUpperBound = (changedLine: string): boolean => changedLine.includes("<")

/** Target (b-side) path of a `diff --git a/… b/…` section header line. */
const targetPathOf = (sectionHeader: string): string | undefined => {
  const m = /^a\/.+ b\/(.+)$/.exec(sectionHeader)
  return m?.[1]
}

/** A `+`/`-` content line of a unified diff, with the marker stripped. Returns
 *  null for file headers (`+++`/`---`), hunk headers and context lines — i.e.
 *  everything that is not a CHANGE. */
const changedContentOf = (
  line: string,
): { readonly isAdd: boolean; readonly content: string } | null => {
  // skip file headers and hunk headers; only +/- content lines are "changes"
  if (line.startsWith("+++") || line.startsWith("---")) return null
  const isAdd = line.startsWith("+")
  const isDel = line.startsWith("-")
  if (!isAdd && !isDel) return null
  return { isAdd, content: line.slice(1) }
}

/** The package sets a section's changed lines removed and added. */
type PinDelta = {
  readonly removed: ReadonlySet<string>
  readonly added: ReadonlySet<string>
  readonly changedLines: number
}

/**
 * Scan a file-section's changed lines into a {@link PinDelta}, or `null` the
 * moment a change proves the section is a REAL edit rather than env pinning.
 *
 * Its own unit because it is the only part that walks the diff; the purity
 * verdict below is then pure set algebra over its result.
 */
const scanPinDelta = (sectionBody: string): PinDelta | null => {
  const removed = new Set<string>()
  const added = new Set<string>()
  let changedLines = 0
  for (const line of sectionBody.split("\n")) {
    const change = changedContentOf(line)
    if (change === null) continue
    changedLines++
    const pkg = requirementPackage(change.content)
    if (pkg === null) return null // a non-requirement change ⇒ real edit ⇒ keep
    // Every ADDED line must add an upper bound — the env-pin signature. An added
    // line without one is a real edit (reorder / case-fix / loosened bound).
    if (change.isAdd && !addsUpperBound(change.content)) return null
    ;(change.isAdd ? added : removed).add(pkg)
  }
  return { removed, added, changedLines }
}

/** Set equality by membership (both directions follow from equal sizes). */
const sameMembers = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * True when a file-section is PURELY env dependency-pinning: every added/removed
 * line is a requirement string, and the set of removed packages == the set of
 * added packages (a rewording of the same deps — no package added or dropped,
 * no code touched).
 */
const isPureDependencyPinSection = (sectionBody: string): boolean => {
  const delta = scanPinDelta(sectionBody)
  if (delta === null) return false
  if (delta.changedLines === 0 || delta.removed.size === 0) return false
  return sameMembers(delta.removed, delta.added)
}

/**
 * Remove env dependency-pin contamination from `patch`. Returns the patch with
 * any pure-pin manifest section dropped; byte-identical when there is nothing to
 * strip. Never throws.
 */
export const stripEnvManifestPins = (patch: string): string => {
  if (!patch.includes("diff --git ")) return patch
  // Split into per-file sections. parts[0] is any preamble before the first
  // `diff --git ` (normally ""); each later part is one file-section body.
  const parts = patch.split("diff --git ")
  const head = parts[0]
  const kept: string[] = []
  for (const body of parts.slice(1)) {
    const headerLine = body.split("\n", 1)[0] ?? ""
    const target = targetPathOf(headerLine)
    const isRootManifest = target !== undefined && ROOT_MANIFESTS.has(target)
    if (isRootManifest && isPureDependencyPinSection(body)) continue // drop env-pin section
    kept.push(`diff --git ${body}`)
  }
  return head + kept.join("")
}
