import { BaseRequest, RuleViolation } from '../../platform';
import { type LedgerEntry, ProgressLedger } from '../task/progress-ledger.policy';
import { ChatUpdates } from './chat-update.policy';
import { DecisionNote, type DecisionNoteRow } from './decision-note.policy';
import { TurnBrief, type TurnBriefRow } from './turn-brief.policy';
import { TurnDeliver } from './turn-deliver.policy';

// 대화의 소식 도구 입력의 모양 (docs/API설계.md 4장). 뜻(대화의 일인지, 한도)은 Chat · Service가 본다.

/** MCP agent_updates { chat_id?, project?, after?, wait_seconds? } */
export class AgentUpdatesInput extends BaseRequest {
  static readonly WAIT_MAX = 25;
  /** 커서의 끝 (bigint identity. JS 정수로 다룰 수 있는 범위) */
  private static readonly CURSOR_MAX = Number.MAX_SAFE_INTEGER;

  private constructor(
    readonly chatId: string | null,
    /** git 주소 그대로 (ChatProject가 맞춘다) */
    readonly project: string | null,
    readonly after: number | null,
    readonly waitSeconds: number,
  ) {
    super();
  }

  static from(raw: unknown): AgentUpdatesInput {
    const body = (raw ?? {}) as Record<string, unknown>;
    const after = body.after;
    // 잘못된 커서는 모양 오류(400)가 아니라 규칙 위반(422): 훅이 지난 커서를 그대로 보내는 경우와 같게 다룬다
    if (
      after !== undefined &&
      after !== null &&
      (!Number.isSafeInteger(after) || Number(after) < 0)
    )
      throw new RuleViolation('커서는 0 이상의 정수예요 (지난 답의 cursor)');
    return BaseRequest.read(
      raw,
      (f) =>
        new AgentUpdatesInput(
          body.chat_id === undefined || body.chat_id === null ? null : f.uuid('chat_id'),
          f.optionalText('project', 400),
          f.optionalInteger('after', 0, AgentUpdatesInput.CURSOR_MAX),
          f.optionalInteger('wait_seconds', 0, AgentUpdatesInput.WAIT_MAX) ?? 0,
        ),
    );
  }
}

/** MCP post_update { kind, text, decision? } (작업 토큰). decision은 판단의 모양 (L1, kind decision에만, DecisionNote. confirm · wait_minutes는 L3) */
export class PostUpdateInput extends BaseRequest {
  private constructor(
    readonly kind: string,
    readonly text: string,
    readonly decision: DecisionNoteRow | null,
  ) {
    super();
  }

  static from(raw: unknown): PostUpdateInput {
    const given = (raw as { decision?: unknown } | null)?.decision;
    return BaseRequest.read(raw, (f) => {
      const D = DecisionNote;
      const d = given === undefined || given === null ? null : f.nested('decision');
      const decision =
        d === null
          ? null
          : {
              chosen: d.text('chosen', D.CHOSEN_MAX).trim(),
              alternatives: (
                d.optionalTextList('alternatives', D.ALTERNATIVES_MAX, D.ALTERNATIVE_MAX) ?? []
              )
                .map((a) => a.trim())
                .filter(Boolean),
              why: d.optionalText('why', D.WHY_MAX)?.trim() ?? '',
              weight: d.optionalText('weight', 10) ?? 'medium',
              step: d.optionalText('step', D.STEP_MAX)?.trim() || null,
              confirm: d.optionalText('confirm', 20) ?? null,
              wait_minutes:
                d.optionalInteger('wait_minutes', D.WAIT_MIN, D.WAIT_MAX) ?? D.WAIT_DEFAULT,
            };
      return new PostUpdateInput(
        f.text('kind', 40),
        f.text('text', ChatUpdates.TEXT_MAX),
        decision,
      );
    });
  }
}

/**
 * MCP set_deliver { deliver, note? } (O-3, 작업 토큰): 대표가 이번 회차의 받을 것을 정한다.
 * 값의 목록 · 겹침 · 관리자가 정한 값은 TurnDeliver가 본다
 */
export class SetDeliverInput extends BaseRequest {
  private constructor(
    readonly deliver: string,
    readonly note: string | null,
  ) {
    super();
  }

  static from(raw: unknown): SetDeliverInput {
    return BaseRequest.read(
      raw,
      (f) =>
        new SetDeliverInput(
          f.text('deliver', 20),
          f.optionalText('note', TurnDeliver.NOTE_MAX) ?? null,
        ),
    );
  }
}

/**
 * MCP ask_brief { summary, questions: [{ text, why, choices?, suggested }] } (2026-11-20 목표 확인, 작업 토큰):
 * 대표가 결과물 일을 맡기 전에 핵심을 묻는다. 물을 수 있는 회차인지는 TurnBrief가 본다
 */
export class AskBriefInput extends BaseRequest {
  private constructor(readonly brief: TurnBriefRow) {
    super();
  }

  static from(raw: unknown): AskBriefInput {
    return BaseRequest.read(raw, (f) => {
      const questions = f.nestedList('questions', TurnBrief.QUESTIONS_MAX).map((q) => ({
        text: q.text('text', TurnBrief.TEXT_MAX).trim(),
        why: q.optionalText('why', TurnBrief.TEXT_MAX)?.trim() ?? '',
        choices: (q.optionalTextList('choices', TurnBrief.CHOICES_MAX, TurnBrief.CHOICE_MAX) ?? [])
          .map((c) => c.trim())
          .filter(Boolean),
        suggested: q.text('suggested', TurnBrief.TEXT_MAX).trim(),
      }));
      return new AskBriefInput({
        summary: f.text('summary', TurnBrief.SUMMARY_MAX).trim(),
        questions,
      });
    });
  }
}

/**
 * MCP note_progress { done, progressing, looping, next, why } (2026-11-28 진행 장부, 작업 토큰):
 * 대표가 하위 작업 결과를 받고 깬 실행에서 다음 동작 전에 남기는 한 줄 판단 (ProgressLedger)
 */
export class NoteProgressInput extends BaseRequest {
  private constructor(readonly entry: LedgerEntry) {
    super();
  }

  static from(raw: unknown): NoteProgressInput {
    return BaseRequest.read(
      raw,
      (f) =>
        new NoteProgressInput({
          done: f.boolean('done'),
          progressing: f.boolean('progressing'),
          looping: f.boolean('looping'),
          next: f.text('next', ProgressLedger.NEXT_MAX).trim(),
          why: f.optionalText('why', ProgressLedger.WHY_MAX)?.trim() ?? '',
        }),
    );
  }
}
