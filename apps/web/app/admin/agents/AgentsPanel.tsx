'use client';

import { useState } from 'react';
import { api } from '../../_lib/client-api';
import { useAction } from '../../_lib/use-action';
import { holdLabel, taskStatusLabel } from '../../_task/labels';
import {
  useAgents,
  useExternalTools,
  useLead,
  useRunnerChoices,
  useTasksIn,
  useUsage,
} from '../../_task/live';
import type { Agent } from '../../_task/types';
import { AgentCard, LeadCard } from './AgentCard';
import { type AgentBody, AgentForm } from './AgentForm';
import { DeletedAgents } from './DeletedAgents';

const CONFLICT = '이미 바뀐 일꾼이에요. 최신 내용을 다시 읽었어요';

// 에이전트 (2026-11-21 팀 없는 에이전트): 맨 앞에 대표, 그 뒤로 일꾼. 사용량과 한도, 편집, 중지, 재개.
// 대표는 목록(api/agents)에 없어 따로 읽고(useLead), 고치기는 설정 › AI에서 한다.
// 역할 일꾼 (2026-11-28): 서버가 늘 갖추는 일곱 역할이라 화면에서 더하지 않는다 (예전 일꾼은 편집 · 삭제만)
export function AgentsPanel() {
  const agents = useAgents();
  const lead = useLead().data?.lead ?? null;
  const running = useTasksIn('running');
  const waiting = useTasksIn('waiting');
  const usage = useUsage();
  const runners = useRunnerChoices();
  const externalTools = useExternalTools().data?.tools ?? [];
  // 열린 입력 칸: 편집 중인 에이전트의 id
  const [open, setOpen] = useState<string | null>(null);
  // 삭제한 에이전트(휴지통) 칸
  const [trash, setTrash] = useState(false);
  const action = useAction();
  const save = useAction();
  const list = agents.data?.agents;
  const problem = agents.error ?? action.problem;
  /** 모든 일꾼(대표 포함)이 이번 달에 쓴 토큰: 카드마다 그중 몫을 보인다 */
  const total = [...(list ?? []), ...(lead ? [lead] : [])].reduce(
    (all, a) => all + a.usedThisMonth,
    0,
  );

  /** 실행 중이거나 기다리는 작업이 있으면 그 상태 이름 (승인 · 하위 작업 대기를 나눈다) */
  function workOf(agent: Agent): string | null {
    if (running.data?.tasks.some((t) => t.agentId === agent.id)) return taskStatusLabel('running');
    const waits = waiting.data?.tasks.find((t) => t.agentId === agent.id);
    return waits ? taskStatusLabel(waits.status, waits.waitReason) : null;
  }

  /** 쉬기 한도에 닿았으면 그 문구 */
  function hold(agent: Agent): string | null {
    return holdLabel(usage.data?.agents.find((u) => u.id === agent.id));
  }

  function flip(agent: Agent) {
    const paused = agent.status === 'paused';
    void action.run(
      agent.id,
      () =>
        api('POST', `/api/agents/${agent.id}/${paused ? 'resume' : 'pause'}`, {
          version: agent.version,
        }),
      {
        done: `${agent.name} ${paused ? '재개됨' : '중지됨'}`,
        reload: agents.reload,
        conflict: CONFLICT,
      },
    );
  }

  /** 휴지통으로. 작업 기록은 남고 복원하면 다시 일을 받는다 */
  function remove(agent: Agent) {
    if (
      !window.confirm(
        `${agent.name}을(를) 삭제할까요? 작업 기록은 남고 휴지통에서 복원할 수 있어요`,
      )
    )
      return;
    void action.run(
      agent.id,
      () => api('POST', `/api/agents/${agent.id}/delete`, { version: agent.version }),
      { done: `${agent.name} 삭제됨`, reload: agents.reload, conflict: CONFLICT },
    );
  }

  /** 입력 칸을 열거나 닫는다. 앞 폼의 오류 문구는 남기지 않는다 */
  function show(next: string | null) {
    setOpen(next);
    save.clear();
  }

  // 저장은 패널이 돌린다 (폼은 칸만). 고치기는 본 version을 붙인다
  async function submit(target: Agent, body: AgentBody) {
    const reply = await save.run(
      'save',
      () => api('PATCH', `/api/agents/${target.id}`, { ...body, version: target.version }),
      {
        done: '일꾼 저장됨',
        reload: agents.reload,
        conflict: '이미 바뀐 일꾼이에요. 다시 저장하면 입력한 내용으로 덮어요',
      },
    );
    if (!reply?.ok) return;
    setOpen(null);
    // 한도를 바꾸면 쉬는지도 바뀐다. 이 저장에는 사용량 신호가 없다
    await usage.reload();
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>일꾼</h1>
          <p>
            대화는 대표가 받아 역할 일꾼(기획자 · 리서처 · 작가 · 디자이너 · 개발자 · 검토자 ·
            브라우저 담당)에게 나눠 맡겨요
          </p>
        </div>
        {list && list.length > 0 && (
          <div className="row">
            <button type="button" className="ghost" onClick={() => setTrash(!trash)}>
              휴지통
            </button>
          </div>
        )}
      </header>
      {problem && <p className="error">{problem}</p>}
      {trash && <DeletedAgents onRestored={agents.reload} onClose={() => setTrash(false)} />}
      {list === undefined ? (
        !agents.error && <p className="label-mono loading">불러오는 중…</p>
      ) : list.length === 0 ? (
        <>
          {lead && <LeadCard lead={lead} work={workOf(lead)} hold={hold(lead)} total={total} />}
          <div className="panel">
            <b>일꾼 없음</b>
            <p className="note">대화를 처음 열면 대표와 역할 일꾼이 함께 생겨요</p>
          </div>
        </>
      ) : (
        <div className="agents">
          {lead && <LeadCard lead={lead} work={workOf(lead)} hold={hold(lead)} total={total} />}
          {list.map((a) =>
            open === a.id ? (
              <AgentForm
                key={a.id}
                agent={a}
                agents={list}
                runners={runners}
                externalTools={externalTools}
                busy={save.busy !== null}
                problem={save.problem}
                onSubmit={(body) => submit(a, body)}
                onClear={save.clear}
                onClose={() => show(null)}
              />
            ) : (
              <AgentCard
                key={a.id}
                agent={a}
                work={workOf(a)}
                hold={hold(a)}
                total={total}
                score={usage.data?.agents.find((u) => u.id === a.id)?.scorecard ?? null}
                runner={
                  a.runnerId ? (runners.find((r) => r.runner.id === a.runnerId) ?? null) : undefined
                }
                busy={action.busy === a.id}
                onFlip={() => flip(a)}
                onEdit={() => show(a.id)}
                onRemove={() => remove(a)}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}
