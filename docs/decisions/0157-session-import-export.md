# ADR-0157: Session import / export envelope

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0124 (ConversationCheckpointStore serialize/hydrate — sidecar source), ADR-0128 (PlanQueueStore serialize/hydrate — sidecar source), ADR-0138 (BudgetLedger serialize/hydrate — sidecar source), ADR-0106 (SessionMeta git fingerprint — exported as part of meta)
- **참조**:
  - `src/session/import-export.ts` — 순수 직렬화 port: `SessionExportEnvelope` (`version: 1` + `exporterMeta` + `session` + 선택적 `sidecar`), `exportSession` / `importSession` / `*FromJson` 변형 + 타입드 `SessionImportError`(`malformed`|`unsupported-version`|`version-mismatch`).
  - `src/session/import-export-fs.ts` — FS 어댑터: `exportSessionToFile` / `importSessionFromFile`. Bun.file/Bun.write 위 thin wrapper, 누락 파일은 `malformed` 로 정규화.
  - `src/session/index.ts` — 배럴 export 추가 (타입 4 + 함수 5 + 에러 1).
  - `tests/unit/session-import-export-hellgate.test.ts` — 18 case (스펙 명시 16 + clone-isolation 2). A 라운드트립 4 / B 검증 5 / C 버전델타 3 / D 플랫폼델타 2 / E FS 어댑터 2 / extra 2.

## Context

오늘 세션은 워크스페이스-스코프 저장소(`~/.quanta/sessions/<id>.json`)에 산다. 사용자가 다음을 원할 때 타입드 primitive 가 없다:

- 디버깅 / 아카이브 / 공유 목적의 export
- 다른 워크스페이스로 import (동료 머신에서 리뷰 등)
- CI replay 테스트를 위해 라운드트립

수동으로 raw JSON 을 복사하는 방식은 버전 provenance, sidecar 상태 (memory snapshot / budget / plan queue), 플랫폼 메타가 손실된다.

본 ADR 은 그 타입드 surface 를 추가한다. ADR-0124/0128/0138 가 만든 per-subsystem `serialize/hydrate` 패턴을 한 envelope 안에 합성해, agent 의 복원 가능한 전체 상태를 단일 파일로 round-trip 한다.

## Decision

**버전드 envelope + JSON wire + 선택적 sidecar + warnings + strict mode**:

```ts
interface SessionExportEnvelope {
  readonly version: 1
  readonly exportedAt: number          // injected now()
  readonly exporterMeta: {
    readonly quantaVersion: string     // caller supplies (from package.json)
    readonly platform: NodeJS.Platform // process.platform
  }
  readonly session: SavedSession       // deep-cloned (JSON round-trip)
  readonly sidecar?: {
    readonly conversationCheckpoint?: string  // ADR-0124 serialize() output
    readonly budgetLedger?: string             // ADR-0138 serialize() output
    readonly planQueue?: string                // ADR-0128 serialize() output
  }
}
```

핵심 결정:

