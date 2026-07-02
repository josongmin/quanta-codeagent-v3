/**
 * Browser slice — in-page a11y collection + defensive parse (ADR-0427, Wave 2).
 *
 * `COLLECT_SCRIPT` runs in the page via `Runtime.evaluate` and returns a
 * serialized {@link DomModel} (JSON). It walks interactive + content elements
 * (Shadow DOM included, iframes excluded), assigns a stable `backendPath` per
 * node, and does NOT mutate the DOM (no `data-*` ref attributes — refs are
 * assigned out-of-band by RefMap).
 *
 * `parseDomModel` is the trust boundary: the page is attacker-controlled, so we
 * validate shape and CAP `name`/`value` defensively (the in-page script also
 * caps, but never trust the page). Pure → fully unit-tested.
 */

import { err, ok, type Result } from "@/shared"
import { type DomModel, type DomNode, LOCATOR_DATA_WHITELIST, type LocatorHint } from "../types"

// Re-export the SSOT whitelist so existing importers of `cdp/collect` keep working.
export { LOCATOR_DATA_WHITELIST } from "../types"

export const NAME_CAP = 200
export const VALUE_CAP = 100
/** Max locator hints retained per node (DoS guard — a page could spam dozens of
 *  whitelisted data-* attrs). The whitelist order is the ladder, so we keep the
 *  first {@link LOCATOR_MAX} in whitelist order. */
export const LOCATOR_MAX = 4
/** Per-hint value cap (bytes/chars) at the trust boundary. */
export const LOCATOR_VALUE_CAP = 200
/** Max recursion depth — a pathological/attacker DOM (10k+ deep) would otherwise
 *  blow the JS stack (in-page walk AND the parse trust boundary) and allocate a
 *  giant tree (R4 audit [5]). Past the cap, children are dropped. */
export const MAX_DEPTH = 1000

/* The two helpers below are SERIALIZED into the page via `.toString()` and run
 * in the browser, NOT in this runtime. They must be self-contained (no closure
 * capture, no imports) and use only DOM globals. They are exported so the
 * in-page logic is unit-tested directly (the rest of the walk stays a
 * real-browser smoke concern). `PageEl` is a minimal structural view of an
 * Element — the runtime `lib.dom` type isn't in this slice's typecheck lib, and
 * a local shape keeps the helpers truly self-contained. */
type PageEl = {
  readonly children?: { readonly length: number }
  readonly textContent?: string | null
  readonly placeholder?: unknown
  getAttribute(name: string): string | null
  // resolved against the real DOM at runtime; structurally `unknown` here.
  readonly ownerDocument: { readonly defaultView: { getComputedStyle(el: PageEl): CSSStyle } }
  readonly offsetParent: unknown
}
type CSSStyle = { readonly display: string; readonly visibility: string; readonly position: string }

/**
 * Ancestor-aware visibility fold (REPORT-jun26 fix #5, mirrors the proven
 * `VISIBLE_FOLD_JS` in cdp-adapter/page-scripts.ts). The OLD check only read the
 * element's OWN computed `display`/`visibility`, so a child of a
 * `display:none` ancestor — whose own computed `display` is NOT `none` — was
 * emitted as clickable (fail-open). `offsetParent === null` is the standard
 * idiom for "this element or an ancestor is display:none", with a
 * `position:fixed` escape hatch (fixed elements legitimately have a null
 * offsetParent). MUST stay self-contained — serialized via `.toString()`.
 */
export function pageVisible(el: PageEl): boolean {
  const st = el.ownerDocument.defaultView.getComputedStyle(el)
  if (st.display === "none" || st.visibility === "hidden") return false
  if (el.getAttribute("aria-hidden") === "true") return false
  // offsetParent is null for: a display:none ancestor (the bug we close), AND
  // for position:fixed (legitimately visible) — so only reject when null and
  // NOT fixed.
  if (el.offsetParent === null && st.position !== "fixed") return false
  return true
}

