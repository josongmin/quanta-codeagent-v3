# TVH-04 — resource certification·scheduler·lease 실배선

- 우선순위: P1
- 상태: LANDED (scheduler 전환은 1/2/4 canary 대기)
- 소유 lane: scheduler / resource certification / lease
- 선행: TVH-02, TVH-03
- 후속: TVH-05, TVH-09

## 현재 결함

- integration-path 561개가 전부 미인증이다. registry는 비어 있다.
- classifier는 resource 하나만 고른다. 여러 resource를 쓰는 파일에서 앞선 regex가 뒤 위험을 숨길 수 있다.
- `pathResources`는 빈 source로 분류하고 실제 planner는 source를 다시 읽어 356파일이 불일치한다.
- policy의 `resources`, `cost`, `requiredCapabilities`는 scheduler 입력이 아니다.
- `VALIDATED_NONPURE_OVERLAPS`가 비어 있어 20개 non-pure chunk가 완전 직렬이다.
- keyed lease primitive는 production runner에 연결되지 않았고 shared/shared mode를 표현하지 못한다.
- resource key composite를 repository remote normalization에 통과시키면 path-like key의 prefix/scope가 손실될 수 있다.
- whole-campaign repository lease는 contender를 최대 90분 대기시킨다.
- campaign 시작 시 고정한 `intraParallel`과 실행 직전 재계산하는 worker 수가 서로 다른 load/memory snapshot을 사용한다. 회복 시 8-wide chunk 두 개가 겹치는 식으로 초기 CPU 예산을 초과할 수 있다.
- source regex는 직접 effect만 보므로 `main()`이 내부에서 daemon/port를 여는 web-daemon tests, child process를 여는 file-transaction test, 대형 메모리 fixture를 모두 `pure`로 분류한다.
- contract package script는 `--parallel=1`인데 gate/hosted CI의 direct command는 이 제약을 우회한다. Docker/LSP/Python 계약 테스트가 certification 없는 default parallelism으로 실행될 수 있다.
- whole-campaign lease를 취득한 뒤 최대 180초 quiet-box admission을 기다린다. 이 구간에는 repository 작업이 없지만 다른 checkout의 모든 verification contender가 exclusive lease 뒤에서 대기한다.
- file-level claim은 내부 child multiplicity를 표현하지 않는다. bench auth-pool/index-dataset files는 `test.concurrent`에서 hard-coded cap 4로 real Bun CLI를 동시에 spawn하지만 scheduler에는 integration-path 하나로만 보인다.
- 모든 chunk가 실제 사용 여부와 무관하게 외부 tool 18개의 global fingerprint를 공유해 cache/resource dependency가 과대 선언된다.
- inherited lease bypass는 live ancestor PID와 64-hex token 모양만 검증하고 실제 repository lease listener ownership을 확인하지 않는다.

## 작업

1. `TestResourceClass` 단일 enum을 typed claim set으로 교체한다.
2. claim은 최소 `checkout`, `git-common`, `cache`, `port`, `browser-profile`, `lsp-workspace`, `process-env`, `child-process`, `docker-daemon`, `host-cpu`, `host-memory`를 지원한다.
3. 561개를 source digest 기반 `certified` 또는 `intentionally-exclusive`로 전수 분류한다.
4. missing/source-drift/parser-error/unknown claim은 exclusive fallback이다.
5. policy를 한 번 source-aware하게 resolve하고 동일 snapshot을 planner, scheduler, receipt가 소비한다.
6. keyed lease는 raw key를 stable hash해 사용하고 shared/exclusive mode, canonical lock order, partial rollback을 제공한다.
7. certification 완료 전에는 whole lease를 유지한다. 이후 checkout/git-common/cache/host key를 단계적으로 분리한다.
8. out-of-band PTY/contract도 동일 resource runner 또는 명시적 exclusive wrapper를 사용한다.
9. worker 수와 chunk 내부 병렬도는 각 dispatch 시점의 단일 atomic CPU/memory budget에서 함께 결정한다. 둘의 곱과 host claim을 receipt에 기록한다.
10. claim은 직접 source token이 아니라 test fixture/adapter의 transitive effect manifest를 포함한다. `cpu-heavy`, `memory-heavy`, `output-heavy`, `disk-heavy` weight를 TVH-13 admission에 전달한다.
11. quiet-box pre-admission은 exclusive repository lease 전에 수행하고, 취득 직후 짧은 bounded recheck로 TOCTOU를 막는다. 대기 순서 보존이 필요하면 admission/shared phase와 execution/exclusive phase를 명시적으로 분리한다.
12. file claim에 `maxChildProcesses`, CPU/memory/output multiplicity를 포함하고 local executor는 runner가 부여한 permit을 소비한다. hard-coded nested concurrency는 금지한다.
13. certified claim이 필요한 external tool subset을 cache identity와 scheduler에 함께 전달한다. unknown은 all-tool exclusive fallback이다.
14. inherited lease는 wrapper listener가 발행한 nonce/identity handshake와 repository key를 검증하고 owner death/rebind에서 fail closed한다.

## 수정 파일

