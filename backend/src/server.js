import 'dotenv/config';
import express from 'express';
import {pool,initDb,trimSpins,lastSpinId,uniqueId} from './db.js';
import {setupEncryption,seedAdmin,requireAuth,requireAdmin,sha,passwordHash,passwordValid,validUsername,validPassword,makeSession,encrypt,decrypt} from './security.js';
import {live,startWorkers} from './collector.js';
import {KEYS} from './strategies.js';
import {getHistory,visibleHistory,getAnalyses,updatesSince,invalidateHistory} from './history-cache.js';

if(!process.env.DATABASE_URL) throw Error('Configure DATABASE_URL');
setupEncryption();

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));

const allowed=(process.env.FRONTEND_ORIGIN||'http://localhost:5173,http://localhost:3000,https://taka-roulettes-web.netlify.app')
  .split(',').map(s=>s.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','no-referrer');
  res.set('Cache-Control','no-store');
  const origin=req.get('origin');
  if(origin&&allowed.includes(origin)){
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers','Authorization,Content-Type');
  }
  if(origin&&!allowed.includes(origin)) return res.status(403).json({error:'Origem não autorizada. Configure FRONTEND_ORIGIN.'});
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const loginAttempts=new Map();
const SUPPORTED_TABLE_RE=/(roulette|roleta)/i;
const EXCLUDED_TABLE_RE=/(crazy time|craps|dream catcher|olympus|baccarat|blackjack|poker|dragon tiger)/i;

const sanitizeTableName=name=>String(name||'').replace(/\s*[·-]\s*\d{5,}$/,'').trim();
const isSupportedTable=name=>SUPPORTED_TABLE_RE.test(String(name||'')) && !EXCLUDED_TABLE_RE.test(String(name||'')) && !/888/i.test(String(name||''));
function publicTable(row){
  return {...row,name:sanitizeTableName(row.name),displayName:sanitizeTableName(row.name)};
}
function defaultFlags(){return Object.fromEntries(KEYS.map(k=>[k,false]));}
function sanitizeFlags(flags){
  const base=defaultFlags();
  if(!flags || typeof flags!=='object' || Array.isArray(flags)) return base;
  for(const key of KEYS) if(typeof flags[key]==='boolean') base[key]=flags[key];
  return base;
}
function publicPref(p){
  return {tableId:p?.table_id||'',displayLimit:p?.display_limit||100};
}
function publicProfile(p){
  const flags=sanitizeFlags(p?.flags);
  return {
    id:String(p.id),
    label:p.label,
    sendEnabled:!!p.send_enabled,
    hasToken:!!p.bot_token_cipher,
    hasChat:!!p.chat_id_cipher,
    threadId:p.thread_id||'',
    galeLimit:p.gale_limit||'1',
    threshold:Number(p.threshold||64),
    flags,
    updatedAt:p.updated_at,
  };
}
async function getPref(userId){
  await pool.query('INSERT INTO preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
  const {rows}=await pool.query('SELECT * FROM preferences WHERE user_id=$1',[userId]);
  return rows[0];
}
async function listProfiles(userId){
  const {rows}=await pool.query('SELECT * FROM telegram_profiles WHERE user_id=$1 ORDER BY lower(label),id',[userId]);
  return rows;
}
async function ensureLegacyProfile(userId){
  const pref=await getPref(userId);
  const profiles=await listProfiles(userId);
  if(profiles.length || (!pref.bot_token_cipher && !pref.chat_id_cipher && !pref.send_enabled && !KEYS.some(k=>pref.flags?.[k]))) return;
  const label='Perfil principal';
  await pool.query(`INSERT INTO telegram_profiles(user_id,label,send_enabled,bot_token_cipher,chat_id_cipher,thread_id,gale_limit,threshold,flags,armed_after_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[
    userId,label,!!pref.send_enabled,pref.bot_token_cipher||null,pref.chat_id_cipher||null,pref.thread_id||null,pref.gale_limit||'1',pref.threshold||64,
    JSON.stringify(sanitizeFlags(pref.flags)),pref.armed_after_id||0,
  ]);
}

app.get('/api/health',asyncRoute(async(req,res)=>{
  try{
    await pool.query('SELECT 1');
    res.json({ok:true,database:'connected',collector:live});
  }catch(error){
    console.error('[health] PostgreSQL indisponível:',error.code||error.message);
    res.status(503).json({ok:false,database:'unavailable',collector:live});
  }
}));

app.post('/api/login',asyncRoute(async(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const password=String(req.body?.password||'');
  if(username.length>40||password.length>200) return res.status(400).json({error:'Credenciais inválidas'});
  const key=`${req.ip}:${username.toLowerCase()}`;
  const cur=loginAttempts.get(key)||{count:0,until:0};
  if(cur.until>Date.now()) return res.status(429).json({error:'Muitas tentativas. Aguarde 15 minutos.'});
  const {rows}=await pool.query('SELECT id,username,role,password_hash FROM users WHERE lower(username)=lower($1)',[username]);
  const ok=rows[0]&&passwordValid(password,rows[0].password_hash);
  if(!ok){
    cur.count++;
    if(cur.count>=8){cur.count=0;cur.until=Date.now()+15*60*1000;}
    loginAttempts.set(key,cur);
    return res.status(401).json({error:'Usuário ou senha inválidos'});
  }
  loginAttempts.delete(key);
  await pool.query('INSERT INTO preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[rows[0].id]);
  await ensureLegacyProfile(rows[0].id);
  const token=await makeSession(rows[0].id);
  res.json({token,user:{id:rows[0].id,username:rows[0].username,role:rows[0].role}});
}));

app.post('/api/logout',requireAuth,asyncRoute(async(req,res)=>{
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha(req.get('authorization').slice(7))]);
  res.json({ok:true});
}));

app.use('/api',requireAuth);
app.get('/api/me',(req,res)=>res.json(req.user));

app.get('/api/tables',asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT id,name,last_seen_at,gap_count::text FROM tables
    WHERE last_seen_at IS NOT NULL
    ORDER BY lower(name) LIMIT 200`);
  res.json(rows.filter(r=>isSupportedTable(r.name)).map(publicTable));
}));

