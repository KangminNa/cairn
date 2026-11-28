import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ApiClient, type ApiResult, TestUser } from '../../../testing/api-client';
import { Database, OutboxWorker } from '../../platform';
import { LearnedRuleRepository } from './rule.repository';

// 배운 규칙 (2026-11-28, ACE의 규칙 목록): 대표가 propose_setting rule로 제안 → 관리자 승인 → 규칙(R<번호>).
// 일꾼의 일에 맞는 규칙이 실리고, 답 끝의 "따른 규칙" 줄은 서버가 떼어 result.rules로 둔다.
// 관리자의 수정 요청은 따른 규칙마다 해로움, 판정은 도움 (근거마다 한 번). 관리자는 콘솔에서 바로 내리고 되살린다

// biome-ignore lint/suspicious/noExplicitAny: 응답 JSON을 여러 겹 읽는 시험 (모양은 assert가 본다)
type Json = Record<string, any>;

let api: ApiClient;
let owner: TestUser;
let writerDevice: Record<string, string>;
let runner: string;
let db: Database;
let worker: OutboxWorker;
let leadId: string;
let spaceId: string;
let member: Json;

function ok(res: ApiResult, status = 200): Json {
  assert.equal(res.status, status, res.text);
  return res.json();
}

async function tool(token: string, name: string, args: Json = {}) {
  const res = await api.mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  const result = res.json().result as Json;
  return result.isError
    ? { ok: false, body: JSON.parse(result.content[0]?.text ?? '{}') as Json }
    : { ok: true, body: (result.structuredContent ?? {}) as Json };
}

async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const { ok: done, body } = await tool(token, name, args);
  assert.equal(done, true, JSON.stringify(body));
  return body;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 200 && (await worker.tick()) > 0; i++);
}

/** 이 에이전트에게 일을 맡기고 러너가 빌린 일 */
async function take(agentId: string): Promise<Json> {
  const made = ok(
    await api.request('POST', '/api/tasks', owner, {
      requestId: randomUUID(),
      agentId,
      instruction: '규칙을 지키며 초안을 써 주세요',
    }),
    201,
  );
  for (let i = 0; i < 50; i++) {
    const { jobs } = (await call(runner, 'next_jobs', { limit: 5 })) as { jobs: Json[] };
    const mine = jobs.find((j) => j.task.id === made.id);
    if (mine) return mine;
    if (jobs.length === 0) break;
  }
  throw new Error('맡긴 일을 빌리지 못했어요');
}

/** 대표가 규칙 바꾸기를 제안하고 관리자가 승인한다 */
async function proposeAndApprove(op: string, fields: Json, target?: Json): Promise<Json> {
  const job = await take(leadId);
  const proposed = await call(String(job.run_token), 'propose_setting', {
    request_id: randomUUID(),
    setting: 'rule',
    op,
    ...(target ? { target_id: target.id, version: target.version } : {}),
    fields,
    note: '수정 요청에서 되풀이된 지적',
  });
  const approval = ok(await api.get(`/api/approvals/${proposed.approval_id}`, owner));
  assert.equal(approval.action, 'task.setting.change');
  ok(
    await api.request('POST', `/api/approvals/${approval.id}/decide`, owner, {
      version: approval.version,
      decision: 'approve',
    }),
  );
  await drain();
  return proposed;
}

const rules = async (): Promise<Json[]> => ok(await api.get('/api/rules', owner)).rules;
const rule = async (seq: number) => (await rules()).find((r) => r.seq === seq) as Json;

