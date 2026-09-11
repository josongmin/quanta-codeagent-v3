# TVH-11 — discovery/module-load probe 제거와 비용 가시화

- 우선순위: P0/P1
- 상태: LANDED — inventory 4-walk→1 snapshot(ABBA median 124→45ms), module-load external effect 0(4,037 files / 150 effects / 0 violations)
- 소유 lane: test discovery / capability fixtures / timing telemetry
- 선행: TVH-03, TVH-05, TVH-07
- 후속: TVH-10

## 확정 결함

1. `tests/integration/browser-agent-loop-e2e.test.ts:484-536`은 “env-gated” 주석과 달리 실제 gate 없이 top-level await에서 Chrome/CDP를 spawn하고 `Bun.serve`를 시작한다.
2. `tests/integration/browser-real-chrome-e2e.test.ts:85-112,230-263`은 module-load probe와 suite fixture에서 Chrome을 두 번 기동한다. host-pressure scale 적용 시 endpoint/command budget은 최대 75초/150초까지 늘어난다.
3. `tests/contract/lance-real-wire.test.ts:13-48`은 Python 후보 최대 4개를 각 5초씩 직렬 probe한다. LSP contract도 TypeScript/Pyright를 파일별로 다시 probe한다.
4. `tests/unit/tool/debug/debugpy-real-e2e.test.ts:323-352`는 capability lane이 꺼져도 timeout 없는 LLDB discovery를 수행한다.
5. `tests/meta/preload-runtime-closure-hellgate.test.ts:70-100,185-218`은 nested `bun test`와 별도 `bun run` probe를 ordinary meta suite 안에서 시작한다.
6. 현재 JUnit speed budget은 test body duration만 집계하므로 위 import/discovery 비용을 느린 파일로 잡지 못한다.
7. ordinary full에 추가로 Python, ast-grep, Git probe 5개가 top-level `spawnSync`/`execSync`로 실행되고 classifier는 `pure`다. `glob-gitignore-mtime-hellgate`는 import 중 temp tree와 `git init`을 수행한다.

## 구현

- runner가 tier 시작 전 capability를 한 번 probe하고 `capability-receipt.v1`을 immutable 파일로 전달한다.
- test module은 receipt를 파싱해 `executed/skipped-unsupported/blocked/failed-setup`을 선택할 뿐 외부 process/network/server를 시작하지 않는다.
- browser fixture는 capability group당 한 Chrome process와 isolated context/profile을 사용한다. 실패 시 group 전체를 bounded teardown한다.
- Python/LSP/debugger 후보 탐색은 병렬 또는 priority-race로 수행하되 total deadline 하나, loser kill/drain, timer cancel을 보장한다.
- 런너 timing에 `discoveryStart`, `firstCaseStart`, `lastCaseEnd`, `cleanupEnd`를 추가한다. `moduleLoadMs`와 `cleanupMs`를 case duration과 분리한다.
- static gate는 top-level `fetch`, `Bun.spawn*`, `Bun.serve`, install/build 호출을 탐지한다. allowlist는 파일, callsite, owner, expiry, 이유가 필요하다.
- preload runtime closure 같은 필수 실-runtime probe는 `meta-runtime` resource class로 분리하고 작은 producer artifact를 다른 assertion이 소비한다.
- module-load 외부 effect inventory를 Chrome/LSP suffix에 한정하지 않고 모든 top-level sync/async spawn, Git init, temp creation까지 AST 기반으로 닫는다.

## 검증

- Chrome 설치 호스트에서 ordinary file import만으로 Chrome/port/process 수가 변하지 않는다.
- browser 두 파일을 함께 실행해도 capability probe 1회, Chrome fixture 수가 선언값을 넘지 않는다.
- unavailable/hung Python·Chrome·LLDB를 주입해도 total deadline 내 종료하고 survivor/timer가 0이다.
- synthetic 2초 module-load delay가 speed budget의 정확한 파일에 RED를 낸다.
- capability receipt의 HEAD/policy/tool fingerprint가 다르면 spawn 전에 fail closed한다.
- fake PATH의 Python/ast-grep/Git가 hang/absent여도 ordinary module import는 process/temp를 만들지 않고 bounded capability producer만 typed blocked를 반환한다.

## 완료 기준

- [ ] ordinary test module-load external side effect가 0이다.
- [ ] 동일 capability probe를 file 수만큼 반복하지 않는다.
- [ ] discovery/cleanup overhead가 timing top-N과 receipt에 보인다.
- [ ] comment-only env gate가 존재할 수 없도록 manifest와 source가 일치한다.

## 진행 (2026-09-12)

- 작업 중(별도 lane). `tools/dev/capability-probe-producer.ts`, `capability-receipt.ts`,
  `capability-receipt-consumer.ts`, `module-load-effect-guard.ts` 등이 트리에 있으나 미커밋.
- 통합 요구사항: TVH-03의 `tools/dev/test-capability-manifest.ts`와 `quanta.capability-result.v1`이
  이미 착륙했으므로 **세 번째 스키마를 만들지 말 것**.
- 현재 `lint:debt` RED에 이 lane 파일 다수 포함(lsp-pyright/lsp-typescript의 noUnusedVariables 등).
