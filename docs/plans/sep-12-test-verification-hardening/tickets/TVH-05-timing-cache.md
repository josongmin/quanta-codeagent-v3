# TVH-05 — timing·cache 정확성 및 성능

- 우선순위: P1
- 상태: LANDED (증거 부족) — 손상된 timing hint의 전체 plan 붕괴와 cache 전면 miss를 수정. 열림: timing v2 store는 clean-tree 캠페인 1회가 있어야 생성된다
- 소유 lane: timing telemetry / shard cache
- 선행: TVH-02, TVH-04
- 후속: TVH-06, TVH-09, TVH-10

## 현재 결함

- current timing v2가 없어 모든 파일이 1,000ms fallback이다.
- nightly workflow가 timing store를 restore/publish하지 않아 가장 무거운 tier가 매번 cold planning이다.
- `loadPerCore`를 sample에 기록하지만 planner는 current cohort/load를 요청하지 않고 newest cohort median을 사용한다.
- hot-host 표본이 최대 14일 동안 launch weight를 오염시킬 수 있다.
- 각 chunk 완료 때 timing JSON 전체를 sync read/sort/rewrite해 full당 최대 44회 재작성한다.
- shard receipt 저장 뒤 timing write가 실패해도 shard는 green cache가 된다. 이후 hit는 timing을 복원하지 않아 speed gate가 반복 실패할 수 있다.
- declared input scope가 있어도 unconditional whole-tree hash와 tier 문자열이 identity에 들어가 unrelated change/cross-tier 동일 population 재사용을 막는다.
- tier cache는 `full:pr` 등에 쓰지만 prune은 bare `full`만 정리한다.
- `targetChunkCount`와 `_totalWeight`는 검증/전달만 되고 chunking에서 사용되지 않는다. membership은 class별 고정 SHA bucket이며 현재 pure 최대 bucket 158/ceiling 160이라 3개 유입만으로 plan 전체가 실패할 수 있다.
- 모든 chunk receipt key에 whole tracked-tree digest와 전체 manifest digest가 들어가 declared input scope보다 먼저 전 chunk invalidation을 일으킨다.
- 1분 host load로 바뀌는 120/240/300초 timeout 값이 execution-policy identity에 포함되어, 코드가 같아도 load band 변화만으로 전 chunk cache miss가 난다.
- unit speed budget은 JUnit test-case duration만 보므로 module-load browser spawn, package install, discovery probe와 nested runner 비용을 누락한다.
- timing store는 elapsed time만 다루고 peak RSS, output bytes, temp-disk bytes를 다음 실행의 admission weight로 학습하지 않는다.
- timing parser는 `typeof null === "object"` 때문에 schema-looking `entries:null`을 승인한 뒤 `Object.entries(null)`에서 crash한다. scheduling hint 손상 하나가 cold fallback이 아니라 plan 전체 실패가 된다.
- `now - sampledAt <= maxAge`에 future-skew 상한이 없어 먼 미래 timestamp 한 건이 TTL을 사실상 영구 우회하고 newest cohort authority가 된다.
- 모든 chunk identity에 Docker/Cargo/gopls/pyright 등 외부 도구 18개의 전역 fingerprint가 동일하게 들어간다. 관계없는 tool 설치/mtime 변경이 pure chunk까지 전부 miss시킨다.
- expired receipt prune은 모든 chunk 성공 뒤에만 호출된다. 앞 chunk receipt 저장 후 뒤 chunk가 실패하는 branch가 반복되면 expired JUnit/scan payload가 성공 campaign까지 누적된다.

## 파일·로직별 작업

