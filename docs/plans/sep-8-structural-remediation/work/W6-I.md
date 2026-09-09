# W6-I receipt

Status: **W6 implemented on local `main`**. Findings implemented. **Not** W7 `verified` 39/39. Push 없음. 제품 커밋은 별도 요청.

Merge order: **R16 leaf (`skill-inputs` + `build-skills`) → reserved/I wiring**. Single writer.

source HEAD snapshot: `d841e134be6d349d949ad3dadecbfe877ec106af` (W5 land; W6 residual uncommitted on top)

## Findings

| ID | Result |
|---|---|
| G-F11 | shared compose; org dir resolved once into snapshot+policy; CLI/web surfaces share the same opt-out/env/malformed policy |
| G-F8 | CLI permission load warn 1회 + fail-soft `undefined`; web durable loader redacts + warn-once; diagnostic throw does not become boot crash |
| G-F13 | preset repo-rules warn 1회 + fail-open; web `agent-config-base` redacts cause without importing apps/agent |

## I applied

- Barrel: `session-authorities/index.ts` exports `composeSessionSkillAuthority` / `resolveOrgConfigDir` / `SkillAdminPolicyLoadError`.
- CLI `buildCliSkillAuthority` / web `buildWebSkillAuthority` call the composer. Malformed policy is not caught.
- `repl.ts` `loadPermissionStore` uses `loadPermissionStoreFailSoft`.
- `runtime-factory.ts` `loadDefaultPermissionStore` redacts with `envelope_jsonl` and swallows warn-sink throws.
- `agent-config-base.ts` keeps `loadRepoRules` fail-open; warn is redacted and cannot convert fallback into throw.
- `system.ts` injects warn sink; glob-rules silent catch also warns.
- `biome.json` allows `tests/{unit,integration}/sep8-remediation/r16/**` to import CLI surfaces (same pattern as r14/r15).
- Integration: `tests/integration/sep8-remediation/r16/org-skill-surfaces.test.ts`.

## Remaining (not W6)

- G-F5.4 EC2 실기 OPEN
- G-F9.4 live Docker/Lima daemon / F-13.2 two-process (excluded)
- W7 I.1–I.8, global `prepush`, 39/39 verified
- Product commit/push
