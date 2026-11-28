import { ChangeSignal, TableRepository } from '../../platform';
import { Task } from '../task/task';
import { chats, chatUpdates } from '../task.schema';
import type { ChatRow, TaskRow } from '../task.tables';
import { Chat } from './chat';
import { ChatHistory, type ChatTurnRow } from './chat-history.policy';
import type { PlanChildRow } from './chat-plan.policy';
import { ChatRequest } from './chat-request.policy';
import type { ChatTurnStateRow } from './chat-result.policy';
import { type ChatPlaceRow, ChatUpdates } from './chat-update.policy';

// task.chats ↔ Chat. 불러오기 · 잠그기 · 저장은 기반이 한다. 소식(task.chat_updates)은 saveParts로 함께 넣는다 (추가만).
// 앞 회차(작업)는 이 대화의 회차 request_id로만 읽는다: 작업 쪽에 대화를 가리키는 칸을 두지 않는다 (목표 실행과 같다).
export class ChatRepository extends TableRepository<ChatRow, Chat> {
  protected readonly table = chats;
  protected readonly noun = '대화';
  /** 콘솔이 보내는 요청 id (crypto.randomUUID). 기능 패키지는 이 모양을 쓰지 못한다 (ChatTalk.fromPlugin) */
  static readonly CONSOLE_REQUEST =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  protected toEntity(row: ChatRow): Chat {
    return Chat.restore(row);
  }

  /** 같은 requestId로 이미 만든 대화 (응답을 놓쳐 다시 누른 것) */
  findByRequest(spaceId: string, requestId: string): Promise<Chat | null> {
    return this.findOne({ space_id: spaceId, request_id: requestId });
  }

  /** 이전 대화를 만들 앞 회차들 (최근 ChatHistory.TURNS개, 오래된 것부터) */
  previousTurns(chat: Chat, spaceId: string): Promise<ChatTurnRow[]> {
    const ids = ChatRequest.turns(chat.id, chat.turns - ChatHistory.TURNS + 1, chat.turns);
    if (ids.length === 0) return Promise.resolve([]);
    return this.sql<ChatTurnRow[]>`
      SELECT id, instruction, result, status, wait_reason, payload FROM task.tasks
      WHERE space_id = ${spaceId} AND request_id = ANY(${ids}::text[])
      ORDER BY created_at, id`;
  }

  /** 결재 하나의 검수 작업들: 첫 검수자의 것이 먼저, 두 번째 검수자(2026-11-20)의 것이 다음 */
  inspections(
    spaceId: string,
    chatId: string,
    approvalId: string,
  ): Promise<Pick<TaskRow, 'id' | 'agent_id' | 'status' | 'result'>[]> {
    const ids = [false, true].map((second) => ChatRequest.review(chatId, 0, approvalId, second));
    return this.sql<Pick<TaskRow, 'id' | 'agent_id' | 'status' | 'result'>[]>`
      SELECT id, agent_id, status, result FROM task.tasks
      WHERE space_id = ${spaceId} AND request_id = ANY(${ids}::text[])
      ORDER BY request_id`;
  }

  /**
   * 관리자가 콘솔에서 이 대화로 보낸 말 (2026-11-24 OwnerAsk): 회차 · 덧붙인 말의 답 작업의 지시 중 요청 id가 콘솔의 UUID인 것만.
   * 기기(via) · 서버가 연 회차(fix) · 자동화(schedule:) · 기능 패키지(텔레그램 telegram:, 패키지는 UUID 모양을 쓰지 못한다)는 빠진다
   */
  async ownerWords(spaceId: string, chatId: string, since: Date): Promise<string[]> {
    const prefix = `${ChatRequest.TURN_PREFIX}${chatId}:`;
    const rows = await this.sql<Pick<TaskRow, 'instruction'>[]>`
      SELECT instruction FROM task.tasks
      WHERE space_id = ${spaceId} AND request_id LIKE ${`${prefix}%`}
        AND substr(request_id, ${prefix.length + 1}) ~ '^[0-9]+(:reply:[0-9]+)?$'
        AND payload->'chat'->>'via' IS NULL AND payload->'chat'->>'fix' IS NULL
        AND payload->'chat'->>'requestId' ~ ${ChatRepository.CONSOLE_REQUEST}
        AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT 50`;
    return rows.map((r) => r.instruction);
  }

