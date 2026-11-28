import Link from 'next/link';
import { actionLabel, EFFORT_LABELS, engineLabel, tokens } from '../../_task/labels';
import { type RunnerChoice, useEngines } from '../../_task/live';
import { AgentUsage } from '../../_task/parts';
import type { Agent, UsageAgent } from '../../_task/types';
import { Icon } from '../../_ui/Icon';
import { SETTINGS_HREF } from '../menu';

/** 성적표 한 줄 (2026-11-20): 셀 것이 없으면 null */
function scoreLine(card: UsageAgent['scorecard']): string | null {
  if (!card) return null;
  const parts = [
    card.judged > 0 ? `첫 판정 통과 ${card.firstPass}/${card.judged}` : '',
    card.avgFixes !== null ? `평균 고친 횟수 ${card.avgFixes}` : '',
    card.decided > 0 ? `반려 · 수정 요청 ${card.sentBack}/${card.decided}` : '',
    card.tokensPerDone !== null ? `일 하나에 ${tokens(card.tokensPerDone)} 토큰` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `최근 ${card.days}일 · ${parts.join(' · ')}` : null;
}

/** 카드 머리: 첫 글자 · 이름 · 도구와 모델 · 지금 상태. 상태 점은 채움(일하는 중) · 반(쉬기 한도에 닿음) · 빈 점(멈춤 · 일 없음) */
function CardTop({
  agent,
  name,
  extra,
  work,
  hold,
}: {
  agent: Agent;
  name: string;
  extra: string | null;
  work: string | null;
  hold: string | null;
}) {
  const engines = useEngines();
  const paused = agent.status === 'paused';
  // 일이 없는 것은 "대기 중": "쉬는 중"은 한도에 닿아 새 일을 받지 않는 것(hold)에만 쓴다
  const state = paused ? '멈춤' : (hold ?? work ?? '대기 중');
  const dot = paused || (!hold && !work) ? 'dot off' : hold ? 'dot half' : 'dot run';
  const tuning = [
    agent.preset ? '기본 역할' : null,
    engineLabel(engines, agent.tool),
    agent.model || null,
    agent.effort ? `생각 ${EFFORT_LABELS[agent.effort] ?? agent.effort}` : null,
    extra,
  ];
  return (
    <div className="agent-top">
      <span className="agent-mark" aria-hidden="true">
        {name.slice(0, 1)}
      </span>
      <div className="item-main">
        <b>{name}</b>
        <small>{tuning.filter(Boolean).join(' · ')}</small>
      </div>
      <span className="state">
        <span className={dot} aria-hidden="true" />
        {state}
      </span>
    </div>
  );
}

// 에이전트 화면의 대표 카드 (맨 앞): 대화를 받아 일꾼에게 맡긴다. 고치기는 설정 › AI에서
export function LeadCard({
  lead,
  work,
  hold,
  total,
}: {
  lead: Agent;
  work: string | null;
  hold: string | null;
  /** 모든 일꾼이 이번 달에 쓴 토큰 (몫을 보이는 데) */
  total: number;
}) {
  return (
    <article className="agent" aria-label={`대표 ${lead.name}`}>
      <CardTop agent={lead} name={`${lead.name} · 대표`} extra={null} work={work} hold={hold} />
      <p className="agent-role clamp">대화를 받아 일꾼에게 맡기고 결과를 모아 답해요</p>
      <AgentUsage agent={lead} total={total} />
      <div className="agent-acts">
        <Link className="text-button" href={SETTINGS_HREF}>
          편집 (설정 › AI)
        </Link>
      </div>
    </article>
  );
}

// 에이전트 화면의 일꾼 카드 한 장: 이름 · 도구와 모델 · 지금 상태, 역할, 승인 동작 · 커넥터 칩, 사용량, 동작.
// 권한은 모든 일꾼이 같아(전부) 보이지 않는다 (2026-11-21)
export function AgentCard({
  agent,
  work,
  hold,
  total,
  score = null,
  runner,
  busy,
  onFlip,
  onEdit,
  onRemove,
}: {
  agent: Agent;
  work: string | null;
  hold: string | null;
  /** 모든 일꾼이 이번 달에 쓴 토큰 (몫을 보이는 데) */
  total: number;
  /** 최근 성적표 (사용량 API, 2026-11-20) */
  score?: UsageAgent['scorecard'];
  /** 묶인 러너 (undefined: 아무 러너, null: 묶였지만 그 러너의 기기가 끊김) */
  runner?: RunnerChoice | null;
  busy: boolean;
  onFlip: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const paused = agent.status === 'paused';
  const chips = agent.externalTools.length + agent.approvalActions.length;
  return (
    <article className="agent" aria-label={agent.name}>
      <CardTop
        agent={agent}
        name={agent.name}
        extra={runner === undefined ? null : `실행: ${runnerLabel(runner)}`}
        work={work}
        hold={hold}
      />
      {agent.role && <p className="agent-role clamp">{agent.role}</p>}
      {chips > 0 && (
        <ul className="perm" aria-label="커넥터 · 승인 동작">
          {agent.externalTools.map((t) => (
            <li key={t}>
              <Icon name="plug" />
              {t}
            </li>
          ))}
          {agent.approvalActions.map((a) => (
            <li key={a} className="gate">
              {actionLabel(a)} · 승인 필요
            </li>
          ))}
        </ul>
      )}
      <AgentUsage agent={agent} total={total} />
      {scoreLine(score) && <small className="agent-score">{scoreLine(score)}</small>}
      <div className="agent-acts">
        <button type="button" className="text-button" onClick={onEdit}>
          편집
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={onFlip}>
          {paused ? '다시 시작' : '멈추기'}
        </button>
        <Link className="text-button" href={`/admin/schedules?agent=${agent.id}`}>
          {agent.schedules > 0 ? `스케줄 ${agent.schedules}개` : '스케줄 추가'}
        </Link>
        <span className="grow" />
        {/* 역할 일꾼은 지우지 않는다 (2026-11-28): 서버가 늘 갖춘다 */}
        {!agent.preset && (
          <button type="button" className="text-button" disabled={busy} onClick={onRemove}>
            삭제
          </button>
        )}
      </div>
    </article>
  );
}

/** 묶인 러너의 이름과 연결 상태. 기기를 끊었으면 그 러너는 일을 빌리지 못해 일이 기다린다 */
function runnerLabel(runner: RunnerChoice | null): string {
  if (!runner) return '연결 끊긴 러너 (일이 기다려요)';
  return runner.runner.online ? runner.device.name : `${runner.device.name} (연결 안 됨)`;
}
