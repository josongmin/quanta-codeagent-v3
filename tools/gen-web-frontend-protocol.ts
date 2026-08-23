#!/usr/bin/env bun
/**
 * `bun run build:protocol` (→ `bun run tools/gen-web-frontend-protocol.ts`)
 *
 * GENERATE the web-frontend's session-protocol type bundle FROM the canonical
 * daemon SSOT in `src/protocol/session/`, so the two can never DRIFT: the old
 * hand-maintained copy (`apps/web-frontend/src/types/protocol.ts`) restated the
 * session wire shape by hand and a bun test (`web-frontend-protocol-drift-
 * contract-hellgate`) had to police it. Ticket 03-B (docs/plans/
 * jul-16-transport-unified-sdk/03-protocol-copy-drift-guard.md §Phase B)
 * replaces that hand copy with THIS deterministic emit.
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   apps/web-frontend/src/types/protocol.session.generated.ts
 *
 * It carries EXACTLY the four field-shape-guarded session files —
 * `{commands,events,snapshot,capabilities}.ts` — plus the value consts the
 * frontend consumes at runtime (`SURFACE_READ_MODEL_IDS`,
 * `SURFACE_READ_MODEL_STATUSES`, `SESSION_PROTOCOL_VERSION`, the read-model
 * support type aliases, `SurfaceSubscription`, and
 * `DEFAULT_SESSION_CLIENT_SURFACE_SUBSCRIPTION`). The UI-only shapes
 * (`UiMessage`, `ConnectionState`) and the OTHER protocol mirrors (canvas /
 * observability / agent-state) that share the file are hand-maintained in the
 * barrel `protocol.ts` — they are outside `@/protocol/session` and keep their
 * own union-membership discipline.
 *
 * ── Why a self-contained emit, not a re-export / path alias ─────────────────
 * The frontend is a STANDALONE package (own tsconfig `include:["src"]`, own
 * vite build, no `paths` back to the bun repo). A path alias into
 * `@/protocol/session` would drag the whole tree — `codec.ts` VALUE-imports
 * `errMessage` from `@/shared` (a Node/kernel value; browser-bundle leak),
 * `read-models.ts` value-imports the sibling protocol version consts, and every
 * type file `import type`s branded `@/shared` / `@/llm` types the frontend
 * tsconfig cannot resolve. So the canonical types are NARROWED at emit: each
 * unresolvable `@/*` type reference is rewritten to the opaque text the UI
 * already treats it as (the copy's documented design). The rewrite manifest is
 * `AT_TYPE_NARROWINGS` below; a canonical `@/*` reference with NO manifest
 * entry is a HARD ERROR (the generator refuses to silently emit an
 * unresolvable type), so a new branded field forces a human decision.
 *
 * ── Determinism / drift guard ───────────────────────────────────────────────
 * The emit is a pure function of the canonical source text. The hellgate
 * (`web-frontend-protocol-drift-contract-hellgate.test.ts`) regenerates the
 * bundle in-memory and asserts it BYTE-EQUALS the committed file — so a
 * canonical edit that is not re-emitted is red. `--check` does the same from
 * the CLI (CI hook / pre-commit).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(import.meta.dir, "..")

const VERSION_FILE = "src/protocol/session/version.ts"
const READ_MODELS_FILE = "src/protocol/session/read-models.ts"

export const GENERATED_OUTPUT_PATH = "apps/web-frontend/src/types/protocol.session.generated.ts"

/**
 * Rewrite manifest: each canonical `@/*`-imported type reference the frontend
 * cannot resolve → the narrowed text the UI treats it as. The reason mirrors
 * the hellgate's `DELIBERATE_TOOLCHAIN_NARROWINGS` documentation. Keyed by the
 * type NAME as it appears in a field position (identifier, or the qualifier of
 * an `import("…").X` reference).
 *
 * ONLY these names may be narrowed; any other `@/*`-sourced type name in a
 * field position aborts the generator (see `makeTypeRewriter`).
 */
