# TVH-01 — 테스트 안전성·이식성 결함 제거

- 우선순위: P0
- 상태: LANDED — worker HOME 대여 차단·절대경로 3건·SSRF fixture 실 egress 제거·production 소스 스캔까지. 열림: 분류기 정밀도 규칙 LL-b/c/e/f/h 5건 미검증
- 소유 lane: test-runtime safety / browser fixture
- 선행: 없음
- 후속: TVH-03, TVH-06, TVH-07

## 문제

1. 세 테스트가 `/Users/songmin/quanta-codeagent-v3`를 실제 cwd/entrypoint로 사용한다.
2. browser adversarial fixture가 실제 `http://169.254.169.254/latest/meta-data/`로 요청한다.
3. 모든 local shard worker가 scratch HOME 아래에 실제 사용자 `~/Library` 전체를 symlink한다.
4. 이 외부 상태는 cache/receipt identity에 포함되지 않으며 Linux CI와 실행 환경도 다르다.

## 파일·로직별 작업

| 파일 | 대상 | 변경 |
|---|---|---|
| `tests/unit/eval-grounding-cli.test.ts` | `REPO_ROOT`, `runEvalProcess`, `runEvalApplication` | `import.meta.dir`에서 repository root를 계산한다. 임의 cwd/worktree mirror에서도 동일 entry를 찾는 회귀를 추가한다. |
| `tests/integration/cli-live-debug-mode-hellgate.test.ts` | `REPO_ROOT`, `CLI_ENTRY`, `runCli` | 절대 사용자 경로를 제거하고 호출 파일 기준 root를 사용한다. tmp cwd cleanup도 TVH-07 helper로 위임한다. |
| `tests/integration/session-cli-subprocess.test.ts` | `REPO_ROOT`, `CLI_ENTRY`, `SESSION_ENTRY` | public/focused entry 모두 repository-relative resolution을 사용한다. 다른 checkout prefix fixture에서 실제 spawn argv를 검증한다. |
| `tests/integration/browser-real-chrome-adversarial-e2e.test.ts` | `/ssrf-page`, metadata boundary test | link-local metadata endpoint를 실제 호출하지 않는다. loopback fake metadata server 또는 CDP request interception으로 attempt/block/leak 세 상태를 결정적으로 만든다. 실제 `169.254.169.254` literal의 network use를 금지하는 guard를 추가한다. |
| `tools/dev/run-test-shards.ts` | `lendRealUserLibrary`, worker HOME 구성 | 모든 worker에 `~/Library`를 빌려주는 동작을 제거한다. browser 전용 worker만 versioned disposable Chrome profile을 사용하고, 필요한 최소 디렉터리만 생성한다. |
| `tools/dev/test-shard-receipt.ts` | browser runtime identity | browser binary/version/profile schema가 바뀌면 browser receipt가 miss하도록 identity를 확장한다. 전 사용자 Library hash는 수집하지 않는다. |

## 검증

- repository를 다른 절대경로에 둔 mirror에서 세 subprocess test의 entry resolution이 동일하다.
- SSRF fixture 실행 중 link-local 주소로 나가는 socket/connect가 0이다.
- ordinary/pure worker HOME에서 실제 `~/Library`로 이어지는 symlink가 0이다.
- browser fixture는 disposable profile만 읽고 종료 후 삭제한다.
- browser binary/profile 변경을 주입하면 이전 receipt가 miss한다.

## 완료 기준

- [ ] 소스와 테스트 실행 로직에 사용자 checkout 절대경로가 없다.
- [ ] 테스트가 cloud metadata endpoint에 실제 요청하지 않는다.
- [ ] test worker가 사용자 `~/Library` 전체를 노출하지 않는다.
- [ ] local/macOS와 hosted/Linux의 차이가 명시적 capability로 표현된다.

## 진행 (2026-09-12)

- **LANDED `49d86642b`** — worker HOME의 `~/Library` 전면 대여 제거. `browser` class chunk만 대여하고
  `QUANTA_TEST_NO_USER_LIBRARY=1`로 완전 차단. 정책은 `tools/dev/worker-home.ts`(runner는 top-level
  `await main()`이라 import 불가)에 두고, 가드가 decision 함수와 **runner 호출부의 class-aware 여부**를 둘 다 검사한다.
  측정: 추적 3,957 파일 중 `browser` 12개(실제 Chrome 구동은 3개), full plan 44 chunk → 대여 대상이 44→browser chunk로 축소.
  red-on-injection: class 검사 제거 시 2/4 RED, 호출부 무조건화 시 source arm RED.
- **잔여(정직한 blocker)**: browser lane 자체의 `~/Library` 제거는 Chrome capability producer가 disposable
  profile을 소유하고 navigate rate(cold 2/6 vs lent 6/6)를 재측정한 receipt가 있어야 한다. 측정 없이 지우면
  안전 결함을 귀속 불가능한 flake로 바꾼다.
- 절대경로 3개 test entrypoint와 metadata endpoint fixture는 별도 lane에서 진행 중.
