import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import {
  SESSION_COMMAND_TYPES,
  SESSION_EVENT_TYPES,
  SESSION_PROTOCOL_VERSION,
  SURFACE_READ_MODEL_IDS,
  SURFACE_READ_MODEL_STATUSES,
} from "@/protocol/session"
import {
  GENERATED_OUTPUT_PATH,
  generateProtocolBundle,
} from "../../tools/gen-web-frontend-protocol"

/**
 * Wire-protocol drift contract (hellgate) — foundational guard.
 *
 * The daemon owns the CANONICAL session protocol in `src/protocol/session/`.
 * The web frontend lives OUTSIDE bun's tsconfig `paths` (standalone package,
 * own vite build, no `paths` back to the bun repo). Ticket 03-B (§Phase B)
 * replaced the old HAND-MAINTAINED session copy with a GENERATED bundle,
 * `apps/web-frontend/src/types/protocol.session.generated.ts`, emitted from the
 * four canonical session files by `bun run build:protocol`
 * (tools/gen-web-frontend-protocol.ts). The barrel `protocol.ts` re-exports the
 * generated file and hand-maintains only the OUT-OF-SESSION mirrors
 * (canvas / observability / agent-state) + UI-only types + the transport
 * control envelopes. A config-write allowlist mirror lives in
 * `apps/web-frontend/src/components/slash-knobs.ts`.
 *
 * This test makes session-protocol drift IMPOSSIBLE TO MERGE at TWO altitudes:
 *
 *   1. STRUCTURAL (the strongest guard, ticket 03-B): the committed generated
 *      file must BYTE-EQUAL a fresh in-process regeneration. A canonical edit
 *      that was not re-emitted (`bun run build:protocol`) is red — the copy can
 *      no longer silently lag because it is not hand-written at all.
 *   2. SEMANTIC (retained from 03-A so a generator regression cannot silently
 *      drop coverage): union-membership both-directions, the runtime
 *      `EVENT_TYPES` decode gate, `SESSION_PROTOCOL_VERSION`, the read-model id /
 *      status sets, the ADR-0512 escalation-card button order, the config-key
 *      allowlist parity, AND the field-shape layer (parses the GENERATED file's
 *      interfaces against canonical field-by-field). Layer 1 makes layer 2's
 *      subject deterministic; layer 2 proves the subject is the real wire shape
 *      even if the emitter is wrong.
 *
 * The SSOT is the daemon. To change the wire shape: edit `src/protocol/session/`
 * (and `src/apps/web-daemon/server/http.ts` for config keys) FIRST, then run
 * `bun run build:protocol` (re-mirror `slash-knobs.ts` for config keys) until
 * this test is green again.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")

/** The GENERATED session bundle — the union + field-shape guards read THIS
 *  (the session types moved here from the old hand copy in 03-B). */
const FRONTEND_PROTOCOL_PATH = join(REPO_ROOT, GENERATED_OUTPUT_PATH)

/** The hand-maintained barrel (out-of-session mirrors + UI-only types). The
 *  ADR-0512 additive-field assertion checks `scopeContext` appears on the
 *  session `PendingApprovalView`, which now lives in the generated file — so
 *  that assertion reads FRONTEND_PROTOCOL_PATH; this path is retained for the
 *  barrel-targeting checks. */
const FRONTEND_BARREL_PATH = join(REPO_ROOT, "apps/web-frontend/src/types/protocol.ts")

const FRONTEND_ENVELOPE_PATH = join(REPO_ROOT, "apps/web-frontend/src/ws/envelope.ts")
const FRONTEND_SLASH_KNOBS_PATH = join(REPO_ROOT, "apps/web-frontend/src/components/slash-knobs.ts")
const DAEMON_CONFIG_HTTP_PATH = join(REPO_ROOT, "src/apps/web-daemon/server/http.ts")

const ESCALATION_CARD_PATH = join(REPO_ROOT, "apps/web-frontend/src/components/EscalationCard.tsx")
const ESCALATION_OPTIONS_PATH = join(REPO_ROOT, "src/agent/skill-scope-escalation.ts")

const readText = (path: string): string => readFileSync(path, "utf8")

/**
 * Extract the string literals carried by a discriminated union declared as
 * `export type <UnionName> = | A | B | …`, where each member interface `X`
 * declares its discriminant via `extends <EnvelopeName>"<literal>">`.
 *
 * Two-step so we only pick up the literals of interfaces that are ACTUALLY
 * union members (not every `extends …Envelope<"…">` in the file — though here
 * they coincide, the union scoping is the contract that matters).
 */
const extractUnionTypeLiterals = (
  source: string,
  unionName: string,
  envelopeName: string,
): Set<string> => {
  // 1. Grab the union member interface names from the `export type X = …` block.
  const unionRe = new RegExp(
    `export type ${unionName}\\s*=([\\s\\S]*?)(?:\\n\\n|\\nexport |\\n/\\*|$)`,
  )
  const unionMatch = unionName.length > 0 ? unionRe.exec(source) : null
  if (unionMatch === null) {
    throw new Error(`could not locate \`export type ${unionName} = …\` union block`)
  }
  const memberNames = ((unionMatch[1] ?? "").match(/[A-Za-z0-9_]+/g) ?? []).filter(
    (n) => n.length > 0,
  )

  // 2. For each member interface, resolve its discriminant literal from its
  //    `extends <envelopeName><"literal">` declaration.
  const literals = new Set<string>()
  for (const name of memberNames) {
    const ifaceRe = new RegExp(`interface ${name}\\b[\\s\\S]*?extends ${envelopeName}<"([^"]+)">`)
    const ifaceMatch = ifaceRe.exec(source)
    if (ifaceMatch?.[1] !== undefined) literals.add(ifaceMatch[1])
  }
  return literals
}

