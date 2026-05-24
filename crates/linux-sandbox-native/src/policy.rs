//! Policy compile layer: `NapiSandboxPolicy` → `landlock::Ruleset`.
//!
//! **Scaffold** (ADR-0175 Phase 3). Function bodies are `unimplemented!()`.
//! The shape mirrors `src/runtime/os-sandbox/landlock-cli.ts` and
//! `bubblewrap.ts` from the Phase 2 TypeScript compilers so behavior
//! parity audit is mechanical.
//!
//! ## Mapping (Phase 3.1 target)
//!
//! | TS profile             | Landlock access rights (PathBeneath) |
//! |------------------------|--------------------------------------|
//! | `read-only`            | system RO paths + workspace RO        |
//! | `workspace-write`      | system RO + workspace RW              |
//! | `workspace-write-net`  | same as workspace-write + net-allow   |
//! | `off` / `danger-full-access` | caller bypass — never reaches here |
//!
//! System ambient RO paths (Phase 3.1, matches `landlock-cli.ts:64`):
//!   `/usr`, `/lib`, `/lib64`, `/etc`, `/bin`, `/sbin`
//!
//! Extras filtering rules (Phase 3.1):
//!   - relative paths → silently dropped (landlock requires absolute)
//!   - `/proc`/`/sys` prefixes → silently dropped (kernel-reserved)
//!
//! Network policy: Landlock ABI v4+ supports `bind`/`connect` rule scopes.
//! Phase 3.1 detects ABI via `landlock::ABI::new_current()` and emits net
//! deny when both (a) profile demands it AND (b) ABI ≥ 4. On older kernels
//! the net rule is silently dropped and the TS adapter surfaces a
//! `degradeReason: "landlock-network-policy-not-enforced"` (parity with
//! Phase 2 landlock-cli fallback).

use crate::NapiSandboxPolicy;

/// Compiled landlock ruleset placeholder.
///
/// Phase 3.1 returns the real `landlock::Ruleset` type; until then we
/// return a unit type so the API shape compiles without dragging the
/// landlock crate into every scaffold include path.
pub struct CompiledRuleset;

/// Compile `policy` to a landlock `Ruleset`.
///
/// Scaffold: returns `unimplemented!()`. Phase 3.1 wires:
///   1. `landlock::ABI::new_current()` to bind the highest-supported ABI.
///   2. Walk system RO paths + workspace + extras, calling
///      `PathBeneath::new(ABI).access(...)` for each.
///   3. Optionally add net rules when ABI ≥ 4 and policy denies network.
///   4. Return the compiled ruleset.
pub fn compile_ruleset(_policy: &NapiSandboxPolicy) -> Result<CompiledRuleset, String> {
    unimplemented!("policy::compile_ruleset — Phase 3.1 (see ADR-0175)")
}

/// Apply a compiled ruleset to the CURRENT thread (post-fork / pre-exec).
///
/// Scaffold: `unimplemented!()`. Phase 3.1 calls `ruleset.restrict_self()`
/// and maps the result to typed errors.
pub fn apply_ruleset(_ruleset: &CompiledRuleset) -> Result<(), String> {
    unimplemented!("policy::apply_ruleset — Phase 3.1 (see ADR-0175)")
}