const AT_TYPE_NARROWINGS: Readonly<Record<string, string>> = {
  // @/llm — `ImageBlock` is restated locally in the barrel and kept by-name;
  //          `Message` is never constructed/sent by the UI → top type.
  ImageBlock: "ImageBlock",
  Message: "unknown",
  // @/shared/item-stream
  ItemStreamItemType: "string",
  ItemStreamDeltaKind: "string",
  // @/shared/llm-route-types
  LlmSurfaceId: "string",
  LlmTransportId: "string",
  ResponsesContinuationPhase: "string",
  ResponsesContinuationMode: "string",
  ResponsesContinuationReason: "string",
  LlmRequestObservation: "unknown",
  LlmContinuationObservation: "unknown",
  // @/shared/turn-policy-types
  TurnPolicySnapshot: "unknown",
  // @/objective (RFC-03 C3) — the closed `ObjectiveMutation` union backs
  // `session.objective.mutate`. The web composer does not yet CONSTRUCT typed
  // objective mutations (the CLI + kernel/host are the C3 write path; the web
  // inline editor is the later D3 UX), so the UI treats the payload opaquely →
  // top type (same posture as `Message`, which the UI also never builds).
  ObjectiveMutation: "unknown",
  // @/permission/posture (RFC-05 E4) — the lossless `PosturePatch` backs
  // `session.posture.set`. The write path is the CLI selector + kernel/host
  // (behind QUANTA_POSTURE_SELECTOR); the web posture composer is not built
  // yet, so the UI treats the payload opaquely → top type (same as
  // `ObjectiveMutation`).
  PosturePatch: "unknown",
  // @/permission (RFC-05 E4) — `PostureEffectiveView.threadPermission` echoes
  // the resolved per-thread permission record. Verified aug-23: the frontend
  // never reads `threadPermission` (grep over apps/web-frontend = 0 hits), so
  // narrowing it keeps the generated bundle from dragging the whole
  // `@/permission` type graph across the wire boundary. Same posture as
  // `PosturePatch` above — widen to the real shape when a UI actually renders it.
  ThreadPermission: "unknown",
}

/** Names imported from `@/*` in a canonical file — collected so the generator
 *  can PROVE every one used in a field position is covered by the manifest. */
const collectAtImportedNames = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier
    if (!ts.isStringLiteral(spec) || !spec.text.startsWith("@/")) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text)
    }
  }
  return names
}

/**
 * Rewrite a field type NODE to frontend-safe text: any identifier / import-type
 * qualifier that is a key of `AT_TYPE_NARROWINGS` is swapped for its narrowed
 * text. Same-dir sibling type names (declared in one of the emitted files) pass
 * through untouched. A reference to an `@/*`-imported name with NO manifest
 * entry throws (fail-closed).
 */
const rewriteTypeText = (
  typeNode: ts.TypeNode,
  sf: ts.SourceFile,
  printer: ts.Printer,
  atImportedNames: ReadonlySet<string>,
  contextLabel: string,
): string => {
  const transformer: ts.TransformerFactory<ts.TypeNode> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isImportTypeNode(node)) {
        const qualifier = node.qualifier
        if (qualifier !== undefined && ts.isIdentifier(qualifier)) {
          const narrowed = AT_TYPE_NARROWINGS[qualifier.text]
          if (narrowed !== undefined && narrowed !== qualifier.text) {
            return ts.factory.createTypeReferenceNode(narrowed)
          }
          throw new Error(
            `${contextLabel}: import("…").${qualifier.text} has no scalar AT_TYPE_NARROWINGS entry`,
          )
        }
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text
        const narrowed = AT_TYPE_NARROWINGS[name]
        if (narrowed !== undefined) {
          if (narrowed === name) return node // by-name passthrough (ImageBlock)
          return ts.factory.createTypeReferenceNode(narrowed)
        }
        if (atImportedNames.has(name)) {
          throw new Error(
            `${contextLabel}: type \`${name}\` is imported from @/* but has no AT_TYPE_NARROWINGS entry — ` +
              `add a narrowing (with a reason) before re-emitting`,
          )
        }
      }
      return ts.visitEachChild(node, visit, context)
    }
    return (root) => ts.visitNode(root, visit) as ts.TypeNode
  }
  const result = ts.transform(typeNode, [transformer])
  const rewritten = result.transformed[0] ?? typeNode
  const text = printer.printNode(ts.EmitHint.Unspecified, rewritten, sf)
  result.dispose()
  return text
}