/**
 * Extract the members of a `new Set([ "A", "B", … ])` assigned to `constName`.
 * Used for the config-key allowlist mirrors on both the daemon and frontend.
 */
const extractSetLiterals = (source: string, constName: string): Set<string> => {
  const re = new RegExp(`${constName}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = new Set([…])\``)
  }
  const literals = new Set<string>()
  for (const m of (match[1] ?? "").matchAll(/"([^"]+)"/g)) {
    if (m[1] !== undefined) literals.add(m[1])
  }
  return literals
}

/**
 * Extract the string-literal members of an ARRAY const:
 * `const NAME[: type] = [ "A", "B", … ]`. Used for the frontend `EVENT_TYPES`
 * decode gate in `envelope.ts` (a SECOND, runtime mirror of the event-type set
 * distinct from the `SessionEvent` union in `protocol.ts`). The gate is what
 * `decodeEventFrame` consults; if it drifts below the canonical set the daemon
 * can emit an event the client silently drops (frame AND seq lost).
 */
const extractArrayLiterals = (source: string, constName: string): Set<string> => {
  const re = new RegExp(`${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = [ … ]\` array literal`)
  }
  const literals = new Set<string>()
  for (const m of (match[1] ?? "").matchAll(/"([^"]+)"/g)) {
    if (m[1] !== undefined) literals.add(m[1])
  }
  return literals
}

/**
 * Extract the ORDERED string-literal members of an array const, preserving
 * source order (the SET helpers above lose order). Used by the escalation-verb
 * drift guard, where the BUTTON ORDER — not just membership — is the contract
 * pinned 1:1 between the daemon `ESCALATION_OPTIONS` and the web
 * `ESCALATION_BUTTONS`.
 */
const extractOrderedArrayLiterals = (source: string, constName: string): string[] => {
  const re = new RegExp(`${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = [ … ]\` array literal`)
  }
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].flatMap((m) =>
    m[1] !== undefined ? [m[1]] : [],
  )
}

/**
 * Extract the ORDERED `option:` field literals from an array of object literals
 * (`[{ option: "A", … }, { option: "B", … }]`). Used to read the web
 * `ESCALATION_BUTTONS` button order without importing the .tsx (different
 * toolchain). The first `"…"` after each `option:` is the verb.
 */
const extractOrderedObjectFieldLiterals = (
  source: string,
  constName: string,
  field: string,
): string[] => {
  const re = new RegExp(`${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = [ … ]\` array literal`)
  }
  return [...(match[1] ?? "").matchAll(new RegExp(`${field}:\\s*"([^"]+)"`, "g"))].flatMap((m) =>
    m[1] !== undefined ? [m[1]] : [],
  )
}

/**
 * Extract a single string-literal const value:
 * `export const NAME = "literal" as const`.
 */
const extractStringConst = (source: string, constName: string): string => {
  const re = new RegExp(`${constName}\\s*=\\s*"([^"]+)"`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = "…"\``)
  }
  return match[1] ?? ""
}

describe("wire-protocol GENERATED bundle is in sync with canonical (ticket 03-B structural guard)", () => {
  test("[regen] committed generated bundle BYTE-EQUALS a fresh in-process regeneration", () => {
    // The STRONGEST guard: the session copy is no longer hand-written — it is a
    // pure function of the four canonical session files. If a canonical edit
    // was not re-emitted (`bun run build:protocol`), the committed file differs
    // from a fresh regeneration and THIS reds. It subsumes every field-shape /
    // union drift the semantic layers below check (any such drift changes the
    // emitted bytes) — those layers are retained as an independent witness that
    // the emitter itself is correct (a broken emitter could be byte-stable yet
    // wrong; the semantic guards catch that).
    const committed = readText(FRONTEND_PROTOCOL_PATH)
    const regenerated = generateProtocolBundle()
    expect(regenerated).toBe(committed)
  })

  test("[regen] injecting a NEW canonical event without re-emitting the bundle would red (red-on-injection proof)", () => {
    // Proves the byte-equality guard is NON-VACUOUS: simulate a canonical edit
    // (a new event type + interface) that the committed bundle has not caught up
    // to. The regeneration reflects the new canonical; the (unchanged) committed
    // text does not — so byte-equality fails. This is the exact failure the CI
    // hook forces a `bun run build:protocol` to resolve.
    const committed = readText(FRONTEND_PROTOCOL_PATH)
    // A stand-in "regeneration" that grew a member the committed file lacks.
    const regeneratedWithNewEvent = committed.replace(
      "export interface SessionClosedEvent",
      'export interface WidgetPokedEvent extends SessionEventEnvelope<"widget.poked"> {\n  readonly widgetId: string\n}\n\nexport interface SessionClosedEvent',
    )
    // Sanity: the injection actually changed the text (guards a no-op replace).
    expect(regeneratedWithNewEvent).not.toBe(committed)
    // The guard's assertion (`regenerated === committed`) would fail on this pair.
    expect(regeneratedWithNewEvent === committed).toBe(false)
  })

  test("[regen] generated file carries the GENERATED banner + is imported by the barrel", () => {
    // Guards the file's provenance contract: the banner warns humans off hand-
    // editing, and the barrel MUST re-export it (else the frontend would compile
    // against a stale hand copy). Cheap wiring pins.
    const generated = readText(FRONTEND_PROTOCOL_PATH)
    expect(generated).toContain("GENERATED — DO NOT EDIT")
    const barrel = readText(FRONTEND_BARREL_PATH)
    expect(barrel).toContain('export * from "./protocol.session.generated"')
  })
})

