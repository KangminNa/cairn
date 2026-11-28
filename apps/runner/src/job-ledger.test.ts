import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { JobLedger } from './job-ledger';
import { Json } from './json';
import { PromptPack } from './prompt-pack';

// 진행 장부 (2026-11-28): 서버가 replan을 켠 일에만 "계획을 다시 세운다" 단락을 싣는다
const PACK = PromptPack.read(resolve(__dirname, '../../../skills'));

test('replan이면 이어진 수와 다음 할 일을 싣고, 아니면 단락이 없다', () => {
  const stuck = JobLedger.from(
    Json.of({ ledger: { stalled: 3, replan: true, last: { next: '리서처에게 다시' } } }),
  );
  const part = stuck?.part(PACK) ?? '';
  assert.match(part, /# 계획을 다시 세운다/);
  assert.match(part, /진전 없음이 3번 이어졌다/);
  assert.match(part, /앞에서 적은 다음 할 일: 리서처에게 다시/);
  assert.match(part, /set_plan으로 단계와 하지 말 것을 다시 세운다/);

  assert.equal(JobLedger.from(Json.of({ ledger: { stalled: 1, replan: false } })), null);
  assert.equal(JobLedger.from(Json.of({})), null);
  const bare = JobLedger.from(Json.of({ ledger: { stalled: 3, replan: true, last: null } }));
  assert.equal(bare?.part(PACK).includes('앞에서 적은'), false);
});
