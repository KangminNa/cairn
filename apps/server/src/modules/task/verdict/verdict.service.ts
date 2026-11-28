import { Injectable } from '@nestjs/common';
import { type Actor, BaseService, Forbidden, type Sql, SystemActor } from '../../platform';
import { ApprovalRepository } from '../approval/approval.repository';
import { ChatRepository } from '../chat/chat.repository';
import type { ChatReviewVerdict } from '../chat/chat.view';
import { ChatInspect } from '../chat/chat-inspect.policy';
import { ChatResult } from '../chat/chat-result.policy';
import { ChatReview } from '../chat/chat-review.policy';
import { LearnedRuleRepository } from '../rule/rule.repository';
import { RuleMarks } from '../rule/rule-marks.policy';
import { Task } from '../task/task';
import { Verdict } from './verdict';
import { VerdictRepository } from './verdict.repository';

// 판정 남기기 (2026-11-20 평가가 남는 팀): 검토 · 검수 작업이 끝나면(완료) 그 판정을 점수와 함께 쌓는다.
// 판정에 따라 다음을 정하는 일(ChatResultService · ChatInspectService)과 따로 돈다: 기록일 뿐이라 늦거나 빠져도 결재 흐름은 같다.
// 두 번 불려도 판정 작업마다 한 번이다 (VerdictRepository.judged + UNIQUE(task_id, agent_id))
@Injectable()
export class VerdictService extends BaseService {
  /** 작업 하나가 끝났다. 끝난 검토 · 검수 작업이 아니면 아무것도 하지 않는다 */
  async record(actor: Actor, spaceId: string, taskId: string): Promise<number> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    const now = new Date();
    return this.transaction(async (tx) => {
      const verdicts = new VerdictRepository(tx);
      const judge = await new ChatRepository(tx).placeOf(taskId);
      const chat = (
        judge?.payload as { chat?: { chatId?: unknown; turn?: unknown; review?: unknown } }
      )?.chat;
      if (!judge || judge.status !== Task.DONE || chat?.review !== true) return 0;
      if (await verdicts.judged(spaceId, taskId)) return 0;
      const text = ChatResult.textOf(judge.result);
      const review = ChatReview.parse(text);
      const approvalId = ChatInspect.approvalOf(judge.payload);
      const rows: Verdict[] = [];
      // 판정받은 일 (검수는 결재를 올린 작업, 검토는 그 회차): 그 아래가 따른 배운 규칙을 센다 (2026-11-28)
      let judged: string | null = null;
      if (approvalId !== null) {
        const approvals = new ApprovalRepository(tx);
        const approval = await approvals.findIn(spaceId, approvalId);
        if (!approval?.chatId || approval.agentId === null) return 0;
        // 앞서 검수자가 고쳐 달라고 한 결재 수 + 1 (이번 결재는 빼고, 먼저 만든 것만: 처리 순서와 상관없게)
        const before = (await approvals.inspectorFixes(approval)).filter((a) => a.id < approval.id);
        judged = approval.taskId;
        const target = Verdict.inspectTarget(approval.chatId, approval.action, approval.targetId);
        rows.push(
          Verdict.of(
            spaceId,
            taskId,
            approval.agentId,
            Verdict.INSPECT,
            target,
            before.length + 1,
            review,
            now,
          ),
        );
      } else if (typeof chat.chatId === 'string' && typeof chat.turn === 'number') {
        const turn = await verdicts.turnOf(spaceId, chat.chatId, chat.turn);
        if (!turn) return 0;
        const fixBy = (turn.payload as { chat?: { fixBy?: unknown } } | null)?.chat?.fixBy;
        const fixed = fixBy === ChatResult.BY_REVIEW;
        judged = turn.id;
        const target = Verdict.reviewTarget(chat.chatId, chat.turn, fixed);
        const members =
          turn.members.length > 0 ? turn.members : turn.agent_id ? [turn.agent_id] : [];
        for (const agentId of members)
          rows.push(
            Verdict.of(
              spaceId,
              taskId,
              agentId,
              Verdict.REVIEW,
              target,
              fixed ? 2 : 1,
              review,
              now,
            ),
          );
      }
      for (const row of rows) await verdicts.save(row);
      if (judged !== null)
        await VerdictService.markRules(tx, spaceId, taskId, judged, review, text);
      return rows.length;
    });
  }

  /** 판정 하나로 배운 규칙을 센다: 검토자가 적은 표시, 통과면 따른 규칙마다 도움 (RuleMarks.ofVerdict) */
  private static async markRules(
    tx: Sql,
    spaceId: string,
    judgeTaskId: string,
    judged: string,
    review: ChatReviewVerdict,
    text: string,
  ): Promise<void> {
    const rules = new LearnedRuleRepository(tx);
    const marks = RuleMarks.ofVerdict(
      await rules.followedIn(spaceId, judged),
      review.verdict === ChatReview.PASS,
      RuleMarks.fromReview(text),
    );
    await rules.mark(spaceId, RuleMarks.verdictSource(judgeTaskId), marks, judged);
  }
}
