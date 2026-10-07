import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, initDb } from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const sessionSecret = process.env.SESSION_SECRET || crypto.createHash('sha256').update(process.env.DATABASE_URL || 'biotec-bdt-local').digest('hex');

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir, { etag: true, maxAge: '1h' }));

function b64url(input) { return Buffer.from(input).toString('base64url'); }
function sign(payload) { return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url'); }
function createToken(user) {
  const payload = b64url(JSON.stringify({ uid: user.id, role: user.role, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function readToken(req) {
  const token = parseCookies(req).bdt_session;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function setSession(res, user) {
  res.setHeader('Set-Cookie', `bdt_session=${createToken(user)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `bdt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const existing = Buffer.from(hash, 'hex');
  return existing.length === candidate.length && crypto.timingSafeEqual(existing, candidate);
}
function cleanText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function normalizeCode(value) { return cleanText(value, 60).toUpperCase().replace(/\s+/g, ''); }
function required(obj, fields) { return fields.filter(f => !cleanText(obj[f])); }

async function auth(req, res, next) {
  const data = readToken(req);
  if (!data) return res.status(401).json({ error: 'Não autenticado.' });
  const { rows } = await pool.query('SELECT id, username, role, active FROM bdt_users WHERE id=$1', [data.uid]);
  if (!rows[0] || !rows[0].active) return res.status(401).json({ error: 'Sessão inválida.' });
  req.user = rows[0]; next();
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected', app: 'Biotec BDT' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'error', error: e.message }); }
});
app.get('/api/setup/status', async (_req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM bdt_users');
  res.json({ needsSetup: rows[0].count === 0 });
});
app.post('/api/setup', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM bdt_users');
  if (rows[0].count !== 0) return res.status(409).json({ error: 'Configuração inicial já concluída.' });
  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || '');
  if (username.length < 3 || password.length < 6) return res.status(400).json({ error: 'Use login com 3+ caracteres e senha com 6+ caracteres.' });
  const r = await pool.query('INSERT INTO bdt_users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role', [username, hashPassword(password), 'admin']);
  setSession(res, r.rows[0]); res.json({ user: r.rows[0] });
});
app.post('/api/login', async (req, res) => {
  const username = cleanText(req.body.username, 80);
  const { rows } = await pool.query('SELECT * FROM bdt_users WHERE lower(username)=lower($1) AND active=true LIMIT 1', [username]);
  const user = rows[0];
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) return res.status(401).json({ error: 'Login ou senha inválidos.' });
  setSession(res, user); res.json({ user: { id: user.id, username: user.username, role: user.role } });
});
app.post('/api/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/machines', auth, async (req, res) => {
  const q = normalizeCode(req.query.q || '');
  if (!q) return res.json({ machines: [] });
  const compact = q.replace(/[^A-Z0-9]/g, '');
  const numeric = /^\d+$/.test(compact) ? String(Number(compact)) : null;
  const { rows } = await pool.query(`
    SELECT id, code, description FROM bdt_machines
    WHERE active=true AND (
      regexp_replace(upper(code),'[^A-Z0-9]','','g') LIKE $1
      OR upper(description) LIKE $2
      OR ($3::text IS NOT NULL AND regexp_replace(upper(code),'[^0-9]','','g')::text = $3)
    )
    ORDER BY code LIMIT 12`, [`%${compact}%`, `%${q}%`, numeric]);
  res.json({ machines: rows });
});
app.get('/api/machines/all', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query('SELECT id, code, description, active FROM bdt_machines ORDER BY code');
  res.json({ machines: rows });
});
app.post('/api/machines', auth, adminOnly, async (req, res) => {
  const code = normalizeCode(req.body.code); const description = cleanText(req.body.description, 180);
  if (!code || !description) return res.status(400).json({ error: 'Informe BT e descrição.' });
  const { rows } = await pool.query(`INSERT INTO bdt_machines(code,description,active) VALUES($1,$2,true)
    ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description, active=true, updated_at=NOW()
    RETURNING id,code,description,active`, [code, description]);
  res.json({ machine: rows[0] });
});
app.delete('/api/machines/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE bdt_machines SET active=false, updated_at=NOW() WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

app.get('/api/users', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,username,role,active,created_at FROM bdt_users ORDER BY username'); res.json({ users: rows });
});
app.post('/api/users', auth, adminOnly, async (req, res) => {
  const username = cleanText(req.body.username, 80); const password = String(req.body.password || ''); const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (username.length < 3 || password.length < 6) return res.status(400).json({ error: 'Login mínimo 3 caracteres; senha mínima 6.' });
  try {
    const { rows } = await pool.query('INSERT INTO bdt_users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role,active', [username, hashPassword(password), role]);
    res.json({ user: rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Login já existe.' }); throw e; }
});
app.patch('/api/users/:id', auth, adminOnly, async (req, res) => {
  const id = req.params.id; const role = req.body.role === 'admin' ? 'admin' : 'user'; const active = req.body.active !== false; const password = String(req.body.password || '');
  if (String(id) === String(req.user.id) && !active) return res.status(400).json({ error: 'Não é possível desativar o próprio usuário.' });
  if (password) await pool.query('UPDATE bdt_users SET role=$1, active=$2, password_hash=$3, updated_at=NOW() WHERE id=$4', [role, active, hashPassword(password), id]);
  else await pool.query('UPDATE bdt_users SET role=$1, active=$2, updated_at=NOW() WHERE id=$3', [role, active, id]);
  res.json({ ok: true });
});

const recordFields = ['work_date','shift','farm','up_area','machine_code','machine_description','operator_name','employee_id','hourmeter_initial','hourmeter_final','hourmeter_hours','shift_start','shift_end','total_trips','shift_hours','operated_hours','unproductive_hours','operational_stops','maintenance_stops'];
app.post('/api/records', auth, async (req, res) => {
  const b = req.body || {}; const missing = required(b, recordFields);
  if (missing.length) return res.status(400).json({ error: `Preencha os campos obrigatórios: ${missing.join(', ')}` });
  const machineCode = normalizeCode(b.machine_code);
  const m = await pool.query('SELECT code,description FROM bdt_machines WHERE active=true AND upper(code)=upper($1) LIMIT 1', [machineCode]);
  if (!m.rows[0]) return res.status(400).json({ error: 'BT não encontrado no cadastro.' });
  const trips = Array.isArray(b.trips) ? b.trips.slice(0, 100) : [];
  const interventions = Array.isArray(b.interventions) ? b.interventions.slice(0, 100) : [];
  const vals = [cleanText(b.work_date,20),cleanText(b.shift,30),cleanText(b.operation_code,30),cleanText(b.sheet_no,20),cleanText(b.sheet_total,20),cleanText(b.farm,180),cleanText(b.up_area,180),m.rows[0].code,m.rows[0].description,cleanText(b.operator_name,180),cleanText(b.employee_id,80),cleanText(b.trailer_set,180),cleanText(b.hourmeter_initial,40),cleanText(b.hourmeter_final,40),cleanText(b.hourmeter_hours,40),cleanText(b.shift_start,20),cleanText(b.shift_end,20),cleanText(b.hourmeter_fueling,40),cleanText(b.diesel_l,40),cleanText(b.hydraulic_oil_l,40),cleanText(b.fueling_responsible,180),JSON.stringify(trips),JSON.stringify(interventions),cleanText(b.total_trips,40),cleanText(b.shift_hours,40),cleanText(b.operated_hours,40),cleanText(b.unproductive_hours,40),cleanText(b.operational_stops,40),cleanText(b.maintenance_stops,40),cleanText(b.observations,5000),cleanText(b.operator_signature,180),cleanText(b.supervisor_signature,180),req.user.id];
  const { rows } = await pool.query(`INSERT INTO bdt_records(work_date,shift,operation_code,sheet_no,sheet_total,farm,up_area,machine_code,machine_description,operator_name,employee_id,trailer_set,hourmeter_initial,hourmeter_final,hourmeter_hours,shift_start,shift_end,hourmeter_fueling,diesel_l,hydraulic_oil_l,fueling_responsible,trips,interventions,total_trips,shift_hours,operated_hours,unproductive_hours,operational_stops,maintenance_stops,observations,operator_signature,supervisor_signature,created_by)
  VALUES(${vals.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id,created_at`, vals);
  res.json({ record: rows[0] });
});
app.get('/api/records', auth, async (req, res) => {
  const params=[]; let where='';
  if (req.user.role !== 'admin') { params.push(req.user.id); where='WHERE r.created_by=$1'; }
  const { rows } = await pool.query(`SELECT r.id,r.work_date,r.shift,r.farm,r.up_area,r.machine_code,r.machine_description,r.operator_name,r.total_trips,r.created_at,u.username AS created_by_name FROM bdt_records r LEFT JOIN bdt_users u ON u.id=r.created_by ${where} ORDER BY r.id DESC LIMIT 300`, params);
  res.json({ records: rows });
});
app.get('/api/records/:id', auth, async (req, res) => {
  const params=[req.params.id]; let where='r.id=$1';
  if (req.user.role !== 'admin') { params.push(req.user.id); where+=' AND r.created_by=$2'; }
  const { rows } = await pool.query(`SELECT r.*,u.username AS created_by_name FROM bdt_records r LEFT JOIN bdt_users u ON u.id=r.created_by WHERE ${where}`, params);
  if (!rows[0]) return res.status(404).json({ error:'Registro não encontrado.' }); res.json({ record: rows[0] });
});
app.delete('/api/records/:id', auth, adminOnly, async (req, res) => { await pool.query('DELETE FROM bdt_records WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Erro interno do servidor.' }); });

initDb().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Biotec BDT online na porta ${PORT}`))).catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
