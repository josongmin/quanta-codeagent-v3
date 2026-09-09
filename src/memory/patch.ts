import {
  EMBED_DIM,
  MEMORY_KINDS,
  MEMORY_TIERS,
  type MemoryEntry,
  type MemoryPatch,
  normalizeEntry,
} from "./types"

/** The exact persisted columns callers may mutate. Store identity/clocks are absent by design. */
export const MEMORY_PATCH_FIELDS = [
  "kind",
  "tier",
  "text",
  "tags",
  "importance",
  "accessCount",
  "lastAccessedAt",
  "lastDecayedAt",
  "embedding",
  "supersededBy",
  "sessionId",
  "taskGroup",
  "appliesTo",
  "reuseRule",
] as const satisfies ReadonlyArray<keyof MemoryPatch>

export type MemoryPatchField = (typeof MEMORY_PATCH_FIELDS)[number]

const PATCH_FIELD_SET = new Set<string>(MEMORY_PATCH_FIELDS)

export class InvalidMemoryPatchError extends Error {
  readonly field: string

  constructor(field: string, reason: string) {
    super(`invalid memory patch field ${field}: ${reason}`)
    this.name = "InvalidMemoryPatchError"
    this.field = field
  }
}

const finiteNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value)
const nonEmptyString = (value: unknown): boolean => typeof value === "string" && value.length > 0
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
const appliesTo = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).every((key) => key === "cwd") &&
  nonEmptyString((value as { cwd?: unknown }).cwd)

const PATCH_VALUE_VALIDATORS: Record<MemoryPatchField, (value: unknown) => boolean> = {
  kind: (value) => typeof value === "string" && MEMORY_KINDS.includes(value as never),
  tier: (value) => typeof value === "string" && MEMORY_TIERS.includes(value as never),
  text: (value) => typeof value === "string",
  tags: stringArray,
  importance: (value) => finiteNumber(value) && (value as number) >= 0 && (value as number) <= 1,
  accessCount: (value) => finiteNumber(value) && Number.isInteger(value) && (value as number) >= 0,
  lastAccessedAt: finiteNumber,
  lastDecayedAt: finiteNumber,
  embedding: (value) =>
    Array.isArray(value) && value.length === EMBED_DIM && value.every(finiteNumber),
  supersededBy: nonEmptyString,
  sessionId: nonEmptyString,
  taskGroup: nonEmptyString,
  appliesTo,
  reuseRule: nonEmptyString,
}

/** Fail closed for JS/untyped callers as well as TypeScript callers. */
export const assertValidMemoryPatch = (patch: MemoryPatch): void => {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new InvalidMemoryPatchError("<patch>", "expected an object")
  }
  for (const [rawField, value] of Object.entries(patch)) {
    if (!PATCH_FIELD_SET.has(rawField)) {
      throw new InvalidMemoryPatchError(rawField, "field is immutable or unknown")
    }
    const field = rawField as MemoryPatchField
    if (value === undefined) {
      if (field !== "embedding") {
        throw new InvalidMemoryPatchError(field, "undefined is only valid for embedding clear")
      }
      continue
    }
    if (!PATCH_VALUE_VALIDATORS[field](value)) {
      throw new InvalidMemoryPatchError(field, "value violates the field contract")
    }
  }
}

/** Shared in-memory patch algebra; SQLite shares its validator and field registry. */
export const applyMemoryPatch = (
  existing: MemoryEntry,
  patch: MemoryPatch,
  updatedAt: number,
): MemoryEntry => {
  assertValidMemoryPatch(patch)
  const next = { ...existing, updatedAt } as MemoryEntry & Record<string, unknown>
  for (const field of MEMORY_PATCH_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue
    const value = patch[field]
    if (field === "embedding" && value === undefined) delete next.embedding
    else Object.assign(next, { [field]: value })
  }
  return normalizeEntry(next)
}
