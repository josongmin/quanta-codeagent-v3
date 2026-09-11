# TVH-09 — hosted matrix parity와 required 승격

- 우선순위: P1
- 상태: OPEN
- 소유 lane: CI matrix / required-check integration
- 선행: TVH-02~TVH-07
- 후속: TVH-10

## 현재 결함

- plan/shard/aggregate jobs는 `QUANTA_SHADOW_MATRIX=1` 뒤에 있고 required가 소비하지 않는다.
- required `full-suite`는 monolithic runner다.
- matrix plan은 tier `full`, required monolith는 tier `pr`다. 현재 집합이 같아 문제를 숨기지만 tier 분리 즉시 parity가 깨진다.
- matrix plan은 suite/tier floor 없이 self-discovered 축소 집합도 exact라고 증명할 수 있다.
- matrix worker에는 local runner의 process watchdog, source-JS postflight, 동일 resource/capability envelope가 없다.
- nightly는 timing restore 없이 cache-off 단일 job을 180분 실행한다.
- hosted current-HEAD artifact와 branch-protection enforcement receipt가 없다.
- shadow matrix는 현재 44개 chunk 각각 별도 job이며 각 job이 checkout/install을 다시 수행한다. `max-parallel: 4`는 동시성만 제한하므로 setup wave가 11번 반복된다.
- normal PR도 root `bun install --frozen-lockfile`을 여러 required job에서 반복하고 feature-catalog workflow가 동일 catalog/PM gate를 별도 process로 재실행한다.
- `.github/workflows/fc-gate.yml`에는 PR concurrency group과 `cancel-in-progress`가 없어 superseded commit의 별도 catalog workflow가 계속 실행된다.
- nightly workflow는 Bun setup은 하지만 package download cache를 restore/save하지 않아 매일 dependency install을 cold-start한다.
- CI concurrency key는 event/purpose를 포함하지 않아 main push와 06:00 scheduled eval이 같은 `workflow-ref` lane을 공유한다. non-blocking 60분 eval이 main CI를 queue시킬 수 있다.
- nightly workflow에는 concurrency가 없어 cron, manual dispatch, retry가 최대 180분 cache-off campaign으로 서로 겹칠 수 있다.
- `required`는 expected seven producer IDs를 검증하지 않고, legacy `pyramid`와 함께 여섯 producer를 중복 aggregate한다. `feature-catalog-pr`도 migration context를 별도 runner에서 유지한다.
- shadow full-plan/full-aggregate는 checkout+Bun cache+root install을 반복하지만 matrix CLI의 plan/aggregate import graph는 repository-local module만 사용한다. required도 dependency-free parser를 위해 checkout+Bun runner를 구매한다.
- matrix plan/44 worker/aggregate artifact에 `retention-days`가 없어 repository default retention으로 receipt/JUnit storage가 증폭된다.
- `fc-gate.yml`은 workflow-level path filter를 가진다. live branch protection이 이 historical context를 required로 요구한다면 관련 경로 밖 PR에는 context 자체가 생성되지 않을 수 있다. 이는 ruleset live read-back 전에는 조건부 gap이다.

## 승격 단계

1. matrix plan tier를 required PR authority와 동일하게 만든다.
2. TVH-02 tier universe floor/digest와 TVH-06 receipt schema를 plan에 포함한다.
3. worker가 TVH-04 resource claims, TVH-05 timing cohort, TVH-07 lifecycle primitive를 사용한다.
4. 같은 clean HEAD에서 monolith와 matrix를 shadow로 실행해 exact file IDs, case counts, failures/skips, scan-reach, JUnit aggregate가 동일한지 비교한다.
5. 1/2/4 max-parallel에서 verdict equality와 resource conflict 0을 확인한다.
6. current required는 monolith를 유지한 채 matrix artifact를 수집한다.
7. 충분한 hosted receipts 후 `required`가 `full-aggregate`를 소비하게 바꾸고 monolith를 fallback/shadow로 내린다.
8. branch protection/ruleset에서 exact required context를 live read-back한다.
9. hosted matrix는 44개 one-chunk job 대신 소수 long-lived worker가 여러 chunk를 처리하거나, 검증된 immutable dependency image/artifact를 공유한다. checkout/setup/install 시간을 verdict 시간과 분리 측정한다.
10. 기존 `fc-gate` context는 catalog/full producer receipt를 소비하는 no-checkout aggregator로 이전하고 branch protection 전환 뒤 중복 workflow를 제거한다.
11. 전환 기간의 `fc-gate`에도 main CI와 같은 PR concurrency key와 cancel-in-progress를 적용해 superseded SHA를 즉시 중단한다.
12. nightly는 exact lockfile/runtime/platform key의 Bun package cache 또는 immutable dependency artifact를 사용한다. cache hit/miss와 install duration을 receipt에 기록한다.
13. main push, PR, scheduled eval, nightly의 concurrency group을 purpose별로 분리한다. superseded PR은 cancel하고 required main verification과 non-blocking eval은 서로 queue시키지 않는다.
14. TVH-06 expected-needs SSOT를 required에 연결한 뒤 live branch-protection receipt 순서에 따라 `pyramid`/`feature-catalog-pr` compatibility context를 하나씩 제거한다.
15. plan/aggregate/required는 fresh checkout+no-node_modules fixture로 의존성을 증명한 뒤 불필요한 root install/cache step을 제거하거나 immutable minimal tool artifact를 사용한다.
16. worker 상세 receipt는 짧은 explicit retention, aggregate/closeout receipt만 장기 retention을 둔다. campaign artifact count/bytes/retention을 기록한다.
17. required context는 모든 PR에 항상 생성되는 lightweight aggregator가 소유하고 path selection은 producer 내부 `not-selected` result로 표현한다. workflow 미생성으로 required가 영구 pending되지 않게 한다.

## 수정 파일

- `.github/workflows/ci.yml`
- `.github/workflows/fc-gate.yml`
- `.github/workflows/verification-nightly.yml`
- `tools/dev/verification-matrix.ts`
- `tools/dev/verification-matrix-cli.ts`
- `tools/dev/verification-required-results.ts`
- `tools/dev/gate-manifest.ts`
- `package.json`

## 완료 기준

- [ ] current-HEAD hosted matrix artifact가 존재한다.
- [ ] monolith/matrix exact verdict equality가 반복 확인됐다.
- [ ] required가 aggregate producer 실패·missing artifact를 fail closed한다.
- [ ] job timeout이 유일한 worker watchdog이 아니다.
- [ ] branch protection이 새 required context를 실제 요구한다.
- [ ] hosted worker 수 증가가 root install 횟수를 chunk 수와 같은 O(N)으로 늘리지 않는다.
- [ ] superseded PR SHA의 `ci`와 `fc-gate`가 모두 취소되고 nightly install은 cache identity를 증명한다.
- [ ] main verification과 scheduled eval/nightly가 concurrency key를 공유하지 않고 cron/manual nightly가 중첩되지 않는다.
- [ ] required expected producer set이 exact하며 compatibility aggregator와 setup runner가 migration 후 제거된다.
- [ ] matrix artifact retention과 총 storage bytes가 명시적 예산 안이다.
- [ ] live ruleset이 요구하는 모든 context는 path와 무관하게 결과를 발행하며 `not-selected`가 policy상 명시된다.

## 복구

matrix 불일치나 artifact 누락이 발생하면 required authority는 monolith로 유지한다. timeout 확대, missing artifact 무시, skipped green으로 승격하지 않는다.
