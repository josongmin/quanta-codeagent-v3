/**
 * Does this source USE a link-local / cloud-metadata address on the NETWORK, or
 * merely mention one as DATA?
 *
 * ## Why the question has to be asked this way
 *
 * This repository's SSRF defences are tested by feeding the classifier the very
 * addresses it must refuse. `classifyHost("169.254.169.254")`, a `DENIED` table
 * of metadata URLs, a `HostResolver` that returns the IMDS address, a scripted
 * fetcher whose 302 target is IMDS — all of these are the guard's INPUT, and
 * every one is a string literal spelling the address out. At the time of
 * writing there are ~20 such files and ~60 such literals, and they are the
 * reason the obvious guard is wrong: a grep for the literal fails all of them,
 * would be "fixed" by an allowlist of those 20 files, and that allowlist is
 * exactly where the next real egress would land.
 *
 * So the question is not "does the address appear" but "is it the TARGET of
 * something that opens a socket". That is a property of the SYNTACTIC POSITION
 * the literal occupies, which is why this walks the TypeScript AST instead of
 * the text.
 *
 * ## The three positions that count as network use
 *
 *   1. TS CALL SITE — the literal flows, through url-shaping expressions only
 *      (template, `+`, `new URL`, an argv array, an options object), into an
 *      argument of a call that performs I/O: `fetch`, `Bun.spawn`, `execSync`,
 *      `net.connect`, `port.navigate`, `new WebSocket`, a `$` shell template…
 *      Flow through a NON-sink callee (`classifyHost`, `redirectTo`, `expect`,
 *      `decideEgress`, `reg.run`) is data and stays data.
 *
 *   2. EMBEDDED SCRIPT — the literal is a chunk of HTML or JS held in a
 *      template (a browser fixture page, a `Runtime.evaluate` expression). The
 *      embedded language has its own call sites, so the embedded source is
 *      PARSED WITH THE SAME CLASSIFIER, recursively. `<div>169.254.169.254</div>`
 *      inside the same page is not a call site and stays data.
 *
 *   3. EMBEDDED COMMAND / MARKUP — an HTML attribute that causes a request
 *      (`src=`, `href=`, `action=`), or a shell word that does (`curl`, `wget`,
 *      `nc`). These are positions in a language that has no TS AST; the check is
 *      still positional, not "the literal appears somewhere in the string".
 *
 * Comments are invisible to all three: a comment is not a string literal, so
 * documenting the boundary in prose can never trip the guard. That asymmetry is
 * the point of doing this structurally.
 *
 * ## No address is spelled out in this file
 *
 * Every pattern below is ASSEMBLED from parts. A detector that contains the
 * literal it detects has to exempt itself, and a self-exemption is a hole the
 * size of the detector. Assembling means this file scores zero occurrences by
 * construction, which its own guard asserts.
 */

import ts from "typescript"

const dotted = (...octets: readonly (string | number)[]): string => octets.join(".")

/** A sample IMDS address, assembled — for fixtures and messages. */
export const LINK_LOCAL_SAMPLE = dotted(169, 254, 169, 254)

/**
 * The address shapes that mean "link-local or cloud metadata service".
 *
 * Each is the canonical spelling plus the encodings this repo's own SSRF tests
 * already exercise (IPv4-mapped, IPv6 link-local, decimal, hex, NAT64), because
 * a guard that only knows the dotted form is evaded by the same tricks the
 * production classifier is tested against.
 */
const ADDRESS_PATTERNS: readonly RegExp[] = [
  // 169.254.0.0/16 — IPv4 link-local, which is where every cloud IMDS lives.
  new RegExp(`(?<![\\d.])${dotted(169, 254)}\\.\\d{1,3}\\.\\d{1,3}(?![\\d.])`, "g"),
  // fe80::/10 — IPv6 link-local.
  /\bfe80::[0-9a-f:]*/gi,
  // NAT64 / IPv6 encodings of the IMDS address (a9fe = 169.254).
  /\ba9fe:a9fe\b/gi,
  // Decimal and hex encodings of 169.254.169.254.
  new RegExp(`\\b${(169 * 2 ** 24 + 254 * 2 ** 16 + 169 * 2 ** 8 + 254).toString(10)}\\b`, "g"),
  new RegExp(`\\b0x${(169 * 2 ** 24 + 254 * 2 ** 16 + 169 * 2 ** 8 + 254).toString(16)}\\b`, "gi"),
  // The GCE metadata name.
  /\bmetadata\.google\.internal\b/gi,
]

