'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'applications.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'drift2024';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const MIN_HOURS = 0;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Хранилище заявок: облачная БД (PostgreSQL/Supabase) при наличии DATABASE_URL,
// иначе локальный JSON-файл. Интерфейс одинаковый, чтобы остальной код не менялся.
// ---------------------------------------------------------------------------

let pg = null;
let pool = null;

// Загружаем pg только если он установлен (локальный режим работает и без него)
if (DATABASE_URL) {
  try {
    pg = require('pg');
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  } catch (err) {
    console.error('Не удалось загрузить pg. Установите: npm install pg');
    process.exit(1);
  }
}

const usingDB = () => !!pool && DATABASE_URL;

async function listFromDB() {
  const res = await pool.query(
    'SELECT id, nickname, contact, hours, status, created_at, decided_at FROM applications ORDER BY created_at ASC'
  );
  return res.rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    contact: r.contact || '',
    hours: r.hours,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}

async function insertToDB(a) {
  await pool.query(
    'INSERT INTO applications (id, nickname, contact, hours, status, created_at, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [a.id, a.nickname, a.contact, a.hours, a.status, a.createdAt, a.decidedAt]
  );
}

async function updateDecisionInDB(id, status, decidedAt) {
  await pool.query(
    'UPDATE applications SET status = $1, decided_at = $2 WHERE id = $3',
    [status, decidedAt, id]
  );
}

async function deleteFromDB(id) {
  await pool.query('DELETE FROM applications WHERE id = $1', [id]);
}

// ---------- Локальный JSON-режим ----------
function readApplications() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Ошибка чтения данных:', err.message);
    return [];
  }
}

function writeApplications(list) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------- Общий интерфейс (асинхронный) ----------
async function getAllApplications() {
  if (usingDB()) return listFromDB();
  return readApplications();
}
async function saveApplication(appl) {
  if (usingDB()) { await insertToDB(appl); return; }
  const list = readApplications();
  list.push(appl);
  writeApplications(list);
}
async function setDecision(id, status, decidedAt) {
  if (usingDB()) { await updateDecisionInDB(id, status, decidedAt); return; }
  const list = readApplications();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  list[idx].status = status;
  list[idx].decidedAt = decidedAt;
  writeApplications(list);
  return true;
}
async function removeApplication(id) {
  if (usingDB()) { const r = await pool.query('DELETE FROM applications WHERE id = $1 RETURNING id', [id]); return r.rowCount > 0; }
  const list = readApplications();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeApplications(list);
  return true;
}
async function findByPendingNickname(nickname) {
  const list = await getAllApplications();
  return list.find((a) => a.nickname.toLowerCase() === nickname.toLowerCase() && a.status === 'pending');
}

// ---------------------------------------------------------------------------
// Обработка ошибок/сессий
// ---------------------------------------------------------------------------

