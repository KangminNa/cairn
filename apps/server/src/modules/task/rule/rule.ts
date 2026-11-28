import { BaseEntity, DomainEvent, RuleViolation, TableEntity, ValueList } from '../../platform';
import { AgentRoles } from '../agent/agent-roles';
import { LEARNED_RULE_SCOPE, type LearnedRuleNew, type LearnedRuleRow } from '../task.tables';
import { RuleView } from './rule.view';

// 배운 규칙 하나 (task.learned_rules, 2026-11-28 ACE의 규칙 목록). 피드백에서 배운 것을 역할 설명 · 편집 방침에 섞지 않고
// 번호(R<seq>)를 붙여 따로 둔다. 대상은 모든 일꾼(all) · 한 역할(role: 역할 키) · 한 앱(app: 앱 id).
// 글 · 대상 · 번호는 처음 그대로다 (원칙 2, DB 트리거도 막는다): 고치기 · 합치기는 새 규칙을 만들고 옛 규칙을 내려 새 규칙을 가리킨다.
// 도움 · 해로움 횟수는 판정 · 수정 요청마다 저장소가 센다 (version을 올리지 않는다: 관리자의 내리기와 겹쳐도 낡지 않게)
export class LearnedRule extends TableEntity<LearnedRuleRow, LearnedRuleNew> {
  static readonly ACTIVE = 'active';
  static readonly RETIRED = 'retired';
  static readonly ALL = 'all';
  static readonly ROLE = 'role';
  static readonly APP = 'app';
  static readonly BODY_MAX = 300;
  static readonly CHANGED = 'task.rule.changed';
  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /** 새 규칙. approvalId는 승인한 제안 (관리자가 바로 만들면 null) */
  static open(
    spaceId: string,
    seq: number,
    scope: string,
    scopeKey: string | null,
    body: string,
    approvalId: string | null,
    now: Date,
  ): LearnedRule {
    const text = body.replace(/\s+/g, ' ').trim();
    if (text.length < 1 || text.length > LearnedRule.BODY_MAX)
      throw new RuleViolation(`규칙은 1~${LearnedRule.BODY_MAX}자 한 줄이에요`);
    const rule = new LearnedRule(
      {
        id: BaseEntity.newId(),
        space_id: spaceId,
        seq,
        scope: LearnedRule.scopeOf(scope),
        scope_key: LearnedRule.keyOf(scope, scopeKey),
        body: text,
        status: LearnedRule.ACTIVE,
        approval_id: approvalId,
        created_at: now,
        updated_at: now,
      },
      true,
    );
    rule.announce();
    return rule;
  }

  static restore(row: LearnedRuleRow): LearnedRule {
    return new LearnedRule(row);
  }

  get seq(): number {
    return this.row.seq;
  }

  get active(): boolean {
    return this.row.status === LearnedRule.ACTIVE;
  }

  /** 지시문 · 화면의 이름 */
  get label(): string {
    return `R${this.row.seq}`;
  }

  /** 상태 바꾸기: 내리기(retired) · 되살리기(active). 고치기 · 합치기로 내리면 새 규칙을 가리킨다. 같으면 그대로 */
  changeStatus(status: string, now: Date, replacedBy: string | null = null): void {
    if (status !== LearnedRule.ACTIVE && status !== LearnedRule.RETIRED)
      throw new RuleViolation('규칙의 상태는 active · retired 중 하나예요');
    if (status === this.row.status && replacedBy === null) return;
    if (replacedBy === this.id) throw new RuleViolation('자기 자신으로 바꿀 수 없어요');
    this.put('status', status);
    this.put('retired_at', status === LearnedRule.RETIRED ? now : null);
    if (replacedBy !== null) this.put('replaced_by', replacedBy);
    this.put('updated_at', now);
    this.announce();
  }

  view(): RuleView {
    return new RuleView(this.row);
  }

  private static scopeOf(scope: string): LearnedRuleRow['scope'] {
    if (!ValueList.has(LEARNED_RULE_SCOPE, scope))
      throw new RuleViolation(`scope는 ${LEARNED_RULE_SCOPE.join(' · ')} 중 하나예요`);
    return scope;
  }

  /** 대상의 키: all은 없음, role은 역할 키(agent-roles.json), app은 앱 id */
  private static keyOf(scope: string, key: string | null): string | null {
    if (scope === LearnedRule.ALL) {
      if (key) throw new RuleViolation('scope가 all이면 scope_key는 비워요');
      return null;
    }
    if (scope === LearnedRule.ROLE && (!key || !AgentRoles.KEYS.includes(key)))
      throw new RuleViolation(`역할 키는 ${AgentRoles.KEYS.join(' · ')} 중 하나예요`);
    if (scope === LearnedRule.APP && (!key || !LearnedRule.UUID.test(key)))
      throw new RuleViolation('scope가 app이면 scope_key는 앱 id예요');
    return key;
  }

  private announce(): void {
    this.record(
      new DomainEvent(LearnedRule.CHANGED, 1, this.row.space_id, {
        ruleId: this.id,
        status: this.row.status,
      }),
    );
  }
}
