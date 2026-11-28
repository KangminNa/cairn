import type { AgentRevisionRow, AgentRow } from '../task.tables';

// 에이전트의 읽기 모양. 웹이 `import type`으로 가져온다 (객체설계 6장).
// 표의 칸 중 무엇을 내보내는지는 여기 한 곳에만 적는다.

/** 바꾼 에이전트 하나. 화면은 이 version으로 다음 변경을 보낸다 */
export class AgentSavedView {
  constructor(private readonly row: Readonly<AgentRow>) {}

  toJSON() {
    const r = this.row;
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      /** 역할 일꾼의 열쇠 (agent-roles.json, 2026-11-28). null이면 예전 일꾼. 이름 · 역할을 바꾸거나 지우지 못한다 */
      preset: r.preset ?? null,
      tool: r.tool,
      approvalActions: r.approval_actions,
      monthlyLimit: r.monthly_limit,
      fiveHourLimit: r.five_hour_limit,
      planStopPercent: r.plan_stop_percent,
      /** AI CLI의 모델 · 생각 강도. 빈 글이면 CLI의 기본 (2차 7단계) */
      model: r.model ?? '',
      effort: r.effort ?? '',
      /** 허락한 외부 도구의 이름 (2차 7단계) */
      externalTools: r.external_tools ?? [],
      /** 일을 맡을 러너 (task.runners의 id). null이면 아무 러너 */
      runnerId: r.runner_id ?? null,
      /** 검토자 짝 (다른 AI 도구의 에이전트, 2차 2단계) */
      reviewerId: r.reviewer_id ?? null,
      /** 검수 승인 (대표만, 2026-11-20): 검토자가 앱 안의 공개를 검수해 통과하면 관리자 대신 승인 */
      reviewerApproves: r.reviewer_approves === true,
      /** 두 번째 검수자 (대표만, 2026-11-20): 검수 승인이 켜졌을 때 둘 다 통과해야 공개 */
      secondInspectorId: r.reviewer_approves === true ? (r.second_inspector_id ?? null) : null,
      status: r.status,
      /** 휴지통에 넣은 때. null이면 쓰는 에이전트 */
      deletedAt: r.deleted_at?.toISOString() ?? null,
      version: r.version,
      /** 설정 판: 주인이 정하는 칸이 바뀔 때마다 오른다 (실행 기록이 이 번호를 남긴다) */
      settingsRevision: r.settings_revision,
      createdAt: r.created_at.toISOString(),
    };
  }
}

/** 에이전트 설정 판 목록 (새 판부터). settings는 그 판의 설정 칸 전부 */
export class AgentRevisionListView {
  constructor(private readonly rows: readonly Readonly<AgentRevisionRow>[]) {}

  toJSON() {
    return {
      revisions: this.rows.map((r) => ({
        revision: r.revision,
        settings: r.settings as Record<string, unknown>,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }
}

/** 목록의 에이전트 하나: 이번 달에 쓴 토큰과 맡은 스케줄 수까지 */
export class AgentView extends AgentSavedView {
  constructor(
    row: Readonly<AgentRow>,
    /** 이번 달에 쓴 토큰 */
    private readonly usedThisMonth: number,
    /** 이 에이전트가 담당인 스케줄 수 (스케줄 메뉴에서 정한다) */
    private readonly schedules: number,
  ) {
    super(row);
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      usedThisMonth: this.usedThisMonth,
      schedules: this.schedules,
    };
  }
}

/** 대표 (O-2, GET api/agents/lead): 설정 › AI의 대표 칸. 첫 대화 전이라 아직 없으면 null */
export class AgentLeadView {
  constructor(private readonly lead: AgentView | null) {}

  toJSON() {
    return { lead: this.lead?.toJSON() ?? null };
  }
}

/** 에이전트 목록. 몇 개뿐이라 한 쪽에 다 보낸다 */
export class AgentListView {
  constructor(private readonly agents: readonly AgentView[]) {}

  toJSON() {
    return { agents: this.agents.map((a) => a.toJSON()), next: null };
  }
}
