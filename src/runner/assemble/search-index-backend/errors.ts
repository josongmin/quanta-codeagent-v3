export class EmbeddingSpaceError extends Error {
  readonly kind: "mismatch" | "provider-failed" | "input-too-large" | "unknown-index"
  constructor(
    kind: "mismatch" | "provider-failed" | "input-too-large" | "unknown-index",
    message: string,
  ) {
    super(message)
    this.name = "EmbeddingSpaceError"
    this.kind = kind
  }
}

export class SemanticBackendUnavailableError extends Error {
  readonly phase: "init" | "operation"
  constructor(reason: string, phase: "init" | "operation") {
    super(reason)
    this.name = "SemanticBackendUnavailableError"
    this.phase = phase
  }
}

export type SemanticReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly reason: string; readonly phase: "init" | "operation" }

/** Typed store/space failure — never collapse to a no-hit or warn-and-continue. */
export const isTypedSemanticFailure = (
  e: unknown,
): e is SemanticBackendUnavailableError | EmbeddingSpaceError =>
  e instanceof SemanticBackendUnavailableError ||
  e instanceof EmbeddingSpaceError ||
  (e instanceof Error &&
    (e.name === "SemanticBackendUnavailableError" || e.name === "EmbeddingSpaceError"))
