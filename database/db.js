const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'dashboard.db');
const db = new DatabaseSync(DB_PATH);

// Run pragmas and create tables immediately so prepared statements below can reference them
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'client',
    company_name TEXT,
    logo_url TEXT,
    retell_api_key TEXT,
    vapi_api_key TEXT,
    twilio_account_sid TEXT,
    twilio_auth_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    call_id TEXT UNIQUE,
    call_type TEXT,
    from_number TEXT,
    to_number TEXT,
    agent_id TEXT,
    agent_name TEXT,
    status TEXT,
    start_timestamp INTEGER,
    end_timestamp INTEGER,
    duration_seconds INTEGER,
    recording_url TEXT,
    recording_local_path TEXT,
    transcript TEXT,
    call_summary TEXT,
    call_outcome TEXT,
    retell_cost REAL DEFAULT 0,
    twilio_cost REAL DEFAULT 0,
    llm_cost REAL DEFAULT 0,
    total_cost REAL DEFAULT 0,
    raw_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    city TEXT,
    notes TEXT,
    status TEXT DEFAULT 'pending',
    last_called_at DATETIME,
    call_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS cost_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date TEXT,
    total_calls INTEGER DEFAULT 0,
    total_minutes REAL DEFAULT 0,
    retell_cost REAL DEFAULT 0,
    twilio_cost REAL DEFAULT 0,
    llm_cost REAL DEFAULT 0,
    total_cost REAL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    call_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'pending',
    service_type TEXT,
    notes TEXT,
    confirmation_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS working_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    is_open INTEGER DEFAULT 1,
    start_time TEXT DEFAULT '09:00',
    end_time TEXT DEFAULT '17:00',
    slot_duration INTEGER DEFAULT 30,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS email_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    smtp_host TEXT,
    smtp_port INTEGER DEFAULT 587,
    smtp_user TEXT,
    smtp_pass TEXT,
    from_name TEXT,
    from_email TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
  CREATE INDEX IF NOT EXISTS idx_calls_start_timestamp ON calls(start_timestamp);
  CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
  CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
  CREATE INDEX IF NOT EXISTS idx_cost_daily_user_date ON cost_daily(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_appointments_user_date ON appointments(user_id, appointment_date);
`);

// Run migrations immediately (before prepared statements below)
try { db.exec(`ALTER TABLE users ADD COLUMN vapi_api_key TEXT`); } catch (e) { /* already exists */ }

// Function call logs table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS function_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    function_name TEXT,
    args_json TEXT,
    result TEXT,
    status TEXT DEFAULT 'success',
    call_id TEXT,
    raw_request TEXT,
    response_sent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
} catch(e) {}

// Webhook event logs table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    event_type TEXT,
    call_id TEXT,
    user_id INTEGER,
    raw_body TEXT,
    error_message TEXT,
    status TEXT DEFAULT 'received',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
} catch(e) {}

// Migrations for existing installs
try { db.exec(`ALTER TABLE function_logs ADD COLUMN raw_request TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE function_logs ADD COLUMN response_sent TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'Australia/Sydney'`); } catch(e) {}
// New table migrations — safe to re-run
try { db.exec(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, call_id TEXT, customer_name TEXT, customer_phone TEXT, customer_email TEXT, appointment_date TEXT NOT NULL, appointment_time TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, status TEXT DEFAULT 'pending', service_type TEXT, notes TEXT, confirmation_sent INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS working_hours (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, day_of_week INTEGER NOT NULL, is_open INTEGER DEFAULT 1, start_time TEXT DEFAULT '09:00', end_time TEXT DEFAULT '17:00', slot_duration INTEGER DEFAULT 30)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS email_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, smtp_host TEXT, smtp_port INTEGER DEFAULT 587, smtp_user TEXT, smtp_pass TEXT, from_name TEXT, from_email TEXT)`); } catch(e) {}

