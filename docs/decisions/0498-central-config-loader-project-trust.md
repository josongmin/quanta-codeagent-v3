# ADR-0498: central on-disk config loader + per-project trust gate

- **상태**: Accepted
- **날짜**: 2026-06-07
- **슬라이스**: `@/config` (신규) — layered file reader + precedence merge + per-project trust store
- **티켓**: `docs/tickets/misc-jun-7/05-central-config-trust.md`
- **게이트**: `QUANTA_CENTRAL_CONFIG` (strict `=== "1"`, default-OFF)

## Context

quanta loads settings essentially env-only (`src/shared/runtime-config.ts`의 frozen
`loadFromEnv`). 중앙 on-disk config loader도, per-project trust 개념도 `src/`에 없다
(`projectTrust`/`trustDialog`/`trust_level` grep 0). 그럼에도 `apps/agent/index.ts:206`
은 이미 `<cwd>/settings.json#hooks`를 **trust 게이트 없이** 읽는다 — hostile repo가
`PreToolUse` 커맨드 훅 / MCP 런처 / `permissions.allow`를 심으면 clone = shell 헌납.

경쟁사(Claude Code, Codex)는 공통적으로 (a) machine-owned **managed** layer가 repo
layer를 못 덮는 layered on-disk config, (b) path-keyed **default-untrusted** per-project
trust gate를 갖는다.

## Decision

신규 `@/config` closed-port 슬라이스:

1. **Layered loader** (`loader.ts`) — `managed > user > project > local` 4 layer를
   fail-soft per-layer parse. 누락 ⇒ skip, malformed ⇒ skip + 1 warn (never throw,
   never half-apply), EACCES 같은 실 IO 폴트는 propagate. 파일 read는 `ReadTextPort`
   주입(closed port) — default-OFF에서 read 0을 hellgate로 검증 가능.
2. **Merge** (`merge.ts`) — precedence + **managed-non-overridable**
   (`allowManagedPermissionRulesOnly`/`allowManagedHooksOnly`; Claude verbatim) +
   **trust gate**. deny는 항상 allow를 이긴다.
3. **Trust store** (`trust-store.ts`) — canonical path 키, default **UNTRUSTED**.
   `/a` trust가 `/b`나 `/a/sub`로 새지 않음(path-pinned); `./X`/`/a/./X`/trailing-slash는
   1 키로 canonicalize. 명시적 grant만(`setTrusted`). persistence는 주입.
4. **Trust gate 규칙** (security crux): UNTRUSTED repo의 project/local layer는
   capability-granting(allow/ask/hooks/mcp)을 **전부 drop**, managed+user만 적용.
   단 **tightening(deny)은 untrust여도 적용**(repo가 자기 경계를 좁히는 건 안전).
   drop된 layer는 `droppedForUntrust`로 관측(parity: `tengu_settings_*_untrusted_source_ignored`).
5. **runtime-config 배선** — `QUANTA_CENTRAL_CONFIG` strict gate가 이미 존재
   (Knobs phase). 추가 optional field: `centralConfigDir`(USER layer dir override),
   `centralConfigSources`(`--setting-sources` analogue), `trustedPaths`(headless/CI
   static allow-list). 모두 absent ⇒ undefined ⇒ byte-identical. disk는 env 아래에서만
   consult: **env > managed > user > (trusted)project > (trusted)local**, 단
   managed-non-overridable 키는 org-locked(env로 못 덮음).
6. **§2 ungated read 봉합** — `@/agent/command-hooks/settings-loader.ts`에
   `bindingsFromHookEvents`(resolved+trust-gated hook events → `CommandHookBinding[]`)
   추가. central-config ON 경로에서 hostile repo의 hook 커맨드는 merge 단계에서 이미
   drop되어 binding이 0이 된다.

## Open questions (resolved — conservative)

1. **파일 포맷**: JSON (기존 `settings-loader.ts`/`@/migration`/IDE-spec 스키마 재사용).
2. **env vs managed**: 기본 env > disk; 단 managed-non-overridable 플래그가 붙은
   security 키는 managed가 env를 이긴다(lockdown).
3. **headless/CI trust grant**: headless ⇒ untrusted by default. 명시적
   `QUANTA_TRUSTED_PATHS`(static allow-list)로만 opt-in; cwd auto-trust 절대 없음.
4. **ticket 04 untrusted-source fence**: 이 trust-store가 단일 SSOT(`isProjectTrusted`).
5. **managed discovery path (macOS/Linux)**: host가 OS별 non-user-writable 경로를
   계산해 `managedPath`로 주입(슬라이스는 path를 받기만 함 — OS 경로 enumeration은
   composition-root follow-up).
6. **untrusted repo의 benign 키**: v1은 repo band 전체에서 capability 키만 drop하고
   benign(model)은 통과 — 단순/안전. 더 세밀한 분리는 실수요 발생 시.

## Default-OFF byte-identity

`QUANTA_CENTRAL_CONFIG` 미설정 ⇒ disk loader 호출 0, file IO 0, trust-store 할당 0,
`runtimeConfig()`는 기존 env-parse와 byte-identical(신규 field는 전부 undefined).

## Consequences

- 어떤 repo-local config든 안전하게 honor하는 전제조건(ticket 04 auto-mode overlay,
  `.mcp.json`/`.quanta/agents` repo-local read 전부 이 게이트를 재사용 가능).
- Residual: 한 번 trust된 repo가 이후 hostile 커밋으로 `.quanta/settings.json`을 바꾸면
  여전히 honor됨(trust는 path-level, content-level 아님 — Claude/Codex 동일 residual).
  re-prompt on settings change는 follow-up.
