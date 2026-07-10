#!/usr/bin/env python3
"""Convert TB report cassettes (result.json → agent_result.metadata.trajectory)
into the trajectory-viewer's bench-trajectory.jsonl record format.

Usage: tb-cassette-to-jsonl.py <run-dir> [<run-dir> ...] > merged.jsonl
Each result.json becomes one viewer instance (instanceId = <run-name>/<task>),
each cassette entry becomes one turn-record; exec previews ride as tool_results
on the next record so the viewer's pairResults() attaches them.

Full-prompt reconstruction: the cassette records only actions/claims, so the
system prompt + instruction turn are rebuilt exactly as brain-mode.ts composes
them — request.system from /tmp/tb-prompts.json (buildSystemPrompt render;
selftest runs get the SELF_TEST_DISCIPLINE suffix, matching the systemSource
seam) and user[0] = TERMINAL_OPERATOR_GUIDE + "# Task" + metadata.instruction
(the brain's turnText). Regenerate /tmp/tb-prompts.json with:
  bun -e 'import {buildSystemPrompt} from "./src/agent/prompt"; ...'  (see git log)
"""
import json, sys, glob, os

PROMPTS = {}
if os.path.exists("/tmp/tb-prompts.json"):
    PROMPTS = json.load(open("/tmp/tb-prompts.json"))

def emit(run_dir):
    run_name = os.path.basename(os.path.normpath(run_dir))
    for f in sorted(glob.glob(os.path.join(run_dir, "**", "result.json"), recursive=True)):
        j = json.load(open(f))
        task = j.get("task_name")
        if not task:
            continue
        traj = ((j.get("agent_result") or {}).get("metadata") or {}).get("trajectory") or []
        if not traj:
            continue
        reward = None
        rw = os.path.join(os.path.dirname(f), "verifier", "reward.txt")
        if os.path.exists(rw):
            reward = open(rw).read().strip()
        inst = f"{run_name}/{task}"
        md = (j.get("agent_result") or {}).get("metadata") or {}
        instruction = md.get("instruction") or j.get("task_id", {}).get("path", task)
        guide = PROMPTS.get("operatorGuide", "")
        turn_text = f"{guide}\n\n# Task\n{instruction}" if guide else instruction
        system = PROMPTS.get(
            "systemSelftest" if "selftest" in run_name else "systemDefault")
        msgs = [{"role": "user", "content": turn_text}]
        pending_result = None  # (tool_use_id, preview) to attach on the next record
        tn = 0
        for e in traj:
            if pending_result:
                msgs.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": pending_result[0],
                     "content": pending_result[1]}]})
                pending_result = None
            meta = {"instanceId": inst, "task": task, "reward": reward}
            if e.get("kind") == "exec":
                tn += 1
                tid = f"t{tn}"
                rec = {"metadata": meta,
                       "request": {"system": system, "messages": list(msgs)},
                       "events": [
                           {"type": "tool_use_start", "id": tid, "name": "container_exec"},
                           {"type": "tool_use_end", "id": tid, "input": {"cmd": e.get("cmd", "")}}]}
                ok = e.get("ok"); ec = e.get("exitCode")
                pending_result = (tid, f"[ok={ok} exit={ec}]\n{e.get('preview', '')}")
                msgs.append({"role": "assistant", "content": [
                    {"type": "tool_use", "id": tid, "name": "container_exec",
                     "input": {"cmd": e.get("cmd", "")}}]})
            else:  # text claim
                rec = {"metadata": meta,
                       "request": {"system": system, "messages": list(msgs)},
                       "events": [{"type": "text_delta", "content": e.get("text", "")}]}
                msgs.append({"role": "assistant", "content": e.get("text", "")})
            print(json.dumps(rec, ensure_ascii=False))

for d in sys.argv[1:]:
    emit(d)