function createSessionFor(token) {
  const sessionsFile = path.join(path.dirname(DATA_FILE), 'sessions.json');
  let sessions = {};
  try {
    if (fs.existsSync(sessionsFile)) sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch (err) {
    sessions = {};
  }
  sessions[token] = Date.now();
  try {
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    console.error('Не удалось сохранить сессию:', err.message);
  }
}

function clearExpiredSessions() {
  const sessionsFile = path.join(path.dirname(DATA_FILE), 'sessions.json');
  try {
    if (!fs.existsSync(sessionsFile)) return;
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(sessions)) {
      if (now - sessions[k] > SESSION_TTL_MS) {
        delete sessions[k];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    // ignore
  }
}

function isValidSession(token) {
  if (!token) return false;
  clearExpiredSessions();
  const sessionsFile = path.join(path.dirname(DATA_FILE), 'sessions.json');
  try {
    if (!fs.existsSync(sessionsFile)) return false;
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    return typeof sessions[token] === 'number';
  } catch (err) {
    return false;
  }
}

function publicApplication(a) {
  return {
    id: a.id,
    nickname: a.nickname,
    contact: a.contact || '',
    hours: a.hours,
    status: a.status,
    createdAt: a.createdAt,
  };
}

// ---- Публичный API: подача заявки ----
app.post('/api/applications', async (req, res) => {
  const nickname = typeof req.body.nickname === 'string' ? req.body.nickname.trim() : '';
  const contact = typeof req.body.contact === 'string' ? req.body.contact.trim() : '';
  const hours = normalizeHours(req.body.hours);

  if (!nickname) {
    return res.status(400).json({ error: 'Укажите ваш ник на сервере.' });
  }
  if (nickname.length > 32) {
    return res.status(400).json({ error: 'Ник не должен быть длиннее 32 символов.' });
  }
  if (!contact) {
    return res.status(400).json({ error: 'Укажите ваш Telegram или Discord для связи.' });
  }
  if (contact.length > 60) {
    return res.status(400).json({ error: 'Контакт не должен быть длиннее 60 символов.' });
  }
  if (hours === null) {
    return res.status(400).json({ error: 'Укажите корректное число часов на сервере (0 и более).' });
  }

  const duplicate = await findByPendingNickname(nickname);
  if (duplicate) {
    return res
      .status(409)
      .json({ error: 'Заявка от этого ника уже подана и ожидает рассмотрения.' });
  }

  const application = {
    id: crypto.randomUUID(),
    nickname,
    contact,
    hours,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  await saveApplication(application);

  res.status(201).json({ ok: true, application: publicApplication(application) });
});

// ---- Админ: вход ----
app.post('/api/admin/login', (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const target = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  const given = crypto.createHash('sha256').update(password).digest('hex');

  if (!timingSafeEqualHex(target, given)) {
    return res.status(401).json({ error: 'Неверный пароль.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  createSessionFor(token);
  res.json({ ok: true, token });
});

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ---- Админ: выход ----
app.post('/api/admin/logout', (req, res) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  if (token) deleteSession(token);
  res.json({ ok: true });
});

function deleteSession(token) {
  const sessionsFile = path.join(path.dirname(DATA_FILE), 'sessions.json');
  try {
    if (fs.existsSync(sessionsFile)) {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      if (sessions[token]) {
        delete sessions[token];
        fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
      }
    }
  } catch (err) {
    // ignore
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Требуется авторизация.' });
  }
  next();
}

// ---- Админ: список заявок ----
app.get('/api/admin/applications', requireAdmin, async (req, res) => {
  const status = req.query.status;
  let list = await getAllApplications();
  if (status && ['pending', 'accepted', 'rejected'].includes(status)) {
    list = list.filter((a) => a.status === status);
  }
  res.json(list.map(publicApplication));
});

// ---- Админ: принять / отклонить ----
app.post('/api/admin/applications/:id/decide', requireAdmin, async (req, res) => {
  const decision = req.body.decision;
  if (!['accepted', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Некорректное решение.' });
  }
  const ok = await setDecision(req.params.id, decision, new Date().toISOString());
  if (!ok) return res.status(404).json({ error: 'Заявка не найдена.' });
  const list = await getAllApplications();
  const updated = list.find((a) => a.id === req.params.id);
  res.json({ ok: true, application: publicApplication(updated) });
});

// ---- Админ: удаление заявки ----
app.delete('/api/admin/applications/:id', requireAdmin, async (req, res) => {
  const ok = await removeApplication(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Заявка не найдена.' });
  res.json({ ok: true });
});

function normalizeHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_HOURS) return null;
  return Math.round(n);
}

app.get('/api/health', (req, res) => res.json({ ok: true, storage: usingDB() ? 'database' : 'file' }));

app.listen(PORT, () => {
  console.log(`Drift Paradise — сервер запущен на порту ${PORT}`);
  console.log(`Хранение заявок: ${usingDB() ? 'облачная БД (PostgreSQL)' : 'локальный JSON-файл'}`);
  if (!DATABASE_URL) {
    console.log('Подсказка: задайте DATABASE_URL, чтобы хранить заявки в облачной БД.');
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(`Пароль админа по умолчанию: ${ADMIN_PASSWORD} (смените через переменную ADMIN_PASSWORD!)`);
  }
});