before(async () => {
  api = await ApiClient.start();
  owner = await api.signIn();
  db = api.service(Database);
  worker = api.service(OutboxWorker);
  const space = ok(await api.get('/api/space'));
  ok(
    await api.request('PUT', '/api/space', owner, {
      name: space.name || '배운 규칙',
      siteUrl: api.baseUrl,
      version: space.version,
    }),
  );
  writerDevice = { authorization: `Bearer ${await api.writeDevice(owner, 'rule-writer')}` };
  runner = await api.connectDevice(owner, 'rule-runner');
  const { devices } = ok(await api.get('/api/devices', owner));
  const device = (devices as Json[]).find((d) => d.name === 'rule-runner') as Json;
  ok(
    await api.request('PATCH', `/api/devices/${device.id}`, owner, {
      scopes: [...device.scopes, 'run'],
      version: device.version,
    }),
  );
  ok(
    await api.request('POST', '/api/chats', owner, { requestId: randomUUID(), message: '안녕' }),
    201,
  );
  await db.sql`
    UPDATE task.tasks SET status = 'cancelled', lease_until = NULL, wait_reason = NULL, wait_until = NULL
    WHERE status IN ('queued', 'running', 'waiting')`;
  leadId = String(ok(await api.get('/api/agents/lead', owner)).lead.id);
  const [row] = await db.sql<{ space_id: string }[]>`
    SELECT space_id FROM task.agents WHERE id = ${leadId}`;
  spaceId = String(row?.space_id);
  member = ok(
    await api.request('POST', '/api/agents', owner, {
      requestId: randomUUID(),
      name: `규칙 일꾼 ${randomUUID().slice(0, 6)}`,
      tool: 'claude',
      approvalActions: ['blog.post.publish'],
    }),
    201,
  );
});

after(async () => {
  await db.sql`
    UPDATE task.tasks SET status = 'cancelled', lease_until = NULL, wait_reason = NULL, wait_until = NULL
    WHERE status IN ('queued', 'running', 'waiting')`;
  await db.sql`UPDATE task.agents SET status = 'paused' WHERE id = ${String(member.id)}`;
  await drain();
  await api.close();
});

