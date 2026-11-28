import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RuleViolation } from '../../platform';
import { type LedgerEntry, ProgressLedger } from './progress-ledger.policy';
import { TaskPlan } from './task-plan.policy';

// 진행 장부 (2026-11-28): 진전 없음이 3번 이어지면 계획을 다시 세울 때다 (완료 조건은 그대로)

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  done: false,
  progressing: false,
  looping: false,
  next: '리서처에게 출처 확인',
  why: '',
  ...over,
});

describe('ProgressLedger', () => {
  test('진전 없음(나아지지 않음 · 맴돎)만 세고, 나아지거나 끝나면 처음부터', () => {
    let p: Record<string, unknown> = { chat: { turn: 1 } };
    p = ProgressLedger.record(p, entry());
    p = ProgressLedger.record(p, entry({ progressing: true, looping: true }));
    assert.equal(ProgressLedger.stalled(p), 2);
    assert.equal(ProgressLedger.replanDue(p), false);
    p = ProgressLedger.record(p, entry());
    assert.equal(ProgressLedger.replanDue(p), true);
    assert.deepEqual((p as { chat: unknown }).chat, { turn: 1 }, '다른 칸은 그대로');
    assert.equal(ProgressLedger.stalled(ProgressLedger.record(p, entry({ progressing: true }))), 0);
    assert.equal(ProgressLedger.stalled(ProgressLedger.record(p, entry({ done: true }))), 0);
    assert.equal(ProgressLedger.stalled({ ledger: { stalled: 'x' } }), 0, '모양이 틀리면 0');
  });

  test('소식 글: 끝남 · 다시 세움 · 맴돎 · 다음', () => {
    assert.equal(ProgressLedger.said(entry({ done: true }), 0).text, '결과를 모아 답하는 중');
    assert.match(ProgressLedger.said(entry(), 3).text, /계획을 다시 세우는 중 \(3번 이어짐\)/);
    assert.match(ProgressLedger.said(entry({ looping: true }), 1).text, /방법을 바꾸는 중/);
    const said = ProgressLedger.said(entry({ progressing: true }), 0);
    assert.equal(said.text, '다음: 리서처에게 출처 확인');
    assert.equal((said.data.ledger as { stalled: number }).stalled, 0);
  });

  test('계획은 진전 없음이 이어진 뒤에만 다시: 단계만 바뀌고 완료 조건은 처음 것', () => {
    const first = TaskPlan.declare({}, { steps: ['조사'], criteria: ['표에 5개'], mustNot: [] });
    assert.throws(
      () => TaskPlan.declare(first, { steps: ['다시'], criteria: [], mustNot: [] }),
      RuleViolation,
    );
    let stuck: Record<string, unknown> = first;
    for (let i = 0; i < ProgressLedger.STALL_LIMIT; i++)
      stuck = ProgressLedger.record(stuck, entry());
    assert.throws(
      () => TaskPlan.declare(stuck, { steps: ['다시'], criteria: ['표에 3개'], mustNot: [] }),
      RuleViolation,
      '완료 조건은 바꿀 수 없다',
    );
    const set = TaskPlan.declared(stuck, {
      steps: ['다른 길'],
      criteria: [],
      mustNot: ['같은 사이트'],
    });
    assert.equal(set.again, true);
    assert.deepEqual(set.plan, {
      steps: ['다른 길'],
      criteria: ['표에 5개'],
      mustNot: ['같은 사이트'],
    });
    const same = TaskPlan.declare(stuck, {
      steps: ['다른 길'],
      criteria: ['표에 5개'],
      mustNot: [],
    });
    assert.equal(ProgressLedger.stalled(same), 0, '다시 세우면 처음부터');
    assert.throws(
      () => TaskPlan.declare(same, { steps: ['또'], criteria: [], mustNot: [] }),
      RuleViolation,
    );
  });
});