| 파일 | 대상 | 변경 |
|---|---|---|
| `tools/dev/test-shard-timings.ts` | `loadTestTimings` | expected runner class, policy digest, intra-parallel, platform, load band를 입력받는다. incompatible/hot sample을 reject 또는 별도 cohort로 둔다. |
| `tools/dev/run-test-shards.ts` | harvest | chunk마다 store 전체를 쓰지 않고 memory journal에 누적해 campaign end에 한 번 atomic commit한다. interrupted run은 completed chunk journal만 복구 가능하게 한다. |
| `tools/dev/test-shard-receipt.ts` | successful receipt | file별 timing observation 또는 재구성 가능한 elapsed metadata를 포함한다. cache hit도 timing store를 rehydrate한다. |
| `tools/dev/unit-speed-budget.ts` | timing dependency | cache hit receipt와 timing store가 incoherent하면 이유를 출력하고 bounded rehydrate/miss 처리한다. expensive suite 뒤 영구 retry loop를 만들지 않는다. |
| `tools/dev/verification-input-scope.ts` | declared identity | 인증된 chunk만 declared dependency/input digest를 사용한다. 미인증은 whole-tree 유지한다. tier label 대신 실제 execution semantics digest를 사용한다. |
| `tools/dev/run-test-shards.ts` | `pruneStaleChunkReceipts` | 실제 `cacheSuiteName(opts)` 디렉터리를 prune하고 모든 tier namespace를 TTL 관리한다. |
| `.github/workflows/verification-nightly.yml` | timing cache | verdict cache off와 scheduling telemetry cache를 분리한다. timing v2는 restore/publish하되 shard green receipt는 재사용하지 않는다. |
| `tools/dev/test-shard-plan.ts`, `test-shard-membership.ts` | dead target/fixed buckets | `targetChunkCount`를 실제 versioned membership에 반영하거나 옵션을 삭제한다. 파일 수 ceiling이 아니라 weight/capacity 기반 saturation과 deterministic rebucketing을 사용한다. |
| `tools/dev/test-shard-receipt.ts` | global invalidation | certified chunk는 chunk-local input scope + shared producer receipt digest만 identity로 사용한다. global policy/manifest는 compatibility field와 chunk selection proof로 분리한다. |
| `tools/dev/run-test-shards.ts` | load-derived timeout | 안전상 실행 timeout은 현재 load에 맞추되 cache compatibility에는 stable timeout policy version/range만 넣는다. compatible widening은 hit를 보존한다. |
| JUnit/runner timing schema | discovery overhead | file import 시작/첫 case/마지막 case/cleanup 종료 wall time을 기록해 `file wall - sum(case)`를 별도 overhead로 노출한다. |
| resource telemetry schema | multidimensional history | file/chunk별 elapsed, peak RSS, spool bytes, temp peak를 함께 기록하고 healthy-load cohort의 p50/p95를 분리한다. |
| `tools/dev/test-shard-timings.ts` | hostile/corrupt input | `entries`의 non-null plain-record shape, finite fields, past/future skew를 검증한다. invalid hint는 quarantine 후 deterministic cold fallback이고 verdict를 막지 않는다. |
| `test-shard-receipt.ts`, certification | tool-scoped cache identity | certified chunk가 실제 claim한 tool capability digest만 포함한다. 미인증 chunk는 all-tool fingerprint fail-safe를 유지한다. |
| `run-test-shards.ts` | cache GC lifecycle | bounded GC를 campaign 시작/종료 finally 또는 별도 safe maintenance phase에서 수행한다. live writer/다른 worktree namespace는 보존한다. |
| `verification-input-scope.ts` | declared rollout blocker | path/reason뿐 아니라 test source content와 transitive imported helper/fixture content digest를 포함한다. 이 계약 전에는 declared opt-in을 0으로 유지한다. |

## 검증

- hot load sample만 있는 경우 clean planner가 이를 authority로 사용하지 않는다.
- policy/intra-parallel/platform이 다른 sample은 섞이지 않는다.
- timing write 실패 후 cache hit가 missing-timing loop를 만들지 않는다.
- docs-only change에서 certified declared chunk는 hit하고 uncertified chunk는 miss한다.
- expired `full:pr`, `full:nightly` receipt가 모두 prune된다.
- cold store에서도 deterministic file-count plan을 만들고 “측정됨”으로 오표시하지 않는다.
- `targetChunkCount=4`와 `24`가 의도된 경우 plan을 실제로 바꾸며, 고정 membership 모드라면 해당 옵션을 거부한다.
- 다른 chunk 파일 또는 docs-only 변경이 certified stable chunk를 miss시키지 않는다.
- load band만 바뀐 동일 input은 compatible timeout 정책에서 hit한다.
- module-load/discovery overhead가 per-file budget과 top-N report에 잡힌다.
- 시간상 빠르지만 메모리/출력이 큰 파일도 다음 plan의 resource weight에 반영된다.
- `entries:null`, array, invalid field, future timestamp는 plan crash나 authoritative timing이 아니라 typed cold fallback이다.
- unclaimed Docker/tool 변화는 certified pure chunk hit를 유지하고 claimed tool/Bun 변화는 해당 chunk만 miss한다.
- 연속 failed campaign에서도 expired receipt는 bounded GC되고 live sibling-worktree receipt는 보존된다.
- 같은 path의 test source 또는 imported helper bytes만 바꿔도 declared digest는 miss하고 관계없는 docs는 hit한다.

