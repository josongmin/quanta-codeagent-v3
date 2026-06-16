---
instance_id: sympy__sympy-15976
repo: sympy/sympy
base_commit: 701441853569d370506514083b995d11f9a130bd
version: "1.4"
difficulty: "15 min - 1 hour"
created_at: "2019-02-13T15:02:37Z"
fail_to_pass: 1
pass_to_pass: 37
gold_files: [sympy/printing/mathml.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
Symbol 이름에 숫자/첨자가 들어간 경우(`x2`, `x_2`, `x^2` 등) MathML presentation 프린터가 깨진 마크업을 낸다. 이슈 본문에 재현 코드와 함께 정확한 원인 마크업이 적혀 있다: `<mi><msub><mi>x</mi><mi>2</mi></msub></mi>` 처럼 `<msub>`(아래첨자) 구조를 바깥 `<mi>` 로 한 번 더 감싸고 있다. Safari는 이 중첩된 `<mi>` 안의 첨자 구조를 무시해 심볼이 통째로 사라진다. 정상 마크업은 바깥 `<mi>` 가 없는 `<msub><mi>x</mi><mi>2</mi></msub>` 다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 파일을 직접 지목하진 않으나, "MathML presentation 프린터 + 잘못된 `<mi>` 중첩"이라는 신호가 매우 강하다. `sympy/printing/mathml.py` 의 `_print_Symbol`(MathMLPresentationPrinter) 로 키워드 수렴이 한 방에 된다. content vs presentation 두 프린터가 있어 약간의 분별만 필요.
- **S1 (Direct-Map) + S6**: 이슈가 사실상 픽스를 명세한다("바깥 `<mi>` 쌍을 제거하면 된다"). 다만 단순 한 줄 삭제가 아니라, 미리 만들어 둔 `x = createElement('mi')` 래퍼에 자식을 `appendChild` 하던 구조를 "`x` 자체를 첨자 노드로 만든다"로 작은 재배치(S6)를 해야 한다 — bold 속성 부여도 함께 이동.
- **K-Domain**: MathML 엘리먼트 의미론(`mi`/`msub`/`msup`/`msubsup`/`mrow`)과 sympy 프린터의 DOM 빌드 관례를 알아야 올바른 트리를 짠다. 일반 파이썬 추론만으론 정답 트리 모양을 확정 못 함.
- **primary = T-DirectMap**: 위치가 좁고(L1) 결함 클래스가 "불필요한 래퍼 노드 제거"로 정형적이며, 이슈가 기대 출력까지 적어줘 픽스 매핑이 기계적이다.

## 난이도 티어
**T2 (쉬움)**. 구조 피처: 단일 파일·단일 함수(`_print_Symbol`), 골드 ~30줄이지만 실질 변경은 "래퍼 제거 + 변수 재배치 + bold 이동"의 1가지 아이디어. **has-repro** 가 가장 강한 easiness 신호이고 이슈에 정답 마크업까지 명시돼 있다. 다만 T1이 아닌 이유: (1) content/presentation 두 프린터 분별이 필요, (2) `msub`/`msup`/`msubsup`/plain 4-분기를 **모두** 일관되게 고쳐야 하고 bold 속성을 끝으로 옮기는 재배치가 있어 한 줄 삭제로 끝나지 않음, (3) **regression-trap** — P2P 37개가 인접 프린터 동작을 광범위하게 검증한다. 공식 라벨(15분~1시간)과 일치.

## 골드패치 분석
- **파일·함수**: `sympy/printing/mathml.py`, `MathMLPresentationPrinter._print_Symbol`.
- **근본원인**: 함수 진입부에서 `x = self.dom.createElement('mi')` 로 항상 바깥 `<mi>` 컨테이너를 만들고, 첨자 유무에 따라 만든 `msub`/`msup`/`msubsup` 노드를 그 `x` 의 **자식으로 appendChild** 했다. 그 결과 첨자가 있는 심볼은 `<mi><msub>...</msub></mi>` 처럼 의미상 잘못된(스칼라 identifier 안에 첨자 구조가 든) 트리가 되어, 엄격한 렌더러(Safari)에서 깨진다.
- **수정요지**: 진입부의 `x = createElement('mi')` 와 bold 분기를 제거하고, 4-분기 각각에서 `x` 를 **결과 노드 자체로 대입**한다 — 첨자 없음이면 `x = mname`, sub만이면 `x = createElement('msub')`, sup만이면 `'msup'`, 둘 다면 `'msubsup'`. 그리고 `style == 'bold'` 일 때 `mathvariant='bold'` 를 **최종 `x` 에** 마지막에 부여하도록 끝으로 옮긴다(어느 분기든 올바른 루트 노드에 bold가 걸리게 됨).

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_presentation_symbol`** (1개). 테스트는 `x^2`/`x__2`/`x_2`/`x^3_2`/`x__3_2`/`x_2_a`/`x^2^a`/`x__2__a` 각각에 대해 `mml.nodeName` 이 더 이상 `'mi'` 가 **아니라** `'msup'`/`'msub'`/`'msubsup'` 임을, 그리고 첫째 자식이 `mi`("x")임을 단언한다. 즉 바깥 `<mi>` 래퍼가 사라지고 첨자 노드가 루트로 올라온 것을 직접 증명한다(`childNodes[0].childNodes[0]` → `childNodes[0]` 으로 경로가 한 단계 얕아짐).
- **overfit 관점**: FAIL_TO_PASS는 1 테스트지만 내부에 8가지 첨자 조합을 전수 단언하므로 special-case 통과가 어렵다. 4-분기를 일관되게 안 고치면 일부 케이스에서 실패 → overfit 위험 낮음.
- **regression 관점**: P2P 37개에 `test_content_symbol`, `test_presentation_*` 군, `test_print_matrix_symbol`, `test_root_notation_print` 가 포함. content 프린터(`MathMLContentPrinter`)는 건드리지 않아야 하고, plain(첨자 없음) 심볼 경로(`x = mname`)와 bold 속성이 그대로 유지돼야 한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "MathML presentation" + 첨부된 깨진 마크업 `<mi><msub>...</msub></mi>` → `mathml.py` 에서 `mi` 와 `msub`/`msup`/`msubsup` 를 함께 만드는 곳을 grep → `MathMLPresentationPrinter._print_Symbol` 로 직행(content 프린터는 마크업 형태가 달라 배제).
2. **픽스와 일반화**: 잘못된 불변식은 "심볼은 항상 `mi` 루트"라는 가정. 올바른 일반화는 "루트 노드 = 첨자 유무에 따른 최외곽 구조 노드"다. 그래서 4-분기 각각이 자기 루트(`mname`/`msub`/`msup`/`msubsup`)를 `x` 로 직접 돌려준다. 이는 특정 입력이 아니라 **모든 첨자 조합**에 대해 동일 원리로 동작하므로 overfit이 아니다.
3. **regression 안전**: bold 부여를 분기 뒤 단일 지점으로 옮긴 게 핵심 — 이전엔 항상 바깥 `mi` 에 bold가 걸렸는데, 래퍼를 없앤 뒤에도 어느 루트든 bold가 정확히 한 번 걸리게 보존된다. content 프린터·plain 심볼·matrix symbol 경로를 손대지 않아 P2P 37개가 유지된다.
4. **함정 회피**: (a) 바깥 `<mi>` 만 무지성으로 지우고 4-분기 중 일부(예: `msubsup`)를 빠뜨리면 `x^3_2` 케이스에서 실패 — 분기 전수 수정이 필요. (b) bold 분기를 진입부에 둔 채 `x` 를 재대입하면 bold 설정이 버려진다 → 끝으로 이동이 필수. (c) `MathMLContentPrinter._print_Symbol` 까지 같이 고치면 content P2P 회귀. presentation만 정밀 타격해야 한다.
