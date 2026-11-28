import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ClaudeStream } from './claude-stream';
import { CodexStream } from './codex-stream';
import { LoopWatch } from './loop-watch';

// 맴도는 일꾼 멈추기 (2026-11-28): 같은 결과 4번 · 같은 오류 3번 · 번갈아 6번. 입력 · 결과는 해시로만 본다

const watchOf = (steps: readonly [string, unknown, unknown, boolean][]) => {
  const watch = new LoopWatch();
  for (const [tool, input, result, error] of steps) watch.done(tool, input, result, error);
  return watch;
};

describe('LoopWatch', () => {
  test('같은 입력이 같은 결과를 4번 연달아 내면 맴돈 것이다 (3번은 아니다)', () => {
    const step: [string, unknown, unknown, boolean] = ['Grep', { pattern: 'x' }, '없음', false];
    assert.equal(watchOf([step, step, step]).stuck, null);
    assert.equal(
      watchOf([step, step, step, step]).stuck,
      '맴돌아 멈췄어요: 같은 Grep 호출이 같은 결과를 4번 냈어요',
    );
  });

  test('결과가 바뀌거나 입력이 바뀌면 맴돈 것이 아니다', () => {
    const steps = [1, 2, 3, 4].map((n): [string, unknown, unknown, boolean] => [
      'Bash',
      { command: 'pnpm test' },
      `실패 ${n}`,
      false,
    ]);
    assert.equal(watchOf(steps).stuck, null);
    const reads = [1, 2, 3, 4].map((n): [string, unknown, unknown, boolean] => [
      'Read',
      { file_path: `a${n}.ts` },
      '같음',
      false,
    ]);
    assert.equal(watchOf(reads).stuck, null);
  });

  test('같은 입력이 오류를 3번 연달아 내면 (오류 글이 달라도) 맴돈 것이다', () => {
    const fail = (why: string): [string, unknown, unknown, boolean] => [
      'site_run',
      { id: 1 },
      why,
      true,
    ];
    assert.equal(
      watchOf([fail('a'), fail('b'), fail('c')]).stuck,
      '맴돌아 멈췄어요: 같은 site_run 호출이 오류를 3번 냈어요',
    );
    assert.equal(watchOf([fail('a'), ['site_run', { id: 2 }, 'b', true], fail('c')]).stuck, null);
  });

  test('두 동작을 같은 결과로 번갈아 6번 하면 맴돈 것이다', () => {
    const a: [string, unknown, unknown, boolean] = ['browser_click', { ref: 'e1' }, '열림', false];
    const b: [string, unknown, unknown, boolean] = ['browser_navigate_back', {}, '닫힘', false];
    assert.equal(watchOf([a, b, a, b, a]).stuck, null);
    assert.equal(
      watchOf([a, b, a, b, a, b]).stuck,
      '맴돌아 멈췄어요: browser_click · browser_navigate_back 호출을 번갈아 6번 되풀이했어요',
    );
  });

  test('한 번 맴돈 까닭은 그대로 남는다. 결과가 오지 않은 부름은 세지 않는다', () => {
    const watch = new LoopWatch();
    for (let n = 0; n < 4; n++) watch.called(`t${n}`, 'Grep', { pattern: 'x' });
    assert.equal(watch.stuck, null);
    for (let n = 0; n < 4; n++) watch.answered(`t${n}`, '없음', false);
    const first = watch.stuck;
    assert.match(String(first), /같은 결과를 4번/);
    watch.done('Read', { file_path: 'b' }, '다름', false);
    assert.equal(watch.stuck, first);
    watch.answered('모르는 id', '없음', false);
  });
});

describe('스트림이 맴돎을 알린다', () => {
  test('Claude: tool_use와 tool_result를 id로 짝지어 본다', () => {
    const stream = new ClaudeStream();
    for (let n = 0; n < 3; n++) {
      stream.read(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `m${n}`,
            usage: {},
            content: [
              {
                type: 'tool_use',
                id: `u${n}`,
                name: 'mcp__moida__read_url',
                input: { url: 'https://a.example' },
              },
            ],
          },
        }),
      );
      assert.equal(stream.stuck, null);
      stream.read(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: `u${n}`, content: '오류: 403', is_error: true },
            ],
          },
        }),
      );
    }
    assert.equal(stream.stuck, '맴돌아 멈췄어요: 같은 read_url 호출이 오류를 3번 냈어요');
    assert.equal(stream.breach, null);
  });

  test('Codex: 끝난 mcp_tool_call의 인자 · 결과로 본다', () => {
    const stream = new CodexStream();
    const done = (n: number) =>
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: `i${n}`,
          type: 'mcp_tool_call',
          server: 'moida',
          tool: 'search_sessions',
          arguments: { query: '지도' },
          result: { content: [{ type: 'text', text: '[]' }] },
          status: 'completed',
        },
      });
    for (let n = 0; n < 3; n++) stream.read(done(n));
    assert.equal(stream.stuck, null);
    stream.read(done(3));
    assert.equal(
      stream.stuck,
      '맴돌아 멈췄어요: 같은 search_sessions 호출이 같은 결과를 4번 냈어요',
    );
  });
});
