import {pool} from './db.js';
import {getHistory,applySpin,getAnalyses,recentHistory,HISTORY_LIMIT} from './history-cache.js';
import {color,column,KEYS,inferNewNumbers,matches,TITLES} from './strategies.js';
import {decrypt} from './security.js';
export const live={online:false,lastPoll:null,error:null,received:0};
const API='https://cgp.safe-iplay.com/cgpapi/liveFeed/GetLiveTables';
const postData=new URLSearchParams({regulationID:'4',lang:'por',clientRequestId:'init',
 clientProperties:JSON.stringify({brandName:'888Casino',language:'por'}),
 CGP_DomainOrigin:'https://br.888casino.com',CGP_Skin:'888casino',CGP_SkinOverride:'com'});
const names={'2010097':'VIP Roulette','2010017':'Auto-Roulette','2010016':'Immersive Roulette','2010165':'Roulette','2010098':'Auto-Roulette VIP','2010012':'American Roulette','2010565':'Gold Vault Roulette','2010096':'Speed Auto Roulette','2010033':'Lightning Roulette','2010440':'XXXtreme Lightning Roulette','2380064':'Roleta Azure','2380038':'Roulette Macao','2380148':'PowerUp Roulette','2380390':'Immersive Roulette Deluxe'};
function tableName(id,obj){for(const key of ['TableName','tableName','GameName','gameName','Name','name']) if(typeof obj[key]==='string'&&obj[key].trim())return obj[key].trim().slice(0,100);return names[id]||`Roleta ${id}`;}
function snapshot(obj){
  const a=obj?.RouletteLast5Numbers;
  if(!Array.isArray(a)||!a.length) return null;
  const list=a.slice(0,5).map(x=>Number(x));
  return list.every(n=>Number.isInteger(n)&&n>=0&&n<=36)?list:null;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const symbol={V:'🔴',P:'⚫',B:'🟢',0:'🟢',1:'1️⃣',2:'2️⃣',3:'3️⃣'};
let nextOutboxCheckAt=0;
function targetText(key,target){return key.startsWith('col')?`Coluna ${target} ${symbol[target]}`:target==='B'?'Zero 🟢':`${symbol[target]} + proteção no zero 🟢`;}
async function enqueue(userId,tableId,key,spinId,signalId,body,unique){
  await pool.query('INSERT INTO outbox(user_id,table_id,strategy_key,spin_id,signal_id,body,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING',
    [userId,tableId,key,spinId,signalId,body,unique]);
  nextOutboxCheckAt=0;
}
async function processSpin(tableId,num,source='api'){
  // Uma leitura de 2.000 registros na primeira utilização; demais giros usam o cache.
  const history=await getHistory(tableId);
  const oldest=history.rows.length>=HISTORY_LIMIT?history.rows[0]:null;
  // Inserção e remoção do giro antigo na MESMA transação: nunca deixa 2.001 no banco.
  const client=await pool.connect();let spin;
  try{
    await client.query('BEGIN');
    const result=await client.query('INSERT INTO spins(table_id,number,source) VALUES($1,$2,$3) RETURNING id::text,number,source,created_at',[tableId,num,source]);
    spin=result.rows[0];
    if(oldest)await client.query('DELETE FROM spins WHERE table_id=$1 AND id=$2',[tableId,oldest.id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;
  }finally{client.release();}
  applySpin(history,spin);
  const {rows:people}=await pool.query('SELECT * FROM preferences WHERE table_id=$1 AND send_enabled=true',[tableId]);
  // Result validation is processed BEFORE new predictions, so SG/G1 never consumes its own setup spin.
  for(const pref of people){
    const flags=pref.flags||{};
    const {rows:open}=await pool.query("SELECT * FROM signals WHERE user_id=$1 AND table_id=$2 AND status='open' ORDER BY id",[pref.user_id,tableId]);
    for(const sig of open){
      if(BigInt(spin.id)<=BigInt(sig.start_spin_id)||BigInt(spin.id)<=BigInt(sig.last_processed_id))continue;
      if(!flags[sig.strategy_key]||!pref.bot_token_cipher||!pref.chat_id_cipher){
        await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE id=$1",[sig.id]);continue;
      }
      const attempt=BigInt(sig.attempts);
      const didMatch=matches(num,sig.kind,sig.target);
      if(didMatch){
        const label=attempt===0n?'SG':`G${attempt}`;
        const zero=(sig.kind==='cor'&&color(num)==='B'&&sig.target!=='B');
        const body=`✅ GREEN ${label}${zero?' (ZERO)':''} | ${TITLES[sig.strategy_key]}\n🎯 Alvo: ${targetText(sig.strategy_key,sig.target)}\n🎲 Resultado: ${num}\n🕒 ${new Date(spin.created_at).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})}`;
        await pool.query("UPDATE signals SET status='green',attempts=$2,last_processed_id=$3,closed_at=now() WHERE id=$1",[sig.id,attempt.toString(),spin.id]);
        await enqueue(pref.user_id,tableId,sig.strategy_key,spin.id,sig.id,body,`result:${sig.id}:${spin.id}`);
      } else if(attempt>=BigInt(sig.gale_limit)){
        await pool.query("UPDATE signals SET status='red',last_processed_id=$2,closed_at=now() WHERE id=$1",[sig.id,spin.id]);
        await enqueue(pref.user_id,tableId,sig.strategy_key,spin.id,sig.id,
          `❌ RED | ${TITLES[sig.strategy_key]}\n🎯 Alvo: ${targetText(sig.strategy_key,sig.target)}\n🎲 Resultado: ${num}\nLimite: G${sig.gale_limit}`,
          `result:${sig.id}:${spin.id}`);
      }else{
        const next=attempt+1n;
        await pool.query('UPDATE signals SET attempts=$2,last_processed_id=$3 WHERE id=$1',[sig.id,next.toString(),spin.id]);
        await enqueue(pref.user_id,tableId,sig.strategy_key,spin.id,sig.id,
          `⚠️ GALE ${next} | ${TITLES[sig.strategy_key]}\n🎯 Manter: ${targetText(sig.strategy_key,sig.target)}\n🎲 Último: ${num}`,
          `gale:${sig.id}:${spin.id}`);
      }
    }
  }
  const analyses=getAnalyses(history);
  for(const pref of people){
    if(!pref.bot_token_cipher||!pref.chat_id_cipher||BigInt(spin.id)<=BigInt(pref.armed_after_id))continue;
    for(const key of KEYS){
      if(pref.flags?.[key]!==true)continue;
      const a=analyses[key];
      if(!a?.occurrences||a.target===null||a.percentage<pref.threshold)continue;
      const exists=await pool.query("SELECT 1 FROM signals WHERE user_id=$1 AND table_id=$2 AND strategy_key=$3 AND status='open'",[pref.user_id,tableId,key]);
      if(exists.rowCount)continue;
      const kind=key.startsWith('col')?'col':'cor';
      const {rows:signals}=await pool.query(`INSERT INTO signals(user_id,table_id,strategy_key,target,kind,start_spin_id,last_processed_id,gale_limit)
       VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
       [pref.user_id,tableId,key,String(a.target),kind,spin.id,pref.gale_limit]);
      if(!signals.length)continue;
      await enqueue(pref.user_id,tableId,key,spin.id,signals[0].id,
        `🎯 SINAL | ${a.title}\nApós resultado: ${num}\nEntrada: ${targetText(key,a.target)}\nAmostra: ${a.occurrences} ocorrência(s), ${a.percentage}% na amostra recente\nAté G${pref.gale_limit}\nAguardar o PRÓXIMO giro.`,
        `signal:${signals[0].id}`);
    }
  }
  live.received++;
}
// Consulta à origem é compartilhada: nunca uma coleta por usuário ou aba.
let busy=false;
const snapshots=new Map();
let snapshotsReady=false;
let watchIds=new Set();
let watchRefreshAt=0;
async function initSnapshots(){
  if(snapshotsReady)return;
  const {rows}=await pool.query('SELECT id,name,last_snapshot FROM tables');
  for(const row of rows)snapshots.set(row.id,{name:row.name,previous:row.last_snapshot});
  snapshotsReady=true;
}
async function watchedTables(){
  if(Date.now()<watchRefreshAt)return watchIds;
  const {rows}=await pool.query('SELECT DISTINCT table_id FROM preferences WHERE table_id IS NOT NULL');
  watchIds=new Set(rows.map(x=>x.table_id));
  watchRefreshAt=Date.now()+15000;
  return watchIds;
}
export async function pollOnce(){
  if(busy)return;
  busy=true;
  try{
    await initSnapshots();
    const response=await fetch(API,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'*/*',
      'origin':'https://br.888casino.com','referer':'https://br.888casino.com/','user-agent':'Mozilla/5.0'},body:postData,
      signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`Origem HTTP ${response.status}`);
    const body=await response.json();
    if(!body.LiveTables||typeof body.LiveTables!=='object')throw Error('API sem LiveTables');
    const watched=await watchedTables();
    for(const [id,raw] of Object.entries(body.LiveTables)){
      const now=snapshot(raw);if(!now)continue;
      const name=tableName(id,raw);
      let info=snapshots.get(id);
      if(!info){
        await pool.query('INSERT INTO tables(id,name,last_snapshot,last_seen_at) VALUES($1,$2,NULL,now()) ON CONFLICT(id) DO NOTHING',[id,name]);
        info={name,previous:null};snapshots.set(id,info);
      }
      if(!watched.has(id))continue;
      const previous=info.previous;
      if(!previous){
        const count=await pool.query('SELECT 1 FROM spins WHERE table_id=$1 LIMIT 1',[id]);
        if(!count.rowCount)await processSpin(id,now[0],'initial');
      }else{
        const {numbers,gap}=inferNewNumbers(previous,now);
        for(const n of numbers)await processSpin(id,n);
        if(gap)await pool.query('UPDATE tables SET gap_count=gap_count+1 WHERE id=$1',[id]);
      }
      // Uma gravação de snapshot apenas quando a janela de resultados mudar.
      if(!previous||previous.length!==now.length||now.some((n,i)=>n!==previous[i])){
        await pool.query('UPDATE tables SET last_snapshot=$2,last_seen_at=now(),name=$3 WHERE id=$1',[id,JSON.stringify(now),name]);
        info.previous=now;info.name=name;
      }
    }
    live.online=true;live.error=null;live.lastPoll=new Date().toISOString();
  }catch(e){
    live.online=false;live.error=String(e.message).slice(0,250);
    console.error('[coleta]',live.error);
  }finally{busy=false;}
}
let sendBusy=false;
export async function deliverOne(){
  if(sendBusy||Date.now()<nextOutboxCheckAt)return;
  sendBusy=true;
  try{
    // Single serialized queue; next message only after previous attempt finishes.
    const {rows}=await pool.query(`SELECT o.*,p.bot_token_cipher,p.chat_id_cipher,p.thread_id,p.send_enabled,p.flags,p.armed_after_id,p.table_id AS selected_table
      FROM outbox o JOIN preferences p ON p.user_id=o.user_id
      WHERE o.status='queued' AND o.run_after<=now() ORDER BY o.id LIMIT 1`);
    const item=rows[0];if(!item){nextOutboxCheckAt=Date.now()+30000;return;}
    nextOutboxCheckAt=0;
    if(!item.send_enabled||item.selected_table!==item.table_id||!item.flags?.[item.strategy_key]
      ||BigInt(item.spin_id)<=BigInt(item.armed_after_id)||!item.bot_token_cipher||!item.chat_id_cipher){
      await pool.query("UPDATE outbox SET status='cancelled' WHERE id=$1",[item.id]);return;
    }
    await pool.query("UPDATE outbox SET status='processing',tries=tries+1 WHERE id=$1 AND status='queued'",[item.id]);
    let json;
    try{
      const token=decrypt(item.bot_token_cipher),chatId=decrypt(item.chat_id_cipher);
      const payload={chat_id:chatId,text:item.body,disable_web_page_preview:true};
      if(item.thread_id)payload.message_thread_id=Number(item.thread_id);
      const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
      json=await r.json();
      if(!r.ok||!json.ok)throw Error(`Telegram HTTP ${r.status}: ${String(json.description||'falha').slice(0,150)}`);
      await pool.query("UPDATE outbox SET status='sent',sent_at=now(),last_error=NULL WHERE id=$1",[item.id]);
    }catch(e){
      const retry=Number(item.tries)<3;
      await pool.query(`UPDATE outbox SET status=$2,run_after=now()+($3*interval '1 second'),last_error=$4 WHERE id=$1`,
        [item.id,retry?'queued':'failed',retry?10*(Number(item.tries)+1):0,String(e.message).slice(0,180)]);
      if(retry)nextOutboxCheckAt=Date.now()+10000*(Number(item.tries)+1);
    }
  }catch(e){console.error('[telegram]',e.message);}finally{sendBusy=false;}
}
export function startWorkers(){
  // A stopped process may leave a message in 'processing'. Recover it on restart.
  pool.query("UPDATE outbox SET status='queued',run_after=now()+interval '5 seconds' WHERE status='processing'")
    .then(()=>deliverOne()).catch(e=>console.error('[outbox recovery]',e.message));
  pollOnce();
  const interval=Math.max(2000,Number(process.env.POLL_MS)||2500);
  setInterval(pollOnce,interval);
  setInterval(deliverOne,1400);
  setInterval(()=>pool.query("DELETE FROM sessions WHERE expires_at<now()").catch(e=>console.error(e.message)),3600000);
}
