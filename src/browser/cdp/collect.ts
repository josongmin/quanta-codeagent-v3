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
import type { DomModel, DomNode } from "../types"

export const NAME_CAP = 200
export const VALUE_CAP = 100
/** Max recursion depth — a pathological/attacker DOM (10k+ deep) would otherwise
 *  blow the JS stack (in-page walk AND the parse trust boundary) and allocate a
 *  giant tree (R4 audit [5]). Past the cap, children are dropped. */
export const MAX_DEPTH = 1000

/** The script evaluated in-page. Kept as a string (runs in the browser, not in
 *  this runtime). Correctness of the walk is a real-browser smoke concern; the
 *  parse of its output is what we unit-test. */
export const COLLECT_SCRIPT = `(() => {
  const NAME_CAP = ${NAME_CAP}, VALUE_CAP = ${VALUE_CAP};
  const INTERACTIVE = 'input,textarea,select,button,a[href],summary,[role],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const accName = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim()).slice(0, NAME_CAP);
  const roleOf = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
  const states = (el) => {
    const s = [];
    if (el.disabled) s.push('disabled');
    if (el.checked) s.push('checked');
    if (el === document.activeElement) s.push('focused');
    return s;
  };
  const visible = (el) => {
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
  };
  const MAX_DEPTH = ${MAX_DEPTH};
  const walk = (el, path, depth) => {
    const node = { backendPath: path, role: roleOf(el), name: accName(el), tag: el.tagName.toLowerCase() };
    const st = states(el); if (st.length) node.states = st;
    if ('value' in el && el.value != null) node.value = String(el.value).slice(0, VALUE_CAP);
    if (el.placeholder) node.placeholder = String(el.placeholder).slice(0, NAME_CAP);
    const lvl = /^H([1-6])$/.exec(el.tagName); if (lvl) node.level = Number(lvl[1]);
    else if (el.getAttribute('aria-level')) node.level = Number(el.getAttribute('aria-level'));
    if (el.tagName === 'A' && el.href) node.url = el.href;
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
