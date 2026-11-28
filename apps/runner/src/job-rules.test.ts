import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { JobRules } from './job-rules';
import { Json } from './json';
import { PromptPack } from './prompt-pack';

// 배운 규칙 (2026-11-28): 서버가 실은 rules를 지시문 단락으로, 따른 규칙을 적는 법과 함께
const PACK = PromptPack.read(resolve(__dirname, '../../../skills'));

test('규칙마다 [R번호] 한 줄, 따른 규칙 줄을 적는 법. 없거나 모양이 틀린 줄은 뺀다', () => {
  const rules = JobRules.from([
    Json.of({ seq: 3, body: '제목은 40자 안으로' }),
    Json.of({ seq: 0, body: '번호가 틀림' }),
    Json.of({ seq: 7, body: '  ' }),
  ]);
  assert.ok(rules);
  const part = rules.part(PACK);
  assert.match(part, /# 배운 규칙/);
  assert.match(part, /- \[R3\] 제목은 40자 안으로/);
  assert.match(part, /따른 규칙: R3, R7/);
  assert.equal(part.includes('번호가 틀림'), false);
  assert.equal(JobRules.from([]), null);
});