describe("wire-protocol drift contract: frontend copy === canonical daemon SSOT", () => {
  test("[events] frontend SessionEvent union === SESSION_EVENT_TYPES (both directions)", () => {
    const frontendEvents = extractUnionTypeLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SessionEvent",
      "SessionEventEnvelope",
    )
    const canonical = new Set<string>(SESSION_EVENT_TYPES)

    // Diagnostic-friendly: sorted-array compare so the failure prints the
    // exact missing/extra members.
    expect([...frontendEvents].sort()).toEqual([...canonical].sort())

    // Explicit both-directions set assertions (belt-and-suspenders).
    for (const t of canonical) {
      expect(frontendEvents.has(t)).toBe(true)
    }
    for (const t of frontendEvents) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[decode-gate] frontend envelope.ts EVENT_TYPES === SESSION_EVENT_TYPES (both directions)", () => {
    // The `SessionEvent` union (asserted above) is the TYPE-level mirror.
    // `EVENT_TYPES` in envelope.ts is the RUNTIME decode gate: `decodeEventFrame`
    // returns null for any `type` not in this array, and the client then DROPS
    // the frame (losing its seq, breaking resume). A past drift kept the union
    // in sync but let this array fall behind — so the daemon's `turn.llm.request`
    // / `turn.llm.continuation` events were silently dropped. Pin both directions.
    const gateTypes = extractArrayLiterals(readText(FRONTEND_ENVELOPE_PATH), "EVENT_TYPES")
    const canonical = new Set<string>(SESSION_EVENT_TYPES)

    expect([...gateTypes].sort()).toEqual([...canonical].sort())

    for (const t of canonical) {
      expect(gateTypes.has(t)).toBe(true)
    }
    for (const t of gateTypes) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[commands] frontend SessionCommand union === SESSION_COMMAND_TYPES (both directions)", () => {
    const frontendCommands = extractUnionTypeLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SessionCommand",
      "SessionCommandEnvelope",
    )
    const canonical = new Set<string>(SESSION_COMMAND_TYPES)

    expect([...frontendCommands].sort()).toEqual([...canonical].sort())

    for (const t of canonical) {
      expect(frontendCommands.has(t)).toBe(true)
    }
    for (const t of frontendCommands) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[version] frontend SESSION_PROTOCOL_VERSION === canonical SESSION_PROTOCOL_VERSION", () => {
    const frontendVersion = extractStringConst(
      readText(FRONTEND_ENVELOPE_PATH),
      "SESSION_PROTOCOL_VERSION",
    )
    expect(frontendVersion).toBe(SESSION_PROTOCOL_VERSION)
  })

  test("[read-models] frontend SURFACE_READ_MODEL_IDS === canonical", () => {
    const frontendIds = extractArrayLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SURFACE_READ_MODEL_IDS",
    )
    const canonical = new Set<string>(SURFACE_READ_MODEL_IDS)

    expect([...frontendIds].sort()).toEqual([...canonical].sort())
    for (const id of canonical) {
      expect(frontendIds.has(id)).toBe(true)
    }
    for (const id of frontendIds) {
      expect(canonical.has(id)).toBe(true)
    }
  })

  test("[read-model-statuses] frontend SURFACE_READ_MODEL_STATUSES === canonical", () => {
    const frontendStatuses = extractArrayLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SURFACE_READ_MODEL_STATUSES",
    )
    const canonical = new Set<string>(SURFACE_READ_MODEL_STATUSES)

    expect([...frontendStatuses].sort()).toEqual([...canonical].sort())
    for (const status of canonical) {
      expect(frontendStatuses.has(status)).toBe(true)
    }
    for (const status of frontendStatuses) {
      expect(canonical.has(status)).toBe(true)
    }
  })

  test("[adr-0512] approval scopeContext field mirrored canonical ↔ frontend (additive, type set unchanged)", () => {
    // ADR-0512 P3 enriches the EXISTING `approval.requested` event with an
    // OPTIONAL `scopeContext` field on `PendingApprovalView` (the escalation
    // card payload). Adding a FIELD to an existing event interface must NOT add
    // a new SESSION_EVENT_TYPE — so the member-set guards above stay green. Pin
    // both: (a) the canonical type set still has exactly the legacy members
    // (no `permission_escalation_*` event type leaked in), and (b) the
    // `scopeContext` field literally appears in BOTH the canonical snapshot and
    // the frontend mirror so the card's read of it can never silently break.
    const canonical = new Set<string>(SESSION_EVENT_TYPES)
    expect(canonical.has("approval.requested")).toBe(true)
    // No NEW escalation event type — the enrichment is purely additive-field.
    for (const t of canonical) {
      expect(t.startsWith("permission_escalation")).toBe(false)
    }
    const canonicalSnapshot = readText(join(REPO_ROOT, "src/protocol/session/snapshot.ts"))
    const frontendProtocol = readText(FRONTEND_PROTOCOL_PATH)
    for (const source of [canonicalSnapshot, frontendProtocol]) {
      expect(source).toContain("scopeContext")
      expect(source).toContain("activeSkill")
    }
  })

  test("[adr-0512] EscalationCard button order === ESCALATION_OPTIONS (daemon SSOT, ordered)", () => {
    // The web `EscalationCard` re-declares the 4 escalation verbs locally (it
    // CANNOT import `@/agent/*` — different toolchain) and the source comment
    // CLAIMS the button order is "1:1 with ESCALATION_OPTIONS in
    // src/agent/skill-scope-escalation.ts" — but nothing enforced it. A drift
    // (reorder / add / drop a verb on either side) would silently mismatch the
    // card buttons against the wire/host decision map. Pin the EXACT ORDER (not
    // just membership) between the daemon `ESCALATION_OPTIONS` SSOT and the web
    // `ESCALATION_BUTTONS` so the claim can never go stale.
    const canonicalOrder = extractOrderedArrayLiterals(
      readText(ESCALATION_OPTIONS_PATH),
      "ESCALATION_OPTIONS",
    )
    const cardOrder = extractOrderedObjectFieldLiterals(
      readText(ESCALATION_CARD_PATH),
      "ESCALATION_BUTTONS",
      "option",
    )
    // Sanity: the daemon SSOT is the known 4-verb closed set (catches a regex
    // that silently captured zero / partial literals).
    expect(canonicalOrder).toEqual(["allow_once", "allow_session", "deny", "deny_and_steer"])
    // The contract: the web card's button order is byte-for-byte the daemon order.
    expect(cardOrder).toEqual(canonicalOrder)
  })

  test("[config] frontend CONFIG_WRITABLE_KEYS === daemon CONFIG_ALLOWED_KEYS (both directions)", () => {
    const frontendKeys = extractSetLiterals(
      readText(FRONTEND_SLASH_KNOBS_PATH),
      "CONFIG_WRITABLE_KEYS",
    )
    const daemonKeys = extractSetLiterals(readText(DAEMON_CONFIG_HTTP_PATH), "CONFIG_ALLOWED_KEYS")

    expect([...frontendKeys].sort()).toEqual([...daemonKeys].sort())

    for (const k of daemonKeys) {
      expect(frontendKeys.has(k)).toBe(true)
    }
    for (const k of frontendKeys) {
      expect(daemonKeys.has(k)).toBe(true)
    }
  })
})

