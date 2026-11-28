import { RuleViolation } from '../../platform';
import { ProgressLedger } from './progress-ledger.policy';

/** 계획 하나 (작업의 payload.plan에 함께 적는 칸) */
export interface TaskPlanRow {
  steps: readonly string[];
  criteria: readonly string[];
  mustNot: readonly string[];
}

// 큰 일은 계획 먼저 (2026-11-20, ECC의 "만드는 쪽은 완료 조건을 고치지 못한다"): 일을 맡은 에이전트가 하위 작업을 나눠
// 맡기기 전에 set_plan으로 단계 · 완료 조건 · 하지 말 것을 한 번 정한다. 서버가 작업의 payload.plan에 고정해 두어 다시 정할 수
// 없고, 검토 · 검수 지시문이 그 완료 조건 · 하지 말 것을 그대로 받는다(일한 팀의 답이 조건을 바꿔 말해도 계획의 문장으로).
// 깨어난 일에도 러너가 다시 보인다 (apps/runner JobPlan). 상태 없음
// biome-ignore lint/complexity/noStaticOnlyClass: 상태 없는 규칙 한 곳. 작업 · 결과 결재 · 검수가 함께 쓴다
export class TaskPlan {
  static readonly STEPS_MAX = 8;
  static readonly CRITERIA_MAX = 8;
  static readonly MUST_NOT_MAX = 5;
  static readonly LINE_MAX = 200;
  private static readonly NOTE_MAX = 2000;

  /**
   * 계획을 적은 payload. 이미 정했으면 RuleViolation (완료 조건은 바꿀 수 없다).
   * 진행 장부의 진전 없음이 이어졌으면(ProgressLedger.replanDue, 2026-11-28) 단계 · 하지 말 것만 다시 정한다:
   * 완료 조건은 비우거나 처음 것 그대로 적어야 하고 처음 것을 둔다
   */
  static declare(
    payload: Readonly<Record<string, unknown>>,
    plan: TaskPlanRow,
  ): Record<string, unknown> {
    const before = TaskPlan.of(payload);
    if (before !== null) return TaskPlan.redeclare(payload, before, plan);
    if (plan.criteria.length === 0) throw new RuleViolation('완료 조건을 하나 이상 적어 주세요');
    return { ...payload, plan: { ...plan } };
  }

  /** declare로 저장될 계획(다시 세웠으면 처음 완료 조건)과 다시 세웠는지 (set_plan의 답 · 소식) */
  static declared(
    payload: Readonly<Record<string, unknown>>,
    plan: TaskPlanRow,
  ): { plan: TaskPlanRow; again: boolean } {
    const next = TaskPlan.declare(payload, plan);
    return { plan: TaskPlan.of(next) ?? plan, again: TaskPlan.of(payload) !== null };
  }

  private static redeclare(
    payload: Readonly<Record<string, unknown>>,
    before: TaskPlanRow,
    plan: TaskPlanRow,
  ): Record<string, unknown> {
    if (!ProgressLedger.replanDue(payload))
      throw new RuleViolation(
        `계획은 한 번만 정해요 (완료 조건은 바꿀 수 없어요). 진전 없음이 ${ProgressLedger.STALL_LIMIT}번 이어지면 단계를 다시 정해요`,
      );
    const same = plan.criteria.join('\n') === before.criteria.join('\n');
    if (plan.criteria.length > 0 && !same)
      throw new RuleViolation(
        '다시 세울 때도 완료 조건은 그대로예요 (criteria를 비우거나 처음 것 그대로)',
      );
    const next = { steps: plan.steps, criteria: before.criteria, mustNot: plan.mustNot };
    return ProgressLedger.replanned({ ...payload, plan: next });
  }

  /** 작업에 정해 둔 계획. 없거나 모양이 틀리면 null */
  static of(payload: unknown): TaskPlanRow | null {
    const plan = (payload as { plan?: unknown } | null)?.plan as Partial<TaskPlanRow> | undefined;
    if (!plan || !Array.isArray(plan.criteria) || plan.criteria.length === 0) return null;
    const texts = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
      steps: texts(plan.steps),
      criteria: texts(plan.criteria),
      mustNot: texts(plan.mustNot),
    };
  }

  /**
   * 대화의 회차들(오래된 것부터)에서 판정에 쓸 계획: 마지막 회차부터 다시 맡긴 회차(payload.chat.fix)를 거슬러 그 줄의
   * 처음 회차까지 가며, 그 가운데 가장 먼저 정한 계획. 다시 맡긴 회차가 새로 정해도 처음 완료 조건으로 판정한다
   */
  static inTurns(turns: readonly { payload: unknown }[]): TaskPlanRow | null {
    let found: TaskPlanRow | null = null;
    for (const turn of [...turns].reverse()) {
      found = TaskPlan.of(turn.payload) ?? found;
      if ((turn.payload as { chat?: { fix?: unknown } } | null)?.chat?.fix !== true) break;
    }
    return found;
  }

  /** 검토 · 검수 지시문의 자리 (계획이 없으면 둘 다 null) */
  static fields(plan: TaskPlanRow | null): { criteria: string | null; mustNot: string | null } {
    const list = (lines: readonly string[]) => lines.map((l) => `- ${l}`).join('\n') || null;
    return {
      criteria: plan ? list(plan.criteria) : null,
      mustNot: plan ? list(plan.mustNot) : null,
    };
  }

  /** 대화의 소식 한 줄 (관리자가 계획을 바로 본다). 소식의 길이(2,000자)를 넘으면 자른다 */
  static note(plan: TaskPlanRow, again = false): string {
    const block = (head: string, lines: readonly string[]) =>
      lines.length > 0 ? [head, ...lines.map((l) => `- ${l}`)].join('\n') : '';
    return [
      again ? '계획을 다시 세웠어요 (완료 조건은 그대로)' : '계획을 정했어요',
      block('단계', plan.steps),
      block('완료 조건', plan.criteria),
      block('하지 말 것', plan.mustNot),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, TaskPlan.NOTE_MAX);
  }
}
