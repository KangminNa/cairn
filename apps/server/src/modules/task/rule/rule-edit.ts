import {
  RuleViolation,
  type SettingChangeInput,
  type SettingShape,
  type Sql,
} from '../../platform';
import { LearnedRule } from './rule';
import { LearnedRuleRepository } from './rule.repository';

/**
 * 배운 규칙 바꾸기 한 번을 부르는 쪽의 트랜잭션에서 (2026-11-28, GoalEdit과 같은 모양). 제안의 미리 해 보기와 승인 뒤 적용이 같은 줄.
 *   create { scope, scope_key?, body, replaces? }: 새 규칙. replaces(규칙 id 10개까지)는 내리고 새 규칙을 가리킨다
 *     → 글 고치기는 새 규칙 + 옛 규칙 하나, 합치기는 새 규칙 + 옛 규칙 여럿 (원칙 2: 옛 글은 남는다)
 *   edit { status }: 내리기(retired) · 되살리기(active). 글 · 대상은 바꾸지 않는다
 * 저장 순서는 새 규칙 → 내릴 규칙 (내린 규칙이 새 규칙을 가리키므로). 저장은 부르는 쪽이 정한다
 */
export class RuleEdit {
  static readonly SETTING: SettingShape = {
    setting: 'rule',
    list: 'rules',
    ops: ['create', 'edit'],
    fields: ['scope', 'scope_key', 'body', 'replaces', 'status'],
    target: 'id',
    versioned: true,
    grants: [],
  };
  /** 한 번에 합칠 수 있는 규칙 수 */
  static readonly REPLACES_MAX = 10;

  constructor(
    private readonly tx: Sql,
    private readonly spaceId: string,
  ) {}

  /** 바꾼 규칙들 (저장할 차례대로). approvalId는 승인한 제안 (미리 해 보기는 null) */
  async apply(
    change: SettingChangeInput,
    approvalId: string | null,
    now: Date,
  ): Promise<LearnedRule[]> {
    const rules = new LearnedRuleRepository(this.tx);
    const { scope, scope_key: key, body, replaces, status } = change.body;
    if (change.op !== 'create') {
      if (scope !== undefined || key !== undefined || body !== undefined || replaces !== undefined)
        throw new RuleViolation(
          '규칙의 글 · 대상은 바꾸지 않아요: op create로 새 규칙을 만들고 replaces에 옛 규칙 id를 적어요',
        );
      const rule = await rules.lock(this.spaceId, String(change.targetId));
      rule.assertVersion(change.version);
      rule.changeStatus(String(status ?? ''), now);
      return [rule];
    }
    if (status !== undefined) throw new RuleViolation('새 규칙은 쓰는 중으로 시작해요');
    if (typeof body !== 'string') throw new RuleViolation('body는 규칙 한 줄이에요');
    const old = await rules.lockAll(this.spaceId, RuleEdit.idsOf(replaces));
    for (const rule of old)
      if (!rule.active) throw new RuleViolation(`이미 내린 규칙이에요: ${rule.label}`);
    const made = LearnedRule.open(
      this.spaceId,
      await rules.nextSeq(this.spaceId),
      typeof scope === 'string' ? scope : LearnedRule.ALL,
      typeof key === 'string' && key !== '' ? key : null,
      body,
      approvalId,
      now,
    );
    for (const rule of old) rule.changeStatus(LearnedRule.RETIRED, now, made.id);
    return [made, ...old];
  }

  /** replaces: 규칙 id 목록 (없으면 빈 목록) */
  private static idsOf(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      !Array.isArray(value) ||
      value.length > RuleEdit.REPLACES_MAX ||
      !value.every((v) => typeof v === 'string' && uuid.test(v))
    )
      throw new RuleViolation(`replaces는 규칙 id ${RuleEdit.REPLACES_MAX}개까지예요`);
    return value as string[];
  }
}
