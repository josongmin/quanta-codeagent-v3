---
instance_id: pallets__flask-5014
repo: pallets/flask
base_commit: 7ee9ceb71e868944a46e1ff00b506772a53a4f1d
version: "2.3"
difficulty: "<15 min fix"
created_at: 2023-03-04T18:36:21Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [src/flask/blueprints.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [regression-trap]
---

## 문제 요약
`Blueprint`에 빈 문자열 이름(`""`)을 주면 내부 동작이 깨지지만(이슈 #4944 참조) 아무 에러 없이 통과한다. 빈 이름을 생성자에서 거부해 `ValueError`를 던져 달라는 요청이다. 즉 기존에 점(`.`) 포함 이름을 막는 검증과 동일선상의 입력 검증을 하나 더 추가하는 일이다.

## 유형 (정형화)
- **L = L0 (Pinpointed).** 이슈가 "Blueprint name"을 직접 지목한다. `src/flask/blueprints.py`의 `Blueprint.__init__`로 grep 한 방에 수렴. 바로 옆에 이미 `if "." in name:` 검증이 있어 삽입 지점이 자명하다.
- **S = S1 (Direct-Map).** 정형 결함클래스(입력 유효성 검증 누락)에 템플릿 매칭. 이슈가 사실상 픽스를 명세("`ValueError`를 raise") — 조건(`not name`) 한 줄과 raise 한 줄이면 끝. 추론 합성 불필요.
- **K = K-Gen.** 빈 문자열 falsy 판정은 순수 일반 파이썬. Flask 내부 도메인 지식 불요. 점-검증 패턴을 모방만 하면 됨.
- **primary = T-DirectMap.** 위치 명확 + 기계적 가드 추가. 이슈가 픽스를 거의 적어주지만 "체크를 어디에 어떤 순서로" 끼우는 미세 판단이 있어 T-LocTrivial보다 T-DirectMap이 정확.

APR 관점: 결함이 "missing precondition check"라는 단일 결함클래스로 깔끔히 떨어지므로 PAR/TBar식 fix-pattern(널/빈값 가드 삽입)이 직접 적용된다. SemFix류 식 합성도, G&V식 후보 탐색도 필요 없다 → S1.

## 난이도 티어
**T2 (쉬움).** 구조적 피처:
- 파일 1개, 함수 1개(`__init__`), 순 추가 +3줄(빈 줄 포함) — ICLR 2024 컷 기준 1파일·<5줄 ≈ 48% solve 구간.
- localize 직접성 최상(L0): 이슈 키워드 → 정확한 메서드.
- repro 없음(스택트레이스 미제공)이지만 `if "." in name:`이라는 **모범 패턴이 코드에 이미 존재**해 사실상 셀프-템플릿. 이 강한 prior 때문에 T1이 아니라 T2로 살짝만 올림(엄밀히는 거의 T1).
- P2P=63개로 넓다 → `regression-trap` 표기. 단, 모두 비어있지 않은 이름으로 Blueprint를 만들기에 새 가드가 그들을 깰 경로는 없음(아래 검증 참조). 실질 trap 강도는 약함.

공식 라벨 "<15 min fix"와 일치한다. 시간라벨과 구조 티어가 모순되지 않는 전형적 입력검증 케이스.

## 골드패치 분석
- **파일·함수:** `src/flask/blueprints.py` → `Blueprint.__init__`.
- **근본원인:** 생성자가 `name` 인자의 유효성을 점(`.`) 포함 여부만 검사하고 **공집합(빈 문자열)을 검사하지 않음**. 빈 이름은 엔드포인트 네이밍·URL 규칙 조립에서 silently 깨진 동작을 유발(이슈 #4944).
- **수정요지:** `super().__init__(...)` 호출 직후, 기존 `if "." in name:` 검사 **바로 앞**에 가드를 삽입:
  ```python
  if not name:
      raise ValueError("'name' may not be empty.")
  ```
  `not name`은 빈 문자열뿐 아니라 falsy `name`을 모두 거른다. 순서가 dot-check 앞인 것이 중요 — 빈 문자열도 `"." in name`은 `False`라 dot-check만으론 절대 못 잡으므로 별도 가드가 필수이고, 먼저 실패시켜 메시지를 명확히 한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `tests/test_blueprints.py::test_empty_name_not_allowed` — `pytest.raises(ValueError)` 컨텍스트에서 `flask.Blueprint("", __name__)`. 가드 추가 전엔 예외 없이 객체 생성 → 테스트 실패. 추가 후 `ValueError` 발생 → 통과. 픽스가 정확히 이 동작을 증명.
- **overfit 관점:** 테스트가 빈 문자열 단일 케이스만 본다(얇음). 그러나 골드 픽스 `not name`은 빈 문자열을 특수처리하지 않고 falsy 일반화로 막으므로, 테스트가 과소명세여도 픽스는 그 너머로 올바르게 일반화됨. CEGIS 불필요.
- **regression 관점:** P2P 63개는 전부 `"test"`, `"app.ui"`(dot-check용), prefix 등 **비어있지 않은 이름**을 쓴다. `not name`은 truthy 이름엔 무영향 → 인접 동작(nested blueprint, prefix slash 매트릭스, template filter/test 등) 모두 보존. 새 ValueError가 기존 통과 테스트를 깰 경로 없음.

## 모범답안 (오라클 기반)
1. **Localize:** 이슈의 "Blueprint … empty name" → `src/flask/blueprints.py` 검색 → `Blueprint.__init__`. 이미 있는 `if "." in name: raise ValueError(...)`가 검증 관례의 앵커. 여기가 단 하나의 정답 지점.
2. **Fix:** dot-check 앞에 `if not name: raise ValueError("'name' may not be empty.")` 추가. `name == ""` 대신 `not name`을 써 falsy 전반을 막는 것이 올바른 일반화(빈 이름이 깨지는 근본은 "유효한 식별자 부재"이지 "정확히 빈 문자열"이 아님). 메시지를 기존 dot 메시지와 톤·따옴표 컨벤션 맞춤.
3. **Regression 안전:** truthy 이름엔 분기 미진입 보장 → 63개 P2P 무손상. 검증을 `super().__init__()` **뒤**에 두어 부모 초기화 부수효과 순서를 기존과 동일하게 유지(앞에 두면 미묘한 초기화 순서 변동 위험).
4. **함정 회피:** (a) 빈 문자열을 dot-check 안에서 처리하려는 시도 — `"." in ""`은 `False`라 절대 안 걸림. 반드시 **독립 가드**여야 함. (b) `name == ""`로 좁게 박으면 `None` 등 다른 falsy 누수(overfit). (c) 검증을 `self.name = name` 할당 뒤로 미루면 이미 부분 초기화된 상태로 예외 — 생성 직후 fail-fast가 정답. (d) 메시지 따옴표 스타일 불일치는 기능엔 무해하나 P2P엔 영향 없으니 무시 가능.
