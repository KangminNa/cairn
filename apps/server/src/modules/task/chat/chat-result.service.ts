import { Injectable } from '@nestjs/common';
import {
  ActionChecks,
  type Actor,
  BaseService,
  Database,
  Forbidden,
  Idempotency,
  SystemActor,
} from '../../platform';
import type { Agent } from '../agent/agent';
import { AgentRepository } from '../agent/agent.repository';
import { AppApproval } from '../approval/app-approval.policy';
import { Approval } from '../approval/approval';
import { ApprovalRepository } from '../approval/approval.repository';
import { OutputRepository } from '../output/output.repository';
import { LearnedRuleRepository } from '../rule/rule.repository';
import { SkillQuery } from '../skill/skill.query';
import { Task } from '../task/task';
import { TaskRepository } from '../task/task.repository';
import { TaskPlan } from '../task/task-plan.policy';
import type { AppCodeAddedInput } from './chat.input';
import { ChatRepository } from './chat.repository';
import { ChatInspect } from './chat-inspect.policy';
import { ChatRequest } from './chat-request.policy';
import { ChatResult } from './chat-result.policy';
import { ChatReview } from './chat-review.policy';
import { TurnDeliver } from './turn-deliver.policy';

// 결과 결재 (2차 2단계 · 기획서 결정 2026-11-14): 대화의 일이 바뀔 때마다(작업 상태 · 결재 요청) 회차가 가라앉았는지 보고
// 다음 하나를 한다: 받을 것이 없으면 다시 맡김(result-check) · 검토자 짝의 검토(result-review) ·
// 검토가 고칠 것을 남겼으면 한 번 다시 맡김(result-fix, 검증 고리 V) · 결과 카드.
// 받을 것이 있어도 동작의 대상을 가진 모듈이 빠진 점을 짚으면(platform ActionChecks, 2차 6단계) 다시 맡긴다.
// 카드에 실을 때 같은 이름의 결과물은 마지막 것만 싣고 앞의 것은 휴지통으로 (다시 맡긴 회차가 고쳐 낸 것, 검증 고리 V).
// 카드 · 실린 결재 · 결과물은 함께 바뀌어야 해서 같은 트랜잭션에서 여러 묶음을 쓴다 (ApprovalService와 같은 까닭).
// 대화를 먼저 잠가 같은 대화의 판단은 하나씩 한다. 잠그는 순서: 대화 → 결재 → 결과물.
// 카드의 결정(고른 것만 남기기)은 ApprovalService.decide, 수정 요청 · 반려 뒤의 정리는 ChatService.closeByCard.
// 검수 (2026-11-20, ChatInspect): 대표가 검수 승인을 켰으면 앱 안의 공개는 카드보다 먼저 검수 작업을 연다 (결재마다 하나).
// 검수가 도는 동안은 대화가 돌고(busy), 검수 반영(ChatInspectService)이 정한 뒤 다시 와서 남은 것만 카드에 싣는다
@Injectable()
export class ChatResultService extends BaseService {
  private static readonly APP_CODE = 'app_code_card';

  constructor(
    db: Database,
    private readonly skills: SkillQuery,
    private readonly checks: ActionChecks,
  ) {
    super(db);
  }

