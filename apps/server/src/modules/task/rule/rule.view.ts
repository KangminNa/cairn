import type { LearnedRuleRow } from '../task.tables';

// 배운 규칙의 응답 모양 (2026-11-28). 콘솔(camelCase) · get_settings(snake_case, propose_setting rule의 칸과 같은 이름)이
// 보는 칸이 달라 View를 나눈다. 일꾼의 지시문에 싣는 줄(next_jobs의 rules)은 JobView가 그린다

/** 콘솔의 규칙 한 줄 (일꾼 › 배운 규칙) */
export class RuleView {
  constructor(private readonly row: Readonly<LearnedRuleRow>) {}

  toJSON() {
    const r = this.row;
    return {
      id: r.id,
      seq: r.seq,
      scope: r.scope,
      scopeKey: r.scope_key,
      body: r.body,
      helpful: r.helpful,
      harmful: r.harmful,
      status: r.status,
      fromApproval: r.approval_id !== null,
      replacedBy: r.replaced_by,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      retiredAt: r.retired_at?.toISOString() ?? null,
    };
  }
}

/** 콘솔의 규칙 목록: 쓰는 중 먼저(도움 - 해로움이 큰 순), 그다음 내린 것(최근 순) */
export class RuleListView {
  constructor(private readonly rules: readonly RuleView[]) {}

  toJSON() {
    return { rules: this.rules.map((r) => r.toJSON()) };
  }
}

/** get_settings { kind: rules }의 한 줄. 제안의 지금 값도 이 모양이다 */
export class RuleSettingView {
  constructor(private readonly row: Readonly<LearnedRuleRow>) {}

  toJSON() {
    const r = this.row;
    return {
      id: r.id,
      version: r.version,
      seq: r.seq,
      scope: r.scope,
      scope_key: r.scope_key,
      body: r.body,
      helpful: r.helpful,
      harmful: r.harmful,
      status: r.status,
    };
  }
}

/** get_settings { kind: rules }: 쓰는 중인 규칙과 최근에 내린 규칙 */
export class RuleSettingsView {
  constructor(private readonly rows: readonly Readonly<LearnedRuleRow>[]) {}

  toJSON() {
    return { rules: this.rows.map((r) => new RuleSettingView(r).toJSON()) };
  }
}
