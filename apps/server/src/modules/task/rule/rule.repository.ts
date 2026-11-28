import { TableRepository } from '../../platform';
import { learnedRules } from '../task.schema';
import type { LearnedRuleRow } from '../task.tables';
import { LearnedRule } from './rule';

// task.learned_rules ↔ LearnedRule, 그리고 세기의 근거 task.rule_marks (추가만).
// 횟수는 엔티티를 거치지 않고 근거를 넣은 만큼만 더한다: 같은 근거(판정 작업 · 결재)는 UNIQUE라 두 번 와도 한 번이고,
// version을 올리지 않아 관리자의 내리기와 겨루지 않는다
export class LearnedRuleRepository extends TableRepository<LearnedRuleRow, LearnedRule> {
  protected readonly table = learnedRules;
  protected readonly noun = '배운 규칙';

  protected toEntity(row: LearnedRuleRow): LearnedRule {
    return LearnedRule.restore(row);
  }

  /** 새 규칙의 번호: 공간마다 잠그고 가장 큰 번호 + 1 (동시에 둘을 만들어도 겹치지 않게) */
  async nextSeq(spaceId: string): Promise<number> {
    await this
      .sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task.learned_rules:${spaceId}`}, 0))`;
    const [row] = await this.sql<{ seq: number }[]>`
      SELECT coalesce(max(seq), 0) + 1 AS seq FROM task.learned_rules WHERE space_id = ${spaceId}`;
    return Number(row?.seq ?? 1);
  }

  /** 고치기 · 합치기로 내릴 규칙들을 잠근다 (id 순서). 공간에 없는 id가 있으면 NotFound */
  async lockAll(spaceId: string, ids: readonly string[]): Promise<LearnedRule[]> {
    const sorted = [...new Set(ids)].sort();
    const found: LearnedRule[] = [];
    for (const id of sorted) found.push(await this.lock(spaceId, id));
    return found;
  }

  /**
   * 작업 하나와 그 아래 하위 작업들이 따랐다고 적은 규칙 번호 (result.rules). 판정 · 수정 요청이 그 일의 규칙을 센다
   */
  async followedIn(spaceId: string, rootTaskId: string): Promise<number[]> {
    const rows = await this.sql<{ seq: number }[]>`
      WITH RECURSIVE tree AS (
        SELECT id, result FROM task.tasks WHERE space_id = ${spaceId} AND id = ${rootTaskId}
        UNION ALL
        SELECT t.id, t.result FROM task.tasks t JOIN tree ON t.parent_id = tree.id
      )
      SELECT DISTINCT (r.value)::int AS seq
      FROM tree, jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(tree.result->'rules') = 'array' THEN tree.result->'rules' ELSE '[]'::jsonb END
      ) AS r(value)
      WHERE r.value ~ '^[0-9]{1,7}$'`;
    return rows.map((r) => Number(r.seq));
  }

  /** 대화 회차(request_id) 아래가 따른 규칙의 번호와 글: 검토자가 규칙마다 도움 · 해로움을 적을 수 있게 싣는다 */
  async followedInTurn(
    spaceId: string,
    requestId: string,
  ): Promise<Pick<LearnedRuleRow, 'seq' | 'body'>[]> {
    const [root] = await this.sql<{ id: string }[]>`
      SELECT id FROM task.tasks WHERE space_id = ${spaceId} AND request_id = ${requestId}`;
    const seqs = root ? await this.followedIn(spaceId, root.id) : [];
    if (seqs.length === 0) return [];
    return this.sql<Pick<LearnedRuleRow, 'seq' | 'body'>[]>`
      SELECT seq, body FROM task.learned_rules
      WHERE space_id = ${spaceId} AND seq = ANY(${seqs}::int[]) ORDER BY seq`;
  }

  /**
   * 근거 하나로 규칙들을 센다: 번호 → helpful · harmful. 공간에 있는 번호만, 같은 근거는 한 번.
   * 새로 센 수를 돌려준다
   */
  async mark(
    spaceId: string,
    source: string,
    marks: ReadonlyMap<number, string>,
    taskId: string | null,
  ): Promise<number> {
    let counted = 0;
    for (const [seq, mark] of marks) {
      const rows = await this.sql<{ rule_id: string }[]>`
        INSERT INTO task.rule_marks (space_id, rule_id, source, mark, task_id)
        SELECT r.space_id, r.id, ${source}, ${mark}, ${taskId}
        FROM task.learned_rules r WHERE r.space_id = ${spaceId} AND r.seq = ${seq}
        ON CONFLICT (rule_id, source) DO NOTHING
        RETURNING rule_id`;
      const ruleId = rows[0]?.rule_id;
      if (ruleId === undefined) continue;
      if (mark === 'helpful')
        await this.sql`UPDATE task.learned_rules SET helpful = helpful + 1 WHERE id = ${ruleId}`;
      else await this.sql`UPDATE task.learned_rules SET harmful = harmful + 1 WHERE id = ${ruleId}`;
      counted += 1;
    }
    return counted;
  }
}