app.get('/api/state',asyncRoute(async(req,res)=>{
  await ensureLegacyProfile(req.user.id);
  const pref=await getPref(req.user.id);
  const profiles=(await listProfiles(req.user.id)).map(publicProfile);
  const limit=pref.display_limit;
  const table=pref.table_id;
  let spins=[],analyses={},signals=[],outbox=[],tableInfo=null,totalStored=0,historyEpoch=null,latestSpinId='0';
  if(table){
    const {rows:t}=await pool.query('SELECT id,name,last_seen_at,gap_count::text FROM tables WHERE id=$1',[table]);
    tableInfo=t[0]?publicTable(t[0]):null;
    const history=await getHistory(table);
    analyses=getAnalyses(history);
    spins=visibleHistory(history,limit);
    totalStored=history.rows.length;
    historyEpoch=history.epoch;
    latestSpinId=history.rows.at(-1)?.id||'0';
    const {rows:s}=await pool.query(`SELECT s.id::text,s.profile_id::text AS profile_id,tp.label AS profile_label,s.strategy_key,s.target,s.kind,
      s.attempts,s.gale_limit,s.status,s.created_at,s.closed_at
      FROM signals s LEFT JOIN telegram_profiles tp ON tp.id=s.profile_id
      WHERE s.user_id=$1 AND s.table_id=$2 ORDER BY s.id DESC LIMIT 80`,[req.user.id,table]);
    signals=s;
    const {rows:o}=await pool.query(`SELECT o.id::text,o.profile_id::text AS profile_id,tp.label AS profile_label,o.strategy_key,o.status,o.body,o.created_at,o.last_error
      FROM outbox o LEFT JOIN telegram_profiles tp ON tp.id=o.profile_id
      WHERE o.user_id=$1 AND o.table_id=$2 ORDER BY o.id DESC LIMIT 50`,[req.user.id,table]);
    outbox=o;
  }
  res.json({user:req.user,preferences:publicPref(pref),profiles,table:tableInfo,collector:live,totalStored,spins,analyses,signals,outbox,historyEpoch,latestSpinId});
}));

app.get('/api/live',asyncRoute(async(req,res)=>{
  const tableId=String(req.query.tableId||'');
  if(!tableId||tableId.length>80) return res.status(400).json({error:'Mesa inválida'});
  const lim=Number(req.query.limit);
  if(!Number.isInteger(lim)||lim<1||lim>2000) return res.status(400).json({error:'Limite entre 1 e 2.000'});
  const history=await getHistory(tableId);
  const delta=updatesSince(history,req.query.afterId,req.query.epoch,lim);
  res.json({...delta,epoch:history.epoch,totalStored:history.rows.length,
    analyses:(delta.replace||delta.spins.length)?getAnalyses(history):undefined,
    latest:history.rows.at(-1)?.id||'0',collector:live});
}));

