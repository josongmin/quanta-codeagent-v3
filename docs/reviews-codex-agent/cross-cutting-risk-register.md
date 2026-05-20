# Cross-Cutting Risk Register

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 문서는 `/docs/analysis/codex-agent/` 아래 전체 분석 문서를 가로지르는 공통 리스크를 모은다.

목적:
- 개별 문서의 local caveat가 아니라
- 전체 agent 모델을 잘못 이해할 때 생기는 공통 failure mode를 모아 둔다

표기:
- `P0`: silent corruption / dangerous authorization or consent breach / false completion
- `P1`: major model distortion leading to wrong execution path
- `P2`: efficiency/collaboration degradation
- `P3`: minor interpretive drift

---

## 1. Risk register

| ID | Risk | Severity | Why it matters | Primary docs |
| --- | --- | --- | --- | --- |
| RISK-01 | `tool visible == action allowed`로 오해 | P1 | mode, approval, HITL, repo-local boundary를 놓침 | permission, sandbox, hitl, tool inventory |
| RISK-02 | `approval == consent`로 오해 | P0 | approval rail과 HITL rail을 혼동하면 민감 action 무단 실행 위험 | permission, hitl |
| RISK-03 | `Default mode == no questions ever`로 오해 | P2 | risky/undiscoverable case를 놓침 | mode/process |
| RISK-04 | `Plan mode == just longer planning text`로 오해 | P1 | structured branch-control 기능을 놓침 | mode/process |
| RISK-05 | `grep=0 == correctness`로 오해 | P1 | semantic closeout과 문자열 closeout 혼동 | judgment, execution loop |
| RISK-06 | `patch preferred == patch always`로 오해 | P1 | unstable file에서 partial landing 유발 | execution loop, budget |
| RISK-07 | `current session facts == all Codex deployments`로 일반화 | P1 | sandbox/plugin/mode/tool behavior를 과잉 일반화 | unknowns, sandbox, plugin |
| RISK-08 | hidden typed router/planner 존재를 단정 | P2 | 분석 문서를 사실 문서처럼 오용 | unknowns, loop deep dive |
| RISK-09 | artifact를 memory substrate로 보지 않음 | P1 | 장기 상태 externalization 설계를 놓침 | memory |
| RISK-10 | current replay/cassette path를 완전 authority로 과신 | P0 | placeholder validator 때문에 false determinism claim 가능 | record/replay |

---

## 2. Common mis-modeling clusters

### Cluster A: permission collapse

증상:
- sandbox만 보면 permission 다 안다고 생각

실제 누락:
- approval
- HITL
- mode
- repo-local op boundary

영향:
- wrong action path
- unauthorized action

---

### Cluster B: reasoning collapse

증상:
- “LLM이 다 알아서” 혹은 “hard router가 다 한다” 둘 중 하나로 단순화

실제:
- constraint-bounded routing model이 더 적합

영향:
- mode/tool/policy interaction 설명 실패

---

### Cluster C: memory collapse

증상:
- memory를 either “없다” or “global database다”로 이해

실제:
- policy/thread/working/artifact/subagent memory 조합이 더 적합

영향:
- state continuity 설계 오류

---

### Cluster D: validation collapse

증상:
- validation 안 했으면 아무 근거가 없다
- 혹은 validation 안 했는데 끝난 것처럼 본다

실제:
- validation budget + honesty rail 조합

영향:
- false confidence
- collaboration mismatch

---

## 3. Mitigations

1. 항상 `FACT`와 `STRONG-INFERENCE`를 분리해서 읽기
2. current session contract와 platform-wide generalization을 분리하기
3. permission을 단일 축으로 보지 말기
4. replay/cassette는 format completeness와 replay proof completeness를 분리하기
5. mode 차이를 prose style이 아니라 interaction contract 차이로 읽기
6. unknowns 문서를 함께 참조하기

---

## 4. Safe reading order

이 디렉터리 문서를 안전하게 읽는 순서:

1. [direct-observable-facts.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/direct-observable-facts.md)
2. [unknowns-and-non-claims.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/unknowns-and-non-claims.md)
3. [prompt-and-policy-stack.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/prompt-and-policy-stack.md)
4. [execution-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/execution-loop.md)
5. task-specific audits

---

## 5. Most important warning

이 디렉터리의 분석은 “현재 세션에서 보이는 Codex agent contract”에 대한 고해상도 모델이다.

따라서:
- 구현 상세를 hidden source처럼 읽으면 안 되고
- 현재 세션의 visible evidence와 non-claims를 같이 봐야 한다.
