/**
 * Browser slice — CDP adapter page-script builders (extracted from
 * `../cdp-adapter.ts` to keep that orchestrator under the god-module line cap).
 *
 * Every export here is a PURE string builder producing the in-page JS the
 * adapter injects via `Runtime.evaluate`. They reference no module-internal
 * state — only their arguments and each other — so they live cleanly outside the
 * adapter closure. element refs resolve to a raw child-index path; click/type
 * run as in-page JS (`.click()` / value+input event) — NOT `Input.*` CDP.
 */

const pathIndices = (path: string): number[] =>
  path
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => Number(seg))

export const resolveJs = (path: string): string => {
  const idx = JSON.stringify(pathIndices(path))
  return `(() => { let el = document.body; for (const i of ${idx}) { if (!el) return null; el = (el.shadowRoot ? el.shadowRoot.children : el.children)[i]; } return el; })()`
}

export const clickJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return false; if (el.focus) el.focus(); el.click(); return true; })()`

// Branches on element kind (R1 audit [10]): form controls get `.value` set +
// change event; contenteditable gets text appended into the node; anything else
// returns false so the tool surfaces element-not-found instead of silently
// writing a junk `value` property.
export const typeJs = (path: string, text: string, clear: boolean): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const t = ${JSON.stringify(text)};
    if (el.focus) el.focus();
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      if (${clear ? "true" : "false"}) el.value = '';
      el.value = (el.value || '') + t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      if (${clear ? "true" : "false"}) el.textContent = '';
      el.textContent = (el.textContent || '') + t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  })()`

export const fillJs = (path: string, value: string): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const v = ${JSON.stringify(value)};
    if (el.focus) el.focus();
    if ('value' in el) { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }
    if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new Event('input',{bubbles:true})); return true; }
    return false;
  })()`

export const selectJs = (path: string, values: readonly string[]): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el || el.tagName !== 'SELECT') return false;
    const vs = ${JSON.stringify(values)};
    for (const o of el.options) o.selected = vs.includes(o.value);
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`

export const scrollToRefJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return false; el.scrollIntoView({block:'center',inline:'center'}); return true; })()`

export const scrollByJs = (dx: number, dy: number): string =>
  `(() => { window.scrollBy(${dx}, ${dy}); return true; })()`

export const rectJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`

// SINGLE SOURCE for the "is this element visible" fold (JS source injected into
// the page). Assumes `el`, `cs` (= getComputedStyle(el)) and `r` (=
// el.getBoundingClientRect()) are in scope. Shared by boxJs + readJs so the two
// can never drift on what "visible" means.
const VISIBLE_FOLD_JS =
  "!!(el.offsetParent || (cs.position === 'fixed' && cs.display !== 'none')) && cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0)"

// Full bounding rect + visibility (the same fold readJs(visible) uses) for the
// model-facing bounding_box. Returns null when the ref's element is missing so
// the adapter surfaces element-not-found rather than a junk zero-rect.
export const boxJs = (path: string): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible = ${VISIBLE_FOLD_JS};
    return { x: r.x, y: r.y, w: r.width, h: r.height, visible };
  })()`

// Cosmetic highlight: append ONE absolutely-positioned overlay div over the
// element's viewport rect (outline only, NO fill, pointer-events:none so it
// never intercepts clicks), removing any prior overlay first so a double-
// highlight never leaks stacked divs, and self-removing after `durationMs`.
// Mutates nothing on the page's own DOM. Returns false (→ element-not-found)
// when the ref is stale. `color` is JSON.stringify-escaped at the call site.
const HIGHLIGHT_OVERLAY_ID = "__quanta_highlight_overlay__"
export const highlightJs = (path: string, color: string, durationMs: number): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const ID = ${JSON.stringify(HIGHLIGHT_OVERLAY_ID)};
    const prior = document.getElementById(ID);
    if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
    const r = el.getBoundingClientRect();
    const o = document.createElement('div');
    o.id = ID;
    o.style.position = 'fixed';
    o.style.left = r.x + 'px';
    o.style.top = r.y + 'px';
    o.style.width = r.width + 'px';
    o.style.height = r.height + 'px';
    o.style.outline = '3px solid ' + ${JSON.stringify(color)};
    o.style.background = 'transparent';
    o.style.pointerEvents = 'none';
    o.style.zIndex = '2147483647';
    document.body.appendChild(o);
    setTimeout(() => { const n = document.getElementById(ID); if (n && n.parentNode) n.parentNode.removeChild(n); }, ${Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 1500});
    return true;
  })()`

// Read a precise property off the resolved element. Returns a tagged object so
// the adapter can distinguish "element missing" (null) from a falsy-but-present
// value (e.g. visible:false, empty text). text uses innerText (rendered text);
// attribute returns "" when the attr is absent; visible folds offsetParent +
// computed-style + a non-zero rect.
export const readJs = (path: string, what: string, attr: string | undefined): string => {
  const a = JSON.stringify(attr ?? "")
  const w = JSON.stringify(what)
  return `(() => {
    const el = ${resolveJs(path)};
    if (!el) return null;
    const what = ${w};
    if (what === 'text') return { value: (el.innerText !== undefined ? el.innerText : el.textContent) || '' };
    if (what === 'attribute') { const v = el.getAttribute(${a}); return { value: v === null ? '' : v }; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vis = ${VISIBLE_FOLD_JS};
    return { value: vis };
  })()`
}

export const selectorPresentJs = (selector: string): string =>
  `(() => { try { return !!document.querySelector(${JSON.stringify(selector)}); } catch { return false; } })()`
