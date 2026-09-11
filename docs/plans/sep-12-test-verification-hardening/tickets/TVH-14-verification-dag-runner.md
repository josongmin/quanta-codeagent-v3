# TVH-14 — top-level verification DAG와 bounded gate lifecycle

- 우선순위: P1
- 상태: IN PROGRESS (항목 0 착륙)
- 소유 lane: gate orchestration / lifecycle / critical path
- 선행: TVH-04, TVH-06, TVH-07, TVH-12
- 후속: TVH-09, TVH-10

## 확정 결함

0. manifest의 precommit 소유 gate는 8개인데 `MIN_OWNED.precommit`은 10이다. `--list`는 validator 전에 return하고 실제 execution은 dispatch 전에 실패한다. DAG 전환 전에 공통 manifest validation부터 self-consistent하게 만들어야 한다.
1. `verification-tier.ts:92-137`의 `stepGatePlan`은 dependency가 없어도 모든 gate를 순서대로 await한다. shard 내부 최적화가 typecheck/lint/catalog/suite top-level 합계에는 적용되지 않는다.
2. gate dependency는 단일 `consumes?: string`만 표현해 여러 producer를 기다리거나 resource conflict를 표현할 수 없다.
3. `gate.ts:293-310`은 `sh -c`를 timeout 없는 `Bun.spawnSync`로 실행한다. gate별 process-group, cancellation, output bound, total deadline이 없다.
4. `--keep-going`은 독립 gate 병렬 실행이 아니라 실패 후에도 다음 gate를 계속 직렬 실행한다.
5. whole-campaign repository lease가 read-only static gates까지 점유한다. TVH-04 resource lease 세분화 전에는 서로 다른 checkout의 typecheck/lint도 대기한다.
6. exact durable receipt 발행은 현재 `label === "prepush"`에만 묶여 PR/full/nightly tier의 exact result 재사용·비교가 불완전하다.
7. campaign/shard/quiet gate가 각각 admission budget을 새로 만들고 상위 deadline을 실행 전에 지워 sustained-load idle wait가 최대 16분 합산된다.

## 구현

- list/plan/run이 공유하는 pure manifest validator를 먼저 두고 exact gate ID, stage ownership, dependency cycle/missing producer를 검사한다. validator 자체는 어떤 gate도 spawn하지 않는다.
- gate schema를 `dependsOn[]`, `consumes[]`, `resources[]`, `capabilities[]`, `timeout`, `outputBudget`, `producerArtifact`로 확장한다.
- frozen snapshot 위에서 ready-set을 계산하고 resource-compatible gate만 제한 병렬 실행한다. 기본 concurrency는 2 이하이며 host load/memory budget이 낮추도록 한다.
- shell command string authority는 유지하되 bounded lifecycle primitive가 detached process group, TERM→KILL, drain, head/tail output, typed outcome을 소유한다.
- fail-fast는 첫 primary failure 이후 새 dispatch를 멈추고 실행 중 peer를 정책에 따라 cancel/drain한다. `keep-going`은 독립 branch만 계속한다.
- static producer receipt와 full JUnit/scan receipt를 DAG edge로 전달한다. consumer는 exact input을 독립 검증한다.
- checkout/git-common write claim이 없는 gate는 세분화된 shared lease를 사용한다. TVH-04 certification 전에는 기존 whole lease가 fail-safe다.
- prepush/PR/full/nightly 모두 동일 schema의 exact receipt를 발행하되 tier/membership/capability가 다르면 재사용하지 않는다.
- receipt에 critical path, queue wait, resource wait, setup, execution, cleanup 시간을 분리한다.
- campaign-wide monotonic admission deadline을 DAG context로 전달하고 모든 node가 remaining budget만 소비한다. exclusive lease는 admission-only wait 동안 점유하지 않는다.

## 검증

- current manifest의 list/plan/run validation 결과가 같고 gate 삭제·misstage·dependency cycle injection이 dispatch 0에서 RED다.
- 독립한 synthetic 1초 gates 두 개가 약 1초 critical path에 끝나고 conflicting resource gates는 직렬이다.
- A+B를 소비하는 C는 둘 모두 exact green일 때만 실행된다.
- gate hang/무한 출력/descendant survivor가 각각 bounded typed failure가 된다.
- first failure 뒤 아직 시작하지 않은 dependent gate는 `skipped-input`, 독립 branch는 keep-going 정책대로 실행된다.
- sequential legacy runner와 DAG runner의 exact gate verdict가 같은 HEAD에서 일치한다.
- hot sampler fixture에서도 전체 DAG admission 시간이 global cap을 넘지 않고 admission wait와 execution critical path가 별도 기록된다.

## 완료 기준

- [ ] top-level wall time이 독립 gate 합이 아니라 DAG critical path에 수렴한다.
- [ ] 모든 gate에 total deadline, process-group drain, output bound가 있다.
- [ ] resource claim 없는 임의 병렬화가 없다.
- [ ] 모든 verification tier가 비교 가능한 exact receipt를 발행한다.
- [ ] manifest validation drift가 listing 경로에 숨지 않는다.

## 진행 (2026-09-12)

- **LANDED `151040786`** — 확정 결함 0(manifest validation self-consistency) 해소.
  list/plan/run이 공유하는 **순수** validator를 `tools/dev/gate-manifest-contract.ts`에 두고
  `--list` 분기 앞에서 실행한다. validator는 gate를 하나도 spawn하지 않는다.
  exact gate ID + stage ownership + dangling/cyclic `consumes`를 검사하며 위반은 ID로 지목한다.
  DAG 전환의 선행 조건이 충족됐다.
- 남은 항목: gate schema 확장(`dependsOn[]`/`resources[]`/`timeout`/`outputBudget`),
  ready-set 병렬 실행, bounded lifecycle primitive로 `Bun.spawnSync` 교체, 단일 admission deadline.