/**
 * Accessible name (REPORT-jun26 fix #5). aria-label / placeholder always win.
 * Otherwise fall back to `textContent` ONLY for leaf elements (no element
 * children) — the OLD code slurped up to 200 chars of aggregated descendant
 * text on container nodes (a `<div role=region>` wrapping paragraphs), which is
 * snapshot noise, not an accessible name. ARIA "name from content" applies to
 * leaf roles; containers get their name from a label, not their subtree.
 * MUST stay self-contained — serialized via `.toString()`. Cap kept in sync
 * with NAME_CAP (asserted by the unit test).
 */
export function pageAccName(el: PageEl): string {
  const label = el.getAttribute("aria-label")
  if (label) return label.slice(0, 200)
  const placeholder = el.getAttribute("placeholder") || el.placeholder
  if (placeholder) return String(placeholder).slice(0, 200)
  if (el.children && el.children.length > 0) return ""
  return (el.textContent || "").trim().slice(0, 200)
}

/** The script evaluated in-page. Kept as a string (runs in the browser, not in
 *  this runtime). The `pageVisible`/`pageAccName` helpers are SERIALIZED in via
 *  `.toString()` so their logic is unit-tested directly (HELL-WIRE-01 guards the
 *  embedding). The rest of the walk is a real-browser smoke concern. */
export const COLLECT_SCRIPT = `(() => {
  const NAME_CAP = ${NAME_CAP}, VALUE_CAP = ${VALUE_CAP};
  const LOCATOR_WHITELIST = ${JSON.stringify(LOCATOR_DATA_WHITELIST)};
  const LOCATOR_MAX = ${LOCATOR_MAX}, LOCATOR_VALUE_CAP = ${LOCATOR_VALUE_CAP};
  const INTERACTIVE = 'input,textarea,select,button,a[href],summary,[role],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const accName = ${pageAccName.toString()};
  const roleOf = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
  // Stable locators — READ-ONLY getAttribute over the whitelist, in ladder order.
  // Never writes attributes back into the page (no data-*-ref pollution).
  const locatorsOf = (el) => {
    const out = [];
    for (let i = 0; i < LOCATOR_WHITELIST.length && out.length < LOCATOR_MAX; i++) {
      const key = LOCATOR_WHITELIST[i];
      const v = el.getAttribute(key);
      if (v != null && v !== '') out.push({ key: key, value: String(v).slice(0, LOCATOR_VALUE_CAP) });
    }
    return out;
  };
  const states = (el) => {
    const s = [];
    if (el.disabled) s.push('disabled');
    if (el.checked) s.push('checked');
    if (el === document.activeElement) s.push('focused');
    return s;
  };
  const visible = ${pageVisible.toString()};
  const MAX_DEPTH = ${MAX_DEPTH};
  const walk = (el, path, depth) => {
    const node = { backendPath: path, role: roleOf(el), name: accName(el), tag: el.tagName.toLowerCase() };
    const st = states(el); if (st.length) node.states = st;
    if ('value' in el && el.value != null) node.value = String(el.value).slice(0, VALUE_CAP);
    if (el.placeholder) node.placeholder = String(el.placeholder).slice(0, NAME_CAP);
    const lvl = /^H([1-6])$/.exec(el.tagName); if (lvl) node.level = Number(lvl[1]);
    else if (el.getAttribute('aria-level')) node.level = Number(el.getAttribute('aria-level'));
    if (el.tagName === 'A' && el.href) node.url = el.href;
    const locs = locatorsOf(el); if (locs.length) node.locators = locs;
    if (depth >= MAX_DEPTH) return node;
    const kids = [];
    const children = el.shadowRoot ? el.shadowRoot.children : el.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.tagName === 'IFRAME' || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
      if (!visible(c)) continue;
      kids.push(walk(c, path + '/' + i, depth + 1));
    }
    if (kids.length) node.children = kids;
    return node;
  };
  return JSON.stringify({ title: document.title, root: walk(document.body, '/', 0) });
})()`

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

const asStringArray = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === "string")
  return out.length > 0 ? out : undefined
}

type MutableNode = { -readonly [K in keyof DomNode]: DomNode[K] }