/** Every address occurrence in a piece of text, with its offset. */
const addressHits = (
  text: string,
): readonly { readonly address: string; readonly at: number }[] => {
  const out: { address: string; at: number }[] = []
  for (const pattern of ADDRESS_PATTERNS) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    )
    for (;;) {
      const m = re.exec(text)
      if (m === null) break
      out.push({ address: m[0], at: m.index })
      if (m[0] === "") re.lastIndex += 1
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Cheap substring anchors for the patterns above — one `indexOf` scan instead of
 * six regex passes. Measured over this repo's 3.7k test sources: the regex-only
 * form spent most of its time proving the 99% of files that mention no address
 * mention no address.
 */
const ADDRESS_ANCHORS: readonly string[] = [
  dotted(169, 254),
  // Assembled, like everything else here: a plain "fe80::" would make this file
  // score an occurrence against its own scan, and the only cure for that is a
  // self-exemption — a hole the size of the detector.
  `fe${80}::`,
  "a9fe",
  (169 * 2 ** 24 + 254 * 2 ** 16 + 169 * 2 ** 8 + 254).toString(10),
  `metadata.google.${"internal"}`,
]

/** Does this text contain a link-local / metadata address at all? */
export const mentionsLinkLocal = (text: string): boolean => {
  if (!ADDRESS_ANCHORS.some((a) => text.includes(a))) return false
  return addressHits(text).length > 0
}

/**
 * Callees whose final identifier means "this opens a socket or starts a
 * process". Curated deliberately: generic names (`get`, `post`, `send`, `run`)
 * are NOT here, because `reg.run("browser_navigate", …)` is a tool-registry
 * dispatch the suite asserts is DENIED, not an egress.
 */
export const NETWORK_SINKS: ReadonlySet<string> = new Set([
  "fetch",
  "request",
  "connect",
  "createConnection",
  "navigate",
  "goto",
  "sendBeacon",
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
])

/**
 * Receivers that make ANY method call on them network-shaped. `http.get`,
 * `https.request`, `net.connect`, `Bun.spawn`, `Bun.connect` — the method names
 * are too generic to list on their own, but qualified by these they are not.
 */
const NETWORK_RECEIVERS: ReadonlySet<string> = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "Bun",
  "undici",
  "axios",
])

/** The Bun shell tag — `` $`curl …` `` runs a command. */
const SHELL_TAGS: ReadonlySet<string> = new Set(["$", "sh", "shell"])

const rootIdentifier = (node: ts.Expression): string | undefined => {
  let cursor: ts.Node = node
  for (;;) {
    if (ts.isIdentifier(cursor)) return cursor.text
    if (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
      cursor = cursor.expression
      continue
    }
    if (ts.isCallExpression(cursor) || ts.isNonNullExpression(cursor)) {
      cursor = cursor.expression
      continue
    }
    if (ts.isParenthesizedExpression(cursor)) {
      cursor = cursor.expression
      continue
    }
    return undefined
  }
}

const finalIdentifier = (node: ts.Expression): string | undefined => {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isParenthesizedExpression(node)) return finalIdentifier(node.expression)
  if (ts.isNonNullExpression(node)) return finalIdentifier(node.expression)
  return undefined
}

/** The sink name if this call/new performs I/O, else undefined. */
const sinkNameOf = (call: ts.CallExpression | ts.NewExpression): string | undefined => {
  const final = finalIdentifier(call.expression)
  if (final !== undefined && NETWORK_SINKS.has(final)) return final
  const root = rootIdentifier(call.expression)
  if (root !== undefined && NETWORK_RECEIVERS.has(root)) {
    return final === undefined ? root : `${root}.${final}`
  }
  return undefined
}

