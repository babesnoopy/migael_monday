-- ============================================================
-- Migael Team v1 — Database Schema (sql.js / SQLite syntax)
-- ============================================================

-- ----------------------------------------------------------
-- Users: ทีมงานทุกคน (ผูกกับ LINE userId)
-- ----------------------------------------------------------
CREATE TABLE users (
    id            TEXT PRIMARY KEY,      -- LINE userId
    display_name  TEXT NOT NULL,         -- ชื่อที่ใช้เรียก เช่น "แคน"
    team_id       TEXT,                  -- FK -> teams.id (1 คน = 1 ทีมเสมอ)
    role          TEXT DEFAULT 'member', -- 'owner' | 'lead' | 'member'
    onboarded_at  DATETIME,              -- เวลาที่แนะนำตัวเสร็จ
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------
-- Teams / Departments: Set up, Decor, Content, Production ฯลฯ
-- ----------------------------------------------------------
CREATE TABLE teams (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,         -- "Decor", "Set up/Management", ...
    project_id    TEXT,                  -- FK -> projects.id (ทีมสังกัดโปรเจกต์ไหนหลัก)
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------
-- Projects: Unfest26, Uncommu, Unformat Content ฯลฯ
-- ----------------------------------------------------------
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------
-- Groups: LINE group <-> project mapping (1 group อาจดูหลายโปรเจกต์)
-- ----------------------------------------------------------
CREATE TABLE line_groups (
    id            TEXT PRIMARY KEY,      -- LINE groupId
    group_name    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_projects (
    group_id      TEXT NOT NULL REFERENCES line_groups(id),
    project_id    TEXT NOT NULL REFERENCES projects(id),
    PRIMARY KEY (group_id, project_id)
);

-- Tracks which LINE groups each user is actually active in. Needed because
-- one person can be in multiple groups, and roster lookups must be scoped
-- to a single group (a plain users table has no group context on its own).
CREATE TABLE group_members (
    group_id      TEXT NOT NULL REFERENCES line_groups(id),
    user_id       TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (group_id, user_id)
);

-- ----------------------------------------------------------
-- Calendars: Google Calendar mapping ต่อโปรเจกต์
-- ----------------------------------------------------------
CREATE TABLE calendars (
    id                TEXT PRIMARY KEY,       -- Google Calendar ID
    name              TEXT NOT NULL,          -- "UNFEST'26: MEETING"
    project_id        TEXT REFERENCES projects(id),
    calendar_purpose  TEXT,                   -- 'creative' | 'meeting' | 'production' | 'content' | null
    requires_confirm  BOOLEAN DEFAULT 0        -- 1 = ต้องถามยืนยันก่อนสร้าง event ทุกครั้ง (เช่น UNFEST26)
);

-- ----------------------------------------------------------
-- Tasks: งานที่ต้องทำ
-- ----------------------------------------------------------
CREATE TABLE tasks (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    project_id     TEXT REFERENCES projects(id),
    team_id        TEXT REFERENCES teams(id),
    assignee_id    TEXT REFERENCES users(id),
    created_by     TEXT REFERENCES users(id),      -- ใครเป็นคนสั่งงาน
    status         TEXT DEFAULT 'to_do',           -- 'to_do' | 'in_progress' | 'review' | 'done'
    priority       TEXT,                            -- 'urgent' | 'normal' | ...
    is_urgent      BOOLEAN DEFAULT 0,
    due_date       DATETIME,
    group_id       TEXT REFERENCES line_groups(id), -- ที่มาของงาน (กลุ่มไหนสั่ง)
    note           TEXT,                            -- ข้อมูลแนบ เช่น email, link
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at   DATETIME
);

-- ----------------------------------------------------------
-- Events: มีตติ้ง/นัดหมาย
-- ----------------------------------------------------------
CREATE TABLE events (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    start_time     DATETIME NOT NULL,
    end_time       DATETIME,
    location       TEXT,
    meeting_link   TEXT,
    calendar_id    TEXT REFERENCES calendars(id),   -- ปลายทางใน Google Calendar
    google_event_id TEXT,                            -- id ของ event จริงใน Google Calendar
    project_id     TEXT REFERENCES projects(id),
    group_id       TEXT REFERENCES line_groups(id),
    created_by     TEXT REFERENCES users(id),
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ผู้เข้าร่วมมีตติ้ง (many-to-many)
CREATE TABLE event_attendees (
    event_id       TEXT NOT NULL REFERENCES events(id),
    user_id        TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (event_id, user_id)
);

-- ----------------------------------------------------------
-- Reminders: การเตือนที่ยิงไปแล้ว/ต้องยิง
-- ----------------------------------------------------------
CREATE TABLE reminders (
    id             TEXT PRIMARY KEY,
    ref_type       TEXT NOT NULL,        -- 'task' | 'event'
    ref_id         TEXT NOT NULL,        -- FK -> tasks.id หรือ events.id
    reminder_type  TEXT NOT NULL,        -- 'pre_30min' | 'pre_10min' | 'overdue'
    scheduled_at   DATETIME NOT NULL,
    sent_at        DATETIME,
    group_id       TEXT REFERENCES line_groups(id),
    escalation_count INTEGER DEFAULT 0   -- นับจำนวนครั้งที่เตือนซ้ำ (สำหรับ overdue)
);

-- ----------------------------------------------------------
-- Listening Mode Sessions: track context หลังถูกเรียกชื่อ
-- ----------------------------------------------------------
CREATE TABLE listening_sessions (
    id             TEXT PRIMARY KEY,
    group_id       TEXT NOT NULL REFERENCES line_groups(id),
    triggered_by   TEXT REFERENCES users(id),
    linked_ref_type TEXT,                -- 'task' | 'event' | null (ยังไม่ระบุ)
    linked_ref_id  TEXT,
    started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at       DATETIME,             -- null = ยัง active อยู่
    end_reason     TEXT                  -- 'topic_changed' | 'manual' | null
);

-- ----------------------------------------------------------
-- Daily Summaries: เก็บ personal summary ที่ส่งให้เบ้บ
-- ----------------------------------------------------------
CREATE TABLE daily_summaries (
    id             TEXT PRIMARY KEY,
    summary_date   DATE NOT NULL,
    recipient_id   TEXT REFERENCES users(id),  -- เบ้บ
    content_json   TEXT NOT NULL,               -- structured data ใกล้เคียง sheet columns
    sent_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------
-- Topics: ongoing discussion threads (specs, ideas, decisions-in-progress)
-- that span multiple chat sessions over time — different from Task/Event
-- because there's no single deadline or start time, just an evolving
-- summary. This is what lets Migael recap "where did we leave off" and
-- follow up with the right people without anyone re-reading old chat.
-- ----------------------------------------------------------
CREATE TABLE topics (
    id             TEXT PRIMARY KEY,
    group_id       TEXT REFERENCES line_groups(id),
    project_id     TEXT REFERENCES projects(id),
    title          TEXT NOT NULL,           -- short label, e.g. "Epson projector spec"
    summary        TEXT NOT NULL,           -- latest known state, rewritten each update
    status         TEXT DEFAULT 'open',     -- 'open' | 'resolved'
    reference_link TEXT,                    -- e.g. Canva/Drive link shared in the discussion
    created_by     TEXT REFERENCES users(id),
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Who's tagged/involved in a topic, so Migael knows who to follow up with
-- as it progresses (mirrors event_attendees but for topics, not events).
CREATE TABLE topic_participants (
    topic_id       TEXT NOT NULL REFERENCES topics(id),
    user_id        TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (topic_id, user_id)
);

-- ----------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------
CREATE INDEX idx_tasks_assignee   ON tasks(assignee_id);
CREATE INDEX idx_tasks_status     ON tasks(status);
CREATE INDEX idx_tasks_due        ON tasks(due_date);
CREATE INDEX idx_events_start     ON events(start_time);
CREATE INDEX idx_reminders_sched  ON reminders(scheduled_at, sent_at);
CREATE INDEX idx_topics_group     ON topics(group_id, status);