/**
 * TRUST BOUNDARY for locator hints. The page is attacker-controlled, so:
 *   - only WHITELISTED keys survive (an arbitrary `data-secret` carrying a
 *     token/PII is dropped — never reaches model context);
 *   - the result is ordered by WHITELIST PRIORITY (not page source order), so a
 *     page cannot reorder the ladder to demote `data-testid`;
 *   - each value is length-capped and the count is capped at {@link LOCATOR_MAX};
 *   - a duplicate key keeps only the FIRST value (deterministic).
 * Returns undefined when nothing survives (keeps the field absent → byte-stable).
 */
/** Extract the (key,value) of ONE raw locator entry iff it is a whitelisted,
 *  well-typed pair; null otherwise. Keeps {@link parseLocators} flat. */
const asWhitelistedLocator = (item: unknown): { key: string; value: string } | null => {
  if (typeof item !== "object" || item === null) return null
  const rec = item as Record<string, unknown>
  const { key, value } = rec
  if (typeof key !== "string" || typeof value !== "string") return null
  if (!(LOCATOR_DATA_WHITELIST as readonly string[]).includes(key)) return null
  return { key, value }
}

const parseLocators = (raw: unknown): readonly LocatorHint[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  // Map whitelisted key → first seen (capped) value (dedupe, deterministic).
  const seen = new Map<string, string>()
  for (const item of raw) {
    const hit = asWhitelistedLocator(item)
    if (hit !== null && !seen.has(hit.key)) seen.set(hit.key, cap(hit.value, LOCATOR_VALUE_CAP))
  }
  // Emit in WHITELIST PRIORITY order (not page source order), capped in count.
  const out: LocatorHint[] = []
  for (const key of LOCATOR_DATA_WHITELIST) {
    if (out.length >= LOCATOR_MAX) break
    const value = seen.get(key)
    if (value !== undefined) out.push({ key, value })
  }
  return out.length > 0 ? out : undefined
}

const applyOptionalFields = (node: MutableNode, o: Record<string, unknown>): void => {
  if (typeof o.tag === "string") node.tag = o.tag
  const states = asStringArray(o.states)
  if (states !== undefined) node.states = states
  if (typeof o.value === "string") node.value = cap(o.value, VALUE_CAP)
  if (typeof o.placeholder === "string") node.placeholder = cap(o.placeholder, NAME_CAP)
  if (typeof o.level === "number" && Number.isInteger(o.level) && o.level >= 1 && o.level <= 6) {
    node.level = o.level
  }
  if (typeof o.url === "string") node.url = o.url
  const locators = parseLocators(o.locators)
  if (locators !== undefined) node.locators = locators
}

// fail-closed: a single malformed child rejects the whole subtree (null), an
// absent/empty children list yields []. Mutually recursive with `asNode` —
// declared as functions so hoisting handles the cycle.
function parseChildren(raw: unknown, depth: number): DomNode[] | null {
  if (depth >= MAX_DEPTH || !Array.isArray(raw)) return []
  const kids: DomNode[] = []
  for (const c of raw) {
    const parsed = asNode(c, depth + 1)
    if (parsed === null) return null
    kids.push(parsed)
  }
  return kids
}

function asNode(v: unknown, depth: number): DomNode | null {
  if (typeof v !== "object" || v === null) return null
  const o = v as Record<string, unknown>
  if (
    typeof o.backendPath !== "string" ||
    typeof o.role !== "string" ||
    typeof o.name !== "string"
  ) {
    return null
  }
  const kids = parseChildren(o.children, depth)
  if (kids === null) return null
  const node: MutableNode = {
    backendPath: o.backendPath,
    role: o.role,
    name: cap(o.name, NAME_CAP),
  }
  applyOptionalFields(node, o)
  if (kids.length > 0) node.children = kids
  return node
}

/** Validate + cap the raw `Runtime.evaluate` payload into a DomModel. The raw
 *  value may be a JSON string (returnByValue on a string expr) or an already
 *  parsed object. Fail-closed: any shape violation ⇒ `Err("malformed")`. */
export const parseDomModel = (raw: unknown): Result<DomModel, "malformed"> => {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return err("malformed")
    }
  }
  if (typeof value !== "object" || value === null) return err("malformed")
  const o = value as Record<string, unknown>
  if (typeof o.title !== "string") return err("malformed")
  const root = asNode(o.root, 0)
  if (root === null) return err("malformed")
  return ok({ title: cap(o.title, NAME_CAP), root })
}