1. **Pure port + 별도 FS 어댑터**. `import-export.ts` 는 `node:fs` 미사용 — 메모리 round-trip 만 필요한 호출자 (CI replay 버퍼, IPC 마샬링, 브라우저 테스트) 에서 그대로 동작. FS 작업은 `import-export-fs.ts` 가 `Bun.file`/`Bun.write` 로만 수행.
2. **Wire-stable `version: 1`**. 미래 schema bump 은 `version: 2` 로 additive 추가. importer 가 `version` 으로 분기.
3. **Sidecar 는 pre-serialized 문자열 합성**. 본 slice 가 ConversationCheckpointStore/BudgetLedger/PlanQueueStore 의 내부 shape 을 알 필요 없음 — 각 subsystem 의 `serialize()` 출력을 그대로 운반, importer 가 해당 subsystem 의 `hydrate()` 로 복원. responsibility split.
4. **Deep-clone on export AND import**. JSON round-trip 으로 envelope 가 호출자의 live mutable 카피와 디커플. 두 쪽 모두에서 mutate 자유.
5. **Warnings, not failures**. 버전 / 플랫폼 mismatch 는 기본적으로 warning array 에 담기고 import 는 성공. `strictVersion: true` 일 때만 version mismatch 가 typed throw 로 승격 — CI replay 처럼 drift 가 테스트 무효화인 경우용.
6. **exactOptional 엄격**. `sidecar`, `platform` 등 optional 필드는 부재 시 wire 와 result 양쪽에서 키 자체 부재 (`"sidecar" in env === false`), `undefined` 절대 없음.
7. **타입드 에러 1종, 3 코드**. `SessionImportError` 의 `code` 가 `malformed` | `unsupported-version` | `version-mismatch` — 호출자 단일 try/catch, 코드로 분기.
8. **No zod 의존**. outer envelope shape 만 손-검증 (브라우저 호환). 내부 `SavedSession` 의 deep 검증은 `loadSessionById` 의 기존 zod schema 에 맡김 — 본 slice 가 `loadSessionById` 를 호출하지 않으므로 책임 분리.
9. **Plane-clean**. `import-export.ts` 는 `./types` 만, `import-export-fs.ts` 는 `./import-export` + `./types` + Bun globals 만. `@/agent/*`, `@/storage`, `node:fs` 미사용.

## Hellgate (18 case)

`tests/unit/session-import-export-hellgate.test.ts`:

