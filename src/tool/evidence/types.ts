/**
 * Keystone — the unified Evidence Packet handed to the LLM for a failing test.
 * One shape that fuses every signal source: the test failure (run_tests), the
 * runtime state at the failure (DAP), the static context around it (LSP), and
 * the repo context (git). Each source is INDEPENDENTLY optional — a packet is
 * still useful with only some of them (degrade-gracefully).
 */

export interface EvidenceLocation {
  readonly file: string
  readonly line: number
}

export interface EvidenceDiagnostic {
  readonly file: string
  readonly line: number
  readonly severity: string
  readonly message: string
}

/** The failing test (from run_tests). null when the suite is green. */
export interface FailureEvidence {
  readonly command: string
  readonly test_name: string
  readonly message?: string
  readonly file?: string
  readonly line?: number
}

/** Runtime state captured at the failure (from DAP debug_inspect). */
export interface RuntimeEvidence {
  readonly stack: readonly { readonly name: string; readonly file?: string; readonly line: number }[]
  readonly locals: readonly { readonly name: string; readonly value: string }[]
}

/** Static context around the failure site (from LSP). */
export interface StaticEvidence {
  readonly definition_chain: readonly EvidenceLocation[]
  readonly references: readonly EvidenceLocation[]
  readonly type_info: string | null
  readonly diagnostics: readonly EvidenceDiagnostic[]
}

export interface PatchConstraints {
  readonly public_api_change_allowed: boolean
  readonly style?: string
}

/** The full packet (mirrors the agreed LLM-input schema). */
export interface EvidencePacket {
  readonly language: string
  readonly repo_context: {
    readonly changed_files: readonly string[]
    readonly diagnostics: readonly EvidenceDiagnostic[]
  }
  readonly failure: FailureEvidence | null
  readonly runtime: RuntimeEvidence | null
  readonly static: StaticEvidence | null
  readonly patch_constraints: PatchConstraints
}