/**
 * Expression kinds a URL can legitimately travel through on its way to a sink
 * WITHOUT changing what it is. Everything else terminates the walk — most
 * importantly a call to a non-sink function, which consumes the string as data.
 */
const isUrlShaping = (node: ts.Node): boolean =>
  ts.isTemplateExpression(node) ||
  ts.isTemplateSpan(node) ||
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isArrayLiteralExpression(node) ||
  ts.isObjectLiteralExpression(node) ||
  ts.isPropertyAssignment(node) ||
  ts.isSpreadElement(node) ||
  ts.isSpreadAssignment(node) ||
  (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
  ts.isTemplateLiteralTypeSpan(node)

/** Calls that return the url they were given, re-shaped. */
const URL_SHAPING_CALLS: ReadonlySet<string> = new Set([
  "encodeURI",
  "encodeURIComponent",
  "String",
  "toString",
  "href",
])

/**
 * Walk upward from a literal to the sink that consumes it, if any.
 *
 * `new URL(x)` is transparent (it re-shapes a URL, it does not fetch it); a
 * tagged template with a shell tag IS a sink; an argument list of a sink call is
 * the terminal answer.
 */
const enclosingSink = (literal: ts.Node): string | undefined => sinkWalk(literal).sink

/**
 * The upward walk, reported in full: the sink if one consumes the value, plus
 * where the walk STOPPED, which is what one-hop binding flow needs.
 */
interface SinkWalkResult {
  readonly sink?: string
  readonly terminalChild: ts.Node
  readonly terminalParent?: ts.Node
}

/** One step of the walk through a call: stop with a sink, stop as data, or pass through. */
type CallStep = { readonly kind: "stop"; readonly sink?: string } | { readonly kind: "through" }

const stepThroughCall = (call: ts.CallExpression | ts.NewExpression, child: ts.Node): CallStep => {
  // Only ARGUMENT position counts — a literal used as the CALLEE is not a url.
  if (!(call.arguments ?? []).some((a) => a === child)) return { kind: "stop" }
  const sink = sinkNameOf(call)
  if (sink !== undefined) return { kind: "stop", sink }
  // `new URL(addr)` / `new URL(addr, base)` re-shapes the url; keep walking.
  const name = finalIdentifier(call.expression)
  if (ts.isNewExpression(call) && name === "URL") return { kind: "through" }
  if (name !== undefined && URL_SHAPING_CALLS.has(name)) return { kind: "through" }
  // A non-sink callee consumed the string. It is data from here on.
  return { kind: "stop" }
}

/** The walk's answer AT this parent, or `undefined` to keep climbing. */
const stopAt = (parent: ts.Node, child: ts.Node): SinkWalkResult | undefined => {
  const stopped = (sink?: string): SinkWalkResult =>
    sink === undefined
      ? { terminalChild: child, terminalParent: parent }
      : { sink, terminalChild: child, terminalParent: parent }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const step = stepThroughCall(parent, child)
    return step.kind === "through" ? undefined : stopped(step.sink)
  }
  if (ts.isTaggedTemplateExpression(parent)) {
    const tag = finalIdentifier(parent.tag)
    return stopped(tag !== undefined && SHELL_TAGS.has(tag) ? `\`${tag}\`` : undefined)
  }
  return isUrlShaping(parent) ? undefined : stopped()
}

const sinkWalk = (literal: ts.Node): SinkWalkResult => {
  let child: ts.Node = literal
  let parent = literal.parent
  while (parent !== undefined) {
    const stop = stopAt(parent, child)
    if (stop !== undefined) return stop
    child = parent
    parent = parent.parent
  }
  return { terminalChild: child }
}

/**
 * ONE-HOP BINDING FLOW.
 *
 * `const host = "<addr>"; await fetch(\`http://${host}/\`)` is the same egress as
 * `fetch("http://<addr>/")`, and a purely positional walk calls the first one
 * data — the literal's parent is a variable declaration, not a call. So when the
 * walk terminates on a `const`/`let` bound to a plain identifier, every OTHER
 * reference to that identifier in the file is re-walked.
 *
 * ONE hop, deliberately. Two hops needs a scope-aware resolver (shadowing,
 * re-assignment, closures) and this has no type checker; one hop covers the
 * shape that actually occurs — name the address, then use the name — without
 * pretending to an analysis it cannot perform.
 */
