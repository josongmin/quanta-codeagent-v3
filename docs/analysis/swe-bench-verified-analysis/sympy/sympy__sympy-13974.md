---
instance_id: sympy__sympy-13974
repo: sympy/sympy
base_commit: 84c125972ad535b2dfb245f8d311d347b45e5b8a
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2018-01-20T18:25:59Z
fail_to_pass: 1
pass_to_pass: 4
gold_files: [sympy/physics/quantum/tensorproduct.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`TensorProduct`의 거듭제곱(`Pow`)이 `tensor_product_simp`로도 `expand(tensorproduct=True)`로도 평가되지 않는다. 예컨대 `tps(tp(1,1)*tp(1,1))`가 `1x1**2` 그대로 남고, `tps(tp(1,Pauli(3))*tp(1,Pauli(3)))`도 미평가다. 기대 동작은 지수를 텐서곱 각 인자로 분배하는 것(`tp(a,b)**n → tp(a**n, b**n)`). 이슈에 재현 세션과 기대 출력(`[5]`, `[9]`)이 명시돼 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 파일을 직접 거론하지 않지만, 증상이 `tensor_product_simp` 함수명을 짚어줘 단일 파일 `sympy/physics/quantum/tensorproduct.py`로 즉시 수렴한다. hints에도 같은 파일·함수가 박혀 있다. grep 한두 번.
- **S2 (+S6) Constraint-Reasoning + Design-Refactor**: 고칠 지점은 자명하나, "지수를 각 인자에 분배"라는 **올바른 식**(`TensorProduct(*[b**e.exp for b in e.base.args])`)을 합성해야 하고, 그것을 `Mul` 분기 안에서 `Pow` 케이스로 끼워넣는 **소규모 구조 추가**(신규 헬퍼 `tensor_product_simp_Pow` 도입 + 기존 `tensor_product_simp_Mul`/`tensor_product_simp` 분기 재배치)가 필요하다. 단순 상수/가드 추가가 아니므로 S1이 아니다.
- **K-Domain**: `TensorProduct`/`Mul.args_cnc`/`Pow.base,exp`라는 sympy 양자·핵심 대수 API를 알아야 식을 맞춘다. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason**: 위치는 거의 명확(L1)하지만 본질 난점은 "어떤 식·어떤 분기로 Pow를 처리할지" 추론 합성에 있다.

## 난이도 티어
**T4 (약간 어려움).** 구조적 피처: 1파일·단일 골드패치지만 헌크가 4개로 흩어지고(`Mul` 분기 내 n_nc==1 / TensorProduct-아님 분기 / next-루프 / 신규 `elif e.has(Pow)`), 신규 헬퍼 함수 도입(S6 성격)과 정확한 인자분배 식 추론(S2)이 겹친다. `tensor_product_simp_Mul`의 기존 raise 경로를 깨지 않으면서 `Pow` 경로를 추가해야 하는 분기 조율이 P2P trap을 만든다. has-repro라 재현은 쉬워 T5까지는 안 가고, 단일파일·~40줄이라 T6도 아니다. 공식 라벨 "15분-1시간"과 정합(T3~T4 경계, 분기 조율 비중으로 T4로 상향).

## 골드패치 분석
- **파일**: `sympy/physics/quantum/tensorproduct.py`
- **함수**: `tensor_product_simp_Mul`, `tensor_product_simp`, 신규 `tensor_product_simp_Pow`
- **근본원인**: `tensor_product_simp`의 `Pow` 분기가 `tensor_product_simp(e.base) ** e.exp`로만 처리해 base가 `TensorProduct`일 때 지수를 인자에 분배하지 못했다. 또한 `tp(a,b)*tp(c,d)` 같은 곱이 `tp(a,b)**2`로 접히면 `tensor_product_simp_Mul`의 nc_part에 `Pow`가 들어오는데, 기존 코드는 `n_nc==1`을 무조건 `return e`하고, 멀티텀 루프에서도 비-`TensorProduct`를 만나면 `TypeError`를 던지거나 잘못 곱했다.
- **수정요지**: 신규 헬퍼 `tensor_product_simp_Pow(e)`가 `isinstance(e.base, TensorProduct)`일 때 `TensorProduct(*[b**e.exp for b in e.base.args])`를 반환. `tensor_product_simp`의 `Pow` 분기는 base가 TensorProduct면 이 헬퍼로 위임. `tensor_product_simp_Mul`은 (a) `n_nc==1`이면서 `Pow`면 헬퍼로 평가, (b) 첫 `current`나 루프의 `next`가 `Pow(base=TensorProduct)`면 헬퍼로 변환 후 인자별 곱, (c) `elif e.has(Pow)` 분기로 nc_part 전체를 헬퍼 매핑 후 재귀.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_tensor_product_simp` 한 개. 신규 단언 4종 — `tps(TP(A,B)**x) == TP(A**x, B**x)`(순수 Pow), `tps(x*TP(A,B)**2) == x*TP(A**2,B**2)`(c_part 동반 단일 nc Pow), `tps(x*(TP(A,B)**2)*TP(C,D)) == x*TP(A**2*C,B**2*D)`(Pow+TP 혼합 멀티텀), `tps(TP(A,B)-TP(C,D)**x) == TP(A,B)-TP(C**x,D**x)`(Add 안의 Pow). 기존 `TP(A,B)*TP(B,C)` 단언도 보존.
- **픽스 증명**: 분기 매핑은 1:1이 아니다(실측 확인). 어서션1(`TP(A,B)**x`)은 `tensor_product_simp`의 순수 Pow 위임을, 어서션2(`x*TP(A,B)**2`)는 `tensor_product_simp_Mul`의 `n_nc==1` + Pow 분기를 탄다. 어서션3(`x*(TP(A,B)**2)*TP(C,D)`)은 args_cnc가 `nc_part=[Pow, TensorProduct]`라 current(nc_part[0])가 Pow → `e.has(TensorProduct)` 분기 안의 `if isinstance(current, Pow)` 블록(첫 current가 Pow)을 타지, 'next-루프 Pow' 블록을 타지 않는다(any next is Pow: False). 어서션4(`TP(A,B)-TP(C,D)**x`)는 Add→재귀→Mul에서 그 Pow 항이 `Mul((-1), TP(C,D)**x)`로 n_nc==1·nc_part=[Pow]라 어서션2와 동일한 `n_nc==1` Pow 분기다. 결과적으로 신규 Mul 분기 중 'next-루프 Pow'와 `elif e.has(Pow)` 두 분기는 4 어서션 어디서도 실행되지 않는다(`elif e.has(Pow)`는 `TP(A,B)**2`가 `.has(TensorProduct)==True`라 선행 `elif e.has(TensorProduct)`에 가려 실질 도달 불가). 4 어서션 모두 gold patch에서 True 통과 확인.
- **overfit/regression**: 신규 Mul 분기 4개 중 'next-루프 Pow'와 `elif e.has(Pow)` 2개는 테스트 미커버라(위 픽스 증명 참조) 분기 1:1 wiring 입증은 성립하지 않는다 — 신규 분기의 절반이 미검증으로 남는다. 그럼에도 어서션이 정확한 기대값과 동치를 요구해 special-case 통과 여지는 작으므로 overfit-risk는 낮다(그래서 플래그 제외). 다만 PASS_TO_PASS 4종(`test_tensor_product_abstract/_expand/_commutator/_issue_5923`)이 같은 `tensor_product_simp` 경로를 공유하므로, raise 경로나 Mul 분기를 잘못 바꾸면 regression이 터진다 → regression-trap.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `tensor_product_simp` / `expand(tensorproduct=True)` 키워드 → `sympy/physics/quantum/tensorproduct.py`의 `tensor_product_simp` 디스패처. 거기서 `elif isinstance(e, Pow): return tensor_product_simp(e.base) ** e.exp` 줄이 인자분배를 안 하는 결함 지점임을 확인.
2. **픽스**: 헬퍼 `tensor_product_simp_Pow`로 `TensorProduct(*[b**e.exp for b in base.args])`를 만든다. 이게 올바른 일반화인 이유 — 텐서곱은 성분별이라 `(a⊗b)**n`이 `a**n ⊗ b**n`과 같고, 인자 개수에 무관하게 `base.args` 전체에 적용되므로 hints의 `tp(a,b,c,...)**n` 임의 항수에도 성립. 곱이 `Pow`로 접히는 경로(`tp*tp → tp**2`)까지 `tensor_product_simp_Mul`의 nc_part에서 잡아야 `[5]/[9]`의 곱 형태도 평가된다.
3. **regression 안전**: `tensor_product_simp_Mul`의 기존 `n_nc==0`/순수 TensorProduct 루프/`c_part` 보존과 `TypeError` 가드를 유지해야 `test_tensor_product_abstract/_expand/_commutator`가 안 깨진다. 신규 처리는 base가 `TensorProduct`인 `Pow`로만 좁히고, 아니면 기존대로 `return e` 또는 raise.
4. **함정 회피**: (a) `tensor_product_simp`의 `Pow` 분기만 고치고 `Mul`로 접힌 케이스를 빠뜨리면 `[2]/[6]`(곱→Pow)은 여전히 미평가 → `tensor_product_simp_Mul`에도 Pow 처리를 넣어야 함. (b) `n_nc==1` 분기를 무조건 `return e`로 두면 `x*TP(A,B)**2`가 통과 못 함 → Pow면 헬퍼 호출로 분기. (c) base가 TensorProduct가 아닌 일반 Pow(예: `A**x`, A는 noncommutative symbol)까지 분배하면 잘못이므로 `isinstance(base, TensorProduct)` 가드를 반드시 둘 것.