/** Emit an interface (comments stripped, field types rewritten). Heritage
 *  (`extends …Envelope<"…">`) + type params preserved verbatim. */
const emitInterface = (
  decl: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  printer: ts.Printer,
  atImportedNames: ReadonlySet<string>,
): string => {
  const name = decl.name.text
  const heritage = decl.heritageClauses?.[0]
  const extendsText =
    heritage !== undefined
      ? ` extends ${heritage.types
          .map((t) => printer.printNode(ts.EmitHint.Unspecified, t, sf))
          .join(", ")}`
      : ""
  const typeParams =
    decl.typeParameters !== undefined
      ? `<${decl.typeParameters
          .map((p) => printer.printNode(ts.EmitHint.Unspecified, p, sf))
          .join(", ")}>`
      : ""
  const lines: string[] = []
  for (const member of decl.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue
    const fieldName =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : member.name.getText(sf)
    const optional = member.questionToken !== undefined ? "?" : ""
    const typeText = rewriteTypeText(
      member.type,
      sf,
      printer,
      atImportedNames,
      `${name}.${fieldName}`,
    )
    lines.push(`  readonly ${fieldName}${optional}: ${typeText}`)
  }
  if (lines.length === 0) {
    return `export interface ${name}${typeParams}${extendsText} {}`
  }
  return `export interface ${name}${typeParams}${extendsText} {\n${lines.join("\n")}\n}`
}

/** Emit a `type X = …` alias (comments stripped, field `@/*` refs narrowed). */
const emitTypeAlias = (
  decl: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  printer: ts.Printer,
  atImportedNames: ReadonlySet<string>,
): string => {
  const name = decl.name.text
  const typeParams =
    decl.typeParameters !== undefined
      ? `<${decl.typeParameters
          .map((p) => printer.printNode(ts.EmitHint.Unspecified, p, sf))
          .join(", ")}>`
      : ""
  const body = rewriteTypeText(decl.type, sf, printer, atImportedNames, name)
  return `export type ${name}${typeParams} = ${body}`
}

/** Emit a string-literal-array const (`const X = [ … ] as const`). */
const emitConstArray = (
  decl: ts.VariableStatement,
  sf: ts.SourceFile,
  printer: ts.Printer,
): string | undefined => {
  const d = decl.declarationList.declarations[0]
  if (d === undefined || !ts.isIdentifier(d.name) || d.initializer === undefined) return undefined
  const init = printer.printNode(ts.EmitHint.Unspecified, d.initializer, sf)
  return `export const ${d.name.text} = ${init}`
}

interface EmittedFile {
  readonly interfaces: string[]
  readonly typeAliases: string[]
  /** `SESSION_COMMAND_TYPES` / `SESSION_EVENT_TYPES` value arrays, if present. */
  readonly typeConsts: string[]
}

/** The discriminant-array value consts the frontend needs at runtime (the
 *  `SessionCommandType` / `SessionEventType` aliases derive from them). */
const TYPE_ARRAY_CONST_NAMES = new Set(["SESSION_COMMAND_TYPES", "SESSION_EVENT_TYPES"])

const emitCanonicalFile = (relPath: string): EmittedFile => {
  const source = readFileSync(join(REPO_ROOT, relPath), "utf8")
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true)
  const printer = ts.createPrinter({ removeComments: true })
  const atImportedNames = collectAtImportedNames(sf)
  const interfaces: string[] = []
  const typeAliases: string[] = []
  const typeConsts: string[] = []
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      interfaces.push(emitInterface(stmt, sf, printer, atImportedNames))
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      typeAliases.push(emitTypeAlias(stmt, sf, printer, atImportedNames))
    } else if (ts.isVariableStatement(stmt)) {
      const d = stmt.declarationList.declarations[0]
      if (d !== undefined && ts.isIdentifier(d.name) && TYPE_ARRAY_CONST_NAMES.has(d.name.text)) {
        const emitted = emitConstArray(stmt, sf, printer)
        if (emitted !== undefined) typeConsts.push(emitted)
      }
    }
  }
  return { interfaces, typeAliases, typeConsts }
}

