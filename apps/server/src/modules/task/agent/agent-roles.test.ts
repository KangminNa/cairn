import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RuleViolation } from '../../platform';
import { TaskKinds } from '../task/task-kinds';
import { AgentRoles } from './agent-roles';

// 역할 일꾼 정의 파일 (agent-roles.json, 2026-11-28): 종류는 맡길 수 있는 것만, 역할 설명은 ECC형 형식(첫 줄 "언제 맡기나"),
// 맡길 수 있는 종류마다 받을 역할이 있다

describe('역할 일꾼 정의', () => {
  test('일곱 역할, 종류는 대표가 맡길 수 있는 것이고 defaults는 kinds 안에 있다', () => {
    assert.deepEqual(AgentRoles.KEYS, [
      'planner',
      'researcher',
      'writer',
      'maker',
      'developer',
      'reviewer',
      'browser',
    ]);
    for (const role of AgentRoles.ALL) {
      assert.ok(role.kinds.length > 0, role.key);
      for (const kind of role.kinds)
        assert.ok(TaskKinds.DELEGABLE.includes(kind), `${role.key}: ${kind}`);
      for (const kind of role.defaults)
        assert.ok(role.kinds.includes(kind), `${role.key}: ${kind}`);
    }
  });

  test('역할 설명은 첫 줄이 "맡긴다."로 끝나고 하는 일 · 결과 형식 · 하지 않는 것을 담는다 (2000자까지)', () => {
    for (const role of AgentRoles.ALL) {
      const [first, ...rest] = role.role.split('\n');
      assert.match(first ?? '', /맡긴다\.$/, role.key);
      for (const part of ['하는 일:', '결과 형식:', '하지 않는 것:'])
        assert.ok(
          rest.some((line) => line.startsWith(part)),
          `${role.key}: ${part}`,
        );
      assert.ok(role.role.length <= 2000, role.key);
    }
  });

  test('맡길 수 있는 종류마다 역할을 고르지 않았을 때 받을 역할이 하나다', () => {
    for (const kind of TaskKinds.DELEGABLE) {
      const roles = AgentRoles.forKind(kind);
      assert.equal(roles.length, 1, `${kind}: ${roles.map((r) => r.key).join(', ')}`);
    }
    assert.equal(AgentRoles.forKind('draft_post')[0]?.key, 'writer');
    assert.equal(AgentRoles.forKind('general')[0]?.key, 'researcher');
  });

  test('이름 · 역할은 정의 그대로만 바꾼다, 역할이 받지 않는 종류는 거절', () => {
    const writer = AgentRoles.find('writer');
    assert.ok(writer);
    AgentRoles.assertEdit('writer', { name: writer.name, model: 'opus' });
    AgentRoles.assertEdit(null, { name: '아무 이름' });
    assert.throws(() => AgentRoles.assertEdit('writer', { name: '다른 이름' }), RuleViolation);
    assert.throws(() => AgentRoles.assertEdit('writer', { role: '다른 역할' }), RuleViolation);
    AgentRoles.assertTakes(writer, 'draft_post');
    assert.throws(() => AgentRoles.assertTakes(writer, 'code'), /개발자/);
  });
});
