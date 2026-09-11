# TVH-10 — 문서 정합성·성능 측정·최종 closeout

- 우선순위: P2
- 상태: PARTIAL — 문서/티켓/catalog closeout 완료. healthy-load ABBA와 full/nightly receipt는 미생성(세션 내내 외부 부하 load 25–120)
- 소유 lane: integration / documentation / performance receipts
- 선행: TVH-01~TVH-09, TVH-11~TVH-15

## 현재 문서 드리프트

- SEP9 문서 안에서 integration-path 558과 현재 561이 혼재한다.
- tier population 3,926/3,930과 현재 3,928/3,934가 혼재한다.
- local main ahead 1이라는 문구와 실제 ahead 3이 다르다.
- “`QUANTA_TEST_STRESS` conditional body가 없다”는 문구가 실제 nightly lint-debt test와 다르다.
- nightly workflow는 schedule이 활성인데 “first real nightly is workflow_dispatch opt-in”이라고 적혀 있다.
- pre-push hook이 `--bail`을 직접 넘긴다는 문서와 실제 package default-bail 동작이 다르다.
- feature catalog와 tests README 일부가 현재 full/test cleanup 범위를 옛 의미로 설명한다.

## 작업

1. generated artifact는 원본 YAML/manifest를 수정한 뒤 generator로 재생성한다.
2. 인벤토리 숫자를 문서에 수동 복제하지 않고 discovery artifact 링크/digest를 사용한다.
3. smoke/prepush/PR/full/nightly 명령 표에 정확한 scope, capability, cache, receipt 의미를 쓴다.
4. static/focused/current-head full/hosted/activation receipt를 명확히 구분한다.
5. healthy host 기준을 먼저 고정한다: clean checkout, current HEAD, no foreign saturation, toolchain/capability snapshot.
6. warm/cold ABBA를 최소 반복하고 median/p95, cache hit ratio, per-gate critical path, peak RSS, spool/temp peak, worker utilization을 기록한다.
7. legacy Sep9 41분 34초 SIGINT 기록은 load 120.41→139.69/16 CPU의 stale RCA로만 남기고 현재 성능 baseline으로 사용하지 않는다.
8. current-HEAD prepush, PR matrix, cache-off full/nightly receipt를 별도 artifact로 보존한다.

## 최종 검증 표

| 검증 | 필수 증거 |
|---|---|
| smoke | exact membership, cold/warm wall, no external capability |
| prepush | affected+canary manifest, no upstream clone/install/live model |
| PR | hosted required aggregate, exact executed paths/capabilities |
| full | deterministic full receipt, timing-v2 coverage |
| nightly | cache-off verdict, timing telemetry, capability job artifacts |
| isolation | 1/2/4 worker equality, conflict/survivor/temp leak 0 |
| cache | declared/whole-tree hit/miss injection, stale receipt rejection |
| determinism | seed replay, strict wall assertion inventory 0, fixed-wait budget |
| resource | peak RSS/spool/temp quota, low-memory/low-disk admission injection |

## 완료 기준

- [ ] 문서·workflow·package command·manifest가 동일 계약을 설명한다.
- [ ] current-HEAD healthy-load 수치로 개선율을 계산할 수 있다.
- [ ] hosted required와 branch protection이 live read-back됐다.
- [ ] 열린 항목은 owner, blocker, 다음 명령, 필요한 authority가 명시돼 있다.
- [ ] stale/partial/static 증거를 full closure로 표시한 곳이 없다.
