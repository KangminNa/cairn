import { Injectable } from '@nestjs/common';
import {
  Actor,
  AgentActor,
  BaseService,
  Conflict,
  Forbidden,
  RuleViolation,
  type Sql,
  SystemActor,
} from '../../platform';
import { AgentRepository } from '../agent/agent.repository';
import { Approval } from '../approval/approval';
import { ApprovalRepository } from '../approval/approval.repository';
import { DecisionAsk } from '../approval/decision-ask.policy';
import { ProgressLedger } from '../task/progress-ledger.policy';
import { TaskRepository } from '../task/task.repository';
import { ChatRepository } from './chat.repository';
import { ChatPlan } from './chat-plan.policy';
import type {
  AskBriefInput,
  NoteProgressInput,
  PostUpdateInput,
  SetDeliverInput,
} from './chat-update.input';
import { ChatUpdates } from './chat-update.policy';
import {
  BriefAskedView,
  DeliverSetView,
  PostedUpdateView,
  ProgressNotedView,
} from './chat-update.view';
import { DecisionNote, type DecisionNoteRow } from './decision-note.policy';
import { TurnBrief } from './turn-brief.policy';
import { TurnDeliver } from './turn-deliver.policy';

// 대화의 소식 쓰기 (task.chat_updates, 2차 1-1). 소식은 대화 엔티티를 거쳐 쌓이고(Chat.note) 변경 신호로 agent_updates를 깨운다.
//   일꾼: 대화 안의 작업이 끝나면(task.task.changed) 팀원 끝남 · 실패 · 최종 답 · 덧붙인 말의 답 (ChatUpdateHandler)
//   작업 토큰: 대화에서 맡은 일(그 아래 하위 작업 포함)의 에이전트가 MCP post_update로 중간 보고 · 정한 것 · 가정
// 대화 줄은 잠그지 않는다: 소식은 추가만이고, 한도는 작업마다 센다 (동시에 남기면 하나 더 들어갈 수 있다).
@Injectable()
export class ChatUpdateService extends BaseService {
  /** 끝난 작업의 소식. 대화의 일이 아니거나, 소식이 아니거나(취소), 이미 남겼으면 그대로. 두 번 불려도 같다 */
  async noteSettled(actor: Actor, taskId: string): Promise<void> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    const now = new Date();
    await this.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      const said = place ? ChatUpdates.settled(place) : null;
      if (!place || !said || (await chats.hasUpdate(taskId, said.kind))) return;
      const chat = await chats.load(place.space_id, place.chat_id);
      chat.settled(said, taskId, place.agent_id, now);
      await chats.save(chat);
    });
  }

  /**
   * 위임을 계획 판단으로 (D3, ChatUpdateHandler가 task.task.changed의 waiting에서 부른다): 대화의 일이 하위 작업을
   * 기다리기 시작했고 앞 계획 뒤로 새로 맡긴 것이 있으면 판단 소식 하나 (ChatPlan). 두 번 와도 planned로 하나
   */
  async notePlan(actor: Actor, taskId: string): Promise<void> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    const now = new Date();
    await this.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      if (!place) return;
      const { parent, children, names, noted } = await chats.planOf(place.space_id, taskId);
      const said = parent?.agent_id ? ChatPlan.line(parent, children, names, noted) : null;
      if (!said || !parent?.agent_id) return;
      const chat = await chats.load(place.space_id, place.chat_id);
      chat.post(ChatPlan.KIND, said, taskId, parent.agent_id, 0, now);
      await chats.save(chat);
    });
  }

  /**
   * MCP post_update: 소식 하나를 남기고 그 번호(n)를 돌려준다. 대화에서 맡은 일이 아니면 RuleViolation.
   * 판단이 대화의 멈춤 기준에 걸리면(L3) 승인으로 멈춘다 (stopFor)
   */
  async post(actor: Actor, req: PostUpdateInput): Promise<PostedUpdateView> {
    actor.assertCan(Actor.AGENT);
    if (!(actor instanceof AgentActor) || !actor.spaceId || !actor.id)
      throw new Forbidden(Actor.AGENT);
    const { spaceId, id: agentId, taskId } = actor;
    const now = new Date();
    return this.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      if (!place) throw new RuleViolation('대화에서 맡은 일이 아니에요');
      const chat = await chats.load(spaceId, place.chat_id);
      const posted = await chats.countPosted(taskId, false);
      const data = DecisionNote.dataFor(req.kind, req.decision);
      const stop =
        req.decision && DecisionNote.stops(chat.stopMode, req.decision)
          ? await this.stopFor(tx, taskId, agentId, req.text, req.decision, chat.id, now)
          : null;
      const said = { text: req.text, data: stop ? { ...data, ...stop } : data };
      chat.post(req.kind, said, taskId, agentId, posted, now);
      await chats.save(chat);
      return new PostedUpdateView(await chats.numberOf(chat.addedUpdates[0]?.id ?? ''), stop);
    });
  }

  /**
   * 진행 장부 (2026-11-28, Magentic-One의 progress ledger, MCP note_progress, 작업 토큰): 대표가 맡은 일에서 하위 작업 결과를
   * 받고 깬 실행마다 끝났나 · 나아지나 · 맴도나 · 다음을 한 줄로. 진전 없음이 이어진 수는 작업의 payload.ledger에
   * (ProgressLedger), 대화의 일이면 소식(progress, data.ledger)으로도 남겨 화면의 상태 한 줄에 보인다. 잠그는 순서는 작업 → (대화는 쓰기만)
   */
  async noteProgress(actor: Actor, req: NoteProgressInput): Promise<ProgressNotedView> {
    actor.assertCan(Actor.AGENT);
    if (!(actor instanceof AgentActor) || !actor.spaceId || !actor.id)
      throw new Forbidden(Actor.AGENT);
    const { spaceId, id: agentId, taskId } = actor;
    const now = new Date();
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const task = await tasks.lockById(taskId);
      const lead = await new AgentRepository(tx).findLead(spaceId);
      if (task?.spaceId !== spaceId || task.agentId !== agentId || lead?.id !== agentId)
        throw new Forbidden(Actor.AGENT, '맡은 일을 하는 대표만 남겨요');
      if (!task.open) throw new Conflict('끝난 일이에요');
      let stalled = 0;
      task.declare((p) => {
        const next = ProgressLedger.record(p, req.entry);
        stalled = ProgressLedger.stalled(next);
        return next;
      });
      await tasks.save(task);
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      if (place) {
        const chat = await chats.load(spaceId, place.chat_id);
        const noted = await chats.countPosted(taskId, true);
        chat.post('progress', ProgressLedger.said(req.entry, stalled), taskId, agentId, noted, now);
        await chats.save(chat);
      }
      return new ProgressNotedView(stalled, stalled >= ProgressLedger.STALL_LIMIT);
    });
  }

  /**
   * 확인 필요 판단 (L3): 고를 안이 있는 승인을 올리고 일은 기다린다 (러너는 다음 보고에서 멈춘다).
   * 소식에는 승인 id와 기한을 함께 적어 화면이 판단 칸에서 바로 고르게 한다. 잠그는 순서는 작업 → 결재
   */
  private async stopFor(
    tx: Sql,
    taskId: string,
    agentId: string,
    text: string,
    note: DecisionNoteRow,
    chatId: string,
    now: Date,
  ): Promise<{ approval_id: string; expires_at: string | null }> {
    const tasks = new TaskRepository(tx);
    const task = await tasks.lockById(taskId);
    if (!task) throw new RuleViolation('대화에서 맡은 일이 아니에요');
    const agent = await new AgentRepository(tx).load(task.spaceId, agentId);
    const ask = DecisionAsk.request(task, text, note, chatId, now);
    const approval = Approval.request(task, agent, ask.fields, now, null, ask.payload);
    approval.expireAt(ask.expiresAt);
    await tasks.save(task);
    await new ApprovalRepository(tx).save(approval);
    return { approval_id: approval.id, expires_at: ask.expiresAt?.toISOString() ?? null };
  }

  /**
   * 이번 회차의 받을 것 (O-3, MCP set_deliver, 작업 토큰): 대표가 맡은 대화 회차(맨 위 작업)에서만, 끝나기 전에.
   * 관리자 · 레시피가 대화에 정한 값(chats.deliver)이 있으면 그 값만 받는다 (TurnDeliver). 잠그는 순서는 작업 → (대화는 읽기만)
   */
  async setDeliver(actor: Actor, req: SetDeliverInput): Promise<DeliverSetView> {
    actor.assertCan(Actor.AGENT);
    if (!(actor instanceof AgentActor) || !actor.spaceId || !actor.id)
      throw new Forbidden(Actor.AGENT);
    const { spaceId, id: agentId, taskId } = actor;
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const task = await tasks.lockById(taskId);
      const lead = await new AgentRepository(tx).findLead(spaceId);
      if (task?.spaceId !== spaceId || task.agentId !== agentId || lead?.id !== agentId)
        throw new Forbidden(Actor.AGENT, '대화 회차를 맡은 대표만 정해요');
      if (!task.open) throw new Conflict('끝난 회차예요');
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      if (!place) throw new Forbidden(Actor.AGENT, '대화 회차를 맡은 대표만 정해요');
      const chat = await chats.load(spaceId, place.chat_id);
      task.declare((p) => TurnDeliver.declare(p, req.deliver, req.note, chat.deliver));
      await tasks.save(task);
      return new DeliverSetView(chat.deliver ?? req.deliver, chat.deliver !== null);
    });
  }

  /**
   * 목표 확인 질문 (2026-11-20, MCP ask_brief, 작업 토큰): 대표가 맡은 대화 회차에서 핵심을 묻고 소식(question)을 남긴다.
   * 물을 수 있는 회차인지는 TurnBrief (바로 앞 회차가 물었으면 이 회차는 그 답이라 묻지 않는다). 잠그는 순서는 작업 → (대화는 쓰기만)
   */
  async askBrief(actor: Actor, req: AskBriefInput): Promise<BriefAskedView> {
    actor.assertCan(Actor.AGENT);
    if (!(actor instanceof AgentActor) || !actor.spaceId || !actor.id)
      throw new Forbidden(Actor.AGENT);
    const { spaceId, id: agentId, taskId } = actor;
    const now = new Date();
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const task = await tasks.lockById(taskId);
      const lead = await new AgentRepository(tx).findLead(spaceId);
      if (task?.spaceId !== spaceId || task.agentId !== agentId || lead?.id !== agentId)
        throw new Forbidden(Actor.AGENT, '대화 회차를 맡은 대표만 물어요');
      if (!task.open) throw new Conflict('끝난 회차예요');
      const chats = new ChatRepository(tx);
      const place = await chats.placeOf(taskId);
      if (!place) throw new Forbidden(Actor.AGENT, '대화 회차를 맡은 대표만 물어요');
      const previous = await chats.previousTurnPayload(spaceId, place.chat_id, taskId);
      task.declare((p) => TurnBrief.declare(p, req.brief, TurnBrief.asked(previous)));
      await tasks.save(task);
      const chat = await chats.load(spaceId, place.chat_id);
      chat.note('question', TurnBrief.news(req.brief), taskId, agentId, now);
      await chats.save(chat);
      return new BriefAskedView(req.brief.questions.length);
    });
  }
}
