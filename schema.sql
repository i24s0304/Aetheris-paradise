-- Создание таблицы заявок для Drift Paradise (Supabase / PostgreSQL)
-- Выполнить в Supabase: SQL Editor -> New query -> вставить -> Run

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  hours INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_nickname ON applications (lower(nickname));