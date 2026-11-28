import { Injectable } from '@nestjs/common';
import { type Actor, BaseQuery, Forbidden } from '../../platform';
import { agents, learnedRules } from '../task.schema';
import type { LearnedRuleRow, TaskRow } from '../task.tables';
import { type LessonNoteRow, Lessons } from './lesson.policy';

// 피드백에서 배우기의 읽기 (2026-11-20, Lessons): 대표, 지난 배우기 일, 그 뒤의 관리자 수정 요청 메모.
// 일꾼(SystemActor)이 부른다. 공간 밖은 읽지 않는다
@Injectable()
export class LessonQuery extends BaseQuery {
  /** 공간의 대표. 대화를 연 적이 없으면 null (배우기도 없다) */
  async leadOf(actor: Actor, spaceId: string): Promise<string | null> {
    LessonQuery.assertSpace(actor, spaceId);
    const lead = await this.row(
      agents,
      { space_id: spaceId, lead: true, deleted_at: null },
      { columns: ['id'] },
    );
    return lead?.id ?? null;
  }

  /** 가장 최근의 배우기 일 (열렸는지 · 언제 만들었는지) */
  async last(
    actor: Actor,
    spaceId: string,
  ): Promise<Pick<TaskRow, 'status' | 'created_at'> | null> {
    LessonQuery.assertSpace(actor, spaceId);
    const [row] = await this.sql<Pick<TaskRow, 'status' | 'created_at'>[]>`
      SELECT status, created_at FROM task.tasks
      WHERE space_id = ${spaceId} AND request_id LIKE ${`${Lessons.PREFIX}${spaceId}:%`}
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    return row ?? null;
  }

  /**
   * since 뒤에 관리자가 수정 요청으로 남긴 메모 (최근 것부터 NOTES_MAX개). 사람이 정한 것만(agent_decided가 아님),
   * 메모가 빈 것 · 신호(Lessons.SKIP)는 뺀다. 앱은 대상이 앱이면 그 앱, 아니면 대화의 앱
   */
  async notes(
    actor: Actor,
    spaceId: string,
    since: Date | null,
  ): Promise<readonly LessonNoteRow[]> {
    LessonQuery.assertSpace(actor, spaceId);
    return this.sql<LessonNoteRow[]>`
      SELECT a.id, a.action, a.target_kind, a.note, a.decided_at,
        g.name AS agent_name, t.title AS task_title,
        CASE WHEN a.target_kind = 'app' THEN a.target_id::text ELSE c.app_id::text END AS app_id
      FROM task.approvals a
      LEFT JOIN task.agents g ON g.id = a.agent_id
      LEFT JOIN task.tasks t ON t.id = a.task_id
      LEFT JOIN task.chats c ON c.id = a.chat_id
      WHERE a.space_id = ${spaceId} AND a.status = 'revision_requested' AND NOT a.agent_decided
        AND a.decided_by IS NOT NULL AND btrim(coalesce(a.note, '')) <> ''
        AND NOT (a.action = ANY(${Lessons.SKIP as string[]}::text[]))
        AND (${since}::timestamptz IS NULL OR a.decided_at > ${since}::timestamptz)
      ORDER BY a.decided_at DESC, a.id DESC
      LIMIT ${Lessons.NOTES_MAX}`;
  }

  /** 쓰는 중인 배운 규칙 (2026-11-28): 배우기 일이 횟수를 보고 더하기 · 내리기 · 합치기를 제안한다 */
  async rules(actor: Actor, spaceId: string): Promise<readonly LearnedRuleRow[]> {
    LessonQuery.assertSpace(actor, spaceId);
    return this.rows(learnedRules, { space_id: spaceId, status: 'active' }, { order: ['seq'] });
  }

  private static assertSpace(actor: Actor, spaceId: string): void {
    if (actor.spaceId !== null && actor.spaceId !== spaceId) throw new Forbidden('space');
  }
}