| slice | case | 봉인하는 invariant |
|---|---|---|
| A.1 | HELL-1 | export → import 라운드트립이 structurally-equal |
| A.2 | HELL-2 | `exporterMeta.quantaVersion` + `platform` 운반 |
| A.3 | HELL-3 | `exportedAt` 가 injected `now()` 사용 |
| A.4 | HELL-4 | sidecar 3 필드 라운드트립 보존 |
| B.5 | HELL-5 | `version !== 1` → `unsupported-version` |
| B.6 | HELL-6 | 필수 필드 누락 → `malformed` |
| B.7 | HELL-7 | JSON 파싱 실패 → `malformed` (FromJson) |
| B.8 | HELL-8 | 빈 `messages` 배열은 valid |
| B.9 | HELL-9 | sidecar 부재 → envelope 와 result 양쪽에서 key 부재 (`"sidecar" in x === false`) |
| C.10 | HELL-10 | 동일 버전 → `versionDelta.same = true` + warnings 비움 |
| C.11 | HELL-11 | 다른 버전 → warnings 에 version mismatch 메시지 |
| C.12 | HELL-12 | `strictVersion: true` + mismatch → `version-mismatch` throw |
| D.13 | HELL-13 | 다른 플랫폼 → warnings 에 platform 노트 |
| D.14 | HELL-14 | 동일 플랫폼 → platform warning 없음 |
| E.15 | HELL-15 | tmpdir 경유 file round-trip |
| E.16 | HELL-16 | 누락 파일 → `malformed` typed throw |
| extra | HELL-17 | export 후 source 변경이 envelope 에 영향 없음 (deep-clone isolation, Contract clause #5) |
| extra | HELL-18 | `exportSessionToJson` 출력이 `importSessionFromJson` 로 그대로 라운드트립 |

## Default-OFF

오늘 loop / CLI / agent bootstrap 중 어느 것도 `exportSession` / `importSession` 을 부르지 않는다. 호출자가 wire 해야 동작:

- 향후 `/session export <path>` 슬래시 커맨드 — `apps/cli` 가 본 slice 호출.
- CI replay 하네스 — golden session 을 `exportSessionToFile` 로 저장 후 다른 머신에서 `importSessionFromFile` → replay.
- 디버깅 surface — failure 시점에 자동 export (옵트-인).

## Alternatives rejected

1. **SQLite dump (`.dump`)** — 워크스페이스 sessions DB 통째로 직렬화. 의존이 워크스페이스 스키마에 강결합 + import 측이 SQLite 를 가져야 함 + 다중 세션 의도치 않은 export. 기각.
2. **tar archive** — 디렉토리 통째로. 버전 헤더 없음, sidecar 합성도 ad-hoc 디렉토리 구조, 정형 검증 불가. 기각.
3. **DB-backed export queue (per-session pending → push)** — overkill. user 가 명시적으로 export 하는 1회성 작업에 비동기 큐 도입 정당화 안 됨. 기각.
4. **zod schema for outer envelope** — 정확하나 zod 를 본 slice 의존성으로 추가 (현재 `node:fs` 없이 브라우저-호환). 외부 envelope 의 키 4개 검증을 위해 zod 도입 ROI 부족. 손-검증 채택.
5. **`structuredClone` for deep-clone** — `SavedSession` 은 모두 primitive + array + plain object 이므로 JSON round-trip 과 동등. JSON 이 추가로 wire-shape 검증을 한 번 수행 (NaN / function / undefined → 거름). JSON 채택.
6. **`platform` 자동 비교를 default-strict** — drift 가 흔하고 (linux dev → darwin reviewer) blocking error 로 만들면 흐름 차단. warning 만, strict 는 caller opt-in. 채택된 default.

## SOTA++ 자리매김

| 시스템 | 세션 import/export primitive |
|---|---|
| Claude Code 2.1 | 없음. `~/.claude/projects/<workspace-hash>/*.jsonl` 을 manually 복사 가능하나 workspace-hash 가 cwd 의존이라 cross-host 깨짐 |
| Codex 0.131 | `archived_sessions/*.jsonl` 가 envelope 형태 (ADR-0035) 이지만 import 측 API 없음 — 디렉토리 통째로 복사가 유일 경로 |
| Cursor 3.2 | 없음. session DB 통째 복사, version provenance 없음 |
| Cline | 없음 |
| **quanta** (본 ADR) | 타입드 envelope + sidecar 합성 + 버전 delta + strict 모드 + FS 어댑터 분리 |

quanta 가 first-class typed primitive 를 가진 첫 agent.

## Caveat

1. **Secrets in messages**. `SavedSession.messages` 에 API key / 사내 비밀이 들어 있을 수 있음. 본 slice 는 redact 안 함 — caller 책임. Follow-up 으로 secret-redact 옵션 (`SessionExportOpts.redactor: (msg) => msg`) 검토.
2. **JSON wire 사이즈**. pretty-print (`indent: 2`) 이므로 대형 세션 (`messages.length > 10k`, `>5MB`) 에서 size 비용 있음. Follow-up 으로 `compact?: boolean` 옵션 검토. 현재 size < 1MB 가정.
3. **sidecar 의 hydrate 실패는 import slice 책임 아님**. envelope 에 잘못된 sidecar 문자열이 와도 본 slice 는 통과시키고 호출자가 ConversationCheckpointStore.hydrate 등에서 발견. ADR-0124/0138 가 hydrate-safe (corrupt → empty) 이므로 graceful fail.

## Follow-up

- **Redact-on-export** — `SessionExportOpts.redactor` 콜백으로 message content 통과 시 마스킹. ChatGPT API key / OAuth token 패턴 regex 기본 제공.
- **Sidecar diff between import and current state** — import 직후 현재 워크스페이스의 budget/plan/checkpoint 와 차이 표면화 (replace vs. merge UX).
- **Agent shadow ODB snapshot in sidecar** — ADR-0118 ShadowOdb 의 직렬화 (현재 미존재). 파일 state 까지 함께 round-trip 가능.
- **`compact: true` option** — 대형 세션용 minified JSON.
- **`SessionExportEnvelope` version 2 — sidecar 정형화** — 현재 sidecar 는 opaque 문자열 3종. v2 에서 각 subsystem 의 schema 를 본 슬라이스에 import 해 validate (단, plane-clean 트레이드오프 재평가 필요).