- `tools/dev/test-resource-certification.ts`
- `tools/dev/test-resource-certification-audit.ts`
- `tools/dev/test-resource-certifications.json`
- `tools/dev/test-policy.ts`
- `tools/dev/test-shard-plan.ts`
- `tools/dev/test-shard-lease.ts`
- `tools/dev/test-shard-lifecycle.ts`
- `tools/dev/run-test-shards.ts`
- `tools/dev/gate-manifest.ts`

## 회귀 rail

- source에 browser+worktree, port+process-env 등 복수 claim을 주입하면 모두 보존된다.
- 같은 key의 shared/shared만 overlap하고 shared/exclusive, exclusive/exclusive는 충돌한다.
- 반대 key 순서로 취득해도 deadlock이 없다.
- 부분 취득 후 취소/throw에서 역순 release와 재취득이 가능하다.
- certification source digest drift 시 병렬 실행이 아니라 exclusive fallback이다.
- 1/2/4 worker canary의 test ID/verdict가 동일하고 충돌 0이다.
- load/memory가 campaign 중 변해도 `workers × intraParallel`이 선언한 host budget을 넘지 않는다.
- `main()`/fixture helper 뒤에 숨은 port/process/memory effect를 주입하면 `pure`가 아니라 정확한 복수 claim으로 분류된다.
- canonical contract command를 package/gate/workflow 어느 경로로 호출해도 동일 claim과 max concurrency가 적용된다.
- saturated host에서 admission 중인 campaign이 exclusive repository lease를 소유하지 않고 두 번째 contender의 read-only/static phase를 막지 않는다.
- runner budget 2에서 내부 cap 4 file의 active child peak가 2 이하이고 unclaimed tool 변화는 pure chunk scheduling/cache를 바꾸지 않는다.
- fake token+live ancestor지만 matching listener가 없는 child는 lease bypass 0이고 실제 wrapper child만 inherited ownership을 인정받는다.

## 완료 기준

- [ ] 561개 missing이 0이다.
- [ ] policy와 planner resource 불일치가 0이다.
- [ ] production runner가 certification digest와 acquired keys를 receipt에 기록한다.
- [ ] lease 분할 후에도 checkout/git-common/cache 충돌이 없다.

## 진행 (2026-09-12)

- **LANDED `5c0754ab0`** — 두 숫자, 둘 다 실측.

      policy/planner mismatch   362 → 0     (통합 시 독립 재확인)
      certification            562 missing → 548 certified / 14 intentionally-exclusive

  `pathResources`가 `classifyTestResource(id, "")`로 **빈 소스**를 넘겨서 path 휴리스틱이 항상 이겼고,
  3,962개 중 362개가 planner가 실제 소스에서 계산한 값과 달랐다. `policy.resources`는 허구였고
  scheduler는 애초에 그걸 쓰지도 않았다.

- **단일 class가 위험을 가리고 있었다.** `classifyTestResource`는 첫 regex 매치를 반환하므로
  Chrome을 띄우면서 worktree도 만드는 파일이 `worktree`로 채점됐고, `worktree`는 `pure`와 overlap한다.
  2026-09-02 scar 그 자체가 보이지 않는 형태로 남아 있었다.

      browser-worktree.test.ts   first-match: worktree
                                 claims: browser-profile, git-common, host-cpu

- **격리는 약화되지 않았다.** `resourceClassesOverlap`을 claim set에서 계산하되
  기존 8×8 호환 행렬을 **셀 단위로 그대로** 재현한다(리터럴 표로 단언, spot-check 아님).

- **정직한 부분: 현재 인증은 chunk 수준 병렬성을 0만큼 산다.**
  class-level overlappable pair 732, claim-level 732, 새로 허용 0.
  원인은 chunk **구성**이다 — membership이 class+sha bucket이라 chunk가 ~70개 파일의 claim 합집합을
  소유하고, integration-path chunk 8개 중 6개가 14개 exclusive 파일 중 하나를 품는다.
  파일 단위로는 다르다: 서로 다른 claim signature 30개, signature pair의 27%가 호환, 17개는 claim이 없다.
  다음 슬라이스는 claim-signature bucketing이며 ROI와 함께 handoff에 적었다.

- 인증은 import closure fixpoint(3,352 모듈)로 수행했고, closure 안에 불투명한 것이 하나라도 있으면
  `intentionally-exclusive`다. `host-cpu`는 **의도적으로 비전이적**이다 —
  전이시키면 `src/browser/**`가 자기 adapter 소스에 매치되면서 562개 중 297개가
  `host-cpu: exclusive`가 되어 `pure` chunk 옆에서도 실행을 거부한다. CDP adapter에 도달하는 것은
  브라우저를 띄우는 것이 아니다.
- 뮤턴트 11개 전부 killed.

### 남은 항목 (blocker)

- `chunkClaimsOverlap`은 구현·검증·export됐지만 **scheduler에 배선되지 않았다**.
  전환하려면 실제 shard 캠페인에서 1/2/4-worker verdict 동등성 canary가 필요하고,
  그건 추론만으로 켤 수 있는 것이 아니다.
- certification drift: 인증된 test 파일을 고치면 `--check`가 red가 된다(drift → exclusive → 현행 동작이라 안전).
  비차단으로 먼저 배선할 것을 권고.
