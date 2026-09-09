# TV-04 — 캐시 정확성, JUnit 보존, 실제 cold 실행

- 우선순위: P0
- 상태: PLANNED
- 소유자: B
- 선행: TV-00, contracts.md

## 문제와 근거

`sameIdentity`는 concurrent boolean으로 serial 또는 다른 병렬 폭에 green을 재사용한다. `prepush:cold`도 shard cache를 읽는다. worker가 생성한 JUnit은 caller가 junitOut을 요청하지 않으면 cache에서 버린다.

## 구현 범위

1. receipt schema/cache namespace를 새 버전으로 나눈다. exact `intraParallel`, isolation/timeout policy, 필요한 runner identity를 저장한다.
2. `parallel green ⇒ serial green` implication을 제거한다. timeout-scale도 exact match를 유지한다.
3. tier별 고정 timeout policy를 도입한다. 부하 대응은 TV-08 admission이 맡으며 내부 deadline을 무조건 300초로 확대하지 않는다.
4. `--cache=off|read-write` (PROPOSED)를 runner/wrapper로 전달한다. off에서는 result cache 조회·materialization 0, 실제 worker 실행을 요구한다.
5. `prepush:cold`와 nightly의 cold 경로를 off에 연결한다. download/build cache와 test-result cache를 별도 표기한다.
6. 모든 성공 worker의 실제 junitPath에서 XML을 읽고 검증 후 영구 저장한다. 출력 요청이 없는 실행도 같은 suite/policy의 다음 실행을 seed한다.
7. suite/manifest/global input 일치는 기본 유지한다. cross-suite 재사용은 이 티켓에서 하지 않는다.
8. 실패·중단·누락 XML은 성공 receipt를 만들지 않는다. GC는 검증된 cache namespace 안의 만료 항목만 처리하고 실행 중 temp/다른 버전은 보존한다.

## 수정 파일

- EXISTING: `tools/dev/test-shard-receipt.ts`, `tools/dev/run-test-shards.ts`, `tools/dev/verification-receipt.ts`, `tools/dev/verification-receipt-probe.ts`
- NEW: `tools/dev/verification-execution-policy.ts`
- 통합 변경: `package.json` cold aliases
- TEST: `tests/unit/test-shard-cache-identity.test.ts`, `tests/unit/dev/verification-receipt.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-execution-policy.ts` | NEW `VerificationExecutionPolicy`, `executionPolicyDigest` | runner, exact intra-worker width, timeout, isolation, retry, cache mode를 canonical JSON으로 serialize하고 SHA256을 만든다. | key order가 달라도 digest 동일, 값 하나 변경 시 digest 변경. |
| `tools/dev/test-shard-receipt.ts` | `TestShardCacheIdentity`, `sameIdentity`, `parseSuccessfulShardReceipt` | schema v2에 `executionPolicySha256`을 필수로 넣고 concurrent boolean implication을 삭제한다. v1은 명시적 miss로 처리한다. | width 1/2/8, timeout, schema, toolchain 각각의 hit/miss matrix. |
| `tools/dev/run-test-shards.ts` | CLI options, cache lookup, `executeChunks`, success persistence | `--cache=off|read-write`를 parse한다. off는 lookup/materialize/write를 모두 0회로 만들고 worker 실행 수를 selected chunk 수와 일치시킨다. | fake worker/cache adapter call counter. |
| `tools/dev/run-test-shards.ts` | worker `junitPath` 처리 | caller의 `--junit-out` 유무와 무관하게 성공 worker XML을 read/validate 후 cache receipt와 atomic하게 보존한다. | valid XML 보존, missing/partial XML receipt 거부. |
| `package.json` | `prepush:cold` | 구현 후 `--cache=off`를 실제 campaign command에 전달한다. dependency cache 여부는 별도 필드다. | script argv assertion. |

## 작업 순서

1. execution policy digest와 v2 parser를 추가한다.
2. 기존 cache를 v1 miss로 읽는 compatibility test를 고정한다.
3. cache adapter를 runner option으로 주입해 off/read-write 분기를 단위 검증한다.
4. JUnit validate→atomic write 순서를 구현한다.
5. 마지막에만 cold alias를 전환한다.

## 검증 계획

`bun test tests/unit/test-shard-cache-identity.test.ts tests/unit/dev/verification-receipt.test.ts`

회귀 추가: width 1/2/8 상호 miss, timeout-scale 변경 miss, old schema miss, 정상 같은 정책 hit, XML 미요청 실행 후 요청 실행에서 재사용, invalid/partial XML 거부. fake worker counter로 cache-off일 때 valid receipt가 있어도 실행되는지 확인한다. GC의 expired/active/foreign 파일 구분도 fixture로 검증한다.

## 완료 기준

- [ ] false cold 명령이 제거됨.
- [ ] 실행 정책이 다르면 일반적으로 재사용하지 않음.
- [ ] 이미 생성한 JUnit을 불필요하게 버리지 않음.
- [ ] 실패/cancel 결과가 green cache로 남지 않음.
- [ ] 새 schema에서 기존 cache를 잘못 읽지 않음.

## 실패·복구

cache hit 문제 발생 시 off로 전환하되 full 실행 제한을 우회하지 않는다. 이전의 불건전한 implication을 복원하지 않는다.