function initDatabase() {
  console.log('[DB] Database initialized at', DB_PATH);
}

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme123', 10);
    db.prepare(`
      INSERT INTO users (name, email, password, role, company_name)
      VALUES (?, ?, ?, 'admin', 'Agency Admin')
    `).run(
      process.env.ADMIN_NAME || 'Administrator',
      process.env.ADMIN_EMAIL || 'admin@yourdomain.com',
      hash
    );
    console.log(`[DB] Admin user created: ${process.env.ADMIN_EMAIL}`);
  }
}

// --- User queries ---
const userQueries = {
  findByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findById: db.prepare('SELECT id, name, email, role, company_name, logo_url, retell_api_key, vapi_api_key, twilio_account_sid, twilio_auth_token, created_at FROM users WHERE id = ?'),
  findAll: db.prepare('SELECT id, name, email, role, company_name, created_at FROM users ORDER BY created_at DESC'),
  create: db.prepare(`
    INSERT INTO users (name, email, password, role, company_name, retell_api_key, twilio_account_sid, twilio_auth_token)
    VALUES (@name, @email, @password, @role, @company_name, @retell_api_key, @twilio_account_sid, @twilio_auth_token)
  `),
  update: db.prepare(`
    UPDATE users SET name=@name, company_name=@company_name, retell_api_key=@retell_api_key,
    twilio_account_sid=@twilio_account_sid, twilio_auth_token=@twilio_auth_token
    WHERE id=@id
  `),
  updatePassword: db.prepare('UPDATE users SET password=? WHERE id=?'),
  delete: db.prepare('DELETE FROM users WHERE id=?'),
  getApiKeys: db.prepare("SELECT id, retell_api_key, vapi_api_key, twilio_account_sid, twilio_auth_token FROM users WHERE (retell_api_key IS NOT NULL AND retell_api_key != '') OR (vapi_api_key IS NOT NULL AND vapi_api_key != '')"),
};

// --- Call queries ---
const callQueries = {
  findById: db.prepare('SELECT * FROM calls WHERE id = ?'),
  findByCallId: db.prepare('SELECT * FROM calls WHERE call_id = ?'),
  upsert: db.prepare(`
    INSERT INTO calls (user_id, call_id, call_type, from_number, to_number, agent_id, agent_name,
      status, start_timestamp, end_timestamp, duration_seconds, recording_url, transcript,
      call_summary, call_outcome, retell_cost, twilio_cost, llm_cost, total_cost, raw_data)
    VALUES (@user_id, @call_id, @call_type, @from_number, @to_number, @agent_id, @agent_name,
      @status, @start_timestamp, @end_timestamp, @duration_seconds, @recording_url, @transcript,
      @call_summary, @call_outcome, @retell_cost, @twilio_cost, @llm_cost, @total_cost, @raw_data)
    ON CONFLICT(call_id) DO UPDATE SET
      status=excluded.status, end_timestamp=excluded.end_timestamp,
      duration_seconds=excluded.duration_seconds, recording_url=excluded.recording_url,
      transcript=excluded.transcript, call_summary=excluded.call_summary,
      retell_cost=excluded.retell_cost, twilio_cost=excluded.twilio_cost,
      llm_cost=excluded.llm_cost, total_cost=excluded.total_cost, raw_data=excluded.raw_data
  `),
  updateRecordingPath: db.prepare('UPDATE calls SET recording_local_path=? WHERE call_id=?'),
  updateOutcome: db.prepare('UPDATE calls SET call_outcome=? WHERE id=? AND user_id=?'),
  getActiveCalls: db.prepare("SELECT * FROM calls WHERE status = 'ongoing' ORDER BY start_timestamp DESC"),
  getActiveCallsForUser: db.prepare("SELECT * FROM calls WHERE status = 'ongoing' AND user_id = ? ORDER BY start_timestamp DESC"),
};

