---
instance_id: astropy__astropy-14598
repo: astropy/astropy
base_commit: 80c3854a5f4f4a6ab86c03d9db7854767fcd83c1
version: "5.2"
difficulty: "15 min - 1 hour"
created_at: 2023-03-29T10:34:49Z
fail_to_pass: 1
pass_to_pass: 175
gold_files: [astropy/io/fits/card.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

## 문제 요약
FITS Card에서 null string(이중 단일인용부 `''`)을 포함한 긴 문자열 값을 `Card.fromstring`으로 round-trip하면 `''`가 `'` 하나로 깨지거나, 값 일부/끝 인용부가 유실된다. CONTINUE 카드로 분할될 만큼 값이 길 때(약 65자 이상)만 발생하며, `''`의 위치·뒤따르는 텍스트/공백 유무에 따라 산발적으로 재현된다. 짧은 카드는 정상 — 즉 long-string 분할 경로의 unescape 로직과 분할 정규식 둘 다에 결함이 있다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈에 명확한 재현 코드(`Card.fromstring`/`Card.value`)가 있고, `''` round-trip이라는 키워드로 `io/fits/card.py`의 long-string 분할 경로(`_split`)와 값 파싱 정규식으로 좁게 수렴된다. grep 한 방은 아니지만 단일 파일·단일 함수권.
- **S = S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, "왜 `.replace("''","'")`를 제거해야 하는가"와 "정규식에 왜 `$` 앵커가 필요한가"를 FITS 인코딩 불변식으로 추론 합성해야 한다. 후보를 마구 시도해서 맞추는 G&V가 아니라, escape/unescape 대칭성과 greedy-match 경계를 따져 푸는 의미론적 수리.
- **K = K-Domain**: FITS long-string(CONTINUE) 인코딩과 `''` escaping 규약이라는 io.fits 내부 도메인 지식이 병목. 일반 파이썬 추론만으론 "이중인용부를 언제 unescape하나"를 결정 못 함.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만(L1), 올바른 픽스는 두 곳의 정규식/문자열 변환 불변식을 추론으로 맞추는 데 본질이 있다. 기계적 가드 추가(S1)가 아니다.

## 난이도 티어
**T4 (약간 어려움).** 구조 피처: 1파일·2헌크·실질 2줄 변경으로 scope는 작다(T2급 외형). 그러나 (1) 두 결함이 **함께** 고쳐져야 round-trip이 성립 — `$` 앵커 누락(non-greedy `strg`가 공백 앞 close-quote lookahead에서 조기 종료하고 optional `comm_field`가 매치를 끝내 인용부 뒤 텍스트가 silently truncate)과 `.replace("''","'")`의 과잉 unescape가 별개 원인이라 한 줄만 고치면 hint의 두 케이스 중 하나가 남는다. (2) 정규식 non-greedy/backtrack 동작·FITS escaping이라는 도메인 추론이 필요(K-Domain). (3) P2P 175개 중 long-string·commentary·fromstring 계열이 다수라 정규식에 `$`를 붙이면 인접 파싱을 깰 regression-trap이 실재. localize 자체는 쉬워 T5는 아니고, 추론·이중원인·넓은 P2P가 T2→T4로 민다. 공식 라벨 "15분-1시간"과 정합(개발자엔 짧지만 에이전트엔 이중원인+정규식 추론이 함정).

## 골드패치 분석
- **파일/심볼**: `astropy/io/fits/card.py` — 클래스 `Card`의 정규식 상수 `_strg_comment_RE`와 메서드 `_split()`.
- **근본원인 1 (정규식 비앵커)**: `_strg_comment_RE = re.compile(f"({_strg})? *{_comm_field}?")`에서 끝 앵커가 없어, value 뒤에 오는 텍스트가 매치에서 그대로 탈락(silent truncate)됨(hint의 `'' aaa` 케이스). 메커니즘은 `_strg = r"\'(?P<strg>([ -~]+?|\'\'|) *?)\'(?=$|/| )"`의 non-greedy `strg`([ -~]+?)가 첫 유효 close-quote lookahead `(?=$|/| )`(공백 앞) 지점에서 조기 종료하고, `_comm_field?`가 optional이라 매치가 거기서 끝나 뒤 텍스트가 버려지는 것이다. comment 그룹으로 흡수되는 것이 **아니다**(실측: `old.match("'xx'' xxx&'")` → span (0,6), strg="xx'", comm=None, comm_field=None). `$` 앵커를 붙이면 엔진이 backtrack해 strg가 전체를 소비하도록 강제한다(strg="xx'' xxx&").
- **근본원인 2 (이중 unescape)**: `_split()`에서 `value = value.rstrip().replace("''", "'")`. CONTINUE 분할 경로에서 각 서브카드 값의 `''`를 선행 unescape하는데, 이는 redundant한 두 번째 unescape다. `_split()`는 서브카드 값들을 `valuecomment = f"'{''.join(values)}' / {' '.join(comments)}"`로 재합성하고, 호출부 `_parse_value()`가 이 valuecomment를 `_value_NFSC_RE`로 다시 매치한 뒤 `value = re.sub("''", "'", m.group("strg"))`로 unescape한다(이것이 **올바른 단 한 번의 unescape 지점**). 인코딩 측 `_format_long_image()`의 `value = self._value.replace("'", "''")`가 escape를 한 번만 하므로 decode도 한 번만 해야 대칭인데, `_split`의 `.replace`가 거기에 한 번 더 얹혀 `''`→`'`로 손실됨.
- **수정요지**: (1) 정규식 끝에 `$` 추가 → value/comment 경계를 문자열 끝까지로 못박아 인용부 뒤 텍스트·끝 인용부 유실 방지. (2) `.replace("''","'")` 제거 → 이 경로에서의 과잉 unescape 제거. 두 변경이 짝을 이뤄 `''`가 원형 그대로 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)** `test_long_string_value_with_quotes`: `"x"*100 + "''"`, `+ "''xxx"`, `+ "'' xxx"` 세 값을 Card→image→`fromstring` round-trip 후 `c.value == testval` 단언. 세 케이스가 각각 (끝 인용부 보존 / 인용부 뒤 텍스트 보존 / 공백 후 텍스트 보존)을 커버 — hint가 발견한 두 추가 결함까지 포함.
- **픽스 증명**: `''`가 `.replace` 제거로 원형 유지(케이스1·2), `$` 앵커로 뒤따르는 `xxx`/` xxx`가 매치에서 truncate되지 않고 value에 남음(케이스3) — 비앵커 정규식에선 non-greedy strg가 공백 앞에서 조기 종료하고 optional comm_field가 매치를 끝내 트레일링 텍스트가 silently 유실되며(comment 흡수 아님), `$`가 strg backtrack을 강제해 전체를 소비한다. 한 줄만 고치면 세 단언 중 하나 이상이 실패하므로 두 변경의 필요성을 테스트가 강제.
- **overfit 관점**: 테스트가 세 구별 입력으로 special-case 통과를 막아 S2 픽스를 비교적 잘 고정. 다만 `''`가 여러 개·중간 다중 출현하는 경우, comment가 실제로 있는 long-string은 직접 단언하지 않아 미검증 입력공간이 남음(overfit-risk 약).
- **regression 관점**: P2P 175개에 `test_long_string_*`, `test_commentary_*`, `test_*_via_fromstring`, `test_continue_card_*`가 포진. `$` 앵커는 trailing 공백/패딩 처리에 민감해 이들이 강한 regression guard 역할.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`''`가 `'`로, long value에서만" 신호 → escape는 정상인데 round-trip만 깨짐 → `Card.fromstring`/`str(card)`의 long-string(CONTINUE) 분할 경로. `io/fits/card.py`에서 `_split()`의 길이 초과 분기와 거기서 쓰는 `_strg_comment_RE`로 수렴.
2. **픽스와 일반화**: `_split()`의 `value.rstrip().replace("''","'")`에서 `.replace`가 redundant한 선행 unescape임을 확인 → 제거. 핵심 prerequisite은 진짜 unescape가 호출부 `_parse_value()`의 `value = re.sub("''", "'", m.group("strg"))`에서 정확히 한 번 일어난다는 것이라, `.replace`를 빼도 진짜 single-quote 값의 round-trip이 보존된다(인코딩 `_format_long_image`의 `replace("'","''")`가 한 번 escape → decode도 한 번이라야 대칭). hint의 `'' aaa`/끝 인용부 유실은 `_strg_comment_RE`가 끝 앵커 없어 non-greedy `strg`가 공백 앞에서 조기 종료하고 optional `comm_field`로 매치가 끝나 트레일링 텍스트가 truncate됨이 원인 → `$` 추가(backtrack 강제). 이는 특정 길이 패치가 아니라 "decode unescape를 `_parse_value` 한 곳에서만, value/comment 경계를 문자열 끝으로 확정"이라는 불변식 복원이라 올바른 일반화.
3. **regression 안전**: `$` 추가가 정상 comment 분리·trailing 공백 패딩을 깨면 안 됨 → `test_long_string_value`, `test_long_string_value_via_fromstring`, `test_commentary_*`, `test_continue_card_*`가 P2P로 보장. `.replace` 제거가 단일 `'`(정상 escape) 케이스를 깨지 않는지도 동일 P2P가 커버.
4. **함정 회피**: (a) 끝 인용부 유실(`''`→`'`)만 보고 `.replace`만 제거하면 `'' aaa`의 텍스트 유실이 남음 — **두 원인을 다 잡아야** 함(이중원인 함정). (b) 반대로 `$`만 추가하면 unescape 손실이 남음. (c) `.replace`를 `_split` 대신 escaping 쪽에서 손대면 짧은 카드 정상 경로를 깨 P2P 광범위 회귀. 오라클 없는 에이전트는 첫 재현(끝 인용부)만 픽스하고 hint의 공백 케이스를 놓치기 쉬운데, FAIL_TO_PASS 케이스3가 이를 적발한다.
