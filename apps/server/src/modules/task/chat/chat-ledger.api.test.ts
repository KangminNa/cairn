import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ApiClient, type ApiResult, type TestUser } from '../../../testing/api-client';
import { Database, OutboxWorker } from '../../platform';

// 진행 장부 (2026-11-28, MCP note_progress): 대표가 깬 실행마다 끝났나 · 나아지나 · 맴도나 · 다음을 남긴다.
// 진전 없음이 3번 이어지면 replan이 켜지고 set_plan을 한 번 더 받는다 (단계만, 완료 조건은 그대로)

// biome-ignore lint/suspicious/noExplicitAny: 응답 JSON을 여러 겹 읽는 테스트 (모양은 assert가 본다)
type Json = Record<string, any>;

let api: ApiClient;
let owner: TestUser;
let db: Database;
let worker: OutboxWorker;
let runner: string;

function ok(res: ApiResult, status = 200): Json {
  assert.equal(res.status, status, res.text);
  return res.json();
}

async function drain(): Promise<void> {
  for (let i = 0; i < 200 && (await worker.tick()) > 0; i++);
}

const call = (token: string, name: string, args: Json = {}) =>
  api.mcp(token, 'tools/call', { name, arguments: args });

async function tool(token: string, name: string, args: Json = {}): Promise<Json> {
  const res = await call(token, name, args);
  assert.equal(res.status, 200, res.text);
  const result = res.json().result as { isError?: boolean; structuredContent?: Json };
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? {};
}

async function refused(token: string, name: string, args: Json = {}): Promise<string> {
  const res = await call(token, name, args);
  const result = (res.json() as Json).result;
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.stringify(result.content);
}

async function turnOf(chatId: string): Promise<Json> {
  const jobs: Json[] = (await tool(runner, 'next_jobs', { limit: 5 })).jobs ?? [];
  const job = jobs.find((j) => j.task.payload.chat?.chatId === chatId);
  assert.ok(job, '회차가 빌려지지 않았다');
  return job;
}

const stall = {
  done: false,
  progressing: false,
  looping: true,
  next: '리서처에게 다시',
  why: '같은 403',
};

before(async () => {
  api = await ApiClient.start();
  owner = await api.signIn();
  db = api.service(Database);
  worker = api.service(OutboxWorker);
  const { version } = (await api.get('/api/space')).json() as { version: number };
  await api.request('PUT', '/api/space', owner, { name: '장부', siteUrl: api.baseUrl, version });
  runner = await api.connectDevice(owner, 'ledger-runner');
  const { devices } = ok(await api.get('/api/devices', owner)) as { devices: Json[] };
  const device = devices.find((d) => d.name === 'ledger-runner') as Json;
  ok(
    await api.request('PATCH', `/api/devices/${device.id}`, owner, {
      scopes: [...device.scopes, 'run'],
      version: device.version,
    }),
  );
});

after(async () => {
  await api.close();
});

beforeEach(async () => {
  await drain();
  await db.sql`
    UPDATE task.tasks SET status = 'cancelled', lease_until = NULL, wait_reason = NULL, wait_until = NULL
    WHERE status IN ('queued', 'running', 'waiting')`;
});

describe('진행 장부', () => {
  test('진전 없음이 3번 이어지면 replan, 소식은 상태 한 줄 · 장부 칸으로, 계획은 단계만 한 번 더', async () => {
    const chat = ok(
      await api.request('POST', '/api/chats', owner, {
        requestId: randomUUID(),
        message: '경쟁사 가격 표로 정리해 줘',
      }),
      201,
    );
    const turn = await turnOf(chat.id);
    const token = turn.run_token;
    await tool(token, 'set_plan', { steps: ['조사'], criteria: ['표에 5개'] });
    assert.match(
      await refused(token, 'set_plan', { steps: ['다시'] }),
      /진전 없음이 3번 이어지면/,
      '진전 없음 전에는 다시 세우지 못한다',
    );

    assert.deepEqual(await tool(token, 'note_progress', stall), { stalled: 1, replan: false });
    assert.deepEqual(
      await tool(token, 'note_progress', {
        ...stall,
        looping: false,
        progressing: true,
        next: '정리',
      }),
      { stalled: 0, replan: false },
      '나아지면 처음부터',
    );
    await tool(token, 'note_progress', stall);
    await tool(token, 'note_progress', stall);
    assert.deepEqual(await tool(token, 'note_progress', stall), { stalled: 3, replan: true });

    const room = ok(await api.get(`/api/chats/${chat.id}`, owner));
    const ledger = room.news.filter((n: Json) => n.kind === 'progress');
    assert.equal(ledger.length, 5);
    assert.match(ledger.at(-1).text, /진전이 없어 계획을 다시 세우는 중 \(3번 이어짐\)/);
    assert.equal(ledger[1].text, '다음: 정리');
    // 장부는 post_update의 자리(20개)를 먹지 않는다
    await tool(token, 'post_update', { kind: 'progress', text: '표 만드는 중' });

    // 완료 조건을 바꾸면 거절, 비우면 처음 것 그대로 두고 단계만 바꾼다
    assert.match(
      await refused(token, 'set_plan', { steps: ['다른 길'], criteria: ['표에 3개'] }),
      /완료 조건은 그대로/,
    );
    assert.deepEqual(await tool(token, 'set_plan', { steps: ['다른 길'] }), {
      fixed: true,
      steps: ['다른 길'],
      criteria: ['표에 5개'],
      must_not: [],
    });
    const [row] = await db.sql<{ payload: Json }[]>`
      SELECT payload FROM task.tasks WHERE id = ${turn.task.id}`;
    assert.equal(row?.payload.ledger.stalled, 0, '다시 세우면 처음부터');
    assert.equal(row?.payload.ledger.replan, false);
    const after = ok(await api.get(`/api/chats/${chat.id}`, owner));
    assert.ok(after.news.some((n: Json) => /계획을 다시 세웠어요/.test(n.text)));
  });

  test('대표가 아닌 에이전트는 남기지 못한다', async () => {
    const agent = ok(
      await api.request('POST', '/api/agents', owner, {
        requestId: randomUUID(),
        name: `일꾼 ${randomUUID().slice(0, 6)}`,
        tool: 'claude',
        scopes: ['read_public'],
      }),
      201,
    );
    const task = ok(
      await api.request('POST', '/api/tasks', owner, {
        requestId: randomUUID(),
        kind: 'general',
        title: '조사',
        instruction: '조사',
        agentId: agent.id,
      }),
      201,
    );
    const jobs: Json[] = (await tool(runner, 'next_jobs', { limit: 5 })).jobs ?? [];
    const job = jobs.find((j) => j.task.id === task.id);
    assert.ok(job);
    assert.match(await refused(job.run_token, 'note_progress', stall), /대표만/);
    await db.sql`UPDATE task.agents SET deleted_at = now() WHERE id = ${agent.id}`;
  });
});
