import { Actor, Forbidden, RuleViolation } from '../../platform';
import type { Agent } from '../agent/agent';
import { AgentRoles } from '../agent/agent-roles';
import { ModelTier } from '../agent/model-tier.policy';
import { TurnBrief } from '../chat/turn-brief.policy';
import type { TaskNew, TaskRow } from '../task.tables';
import { CodeScope } from './code-scope';
import type { SubtaskOrder } from './subtask-order.input';
import { SubtaskWait } from './subtask-wait.policy';
import { TaskKinds } from './task-kinds';
import { TaskRefs } from './task-refs.policy';

// 위임 하나의 판단 (Task.assertCanDelegate · subtask가 부른다): 한도와 하위 작업의 모양. 받는 쪽 · 종류는 코드가 막고 LLM에게 맡기지 않는다.
// 팀 없는 같은 일꾼 (2026-11-21, 사용자 결정 "비공개도 그냥 읽어"): 대표만 맡기고 일꾼은 모두 같은 권한이다.
// 비공개를 읽은 대화에서 브라우저 일을 막던 규칙은 없앴다. 바깥을 바꾸는 동작은 원칙 7대로 승인 뒤, 비밀값은 원칙 8대로 AI 밖
// biome-ignore lint/complexity/noStaticOnlyClass: 상태 없는 판단 한 곳
export class DelegationPolicy {
  /** 위임 한도: 깊이(주인이 맡긴 작업이 0), 작업 하나가 위임하는 횟수, 한 번에, 작업 하나에 */
  static readonly DEPTH_MAX = 3;
  static readonly ROUNDS_MAX = 3;
  static readonly DELEGATE_AT_ONCE = 5;
  static readonly SUBTASKS_MAX = 10;

  /** 이 권한을 가진 에이전트에게 맡길 수 있는 일의 종류 (팀원 정보의 kinds) */
  static kindsFor(scopes: readonly string[]): readonly string[] {
    return TaskKinds.DELEGABLE.filter((kind) =>
      (TaskKinds.SCOPES[kind] ?? []).every((scope) => scopes.includes(scope)),
    );
  }

  /**
   * 맡기는 쪽은 대표, 받는 쪽은 지우지 않은 일꾼(Agent.manages), 종류는 위임할 수 있는 것(delegable),
   * 받는 쪽은 그 일에 필요한 권한(needs)을 가졌는가 (권한은 모두 같아 옛 판 · 잘못된 값만 걸린다)
   */
  static assert(
    manager: Agent,
    worker: Agent | null,
    kind: string,
    delegable: readonly string[],
    needs: readonly string[],
  ): asserts worker is Agent {
    if (worker === null || !manager.manages(worker))
      throw new Forbidden(Actor.AGENT, '대표만 일꾼에게 맡길 수 있어요');
    if (!delegable.includes(kind))
      throw new RuleViolation(`맡길 수 있는 일은 ${delegable.join(' · ')}예요: ${kind}`);
    if (!needs.every((scope) => worker.scopes.includes(scope)))
      throw new RuleViolation(`${worker.name}의 권한으로는 할 수 없는 일이에요: ${kind}`);
  }

  /**
   * 이번에 count개를 맡길 수 있는가 (위 작업이 살아 있는 임대로 일하는 중인지는 Task가 본다).
   * 한 번에 DELEGATE_AT_ONCE개, 작업 하나에 SUBTASKS_MAX개(made는 이미 맡긴 수), 깊이 DEPTH_MAX, 라운드 ROUNDS_MAX까지
   */
  static assertLimits(
    parent: Pick<TaskRow, 'depth' | 'rounds' | 'payload'>,
    count: number,
    made: number,
  ): void {
    const P = DelegationPolicy;
    SubtaskWait.assertNotHurried(parent.payload);
    if (TurnBrief.asked(parent.payload))
      throw new RuleViolation('목표 확인 질문을 했어요. 관리자의 답이 오는 다음 회차에서 맡겨요');
    if (count < 1 || count > P.DELEGATE_AT_ONCE)
      throw new RuleViolation(`한 번에 1~${P.DELEGATE_AT_ONCE}개를 맡길 수 있어요 (한도)`);
    if (made + count > P.SUBTASKS_MAX)
      throw new RuleViolation(
        `작업 하나가 맡길 수 있는 하위 작업은 ${P.SUBTASKS_MAX}개예요 (한도, 이미 ${made}개)`,
      );
    if (parent.depth + 1 > P.DEPTH_MAX)
      throw new RuleViolation(`위임은 ${P.DEPTH_MAX}단계까지예요 (한도)`);
    if (parent.rounds + 1 > P.ROUNDS_MAX)
      throw new RuleViolation(
        `작업 하나가 위임하거나 더 기다릴 수 있는 횟수는 ${P.ROUNDS_MAX}번이에요 (한도)`,
      );
  }

