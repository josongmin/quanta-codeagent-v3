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

---

## Round 2 update (2026-05-21 deep dive)

이 라운드는 실제 설치된 `Codex.app` (build 2867) entitlements / IPC channel / Skybridge MCP UI protocol / plugin bundles / on-disk state를 직접 관측하면서 추가로 식별된 **system-level risk**를 누적한다.

§1의 P0/P1/P2/P3 분류는 그대로 유지하되, Round 2는 system-platform 차원의 risk이므로 `Critical / High / Medium / Low` severity로 별도 묶었다. §1과는 다른 축이므로 ID는 `RISK-R2-*`로 분리한다.

### 6. Round 2 risk register

| ID | Risk | Severity | Evidence |
|---|---|---|---|
| RISK-R2-01 | Unsandboxed Electron host + JIT + unsigned executable memory allowed | Critical | `Codex.app` entitlements file (`app-sandbox=false`, `cs.allow-jit=true`, `cs.allow-unsigned-executable-memory=true`) |
| RISK-R2-02 | `runWidgetCode` Skybridge port + `setAdditionalGlobals` accept arbitrary code/globals; security depends on host allowlist not visible in renderer | Critical | `sandbox-preload.js` protocol surface |
| RISK-R2-03 | `upload-local-file-over-sftp` IPC enables arbitrary egress | Critical | IPC channel inventory (378 channels) |
| RISK-R2-04 | `codex_chronicle` continuous screen capture after a single user permission grant | High | `codex_chronicle` 4.3 MB binary + `~/.codex/memories/extensions/chronicle/resources/` (1,390 summary files, 39.8 MB) |
| RISK-R2-05 | 14.8 GB local `logs_2.sqlite` audit trail (forensic exposure) | High | observed file size on disk |
| RISK-R2-06 | `bare-modifier-monitor` global modifier-key hook process | Medium | Swift binary (150 KB) and string analysis |
| RISK-R2-07 | Vendored `browser-use` library + Chromium plugin auto-install | Medium | `package.json` (`browser-api`, `browser-backend-common`, `browser-common`) + bundled `chrome` plugin |
| RISK-R2-08 | 378 IPC channels — sender validation consistency hard to verify in minified bundles | Medium | bundle audit |
| RISK-R2-09 | `claude-code-import` IPC reads `~/.claude/` including auth | Medium | IPC channel inventory |
| RISK-R2-10 | `NSAllowsArbitraryLoads=true` (cleartext HTTP permitted at platform layer) | Low | `Info.plist`; network policy is assumed to be enforced in Rust core, but not directly observed |

### 7. Round 2 cross-cutting observations

- Round 1의 RISK-01~10이 주로 contract / model-of-behavior level이었던 반면, Round 2는 host-OS attack surface level이다. 즉 두 라운드는 직교한다.
- Round 2 위험은 Codex 사용자가 desktop app을 install하는 것 자체로 incurred되는 ambient risk이며, agent action 여부와 무관하게 존재한다.
- 비교 안전 강도:
  - RISK-R2-01~03: 직접 exploitable한 IPC/preload surface가 있다는 사실 자체로 Critical
  - RISK-R2-04~05: privacy/forensic exposure이지 즉시 RCE는 아니므로 High
  - RISK-R2-06~09: feature/구조적 위험, allowlist/host-policy에 따라 변동되므로 Medium
  - RISK-R2-10: platform setting이며 Rust core가 enforcement를 갖고 있을 것이라 가정해 Low

### 8. Most important Round 2 warning

- Round 2 risk는 "agent가 잘못된 의사결정을 내릴 위험"이 아니라 **"앱 자체의 host-level capability가 사용자/시스템에 노출하는 위험"**이다.
- 따라서 mitigations §3의 항목과는 별도로, system-level mitigation (entitlements review, IPC allowlist, MCP server allowlist, retention policy, telemetry transparency)이 함께 검토돼야 한다.
