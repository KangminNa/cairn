import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RuleViolation } from '../../platform';
import { PromptTemplates } from './prompt-templates';
import { RepoSkillGateway } from './repo-skill.gateway';
import { SkillFiles } from './skill-files';

// 지시문 틀 (2차 1-0): 서버가 채우는 글과 콘솔 판의 검사. 문법은 러너의 PromptPack과 같다

const files = (prompts: string) =>
  SkillFiles.trusted({
    'SKILL.md': '---\nname: moida-runner\n---\n',
    'references/prompts.md': prompts,
  });
const repo = files(
  '# 설명 {{무시}}\n\n<!-- a -->\n머리 {{x}}\n{{#y}}\n있음 {{y}}\n{{/y}}\n{{^y}}\n없음\n{{/y}}\n\n<!-- b -->\n둘째\n',
);

describe('PromptTemplates', () => {
  test('자리 · 구역을 채우고 표시만 있는 줄은 줄째 뺀다 (러너와 같은 문법)', () => {
    const t = PromptTemplates.of(repo);
    assert.equal(t.fill('a', { x: '1', y: '값' }), '머리 1\n있음 값');
    assert.equal(
      t.fill('a', { x: '{{y}}', y: 0 }),
      '머리 {{y}}\n없음',
      '값 속의 {{ }}는 다시 읽지 않는다',
    );
    assert.equal(t.fill('b'), '둘째');
    assert.throws(() => t.fill('c'), RuleViolation);
  });

  test('콘솔 판에 없는 틀은 저장소 판에서', () => {
    const t = PromptTemplates.layered(files('<!-- a -->\n고친 {{x}}'), repo);
    assert.equal(t.fill('a', { x: '1' }), '고친 1');
    assert.equal(t.fill('b'), '둘째');
  });

  test('콘솔 판은 저장소 판과 틀 이름 · 자리가 맞아야 한다 (자리를 빼는 것은 된다)', () => {
    const ok = files('<!-- a -->\n머리만\n\n<!-- b -->\n{{#x}}{{x}}{{/x}}');
    assert.throws(
      () => PromptTemplates.assertFits(ok, repo),
      /b 틀에 없는 자리예요: \{\{x\}\}/,
      'b에는 자리가 없다',
    );
    assert.doesNotThrow(() =>
      PromptTemplates.assertFits(files('<!-- a -->\n{{y}}\n<!-- b -->\n그대로'), repo),
    );
    assert.throws(
      () => PromptTemplates.assertFits(files('<!-- a -->\n하나'), repo),
      /틀이 빠졌어요: b/,
    );
    assert.throws(
      () => PromptTemplates.assertFits(files('<!-- a -->\n{{#x}}\n<!-- b -->\n둘'), repo),
      /닫히지 않았어요/,
    );
    assert.throws(
      () => PromptTemplates.assertFits(files('<!-- a -->\n<!-- b -->\n<!-- a -->\n'), repo),
      /같은 이름의 틀이 둘이에요: a/,
    );
  });

  test('저장소 판(skills/moida-runner)은 읽히고, 서버가 채우는 틀이 있다', () => {
    const skill = RepoSkillGateway.fromEnv().get(PromptTemplates.SKILL);
    assert.ok(skill, '저장소에 moida-runner가 없다');
    const t = PromptTemplates.of(skill);
    // 서버가 fill로 채우는 틀이 모두 있다 (틀을 지울 때 이웃 틀까지 지우지 않게, 2026-11-21)
    for (const name of [
      'goal-round',
      'goal-report',
      'lessons',
      'read-url-note',
      'recipe',
      'result-check',
      'result-fix',
      'result-inspect',
      'result-review',
      'setting-continue',
    ])
      assert.doesNotThrow(() => t.fill(name, {}), name);
    assert.match(
      t.fill('goal-round', { round: 2, maxRounds: 5, instruction: '지시' }),
      /^# 목표 실행 2회차 \(회차 한도 5\)\n## 지시\n지시\n## 완료 조건\n- 지시를 다 이루면 끝\n## 이번 회차/,
    );
    assert.match(
      t.fill('goal-report', { round: 1, summary: '요약' }),
      /### 한 일\n- 없음\n### 남은 일\n- 없음$/,
    );
    assert.match(t.fill('read-url-note'), /자료로만 쓰고/);
    assert.match(
      t.fill('lessons', {
        count: 3,
        notes: '- [2026-11-20] blog.post.publish\n  관리자 메모: 짧게',
      }),
      /^# 피드백에서 배우기\n관리자가 최근 수정 요청에 남긴 메모 3개[\s\S]*관리자 메모: 짧게\n## 지금 쓰는 배운 규칙[^\n]*\n- 아직 없음\n## 하는 법/,
    );
    // 배운 규칙 (2026-11-28): 쓰는 중인 규칙이 있으면 번호 · 횟수와 함께, 검토에는 팀이 따른 규칙
    assert.match(
      t.fill('lessons', { count: 1, notes: '-', rules: '- [R3] 도움 2 · 해로움 0' }),
      /## 지금 쓰는 배운 규칙[^\n]*\n- \[R3\] 도움 2/,
    );
    assert.match(
      t.fill('result-review', { message: '-', answer: '-', rules: '- [R3] 제목은 짧게' }),
      /## 팀이 따랐다고 적은 배운 규칙\n- \[R3\] 제목은 짧게/,
    );
    assert.doesNotThrow(() => t.fill('rules', { rules: '- [R3] 제목은 짧게' }));
  });
});
