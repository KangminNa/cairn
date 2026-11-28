import { NotFound, TableRepository } from '../../platform';
import type { TeamStatRow } from '../task/job.view';
import { TeamRoster } from '../task/team-roster';
import { agentRevisions, agents } from '../task.schema';
import type { AgentRow } from '../task.tables';
import { PlanUsage } from '../usage/plan-usage';
import { PlanUsageRepository } from '../usage/plan-usage.repository';
import type { AgentScoreRow } from '../usage/usage.view';
import { Agent } from './agent';
import { AgentUsage } from './agent-usage';

// task.agents ↔ Agent. 불러오기와 저장은 기반이 하고, 여기에는 조직도와 사용량 SQL만 있다.
export class AgentRepository extends TableRepository<AgentRow, Agent> {
  protected readonly table = agents;
  protected readonly noun = '에이전트';

  protected toEntity(row: AgentRow): Agent {
    return Agent.restore(row);
  }

  /** 하나 (새 일 · 스케줄 · 결재 · 고치기의 대상). 삭제한 에이전트는 없는 것과 같다 (404). 복원은 lockAll로 찾는다 */
  override async load(spaceId: string, id: string): Promise<Agent> {
    return AgentRepository.alive(await super.load(spaceId, id));
  }

  override async lock(spaceId: string, id: string): Promise<Agent> {
    return AgentRepository.alive(await super.lock(spaceId, id));
  }

  /**
   * 팀원 정보 (D1, 2026-11-17): 공간의 에이전트(usage)에 에이전트마다 쥔 일(대기 · 실행 · 기다림), 최근 기간의 끝냄 · 실패 ·
   * 결재에서 고쳐 달라 · 반려된 수, 허락받았고 켜진 커넥터를 붙인다. 일을 빌려 줄 때 한 번 읽는다
   */
  async roster(spaceId: string, usage: readonly AgentUsage[], now: Date): Promise<TeamRoster> {
    const since = TeamRoster.since(now);
    const stats = await this.sql<Omit<TeamStatRow, 'scorecard'>[]>`
      WITH work AS (
        SELECT agent_id,
          count(*) FILTER (WHERE status IN ('queued', 'running', 'waiting'))::int AS open,
          count(*) FILTER (WHERE status = 'done' AND finished_at >= ${since})::int AS done,
          count(*) FILTER (WHERE status = 'failed' AND finished_at >= ${since})::int AS failed
        FROM task.tasks
        WHERE space_id = ${spaceId} AND agent_id IS NOT NULL
          AND (status IN ('queued', 'running', 'waiting') OR finished_at >= ${since})
        GROUP BY agent_id
      ), sent_back AS (
        SELECT agent_id, count(*)::int AS revised FROM task.approvals
        WHERE space_id = ${spaceId} AND status IN ('revision_requested', 'rejected')
          AND decided_at >= ${since} AND agent_id IS NOT NULL
        GROUP BY agent_id
      )
      SELECT a.id AS agent_id, coalesce(w.open, 0) AS open, coalesce(w.done, 0) AS done,
        coalesce(w.failed, 0) AS failed, coalesce(b.revised, 0) AS revised,
        ARRAY(SELECT e.name FROM task.external_tools e
              WHERE e.space_id = a.space_id AND e.status = 'active' AND e.catalog_pending IS NULL AND e.name = ANY(a.external_tools)
              ORDER BY e.name) AS connectors
      FROM task.agents a
      LEFT JOIN work w ON w.agent_id = a.id
      LEFT JOIN sent_back b ON b.agent_id = a.id
      WHERE a.space_id = ${spaceId} AND a.deleted_at IS NULL`;
    const scores = new Map((await this.scores(spaceId, now)).map((s) => [s.agent_id, s]));
    return new TeamRoster(
      usage.map((u) => u.agent),
      stats.map((stat) => ({
        ...stat,
        scorecard: AgentRepository.cardOf(scores.get(stat.agent_id)),
      })),
    );
  }

  /** 성적표 한 줄 → 팀원 정보의 칸 (끝낸 일 수는 팀원 줄의 최근 7일 수와 겹쳐 뺀다) */
  private static cardOf(row: AgentScoreRow | undefined): TeamStatRow['scorecard'] {
    if (!row) return null;
    const { judged, first_pass, avg_fixes, decided, sent_back, tokens_per_done } = row;
    return { judged, first_pass, avg_fixes, decided, sent_back, tokens_per_done };
  }