  /**
   * 작업 하나가 바뀌었다(taskId), 또는 대화의 결재가 바뀌었다(chatId: 작업에 묶이지 않은 앱 화면 공개 · 검수).
   * 대화의 일이 아니면 아무것도 하지 않는다. 두 번 불려도 같다 (카드는 대화마다 하나, 일은 request_id로 하나)
   */
  async settle(
    actor: Actor,
    spaceId: string,
    taskId: string | null,
    chatOfEvent: string | null = null,
  ): Promise<void> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    const chatId =
      chatOfEvent ??
      (taskId ? await this.transaction((tx) => new TaskRepository(tx).chatOf(taskId)) : null);
    if (chatId === null) return;
    const prompts = await this.skills.prompts(actor, spaceId);
    const now = new Date();
    await this.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const chat = await chats.lock(spaceId, chatId);
      // 휴지통의 대화(2026-11-19 휴지통 A)는 다시 맡기거나 카드를 만들지 않는다
      if (chat.agentId === null || chat.trashed || (await chats.busy(chat))) return;
      const approvals = new ApprovalRepository(tx);
      const outputs = new OutputRepository(tx);
      const actions = await approvals.lockUncarded(chat.id);
      const open = await approvals.lockOpenCard(chat.id);
      const made = await outputs.uncardedInChat(spaceId, chat.id);
      const turn = await chats.turnState(chat);
      const previous = await chats.previousTurns(chat, spaceId);
      const agents = await new AgentRepository(tx).all(spaceId);
      const partner = agents.find((a) => a.id === chat.agentId);
      const reviewer = agents.find((a) => a.id === partner?.reviewerId && !a.deleted) ?? null;
      const tasks = new TaskRepository(tx);
      const inspector = partner?.reviewerApproves ? reviewer : null;
      // 두 번째 검수자 (2026-11-20, 선택): 있으면 둘 다 따로 검수한다
      const second = agents.find((a) => a.id === partner?.secondInspectorId && !a.deleted) ?? null;
      const inspectors = [inspector, second].filter((a): a is Agent => a !== null);
      const due = inspector ? actions.filter((a) => ChatInspect.due(a, inspectors)) : [];
      if (inspector && due.length > 0) {
        for (const approval of due) {
          const fixed = await approvals.inspectorFixes(approval);
          const fields = {
            ...ChatInspect.fields(approval, chat.goal, turn.instruction ?? '', fixed),
            ...TaskPlan.fields(TaskPlan.inTurns(previous)),
          };
          const instruction = prompts.fill('result-inspect', fields);
          await tasks.insertOnce(chat.review(inspector, instruction, now, approval));
          if (second) await tasks.insertOnce(chat.review(second, instruction, now, approval, true));
        }
        return;
      }
      // 받을 것: 대표가 회차에 정한 값, 없으면 대화의 값 (O-3, TurnDeliver).
      // 받을 것이 있어도 그 동작의 대상을 가진 모듈이 짚는 빠진 점 (2차 6단계: 메뉴에 올리지 않은 글의 발행)
      const deliver = TurnDeliver.effective(turn.payload, chat.deliver);
      const problems = deliver
        ? await this.checks.problemsOf(
            actor,
            actions.map((a) => ({ action: a.action, targetId: a.targetId })),
          )
        : [];
      // 비공개 앱의 앱 코드는 결재 없이 보여서 이번 회차의 끝난 앱 코드 일을 본다 (스토어 2-6)
      const order = ChatResult.countsMade(deliver);
      const orders = order !== null && (await chats.madeAppCode(chat)) ? [order] : [];
      const missing =
        ChatResult.missing(
          deliver,
          actions.map((a) => a.action),
          made.map((o) => o.name),
          orders,
        ) ?? (problems.length > 0 ? deliver : null);
      const review =
        turn.review_status === Task.DONE
          ? ChatReview.parse(ChatResult.textOf(turn.review_result))
          : null;
      const step = ChatResult.next({
        root: turn.status,
        items: actions.length + made.length,
        missing: missing !== null,
        // 이 회차가 기다리는 카드에 실렸거나, 실린 카드를 이미 정했다 (O-3: 승인한 결재를 기다리던 회차가 끝난 뒤)
        carded:
          (open !== null && open.targetVersion === chat.turns) ||
          (await approvals.cardDecided(chat.id, chat.turns)),
        fixes: ChatResult.fixesIn(previous),
        reviewFixes: ChatResult.fixesIn(previous, ChatResult.BY_REVIEW),
        reviewer: reviewer !== null,
        reviewed: turn.review_status !== null,
        review,
      });
      if (step === ChatResult.FIX && partner && missing) {
        const message = prompts.fill('result-check', {
          deliver: missing,
          need: problems.length > 0 ? problems.join(' · ') : ChatResult.needOf(missing),
        });
        const label = TurnDeliver.label(missing);
        const note =
          problems.length > 0
            ? `받을 것(${label})에 빠진 점이 있어 다시 맡김`
            : `받을 것(${label})이 없어 다시 맡김`;
        const task = chat.fix(partner, message, previous, now, { note });
        await chats.save(chat);
        await tasks.insertOnce(task);
      } else if (step === ChatResult.REVIEW_FIX && partner && review) {
        const message = prompts.fill('result-fix', ChatReview.fixFields(review));
        const note = `검토자가 고칠 것 ${review.fixes.length}개를 남겨 다시 맡김`;
        const task = chat.fix(partner, message, previous, now, { by: ChatResult.BY_REVIEW, note });
        await chats.save(chat);
        await tasks.insertOnce(task);
      } else if (step === ChatResult.REVIEW && reviewer) {
        const items = [...actions.map((a) => a.action), ...made.map((o) => o.name)];
        // 팀이 따른 배운 규칙 (2026-11-28): 검토자가 규칙마다 도움 · 해로움을 적는다 (RuleMarks.fromReview)
        const followed = await new LearnedRuleRepository(tx).followedInTurn(
          spaceId,
          ChatRequest.turn(chat.id, chat.turns),
        );
        const instruction = prompts.fill('result-review', {
          rules: followed.map((r) => `- [R${r.seq}] ${r.body}`).join('\n') || null,
          goal: chat.goal,
          message: turn.instruction ?? '',
          answer: ChatResult.textOf(turn.result) || '-',
          items: items.map((name) => `- ${name}`).join('\n') || null,
          ...TaskPlan.fields(TaskPlan.inTurns(previous)),
        });
        await tasks.insertOnce(chat.review(reviewer, instruction, now));
      } else if (step === ChatResult.CARD) {
        const card = open ?? Approval.forChat(spaceId, chat.id, chat.partnerId, chat.turns, now);
        if (open) open.grew(chat.turns);
        await approvals.save(card);
        for (const action of actions) {
          action.bundleInto(card);
          await approvals.save(action);
        }
        // 다시 맡긴 회차가 있을 때만: 한 회차 안의 같은 이름(다른 팀원이 각자 낸 index.html 등)은 그대로 싣는다
        const replaced = new Set(
          ChatResult.fixesIn(previous) > 0 ? ChatResult.superseded(made).map((o) => o.id) : [],
        );
        for (const output of made) {
          if (replaced.has(output.id)) output.trash(now);
          else output.bundleInto(card.id);
          await outputs.save(output);
        }
      }
    });
  }

  /**
   * 대화의 만들기 일이 낸 앱 코드가 확인 대기 버전이 됐다 (blog.app_code.added, 스토어 1-6b): 그 대화의 결과 카드에
   * 공개 승인(AppApproval.forAppCode)을 싣는다. 관리자가 이 대화에서 그 앱의 배포 · 수정을 요청했으면 바로 승인한다. 결재 요청이 다시 settle을 불러 카드에 실린다. 대화의 일이 아니거나
   * 바로 보인 버전(비공개 앱)이면 아무것도 하지 않는다 (알림과 코드 탭이 맡는다). 같은 버전이 두 번 와도 결재는 하나
   */
  async offerAppCode(actor: Actor, spaceId: string, req: AppCodeAddedInput): Promise<void> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    if (!req.offered || req.taskId === null) return;
    const taskId = req.taskId;
    const now = new Date();
    await this.transaction(async (tx) => {
      const chatId = await new TaskRepository(tx).chatOf(taskId);
      if (chatId === null) return;
      const chat = await new ChatRepository(tx).lock(spaceId, chatId);
      if (chat.trashed) return;
      const once = new Idempotency(
        tx,
        spaceId,
        `${req.appId}:${req.seq}`,
        ChatResultService.APP_CODE,
      );
      if (await once.previous()) return;
      const approval = AppApproval.forAppCode(spaceId, chat.id, chat.partnerId, req, now);
      // 관리자가 이 대화에서 그 앱의 배포 · 수정을 요청했으면 (24시간 안) 기다리지 않고 바로 반영한다 (2026-11-24)
      const approvals = new ApprovalRepository(tx);
      const asked = await approvals.askedFor(chat.id, req.appId, AppApproval.askedSince(now));
      if (asked !== null) approval.grantAsked(chat.partnerId, asked, now);
      await approvals.save(approval);
      await once.remember({ approvalId: approval.id });
    });
  }
}
