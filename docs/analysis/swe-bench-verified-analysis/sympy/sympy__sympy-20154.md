---
instance_id: sympy__sympy-20154
repo: sympy/sympy
base_commit: bdb49c4abfb35554a3c8ce761696ffff3bb837fe
version: "1.7"
difficulty: "15 min - 1 hour"
created_at: 2020-09-26T22:49:04Z
fail_to_pass: 2
pass_to_pass: 40
gold_files: [sympy/utilities/iterables.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [regression-trap]
---

## 문제 요약
`sympy.utilities.iterables.partitions()` 이터레이터가 매 yield마다 **같은 dict 객체를 재사용**한다(속도 목적, docstring에 caveat 명시). 그 결과 `list(partitions(...))`처럼 결과를 누적하면 모든 원소가 마지막 상태를 가리켜 겉보기 오답이 나오고, partition을 비자명하게 쓰면 미묘한 버그로 이어진다. 이슈는 "복사 비용이 그리 크지 않을 텐데 이 혼란스러운 동작이 정말 필요하냐"고 묻는다 — 즉 yield 전에 copy를 요구한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 함수 `partitions`를 직접 지목하고, 모듈 경로(`sympy.utilities.iterables`)까지 적어준다. grep 한 방. 점수 L0.
- **S1 (Direct-Map)**: 이슈가 사실상 픽스를 명세한다 — "copy the dictionary before yielding it". 결함클래스는 정형적인 "mutable-object aliasing on yield". 추론 합성(S2)이 아니라 `ms` → `ms.copy()` 기계적 치환. 점수 S1.
- **K-Gen**: aliasing/제너레이터 시맨틱은 일반 파이썬 지식. sympy 도메인(assumptions/심볼대수) 불필요. 점수 K-Gen.
- **primary = T-DirectMap**: 위치 명확 + 기계적 픽스. 픽스가 식·조건의 추론 합성이 아니라 "yield 직전에 copy 삽입"이라 T-ConstraintReason이 아닌 T-DirectMap.
- APR 관점: PAR/TBar식 결함템플릿("aliased mutable yield → defensive copy")에 그대로 매칭. 이슈 본문이 픽스를 명세하므로 generate-&-validate 탐색이 불필요, S1이 dominant.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개, 함수 1개(`partitions`), 실코드 변경 4줄(2개 yield 분기 × {size True/False}), 추가로 docstring 15줄 삭제.
- localize 직접성: L0(이슈가 심볼 지목) — 탐색 노력 거의 0.
- repro: 이슈에 `[p for p in partitions(6, k=2)]` 형태의 명시적 잘못된 출력 예시가 있어 사실상 재현 코드 포함.
- 도메인 지식: 불필요(K-Gen).
- P2P trap: `regression-trap` 약하게 존재 — `partitions`는 sympy 전역에서 쓰이는 핵심 이터레이터라 의미는 보존하되 동작은 절대 안 깨야 한다(P2P 40개). 단 copy는 의미를 보존하므로 trap이 폭발하진 않음.
- 공식 라벨 "15분-1시간"과 정합. T1까지 내리지 않는 이유: 단순 1줄이 아니라 4개 yield 사이트를 빠짐없이 손봐야 하고(누락 시 부분 픽스), 넓은 호출처에 대한 회귀 인식이 필요해 T1(자명)보다 한 단계 위.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/utilities/iterables.py`의 `partitions(n, m=None, k=None, size=False)`.
- **근본원인**: 함수가 내부 누적 dict `ms`를 매 yield마다 *동일 참조*로 내보낸다. 다음 반복에서 `ms`를 in-place 변형하므로 이전에 yield된 객체도 함께 바뀐다(aliasing). 속도 위해 의도된 동작이지만 호출자에게 함정.
- **수정요지**: 4개 yield 지점을 모두 copy 반환으로 변경 —
  - 첫 yield(루프 진입 전): `yield sum(ms.values()), ms` → `... ms.copy()`, `yield ms` → `yield ms.copy()`
  - while 루프 내 yield: 동일하게 `ms` → `ms.copy()` (size 분기 양쪽).
  또한 재사용 동작을 설명하던 docstring 단락(`Note that the _same_ dictionary object is returned...` 및 `.copy()`로 우회하라는 예시)을 삭제해 코드와 문서를 일치시킴.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_partitions`, `test_uniq`.
- **픽스 증명**: 테스트 패치는 기존 테스트가 결과 보존을 위해 강제로 박아두던 `p.copy()`를 **제거**한다. 예: `[p.copy() for p in partitions(6, k=2)] == [...]` → `[p for p in partitions(6, k=2)] == [...]`. 픽스 전에는 copy 없이 누적하면 모두 마지막 partition으로 collapse되어 불일치 → 실패. 픽스 후 `partitions`가 이미 copy를 yield하므로 호출자 copy 없이도 각 dict가 독립 → 통과. `test_uniq`도 `uniq(p for p in partitions(4))`가 서로 다른 dict를 보아야 정상 동작.
- **overfit 관점**: 픽스가 입력 특수화가 아니라 모든 yield 경로의 보편적 copy라 overfit 위험 낮음. FAIL_TO_PASS가 size 분기/여러 (n,m,k) 조합을 커버해 4개 사이트 누락을 잡아낸다.
- **regression 관점**: P2P 40개(같은 모듈의 다른 이터레이터들)는 의미 무변경이라 안전. `partitions`의 yield 값 *내용*은 동일하고 *동일성/aliasing*만 바뀌므로 값 비교 기반 호출처는 영향 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `sympy.utilities.iterables`의 `partitions`를 직접 호명 → 해당 파일에서 `def partitions(` grep → docstring의 "same dictionary object is returned" caveat이 곧 결함 위치를 자백한다. 함수 본문의 모든 `yield`를 열거(첫 진입 yield + while 루프 yield, 각각 size True/False) → 4개 사이트 확정.
2. **픽스와 일반화 근거**: 4개 yield 모두 `ms` → `ms.copy()`. 올바른 일반화인 이유 — 결함은 입력 특정이 아니라 "변형되는 내부 dict를 alias로 내보냄"이라는 *구조적* 문제다. 따라서 단일 케이스가 아니라 모든 산출 경로에서 방어적 copy가 정답. 한 분기만 고치면 다른 (n,m,k,size) 경로에서 동일 버그 잔존.
3. **regression 안전**: yield되는 dict의 *값*은 불변, *공유 여부*만 바뀐다. 따라서 값을 소비하는 모든 P2P(`test_ordered_partitions` 등 40개)는 무영향. docstring 예시 삭제는 문서-코드 일치를 위한 것으로 동작에 무관. 성능 회귀는 partition당 작은 dict copy 한 번이라 무시 가능(이슈도 이를 수용).
4. **함정 회피**: (a) yield 사이트 **누락** — size=True 분기와 while 루프 내부 yield까지 4곳 전부 손대야 함. 하나라도 빠지면 FAIL_TO_PASS의 size 조합/긴 시퀀스 케이스에서 재실패. (b) docstring의 "speed" caveat을 보고 "의도된 동작이니 두라"고 잘못 판단 — 이슈가 명시적으로 그 동작 폐기를 요청하므로 docstring 예시까지 제거하는 게 정답. (c) 호출자 쪽(테스트의 `.copy()`)을 고치는 방향은 본질을 뒤집은 오답 — 픽스 책임은 생산자 `partitions`에 있다.