  /**
   * 하위 작업에 일꾼을 고른다 (D3 2026-11-28, 역할 일꾼 2026-11-28). 순서:
   * 역할(role)을 골랐으면 그 역할 일꾼(그 역할이 받는 종류여야 한다) → 담당(to_agent_id)을 정했으면 그대로 →
   * 그 종류를 받는 역할 일꾼(AgentRoles.forKind) 가운데 → 그래도 없으면 맡을 수 있는 일꾼 모두 가운데.
   * 고르는 기준은 대표가 맡길 수 있고(Agent.manages) 멈추지 않았으며 그 일의 권한을 가진 일꾼 가운데 지금 쥔 일
   * (대기 · 실행, loads)이 가장 적은 쪽, 같으면 목록 순서. 한 번의 호출에서 먼저 맡긴 것도 센다. 고를 일꾼이 없으면 RuleViolation
   */
  static assign(
    manager: Agent,
    org: readonly Agent[],
    loads: ReadonlyMap<string, number>,
    orders: readonly SubtaskOrder[],
  ): SubtaskOrder[] {
    const load = new Map(loads);
    const busy = (id: string) => load.get(id) ?? 0;
    const least = (agents: readonly Agent[]) =>
      agents.reduce<Agent | null>(
        (best, a) => (best && busy(best.id) <= busy(a.id) ? best : a),
        null,
      )?.id;
    return orders.map((order) => {
      const kind = order.fields.kind ?? 'general';
      const needs = TaskKinds.SCOPES[kind] ?? [];
      const able = org
        .filter((a) => manager.manages(a) && !a.paused)
        .filter((a) => needs.every((scope) => a.scopes.includes(scope)));
      const fits = AgentRoles.forKind(kind).map((r) => r.key);
      const pick =
        DelegationPolicy.roleAgent(manager, org, order.role, kind) ??
        order.toAgentId ??
        least(able.filter((a) => a.preset !== null && fits.includes(a.preset))) ??
        least(able);
      if (!pick)
        throw new RuleViolation('맡을 수 있는 일꾼이 없어요 (일꾼 메뉴에서 멈춘 일꾼을 켜요)');
      load.set(pick, busy(pick) + 1);
      return pick === order.toAgentId ? order : order.assigned(pick);
    });
  }

  /** 대표가 고른 역할의 일꾼. 역할이 없으면 null, 그 역할이 받지 않는 종류이거나 일꾼이 없으면 RuleViolation */
  private static roleAgent(
    manager: Agent,
    org: readonly Agent[],
    role: string | null,
    kind: string,
  ): string | null {
    const def = AgentRoles.find(role);
    if (!def) return null;
    AgentRoles.assertTakes(def, kind);
    const agent = org.find((a) => a.preset === def.key && manager.manages(a));
    if (!agent) throw new RuleViolation(`${def.name} 일꾼이 아직 없어요 (서버를 다시 켜면 생겨요)`);
    return agent.id;
  }

  /** 위임에 쓰는 하위 작업의 request_id. AI가 만든 값을 위 작업마다 따로 센다 */
  static requestIdOf(parentId: string, requestId: string): string {
    return `delegate:${parentId}:${requestId}`;
  }

  /** 이 작업이 아직 위임할 수 있는 횟수 (러너가 일과 함께 받는다) */
  static roundsLeft(parent: Pick<TaskRow, 'rounds'>): number {
    return Math.max(0, DelegationPolicy.ROUNDS_MAX - parent.rounds);
  }

  /**
   * 하위 작업 하나의 칸. 받는 쪽은 대표가 맡길 수 있는 일꾼이어야 하고, 그 에이전트의 권한으로 할 수 있는 종류여야 한다 (assert).
   * 하위 작업은 위 작업의 목표와 우선순위를 물려받고, 담당은 worker로 정해진다.
   * code는 code 작업에서만 맡긴다: 위 작업의 저장소 · 명령을 물려받고 경로(paths)는 위 작업의 경로 안으로 좁힌다 (CodeScope).
   * 참조(refs)는 위 작업의 참조 가운데 고른 것만 넘긴다 (TaskRefs.handOn)
   */
  static subtask(
    parent: TaskRow,
    parentScope: CodeScope | null,
    manager: Agent,
    worker: Agent | null,
    order: SubtaskOrder,
  ): Omit<TaskNew, 'id' | 'space_id'> {
    const { fields, paths, refs } = order;
    const { kind } = fields;
    const needs = TaskKinds.SCOPES[kind] ?? [];
    DelegationPolicy.assert(manager, worker, kind, TaskKinds.DELEGABLE, needs);
    // 모델 상한: 맡기는 일이 쓰는 모델(대화가 정한 것 → 맡기는 에이전트의 설정) 이하에서 (ModelTier)
    const model = ModelTier.forSubtask(
      DelegationPolicy.modelOf(parent) || manager.model,
      order.model,
      worker,
    );
    return {
      ...fields,
      agent_id: worker.id,
      payload: {
        delegatedBy: parent.id,
        ...CodeScope.forSubtask(kind, paths, parentScope),
        ...TaskRefs.of(parent.payload).handOn(refs).payload,
        ...(order.deliver ? { deliver: order.deliver } : {}),
        // 이 일의 방법 (C4): 러너가 도구를 고른다 (web이면 커넥터를 붙이지 않는다)
        ...(order.route ? { route: order.route } : {}),
        // 검증받기 (L2): 끝나면 SubtaskService가 검증 일을 연다 (SubtaskVerify)
        ...(order.verify ? { verify: true } : {}),
        // 앱 코드를 고치는 make 일 (스토어 1-6b): 어느 앱인지만 물려준다. make 일이 아니면 MakeOrder가 막는다
        ...(order.appId ? { appCode: { appId: order.appId } } : {}),
        // 고른 모델 · 낮춘 모델: JobView가 팀원의 설정 대신 보내고, 이 일이 다시 맡기면 그 상한이 된다
        ...(model ? { runtime: { model } } : {}),
      },
      priority: parent.priority,
      goal_id: parent.goal_id,
      parent_id: parent.id,
      depth: parent.depth + 1,
    };
  }

  /** 일에 실린 모델 (payload.runtime.model: 대화의 회차 · 모델을 정해 맡긴 하위 작업). 없으면 빈 글 */
  private static modelOf(task: TaskRow): string {
    const runtime = (task.payload as { runtime?: { model?: unknown } } | null)?.runtime;
    return typeof runtime?.model === 'string' ? runtime.model : '';
  }
}
