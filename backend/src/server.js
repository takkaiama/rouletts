import 'dotenv/config';
import express from 'express';
import {pool,initDb,trimSpins,lastSpinId,uniqueId} from './db.js';
import {setupEncryption,seedAdmin,requireAuth,requireAdmin,sha,passwordHash,passwordValid,validUsername,validPassword,makeSession,encrypt,decrypt} from './security.js';
import {live,startWorkers} from './collector.js';
import {KEYS} from './strategies.js';
import {getHistory,visibleHistory,getAnalyses,updatesSince,invalidateHistory} from './history-cache.js';
if(!process.env.DATABASE_URL)throw Error('Configure DATABASE_URL');
setupEncryption();
const app=express();app.disable('x-powered-by');
app.use(express.json({limit:'16kb'}));
const allowed=(process.env.FRONTEND_ORIGIN||'http://localhost:5173,http://localhost:3000').split(',').map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');
  res.set('Cache-Control','no-store');
  const origin=req.get('origin');
  if(origin&&allowed.includes(origin)){
    res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');
    res.set('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers','Authorization,Content-Type');
  }
  if(origin&&!allowed.includes(origin))return res.status(403).json({error:'Origem não autorizada. Configure FRONTEND_ORIGIN.'});
  if(req.method==='OPTIONS')return res.sendStatus(204);
  next();
});
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const loginAttempts=new Map();
app.get('/api/health',asyncRoute(async(req,res)=>{
  try {
    await pool.query('SELECT 1');
    res.json({ok:true,database:'connected',collector:live});
  } catch(error){
    console.error('[health] PostgreSQL indisponível:',error.code||error.message);
    res.status(503).json({ok:false,database:'unavailable',collector:live});
  }
}));
app.post('/api/login',asyncRoute(async(req,res)=>{
  const username=String(req.body?.username||'').trim(),password=String(req.body?.password||'');
  if(username.length>40||password.length>200)return res.status(400).json({error:'Credenciais inválidas'});
  const key=`${req.ip}:${username.toLowerCase()}`;
  const cur=loginAttempts.get(key)||{count:0,until:0};
  if(cur.until>Date.now())return res.status(429).json({error:'Muitas tentativas. Aguarde 15 minutos.'});
  const {rows}=await pool.query('SELECT id,username,role,password_hash FROM users WHERE lower(username)=lower($1)',[username]);
  const ok=rows[0]&&passwordValid(password,rows[0].password_hash);
  if(!ok){cur.count++;if(cur.count>=8){cur.count=0;cur.until=Date.now()+15*60*1000;}loginAttempts.set(key,cur);return res.status(401).json({error:'Usuário ou senha inválidos'});}
  loginAttempts.delete(key);
  const token=await makeSession(rows[0].id);
  await pool.query('INSERT INTO preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[rows[0].id]);
  res.json({token,user:{id:rows[0].id,username:rows[0].username,role:rows[0].role}});
}));
app.post('/api/logout',requireAuth,asyncRoute(async(req,res)=>{
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha(req.get('authorization').slice(7))]);res.json({ok:true});
}));
app.use('/api',requireAuth);
app.get('/api/me',(req,res)=>res.json(req.user));
app.get('/api/tables',asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT id,name,last_seen_at,gap_count::text FROM tables ORDER BY name LIMIT 100');res.json(rows);
}));
function publicPref(p){return {tableId:p.table_id,displayLimit:p.display_limit,sendEnabled:p.send_enabled,
  hasToken:!!p.bot_token_cipher,hasChat:!!p.chat_id_cipher,threadId:p.thread_id||'',galeLimit:p.gale_limit,
  threshold:p.threshold,flags:p.flags||{},armedAfter:p.armed_after_id?.toString()||'0'};}
