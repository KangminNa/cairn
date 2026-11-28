import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type LessonNoteRow, Lessons } from './lesson.policy';

// 피드백에서 배우기의 판단 (2026-11-20): 시작할 때 · 날마다 하나 · 지시문에 싣는 줄
const note = (more: Partial<LessonNoteRow> = {}): LessonNoteRow => ({
  id: 'a',
  action: 'blog.post.publish',
  target_kind: 'post',
  note: '제목을\n짧게',
  decided_at: new Date('2026-11-20T03:00:00Z'),
  agent_name: '작가',
  task_title: '초안 쓰기',
  app_id: null,
  ...more,
});

describe('Lessons', () => {
  test('열린 배우기 일이 없고 메모가 MIN_NOTES개 이상일 때만', () => {
    assert.equal(Lessons.due(null, Lessons.MIN_NOTES), true);
    assert.equal(Lessons.due(null, Lessons.MIN_NOTES - 1), false);
    for (const status of ['queued', 'running', 'waiting'] as const)
      assert.equal(Lessons.due({ status }, 10), false, status);
    for (const status of ['done', 'failed', 'cancelled'] as const)
      assert.equal(Lessons.due({ status }, Lessons.MIN_NOTES), true, status);
  });

  test('공간 · 날(UTC)마다 같은 request_id', () => {
    const at = (iso: string) => Lessons.requestId('s', new Date(iso));
    assert.equal(at('2026-11-20T00:00:00Z'), at('2026-11-20T23:59:59Z'));
    assert.notEqual(at('2026-11-20T23:59:59Z'), at('2026-11-21T00:00:00Z'));
    assert.ok(at('2026-11-20T00:00:00Z').startsWith(`${Lessons.PREFIX}s:`));
  });

  test('메모 한 줄: 날 · 동작 · 일 · 올린 에이전트 · 앱, 줄바꿈은 한 줄로', () => {
    const { count, notes, rules } = Lessons.fields(
      [note({ app_id: 'app-1' }), note({ agent_name: null })],
      [],
    );
    assert.equal(rules, null);
    assert.equal(count, 2);
    assert.equal(
      String(notes).split('\n')[0],
      '- [2026-11-20] blog.post.publish · 일: 초안 쓰기 · 올린 에이전트: 작가 · app_id: app-1',
    );
    assert.match(String(notes), /관리자 메모: 제목을 짧게/);
    assert.match(String(notes), /- \[2026-11-20\] blog\.post\.publish · 일: 초안 쓰기\n/);
  });

  test('배운 규칙 한 줄: 번호 · 도움 · 해로움 · 대상 · id · 글 (2026-11-28)', () => {
    const rule = {
      id: 'r-1',
      space_id: 's',
      seq: 3,
      scope: 'role',
      scope_key: 'writer',
      body: '제목은 40자 안으로',
      helpful: 2,
      harmful: 1,
      status: 'active',
      approval_id: null,
      replaced_by: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      retired_at: null,
    } as const;
    const { rules } = Lessons.fields([], [rule]);
    assert.equal(rules, '- [R3] 도움 2 · 해로움 1 · 대상 role writer (id r-1): 제목은 40자 안으로');
  });
});
