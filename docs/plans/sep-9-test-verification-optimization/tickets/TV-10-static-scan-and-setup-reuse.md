# TV-10 — 중복 scan, preload, toolchain setup 비용 제거

- 우선순위: P1
- 상태: FOCUSED_VERIFIED
- 소유자: C
- 선행: TV-02
- 협업: TV-09 reach-test 빈도, TV-11 job 배치, TV-13 toolchain 환경

## 문제와 근거

lint gate 뒤 lint reach 테스트가 전체 Biome 스캔을 다시 한다. slice boundary entrypoints는 동일 source를 여러 번 read/parse한다. source JS cleanup은 package script와 preload에서 반복될 수 있다. 설치·빌드 비용은 테스트 body 시간에 섞여 있다.

## 구현 범위

1. lint → lint-debt의 현재 진단 receipt 재사용을 유지하고 같은 job에 배치한다.
2. 일반 lint와 full-reach oracle의 목적을 구별한다. oracle을 기존 lint receipt로만 대체하면 독립 검증이 사라지므로, 관련 설정 변경 시 독립 전체 스캔을 유지한다.
3. slice별 immutable source snapshot/parse를 한 번 만들고 해당 검증 arms가 공유하게 한다. 주입 테스트는 clone snapshot으로 격리한다.
4. package cleanup과 preload 비용을 계측한다. managed runner에서 초기 검사를 공유할 경우 snapshot identity와 종료 검사를 요구한다. 직접 `bun test`의 stale-JS 보호는 유지한다.
5. planner source read/classification을 스냅샷 내에서 memoize한다. 다른 HEAD의 scan 결과를 경로만으로 재사용하지 않는다.
6. Bun/Node/Python 의존성 준비는 lockfile·OS/arch·도구 버전에 결합해 별도 단계로 만든다.
7. Astropy의 native rematerialization용 no-cache는 이 티켓에서 제거하지 않는다. cold proof와 일반 warm 설치의 예산을 따로 기록한다.
8. 수백 줄 새 scan framework 대신 기존 snapshot/receipt 소유자를 개선한다.

## 대상 파일

- `tools/dev/run-biome.ts`, `lint-debt-ceiling.ts`, `biome-targets.ts`
- `tests/unit/_arch/slice-boundary-scanner.ts`
- `tests/preload-clean-source-js.ts`, `tools/dev/sandboxed-test.ts`
- `tests/integration/lint-debt-reach-e2e.nightly.test.ts`
- `src/runner/batch/corpus/project-env.ts` (cold-correctness 읽기; 기본 변경 대상 아님)

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/run-biome.ts` | `collectBiomeTargets` 소비, `printJsonDiagnostics`, Bun spawn | lint 실행 뒤 diagnostics, target digest, config/lock/tool version, exit status를 atomic receipt로 쓴다. stderr/stdout 포맷은 기존 CLI와 호환시킨다. | content/config/version 변경 시 receipt miss. |
| `tools/dev/biome-diagnostics-receipt.ts` | receipt producer/parser | 같은 job/HEAD/targets/config/tool identity에서만 diagnostics 재사용을 허용한다. failed/partial receipt는 consumer가 거부한다. | stale/partial/corrupt/다른 cwd fixture. |
| `tools/dev/lint-debt-ceiling.ts` | `runBiome`, `evaluateCeilings`, `scopeOfPath` | valid producer receipt가 있으면 `runBiome`을 생략하고 동일 diagnostics를 `evaluateCeilings`에 전달한다. receipt miss면 현재 full scan으로 fallback한다. | producer 1회/consumer 추가 spawn 0회 counter. |
| `tests/integration/lint-debt-reach-e2e.nightly.test.ts` | `biomeDiagnosticsOverRoots` | 독립 oracle은 nightly와 config/target/receipt code 변경 시 실행한다. 자기 자신이 검증할 receipt를 무조건 소비하지 않는다. | invalid target enumeration injection이 RED. |
| `tests/unit/_arch/slice-boundary-scanner.ts` | source read/parse helpers | `(HEAD, path, contentSha)` keyed immutable snapshot을 한 test process 안에서 공유하고 mutation fixture는 clone한다. | read counter 감소, mutation 오염 0, empty floor failure. |
| `tests/preload-clean-source-js.ts`, `tools/dev/sandboxed-test.ts` | cleanup/preload | managed campaign에서만 snapshot identity가 맞는 setup receipt를 재사용하고 direct `bun test`는 기존 freshness check를 수행한다. | stale `.js`, 외부 cwd, direct-run 회귀. |

## 작업 순서

1. Biome receipt의 exact identity와 atomic writer/parser를 확정한다.
2. `run-biome` producer와 lint-debt consumer를 같은 job에서 연결한다.
3. 독립 reach oracle trigger를 별도 정책으로 유지한다.
4. slice scanner를 process-local immutable snapshot으로만 memoize한다.
5. preload/setup 재사용은 identity mismatch에서 반드시 cold path로 돌아가는지 확인 후 적용한다.

## 검증 계획

synthetic fs/read counter로 동일 snapshot의 중복 read 감소를 확인한다. 내용 변경·빈 corpus·stale JS·외부 cwd·fixture 주입 후에는 cache를 잘못 재사용하지 않아야 한다. 기존 slice-boundary parity와 preload closure 테스트를 owner-local로 선택한다. lint receipt가 없거나 input digest가 다르면 lint-debt가 stale green을 소비하지 않는지도 검증한다.

## 완료 기준

- [ ] scanner 비용 감소와 실제 read/parse 횟수 근거 있음.
- [ ] non-vacuity·cwd parity·source freshness 보호 유지.
- [ ] 독립 oracle이 자기 결과를 재사용하는 순환 검증으로 변하지 않음.
- [ ] 설치 cache와 결과 cache를 구별함.

## 실패·복구

공유 snapshot이 mutation 간 오염을 만들면 해당 범위의 공유를 해제한다. floor/allowlist를 완화해서 테스트를 통과시키지 않는다.