## 완료 기준

- [ ] healthy-load current-HEAD timing v2가 존재한다.
- [ ] nightly가 cold verdict + warm scheduling telemetry로 동작한다.
- [ ] full campaign당 timing store commit 수가 O(1)이다.
- [ ] cache identity가 실제 input/capability/execution semantics를 반영한다.

## 진행 (2026-09-12)

- **LANDED `7cf5f435f`** — 5개 결함, 각각 변경 전에 재현함.
  - **손상된 hint 하나가 캠페인 전체를 죽였다.** validator가 `typeof entries !== "object"`를 물었고
    `null`/`[]` 둘 다 통과 → `Object.entries(null)`에서 TypeError. **scheduling hint(조언 데이터)가 verdict를 막았다.**
    이제 typed read + content-addressed quarantine, `kind:"cold"`는 `"measured"`와 다른 타입이라
    fallback이 측정으로 읽힐 수 없다.
  - **미래 timestamp가 불멸이었다.** `now - sampledAt <= maxAge`에 상한이 없어 +100y 표본 하나가
    영원히 newest-cohort authority가 됐다. 정직한 50ms 표본 옆에 999,999ms 위조를 두고 측정:
    before는 모든 horizon에서 위조가 cohort를 선택, after는 정직한 값이 살아남는다.
    새 임계값이 아니라 receipt에 이미 적용되던 규칙과 동일하다.
  - **캐시가 전부 miss했다.** 모든 chunk 키가 전체 tracked tree + 전체 manifest + tier label +
    외부 도구 **27개**(실측; 티켓은 18) 전역 fingerprint를 담았다. docs-only 커밋이나 무관한 Docker 설치가
    44개 chunk 전부를 무효화했다. 이제 scoped이지만 **양쪽 registry가 비어 있어 현재 HEAD에선
    모든 chunk가 여전히 `whole-tree`** — 축소는 구현·검증됐고 켜지지 않았다.
  - **바쁜 박스가 다른 캐시 우주였다.** 1분 load가 120/240/300s timeout을 옮기고 그 값이
    execution-policy digest에 들어갔다. 이제 stable policy base만 identity이고,
    실제 구현을 probe해서 얻는다(리터럴 복사 아님). 실행 timeout은 여전히 load를 따른다.
    호환은 proof-carrying: 확대는 항상 hit, 축소는 receipt의 모든 case가 좁은 예산 안에 끝났을 때만 hit.
  - **store가 chunk마다 재작성됐다.** full 캠페인당 최대 44회 whole-store read-modify-write →
    chunk당 NDJSON 1줄 append + 캠페인 끝 **1회** 기록. 중단된 런은 journal로 복구.
  - **timing write 유실이 복구 불가였다.** green receipt는 남고 timing이 없으면 이후 캠페인이
    계속 hit → 재실행 없음 → speed budget 영구 red. HEAD에서 재현: 상태 변화 없이 3연속 exit 1,
    `missing 12/12 executed file(s)` — **이 체크아웃에서 그 게이트는 현재 충족 불가능하다**(store 부재).
  - **prune이 아무도 안 쓰는 디렉터리를 쓸었다.** tier 캐시는 `full:pr`/`full:nightly`에 쓰는데
    bare `full`만 청소. 실측: 307 receipts / 127 MiB, 전부 만료, 전부 도달 불가.
    이제 모든 cache root **버전**의 모든 namespace를 `finally`에서 TTL-only로 쓴다.
- 뮤턴트 14개 전부 killed.

### 남은 항목
- healthy-load `test-timings-v2.json`이 아직 없다(완료 기준 1). clean tree 캠페인이 필요하다.
- `producerReceiptsSha256`은 실제 identity 필드지만 값이 비어 있다(TVH-12가 채운다).
- nightly workflow의 verdict cache ↔ scheduling telemetry 분리는 미착수.
