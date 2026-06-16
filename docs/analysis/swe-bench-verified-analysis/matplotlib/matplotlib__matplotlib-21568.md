---
instance_id: matplotlib__matplotlib-21568
repo: matplotlib/matplotlib
base_commit: f0632c0fc7339f68e992ed63ae4cfac76cd41aad
version: "3.4"
difficulty: "15 min - 1 hour"
created_at: 2021-11-08T18:41:08Z
fail_to_pass: 4
pass_to_pass: 73
gold_files: [lib/matplotlib/dates.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`usetex=True`로 datetime 축을 그릴 때 틱 레이블의 간격(spacing)이 3.3 대비 3.4에서 망가졌다. 3.4부터 날짜를 TeX(`$\mathdefault{...}$`)로 렌더하기 시작했는데(#18558), 콜론(`:`)과 공백이 mathtext 안에서 보호되지 않아 `00:00`의 `:`이 이항연산자처럼 넓게 띄워지고 날짜·시각 사이 공백이 사라져 가독성이 깨졌다. 이슈에는 `_wrap_in_tex`를 monkey-patch한 수정안까지 제시되어 있다.

## 유형 (정형화)

- **L = L1 (Traceable)**: 이슈가 직접 심볼을 지목하진 않지만, hints에 `_wrap_in_tex` monkey-patch가 그대로 들어있고 키워드(usetex, mathdefault, dates)가 단일 함수로 곧장 수렴한다. grep 한두 방.
- **S = S2 (+S1) Constraint-Reasoning**: 고칠 지점(`_wrap_in_tex`)은 자명하나, "어떤 문자를 어떻게 escape/보호해야 mathtext가 올바르게 렌더되는가"라는 TeX 조판 규칙을 추론해 식을 합성해야 한다. `-`처럼 `:`도 중괄호로 감싸 이항연산자 spacing을 죽이고(`{:}`), 공백은 `\;`로 치환하는 규칙은 기계적 가드(S1)보다는 도메인 제약 추론에 가깝다.
- **K = K-Domain**: 일반 파이썬이 아니라 mathtext/TeX 조판 의미(중괄호로 연산자 spacing 억제, `\;` thin-space)에 대한 지식이 병목.
- **primary_type = T-ConstraintReason**: 위치는 명확하나 올바른 치환 식을 TeX 규칙으로 추론·합성하는 게 본질. 픽스 도출이 "테스트 반복 수렴"(S3/S4)이 아니라 도메인 제약 추론이라 T-ConstraintReason.

## 난이도 티어

**T3 (중간).** 구조적 피처: 단일 파일(`dates.py`) · 단일 함수(`_wrap_in_tex`) · 실질 +4/-2줄의 작은 헌크. has-repro 강신호(재현코드 + 3.3 vs 3.4 비교 이미지 + 정답에 근접한 monkey-patch까지 hints에 존재) → 본래라면 더 쉽지만, 픽스 자체가 TeX 조판 규칙 추론(S2)이고 P2P가 73개로 넓어(regression-trap) `test_concise_formatter_*` 등 기존 기대 문자열을 동시에 갱신해야 한다. 공식 라벨 "15min-1h"와 정합. L1·S2·소규모 헌크라 T2까지 내려갈 수도 있으나, 정답 식을 "왜 `{:}`·`\;`인가"로 도메인 추론해야 하고 인접 테스트 기대값 동기 갱신 부담이 있어 T3으로 둔다.

## 골드패치 분석

- **건드린 파일·함수**: `lib/matplotlib/dates.py` 의 `_wrap_in_tex(text)`.
- **근본원인**: 기존 코드는 `-`만 `{-}`로 보호한 뒤 `$\mathdefault{...}$`로 감쌌다. 그러나 시각 포맷의 `:`은 mathtext에서 관계연산자로 취급돼 양옆에 넓은 space가 붙고, 날짜와 시각을 잇는 ASCII 공백은 mathmode에서 그냥 사라진다. 즉 "기호 보호"가 `-` 한 종류에만 적용된 불완전한 escape.
- **수정요지**: 치환을 확장 — `-` → `{-}` 에 더해 `:` → `{:}` (연산자 spacing 억제), 그리고 ` ` → `\;` (thin-space로 보존)을 추가한 뒤 `$\mathdefault{...}$`로 감싼다. 마지막의 빈 `$\mathdefault{}$` 제거 로직은 유지.

## 검증 (test_patch)

`lib/matplotlib/tests/test_dates.py`에서 `test_date_formatter_usetex`·`test_concise_formatter_usetex`의 기대 문자열을 새 조판으로 갱신하고, `style.use("default")` 고정 및 분(minutes=10) 케이스 신규 추가.

- **FAIL_TO_PASS(4)**: `test_date_formatter_usetex[delta2/delta3]`, `test_concise_formatter_usetex[t_delta2/t_delta3]`. 예: 일 단위 기대값이 `Jan$\mathdefault{ %02d 1990}$`(보호 안 된 공백) → `$\mathdefault{1990{-}01{-}%02d}$`로, 시각이 `04:00` → `04{:}00`, 날짜-시각 사이가 `01-01\;%02d`처럼 바뀐다. 픽스 후 `_wrap_in_tex`가 `:`/공백을 보호하므로 정확히 이 문자열을 산출 → 통과 증명.
- **overfit 관점**: 기대값이 정규식 매칭이 아닌 정확 문자열 동치라 special-case 회피 여지가 작다. 다만 FAIL_TO_PASS가 4개로 얇아, `:`·공백 외의 다른 기호(예: `/`, `.`)는 검증되지 않음 — 그쪽까지 일반화했다 해도 테스트는 못 잡지만, 골드는 의도적으로 `-`,`:`,` `만 다룬다.
- **regression 관점**: P2P 73개 중 `test_date_formatter_usetex[delta0/delta1]`(연도·월만 있어 보호 대상 문자 없음)과 다수 비-usetex 포맷 테스트가 그대로 통과해야 한다. 치환이 해당 문자가 없는 문자열엔 no-op이라 안전.

## 모범답안 (오라클 기반)

1. **localize**: "usetex datetime spacing 3.3→3.4 회귀" + hints의 `_wrap_in_tex` monkey-patch → `lib/matplotlib/dates.py`의 `_wrap_in_tex` 단일 함수로 직행. 3.4에서 TeX 렌더가 켜진(#18558) 위치이자 `-`만 escape하던 곳임을 확인.
2. **픽스와 일반화 근거**: 기존 `replace('-', '{-}')`가 "연산자 spacing 억제" 패턴임을 읽고, 같은 문제를 일으키는 `:`에 동일 패턴(`{:}`)을, mathmode에서 소실되는 공백엔 TeX thin-space `\;`를 적용. 이는 단순히 실패 테스트를 통과시키는 게 아니라 "mathtext에서 비-영문 기호를 텍스트처럼 조판한다"는 일관된 규칙의 확장이라 올바른 일반화.
3. **regression 안전**: delta0/delta1처럼 보호 대상 문자가 없는 케이스, 그리고 영문 월명 처리(`re.sub(p, ...)` 부분)는 건드리지 않아야 한다. 치환이 부재 문자에 no-op이므로 73개 P2P가 보존됨. `test_concise_formatter_*`의 기존 기대값은 새 조판에 맞춰 동기 갱신하되 의미는 동일.
4. **함정 회피**: (a) `:` 치환을 `re.sub`로 영문 처리 *앞에* 잘못 끼워 넣으면 월명까지 깨질 수 있다 — 골드처럼 `ret_text` 조립 *뒤*에 적용해야 한다. (b) 공백을 `\ `(escaped space)나 단순 제거로 처리하면 spacing이 또 틀어진다 — `\;`가 정답. (c) FAIL_TO_PASS가 얇다고 `:`만 고치고 공백 보호를 빠뜨리면 `t_delta`/날짜-시각 결합 케이스가 깨진다. 세 치환을 한 묶음으로 봐야 한다.