async function getPref(userId){
  await pool.query('INSERT INTO preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
  const {rows}=await pool.query('SELECT * FROM preferences WHERE user_id=$1',[userId]);return rows[0];
}
app.get('/api/state',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id);
  const limit=pref.display_limit,table=pref.table_id;
  let spins=[],analyses={},signals=[],outbox=[],tableInfo=null,totalStored=0;
  if(table){
    const {rows:t}=await pool.query('SELECT id,name,last_seen_at,gap_count::text FROM tables WHERE id=$1',[table]);tableInfo=t[0]||null;
    const history=await getHistory(table);
    analyses=getAnalyses(history);spins=visibleHistory(history,limit);totalStored=history.rows.length;
    const {rows:s}=await pool.query('SELECT id::text,strategy_key,target,kind,attempts,gale_limit,status,created_at,closed_at FROM signals WHERE user_id=$1 AND table_id=$2 ORDER BY id DESC LIMIT 60',[req.user.id,table]);signals=s;
    const {rows:o}=await pool.query('SELECT id::text,strategy_key,status,body,created_at,last_error FROM outbox WHERE user_id=$1 AND table_id=$2 ORDER BY id DESC LIMIT 35',[req.user.id,table]);outbox=o;
  }
  res.json({user:req.user,preferences:publicPref(pref),table:tableInfo,collector:live,totalStored,spins,analyses,signals,outbox,historyEpoch:table?(await getHistory(table)).epoch:null,latestSpinId:table?(await getHistory(table)).rows.at(-1)?.id||'0':'0'});
}));
// Poll leve: somente alterações da grade são transferidas; nenhum SELECT dos 2000 giros.
app.get('/api/live',asyncRoute(async(req,res)=>{
  const tableId=String(req.query.tableId||'');
  if(!tableId||tableId.length>80)return res.status(400).json({error:'Mesa inválida'});
  const lim=Number(req.query.limit);
  if(!Number.isInteger(lim)||lim<1||lim>2000)return res.status(400).json({error:'Limite entre 1 e 2.000'});
  const history=await getHistory(tableId);
  const delta=updatesSince(history,req.query.afterId,req.query.epoch,lim);
  res.json({...delta,epoch:history.epoch,totalStored:history.rows.length,
    analyses:(delta.replace||delta.spins.length)?getAnalyses(history):undefined,collector:live});
}));
app.patch('/api/preferences',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id),body=req.body||{};
  const count=body.displayLimit===undefined?pref.display_limit:Number(body.displayLimit);
  if(!Number.isInteger(count)||count<1||count>2000)return res.status(400).json({error:'Escolha entre 1 e 2.000 resultados'});
  const tableId=body.tableId===undefined?pref.table_id:String(body.tableId||'');
  if(tableId){const check=await pool.query('SELECT 1 FROM tables WHERE id=$1',[tableId]);if(!check.rowCount)return res.status(400).json({error:'Mesa não encontrada na coleta'});}
  const changed=tableId!==pref.table_id;
  const arm=changed?await lastSpinId(tableId||''):pref.armed_after_id;
  await pool.query(`UPDATE preferences SET table_id=$2,display_limit=$3,armed_after_id=$4,
    send_enabled=CASE WHEN $5::boolean THEN false ELSE send_enabled END,updated_at=now() WHERE user_id=$1`,
    [req.user.id,tableId||null,count,arm,changed]);
  if(changed){
    await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE user_id=$1 AND status='open'",[req.user.id]);
    await pool.query("UPDATE outbox SET status='cancelled' WHERE user_id=$1 AND status='queued'",[req.user.id]);
  }
  res.json({preferences:publicPref(await getPref(req.user.id))});
}));
app.patch('/api/telegram',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id),body=req.body||{};
  const flags=body.flags===undefined?pref.flags:body.flags;
  if(!flags||typeof flags!=='object'||Array.isArray(flags)||Object.keys(flags).some(k=>!KEYS.includes(k)||typeof flags[k]!=='boolean'))
    return res.status(400).json({error:'Seleção de estratégias inválida'});
  const enabled=body.sendEnabled===undefined?pref.send_enabled:body.sendEnabled;
  if(typeof enabled!=='boolean')return res.status(400).json({error:'Flag de envio inválida'});
  const gale=body.galeLimit===undefined?pref.gale_limit:String(body.galeLimit);
  if(!/^\d+$/.test(gale))return res.status(400).json({error:'Gales: informe um inteiro igual ou maior que zero'});
  const threshold=body.threshold===undefined?pref.threshold:Number(body.threshold);
  if(!Number.isInteger(threshold)||threshold<0||threshold>100)return res.status(400).json({error:'Percentual entre 0 e 100'});
  const token=body.botToken===undefined?'':String(body.botToken).trim();
  const chat=body.chatId===undefined?'':String(body.chatId).trim();
  const thread=body.threadId===undefined?pref.thread_id:String(body.threadId).trim();
  if(token&&!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token))return res.status(400).json({error:'Formato do token inválido'});
  if(chat&&!/^-?\d{1,22}$/.test(chat)&&!/^@[A-Za-z0-9_]{5,32}$/.test(chat))return res.status(400).json({error:'Chat ID inválido'});
  if(thread&&!/^\d{1,15}$/.test(thread))return res.status(400).json({error:'ID do tópico inválido'});
  const encryptedToken=token?encrypt(token):pref.bot_token_cipher;
  const encryptedChat=chat?encrypt(chat):pref.chat_id_cipher;
  if(enabled&&(!encryptedToken||!encryptedChat||!pref.table_id||!KEYS.some(k=>flags[k])))
    return res.status(400).json({error:'Selecione uma mesa e estratégia e configure o token e o chat ID antes de ativar o envio'});
  const changed=enabled!==pref.send_enabled||token||chat||thread!==pref.thread_id||gale!==pref.gale_limit||threshold!==pref.threshold||KEYS.some(k=>!!flags[k]!==!!pref.flags?.[k]);
  const arm=changed?await lastSpinId(pref.table_id||''):pref.armed_after_id;
  await pool.query(`UPDATE preferences SET send_enabled=$2,flags=$3,bot_token_cipher=$4,chat_id_cipher=$5,thread_id=$6,
    gale_limit=$7,threshold=$8,armed_after_id=$9,updated_at=now() WHERE user_id=$1`,
    [req.user.id,enabled,JSON.stringify(flags),encryptedToken,encryptedChat,thread||null,gale,threshold,arm]);
  if(changed){
    await pool.query("UPDATE outbox SET status='cancelled' WHERE user_id=$1 AND status='queued'",[req.user.id]);
    // Configuração nova nunca herda sinais da configuração anterior.
    await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE user_id=$1 AND status='open'",[req.user.id]);
  }
  res.json({preferences:publicPref(await getPref(req.user.id)),message:enabled?'Envio armado somente para novos giros':'Envio interrompido'});
}));
app.post('/api/telegram/verify',asyncRoute(async(req,res)=>{
  const pref=await getPref(req.user.id);
  const token=String(req.body?.botToken||'').trim()||(pref.bot_token_cipher?decrypt(pref.bot_token_cipher):'');
  const chat=String(req.body?.chatId||'').trim()||(pref.chat_id_cipher?decrypt(pref.chat_id_cipher):'');
  if(!token||!chat)return res.status(400).json({error:'Preencha token e chat ID'});
  if(!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token))return res.status(400).json({error:'Formato do token inválido'});
  const request=async(method,args={})=>{
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
    const j=await r.json();if(!j.ok)throw Error(`${method}: ${String(j.description).slice(0,120)}`);return j.result;
  };
  try{
    const bot=await request('getMe'),room=await request('getChat',{chat_id:chat});
    return res.json({ok:true,bot:bot.username,chat:room.title||room.username||String(room.id),message:'Bot e sala encontrados. Isso não garante autorização para enviar mensagens.'});
  }catch(e){return res.status(400).json({error:`Telegram: ${e.message}`});}
}));
app.get('/api/admin/users',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT id,username,role,created_at FROM users ORDER BY created_at');res.json(rows);
}));
app.post('/api/admin/users',requireAdmin,asyncRoute(async(req,res)=>{
  const {username,password,role='user'}=req.body||{};
  if(!validUsername(username)||!validPassword(password)||!['user','admin'].includes(role))return res.status(400).json({error:'Usuário (3–40), senha (12+ caracteres) ou perfil inválido'});
  const id=uniqueId();
  try{
    await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,passwordHash(password),role]);
    await pool.query('INSERT INTO preferences(user_id) VALUES($1)',[id]);
    await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.create',JSON.stringify({id,username,role})]);
    res.status(201).json({id,username,role});
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'Usuário já existe'});throw e;}
}));
app.patch('/api/admin/users/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const id=req.params.id,{username,password,role}=req.body||{};
  const {rows}=await pool.query('SELECT id,username,role FROM users WHERE id=$1',[id]);
  if(!rows.length)return res.sendStatus(404);
  if(username!==undefined&&!validUsername(username))return res.status(400).json({error:'Nome de usuário inválido'});
  if(password!==undefined&&!validPassword(password))return res.status(400).json({error:'Senha deve ter de 12 a 200 caracteres'});
  if(role!==undefined&&!['user','admin'].includes(role))return res.status(400).json({error:'Perfil inválido'});
  if(id===req.user.id&&role==='user')return res.status(400).json({error:'Não é possível remover seu próprio acesso administrativo'});
  try{
    await pool.query('UPDATE users SET username=COALESCE($2,username),password_hash=COALESCE($3,password_hash),role=COALESCE($4,role) WHERE id=$1',
      [id,username??null,password?passwordHash(password):null,role??null]);
    if(password||role)await pool.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.edit',JSON.stringify({id,username,role,passwordChanged:!!password})]);
    res.json({ok:true});
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'Usuário já existe'});throw e;}
}));
app.delete('/api/admin/users/:id',requireAdmin,asyncRoute(async(req,res)=>{
  if(req.params.id===req.user.id)return res.status(400).json({error:'Você não pode excluir sua própria conta'});
  const {rowCount}=await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  if(!rowCount)return res.sendStatus(404);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'user.delete',JSON.stringify({id:req.params.id})]);res.json({ok:true});
}));
app.post('/api/admin/spins',requireAdmin,asyncRoute(async(req,res)=>{
  const {tableId,number}=req.body||{};
  if(!Number.isInteger(number)||number<0||number>36)return res.status(400).json({error:'Número deve estar entre 0 e 36'});
  const exists=await pool.query('SELECT 1 FROM tables WHERE id=$1',[tableId]);if(!exists.rowCount)return res.sendStatus(404);
  const client=await pool.connect();
  let rows;
  try {
    await client.query('BEGIN');
    ({rows}=await client.query("INSERT INTO spins(table_id,number,source) VALUES($1,$2,'manual') RETURNING id::text,number",[tableId,number]));
    await trimSpins(tableId,client);
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { client.release(); }
  invalidateHistory(tableId);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.create',JSON.stringify({...rows[0],tableId})]);res.status(201).json(rows[0]);
}));
app.patch('/api/admin/spins/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {number}=req.body||{};
  if(!Number.isInteger(number)||number<0||number>36)return res.status(400).json({error:'Número inválido'});
  const {rows}=await pool.query('UPDATE spins SET number=$2,source=\'manual-corrected\' WHERE id=$1 RETURNING id::text,table_id,number',[req.params.id,number]);
  if(!rows.length)return res.sendStatus(404);
  invalidateHistory(rows[0].table_id);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.edit',JSON.stringify(rows[0])]);res.json(rows[0]);
}));
app.delete('/api/admin/spins/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('DELETE FROM spins WHERE id=$1 RETURNING id::text,table_id,number',[req.params.id]);
  if(!rows.length)return res.sendStatus(404);
  invalidateHistory(rows[0].table_id);
  await pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES($1,$2,$3)',[req.user.id,'spin.delete',JSON.stringify(rows[0])]);res.json({ok:true});
}));
app.get('/api/admin/audit',requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT id::text,action,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 100');res.json(rows);
}));
app.use((err,req,res,next)=>{
  console.error('[api]',err?.code||err?.message);
  if(!res.headersSent)res.status(500).json({error:'Erro interno. Consulte os logs do servidor.'});
});
const port=Number(process.env.PORT)||3000;
try {
  await initDb();
  await seedAdmin();
} catch (error) {
  console.error('[inicializacao] Verifique o esquema PostgreSQL e as variáveis obrigatórias:', error.code||error.message);
  process.exitCode=1;
  await pool.end();
  throw error;
}
app.listen(port,()=>{console.log(`Servidor pronto na porta ${port}`);startWorkers();});
