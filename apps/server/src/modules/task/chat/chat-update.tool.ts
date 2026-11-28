import { Injectable } from '@nestjs/common';
import { Actor, BaseTool } from '../../platform';
import { ProgressLedger } from '../task/progress-ledger.policy';
import { CHAT_DELIVER } from '../task.tables';
import {
  AgentUpdatesInput,
  AskBriefInput,
  NoteProgressInput,
  PostUpdateInput,
  SetDeliverInput,
} from './chat-update.input';
import { ChatUpdates } from './chat-update.policy';
import { ChatUpdateQuery } from './chat-update.query';
import { ChatUpdateService } from './chat-update.service';
import {
  type AgentUpdatesView,
  type BriefAskedView,
  type DeliverSetView,
  PostedUpdateView,
  type ProgressNotedView,
} from './chat-update.view';
import { DecisionNote } from './decision-note.policy';
import { TurnBrief } from './turn-brief.policy';
import { TurnDeliver } from './turn-deliver.policy';

// 대화의 소식 MCP 도구 (2차 1-1, docs/API설계.md 4장). 글은 task.tools.ko.json에.

/** agent_updates: 새 소식과 대화마다의 상태판. delegate 기기는 자기 대화, news 기기(훅 · 상태 줄)는 모든 대화 */
@Injectable()
export class AgentUpdatesTool extends BaseTool {
  readonly name = 'agent_updates';
  readonly scope = Actor.DELEGATE;
  override readonly orScope = Actor.NEWS;
  readonly readOnly = true;
  readonly inputSchema = {
    properties: {
      chat_id: { type: 'string', format: 'uuid' },
      project: { type: 'string', maxLength: 400 },
      after: { type: 'integer', minimum: 0 },
      wait_seconds: { type: 'integer', minimum: 0, maximum: AgentUpdatesInput.WAIT_MAX },
    },
  };

  constructor(private readonly updates: ChatUpdateQuery) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<AgentUpdatesView> {
    return this.updates.updates(actor, AgentUpdatesInput.from(raw));
  }
}

/** post_update: 대화에서 맡은 일을 하는 에이전트가 중간 보고 · 정한 것 · 가정을 남긴다 (작업 토큰) */
@Injectable()
export class PostUpdateTool extends BaseTool {
  readonly name = 'post_update';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: {
      kind: { type: 'string', enum: [...ChatUpdates.POSTED] },
      text: { type: 'string', maxLength: ChatUpdates.TEXT_MAX },
      decision: {
        type: 'object',
        properties: {
          chosen: { type: 'string', maxLength: DecisionNote.CHOSEN_MAX },
          alternatives: {
            type: 'array',
            maxItems: DecisionNote.ALTERNATIVES_MAX,
            items: { type: 'string', maxLength: DecisionNote.ALTERNATIVE_MAX },
          },
          why: { type: 'string', maxLength: DecisionNote.WHY_MAX },
          weight: { type: 'string', enum: [...DecisionNote.WEIGHTS] },
          step: { type: 'string', maxLength: DecisionNote.STEP_MAX },
          confirm: { type: 'string', enum: [...DecisionNote.CONFIRMS] },
          wait_minutes: {
            type: 'integer',
            minimum: DecisionNote.WAIT_MIN,
            maximum: DecisionNote.WAIT_MAX,
          },
        },
        required: ['chosen'],
      },
    },
    required: ['kind', 'text'],
  };

  constructor(private readonly updates: ChatUpdateService) {
    super();
  }

  async handle(actor: Actor, raw: unknown): Promise<PostedUpdateView> {
    return this.updates.post(actor, PostUpdateInput.from(raw));
  }
}

/** 이번 회차의 받을 것 (O-3): 대표가 첫 실행에서 정하면 서버가 결과 카드에서 본다 */
@Injectable()
export class SetDeliverTool extends BaseTool {
  readonly name = 'set_deliver';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  override readonly idempotent = true;
  readonly inputSchema = {
    properties: {
      deliver: { type: 'string', enum: [...CHAT_DELIVER] },
      note: { type: 'string', maxLength: TurnDeliver.NOTE_MAX },
    },
    required: ['deliver'],
  };

  constructor(private readonly updates: ChatUpdateService) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<DeliverSetView> {
    return this.updates.setDeliver(actor, SetDeliverInput.from(raw));
  }
}

/** 목표 확인 질문 (2026-11-20): 결과물 일을 맡기 전에 대표가 핵심을 묻고 회차를 끝낸다. 관리자의 답이 다음 회차로 온다 */
@Injectable()
export class AskBriefTool extends BaseTool {
  readonly name = 'ask_brief';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: {
      summary: { type: 'string', maxLength: TurnBrief.SUMMARY_MAX },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: TurnBrief.QUESTIONS_MAX,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: TurnBrief.TEXT_MAX },
            why: { type: 'string', maxLength: TurnBrief.TEXT_MAX },
            choices: {
              type: 'array',
              maxItems: TurnBrief.CHOICES_MAX,
              items: { type: 'string', maxLength: TurnBrief.CHOICE_MAX },
            },
            suggested: { type: 'string', maxLength: TurnBrief.TEXT_MAX },
          },
          required: ['text', 'suggested'],
        },
      },
    },
    required: ['summary', 'questions'],
  };

  constructor(private readonly updates: ChatUpdateService) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<BriefAskedView> {
    return this.updates.askBrief(actor, AskBriefInput.from(raw));
  }
}

/** 진행 장부 (2026-11-28): 대표가 하위 작업 결과를 받고 깬 실행에서 다음 동작 전에 한 줄 판단을 남긴다 */
@Injectable()
export class NoteProgressTool extends BaseTool {
  readonly name = 'note_progress';
  readonly scope = Actor.AGENT;
  readonly readOnly = false;
  readonly inputSchema = {
    properties: {
      done: { type: 'boolean' },
      progressing: { type: 'boolean' },
      looping: { type: 'boolean' },
      next: { type: 'string', maxLength: ProgressLedger.NEXT_MAX },
      why: { type: 'string', maxLength: ProgressLedger.WHY_MAX },
    },
    required: ['done', 'progressing', 'looping', 'next'],
  };

  constructor(private readonly updates: ChatUpdateService) {
    super();
  }

  handle(actor: Actor, raw: unknown): Promise<ProgressNotedView> {
    return this.updates.noteProgress(actor, NoteProgressInput.from(raw));
  }
}