  /**
   * 성적표 (2026-11-20 평가가 남는 팀, 최근 TeamRoster.SCORE_DAYS일): 판정(task.verdicts)의 첫 판정 · 통과 · 고칠 것 ·
   * 대상 수, 관리자가 정한 결재(검수자가 정한 것 · 결과 카드 · 로그인했어요는 빼고)와 그중 수정 요청 · 반려,
   * 끝난 일의 토큰 ÷ 끝낸 일. 팀원 줄(roster)과 팀 화면(UsageQuery)이 함께 읽는다
   */
  async scores(spaceId: string, now: Date): Promise<readonly AgentScoreRow[]> {
    const since = TeamRoster.scoreSince(now);
    const skipped = [...TeamRoster.SCORE_SKIP];
    return this.sql<AgentScoreRow[]>`
      WITH judged AS (
        SELECT agent_id,
          count(*) FILTER (WHERE round = 1)::int AS judged,
          count(*) FILTER (WHERE round = 1 AND verdict = 'pass')::int AS first_pass,
          round(count(*) FILTER (WHERE verdict = 'fix')::numeric / count(DISTINCT target), 2)::float8
            AS avg_fixes
        FROM task.verdicts
        WHERE space_id = ${spaceId} AND created_at >= ${since}
        GROUP BY agent_id
      ), decided AS (
        SELECT agent_id, count(*)::int AS decided,
          count(*) FILTER (WHERE status IN ('revision_requested', 'rejected'))::int AS sent_back
        FROM task.approvals
        WHERE space_id = ${spaceId} AND decided_at >= ${since} AND agent_id IS NOT NULL
          AND NOT agent_decided AND status IN ('approved', 'revision_requested', 'rejected')
          AND action <> ALL(${skipped}::text[])
        GROUP BY agent_id
      ), spent AS (
        SELECT t.agent_id, count(*) FILTER (WHERE t.status = 'done')::int AS done,
          coalesce(sum(e.tokens), 0)::float8 AS tokens
        FROM task.tasks t
        LEFT JOIN LATERAL (
          SELECT sum(tokens) AS tokens FROM task.task_events WHERE task_id = t.id AND tokens > 0
        ) e ON true
        WHERE t.space_id = ${spaceId} AND t.agent_id IS NOT NULL AND t.finished_at >= ${since}
        GROUP BY t.agent_id
      )
      SELECT a.id AS agent_id,
        coalesce(j.judged, 0) AS judged, coalesce(j.first_pass, 0) AS first_pass,
        j.avg_fixes,
        coalesce(d.decided, 0) AS decided, coalesce(d.sent_back, 0) AS sent_back,
        coalesce(s.done, 0) AS done,
        CASE WHEN coalesce(s.done, 0) > 0 THEN round(s.tokens / s.done)::int END AS tokens_per_done
      FROM task.agents a
      LEFT JOIN judged j ON j.agent_id = a.id
      LEFT JOIN decided d ON d.agent_id = a.id
      LEFT JOIN spent s ON s.agent_id = a.id
      WHERE a.space_id = ${spaceId} AND a.deleted_at IS NULL
      ORDER BY a.id`;
  }

  /** 공간의 대표 (O-2). 아직 없으면 null */
  async findLead(spaceId: string): Promise<Agent | null> {
    return this.findOne({ space_id: spaceId, lead: true, deleted_at: null });
  }

  /**
   * 대표를 만들기 전에: 공간마다 advisory 잠금을 걸고 다시 찾는다 (처음 여는 대화 둘이 대표를 하나씩 만들지 않게.
   * 부분 유일 색인 agents_one_lead가 마지막 방어). 줄이 없을 수 있어 행 대신 advisory 잠금
   */
  async lockLeadSlot(spaceId: string): Promise<Agent | null> {
    await this
      .sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task.agent-lead:${spaceId}`}, 0))`;
    return this.findLead(spaceId);
  }

  /** 공간의 살아 있는 역할 일꾼 (2026-11-28, AgentRoster가 갖춘다) */
  async presets(spaceId: string): Promise<readonly Agent[]> {
    const live = await this.find({ space_id: spaceId, deleted_at: null }, { order: ['id'] });
    return live.filter((a) => a.preset !== null);
  }

