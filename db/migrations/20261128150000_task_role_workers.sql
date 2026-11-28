-- migrate:up
-- 역할 일꾼 (2026-11-28, 사용자 결정 "이미 있는 일꾼N은 지우고 그냥 강제로 남길 순 없나 그 성격 밑에 이제 에이전트들이 알아서 굴리는거지"):
-- ECC의 agents/*.md처럼 일꾼은 시스템이 정한 역할(기획자 · 리서처 · 작가 · 디자이너 · 개발자 · 검토자 · 브라우저 담당,
-- apps/server/src/modules/task/agent/agent-roles.json)로 고정한다. 역할 일꾼은 서버가 공간마다 만들고(AgentRoster) 관리자가 지우거나
-- 이름 · 역할을 바꾸지 못한다. preset: 그 역할의 key (대표와 관리자가 만든 일꾼은 null)
ALTER TABLE task.agents ADD COLUMN preset text;
ALTER TABLE task.agents ADD CONSTRAINT agents_preset_not_lead CHECK (NOT (lead AND preset IS NOT NULL));
-- 공간마다 역할 하나에 살아 있는 일꾼 하나
CREATE UNIQUE INDEX agents_one_preset ON task.agents (space_id, preset)
  WHERE preset IS NOT NULL AND deleted_at IS NULL;

-- 기존 "일꾼 N"(대표가 아니고 역할이 없는 일꾼)을 휴지통으로. 지울 때와 같은 조건(AgentQuery.blockers)으로 막히는 것은 남긴다:
-- 진행 중인 작업(대기 · 실행 · 기다림) · 스케줄 · 도는 목표 실행이 있는 일꾼. 남은 일꾼도 관리자가 끝낸 뒤 휴지통으로 옮길 수 있다.
-- 행은 지우지 않는다 (실행 기록 · 결재 · 설정 판 · 성적표가 가리킨다). 검토자 짝으로 가리키던 짝은 비운다 (지운 일꾼은 검토자가 될 수 없다)
CREATE TEMP TABLE retired_workers ON COMMIT DROP AS
SELECT a.id FROM task.agents a
WHERE NOT a.lead AND a.preset IS NULL AND a.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM task.tasks t WHERE t.agent_id = a.id
                  AND t.status IN ('queued', 'running', 'waiting'))
  AND NOT EXISTS (SELECT 1 FROM task.schedules s WHERE s.agent_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM task.goal_runs g WHERE g.agent_id = a.id
                  AND g.status IN ('running', 'waiting'));

UPDATE task.agents a SET reviewer_id = NULL, version = a.version + 1
WHERE a.reviewer_id IN (SELECT id FROM retired_workers);
UPDATE task.agents a SET second_inspector_id = NULL, version = a.version + 1
WHERE a.second_inspector_id IN (SELECT id FROM retired_workers);
UPDATE task.agents a SET deleted_at = now(), version = a.version + 1
WHERE a.id IN (SELECT id FROM retired_workers);

-- migrate:down
-- 휴지통으로 옮긴 일꾼은 콘솔의 휴지통에서 복원한다 (어느 줄을 옮겼는지 따로 남기지 않는다)
DROP INDEX IF EXISTS task.agents_one_preset;
ALTER TABLE task.agents DROP CONSTRAINT IF EXISTS agents_preset_not_lead;
ALTER TABLE task.agents DROP COLUMN IF EXISTS preset;