const sinkViaBinding = (literal: ts.Node, sourceFile: ts.SourceFile): string | undefined => {
  const { terminalChild, terminalParent } = sinkWalk(literal)
  if (terminalParent === undefined || !ts.isVariableDeclaration(terminalParent)) return undefined
  if (terminalParent.initializer !== terminalChild) return undefined
  if (!ts.isIdentifier(terminalParent.name)) return undefined
  const bound = terminalParent.name.text
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isIdentifier(node) && node.text === bound && node !== terminalParent.name) {
      const sink = enclosingSink(node)
      if (sink !== undefined) found = `${sink} via \`${bound}\``
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * An HTML attribute whose value the browser FETCHES. Position in markup, not
 * mere presence in a string — `<div>{addr}</div>` is inert text.
 */
const HTML_REQUESTING_ATTRIBUTE =
  /\b(?:src|href|action|formaction|data|poster|srcset)\s*=\s*["']?[^"'\s>]*$/i

/**
 * A shell word that performs a request, IMMEDIATELY before the address (only
 * option flags may intervene).
 *
 * Tightened after measurement: an earlier version allowed 80 arbitrary
 * characters between the word and the address, and listed `http` among the
 * words. `http` then matched the SCHEME of every url — `"http://<addr>"` — and
 * seven test-table entries in five files were reported as shell commands. A
 * classifier that cannot tell a scheme from a command is the grep it replaced.
 */
const SHELL_REQUESTING_WORD = /\b(?:curl|wget|ncat|nc|telnet|httpie|rsync)\s+(?:-{1,2}[^\s]+\s+)*$/i

/** One classified appearance of a link-local / metadata address. */
export interface LinkLocalOccurrence {
  readonly file: string
  readonly line: number
  readonly column: number
  /**
   * Index of the address WITHIN the `source` string that was classified.
   *
   * Not cosmetic: embedded-source rules re-classify a fragment and must know
   * WHICH occurrence in it came back network. Without this, one real
   * `fetch(<addr>)` inside a page marked every other mention of the address in
   * the same page — an inert `<div><addr></div>` included — as network use.
   * Measured on the injection fixture that found it.
   */
  readonly offset: number
  readonly address: string
  readonly verdict: "network" | "data"
  /** What made it network use, or how it is consumed as data. */
  readonly site: string
  /** A short excerpt of the literal, for the failure message. */
  readonly excerpt: string
}

const excerptOf = (text: string, at: number): string => {
  const from = Math.max(0, at - 40)
  return `${from > 0 ? "…" : ""}${text.slice(from, at + 60).replace(/\s+/g, " ")}`
}

/**
 * Classify the embedded source a literal carries.
 *
 * HTML: every `<script>` body is re-parsed with the SAME classifier, so an
 * in-page `fetch(addr)` is caught by rule 1 one level down. Requesting
 * attributes are checked positionally. A bare JS/shell string is tried as JS,
 * then as a command line.
 */
const embeddedVerdict = (
  text: string,
  at: number,
  depth: number,
): { readonly network: boolean; readonly site: string } => {
  // Embedded source can itself embed source. Two levels is every real case in
  // this tree (a template holding HTML holding a <script>); the bound exists so
  // a pathological fixture cannot recurse without end.
  if (depth > 2) return { network: false, site: "embedded depth limit" }
  // 1. <script> bodies — re-parse with the same rules.
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
  for (;;) {
    const m = scriptRe.exec(text)
    if (m === null) break
    const body = m[1] ?? ""
    const bodyStart = m.index + m[0].indexOf(body)
    if (at < bodyStart || at >= bodyStart + body.length) continue
    const inner = classifyLinkLocalUsages("<embedded script>", body, depth + 1)
    // THIS occurrence, not merely SOME occurrence in the same script.
    const hit = inner.find((o) => o.verdict === "network" && o.offset === at - bodyStart)
    if (hit !== undefined) return { network: true, site: `embedded <script> → ${hit.site}` }
    return { network: false, site: "embedded <script> (inert text)" }
  }
  // 2. A requesting HTML attribute.
  const before = text.slice(Math.max(0, at - 120), at)
  if (HTML_REQUESTING_ATTRIBUTE.test(before)) {
    return { network: true, site: "html requesting attribute" }
  }
  // 3. The whole literal as JS (a `Runtime.evaluate` expression, an eval body).
  if (/[(){};=]/.test(text)) {
    const inner = classifyLinkLocalUsages("<embedded js>", text, depth + 1)
    const hit = inner.find((o) => o.verdict === "network" && o.offset === at)
    if (hit !== undefined) return { network: true, site: `embedded js → ${hit.site}` }
  }
  // 4. A shell command line.
  if (SHELL_REQUESTING_WORD.test(before)) {
    return { network: true, site: "embedded shell command" }
  }
  return { network: false, site: "inert embedded text" }
}

/**
 * Every link-local / metadata address in `source`, each classified `network` or
 * `data`.
 *
 * `fileName` is a label only — nothing is read from disk, so the same function
 * classifies a repository file and a synthetic fixture identically. That is what
 * lets the guard prove red-on-injection with the instrument it actually ships.
 */
export const classifyLinkLocalUsages = (
  fileName: string,
  source: string,
  depth = 0,
): readonly LinkLocalOccurrence[] => {
  const sourceFile = ts.createSourceFile(
    fileName.endsWith(".ts") ? fileName : `${fileName}.ts`,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )
  const out: LinkLocalOccurrence[] = []

  /**
   * Record every address inside ONE literal chunk.
   *
   * `chunk` is what the literal itself holds; `doc`/`docBase` are the DOCUMENT
   * the embedded-source rules should read and where this chunk sits in it. For a
   * plain literal the two are the same thing; for a template chunk the document
   * is the WHOLE template, so an embedded `<script>` split across `${…}`
   * substitutions is still seen as one script rather than as fragments.
   */
  const record = (
    node: ts.Node,
    chunk: string,
    chunkStartInFile: number,
    doc: string,
    docBase: number,
  ): void => {
    for (const hit of addressHits(chunk)) {
      const absolute = chunkStartInFile + hit.at
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        Math.min(absolute, Math.max(source.length - 1, 0)),
      )
      const sink = enclosingSink(node) ?? sinkViaBinding(node, sourceFile)
      const embedded =
        sink === undefined ? embeddedVerdict(doc, docBase + hit.at, depth) : undefined
      out.push({
        file: fileName,
        line: line + 1,
        column: character + 1,
        offset: absolute,
        address: hit.address,
        verdict: sink !== undefined || embedded?.network === true ? "network" : "data",
        site: sink !== undefined ? `argument of ${sink}(…)` : (embedded?.site ?? "data"),
        excerpt: excerptOf(chunk, hit.at),
      })
    }
  }

  /** Where a template chunk sits inside the whole template literal. */
  const templateDoc = (
    node: ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail,
  ): { readonly doc: string; readonly base: number } => {
    const owner = ts.isTemplateHead(node) ? node.parent : node.parent.parent
    return {
      doc: owner.getText(sourceFile),
      base: node.getStart(sourceFile) + 1 - owner.getStart(sourceFile),
    }
  }

  const visit = (node: ts.Node): void => {
    // +1 for the opening quote/backtick: the literal's text starts one char in.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text, node.getStart(sourceFile) + 1, node.text, 0)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const { doc, base } = templateDoc(node)
      record(node, node.text, node.getStart(sourceFile) + 1, doc, base)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}

/** Only the occurrences that are real network use. */
export const linkLocalNetworkUses = (
  fileName: string,
  source: string,
): readonly LinkLocalOccurrence[] =>
  classifyLinkLocalUsages(fileName, source).filter((o) => o.verdict === "network")