  /** 대표가 있는 공간들 (서버를 켤 때 공간마다 역할 일꾼을 갖춘다) */
  async leadSpaces(): Promise<readonly string[]> {
    const rows = await this.sql<{ space_id: string }[]>`
      SELECT space_id FROM task.agents WHERE lead AND deleted_at IS NULL`;
    return rows.map((r) => r.space_id);
  }

  private static alive(agent: Agent): Agent {
    if (agent.deleted) throw new NotFound('에이전트를 찾을 수 없어요');
    return agent;
  }

  /** 바뀐 설정의 판을 남긴다 (추가만) */
  protected override async saveParts(agent: Agent): Promise<void> {
    const revision = agent.addedRevision;
    if (revision) await this.insertRows(agentRevisions, revision);
  }

  /** 공간의 모든 에이전트 (만든 순서). 잠그지 않는다: 위임할 때 바로 아래 팀을 찾는다 */
  async all(spaceId: string): Promise<readonly Agent[]> {
    return this.find({ space_id: spaceId }, { order: ['id'] });
  }

  /**
   * 공간의 모든 에이전트를 만든 순서대로 잠근다. 조직도를 바꿀 때: 둘이 동시에 서로에게 보고하게 바꾸면
   * 각자 본 조직도에는 순환이 없어 둘 다 통과하므로, 조직도 전체를 같은 순서로 잠가 한 번에 하나만 바꾼다.
   */
  async lockAll(spaceId: string): Promise<readonly Agent[]> {
    return this.find({ space_id: spaceId }, { order: ['id'], lock: true });
  }

  /**
   * 공간의 모든 에이전트와 지금 사용량. 만든 순서대로. 잠그지 않는다.
   * 일을 빌릴 때와 홈의 사용량이 같은 값을 보게 한 곳에서 읽는다.
   */
  async usage(spaceId: string, now: Date): Promise<readonly AgentUsage[]> {
    const plan = await new PlanUsageRepository(this.sql).list(spaceId);
    const rows = await this.sql<(AgentRow & { five_hour_tokens: number; month_tokens: number })[]>`
      SELECT a.*,
        coalesce(u.five_hour, 0)::bigint AS five_hour_tokens,
        coalesce(u.month, 0)::bigint AS month_tokens
      FROM task.agents a
      LEFT JOIN LATERAL (
        SELECT
          sum(e.tokens) FILTER (WHERE e.at > ${now}::timestamptz - interval '5 hours') AS five_hour,
          sum(e.tokens) FILTER (WHERE e.at >= date_trunc('month', ${now}::timestamptz)) AS month
        FROM task.task_events e JOIN task.tasks t ON t.id = e.task_id
        WHERE t.agent_id = a.id AND e.tokens > 0
          AND e.at >= least(
            ${now}::timestamptz - interval '5 hours',
            date_trunc('month', ${now}::timestamptz)
          )
      ) u ON true
      WHERE a.space_id = ${spaceId} AND a.deleted_at IS NULL
      ORDER BY a.id`;
    return rows.map((row) => {
      const agent = this.toEntity(row);
      return new AgentUsage(
        agent,
        row.five_hour_tokens,
        row.month_tokens,
        PlanUsage.highest(plan, agent.tool, now),
      );
    });
  }

  /** 이번 달에 쓴 토큰. 원본은 실행 기록이다 */
  async usedThisMonth(agentId: string, now: Date): Promise<number> {
    const [row] = await this.sql<{ used: number }[]>`
      SELECT coalesce(sum(e.tokens), 0)::bigint AS used
      FROM task.task_events e JOIN task.tasks t ON t.id = e.task_id
      WHERE t.agent_id = ${agentId} AND e.tokens > 0
        AND e.at >= date_trunc('month', ${now}::timestamptz)`;
    return row?.used ?? 0;
  }

  /** 에이전트마다 지금 쥔 일(대기 · 실행)의 수 (D3, 담당을 비운 위임에서 덜 바쁜 일꾼을 고른다) */
  async loads(spaceId: string): Promise<ReadonlyMap<string, number>> {
    const rows = await this.sql<{ agent_id: string; n: number }[]>`
      SELECT agent_id, count(*)::int AS n FROM task.tasks
      WHERE space_id = ${spaceId} AND agent_id IS NOT NULL AND status IN ('queued', 'running')
      GROUP BY agent_id`;
    return new Map(rows.map((r) => [r.agent_id, r.n]));
  }
}
