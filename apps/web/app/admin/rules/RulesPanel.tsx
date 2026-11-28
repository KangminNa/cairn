'use client';

import { useApps } from '../../_blog/live';
import { api } from '../../_lib/client-api';
import { useAction } from '../../_lib/use-action';
import { when } from '../../_task/labels';
import { useAgents, useRules } from '../../_task/live';
import type { Rule } from '../../_task/types';

const CONFLICT = '이미 바뀐 규칙이에요. 최신 내용을 다시 읽었어요';

// 배운 규칙 (2026-11-28, ACE의 규칙 목록): 관리자의 수정 요청에서 대표가 배워 제안하고 승인한 규칙.
// 일꾼은 맞는 규칙을 지시문에서 받고, 검토 통과는 도움 · 관리자의 수정 요청은 해로움으로 센다.
// 만들기 · 고치기 · 합치기는 대화의 승인으로만, 내리기 · 되살리기는 여기서 바로 (사람이 정한 것)
export function RulesPanel() {
  const rules = useRules();
  const agents = useAgents().data?.agents ?? [];
  const apps = useApps().data?.apps ?? [];
  const action = useAction();
  const list = rules.data?.rules;
  const active = list?.filter((r) => r.status === 'active') ?? [];
  const retired = list?.filter((r) => r.status !== 'active') ?? [];

  /** 대상: 모든 일꾼 · 역할 일꾼의 이름 · 앱의 이름 */
  function target(rule: Rule): string {
    if (rule.scope === 'all') return '모든 일꾼';
    if (rule.scope === 'role')
      return agents.find((a) => a.preset === rule.scopeKey)?.name ?? `역할 ${rule.scopeKey}`;
    return `앱 ${apps.find((a) => a.id === rule.scopeKey)?.name ?? rule.scopeKey}`;
  }

  function flip(rule: Rule) {
    const retire = rule.status === 'active';
    if (
      retire &&
      !window.confirm(`R${rule.seq}을(를) 내릴까요? 일꾼에게 더 보이지 않고, 되살릴 수 있어요`)
    )
      return;
    void action.run(
      rule.id,
      () =>
        api('PATCH', `/api/rules/${rule.id}`, {
          status: retire ? 'retired' : 'active',
          version: rule.version,
        }),
      {
        done: `R${rule.seq} ${retire ? '내림' : '되살림'}`,
        reload: rules.reload,
        conflict: CONFLICT,
      },
    );
  }

  const row = (rule: Rule) => (
    <li key={rule.id} className="item">
      <div className="item-main">
        <b>
          R{rule.seq} {rule.body}
        </b>
        <small>
          {target(rule)} · 도움 {rule.helpful} · 해로움 {rule.harmful}
          {rule.harmful > rule.helpful ? ' · 해로움이 더 많음' : ''}
          {rule.retiredAt ? ` · 내림 ${when(rule.retiredAt)}` : ` · ${when(rule.createdAt)}`}
          {rule.replacedBy
            ? ` · R${list?.find((r) => r.id === rule.replacedBy)?.seq ?? '?'}로 바뀜`
            : ''}
        </small>
      </div>
      <button
        type="button"
        className="ghost"
        disabled={action.busy !== null}
        onClick={() => flip(rule)}
      >
        {rule.status === 'active' ? '내리기' : '되살리기'}
      </button>
    </li>
  );

  return (
    <>
      <p className="note">
        대화에서 대표가 제안하고 승인한 규칙이에요. 일꾼은 맞는 규칙을 일마다 받고, 검토를 통과하면
        도움 · 수정 요청을 받으면 해로움으로 세요.
      </p>
      {(rules.error ?? action.problem) && <p className="error">{rules.error ?? action.problem}</p>}
      {list === undefined ? (
        !rules.error && <p className="label-mono loading">불러오는 중…</p>
      ) : (
        <>
          <section className="panel" aria-labelledby="rules-active">
            <div className="sec-title flat">
              <h2 id="rules-active">쓰는 중</h2>
            </div>
            {active.length === 0 ? (
              <p className="rows-empty">아직 배운 규칙 없음</p>
            ) : (
              <ul className="list" aria-label="쓰는 중인 규칙">
                {active.map(row)}
              </ul>
            )}
          </section>
          {retired.length > 0 && (
            <section className="panel" aria-labelledby="rules-retired">
              <div className="sec-title flat">
                <h2 id="rules-retired">내린 규칙</h2>
              </div>
              <ul className="list" aria-label="내린 규칙">
                {retired.map(row)}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