describe('배운 규칙', () => {
  test('목록은 관리자만: 방문자 · write 기기는 막힌다', async () => {
    assert.ok([401, 403].includes((await api.get('/api/rules', TestUser.visitor)).status));
    const device = await api.request(
      'GET',
      '/api/rules',
      TestUser.visitor,
      undefined,
      writerDevice,
    );
    assert.equal(device.status, 403);
    assert.ok(Array.isArray(await rules()));
  });

  test('제안을 승인하면 규칙이 생기고, 일꾼의 일에 실리고, 따른 규칙 줄은 result.rules가 된다', async () => {
    const before = (await rules()).length;
    await proposeAndApprove('create', { scope: 'all', body: '제목은   40자 안으로' });
    const made = (await rules()).find((r) => r.body === '제목은 40자 안으로') as Json;
    assert.ok(made, '띄어쓰기를 하나로 줄인 규칙');
    assert.equal((await rules()).length, before + 1);
    assert.deepEqual(
      [made.status, made.helpful, made.harmful, made.fromApproval],
      ['active', 0, 0, true],
    );

    const job = await take(String(member.id));
    assert.ok((job.rules as Json[]).some((r) => r.seq === made.seq && r.body === made.body));
    const token = String(job.run_token);
    const bad = await tool(runner, 'submit_result', {
      task_id: job.task.id,
      request_id: randomUUID(),
      status: 'done',
      result: { text: '답', rules: ['R1'] },
    });
    assert.equal(bad.ok, false, '규칙 번호는 정수');
    await call(runner, 'submit_result', {
      task_id: job.task.id,
      request_id: randomUUID(),
      status: 'done',
      result: { text: `초안을 썼어요.\n\n따른 규칙: R${made.seq}` },
    });
    assert.ok(token);
    const [row] = await db.sql<{ result: Json }[]>`
      SELECT result FROM task.tasks WHERE id = ${String(job.task.id)}`;
    assert.equal(row?.result.text, '초안을 썼어요.', '따른 규칙 줄은 답에서 뗀다');
    assert.deepEqual(row?.result.rules, [made.seq]);

    // 판정의 도움은 근거마다 한 번 (VerdictService가 같은 저장소로 센다)
    const repo = new LearnedRuleRepository(db.sql);
    const source = `verdict:${randomUUID()}`;
    const helpful = new Map([[Number(made.seq), 'helpful']]);
    assert.equal(await repo.mark(spaceId, source, helpful, null), 1);
    assert.equal(await repo.mark(spaceId, source, helpful, null), 0, '같은 근거는 한 번');
    assert.deepEqual(await repo.followedIn(spaceId, String(job.task.id)), [made.seq]);
    assert.equal((await rule(made.seq)).helpful, 1);
  });

  test('관리자가 사람으로서 수정 요청하면 그 일이 따른 규칙마다 해로움 하나 (결재마다 한 번)', async () => {
    const [made] = (await rules()).filter((r) => r.status === 'active');
    assert.ok(made);
    const job = await take(String(member.id));
    const asked = await call(String(job.run_token), 'request_approval', {
      request_id: randomUUID(),
      action: 'blog.post.publish',
      target_kind: 'post',
      target_id: randomUUID(),
      target_version: 1,
      note: '공개해 주세요',
    });
    // 이 일(과 그 아래)이 그 규칙을 따랐다고 적어 둔 것으로 본다
    await db.sql`
      UPDATE task.tasks SET result = ${db.sql.json({ rules: [made.seq] })} WHERE id = ${String(job.task.id)}`;
    const approval = ok(await api.get(`/api/approvals/${asked.approval_id}`, owner));
    ok(
      await api.request('POST', `/api/approvals/${approval.id}/decide`, owner, {
        version: approval.version,
        decision: 'revise',
        note: '제목이 너무 짧아요',
      }),
    );
    await drain();
    assert.equal((await rule(made.seq)).harmful, made.harmful + 1);
    const [marked] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM task.rule_marks WHERE source = ${`approval:${approval.id}`}`;
    assert.equal(marked?.n, 1);
  });

  test('합치기 · 내리기는 제안과 승인으로, 글은 바뀌지 않고 옛 규칙은 새 규칙을 가리킨다', async () => {
    await proposeAndApprove('create', {
      scope: 'role',
      scope_key: 'writer',
      body: '소제목을 단다',
    });
    const a = (await rules()).find((r) => r.body === '소제목을 단다') as Json;
    await proposeAndApprove('create', {
      scope: 'role',
      scope_key: 'writer',
      body: '소제목은 짧게',
    });
    const b = (await rules()).find((r) => r.body === '소제목은 짧게') as Json;
    await proposeAndApprove('create', {
      scope: 'role',
      scope_key: 'writer',
      body: '소제목을 달고 짧게 쓴다',
      replaces: [a.id, b.id],
    });
    const merged = (await rules()).find((r) => r.body === '소제목을 달고 짧게 쓴다') as Json;
    for (const old of [await rule(a.seq), await rule(b.seq)]) {
      assert.equal(old.status, 'retired');
      assert.equal(old.replacedBy, merged.id);
    }
    const lead = await take(leadId);
    const listed = (await call(String(lead.run_token), 'get_settings', { kind: 'rules' }))
      .rules as Json[];
    assert.ok(listed.some((r) => r.id === merged.id && r.scope_key === 'writer'));
    const wrong = await tool(String(lead.run_token), 'propose_setting', {
      request_id: randomUUID(),
      setting: 'rule',
      op: 'edit',
      target_id: merged.id,
      version: merged.version,
      fields: { body: '고친 글' },
    });
    assert.deepEqual([wrong.ok, wrong.body.code], [false, 'rule_violation'], '글은 새 규칙으로');
    await proposeAndApprove('edit', { status: 'retired' }, merged);
    assert.equal((await rule(merged.seq)).status, 'retired');
    await assert.rejects(
      db.sql`UPDATE task.learned_rules SET body = '몰래' WHERE id = ${String(merged.id)}`,
      /바꾸지 않아요/,
    );
  });

  test('관리자는 콘솔에서 바로 내리고 되살린다: 본 version이 낡으면 409', async () => {
    const [made] = (await rules()).filter((r) => r.status === 'active');
    assert.ok(made);
    const retired = ok(
      await api.request('PATCH', `/api/rules/${made.id}`, owner, {
        status: 'retired',
        version: made.version,
      }),
    );
    assert.equal(retired.status, 'retired');
    const stale = await api.request('PATCH', `/api/rules/${made.id}`, owner, {
      status: 'active',
      version: made.version,
    });
    assert.equal(stale.status, 409);
    const restored = ok(
      await api.request('PATCH', `/api/rules/${made.id}`, owner, {
        status: 'active',
        version: retired.version,
      }),
    );
    assert.deepEqual([restored.status, restored.retiredAt], ['active', null]);
    const device = await api.request(
      'PATCH',
      `/api/rules/${made.id}`,
      TestUser.visitor,
      { status: 'retired', version: restored.version },
      writerDevice,
    );
    assert.equal(device.status, 403);
  });
});