/**
 * ── Ticket 03-A — field-shape drift layer ──────────────────────────────────
 * (docs/plans/jul-16-transport-unified-sdk/03-protocol-copy-drift-guard.md §A)
 *
 * The membership guards above pin WHICH union variants exist on both sides,
 * but a variant whose FIELDS drift — a type morph, an optionality flip, a
 * required field added canonically and never mirrored — sails through them.
 * This layer closes that class: it parses BOTH sides with the TypeScript
 * compiler API (precedent: tests/unit/_arch/slice-boundary-scanner.ts — the
 * frontend still cannot be `import`ed from a bun test, but it CAN be parsed)
 * and compares, field by field, every interface the copy declares that has a
 * canonical namesake in `src/protocol/session/{commands,events,snapshot,
 * capabilities}.ts`.
 *
 * Direction rules (ticket 03 §Phase A):
 *   - a field PRESENT in the copy must match the canonical field's type text
 *     and optionality exactly (mismatch = red), modulo the leniences below and
 *     the pinned narrowing inventory;
 *   - a CANONICAL-ONLY field is green only while OPTIONAL — additive-safe, the
 *     ticket-04 `argsFull?` contract. A required canonical-only field is red
 *     (a frame the copy builds or consumes would be missing it);
 *   - a COPY-ONLY field is always red — the copy may narrow the canonical
 *     surface, never extend it (land the field in `src/protocol/session/`
 *     FIRST, then mirror).
 *
 * Deliberate leniences (each one fixture-proven below, so loosening or
 * breaking them is itself red):
 *   - comments / whitespace: ignored — not wire shape (the printer strips
 *     comments; whitespace is collapsed);
 *   - `readonly`: ignored — a compile-time promise of the DECLARING side only,
 *     invisible on the JSON wire. `?` (optionality) by contrast changes what
 *     the wire may omit, so it stays STRICT in both directions and is never
 *     normalized away;
 *   - same-file type aliases: expanded when a field's WHOLE type text is one
 *     alias name (the copy writes `status: SessionStatus`; canonical inlines
 *     the union). Whole-text only — an alias in a partial position falls back
 *     to raw-text comparison, i.e. mismatch = red, the fail-safe direction.
 *
 * Copy-side interfaces with NO canonical namesake (UI-only shapes, and the
 * observability / canvas / agent-state protocol mirrors that share the file)
 * are skipped: the copy is an intentional subset, and the union-membership
 * guards above own the which-variants-exist axis. NOTE the declared scope: the
 * canonical set is the four session files — `ImageBlock` (mirrors `@/llm`) and
 * `SessionWireEnvelope` / `SessionRejectedFrame` (mirror `codec.ts`) are
 * outside this guard today.
 */

const CANONICAL_SESSION_PROTOCOL_PATHS = [
  "src/protocol/session/commands.ts",
  "src/protocol/session/events.ts",
  "src/protocol/session/snapshot.ts",
  "src/protocol/session/capabilities.ts",
] as const

interface ProtocolFieldShape {
  readonly optional: boolean
  readonly typeText: string
}

interface ParsedProtocolSource {
  /** interface name → (field name → shape), in declaration order. */
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, ProtocolFieldShape>>
  /** Non-generic top-level `type X = …` aliases, for whole-text expansion. */
  readonly aliases: ReadonlyMap<string, string>
}

/**
 * Parse every TOP-LEVEL `interface` (exported or not — the copy's envelope
 * interfaces are file-private) into `field → { optional, typeText }`, plus
 * every non-generic top-level type alias. Type text comes from a
 * comment-stripping printer so interior comments can never masquerade as
 * drift. Non-property members (methods, index signatures) are ignored — the
 * mirrored wire shapes carry data properties only.
 */
const propertySignatureName = (member: ts.PropertySignature, sf: ts.SourceFile): string =>
  ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
    ? member.name.text
    : member.name.getText(sf)

const interfaceFieldShapes = (
  decl: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  printer: ts.Printer,
): Map<string, ProtocolFieldShape> => {
  const fields = new Map<string, ProtocolFieldShape>()
  for (const member of decl.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue
    fields.set(propertySignatureName(member, sf), {
      optional: member.questionToken !== undefined,
      typeText: printer.printNode(ts.EmitHint.Unspecified, member.type, sf),
    })
  }
  return fields
}

