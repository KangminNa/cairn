import { Injectable } from '@nestjs/common';
import { Actor, BaseTool } from '../../platform';
import { AgentRoles } from '../agent/agent-roles';
import { ModelTier } from '../agent/model-tier.policy';
import { CodeScope } from './code-scope';
import type { DelegatedView } from './delegated.view';
import { DelegationPolicy } from './delegation.policy';
import { SubtaskOrder } from './subtask-order.input';
import { AskHelpInput, WaitSubtasksInput } from './subtask-wait.input';
import { SubtaskWait } from './subtask-wait.policy';
import type { HelpAskedView } from './subtask-wait.view';
import { Task } from './task';
import { DelegateTaskInput } from './task.input';
import { TaskService } from './task.service';
import { SetPlanInput } from './task-plan.input';
import { TaskPlan } from './task-plan.policy';
import type { PlanSetView } from './task-plan.view';
import { TaskRefs } from './task-refs.policy';

// MCP 도구 delegate_task: 에이전트가 바로 아래 팀에게 하위 작업을 맡긴다 (에이전트 조직, 객체설계 13장).
// 작업 토큰으로만 부른다. 누가 어느 작업에서 맡기는지는 입력이 아니라 토큰에서 나온다.
// 받는 쪽 · 종류 · 한도는 코드가 막고, 무엇을 나눠 누구에게 맡길지는 AI가 정한다.
@Injectable()
export class DelegateTaskTool extends BaseTool {
  readonly name = 'delegate_task';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  override readonly idempotent = true;
  readonly inputSchema = {
    properties: {
      subtasks: {
        type: 'array',
        minItems: 1,
        maxItems: DelegationPolicy.DELEGATE_AT_ONCE,
        items: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              maxLength: 200,
            },
            to_agent_id: { type: 'string', format: 'uuid' },
            role: { type: 'string', enum: [...AgentRoles.KEYS] },
            kind: {
              type: 'string',
              enum: [...Task.DELEGABLE],
            },
            title: { type: 'string', maxLength: 200 },
            instruction: {
              type: 'string',
              maxLength: 20000,
            },
            target_kind: { type: 'string', maxLength: 40 },
            target_id: { type: 'string', format: 'uuid' },
            target_version: { type: 'integer', minimum: 0 },
            paths: {
              type: 'array',
              minItems: 1,
              maxItems: CodeScope.PATHS_MAX,
              items: { type: 'string', maxLength: CodeScope.PATH_MAX },
            },
            refs: {
              type: 'array',
              maxItems: TaskRefs.MAX,
              items: { type: 'string', maxLength: 2000 },
            },
            deliver: { type: 'string', maxLength: SubtaskOrder.DELIVER_MAX },
            after: {
              type: 'array',
              maxItems: SubtaskOrder.AFTER_MAX,
              items: { type: 'string', maxLength: 200 },
            },
            app_id: { type: 'string', format: 'uuid' },
            model: { type: 'string', enum: [...ModelTier.CHOICES] },
            route: { type: 'string', enum: [...SubtaskOrder.ROUTES] },
            verify: { type: 'boolean' },
          },
          required: ['request_id', 'title', 'instruction'],
        },
      },
      wait_minutes: { type: 'integer', minimum: 1, maximum: SubtaskWait.MINUTES_MAX },
    },
    required: ['subtasks'],
  };

  constructor(private readonly tasks: TaskService) {
    super();
  }

  /** 작업은 하위 작업을 기다리므로 에이전트는 여기서 멈춘다 */
  async handle(actor: Actor, raw: unknown): Promise<DelegatedView> {
    return Task.delegatedView(await this.tasks.delegate(actor, DelegateTaskInput.from(raw)));
  }
}

// MCP 도구 wait_subtasks (팀원 기다리기, 2026-11-19): 먼저 깨어난 위 작업(기한 · 실패 · 관리자 재촉)이
// 끝나지 않은 하위 작업을 더 기다린다. 골라서 취소할 수 있다. 위임처럼 라운드 하나를 쓰고, 에이전트는 여기서 멈춘다
@Injectable()
export class WaitSubtasksTool extends BaseTool {
  readonly name = 'wait_subtasks';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: {
      minutes: { type: 'integer', minimum: 1, maximum: SubtaskWait.MINUTES_MAX },
      cancel: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uuid' } },
    },
  };

  constructor(private readonly tasks: TaskService) {
    super();
  }

  async handle(actor: Actor, raw: unknown): Promise<DelegatedView> {
    return Task.delegatedView(await this.tasks.waitMore(actor, WaitSubtasksInput.from(raw)));
  }
}

// MCP 도구 ask_help (2026-11-20): 맡겨진 팀원이 일이 커서 나눌 부분을 적어 팀장에게 도움을 청한다.
// 실행 기록 한 줄로 남고, 팀장이 하위 작업을 기다리는 중이면 먼저 깨운다. 누가 어느 일에서 청하는지는 토큰에서 나온다
@Injectable()
export class AskHelpTool extends BaseTool {
  readonly name = 'ask_help';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: { part: { type: 'string', maxLength: SubtaskWait.HELP_TEXT_MAX } },
    required: ['part'],
  };

  constructor(private readonly tasks: TaskService) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<HelpAskedView> {
    return this.tasks.askHelp(actor, AskHelpInput.from(raw));
  }
}

// MCP 도구 set_plan (2026-11-20 큰 일은 계획 먼저): 맡은 일의 단계 · 완료 조건 · 하지 말 것을 한 번 정한다. 완료 조건은 바꿀 수 없다
// (진전 없음이 이어지면 단계 · 하지 말 것만 다시, 2026-11-28 진행 장부). 처음 정할 때 완료 조건이 없으면 TaskPlan이 거절한다
@Injectable()
export class SetPlanTool extends BaseTool {
  readonly name = 'set_plan';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: {
      steps: SetPlanTool.list(TaskPlan.STEPS_MAX),
      criteria: SetPlanTool.list(TaskPlan.CRITERIA_MAX),
      must_not: SetPlanTool.list(TaskPlan.MUST_NOT_MAX),
    },
  };

  private static list(max: number) {
    return {
      type: 'array',
      maxItems: max,
      items: { type: 'string', maxLength: TaskPlan.LINE_MAX },
    };
  }

  constructor(private readonly tasks: TaskService) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<PlanSetView> {
    return this.tasks.setPlan(actor, SetPlanInput.from(raw));
  }
}
