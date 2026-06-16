---
instance_id: sphinx-doc__sphinx-8621
repo: sphinx-doc/sphinx
base_commit: 21698c14461d27933864d73e6fba568a154e83b3
version: "3.5"
difficulty: "<15 min fix"
created_at: 2020-12-30T12:13:09Z
fail_to_pass: 2
pass_to_pass: 31
gold_files: [sphinx/builders/html/transforms.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

## 문제 요약

`:kbd:` role이 compound-key 구분자(`-`, `+`, `^`)를 키스트로크 자체로 쓸 때 잘못된 HTML을 생성한다. 예를 들어 `:kbd:`-``, `:kbd:`+``, `:kbd:`Shift-+``에서 구분자 문자가 항상 separator로 취급되어 양옆에 빈(blank) `<kbd>` 요소가 끼어든다. 기대 동작은 단독 키스트로크는 단일 `kbd` 요소 하나여야 하고, compound에서는 separator 위치와 keystroke 위치를 구별해야 한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 "simple regexp", "treats all these characters as separators"라고 메커니즘을 직접 지목. `KeyboardTransform`의 `pattern` 정규식이 유일 범인. grep 한 방으로 도달.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`pattern = re.compile(...)`)은 자명하나, 올바른 식을 추론으로 합성해야 한다. "구분자는 양쪽에 키 문자가 있을 때만 구분자다"라는 불변식을 lookbehind/lookahead `(?<=.)...(?=.)`로 인코딩하는 것이 핵심. 후보를 마구 시도하는 G&V가 아니라 경계 조건을 생각으로 푸는 문제.
- **K-Gen**: 정규식 lookaround와 `re.split` 동작만 알면 풀린다. Sphinx 내부 도메인 지식 불요(transform 파이프라인 동작은 이미 정상, 분할 규칙만 잘못됨).

primary type = **T-ConstraintReason**: 위치는 명확하나 정답 정규식을 제약 추론으로 합성해야 함. S2가 dominant인 이유는, 픽스가 "가드 추가/상수 변경" 같은 기계적 직접매핑(S1)이 아니라 split 의미를 바꾸는 조건 합성이기 때문.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개, 실질 변경 1줄 → scope는 T1~T2급.
- has-repro: 이슈에 입력 3개 + 잘못된 출력이 명시 → easiness 신호 강함.
- 그러나 **실질 추론**이 핵심: 정규식 `(-|\+|\^|\s+)` → `(?<=.)(-|\+|\^|\s+)(?=.)`로 바꾸려면 "split이 양옆 컨텍스트가 있을 때만 일어나야 한다"는 불변식을 lookaround로 정확히 표현해야 한다. 1줄이지만 자명한 가드가 아님 → T2를 넘어 T3.
- regression-trap: PASS_TO_PASS 31개가 기존 정상 케이스(`Control+X`, `M-x M-s`, `space`)를 지킴. 새 lookaround가 정상 compound 분할을 깨면 안 됨.

공식 라벨 `<15 min fix`(=T1~T2 prior)와 어긋나는 이유: 개발자 구현시간은 짧지만(정규식 1줄), 에이전트 관점에선 lookbehind/lookahead 경계를 잘못 잡으면(예: `(?=.)`만 추가) 한쪽 경계 케이스가 새는 silent overfit 위험이 있어 추론 부담이 시간라벨에 안 잡힌다. → T3로 상향.

## 골드패치 분석

- **파일·심볼**: `sphinx/builders/html/transforms.py`의 `KeyboardTransform` 클래스 클래스변수 `pattern`.
- **근본원인**: `pattern = re.compile(r'(-|\+|\^|\s+)')`는 `node[-1].astext()`를 `self.pattern.split(...)`로 쪼갤 때, 구분자 문자가 문자열 **양끝**이나 **연속**으로 나와도 무조건 separator로 잡는다. `re.split`은 매치 양옆에 빈 문자열을 산출하므로 `-` 단독 입력은 `['', '-', '']`로 분할 → 빈 `<kbd>` 두 개 생성.
- **수정요지**: 정규식에 lookbehind `(?<=.)`와 lookahead `(?=.)`를 추가 → `(?<=.)(-|\+|\^|\s+)(?=.)`. 구분자는 **앞에도 뒤에도 문자가 존재할 때만** 매치되므로, 문자열 끝의 구분자나 단독 구분자는 split되지 않고 키스트로크 텍스트로 보존된다. `run()`의 split-then-pop 루프 로직은 그대로 둠.

## 검증 (test_patch)

`tests/test_markup.py`에 FAIL_TO_PASS 2건 추가:
- `:kbd:`Alt+^`` → `Alt`와 `^`가 각각 단일 `<kbd>`로, `+`는 separator 텍스트. 끝의 `^`가 빈 kbd를 더 만들지 않음을 검증(LaTeX는 `Alt+\textasciicircum{}`).
- `:kbd:`-`` → 단일 `<kbd>-</kbd>` 하나만. 빈 kbd 없음(LaTeX `\sphinxhyphen{}`).

**픽스 증명**: lookaround가 없으면 `-` 단독은 `['', '-', '']`로 split되어 빈 kbd 발생 → 테스트 RED. lookaround 추가 후 `len(parts) == 1`이 되어 `run()`이 early-continue, 단일 노드 유지 → GREEN.

**overfit/regression 관점**: FAIL_TO_PASS는 2건으로 얇지만, PASS_TO_PASS의 `Control+X`(중간 separator), `M-x M-s`(공백+하이픈 혼합)가 새 정규식 하에서도 정상 분할됨을 보장 → special-case 하드코딩이 아니라 일반적 경계 규칙임이 회귀군으로 입증. overfit 위험 낮음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "simple regexp"·"treats all these characters as separators" 신호 → `kbd` transform 검색 → `sphinx/builders/html/transforms.py`의 `KeyboardTransform.pattern` 단일 지점. L0.
2. **픽스**: `pattern`에 lookbehind/lookahead를 추가해 `(?<=.)(-|\+|\^|\s+)(?=.)`. 올바른 일반화인 이유 — 구분자는 정의상 "두 키 사이"에만 존재하므로, 양쪽에 문자가 있을 때만 split하는 것이 도메인 불변식과 정확히 일치. 끝/단독 구분자 케이스를 별도 분기로 special-case하지 않고 정규식 한 곳에서 일반적으로 해결.
3. **regression 안전**: `Control+X`, `M-x M-s`, `space` 등 PASS_TO_PASS의 정상 compound/단순 케이스를 안 깨야 함. lookaround는 내부 separator 매치에는 영향 없으므로(양옆에 문자 존재) 기존 동작 보존.
4. **함정 회피**: (a) 한쪽 lookaround만 추가(`(?=.)`만)하면 선행 끝 구분자는 새는 비대칭 픽스 → 양쪽 모두 필요. (b) `run()`의 `parts.pop` 루프나 `len(parts)==1` early-continue를 건드려 분할 후 후처리로 빈 노드를 제거하려는 접근은 더 취약하고 LaTeX writer 경로까지 어긋남 — 정규식 한 곳을 고치는 것이 최소·정합. (c) `+`/`^`를 `re.escape` 없이 alternation에 넣는 기존 패턴은 이미 escape되어 있으니 건드리지 말 것.
