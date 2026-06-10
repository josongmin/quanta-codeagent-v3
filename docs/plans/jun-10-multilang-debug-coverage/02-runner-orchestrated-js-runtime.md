# T-02 — 러너-orchestrate JS/TS runtime (jest/vitest 단일파일 CDP)

- **상태**: OPEN. 우선순위 2.
- **충돌주의**: `src/tool/evidence/runtime.ts` `nodeRuntime`.

## 기능 / 왜 / ROI
- **(기능)** jest/vitest/mocha로 돌아가는 테스트의 **단일 실패파일**을 해당 러너 CLI로 `node --inspect-brk` 하에 실행해 CDP 포착.
- **(왜)** 현 `nodeRuntime`은 `node --inspect-brk <file>`로 파일을 **직접** 실행([runtime.ts](../../../src/tool/evidence/runtime.ts)). node:test 자체실행 파일·단순 .ts는 되지만 jest/vitest는 러너가 변환/수집/실행을 감싸므로 직접 실행 불가. `--test`는 파일당 child fork라 CDP가 러너에 붙는 함정(이미 회피).
- **(ROI)** 중. JS 생태계 다수가 jest/vitest. failure+static은 이미 전 JS 커버(D08), runtime만 러너별 확대.

## 접근 (grounded)
1. 러너 감지: package.json devDeps / 설정파일(jest.config·vitest.config) or test-output 시그니처. (D03 detect 확장점 재사용.)
2. 러너별 단일파일 inspect 커맨드:
   - vitest: `node --inspect-brk node_modules/vitest/vitest.mjs run <file> --no-file-parallelism`
   - jest: `node --inspect-brk node_modules/.bin/jest --runInBand <file>`
   - 단일프로세스 보장(병렬/fork OFF) — 안 그러면 CDP가 메인에 붙어 bp 안 맞음.
3. `nodeRuntime`이 toolchain 힌트(or 재감지)로 커맨드 분기. inspectViaCdp는 무변경(bp file url + line 그대로).
4. TS: node 23.6+ type-strip 직접 / 아니면 러너의 transform 경유(러너 경로면 자동).

## 컴포넌트 DoD (§2)
- 러너 미설치/미감지 → null degrade(현 동작 유지).
- REAL e2e: vitest(설치) 단일 실패 테스트 → `result` 실 포착. (없으면 auto-skip.)
- 단일프로세스 검증(json/list 엔트리 1 — D10서 쓴 측정 패턴).

## repo-green DoD (§4)
- src tsc 0 / 건든 테스트 0 신규 / 스위트 0 fail.
