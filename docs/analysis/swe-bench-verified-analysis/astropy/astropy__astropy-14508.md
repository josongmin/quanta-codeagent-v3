---
instance_id: astropy__astropy-14508
repo: astropy/astropy
base_commit: a3f4ae6cd24d5ecdf49f213d77b3513dd509a06c
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2023-03-09T11:08:51Z
fail_to_pass: 1
pass_to_pass: 174
gold_files: [astropy/io/fits/card.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`io.fits.Card`가 float 값을 필요 이상으로 긴 문자열로 표현해서, 80자 카드 한계 안에서 comment가 잘려나가는 버그다. 예컨대 `0.009125`를 입력하면 `_format_float()`이 `f"{value:.16G}"`를 써서 `0.009124999999999999`(20자)로 부풀린다. 그 결과 원래 FITS 파일에는 멀쩡히 존재하는 `HIERARCH ... = 0.009125 / ...` 카드를 `fits.Card`로 재생성하면 comment가 truncate되고 round-trip이 깨진다. 이슈는 `f"{value:.16G}"` 대신 Python의 `str(value)`(round-trip 보장 repr)를 우선 쓰자고 직접 제안한다.

## 유형 (정형화)

- **L0 (Localization)**: 이슈가 `card.py`의 `_format_float()` 함수와 정확한 라인(L1300-L1302)까지 지목한다. grep 한 방. 더 줄 수 없는 핀포인트.
- **S2 (Repair Strategy)**: 고칠 지점은 명확하나, "어떤 포매팅이 올바른가"를 추론해야 한다. `f"{value:.16G}"`(고정 16자리 유효숫자) → `str(value)`(Python 3의 shortest round-trip repr)로 바꾸는 게 핵심인데, 이게 옳다는 건 "float repr이 최소 자릿수로 reproducible하다"는 불변식을 알아야 한다. 단순 가드 추가(S1)가 아니라 표현식 합성. 보조로 20자 초과 시 truncation 로직은 유지·정리해야 함.
- **K-Domain (Knowledge)**: FITS 카드 80자/value 20자 제약, scientific notation 지수 포맷(`E`)이라는 도메인 규칙 위에서 추론한다. 다만 핵심 통찰(`str(float)` round-trip)은 일반 Python 지식에 가까워 경계에 걸친다.
- **primary type = T-ConstraintReason**: 위치는 자명(L0)하나 픽스가 "체크 추가"가 아니라 올바른 포매팅 식을 추론으로 갈아끼우는 것이라, T-DirectMap이 아니라 T-ConstraintReason. APR 관점에서 SemFix/Angelix류의 의미적 치환 — 한 줄이지만 그 한 줄이 정확한 의미 불변식(round-trip + 20자 제약)을 만족해야 한다.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개, 함수 1개(`_format_float`), 순변경 ~15줄(대부분 기존 zero-pad 분기 삭제). scope는 작다.
- localize 직접성: L0 — 이슈가 함수·라인·원인·해법까지 다 적어준다. 이것만 보면 T2급.
- has-repro: 구체 재현 코드와 기대 출력이 있다(easiness 신호).
- 그러나 **regression-trap이 티어를 T3로 끌어올린다**: PASS_TO_PASS 166개 중 `test_floating_point_value_card`, `test_invalid_float_cards`, `test_leading_zeros`, `test_assign_inf_nan` 등 float 포매팅 정확성을 직접 검사하는 테스트가 다수다. `f"{value:.16G}"`를 통째로 갈면 지수 표기(`E+32` 등)·inf/nan·20자 절단 동작이 미묘하게 달라질 수 있어 "그냥 str로 바꾸기"가 회귀를 부른다. 픽스 식의 정확성 검증에 실질 추론이 든다.
- 공식 라벨 "15 min - 1 hour"와 일치(T3). 에이전트 관점에서도 localize는 공짜지만 회귀 안전성 확인이 비용이라 T3가 타당.

## 골드패치 분석

- **파일·함수**: `astropy/io/fits/card.py` 의 `_format_float(value)`.
- **근본원인**: 기존 구현이 `value_str = f"{value:.16G}"`로 **항상 16자리 유효숫자**를 강제했다. `0.009125`는 이진 부동소수로 정확히 표현 불가라 16자리로 펼치면 `0.009124999999999999`가 되어 20자를 꽉 채우고, 이후 carry-over로 comment 공간을 잠식한다. 즉 "reproducible하게 충분한 자릿수"가 아니라 "불필요하게 많은 자릿수"를 쓴 것.
- **수정요지**: `value_str = str(value).replace("e", "E")`로 교체. Python 3의 `repr`/`str(float)`은 원래 float로 round-trip되는 **최단 십진 표현**을 보장하므로 `0.009125`는 그대로 `"0.009125"`가 된다. `.replace("e", "E")`는 FITS가 대문자 지수 표기를 요구하기 때문. 기존의 `.0` 부착 분기와 Windows 3자리 지수 zero-pad 정규화 분기는 **삭제**(str()가 이미 적정 포맷을 주고, 3자리 지수 정규화는 더는 불필요). 20자 초과 시 절단 로직은 보존하되 walrus(`str_len := len(value_str)`)로 정리하고, 지수/비지수 분기 주석을 명확화했다.

## 검증 (test_patch)

- **FAIL_TO_PASS**: `test_floating_point_string_representation_card` 1개. HIERARCH 키 + 긴 comment 조합으로 `fits.Card(k, 0.009125, com)`, `8.95`, `-99.9` 세 값에 대해 `str(c)`의 앞부분이 `"{k} = 0.009125 / {com}"` 형태와 일치하는지 검사. 픽스 전엔 `0.009125`가 `0.009124999999999999`로 펼쳐져 comment가 잘리며 prefix 불일치 → 실패. 픽스 후 `str(0.009125)=="0.009125"`라 통과.
- **픽스 증명**: 세 값 모두 짧은 정확 repr을 가지므로 `str()`이 의도된 출력을 직접 생산. 동작 효과(comment 비truncation)를 prefix 비교로 관찰하는 강한 단언.
- **overfit 관점**: 테스트가 세 케이스뿐이라 얇아 보이나, 픽스가 special-case 분기가 아니라 포매터 전체 치환이라 overfit 위험은 낮다. 오히려 PASS_TO_PASS의 기존 float 테스트(지수 표기·inf/nan·절단)가 일반화를 강제하는 안전망. **regression 관점**이 핵심: `test_floating_point_value_card`(지수 `E+32`), `test_assign_inf_nan`, `test_invalid_float_cards`가 모두 통과해야 하며, `str()`+`.replace`가 이들을 만족함을 골드패치가 보증.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `_format_float()`와 L1300-L1302, 그리고 `f"{value:.16G}"`가 원인이라고 명시. `card.py`에서 `_format_float` 하나만 열면 끝. localize에 추론 불필요(L0).
2. **픽스와 일반화 근거**: `f"{value:.16G}"` → `str(value).replace("e", "E")`. 옳은 일반화인 이유 — Python 3.1+ float repr은 **round-trip을 보장하는 최단 표현**(David Gay 알고리즘)이라 "필요한 만큼만, 그러나 충분히" 자릿수를 쓴다. 따라서 hint가 제안한 `value = (1-2**-53)*2**exp`(exp=-60,0,60) 같은 극단값도 정확히 복원된다. 특정 입력에 맞춘 패치가 아니라 포매팅 정책 자체를 올바른 불변식으로 교체한 것.
3. **regression 안전**: 20자 초과 절단 로직(지수면 mantissa 절단, 아니면 뒤 절단)은 **반드시 보존**해야 PASS_TO_PASS의 카드 길이 제약 테스트가 산다. 지수 표기 대문자화(`.replace("e","E")`)를 빠뜨리면 `test_floating_point_value_card`의 `E+32` 단언이 깨진다. inf/nan은 `str()`이 `"inf"/"nan"`을 내므로 `test_assign_inf_nan`도 안전.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실수 — (a) `str(value)`만 쓰고 `.replace("e","E")`를 빠뜨려 소문자 지수로 회귀 유발, (b) Windows 3자리 지수 zero-pad 분기를 "혹시 몰라" 남겨둬 죽은 코드/이중 변환, (c) 20자 절단 블록을 함께 지워 길이 회귀. 회피법: 변경 후 float 관련 PASS_TO_PASS(특히 지수·inf/nan·절단)를 돌려 회귀 0을 확인하고, `str()`이 이미 적정 포맷을 주므로 `.0` 부착·3자리 정규화 분기는 불필요하다는 점을 repr 의미론으로 정당화해 삭제.