/**
 * Read-model support type aliases + the two value consts the frontend uses.
 * The upstream aliases carry `typeof CANVAS_PROTOCOL_VERSION` etc. that the
 * frontend cannot resolve, so we emit generic support aliases + concrete
 * `SupportedReadModels` / `SurfaceSubscription` shapes with the LITERAL
 * protocol strings — matching what the daemon actually sends. The id/status
 * member arrays ARE emitted from canonical so they can never drift.
 */
const emitReadModelSurface = (): { types: string[]; consts: string[] } => {
  const source = readFileSync(join(REPO_ROOT, READ_MODELS_FILE), "utf8")
  const sf = ts.createSourceFile(READ_MODELS_FILE, source, ts.ScriptTarget.Latest, true)
  const printer = ts.createPrinter({ removeComments: true })
  const types: string[] = [
    "export type SurfaceReadModelSupport<TProtocol extends string> =\n" +
      '  | { readonly status: "subscribed" | "supported"; readonly protocol: TProtocol }\n' +
      '  | { readonly status: "unsupported" }',
    "export type SurfaceSubscriptionSupport<TProtocol extends string> =\n" +
      '  | { readonly status: "subscribed"; readonly protocol: TProtocol }\n' +
      '  | { readonly status: "unsupported" }',
    "export type SupportedReadModelSupport<TProtocol extends string> =\n" +
      '  | { readonly status: "supported"; readonly protocol: TProtocol }\n' +
      '  | { readonly status: "unsupported" }',
    "export interface SupportedReadModels {\n" +
      '  readonly session: SupportedReadModelSupport<"session.v1">\n' +
      '  readonly agentState: SupportedReadModelSupport<"agent-state.v1">\n' +
      '  readonly canvas: SupportedReadModelSupport<"canvas.v1">\n' +
      '  readonly observability: SupportedReadModelSupport<"observability.v1">\n}',
    "export interface SurfaceSubscription {\n" +
      '  readonly session: SurfaceSubscriptionSupport<"session.v1">\n' +
      '  readonly agentState: SurfaceSubscriptionSupport<"agent-state.v1">\n' +
      '  readonly canvas: SurfaceSubscriptionSupport<"canvas.v1">\n' +
      '  readonly observability: SurfaceSubscriptionSupport<"observability.v1">\n}',
  ]
  const consts: string[] = []
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const d = stmt.declarationList.declarations[0]
    if (d === undefined || !ts.isIdentifier(d.name)) continue
    if (d.name.text === "SURFACE_READ_MODEL_IDS" || d.name.text === "SURFACE_READ_MODEL_STATUSES") {
      const emitted = emitConstArray(stmt, sf, printer)
      if (emitted !== undefined) consts.push(emitted)
    }
  }
  return { types, consts }
}

/** The single string-literal `SESSION_PROTOCOL_VERSION` const. */
const emitVersionConst = (): string => {
  const source = readFileSync(join(REPO_ROOT, VERSION_FILE), "utf8")
  const match = /SESSION_PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(source)
  if (match === null) throw new Error("could not read SESSION_PROTOCOL_VERSION from version.ts")
  return `export const SESSION_PROTOCOL_VERSION = "${match[1]}" as const`
}

const BANNER = `/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: \`src/protocol/session/{capabilities,commands,snapshot,events,
 * read-models,version}.ts\` in the main quanta repo. Regenerate with:
 *
 *     bun run build:protocol      (-> tools/gen-web-frontend-protocol.ts)
 *
 * This file mirrors the CANONICAL session wire protocol, NARROWED where the
 * frontend toolchain cannot resolve a branded \`@/*\` type (see the generator's
 * AT_TYPE_NARROWINGS manifest). Editing it by hand will be reverted by the next
 * regeneration and is caught red by
 * \`tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts\` (it
 * regenerates in-memory and asserts byte-equality). To change the wire shape,
 * edit \`src/protocol/session/\` FIRST, then re-run \`bun run build:protocol\`.
 *
 * The barrel \`./protocol.ts\` re-exports everything here and adds the UI-only
 * types + the canvas / observability / agent-state protocol mirrors that are
 * outside \`@/protocol/session\`.
 */

import type { ImageBlock } from "./protocol"`

