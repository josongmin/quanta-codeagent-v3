---
instance_id: sympy__sympy-24539
repo: sympy/sympy
base_commit: 193e3825645d93c73e31cdceb6d742cc6919624d
version: "1.12"
difficulty: "<15 min fix"
created_at: 2023-01-17T17:26:42Z
fail_to_pass: 1
pass_to_pass: 62
gold_files: [sympy/polys/rings.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
`PolyElement.as_expr(*symbols)`는 출력 표현식에 쓸 심볼을 호출자가 지정할 수 있어야 하는데, 실제로는 동작하지 않는다. 올바른 개수의 심볼을 넘기면 그 인자를 무시하고 `self.ring.symbols`를 쓰고, 틀린 개수를 넘기면 에러를 던진다. 즉 사용자가 준 심볼이 절대 반영되지 않는 죽은 분기 버그다. 이슈 본문에 정확한 소스 위치(L618-L624)와 재현 스니펫(`f.as_expr(U, V, W)`가 `x,y,z`로 출력)이 모두 들어있다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·메서드(`sympy/polys/rings.py`의 `as_expr`)와 정확한 줄 범위를 직접 지목. 탐색 불필요.
- **S1 (Direct-Map)**: 결함클래스가 정형적인 "잘못된 if/else 분기 구조"다. `symbols`가 truthy든 아니든 무조건 `symbols = self.ring.symbols`로 덮어쓰는 죽은 코드를 제거하고, "인자 없을 때만 기본값" + "개수 틀릴 때만 에러"로 분기를 재배치하는 기계적 수리. 추론 합성이 아니라 제어흐름 정정.
- **K-Gen (General)**: sympy 도메인 지식 거의 불필요. if/else 의미만 읽으면 잡힌다. `expr_from_dict`/`ring.symbols`는 그대로 두므로 polys 내부 이해 요구 없음.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 기계적(S1)이므로 T-DirectMap. (T-LocTrivial보다 한 단계 위인 이유는 픽스가 단순 한 줄 가드가 아니라 분기 3-갈래 재구성이기 때문 — 그래도 추론 부담은 거의 없음.)

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일 1함수, gold diff 약 6줄(실질 +4/-2), has-repro(이슈에 실행 가능한 재현 + 잘못된 출력 명시), regression-trap 약함(`as_expr`만 만지고 62개 P2P는 인접 polys 동작이라 분기 변경에 무관). localize는 이슈가 정답을 적어줘 비용 0. 공식 라벨 `<15 min fix`(T1성)와 한 단계 차이로 T2를 매긴 이유: 픽스가 한 줄 상수/가드 추가가 아니라 if/else의 양 분기를 재배치(논리적으로 not-symbols / elif len-mismatch / 통과의 3 케이스를 새로 구성)해야 정확히 맞기 때문 — T1의 "이슈가 픽스를 거의 적어줌"보다 살짝 더 손이 간다.

## 골드패치 분석
- **파일·함수**: `sympy/polys/rings.py` → `PolyElement.as_expr`.
- **근본원인**: 기존 코드는
  ```python
  if symbols and len(symbols) != self.ring.ngens:
      raise ValueError(...)
  else:
      symbols = self.ring.symbols
  ```
  구조상 `raise`로 빠지지 않은 모든 경로가 `else`로 떨어져 **사용자가 준 올바른 개수의 `symbols`까지 `self.ring.symbols`로 덮어써 버린다**. 정상 인자가 무조건 폐기되는 죽은 분기.
- **수정요지**: 분기를 의미대로 재배치 — `if not symbols:`일 때만 기본값 `self.ring.symbols`를 채우고, `elif len(symbols) != self.ring.ngens:`일 때만 에러를 던지며, 둘 다 아니면 호출자가 준 `symbols`를 그대로 `expr_from_dict(self.as_expr_dict(), *symbols)`로 전달한다. 에러 메시지도 "not enough symbols"에서 개수 불일치를 정확히 표현하는 "Wrong number of symbols"로 교정.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_PolyElement_as_expr` 1개. 테스트는 링과 다른 심볼 `U, V, W = symbols("u,v,w")`로 `g = 3*U**2*V - U*V*W + 7*W**3 + 1`을 만들고 `f.as_expr(U, V, W) == g`를 단언한다. 기존 코드면 `x,y,z`로 출력돼 `g`와 불일치 → 실패. 픽스 후 사용자 심볼이 보존돼 통과. 또한 `raises(ValueError, lambda: f.as_expr(X))`로 개수 부족 시 여전히 에러임을 검증.
- **픽스 증명**: 테스트가 (a) 올바른 개수 다른-심볼 경로(이전엔 죽은 분기)와 (b) 개수 불일치 에러 경로를 둘 다 덮어 양쪽 분기를 묶는다.
- **overfit·regression 관점**: overfit 위험 낮음 — 단언이 단순 동등성이지만 정정 자체가 "인자 보존"이라는 일반 동작이라 special-case 우회가 어렵다. regression 위험 낮음 — 인자 없는 호출(`f.as_expr()`)은 `if not symbols` 분기로 기존과 동일하게 기본 심볼을 쓰므로 무인자 사용처가 안 깨진다(테스트 상단의 `f.as_expr() == g` 케이스가 이를 지킨다).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 파일·메서드·줄 범위와 재현 스니펫을 직접 제공 → `sympy/polys/rings.py`의 `PolyElement.as_expr`로 즉시 직행. 탐색 단계 사실상 생략.
2. **픽스와 일반화 근거**: 죽은 `else: symbols = self.ring.symbols`가 정상 인자까지 덮는 것이 핵심. 분기를 `not symbols`(기본값) / `len != ngens`(에러) / 통과(인자 사용) 세 갈래로 재배치. 이것이 overfit 아닌 올바른 일반화인 이유 — 테스트의 특정 심볼명(u,v,w)에 맞춘 게 아니라 "전달된 심볼을 그대로 `expr_from_dict`에 넘긴다"는 임의의 올바른-개수 입력에 대해 성립하는 동작을 복원하기 때문.
3. **regression 안전**: 무인자 호출 경로(`if not symbols`)와 개수 불일치 에러 경로를 보존해야 한다. 62개 P2P는 `as_expr` 분기와 독립이지만, 같은 테스트 안의 `f.as_expr()` 동등성과 `raises(ValueError, ...)`를 깨지 않도록 두 경계를 모두 유지하는 게 안전 조건.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 저지를 실수 — `if symbols and len != ngens: raise` 조건만 손대고 `else`를 그대로 둬 여전히 정상 인자를 덮거나, 반대로 `else`만 지워 무인자 호출에서 `symbols`가 빈 채로 `expr_from_dict`에 넘어가 깨지는 것. 함정 회피법: 세 케이스(무인자/개수 틀림/정상)를 명시적으로 분리해 무인자 기본값 채움을 별도 분기로 보존하는 것.