function buildCallsQuery(userId, filters = {}) {
  const conditions = [];
  const params = [];

  if (userId) { conditions.push('user_id = ?'); params.push(userId); }
  if (filters.type && filters.type !== 'all') { conditions.push('call_type = ?'); params.push(filters.type); }
  if (filters.status && filters.status !== 'all') { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.from_date) { conditions.push('start_timestamp >= ?'); params.push(new Date(filters.from_date).getTime()); }
  if (filters.to_date) { conditions.push('start_timestamp <= ?'); params.push(new Date(filters.to_date).getTime() + 86400000); }
  if (filters.search) {
    conditions.push('(from_number LIKE ? OR to_number LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = parseInt(filters.limit) || 25;
  const offset = ((parseInt(filters.page) || 1) - 1) * limit;

  const rows = db.prepare(`SELECT * FROM calls ${where} ORDER BY start_timestamp DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as count FROM calls ${where}`)
    .get(...params).count;

  return { rows, total, page: parseInt(filters.page) || 1, limit };
}

// --- Lead queries ---
const leadQueries = {
  findById: db.prepare('SELECT * FROM leads WHERE id = ?'),
  findAll: (userId, status) => {
    const conds = [];
    const params = [];
    if (userId) { conds.push('user_id = ?'); params.push(userId); }
    if (status && status !== 'all') { conds.push('status = ?'); params.push(status); }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    return db.prepare(`SELECT * FROM leads${where} ORDER BY created_at DESC`).all(...params);
  },
  create: db.prepare(`
    INSERT INTO leads (user_id, name, phone, email, city, notes, status)
    VALUES (@user_id, @name, @phone, @email, @city, @notes, 'pending')
  `),
  update: db.prepare(`
    UPDATE leads SET name=@name, phone=@phone, email=@email, city=@city,
    notes=@notes, status=@status WHERE id=@id AND user_id=@user_id
  `),
  updateStatus: db.prepare('UPDATE leads SET status=?, last_called_at=?, call_count=call_count+1 WHERE id=?'),
  delete: db.prepare('DELETE FROM leads WHERE id=? AND user_id=?'),
};

// --- Cost queries ---
function upsertDailyCost(userId, date, data) {
  const existing = db.prepare('SELECT id FROM cost_daily WHERE user_id=? AND date=?').get(userId, date);
  if (existing) {
    db.prepare(`
      UPDATE cost_daily SET total_calls=total_calls+@calls, total_minutes=total_minutes+@minutes,
      retell_cost=retell_cost+@retell, twilio_cost=twilio_cost+@twilio,
      llm_cost=llm_cost+@llm, total_cost=total_cost+@total WHERE user_id=@uid AND date=@date
    `).run({ calls: data.calls, minutes: data.minutes, retell: data.retell, twilio: data.twilio, llm: data.llm, total: data.total, uid: userId, date });
  } else {
    db.prepare(`
      INSERT INTO cost_daily (user_id, date, total_calls, total_minutes, retell_cost, twilio_cost, llm_cost, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, date, data.calls, data.minutes, data.retell, data.twilio, data.llm, data.total);
  }
}

function getDailyCosts(userId, days = 30) {
  if (userId) {
    return db.prepare('SELECT * FROM cost_daily WHERE user_id=? ORDER BY date DESC LIMIT ?').all(userId, days);
  }
  return db.prepare('SELECT date, SUM(total_calls) as total_calls, SUM(total_minutes) as total_minutes, SUM(retell_cost) as retell_cost, SUM(twilio_cost) as twilio_cost, SUM(llm_cost) as llm_cost, SUM(total_cost) as total_cost FROM cost_daily GROUP BY date ORDER BY date DESC LIMIT ?').all(days);
}

function getMonthlySummary(userId) {
  const monthStr = new Date().toISOString().slice(0, 7);
  if (userId) {
    return db.prepare(`SELECT SUM(total_calls) as total_calls, SUM(total_minutes) as total_minutes, SUM(retell_cost) as retell_cost, SUM(twilio_cost) as twilio_cost, SUM(llm_cost) as llm_cost, SUM(total_cost) as total_cost FROM cost_daily WHERE user_id=? AND date LIKE ?`).get(userId, `${monthStr}%`);
  }
  return db.prepare(`SELECT SUM(total_calls) as total_calls, SUM(total_minutes) as total_minutes, SUM(retell_cost) as retell_cost, SUM(twilio_cost) as twilio_cost, SUM(llm_cost) as llm_cost, SUM(total_cost) as total_cost FROM cost_daily WHERE date LIKE ?`).get(`${monthStr}%`);
}

function getCostByClient() {
  const monthStr = new Date().toISOString().slice(0, 7);
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.company_name,
    COALESCE(SUM(c.total_calls),0) as total_calls,
    COALESCE(SUM(c.total_cost),0) as total_cost
    FROM users u
    LEFT JOIN cost_daily c ON c.user_id=u.id AND c.date LIKE ?
    WHERE u.role='client'
    GROUP BY u.id ORDER BY total_cost DESC
  `).all(`${monthStr}%`);
}

function getDashboardStats(userId) {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const base = userId ? 'AND user_id=?' : '';
  const p = userId ? [userId] : [];

  const todayTotal = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE start_timestamp>=? ${base}`).get(todayStart.getTime(), ...p).c;
  const monthTotal = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE start_timestamp>=? ${base}`).get(monthStart.getTime(), ...p).c;
  const todayInbound = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE call_type='inbound' AND start_timestamp>=? ${base}`).get(todayStart.getTime(), ...p).c;
  const todayOutbound = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE call_type='outbound' AND start_timestamp>=? ${base}`).get(todayStart.getTime(), ...p).c;
  const monthMinutesRow = db.prepare(`SELECT COALESCE(SUM(duration_seconds),0)/60.0 as m FROM calls WHERE start_timestamp>=? ${base}`).get(monthStart.getTime(), ...p);
  const monthMinutes = monthMinutesRow ? monthMinutesRow.m : 0;
  const activeNow = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE status='ongoing' ${base}`).get(...p).c;
  const monthAnswered = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE status='ended' AND start_timestamp>=? ${base}`).get(monthStart.getTime(), ...p).c;
  const answerRate = monthTotal > 0 ? Math.round((monthAnswered / monthTotal) * 100) : 0;

  const monthStr = new Date().toISOString().slice(0, 7);
  const costRow = userId
    ? db.prepare(`SELECT COALESCE(SUM(total_cost),0) as t FROM cost_daily WHERE user_id=? AND date LIKE ?`).get(userId, `${monthStr}%`)
    : db.prepare(`SELECT COALESCE(SUM(total_cost),0) as t FROM cost_daily WHERE date LIKE ?`).get(`${monthStr}%`);

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
    const dateStr = d.toISOString().slice(0,10);
    const inb = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE call_type='inbound' AND start_timestamp>=? AND start_timestamp<=? ${base}`).get(d.getTime(), dEnd.getTime(), ...p).c;
    const out = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE call_type='outbound' AND start_timestamp>=? AND start_timestamp<=? ${base}`).get(d.getTime(), dEnd.getTime(), ...p).c;
    last7.push({ date: dateStr, inbound: inb, outbound: out });
  }

  return {
    todayTotal, monthTotal, todayInbound, todayOutbound,
    monthMinutes: parseFloat((monthMinutes || 0).toFixed(1)),
    activeNow, answerRate,
    monthCost: parseFloat((costRow?.t || 0).toFixed(2)),
    last7Days: last7,
  };
}

module.exports = {
  db,
  initDatabase,
  seedAdmin,
  userQueries,
  callQueries,
  buildCallsQuery,
  leadQueries,
  upsertDailyCost,
  getDailyCosts,
  getMonthlySummary,
  getCostByClient,
  getDashboardStats,
};