/** Build the full generated file text. PURE given the canonical sources on disk. */
export const generateProtocolBundle = (): string => {
  const capabilities = emitCanonicalFile("src/protocol/session/capabilities.ts")
  const commands = emitCanonicalFile("src/protocol/session/commands.ts")
  // aug-23 audit — `posture-projection.ts` is a FIFTH canonical file. It was
  // added as a RELATIVE import of `snapshot.ts`, and the emitter only reads the
  // four listed here while its coverage proof only inspects `@/*` imports — so
  // the bundle shipped a `posture?: PostureProjectionView` field whose type it
  // never declared, and `typecheck:all` went red on a GENERATED file. Every
  // drift guard stayed green because they compare unions and bytes, not
  // closure. The `[closure]` hellgate now asserts the missing property.
  const postureProjection = emitCanonicalFile("src/protocol/session/posture-projection.ts")
  const snapshot = emitCanonicalFile("src/protocol/session/snapshot.ts")
  const events = emitCanonicalFile("src/protocol/session/events.ts")
  const readModels = emitReadModelSurface()

  const sections: string[] = []
  sections.push(BANNER)
  sections.push("/* --- Value re-declarations the frontend consumes at runtime ---------- */")
  sections.push(emitVersionConst())
  sections.push(...readModels.consts)
  sections.push("export type SurfaceReadModelId = (typeof SURFACE_READ_MODEL_IDS)[number]")
  sections.push("export type SurfaceReadModelStatus = (typeof SURFACE_READ_MODEL_STATUSES)[number]")
  sections.push(...readModels.types)
  sections.push(
    "export const DEFAULT_SESSION_CLIENT_SURFACE_SUBSCRIPTION: SurfaceSubscription = {\n" +
      '  session: { status: "subscribed", protocol: "session.v1" },\n' +
      '  agentState: { status: "subscribed", protocol: "agent-state.v1" },\n' +
      '  canvas: { status: "subscribed", protocol: "canvas.v1" },\n' +
      '  observability: { status: "subscribed", protocol: "observability.v1" },\n}',
  )
  sections.push("/* --- Capabilities ---------------------------------------------------- */")
  sections.push(...capabilities.interfaces, ...capabilities.typeAliases)
  sections.push("/* --- Snapshot views -------------------------------------------------- */")
  // Posture views FIRST — `SessionStateView.posture` references them.
  sections.push(...postureProjection.interfaces, ...postureProjection.typeAliases)
  sections.push(...snapshot.interfaces, ...snapshot.typeAliases)
  // `SessionStatus` — a NAMED alias the frontend consumes (StatusBar /
  // ThinkingIndicator / ChatPanel). Canonical inlines the union on
  // `SessionStateView.status`; derive the name FROM it so the two can never
  // diverge (no second literal to maintain).
  sections.push('export type SessionStatus = SessionStateView["status"]')
  sections.push("/* --- Command envelopes (client -> server) ---------------------------- */")
  sections.push(...commands.interfaces, ...commands.typeConsts, ...commands.typeAliases)
  sections.push("/* --- Event envelopes (server -> client) ------------------------------ */")
  sections.push(...events.interfaces, ...events.typeConsts, ...events.typeAliases)

  return `${sections.join("\n\n")}\n`
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const main = (): void => {
  const check = process.argv.includes("--check")
  const generated = generateProtocolBundle()
  const outPath = join(REPO_ROOT, GENERATED_OUTPUT_PATH)
  if (check) {
    const current = readFileSync(outPath, "utf8")
    if (current !== generated) {
      process.stderr.write(
        `[gen-web-frontend-protocol] DRIFT: ${GENERATED_OUTPUT_PATH} is stale.\n` +
          "Run `bun run build:protocol` to regenerate.\n",
      )
      process.exit(1)
    }
    process.stdout.write(`[gen-web-frontend-protocol] up to date: ${GENERATED_OUTPUT_PATH}\n`)
    return
  }
  writeFileSync(outPath, generated)
  process.stdout.write(`[gen-web-frontend-protocol] wrote ${GENERATED_OUTPUT_PATH}\n`)
}

if (import.meta.main) main()
