---
instance_id: sympy__sympy-19637
repo: sympy/sympy
base_commit: 63f8f465d48559fecb4e4bf3c48b75bf15a3e0ef
version: "1.7"
difficulty: "<15 min fix"
created_at: 2020-06-24T13:08:57Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [sympy/core/sympify.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`kernS("(2*x)/(x-1)")` 호출이 `UnboundLocalError: local variable 'kern' referenced before assignment`로 죽는다. 이슈 본문이 재현 코드와 정확한 예외 메시지, 그리고 터지는 줄(`hit = kern in s`)까지 그대로 적어준다. 입력에 공백이 없는 경우(`if ' ' in s:`가 거짓) `kern`이 한 번도 바인딩되지 않은 채 `hit = kern in s`에 도달하는 것이 원인.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈가 함수명 `kernS`와 터지는 정확한 라인 `hit = kern in s`를 직접 지목. 스택트레이스가 변수명까지 명시 → grep 한 방.
- **S (Repair Strategy) = S1 (Direct-Map)**: 정형 결함클래스 "조건부 분기 밖에서 미초기화 지역변수 참조". 픽스가 기계적 — 해당 대입을 정의 블록 안으로 옮기고 else에서 기본값(`False`) 부여. 추론 합성 불필요.
- **K (Knowledge) = K-Gen**: 순수 파이썬 스코프 규칙(지역변수 바인딩) 문제. sympify 도메인 지식 전무. `kern`/`hit`의 의미만 알면 됨.
- **Primary = T-DirectMap**: 위치 자명(L0) + 픽스가 None-가드/초기화 템플릿에 그대로 매칭(S1). T-LocTrivial이 아닌 이유는 픽스가 "한 줄 추가"가 아니라 제어흐름(분기 안으로 이동 + else 기본값) 재배치라 약간의 의미 정렬이 필요하기 때문.

APR 관점: 이건 SemFix류 식 합성(S2)이 아니라 PAR/TBar식 템플릿 매칭(S1)이다 — "uninitialized-on-some-path 변수를 모든 경로에서 정의되게 한다"는 결함패턴이 정확히 알려진 fix template과 일대일 대응한다.

## 난이도 티어
**T1 (존나쉬움)**. 구조적 피처:
- 파일수 1 (`sympy/core/sympify.py`), 골드 헌크 1개, 실질 변경 ~3줄.
- localize 직접성 최상: 이슈가 라인·변수·예외타입을 모두 줌(`has-repro`).
- 도메인 지식 불요(K-Gen). 식·불변식 추론 없음.
- 공식 라벨 `<15 min fix`와 일치 — 재조정 없음.
- 다만 단순 0줄짜리 T0이 아닌 이유: `hit`은 함수 후반(`for i in range(2)`의 fallback, `if not hit: return expr`, `rep = {Symbol(kern): 1}`)에서 다시 읽힌다. 그래서 "그냥 라인 삭제"는 틀린 픽스고, no-space 경로에서 `hit=False`로 단락시켜 `kern` 미사용을 보장해야 한다(약한 `regression-trap`). 이 한 가지 미묘함이 T0이 아닌 T1.

## 골드패치 분석
- **파일·함수**: `sympy/core/sympify.py` 내 `kernS(s)`.
- **근본원인**: `kern`은 `if ' ' in s:` 블록 안에서만 생성되는데(`kern = '_'` 이후 충돌 회피 루프), `hit = kern in s`가 그 블록 **밖**에서 무조건 실행됨. 입력에 공백이 없으면(예: `"(2*x)/(x-1)"`는 `s = s.replace(' ', kern)` 전처리에서 공백이 안 생기는 케이스) `kern`이 영영 바인딩되지 않아 `UnboundLocalError`.
- **수정요지**: `hit = kern in s`를 `if ' ' in s:` 블록 **안으로** 들여쓰고, 새 `else: hit = False`를 추가. 즉 공백이 있어 kern 치환을 했을 때만 `hit`을 kern 존재 여부로 계산하고, 아니면 kern을 안 썼으니 `hit = False`. 이렇게 하면 후속 `if not hit: return expr`가 즉시 정상 경로로 빠지고 `rep = {Symbol(kern): 1}`(kern 사용처)에 절대 도달하지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_kernS`** (1개): `assert kernS("(2*x)/(x-1)") == 2*x/(x-1)` 단언 추가. 패치 전엔 `UnboundLocalError`로 raise, 패치 후엔 공백 없는 입력에서 `hit=False`로 정상 sympify되어 기대식 반환.
- **픽스 증명**: 추가 단언이 정확히 "no-space 입력" 경로를 때린다. else 분기가 없으면 여전히 raise하므로 패치의 핵심(else 추가)을 직접 커버.
- **overfit 관점**: 단언 1줄이라 얇아 보이지만, 픽스가 입력값에 의존하는 special-case가 아니라 제어흐름 일반화(모든 no-space 입력에 동일 적용)라 overfit 위험 낮음. `overfit-risk` 미표기.
- **regression 관점**: `regression-trap` 표기. PASS_TO_PASS 40개가 `kernS`를 호출하는 기존 케이스(공백 있는 입력, `'x - (x - 1)'` 등)를 보호한다. 핵심은 공백 있는 경로에서 `hit = kern in s`가 **여전히** 계산되어야 한다는 것 — else만 추가하고 들여쓰기를 안 하면 공백 케이스가 깨진다. 골드패치는 대입을 if 안으로 옮겨 이 동작을 보존.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 예외 메시지 `local variable 'kern' referenced before assignment`와 주석 `// hit = kern in s` → `grep "hit = kern in s"`로 `sympify.py:kernS` 단일 히트. 즉시 도달.
2. **픽스와 일반화**: `kern`이 `if ' ' in s:` 안에서만 정의됨을 확인 → 두 경로(공백 有/無)에서 `hit`이 모두 정의되도록 만든다. 공백 있을 때만 `kern in s`, 없을 때 `hit=False`. 이는 입력 한 개를 통과시키는 패치가 아니라 "kern을 쓴 경로만 hit=True 가능"이라는 불변식을 복원하는 것이라 올바른 일반화.
3. **regression 안전**: 공백 있는 입력 경로의 `hit = kern in s` 계산을 반드시 유지해야 함(PASS_TO_PASS의 `'x - (x - 1)'` 등이 kern 치환 후 `if not hit` 단락에 의존). 그래서 "라인 삭제"나 "if 밖에 hit=False만" 같은 픽스는 회귀를 부른다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 두 함정 — (a) `hit = kern in s`를 통째로 지워 공백 경로의 `not hit` 처리를 깨뜨림, (b) `kern = '_'`를 if 위로 끌어올려 초기화하지만 그러면 공백 없는 입력에서 `hit`이 `'_' in s` 결과로 잘못 True가 되어 `rep = {Symbol('_'): 1}` 치환이 엉뚱하게 발동. 정답은 골드처럼 **분기별로 `hit`을 정의**해 kern 사용 여부와 hit을 묶는 것.
