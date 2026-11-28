import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RuleMarks } from './rule-marks.policy';

// 배운 규칙의 세기 (2026-11-28): 따른 규칙 줄 떼기 · 받은 번호 · 검토자의 표시 · 판정 하나의 표시
describe('RuleMarks', () => {
  test('답 끝의 따른 규칙 줄을 떼어 번호로', () => {
    assert.deepEqual(RuleMarks.split('초안이에요.\n\n따른 규칙: R3, R7 · R3'), {
      text: '초안이에요.',
      seqs: [3, 7],
    });
    assert.deepEqual(RuleMarks.split('따른 규칙：R12\n그다음 글'), {
      text: '\n그다음 글',
      seqs: [12],
    });
    const plain = '규칙 R3을 따랐다고 글 안에 적은 것은 줄이 아니다';
    assert.deepEqual(RuleMarks.split(plain), { text: plain, seqs: [] });
  });

  test('받은 번호는 1 이상의 정수만, 20개까지', () => {
    assert.deepEqual(RuleMarks.seqsOf([3, 3, 9]), [3, 9]);
    assert.equal(RuleMarks.seqsOf(['R3']), null);
    assert.equal(RuleMarks.seqsOf([0]), null);
    assert.equal(RuleMarks.seqsOf('3'), null);
    assert.equal(RuleMarks.seqsOf(Array.from({ length: 21 }, (_, i) => i + 1)), null);
  });

  test('검토자의 표시는 판정 JSON의 rules에서, 못 읽는 줄은 버린다', () => {
    const text = `판정: {"verdict": "fix", "rules": [{"id": "R3", "mark": "harmful"}, {"id": "r4", "mark": "helpful"}, {"id": "X", "mark": "helpful"}, {"id": "R5", "mark": "좋음"}]}`;
    assert.deepEqual(
      [...RuleMarks.fromReview(text)],
      [
        [3, 'harmful'],
        [4, 'helpful'],
      ],
    );
    assert.equal(RuleMarks.fromReview('JSON이 아님').size, 0);
  });

  test('통과면 따른 규칙은 도움, 검토자가 적은 것은 그대로 (적은 것이 먼저)', () => {
    const reviewed = new Map([[3, RuleMarks.HARMFUL]]);
    assert.deepEqual(
      [...RuleMarks.ofVerdict([3, 7], true, reviewed)],
      [
        [3, 'harmful'],
        [7, 'helpful'],
      ],
    );
    assert.deepEqual([...RuleMarks.ofVerdict([3, 7], false, new Map())], []);
  });
});
