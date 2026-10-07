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
app.use(express.static(publicDir, { etag: true, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control','no-store, max-age=0') }));

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
function parseNumber(value) {
  const s = String(value ?? '').trim().replace(/\s/g,'').replace(',','.');
  if (!s) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
function minutesBetween(start, end) {
  if (!start || !end) return null;
  const a = String(start).split(':').map(Number), b = String(end).split(':').map(Number);
  if (a.length < 2 || b.length < 2 || [...a,...b].some(Number.isNaN)) return null;
  let x = a[0]*60+a[1], y = b[0]*60+b[1]; if (y < x) y += 1440; return y-x;
}
function fmtDecimal(n) { return n == null || !Number.isFinite(n) ? '' : Number(n.toFixed(2)).toString().replace('.',','); }
function fmtHoursMinutes(min) { return min == null || !Number.isFinite(min) ? '' : (min/60).toFixed(2).replace('.',','); }
const maintenanceCodes = new Set(['02','05','06','07','11','12','20','21','22']);
function calculateRecord(body) {
  const hi = parseNumber(body.hourmeter_initial), hf = parseNumber(body.hourmeter_final);
  if (hi == null || hf == null || hf < hi) throw Object.assign(new Error('Horímetros inválidos. O final deve ser maior ou igual ao inicial.'), { status: 400 });
  const hourmeterHours = hf-hi;
  const shiftMinutes = minutesBetween(body.shift_start, body.shift_end);
  if (shiftMinutes == null) throw Object.assign(new Error('Informe início e fim do turno.'), { status: 400 });
  const trips = (Array.isArray(body.trips) ? body.trips : []).slice(0,100).map(t => {
    const cycle = minutesBetween(t.start, t.end);
    return { origin:cleanText(t.origin,100), destination:cleanText(t.destination,100), start:cleanText(t.start,20), end:cleanText(t.end,20), cycle:cycle==null?'':String(cycle), stop_code:cleanText(t.stop_code,10) };
  }).filter(t => t.origin || t.destination || t.start || t.end || t.stop_code);
  let totalStop=0, maintenance=0, operational=0;
  const interventions = (Array.isArray(body.interventions) ? body.interventions : []).slice(0,100).map(i => {
    const minutes = minutesBetween(i.start, i.end);
    const code = cleanText(i.code,10);
    if (code && minutes != null) { totalStop += minutes; if (maintenanceCodes.has(code)) maintenance += minutes; else operational += minutes; }
    return { code, start:cleanText(i.start,20), end:cleanText(i.end,20), reason:cleanText(i.reason,300), minutes:minutes==null?'':String(minutes) };
  }).filter(i => i.code || i.start || i.end || i.reason);
  const unproductiveHours = Math.max(shiftMinutes/60-hourmeterHours,0);
  return {
    trips, interventions,
    hourmeter_hours: fmtDecimal(hourmeterHours),
    total_trips: String(trips.length),
    shift_hours: fmtHoursMinutes(shiftMinutes),
    operated_hours: fmtDecimal(hourmeterHours),
    unproductive_hours: fmtDecimal(unproductiveHours),
    operational_stops: fmtHoursMinutes(operational),
    maintenance_stops: fmtHoursMinutes(maintenance)
  };
}

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
  const numeric = /^\d+$/.test(compact) ? Number(compact) : null;
  const { rows } = await pool.query(`
    WITH machine_source AS (
      SELECT code, description, 0 AS priority FROM bdt_machines WHERE active=true
      UNION ALL
      SELECT machine_code AS code, machine_description AS description, 1 AS priority
      FROM bdt_records WHERE machine_code<>'' AND machine_description<>''
    ), dedup AS (
      SELECT DISTINCT ON (upper(code)) code, description, priority
      FROM machine_source ORDER BY upper(code), priority
    )
    SELECT code, description FROM dedup
    WHERE regexp_replace(upper(code),'[^A-Z0-9]','','g') LIKE $1
       OR upper(description) LIKE $2
       OR ($3::bigint IS NOT NULL AND NULLIF(regexp_replace(code,'[^0-9]','','g'),'')::bigint = $3)
    ORDER BY code LIMIT 20`, [`%${compact}%`, `%${q}%`, numeric]);
  res.json({ machines: rows });
});

app.get('/api/catalogs', auth, async (_req, res) => {
  const [farms, operators, machines] = await Promise.all([
    pool.query(`SELECT name FROM bdt_farms WHERE active=true ORDER BY name`),
    pool.query(`SELECT DISTINCT ON (lower(operator_name)) operator_name AS name, employee_id FROM bdt_records WHERE trim(operator_name)<>'' ORDER BY lower(operator_name), id DESC`),
    pool.query(`SELECT code,description FROM bdt_machines WHERE active=true ORDER BY code`)
  ]);
  res.json({ farms: farms.rows.map(r=>r.name), operators: operators.rows, machines: machines.rows });
});

app.get('/api/farms/all', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,name,active FROM bdt_farms ORDER BY name');
  res.json({ farms: rows });
});
app.post('/api/farms', auth, adminOnly, async (req, res) => {
  const name = cleanText(req.body.name, 180).toUpperCase();
  if (!name) return res.status(400).json({ error: 'Informe o nome da fazenda.' });
  const { rows } = await pool.query(`INSERT INTO bdt_farms(name,active) VALUES($1,true)
    ON CONFLICT(name) DO UPDATE SET active=true, updated_at=NOW()
    RETURNING id,name,active`, [name]);
  res.json({ farm: rows[0] });
});
app.patch('/api/farms/:id', auth, adminOnly, async (req, res) => {
  const name = cleanText(req.body.name, 180).toUpperCase();
  const active = req.body.active !== false;
  if (!name) return res.status(400).json({ error: 'Informe o nome da fazenda.' });
  try {
    const { rows } = await pool.query('UPDATE bdt_farms SET name=$1,active=$2,updated_at=NOW() WHERE id=$3 RETURNING id,name,active', [name,active,req.params.id]);
    if (!rows[0]) return res.status(404).json({error:'Fazenda não encontrada.'});
    res.json({farm:rows[0]});
  } catch(e) { if(e.code==='23505') return res.status(409).json({error:'Já existe uma fazenda com esse nome.'}); throw e; }
});
app.delete('/api/farms/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM bdt_farms WHERE id=$1', [req.params.id]);
  res.json({ok:true});
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
app.patch('/api/machines/:id', auth, adminOnly, async (req, res) => {
  const code = normalizeCode(req.body.code);
  const description = cleanText(req.body.description, 180);
  const active = req.body.active !== false;
  if (!code || !description) return res.status(400).json({ error: 'Informe BT e descrição.' });
  try {
    const { rows } = await pool.query('UPDATE bdt_machines SET code=$1,description=$2,active=$3,updated_at=NOW() WHERE id=$4 RETURNING id,code,description,active', [code,description,active,req.params.id]);
    if (!rows[0]) return res.status(404).json({error:'BT não encontrado.'});
    res.json({machine:rows[0]});
  } catch(e) { if(e.code==='23505') return res.status(409).json({error:'Já existe um BT com esse código.'}); throw e; }
});
app.delete('/api/machines/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM bdt_machines WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
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

const recordFields = ['work_date','shift','farm','up_area','machine_code','operator_name','employee_id','hourmeter_initial','hourmeter_final','shift_start','shift_end'];
app.post('/api/records', auth, async (req, res) => {
  try {
    const b = req.body || {}; const missing = required(b, recordFields);
    if (missing.length) return res.status(400).json({ error: `Preencha os campos obrigatórios: ${missing.join(', ')}` });
    const machineCode = normalizeCode(b.machine_code);
    const mq = await pool.query(`
      WITH src AS (
        SELECT code,description,0 p FROM bdt_machines WHERE active=true
        UNION ALL SELECT machine_code,machine_description,1 p FROM bdt_records
      ) SELECT code,description FROM src
      WHERE upper(code)=upper($1) OR regexp_replace(upper(code),'[^A-Z0-9]','','g')=regexp_replace(upper($1),'[^A-Z0-9]','','g')
      ORDER BY p LIMIT 1`, [machineCode]);
    if (!mq.rows[0]) return res.status(400).json({ error: 'BT não encontrado no cadastro ou histórico.' });
    const calc = calculateRecord(b);
    const machine = mq.rows[0];
    await pool.query(`INSERT INTO bdt_machines(code,description,active) VALUES($1,$2,true) ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description,active=true,updated_at=NOW()`, [machine.code,machine.description]);
    const vals = [cleanText(b.work_date,20),cleanText(b.shift,30),cleanText(b.operation_code,30),cleanText(b.sheet_no,20),cleanText(b.sheet_total,20),cleanText(b.farm,180),cleanText(b.up_area,180),machine.code,machine.description,cleanText(b.operator_name,180),cleanText(b.employee_id,80),cleanText(b.trailer_set,180),cleanText(b.hourmeter_initial,40),cleanText(b.hourmeter_final,40),calc.hourmeter_hours,cleanText(b.shift_start,20),cleanText(b.shift_end,20),cleanText(b.hourmeter_fueling,40),cleanText(b.diesel_l,40),cleanText(b.hydraulic_oil_l,40),cleanText(b.fueling_responsible,180),JSON.stringify(calc.trips),JSON.stringify(calc.interventions),calc.total_trips,calc.shift_hours,calc.operated_hours,calc.unproductive_hours,calc.operational_stops,calc.maintenance_stops,cleanText(b.observations,5000),cleanText(b.operator_signature,180),cleanText(b.supervisor_signature,180),req.user.id];
    const { rows } = await pool.query(`INSERT INTO bdt_records(work_date,shift,operation_code,sheet_no,sheet_total,farm,up_area,machine_code,machine_description,operator_name,employee_id,trailer_set,hourmeter_initial,hourmeter_final,hourmeter_hours,shift_start,shift_end,hourmeter_fueling,diesel_l,hydraulic_oil_l,fueling_responsible,trips,interventions,total_trips,shift_hours,operated_hours,unproductive_hours,operational_stops,maintenance_stops,observations,operator_signature,supervisor_signature,created_by)
    VALUES(${vals.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id,created_at`, vals);
    res.json({ record: rows[0] });
  } catch (e) { if (e.status) return res.status(e.status).json({error:e.message}); throw e; }
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
