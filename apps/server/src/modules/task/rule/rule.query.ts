import { Injectable } from '@nestjs/common';
import { Actor, BaseQuery, NotFound, SettingActor, type SettingChangeInput } from '../../platform';
import { Approval } from '../approval/approval';
import { ChatRequest } from '../chat/chat-request.policy';
import { Lessons } from '../task/lesson.policy';
import { approvals, learnedRules, tasks } from '../task.schema';
import type { LearnedRuleRow } from '../task.tables';
import { RuleListView, RuleSettingsView, RuleSettingView, RuleView } from './rule.view';

// 배운 규칙의 읽기 (2026-11-28): 콘솔 목록(관리자) · get_settings rules(제안하는 에이전트) · 일꾼의 지시문(러너) ·
// 수정 요청이 가리키는 일(일꾼). 배우기 일에 싣는 규칙은 LessonQuery.rules
@Injectable()
export class LearnedRuleQuery extends BaseQuery {
  /** 일 하나의 지시문에 싣는 규칙 수 (도움 - 해로움이 큰 것부터) */
  static readonly JOB_MAX = 15;
  /** get_settings에 싣는 내린 규칙 (최근 것) */
  private static readonly RETIRED_MAX = 20;
  /** 하위 작업에서 앱을 찾아 위로 올라가는 깊이 */
  private static readonly DEPTH_MAX = 20;

  /** 콘솔: 공간의 규칙 모두 (관리자만) */
  async list(actor: Actor): Promise<RuleListView> {
    actor.assertOwner();
    const rows = await this.sql<LearnedRuleRow[]>`
      SELECT * FROM task.learned_rules WHERE space_id = ${actor.requireSpace()}
      ORDER BY status = 'active' DESC,
        CASE WHEN status = 'active' THEN helpful - harmful END DESC NULLS LAST,
        retired_at DESC NULLS LAST, seq`;
    return new RuleListView(rows.map((r) => new RuleView(r)));
  }

  /** get_settings { kind: rules }: 쓰는 중인 것과 최근에 내린 것 */
  async settings(actor: Actor): Promise<RuleSettingsView> {
    return new RuleSettingsView(await this.current(SettingActor.spaceOf(actor)));
  }

  /** 제안의 지금 값 (만들기면 null) */
  async settingNow(actor: Actor, change: SettingChangeInput): Promise<RuleSettingView | null> {
    const spaceId = SettingActor.spaceOf(actor);
    if (change.targetId === null) return null;
    const row = await this.row(learnedRules, { space_id: spaceId, id: change.targetId });
    if (!row) throw new NotFound('배운 규칙을 찾을 수 없어요');
    return new RuleSettingView(row);
  }

  /**
   * 일꾼의 일에 실을 규칙 (next_jobs의 rules): 쓰는 중이고 모든 일꾼 · 그 일꾼의 역할 · 그 일의 앱에 맞는 것.
   * 앱은 그 일이나 위 작업의 대상이 앱이거나, 대화의 회차 · 앱 코드 주문에 적힌 앱이다
   */
  async forJob(
    actor: Actor,
    spaceId: string,
    taskId: string,
    preset: string | null,
  ): Promise<readonly Pick<LearnedRuleRow, 'seq' | 'body'>[]> {
    actor.assertCan(Actor.RUN);
    const rows = await this.sql<Pick<LearnedRuleRow, 'seq' | 'body'>[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, target_kind, target_id, payload, 0 AS depth
        FROM task.tasks WHERE space_id = ${spaceId} AND id = ${taskId}
        UNION ALL
        SELECT t.id, t.parent_id, t.target_kind, t.target_id, t.payload, up.depth + 1
        FROM task.tasks t JOIN up ON t.id = up.parent_id
        WHERE up.depth < ${LearnedRuleQuery.DEPTH_MAX}
      ), app AS (
        SELECT id FROM (
          SELECT up.depth, coalesce(
            CASE WHEN up.target_kind = 'app' THEN up.target_id::text END,
            up.payload->'chat'->>'appId',
            up.payload->'appCode'->>'appId'
          ) AS id FROM up
        ) found WHERE id IS NOT NULL ORDER BY depth LIMIT 1
      )
      SELECT r.seq, r.body FROM task.learned_rules r
      WHERE r.space_id = ${spaceId} AND r.status = 'active'
        AND (r.scope = 'all'
          OR (r.scope = 'role' AND r.scope_key = ${preset})
          OR (r.scope = 'app' AND r.scope_key IN (SELECT id FROM app)))
      ORDER BY r.helpful - r.harmful DESC, r.seq
      LIMIT ${LearnedRuleQuery.JOB_MAX}`;
    return rows;
  }

  /**
   * 관리자가 사람으로서 수정 요청한 결재가 가리키는 일 (해로움을 셀 일): 결재를 올린 작업, 결과 카드면 실린 마지막 회차.
   * 검수자가 돌려보낸 것(agent_decided) · 신호(로그인했어요) · 수정 요청이 아닌 것은 null
   */
  async revisedTask(actor: Actor, spaceId: string, approvalId: string): Promise<string | null> {
    actor.assertCan(Actor.RUN);
    const a = await this.row(approvals, { space_id: spaceId, id: approvalId });
    if (!a || a.status !== 'revision_requested' || a.agent_decided || a.decided_by === null)
      return null;
    if (Lessons.SKIP.includes(a.action)) return null;
    if (a.task_id !== null) return a.task_id;
    if (a.action !== Approval.CARD) return null;
    const turn = await this.row(
      tasks,
      { space_id: spaceId, request_id: ChatRequest.turn(a.target_id, a.target_version) },
      { columns: ['id'] },
    );
    return turn?.id ?? null;
  }

  /** 쓰는 중인 규칙 모두와 최근에 내린 규칙 */
  private current(spaceId: string): Promise<LearnedRuleRow[]> {
    return this.sql<LearnedRuleRow[]>`
      (SELECT * FROM task.learned_rules WHERE space_id = ${spaceId} AND status = 'active')
      UNION ALL
      (SELECT * FROM task.learned_rules WHERE space_id = ${spaceId} AND status = 'retired'
        ORDER BY retired_at DESC LIMIT ${LearnedRuleQuery.RETIRED_MAX})
      ORDER BY seq`;
  }
}