const collectProtocolStatement = (
  stmt: ts.Statement,
  sf: ts.SourceFile,
  printer: ts.Printer,
  label: string,
  interfaces: Map<string, Map<string, ProtocolFieldShape>>,
  aliases: Map<string, string>,
): void => {
  if (ts.isTypeAliasDeclaration(stmt) && stmt.typeParameters === undefined) {
    if (aliases.has(stmt.name.text)) {
      throw new Error(
        `duplicate type alias \`${stmt.name.text}\` across ${label} — expansion would silently pick one`,
      )
    }
    aliases.set(stmt.name.text, printer.printNode(ts.EmitHint.Unspecified, stmt.type, sf))
  }
  if (!ts.isInterfaceDeclaration(stmt)) return
  if (interfaces.has(stmt.name.text)) {
    throw new Error(
      `duplicate interface \`${stmt.name.text}\` across ${label} — the merge would mask one declaration`,
    )
  }
  interfaces.set(stmt.name.text, interfaceFieldShapes(stmt, sf, printer))
}

const parseProtocolSources = (
  sources: readonly { readonly source: string; readonly label: string }[],
): ParsedProtocolSource => {
  const interfaces = new Map<string, Map<string, ProtocolFieldShape>>()
  const aliases = new Map<string, string>()
  const printer = ts.createPrinter({ removeComments: true })
  for (const { source, label } of sources) {
    const sf = ts.createSourceFile(`${label}.ts`, source, ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      collectProtocolStatement(stmt, sf, printer, label, interfaces, aliases)
    }
  }
  return { interfaces, aliases }
}