app.patch('/api/preferences',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id);
  const next={table_id:pref.table_id,display_limit:pref.display_limit};
  if(req.body?.tableId!==undefined){
    const tableId=String(req.body.tableId||'').trim();
    if(tableId){
      const check=await pool.query('SELECT id,name FROM tables WHERE id=$1',[tableId]);
      if(!check.rowCount || !isSupportedTable(check.rows[0].name)) return res.status(400).json({error:'Mesa não encontrada na coleta'});
      next.table_id=tableId;
    }else next.table_id=null;
  }
  if(req.body?.displayLimit!==undefined){
    const n=Number(req.body.displayLimit);
    if(!Number.isInteger(n)||n<1||n>2000) return res.status(400).json({error:'Quantidade entre 1 e 2.000'});
    next.display_limit=n;
  }
  const changedTable=next.table_id!==pref.table_id;
  await pool.query('UPDATE preferences SET table_id=$2,display_limit=$3,updated_at=now() WHERE user_id=$1',[req.user.id,next.table_id,next.display_limit]);
  if(changedTable){
    await pool.query("UPDATE outbox SET status='cancelled' WHERE user_id=$1 AND status='queued'",[req.user.id]);
    await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE user_id=$1 AND status='open'",[req.user.id]);
    const profiles=await listProfiles(req.user.id);
    const arm=await lastSpinId(next.table_id||'');
    if(profiles.length){
      await pool.query('UPDATE telegram_profiles SET armed_after_id=$2,updated_at=now() WHERE user_id=$1',[req.user.id,arm]);
    }
  }
  res.json({preferences:publicPref(await getPref(req.user.id))});
}));

function validateProfileBody(prefTableId,body,current=null){
  const label=String(body.label??current?.label??'').trim();
  if(label.length<2||label.length>50) return {error:'Informe um nome de perfil entre 2 e 50 caracteres'};
  const enabled=body.sendEnabled===undefined?!!current?.send_enabled:body.sendEnabled;
  if(typeof enabled!=='boolean') return {error:'Status do perfil inválido'};
  const gale=body.galeLimit===undefined?(current?.gale_limit||'1'):String(body.galeLimit).trim();
  if(!/^\d+$/.test(gale)) return {error:'Gales: informe um inteiro igual ou maior que zero'};
  const threshold=body.threshold===undefined?Number(current?.threshold||64):Number(body.threshold);
  if(!Number.isInteger(threshold)||threshold<0||threshold>100) return {error:'Percentual entre 0 e 100'};
  const token=body.botToken===undefined?'':String(body.botToken).trim();
  const chat=body.chatId===undefined?'':String(body.chatId).trim();
  const thread=body.threadId===undefined?(current?.thread_id||''):String(body.threadId).trim();
  const flags=sanitizeFlags(body.flags===undefined?current?.flags:body.flags);
  if(token&&!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) return {error:'Formato do token inválido'};
  if(chat&&!/^-?\d{1,22}$/.test(chat)&&!/^@[A-Za-z0-9_]{5,32}$/.test(chat)) return {error:'Chat ID inválido'};
  if(thread&&!/^\d{1,15}$/.test(thread)) return {error:'ID do tópico inválido'};
  const encryptedToken=token?encrypt(token):current?.bot_token_cipher||null;
  const encryptedChat=chat?encrypt(chat):current?.chat_id_cipher||null;
  if(enabled&&(!prefTableId||!encryptedToken||!encryptedChat||!KEYS.some(k=>flags[k]))) return {error:'Selecione uma mesa, marque ao menos uma estratégia e configure token + chat ID antes de ativar o envio'};
  const changed = !current || enabled!==!!current.send_enabled || token || chat || thread!==(current?.thread_id||'') || gale!==(current?.gale_limit||'1') || threshold!==Number(current?.threshold||64) || label!==current?.label || KEYS.some(k=>!!flags[k]!==!!current?.flags?.[k]);
  return {label,enabled,gale,threshold,thread,flags,encryptedToken,encryptedChat,changed};
}
async function armProfile(userId,profileId,tableId){
  const arm=await lastSpinId(tableId||'');
  await pool.query('UPDATE telegram_profiles SET armed_after_id=$3,updated_at=now() WHERE user_id=$1 AND id=$2',[userId,profileId,arm]);
}

