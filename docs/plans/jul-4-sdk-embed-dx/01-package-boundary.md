# Phase 1 — 공개 경계 (토대·BLOCKER)

어딧 B·C·G 해소. **모든 phase의 선행.**

## 기능 / 왜

- (기능) `quanta-codeagent/sdk` 단일 공개 진입점 + package.exports + drift 가드.
- (왜) `@/...` 내부 alias는 외부 레포에서 안 풀림(어딧 B). 큐레이션 없으면 133필드 누수(어딧 C). fence 없으면 리팩터가 소비자 깸(어딧 G).

## Tasks

1.1 **배럴** `src/sdk/index.ts` — 공개 심볼만 re-export (§08 배럴 스펙). `src/sdk/runtime/**`는 내부로 유지(직접 노출 금지).
1.2 **package.json exports**:
```jsonc
"exports": {
  ".": "./dist/index.js",
  "./sdk": { "types": "./dist/sdk/index.d.ts", "import": "./dist/sdk/index.js" }
}
```
+ `"types"` 최상위, + `build:sdk` 스크립트(tsc emit `dist/sdk`). 기존 CLI 진입점 안 깨지게 `.` 보존.
1.3 **slice-fence 테스트** `tests/unit/sdk/boundary.slice.test.ts`:
   - `src/sdk/**`가 `@/apps/cli`, `@/apps/bench`, `@/apps/agent`를 import하지 않음(정적 스캔, headless `index.ts:9` 패턴).
   - `src/sdk/index.ts`의 export 집합이 화이트리스트와 일치(추가 시 의도적 갱신 강제) — 누수 가드.

## Hellgate

- RED: boundary.slice.test 먼저(현재 sdk 배럴 없음 → red). exports 없음 → 외부 import 실패 재현(문서화).
- 구현: 배럴 + exports + fence.
- 적대 어딧 R1-3: (a) `@/` alias가 dist에 새는지(tsconfig paths→상대경로 emit 확인), (b) 화이트리스트가 타입까지 커버하는지, (c) `.` 진입점 회귀.

## Acceptance

- [ ] `tsc -p tsconfig.sdk.json` emit `dist/sdk/index.d.ts` 존재, `@/` 미포함.
- [ ] boundary.slice.test green.
- [ ] 기존 CLI 빌드/진입 회귀 없음.

## Files

- `src/sdk/index.ts` (신설)
- `package.json` (exports/types/scripts)
- `tsconfig.sdk.json` (신설, emit 타깃)
- `tests/unit/sdk/boundary.slice.test.ts` (신설)
