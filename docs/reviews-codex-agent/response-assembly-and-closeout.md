# Codex Response Assembly And Closeout

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 문서는 Codex agent loop에서 `최종 응답 조립`과 `closeout honesty rail`만 따로 정리한다.

목표:
- final answer를 loop의 마지막 판단 단계로 본다
- 어떤 claim을 남기고 어떤 claim을 버리는지 정한다
- verification 미실행, partial landing, blocked rail을 어떻게 보고하는지 고정한다
- task kind별 reporting shape를 정리한다

관련 문서:
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)
- [execution-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/execution-loop.md)
- [prompt-and-policy-stack.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/prompt-and-policy-stack.md)
- [unknowns-and-non-claims.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/unknowns-and-non-claims.md)

주의:
- 이 문서는 app renderer의 exact hidden implementation을 주장하지 않는다.
- 아래 closeout lens는 observed behavior를 가장 잘 설명하는 best-fit model이다.

## 1. Final answer as last loop step

최종 응답은 단순 출력 포맷팅이 아니다.

- 무엇을 claim해도 되는지
- 무엇은 partial인지
- 어떤 불확실성을 남겨야 하는지
- 어떤 evidence만 최종 답변에 올릴지

를 여기서 닫는다.

개념적으로는 아래와 같다. `[MODEL]`

```python
def assemble_final_response(ctx, working_state, evidence):
    shape = choose_reporting_shape(ctx, working_state)
    claims = keep_only_defended_claims(evidence, ctx)
    uncertainty = collect_remaining_uncertainty(working_state, ctx)
    skipped_validation = render_skipped_verification_if_any(working_state, ctx)

    return render_response(
        shape=shape,
        claims=claims,
        uncertainty=uncertainty,
        skipped_validation=skipped_validation,
    )
```

## 2. Closeout inputs

최종 응답 조립에는 보통 이 입력이 들어간다.

| Input | Role | Class |
| --- | --- | --- |
| source truth | owner, contract, actual changed behavior | `[FACT]` once read |
| runtime or build or test result | verification truth, blocker class | `[FACT]` once run |
| working state | selected owner, open blockers, deferred surfaces | `[MODEL]` as state scaffold |
| repo-local rules | reporting language, canonical rail, prohibited overclaim | `[FACT]` |
| user-requested output shape | review-first, plan-first, concise, cited | `[FACT]` |

## 3. Reporting shape by task kind

| Task kind | Typical answer shape |
| --- | --- |
| stable knowledge | short direct explanation |
| research | cited answer with links and dates if needed |
| local code inspection | concise explanation with file references |
| code modification | what changed, why, what was not verified |
| review | findings first, file/line/risk/impact |
| audit | contract vs truth mismatch summary |
| visual or browser | observed behavior and relevant screenshot or result |
| delegation | integrated result plus unresolved side-task risk |

핵심:

- task kind이 달라지면 evidence가 아니라 `정리 순서`가 달라진다
- review에서는 구현 설명보다 finding ordering이 먼저다
- code modification에서는 patch claim과 verification claim을 분리한다

## 4. Defended-claim filtering

최종 응답에는 `읽은 것`, `실행한 것`, `직접 관측한 것`만 남긴다.

필터 규칙:

1. source를 안 읽었으면 owner truth로 승격하지 않는다
2. verification을 안 돌렸으면 green이라고 말하지 않는다
3. grep hit만으로 unused나 complete를 닫지 않는다
4. stale docs나 memory는 routing hint로만 쓰고 proof로는 내리지 않는다

실전적으로는 이 함수가 핵심이다. `[MODEL]`

```python
def keep_only_defended_claims(evidence, ctx):
    claims = []
    for item in evidence:
        if item.is_directly_observed or item.is_source_backed or item.is_verified:
            claims.append(item)
    return claims
```

## 5. Verification disclosure

verification은 항상 도는 것이 아니다. 그래서 closeout은 `했는지`, `안 했는지`, `왜 안 했는지`를 분리해서 말해야 한다.

| Verification state | Required wording discipline |
| --- | --- |
| executed and green | command, rail, verdict를 남긴다 |
| executed and red | rail, blocker, failure class를 남긴다 |
| not requested | 미실행 사실을 남긴다 |
| blocked | blocker surface와 현재 evidence boundary를 남긴다 |

reporting scaffold: `[MODEL]`

```text
VerificationCloseout {
  performed: bool,
  rail: optional string,
  verdict: optional string,
  failure_class: optional string,
  reason_if_skipped: optional string,
}
```

## 6. Partial versus complete wording

partial과 complete는 구조적으로 다르게 써야 한다.

`complete`:
- intended owner surface가 닫혔다
- verification claim을 뒷받침하는 rail이 있다
- residual blocker가 closeout claim을 직접 부정하지 않는다

`partial`:
- patch는 landed 했지만 intended rail이 미실행 또는 blocked
- owner seam은 좁아졌지만 residue contract가 남아 있다
- wrong rail만 green이고 intended rail은 아직 열리지 않았다

금지:

- partial landing을 complete처럼 포장
- scope 밖 green을 current batch proof로 승격
- unrelated blocker를 숨기고 merge-ready처럼 표현

## 7. Evidence shaping

최종 답변에 실리는 evidence는 raw dump가 아니라 압축된 defended summary다.

| Raw signal | Final-answer shape |
| --- | --- |
| long file read | file path + 핵심 owner 설명 |
| long log | failing symbol, failing rail, root-cause summary |
| semantic payload | owner file, type, references count, blast-radius note |
| grep output | candidate distribution or residue count only |
| browser observation | visible regression summary and target page |

핵심:

- raw payload를 그대로 붙이는 게 아니라 closeout에 필요한 최소 정보만 남긴다
- evidence shaping은 요약 행위지만 claim 약화를 허용하지 않는다

## 8. Closeout honesty rail

최종 closeout에서 특히 강한 규칙:

- 안 읽은 surface를 읽은 것처럼 말하지 않기
- 안 돌린 verification을 돌린 것처럼 말하지 않기
- partial work를 complete라고 말하지 않기
- weak signal을 hard proof처럼 말하지 않기

이건 스타일 규칙이 아니라 correctness 규칙이다.

## 9. Common failure modes

| Failure mode | What breaks | Typical mitigation |
| --- | --- | --- |
| wrong rail green | closeout overclaim | report intended rail separately |
| grep-only closure | false proof of unused or complete | require source or runtime corroboration |
| stale memory routed as fact | incorrect current-state claim | downgrade memory and restate source truth |
| patch-only closeout | landed diff treated as correctness proof | separate edit success from verification success |
| broad summary drift | polished answer hides blocker | keep blocker list explicit |

## 10. Rule of thumb

- final answer는 loop 밖 장식이 아니라 loop의 마지막 판단 단계다
- reporting shape는 task kind에 따라 달라져도 honesty rail은 바뀌지 않는다
- verification이 비어 있으면 그 빈칸을 그대로 보여줘야 한다
- closeout은 “무엇이 증명됐는가”와 “무엇이 아직 안 닫혔는가”를 동시에 말해야 한다