app.post('/api/telegram/profiles',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id);
  const check=validateProfileBody(pref.table_id,req.body||{},null);
  if(check.error) return res.status(400).json({error:check.error});
  try{
    const {rows}=await pool.query(`INSERT INTO telegram_profiles(user_id,label,send_enabled,bot_token_cipher,chat_id_cipher,thread_id,gale_limit,threshold,flags,armed_after_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[
      req.user.id,check.label,check.enabled,check.encryptedToken,check.encryptedChat,check.thread||null,check.gale,check.threshold,JSON.stringify(check.flags),await lastSpinId(pref.table_id||''),
    ]);
    await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'telegram.profile.create',JSON.stringify({id:rows[0].id,label:rows[0].label})]);
    res.status(201).json({profile:publicProfile(rows[0]),profiles:(await listProfiles(req.user.id)).map(publicProfile),message:check.enabled?'Perfil armado para novos giros':'Perfil salvo'});
  }catch(e){ if(e.code==='23505') return res.status(409).json({error:'Já existe um perfil com esse nome'}); throw e; }
}));

app.patch('/api/telegram/profiles/:id',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id);
  const {rows}=await pool.query('SELECT * FROM telegram_profiles WHERE user_id=$1 AND id=$2',[req.user.id,req.params.id]);
  const current=rows[0];
  if(!current) return res.sendStatus(404);
  const check=validateProfileBody(pref.table_id,req.body||{},current);
  if(check.error) return res.status(400).json({error:check.error});
  await pool.query(`UPDATE telegram_profiles SET label=$3,send_enabled=$4,bot_token_cipher=$5,chat_id_cipher=$6,thread_id=$7,
    gale_limit=$8,threshold=$9,flags=$10,updated_at=now() WHERE user_id=$1 AND id=$2`,[
    req.user.id,req.params.id,check.label,check.enabled,check.encryptedToken,check.encryptedChat,check.thread||null,
    check.gale,check.threshold,JSON.stringify(check.flags),
  ]);
  if(check.changed){
    await armProfile(req.user.id,req.params.id,pref.table_id||'');
    await pool.query("UPDATE outbox SET status='cancelled' WHERE user_id=$1 AND profile_id=$2 AND status='queued'",[req.user.id,req.params.id]);
    await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE user_id=$1 AND profile_id=$2 AND status='open'",[req.user.id,req.params.id]);
  }
  const profile=(await pool.query('SELECT * FROM telegram_profiles WHERE user_id=$1 AND id=$2',[req.user.id,req.params.id])).rows[0];
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'telegram.profile.edit',JSON.stringify({id:req.params.id,label:check.label})]);
  res.json({profile:publicProfile(profile),profiles:(await listProfiles(req.user.id)).map(publicProfile),message:check.enabled?'Perfil armado somente para giros futuros':'Perfil salvo'});
}));

app.delete('/api/telegram/profiles/:id',asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('DELETE FROM telegram_profiles WHERE user_id=$1 AND id=$2 RETURNING id,label',[req.user.id,req.params.id]);
  if(!rows.length) return res.sendStatus(404);
  await pool.query('UPDATE outbox SET status=\'cancelled\' WHERE user_id=$1 AND profile_id=$2 AND status IN (\'queued\',\'processing\')',[req.user.id,req.params.id]);
  await pool.query('UPDATE signals SET status=\'cancelled\',closed_at=now() WHERE user_id=$1 AND profile_id=$2 AND status=\'open\'',[req.user.id,req.params.id]);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'telegram.profile.delete',JSON.stringify(rows[0])]);
  res.json({ok:true,profiles:(await listProfiles(req.user.id)).map(publicProfile)});
}));

app.post('/api/telegram/verify',asyncRoute(async(req,res)=>{
  const token=String(req.body?.botToken||'').trim();
  const chat=String(req.body?.chatId||'').trim();
  if(!token||!chat) return res.status(400).json({error:'Preencha token e chat ID'});
  if(!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(400).json({error:'Formato do token inválido'});
  const request=async(method,args={})=>{
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
    const j=await r.json();
    if(!j.ok) throw Error(`${method}: ${String(j.description).slice(0,120)}`);
    return j.result;
  };
  try{
    const bot=await request('getMe');
    const room=await request('getChat',{chat_id:chat});
    return res.json({ok:true,bot:bot.username,chat:room.title||room.username||String(room.id),message:'Bot e sala encontrados. Isso não garante autorização para enviar mensagens.'});
  }catch(e){
    return res.status(400).json({error:`Telegram: ${e.message}`});
  }
}));

app.get('/api/admin/users',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT id,username,role,created_at FROM users ORDER BY created_at');
  res.json(rows);
}));
app.post('/api/admin/users',requireAdmin,asyncRoute(async(req,res)=>{
  const {username,password,role='user'}=req.body||{};
  if(!validUsername(username)||!validPassword(password)||!['user','admin'].includes(role)) return res.status(400).json({error:'Usuário (3–40), senha (12+ caracteres) ou perfil inválido'});
  const id=uniqueId();
  try{
    await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,passwordHash(password),role]);
    await pool.query('INSERT INTO preferences(user_id) VALUES($1)',[id]);
    await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.create',JSON.stringify({id,username,role})]);
    res.status(201).json({id,username,role});
  }catch(e){ if(e.code==='23505') return res.status(409).json({error:'Usuário já existe'}); throw e; }
}));
app.patch('/api/admin/users/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const id=req.params.id,{username,password,role}=req.body||{};
  const {rows}=await pool.query('SELECT id,username,role FROM users WHERE id=$1',[id]);
  if(!rows.length) return res.sendStatus(404);
  if(username!==undefined&&!validUsername(username)) return res.status(400).json({error:'Nome de usuário inválido'});
  if(password!==undefined&&!validPassword(password)) return res.status(400).json({error:'Senha deve ter de 12 a 200 caracteres'});
  if(role!==undefined&&!['user','admin'].includes(role)) return res.status(400).json({error:'Perfil inválido'});
  if(id===req.user.id&&role==='user') return res.status(400).json({error:'Não é possível remover seu próprio acesso administrativo'});
  try{
    await pool.query('UPDATE users SET username=COALESCE($2,username),password_hash=COALESCE($3,password_hash),role=COALESCE($4,role) WHERE id=$1',
      [id,username??null,password?passwordHash(password):null,role??null]);
    if(password||role) await pool.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.edit',JSON.stringify({id,username,role,passwordChanged:!!password})]);
    res.json({ok:true});
  }catch(e){ if(e.code==='23505') return res.status(409).json({error:'Usuário já existe'}); throw e; }
}));
app.delete('/api/admin/users/:id',requireAdmin,asyncRoute(async(req,res)=>{
  if(req.params.id===req.user.id) return res.status(400).json({error:'Você não pode excluir sua própria conta'});
  const {rowCount}=await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  if(!rowCount) return res.sendStatus(404);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.delete',JSON.stringify({id:req.params.id})]);
  res.json({ok:true});
}));
app.post('/api/admin/spins',requireAdmin,asyncRoute(async(req,res)=>{
  const {tableId,number}=req.body||{};
  if(!Number.isInteger(number)||number<0||number>36) return res.status(400).json({error:'Número deve estar entre 0 e 36'});
  const exists=await pool.query('SELECT 1 FROM tables WHERE id=$1',[tableId]);
  if(!exists.rowCount) return res.sendStatus(404);
  const client=await pool.connect();
  let rows;
  try{
    await client.query('BEGIN');
    ({rows}=await client.query("INSERT INTO spins(table_id,number,source) VALUES($1,$2,'manual') RETURNING id::text,number",[tableId,number]));
    await trimSpins(tableId,client);
    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
  invalidateHistory(tableId);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.create',JSON.stringify({...rows[0],tableId})]);
  res.status(201).json(rows[0]);
}));
app.patch('/api/admin/spins/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {number}=req.body||{};
  if(!Number.isInteger(number)||number<0||number>36) return res.status(400).json({error:'Número inválido'});
  const {rows}=await pool.query("UPDATE spins SET number=$2,source='manual-corrected' WHERE id=$1 RETURNING id::text,table_id,number",[req.params.id,number]);
  if(!rows.length) return res.sendStatus(404);
  invalidateHistory(rows[0].table_id);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.edit',JSON.stringify(rows[0])]);
  res.json(rows[0]);
}));
app.delete('/api/admin/spins/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('DELETE FROM spins WHERE id=$1 RETURNING id::text,table_id,number',[req.params.id]);
  if(!rows.length) return res.sendStatus(404);
  invalidateHistory(rows[0].table_id);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.delete',JSON.stringify(rows[0])]);
  res.json({ok:true});
}));
app.get('/api/admin/audit',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT id::text,action,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 100');
  res.json(rows);
}));

app.use((err,req,res,next)=>{
  console.error('[api]',err?.code||err?.message);
  if(!res.headersSent) res.status(500).json({error:'Erro interno. Consulte os logs do servidor.'});
});

const port=Number(process.env.PORT)||3000;
try{
  await initDb();
  await seedAdmin();
}catch(error){
  console.error('[inicializacao] Verifique o esquema PostgreSQL e as variáveis obrigatórias:', error.code||error.message);
  process.exitCode=1;
  await pool.end();
  throw error;
}
app.listen(port,()=>{console.log(`Servidor pronto na porta ${port}`);startWorkers();});
