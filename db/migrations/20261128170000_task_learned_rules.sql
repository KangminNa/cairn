-- migrate:up
-- 배운 규칙 (2026-11-28, ACE의 규칙 목록에서 가져옴): 피드백에서 배운 규칙을 역할 설명 · 편집 방침에 섞지 않고 따로 둔다.
-- 규칙마다 번호(R<seq>)와 도움 · 해로움 횟수가 있다. 일꾼은 지시문에서 맞는 규칙을 받고, 따른 규칙 번호를 결과에 적는다.
-- 검토가 통과면 그 규칙이 도움, 관리자가 수정 요청하면 해로움으로 센다. 바꾸기(추가 · 고치기 · 합치기 · 내리기)는
-- 일꾼의 제안(propose_setting rule)을 관리자가 승인해야 된다 (원칙 3). 관리자는 콘솔에서 바로 내리고 되살린다.
-- 원칙 2: 글은 고치지 않는다 (트리거). 고치기 · 합치기는 새 규칙을 만들고 옛 규칙을 내려 replaced_by로 잇는다.
CREATE TABLE task.learned_rules (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  space_id     uuid NOT NULL,
  seq          int NOT NULL CHECK (seq >= 1),                    -- 공간 안의 번호 (지시문의 R<seq>)
  scope        text NOT NULL CHECK (scope IN ('all', 'role', 'app')),
  scope_key    text CHECK (char_length(scope_key) BETWEEN 1 AND 64),  -- role: 역할 키(agents.preset), app: 앱 id
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  helpful      int NOT NULL DEFAULT 0 CHECK (helpful >= 0),
  harmful      int NOT NULL DEFAULT 0 CHECK (harmful >= 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  approval_id  uuid REFERENCES task.approvals(id),               -- 만든 근거 (승인한 제안). 관리자가 바로 만들면 null
  replaced_by  uuid REFERENCES task.learned_rules(id),           -- 고치기 · 합치기로 내렸으면 새 규칙
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  CONSTRAINT learned_rules_seq UNIQUE (space_id, seq),
  CONSTRAINT learned_rules_scope_key CHECK ((scope = 'all') = (scope_key IS NULL)),
  CONSTRAINT learned_rules_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE INDEX learned_rules_active_idx ON task.learned_rules (space_id, status, scope);

-- 글 · 대상 · 번호는 처음 그대로 (원칙 2). 횟수 · 상태만 바뀐다
CREATE FUNCTION task.learned_rules_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key OR NEW.seq IS DISTINCT FROM OLD.seq
    OR NEW.space_id IS DISTINCT FROM OLD.space_id THEN
    RAISE EXCEPTION '배운 규칙의 글 · 대상은 바꾸지 않아요 (새 규칙으로 고쳐요)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learned_rules_fixed
  BEFORE UPDATE ON task.learned_rules
  FOR EACH ROW EXECUTE FUNCTION task.learned_rules_fixed();
CREATE TRIGGER learned_rules_no_delete
  BEFORE DELETE ON task.learned_rules
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_update_delete();

-- 규칙 하나를 센 근거 (추가만): 근거(source)마다 한 번이라 같은 판정 · 수정 요청이 두 번 와도 한 번 센다
CREATE TABLE task.rule_marks (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  space_id    uuid NOT NULL,
  rule_id     uuid NOT NULL REFERENCES task.learned_rules(id),
  source      text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),  -- verdict:<판정 작업> · approval:<결재>
  mark        text NOT NULL CHECK (mark IN ('helpful', 'harmful')),
  task_id     uuid REFERENCES task.tasks(id),                    -- 규칙을 따른 작업
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_marks_once UNIQUE (rule_id, source)
);
CREATE INDEX rule_marks_space_idx ON task.rule_marks (space_id, created_at);
CREATE TRIGGER rule_marks_append_only
  BEFORE UPDATE OR DELETE ON task.rule_marks
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_update_delete();

-- migrate:down
DROP TABLE task.rule_marks;
DROP TABLE task.learned_rules;
DROP FUNCTION task.learned_rules_fixed();