  /** 이 회차 작업에 쌓인 그 종류의 소식 수 (덧붙인 말 · post_update의 한도) */
  async countUpdates(taskId: string, kinds: readonly string[]): Promise<number> {
    const [row] = await this.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM task.chat_updates
      WHERE task_id = ${taskId} AND kind = ANY(${kinds as string[]}::text[])`;
    return row?.count ?? 0;
  }

  /**
   * 이 작업이 post_update · note_progress로 남긴 소식의 수. 진행 장부(data.ledger, 2026-11-28)와 그 밖의 소식은
   * 한도를 따로 센다 (장부가 중간 보고의 자리를 먹지 않게)
   */
  async countPosted(taskId: string, ledger: boolean): Promise<number> {
    const [row] = await this.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM task.chat_updates
      WHERE task_id = ${taskId} AND kind = ANY(${ChatUpdates.POSTED as string[]}::text[])
        AND coalesce(data ? 'ledger', false) = ${ledger}`;
    return row?.count ?? 0;
  }

  /** 이 작업이 그 종류의 소식을 이미 남겼는가 (끝남 소식이 두 번 쌓이지 않게) */
  async hasUpdate(taskId: string, kind: string): Promise<boolean> {
    return (await this.countUpdates(taskId, [kind])) > 0;
  }

  /**
   * 작업이 속한 대화: 위 작업(parent_id)을 따라 맨 위까지 올라가 그 작업의 payload.chat.chatId를 본다.
   * 대화의 일이 아니면 null. 맨 위는 회차 작업이나 덧붙인 말에 답하는 작업이다
   */
  async placeOf(taskId: string): Promise<ChatPlaceRow | null> {
    const [row] = await this.sql<ChatPlaceRow[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 0 AS step FROM task.tasks WHERE id = ${taskId}
        UNION ALL
        SELECT t.id, t.parent_id, up.step + 1 FROM task.tasks t JOIN up ON t.id = up.parent_id
        WHERE up.step < 10
      )
      SELECT t.id, t.status, t.result, t.title, t.agent_id, t.payload, t.space_id,
        root.id AS root_id, root.payload->'chat'->>'chatId' AS chat_id
      FROM task.tasks t
      JOIN LATERAL (SELECT id FROM up ORDER BY step DESC LIMIT 1) top ON true
      JOIN task.tasks root ON root.id = top.id
      WHERE t.id = ${taskId} AND root.payload->'chat'->>'chatId' IS NOT NULL`;
    return row ?? null;
  }

  /**
   * 계획 판단(D3, ChatPlan)에 쓸 것: 위 작업의 상태 · payload, 바로 아래 하위 작업과 받은 일꾼의 이름, 공간의 일꾼 이름
   * (앞 단계를 기다리는 하위 작업의 일꾼), 이 작업이 앞서 남긴 계획 판단의 수(planned 중 가장 큰 것)
   */
  async planOf(spaceId: string, taskId: string) {
    const [parent] = await this.sql<
      Pick<TaskRow, 'status' | 'wait_reason' | 'payload' | 'agent_id'>[]
    >`
      SELECT status, wait_reason, payload, agent_id FROM task.tasks
      WHERE space_id = ${spaceId} AND id = ${taskId}`;
    const children = await this.sql<PlanChildRow[]>`
      SELECT t.title, t.agent_id, a.name AS agent_name FROM task.tasks t
      LEFT JOIN task.agents a ON a.id = t.agent_id
      WHERE t.parent_id = ${taskId} ORDER BY t.created_at, t.id`;
    const agents = await this.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM task.agents WHERE space_id = ${spaceId}`;
    const [noted] = await this.sql<{ n: number }[]>`
      SELECT coalesce(max((data->>'planned')::int), 0) AS n FROM task.chat_updates
      WHERE task_id = ${taskId} AND kind = 'decision' AND data ? 'planned'`;
    return {
      parent: parent ?? null,
      children,
      names: new Map(agents.map((a) => [a.id, a.name])),
      noted: noted?.n ?? 0,
    };
  }

  /** 이 회차 작업의 바로 앞 회차의 payload (목표 확인 질문을 했는가, TurnBrief). 첫 회차 · 앞 회차가 없으면 null */
  async previousTurnPayload(spaceId: string, chatId: string, taskId: string): Promise<unknown> {
    const [row] = await this.sql<Pick<TaskRow, 'payload'>[]>`
      SELECT prev.payload FROM task.tasks cur
      JOIN task.tasks prev ON prev.space_id = cur.space_id
        AND prev.request_id = ${ChatRequest.TURN_PREFIX} || ${chatId} || ':'
          || ((cur.payload->'chat'->>'turn')::int - 1)::text
      WHERE cur.id = ${taskId} AND cur.space_id = ${spaceId}`;
    return row?.payload ?? null;
  }

