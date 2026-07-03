# Phase 4 — capability profiles (비용·결정론 안전판)

어딧 A·E·F 해소. **"오지게"의 나머지 절반.**

## 기능 / 왜

- (기능) `profile: "read-only" | "analysis" | "full"` 한 노브로 (1) mode 레버 조합 (2) optional wire-slot on/off 결정.
- (왜) 기성 mode가 repo-분석에 안 맞음(어딧 E: headless=single-turn, batch=net denied). wire-slot 기본 OFF지만 full은 조립 필요(어딧 A). 세션끝 distill 콜 차단(어딧 F).

## ⚠️ 아키텍처 발견 (실독, Phase 4 계획 정정)

**커스텀 레버 조합은 불가능하다.** `assembleAgentConfig`가 [`modePolicy = MODE_PRESETS[req.mode]`로 하드코딩](../../../src/host/runtime/agent-config-assembler.ts)(주입 훅 없음)하고, [`assertModeMatrix`](../../../src/agent/run-mode/narrow.ts)가 12레버 전부 프리셋과 정확히 일치하도록 강제. 즉 "batch mode인데 network만 open" 같은 조합은 매트릭스 위반. **프로파일은 기존 모드를 고르는 것이지 레버를 섞는 게 아니다.**

→ 두 경로:
- **A(contained, 추천):** 프로파일→기존 모드 매핑 + read-only는 registry 필터(mutating 도구 제거, mode와 독립). analysis=`batch`(멀티턴 verdict, **net denied**, snapshot-only). 순수 static 분석(파일 read/grep/dep-graph)엔 net denied가 오히려 안전 → 충분. **코어 무변경, 전부 sdk/ additive.**
- **B(정확, heavier):** run-mode 매트릭스에 `analysis` 모드 신설(net open + verdict 멀티턴). blast radius ~5-6 코어 파일: `AgentMode` union + `ALL_AGENT_MODES`(컴파일 assert) + `MODE_PRESETS` + `BUDGET_PRESETS` + subagent-typed `Record<AgentMode>` 2 + 일부 switch. **매트릭스 SSOT 수정.**

판단 기준: 분석 에이전트가 **네트워크(dep 설치/외부 API)가 필요하면 B**, 순수 static이면 **A로 충분**(measure-first: 투기적으로 코어 모드 추가 금지).

## 확정 필요 (구현 전 1개)

`analysis` 레버 조합 (A 채택 시 batch 매핑으로 자동 확정) — 아래는 B 채택 시 신설 모드값:

| profile | termination | permission | network | gitWrite | wire-slots |
|---|---|---|---|---|---|
| read-only | verdict | auto, **mutating 도구 차단** | denied | none | 전부 OFF |
| **analysis(기본)** | verdict(멀티턴) | auto/acceptEdits | **open** | snapshot-only | 전부 OFF |
| full | verdict | auto/acceptEdits | allowlist | branch-only | memory·subagent·MCP ON |

## Tasks

4.1 **프로파일→레버 매핑** `src/sdk/profiles.ts` — 기성 `MODE_PRESETS[batch]` baseline에서 `LEVER_FIELDS`로 `narrowMode` override(`@/agent/run-mode`). read-only는 mutating toolSurface 제거.
4.2 **wire-slot 게이팅** — read-only/analysis는 `memoryConsolidator/subagentBackground/autoBackground/…` 전부 미주입. `runAgent` 리턴을 붙잡는 [세션끝 consolidator](../../../src/agent/loop/entry.ts) 미배선 확인(어딧 F).
4.3 **full 조립 헬퍼** — memory/subagent/MCP를 켠 base 조립(bootstrapSession의 buildTooling/loadFeatures 재사용 or 경량 재구현). Phase 8 이후 착수 가능(분석 유스케이스는 analysis로 충분).

## Hellgate

- RED: `profiles.test.ts` — 각 프로파일이 기대 modePolicy 레버 + wire-slot 부재/존재 assert.
- 적대 어딧 R1-3: (a) read-only가 실제로 파일 mutate 도구를 막는지(정책만 아니라 registry 필터), (b) analysis가 net 여는지, (c) analysis에 memory-slot 안 새는지(비용 회귀), (d) narrowMode 매트릭스 위반(batch+reviewer-backed류) 없음.

## Acceptance

- [ ] read-only 세션이 Edit/Write 시도 시 거부.
- [ ] analysis 세션 종료 시 memory-distill LLM 콜 0(계측/스파이).
- [ ] `assertModeMatrix` green.

## Files

- `src/sdk/profiles.ts` (신설), `src/sdk/embed.ts` (프로파일 소비)
- `tests/unit/sdk/profiles.test.ts` (신설)
