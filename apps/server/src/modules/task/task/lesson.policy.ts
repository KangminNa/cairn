import type { ApprovalRow, LearnedRuleRow, TaskRow } from '../task.tables';

/** 배우기에 싣는 관리자의 수정 요청 한 줄과 함께 읽는 칸: 올린 에이전트 · 일의 제목 · 앱 (대상이 앱이거나 앱의 대화) */
export interface LessonNoteRow
  extends Pick<ApprovalRow, 'id' | 'action' | 'target_kind' | 'note' | 'decided_at'> {
  agent_name: string | null;
  task_title: string | null;
  app_id: string | null;
}

// 피드백에서 배우기 (기획서 결정 2026-11-20, ECC의 continuous-learning에서 가져옴): 관리자가 수정 요청에 남긴 메모가
// 지난 배우기 뒤로 MIN_NOTES개 쌓이면 대표에게 일 하나를 맡긴다. 대표는 되풀이해 지킬 규칙을 배운 규칙(R<번호>, 2026-11-28)으로,
// 앱의 문체는 편집 방침으로 제안하고, 관리자가 승인해야 바뀐다 (원칙 3). 사람이 고친 것에서만 배운다:
// 검수자가 돌려보낸 수정 요청(agent_decided)은 빼고, 메모가 아닌 신호(로그인했어요)도 뺀다. 상태 없음
// biome-ignore lint/complexity/noStaticOnlyClass: 상태 없는 판단 한 곳. TaskService와 LessonQuery가 쓴다
export class Lessons {
  /** 배우기를 시작하는 메모 수 */
  static readonly MIN_NOTES = 3;
  /** 한 번에 싣는 메모 수 (최근 것부터) */
  static readonly NOTES_MAX = 20;
  private static readonly NOTE_TEXT = 500;
  static readonly PREFIX = 'lessons:';
  static readonly TITLE = '피드백에서 배우기';
  /** 대화의 일(10)과 보통 일(0)보다 뒤 */
  static readonly PRIORITY = -5;
  /** 메모가 아니라 신호인 수정 요청 (사이트에 로그인했어요) */
  static readonly SKIP: readonly string[] = ['browser.site.login'];
  private static readonly OPEN: readonly string[] = ['queued', 'running', 'waiting'];

  /** 시작할 때인가: 열린 배우기 일이 없고 그 뒤로 메모가 MIN_NOTES개 이상 */
  static due(last: Pick<TaskRow, 'status'> | null, notes: number): boolean {
    if (last !== null && Lessons.OPEN.includes(last.status)) return false;
    return notes >= Lessons.MIN_NOTES;
  }

  /** 공간 · 날(UTC)마다 일 하나 */
  static requestId(spaceId: string, now: Date): string {
    return `${Lessons.PREFIX}${spaceId}:${now.toISOString().slice(0, 10)}`;
  }

  /** 지시문 틀 lessons의 자리: 메모와 쓰는 중인 배운 규칙 (번호 · 도움 · 해로움 · 대상, 2026-11-28) */
  static fields(
    notes: readonly LessonNoteRow[],
    rules: readonly LearnedRuleRow[],
  ): Record<string, string | number | null> {
    return {
      count: notes.length,
      notes: notes.map((n) => Lessons.line(n)).join('\n'),
      rules: rules.length === 0 ? null : rules.map((r) => Lessons.ruleLine(r)).join('\n'),
    };
  }

  /** 규칙 한 줄: "- [R3] 도움 2 · 해로움 1 · 대상 role writer (id …): 글" */
  private static ruleLine(r: LearnedRuleRow): string {
    const scope = r.scope === 'all' ? 'all' : `${r.scope} ${r.scope_key}`;
    return `- [R${r.seq}] 도움 ${r.helpful} · 해로움 ${r.harmful} · 대상 ${scope} (id ${r.id}): ${r.body}`;
  }

  private static line(n: LessonNoteRow): string {
    const day = n.decided_at ? n.decided_at.toISOString().slice(0, 10) : '-';
    const where = [
      n.action,
      n.task_title ? `일: ${n.task_title}` : null,
      n.agent_name ? `올린 에이전트: ${n.agent_name}` : null,
      n.app_id ? `app_id: ${n.app_id}` : null,
    ].filter(Boolean);
    const note = (n.note ?? '').replace(/\s+/g, ' ').trim().slice(0, Lessons.NOTE_TEXT);
    return `- [${day}] ${where.join(' · ')}\n  관리자 메모: ${note}`;
  }
}