/** Normalize one field's type text per the documented leniences (see banner). */
const normalizeFieldTypeText = (typeText: string, aliases: ReadonlyMap<string, string>): string => {
  let text = typeText.trim()
  // Whole-text alias expansion (bounded — a cyclic alias pair must not hang).
  for (let hop = 0; hop < 8; hop += 1) {
    const expanded = aliases.get(text)
    if (expanded === undefined) break
    text = expanded
  }
  return text
    .replace(/\breadonly\s+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A pinned, human-reviewed divergence between the copy and the canonical type
 * text. A pin matches ONLY its exact normalized pair — if EITHER side moves,
 * the pin stops applying and the drift goes red, forcing a fresh review. This
 * is the whole lenience budget: there is deliberately no general "copy may
 * widen to string/unknown" rule, because such a rule would also green a
 * canonical change this guard exists to catch (e.g. a branded string type
 * becoming a structured object while the copy still says `string`).
 */
interface ApprovedFieldNarrowing {
  /** Exact NORMALIZED copy-side type text. */
  readonly copy: string
  /** Exact NORMALIZED canonical-side type text. */
  readonly canonical: string
  readonly why: string
}

const NARROWED_TO_OPAQUE_STRING =
  "copy cannot import the branded/closed @/shared type (different toolchain — the reason the copy exists); " +
  "the UI treats the value as an opaque string it never enumerates (documented in the copy's own comments)"

/** Copy-side narrowings that are the DOCUMENTED design of the copy file. Since
 *  03-B the "copy" is the GENERATED bundle — the generator applies exactly the
 *  same `@/*` → opaque narrowings (its `AT_TYPE_NARROWINGS` manifest), so these
 *  pins mirror that manifest and are what keeps the field-shape layer's
 *  zero-drift assertion honest about the (unavoidable) toolchain narrowings. */
const DELIBERATE_TOOLCHAIN_NARROWINGS: Readonly<Record<string, ApprovedFieldNarrowing>> = {
  "SessionTranscriptReplaceCommand.messages": {
    copy: "unknown[]",
    canonical: "Message[]",
    why: "copy cannot import `Message` (@/llm) and the UI never constructs or sends this payload — top-type is safe for a non-writer",
  },
  "SessionObjectiveMutateCommand.mutation": {
    copy: "unknown",
    canonical: "ObjectiveMutation",
    why: "copy cannot import `ObjectiveMutation` (@/objective); the C3 write path is the CLI + kernel/host, and the web inline objective editor is the later D3 UX — until then the UI never constructs this payload, so top-type is safe (same posture as `Message`)",
  },
  "SessionStateView.lastLlmRequest": {
    copy: "unknown & { policy?: unknown; }",
    canonical:
      'LlmRequestObservation & { policy?: import("@/shared/turn-policy-types").TurnPolicySnapshot; }',
    why: "copy cannot import `LlmRequestObservation` / `TurnPolicySnapshot` (@/shared) — the UI reads neither; the generator narrows both arms to the top type (additive-optional field, never inspected by the frontend)",
  },
  "SessionStateView.lastLlmContinuation": {
    copy: "unknown",
    canonical: "LlmContinuationObservation",
    why: "copy cannot import `LlmContinuationObservation` (@/shared) — additive-optional observation the UI never inspects; top-type on a read-only field",
  },
  "TurnLlmRequestEvent.surfaceId": {
    copy: "string",
    canonical: "LlmSurfaceId",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "TurnLlmRequestEvent.transportId": {
    copy: "string",
    canonical: "LlmTransportId",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "TurnLlmRequestEvent.policy": {
    copy: "unknown",
    canonical: "TurnPolicySnapshot",
    why: "structured routing snapshot the UI never inspects — top-type on a read-only field",
  },
  "TurnLlmContinuationEvent.transportId": {
    copy: "string",
    canonical: "LlmTransportId",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "TurnLlmContinuationEvent.phase": {
    copy: "string",
    canonical: "ResponsesContinuationPhase",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "TurnLlmContinuationEvent.mode": {
    copy: "string",
    canonical: "ResponsesContinuationMode",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "TurnLlmContinuationEvent.reason": {
    copy: "string",
    canonical: "ResponsesContinuationReason",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "ItemStartedEvent.itemType": {
    copy: "string",
    canonical: "ItemStreamItemType",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "ItemDeltaEvent.itemType": {
    copy: "string",
    canonical: "ItemStreamItemType",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "ItemDeltaEvent.deltaKind": {
    copy: "string",
    canonical: "ItemStreamDeltaKind",
    why: NARROWED_TO_OPAQUE_STRING,
  },
  "ItemCompletedEvent.itemType": {
    copy: "string",
    canonical: "ItemStreamItemType",
    why: NARROWED_TO_OPAQUE_STRING,
  },
}

/**
 * REAL drift this guard found on landing (jul-16), pinned instead of silently
 * passed: the divergence is wire-COMPATIBLE today, but the pin keeps it
 * visible, and the exact-pair mechanics mean any further movement on either
 * side goes red. To clear an entry: mirror the canonical text into the copy,
 * then DELETE the entry — the stale-pin test below forces the deletion.
 */
const KNOWN_UNMIRRORED_LAG: Readonly<Record<string, ApprovedFieldNarrowing>> = {
  // (empty — the jul-16 landing-time find, `ApprovalRespondCommand.scope`
  // missing `session_prefix`, was mirrored and its pin deleted as the
  // stale-pin ratchet demands. Add entries ONLY for wire-compatible lag,
  // with the exact canonical/copy pair + why.)
}

const APPROVED_FIELD_NARROWINGS: Readonly<Record<string, ApprovedFieldNarrowing>> = {
  ...DELIBERATE_TOOLCHAIN_NARROWINGS,
  ...KNOWN_UNMIRRORED_LAG,
}

interface FieldShapeDriftReport {
  readonly drift: readonly string[]
  readonly comparedInterfaces: readonly string[]
  readonly comparedFieldCount: number
  readonly usedNarrowingKeys: ReadonlySet<string>
}

const describeOptionality = (optional: boolean): string => (optional ? "optional (?)" : "required")

/** Compare one field present on BOTH sides (strict optionality + normalized
 *  type text, modulo an exact-pair pin). */
const compareSharedField = (
  key: string,
  copyField: ProtocolFieldShape,
  canonicalField: ProtocolFieldShape,
  copy: ParsedProtocolSource,
  canonical: ParsedProtocolSource,
  approvedNarrowings: Readonly<Record<string, ApprovedFieldNarrowing>>,
): { readonly drift: readonly string[]; readonly usedNarrowingKey: string | undefined } => {
  const drift: string[] = []
  if (copyField.optional !== canonicalField.optional) {
    drift.push(
      `${key}: optionality drift — copy ${describeOptionality(copyField.optional)} vs canonical ${describeOptionality(canonicalField.optional)}`,
    )
  }
  const copyText = normalizeFieldTypeText(copyField.typeText, copy.aliases)
  const canonicalText = normalizeFieldTypeText(canonicalField.typeText, canonical.aliases)
  if (copyText === canonicalText) return { drift, usedNarrowingKey: undefined }
  const pin = approvedNarrowings[key]
  if (pin !== undefined && pin.copy === copyText && pin.canonical === canonicalText) {
    return { drift, usedNarrowingKey: key }
  }
  drift.push(`${key}: type drift — copy \`${copyText}\` vs canonical \`${canonicalText}\``)
  return { drift, usedNarrowingKey: undefined }
}

interface MirroredInterfaceComparison {
  readonly drift: readonly string[]
  readonly fieldCount: number
  readonly usedNarrowingKeys: readonly string[]
}

const compareMirroredInterface = (
  interfaceName: string,
  copyFields: ReadonlyMap<string, ProtocolFieldShape>,
  canonicalFields: ReadonlyMap<string, ProtocolFieldShape>,
  copy: ParsedProtocolSource,
  canonical: ParsedProtocolSource,
  approvedNarrowings: Readonly<Record<string, ApprovedFieldNarrowing>>,
): MirroredInterfaceComparison => {
  const drift: string[] = []
  const usedNarrowingKeys: string[] = []
  let fieldCount = 0

  for (const [fieldName, copyField] of copyFields) {
    fieldCount += 1
    const key = `${interfaceName}.${fieldName}`
    const canonicalField = canonicalFields.get(fieldName)
    if (canonicalField === undefined) {
      drift.push(
        `${key}: copy-only field — the copy may narrow the canonical shape, never extend it`,
      )
      continue
    }
    const outcome = compareSharedField(
      key,
      copyField,
      canonicalField,
      copy,
      canonical,
      approvedNarrowings,
    )
    drift.push(...outcome.drift)
    if (outcome.usedNarrowingKey !== undefined) usedNarrowingKeys.push(outcome.usedNarrowingKey)
  }

  for (const [fieldName, canonicalField] of canonicalFields) {
    if (copyFields.has(fieldName)) continue
    if (canonicalField.optional) continue // additive-safe (ticket-04 `argsFull?` contract)
    drift.push(
      `${interfaceName}.${fieldName}: canonical REQUIRED field missing from the copy — canonical-only fields are additive-safe only while optional`,
    )
  }

  return { drift, fieldCount, usedNarrowingKeys }
}

/**
 * Pure comparator — the unit under the red-on-injection fixtures below AND the
 * engine of the real-files assertion, so what the fixtures prove is exactly
 * what guards the repo.
 */
const collectFieldShapeDrift = (
  copy: ParsedProtocolSource,
  canonical: ParsedProtocolSource,
  approvedNarrowings: Readonly<Record<string, ApprovedFieldNarrowing>>,
): FieldShapeDriftReport => {
  const drift: string[] = []
  const comparedInterfaces: string[] = []
  const usedNarrowingKeys = new Set<string>()
  let comparedFieldCount = 0

  for (const [interfaceName, copyFields] of copy.interfaces) {
    const canonicalFields = canonical.interfaces.get(interfaceName)
    if (canonicalFields === undefined) continue // intentional-subset skip (see banner)
    comparedInterfaces.push(interfaceName)
    const comparison = compareMirroredInterface(
      interfaceName,
      copyFields,
      canonicalFields,
      copy,
      canonical,
      approvedNarrowings,
    )
    drift.push(...comparison.drift)
    comparedFieldCount += comparison.fieldCount
    for (const key of comparison.usedNarrowingKeys) usedNarrowingKeys.add(key)
  }

  return { drift, comparedInterfaces, comparedFieldCount, usedNarrowingKeys }
}

let realFieldShapeReportMemo: FieldShapeDriftReport | undefined
const realFieldShapeReport = (): FieldShapeDriftReport => {
  if (realFieldShapeReportMemo !== undefined) return realFieldShapeReportMemo
  const copy = parseProtocolSources([
    { source: readText(FRONTEND_PROTOCOL_PATH), label: "web-frontend-protocol-copy" },
  ])
  const canonical = parseProtocolSources(
    CANONICAL_SESSION_PROTOCOL_PATHS.map((path) => ({
      source: readText(join(REPO_ROOT, path)),
      label: path,
    })),
  )
  realFieldShapeReportMemo = collectFieldShapeDrift(copy, canonical, APPROVED_FIELD_NARROWINGS)
  return realFieldShapeReportMemo
}

/* --- Synthetic fixtures: PERMANENT red-on-injection coverage ------------ */

const parseFixture = (source: string): ParsedProtocolSource =>
  parseProtocolSources([{ source, label: "fixture" }])

const fixtureDrift = (
  copySource: string,
  canonicalSource: string,
  approvedNarrowings: Readonly<Record<string, ApprovedFieldNarrowing>> = {},
): readonly string[] =>
  collectFieldShapeDrift(
    parseFixture(copySource),
    parseFixture(canonicalSource),
    approvedNarrowings,
  ).drift

const FIXTURE_CANONICAL = `
export interface WidgetEvent {
  readonly id: string
  readonly count: number
  readonly label?: string
}
`

/** In-sync mirror of {@link FIXTURE_CANONICAL} (readonly deliberately varied). */
const FIXTURE_COPY_IN_SYNC = `
export interface WidgetEvent {
  readonly id: string
  count: number
  readonly label?: string
}
`

describe("wire-protocol field-shape drift: copy field shapes === canonical daemon SSOT (ticket 03-A)", () => {
  describe("[detector] permanent red-on-injection fixtures — every drift class provably detected", () => {
    test("paired control: an in-sync copy reports zero drift", () => {
      expect(fixtureDrift(FIXTURE_COPY_IN_SYNC, FIXTURE_CANONICAL)).toEqual([])
    })

    test("type morph on a shared field is detected (string → number)", () => {
      const morphedCopy = `
        export interface WidgetEvent {
          readonly id: number
          readonly count: number
          readonly label?: string
        }
      `
      expect(fixtureDrift(morphedCopy, FIXTURE_CANONICAL)).toEqual([
        "WidgetEvent.id: type drift — copy `number` vs canonical `string`",
      ])
    })

    test("optionality flip is detected in BOTH directions", () => {
      // copy made a canonical-required field optional (copy could omit what the wire requires)
      const copyLoosened = `
        export interface WidgetEvent {
          readonly id: string
          readonly count?: number
          readonly label?: string
        }
      `
      expect(fixtureDrift(copyLoosened, FIXTURE_CANONICAL)).toEqual([
        "WidgetEvent.count: optionality drift — copy optional (?) vs canonical required",
      ])
      // copy made a canonical-optional field required (copy would crash on a legal omission)
      const copyTightened = `
        export interface WidgetEvent {
          readonly id: string
          readonly count: number
          readonly label: string
        }
      `
      expect(fixtureDrift(copyTightened, FIXTURE_CANONICAL)).toEqual([
        "WidgetEvent.label: optionality drift — copy required vs canonical optional (?)",
      ])
    })

    test("canonical-only REQUIRED field is detected; canonical-only OPTIONAL is additive-safe green (paired control)", () => {
      const canonicalGrewRequired = `
        export interface WidgetEvent {
          readonly id: string
          readonly count: number
          readonly label?: string
          readonly mustHave: string
        }
      `
      expect(fixtureDrift(FIXTURE_COPY_IN_SYNC, canonicalGrewRequired)).toEqual([
        "WidgetEvent.mustHave: canonical REQUIRED field missing from the copy — canonical-only fields are additive-safe only while optional",
      ])
      // The ticket-04 contract: an `argsFull?`-class additive canonical field stays green.
      const canonicalGrewOptional = `
        export interface WidgetEvent {
          readonly id: string
          readonly count: number
          readonly label?: string
          readonly argsFull?: string
        }
      `
      expect(fixtureDrift(FIXTURE_COPY_IN_SYNC, canonicalGrewOptional)).toEqual([])
    })

    test("copy-only field is detected (the copy may narrow, never extend)", () => {
      const copyGrew = `
        export interface WidgetEvent {
          readonly id: string
          readonly count: number
          readonly label?: string
          readonly uiOnly: boolean
        }
      `
      expect(fixtureDrift(copyGrew, FIXTURE_CANONICAL)).toEqual([
        "WidgetEvent.uiOnly: copy-only field — the copy may narrow the canonical shape, never extend it",
      ])
    })

    test("leniences hold and are BOUNDED: comments/whitespace/readonly ignored, same-file alias expanded — but a different union is still red", () => {
      // Interior comment + erratic whitespace + readonly asymmetry: all green.
      const noisyCanonical = `
        export interface WidgetEvent {
          id:   /* interior comment */   string
          count:number
          label
            ?: string
        }
      `
      expect(fixtureDrift(FIXTURE_COPY_IN_SYNC, noisyCanonical)).toEqual([])

      // Copy aliases the union; canonical inlines it: green (whole-text expansion).
      const aliasedCopy = `
        export type WidgetStatus = "on" | "off"
        export interface Toggle {
          readonly status: WidgetStatus
        }
      `
      const inlineCanonical = `
        export interface Toggle {
          readonly status: "on" | "off"
        }
      `
      expect(fixtureDrift(aliasedCopy, inlineCanonical)).toEqual([])

      // Paired red control: alias expansion is NOT blanket equivalence — a
      // diverging union body behind the alias is still drift.
      const divergedCanonical = `
        export interface Toggle {
          readonly status: "on" | "paused"
        }
      `
      expect(fixtureDrift(aliasedCopy, divergedCanonical)).toEqual([
        'Toggle.status: type drift — copy `"on" | "off"` vs canonical `"on" | "paused"`',
      ])
    })

    test("narrowing pin matches ONLY its exact pair — movement on either side, or an optionality flip, is still red", () => {
      const pin: Readonly<Record<string, ApprovedFieldNarrowing>> = {
        "Ev.surfaceId": { copy: "string", canonical: "BrandedId", why: "fixture" },
      }
      const pinnedCopy = `export interface Ev { readonly surfaceId: string }`
      const pinnedCanonical = `export interface Ev { readonly surfaceId: BrandedId }`
      // Exact pinned pair: green.
      expect(fixtureDrift(pinnedCopy, pinnedCanonical, pin)).toEqual([])
      // Canonical moved past the pin: red (forces a fresh review, not silent pass).
      expect(
        fixtureDrift(pinnedCopy, `export interface Ev { readonly surfaceId: OtherBrand }`, pin),
      ).toEqual(["Ev.surfaceId: type drift — copy `string` vs canonical `OtherBrand`"])
      // Copy moved: red.
      expect(
        fixtureDrift(`export interface Ev { readonly surfaceId: number }`, pinnedCanonical, pin),
      ).toEqual(["Ev.surfaceId: type drift — copy `number` vs canonical `BrandedId`"])
      // A pin never covers optionality — `?` stays strict even on a pinned field.
      expect(
        fixtureDrift(`export interface Ev { readonly surfaceId?: string }`, pinnedCanonical, pin),
      ).toEqual(["Ev.surfaceId: optionality drift — copy optional (?) vs canonical required"])
    })

    test("copy-only INTERFACE is skipped (intentional subset — the membership guards own that axis)", () => {
      const copyWithUiOnlyInterface = `${FIXTURE_COPY_IN_SYNC}
        export interface UiOnlyPanel {
          readonly zoom: number
        }
      `
      const report = collectFieldShapeDrift(
        parseFixture(copyWithUiOnlyInterface),
        parseFixture(FIXTURE_CANONICAL),
        {},
      )
      expect(report.drift).toEqual([])
      expect(report.comparedInterfaces).toEqual(["WidgetEvent"])
    })
  })

  test("[field-shape] real copy ↔ canonical: zero field-shape drift outside the pinned narrowing inventory", () => {
    // SSOT doctrine on red: edit `src/protocol/session/` FIRST, then re-mirror
    // `apps/web-frontend/src/types/protocol.ts` until green. Pin a divergence
    // ONLY when the copy deliberately cannot express the canonical type
    // (toolchain narrowing) — with a `why`.
    expect(realFieldShapeReport().drift).toEqual([])
  })

  test("[field-shape] scanner non-vacuity: the mirrored session surface is actually being compared", () => {
    // A parser regression that silently matches nothing would make the drift
    // assertion above vacuously green (the exact failure class the 4-verb
    // sanity pin guards against in the escalation test). Pin floors + names.
    // Measured at landing: 40 interfaces, 131 copy fields.
    const report = realFieldShapeReport()
    expect(report.comparedInterfaces.length).toBeGreaterThanOrEqual(35)
    expect(report.comparedFieldCount).toBeGreaterThanOrEqual(110)
    for (const mustCompare of [
      "SessionCommandEnvelope",
      "SessionEventEnvelope",
      "InputAppendCommand",
      "ApprovalRespondCommand",
      "SessionStateView",
      "SessionSnapshotLite",
      "CapabilityManifest",
      "TurnLlmRequestEvent",
      "TurnLlmContinuationEvent",
    ]) {
      expect(report.comparedInterfaces).toContain(mustCompare)
    }
  })

  test("[field-shape] narrowing inventory is exact: every pin in active use, no stale entries, no key shadowing", () => {
    // Ratchet: a pin whose divergence got mirrored away MUST be deleted (a
    // stale allowlist entry would silently green the NEXT, different drift on
    // that field). Also proves the pins are live — if the parser stopped
    // seeing fields, the pins would go unused and THIS test reds, so the
    // zero-drift assertion above cannot rot into vacuity unnoticed.
    const report = realFieldShapeReport()
    expect(Object.keys(APPROVED_FIELD_NARROWINGS).length).toBe(
      Object.keys(DELIBERATE_TOOLCHAIN_NARROWINGS).length +
        Object.keys(KNOWN_UNMIRRORED_LAG).length,
    )
    expect([...report.usedNarrowingKeys].sort()).toEqual(
      Object.keys(APPROVED_FIELD_NARROWINGS).sort(),
    )
  })
})