  /**
   * 대화의 일이 아직 도는가 (결과 카드 전, 2차 2단계): 대화의 맨 위 작업들(회차 · 덧붙인 말의 답 · 검토)과 그 아래에서
   * 대기 · 실행 중이거나, 카드에 싣지 않는 결재(바로 알리는 동작)를 기다리는 작업이 있으면 돈다.
   * 하위 작업을 기다리는 작업은 세지 않는다 (그 하위 작업이 센다)
   */
  async busy(chat: Chat): Promise<boolean> {
    const [row] = await this.sql<{ busy: boolean }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM task.tasks
        WHERE space_id = ${chat.spaceId} AND request_id LIKE ${`${ChatRequest.TURN_PREFIX}${chat.id}:%`}
        UNION ALL
        SELECT t.id FROM task.tasks t JOIN tree ON t.parent_id = tree.id
      )
      SELECT EXISTS (
        SELECT 1 FROM task.tasks t WHERE t.id IN (SELECT id FROM tree)
          AND (t.status IN (${Task.QUEUED}, ${Task.RUNNING})
            OR (t.status = ${Task.WAITING} AND t.wait_reason = ${Task.WAIT_APPROVAL}
              AND EXISTS (SELECT 1 FROM task.approvals a
                WHERE a.task_id = t.id AND a.status = 'pending' AND a.chat_id IS NULL)))
      ) AS busy`;
    return Boolean(row?.busy);
  }

  /** 지금 회차의 맨 위 작업(상태 · 지시 · 결과)과 그 회차의 검토 작업 */
  async turnState(chat: Chat): Promise<ChatTurnStateRow> {
    const turn = ChatRequest.turn(chat.id, chat.turns);
    const [row] = await this.sql<ChatTurnStateRow[]>`
      SELECT root.status, root.payload, root.instruction, root.result,
        review.status AS review_status, review.result AS review_result
      FROM (SELECT 1) one
      LEFT JOIN task.tasks root ON root.space_id = ${chat.spaceId} AND root.request_id = ${turn}
      LEFT JOIN task.tasks review
        ON review.space_id = ${chat.spaceId} AND review.request_id = ${ChatRequest.review(chat.id, chat.turns)}`;
    return (
      row ?? {
        status: null,
        payload: null,
        instruction: null,
        result: null,
        review_status: null,
        review_result: null,
      }
    );
  }

  /**
   * 이번 회차(맨 위 회차 작업과 그 아래)에서 앱 코드 만들기 일(payload.appCode)이 끝났는가 (스토어 2-6).
   * 비공개 앱의 새 버전은 승인 없이 바로 보여서 받을 것 app_code의 증거가 이것뿐이다
   */
  async madeAppCode(chat: Chat): Promise<boolean> {
    const [row] = await this.sql<{ made: boolean }[]>`
      WITH RECURSIVE tree AS (
        SELECT id, status, payload FROM task.tasks
        WHERE space_id = ${chat.spaceId} AND request_id = ${ChatRequest.turn(chat.id, chat.turns)}
        UNION ALL
        SELECT t.id, t.status, t.payload FROM task.tasks t JOIN tree ON t.parent_id = tree.id
      )
      SELECT EXISTS (SELECT 1 FROM tree WHERE status = ${Task.DONE} AND payload ? 'appCode') AS made`;
    return row?.made === true;
  }

  /** 쌓은 소식의 번호 (커서). 저장한 뒤에 읽는다 */
  async numberOf(updateId: string): Promise<number> {
    const [row] = await this.sql<{ n: string }[]>`
      SELECT n FROM task.chat_updates WHERE id = ${updateId}`;
    return Number(row?.n ?? 0);
  }

  protected override async saveParts(chat: Chat): Promise<void> {
    const rows = chat.addedUpdates;
    if (rows.length === 0) return;
    // choices(질문의 고를 에이전트)는 O-2 전 대화의 기록에만 있다: 새 줄에는 적지 않는다
    await this.insertRows(
      chatUpdates,
      rows.map(({ choices: _none, ...row }) => row),
    );
    await ChangeSignal.send(this.sql, [new ChangeSignal(chat.spaceId, ChatUpdates.TOPIC, chat.id)]);
  }
}
