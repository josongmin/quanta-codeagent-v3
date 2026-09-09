# W6-I receipt

Status: **W6 implemented on local `main`**. Findings implemented. **Not** W7 `verified` 39/39. Push 없음. 제품 커밋은 별도 요청.

Merge order: **R16 leaf (`skill-inputs` + `build-skills`) → reserved/I wiring**. Single writer.

source HEAD snapshot (W4 land; W5+W6 uncommitted on top): `c156d76397feb63ec1c4992c07d011dd0647a4c6`

## Findings

| ID | Result |
|---|---|
| G-F11 | shared compose; org dir resolved once into snapshot+policy |
| G-F8 | CLI permission load warn 1회 + fail-soft `undefined` |
| G-F13 | preset repo-rules warn 1회 + fail-open; cause redacted |

## I applied

- Barrel: `session-authorities/index.ts` exports `composeSessionSkillAuthority` / `resolveOrgConfigDir` / `SkillAdminPolicyLoadError`.
- CLI `buildCliSkillAuthority` / web `buildWebSkillAuthority` call the composer. Malformed policy is not caught.
- `repl.ts` `loadPermissionStore` uses `loadPermissionStoreFailSoft`.
- `system.ts` injects warn sink; glob-rules silent catch also warns.
- `biome.json` allows `tests/{unit,integration}/sep8-remediation/r16/**` to import CLI surfaces (same pattern as r14/r15).

## Remaining (not W6)

- G-F5.4 EC2 실기 OPEN
- G-F9.4 live Docker/Lima daemon / F-13.2 two-process (excluded)
- W7 I.1–I.8, global `prepush`, 39/39 verified
- Product commit/push
