import {pool} from './db.js';
import {getHistory,applySpin,getAnalyses,invalidateHistory,HISTORY_LIMIT} from './history-cache.js';
import {color,column,KEYS,inferNewNumbers,matches,TITLES} from './strategies.js';
import {decrypt} from './security.js';

export const live={online:false,lastPoll:null,lastSuccess:null,error:null,received:0,tableCount:0,tableErrors:0,leader:false};
const API='https://cgp.safe-iplay.com/cgpapi/liveFeed/GetLiveTables';
const postData=new URLSearchParams({regulationID:'4',lang:'por',clientRequestId:'init',
 clientProperties:JSON.stringify({brandName:'888Casino',language:'por'}),
 CGP_DomainOrigin:'https://br.888casino.com',CGP_Skin:'888casino',CGP_SkinOverride:'com'});
const names={'2010097':'VIP Roulette','2010017':'Auto Roulette','2010016':'Immersive Roulette','2010165':'Roulette','2010098':'Auto Roulette VIP','2010012':'American Roulette','2010565':'Gold Vault Roulette','2010096':'Speed Auto Roulette','2010033':'Lightning Roulette','2010440':'XXXtreme Lightning Roulette','2380064':'Roleta Azure','2380038':'Roulette Macao','2380148':'PowerUp Roulette','2380390':'Immersive Roulette Deluxe'};
const SUPPORTED_TABLE_RE=/(roulette|roleta)/i;
const EXCLUDED_TABLE_RE=/(crazy time|craps|dream catcher|olympus|baccarat|blackjack|poker|dragon tiger|american roulette|888)/i;
const symbol={V:'🔴',P:'⚫',B:'🟢',0:'🟢',1:'1️⃣',2:'2️⃣',3:'3️⃣'};
let busy=false;
let sendBusy=false;
let nextOutboxCheckAt=0;
let workerStarted=false;
const POLL_LOCK=734287921;

function sanitizeTableName(name){return String(name||'').replace(/\s*[·-]\s*\d{5,}$/,'').trim();}
function isSupportedTable(name){return SUPPORTED_TABLE_RE.test(String(name||'')) && !EXCLUDED_TABLE_RE.test(String(name||''));}
function tableName(id,obj){
  for(const key of ['TableName','tableName','GameName','gameName','Name','name']) if(typeof obj[key]==='string'&&obj[key].trim()) return sanitizeTableName(obj[key].trim().slice(0,100));
  return sanitizeTableName(names[id]||`Roleta ${id}`);
}
function snapshot(obj){
  const a=obj?.RouletteLast5Numbers;
  if(!Array.isArray(a)||!a.length) return null;
  const list=a.slice(0,5).map(value=>{
    if(typeof value==='number')return value;
    if(typeof value==='string'&&/^\d{1,2}$/.test(value.trim()))return Number(value.trim());
    return NaN; // null, vazio e objetos não representam o número zero
  });
  return list.every(n=>Number.isInteger(n)&&n>=0&&n<=36)?list:null;
}
function describeSpin(number){
  const col=column(number);
  const colorKey=number===0?'B':color(number);
  return `${number} ${symbol[colorKey]}${col?` · C${col}`:' · Zero'}`;
}
function targetText(key,target){
  if(key.startsWith('col')) return `Coluna ${target} ${symbol[target]}`;
  if(key.startsWith('n')) return target==='B'?'Zero 🟢':`${symbol[target]} + proteção no zero 🟢`;
  return target==='B'?'Zero 🟢':`${symbol[target]} + proteção no zero 🟢`;
}

async function enqueue(profileId,userId,tableId,key,spinId,signalId,body,unique){
  await pool.query('INSERT INTO outbox(profile_id,user_id,table_id,strategy_key,spin_id,signal_id,body,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dedupe_key) DO NOTHING',
    [profileId,userId,tableId,key,spinId,signalId,body,unique]);
  nextOutboxCheckAt=0;
}

async function processSignals(tableId,spin,history){
  const num=spin.number;
  const {rows:profiles}=await pool.query(`SELECT tp.*,p.table_id AS selected_table
    FROM telegram_profiles tp
    JOIN preferences p ON p.user_id=tp.user_id
    WHERE p.table_id=$1 AND tp.send_enabled=true`,[tableId]);

  for(const profile of profiles){
    const flags=profile.flags||{};
    const {rows:open}=await pool.query("SELECT * FROM signals WHERE profile_id=$1 AND table_id=$2 AND status='open' ORDER BY id",[profile.id,tableId]);
    for(const sig of open){
      if(BigInt(spin.id)<=BigInt(sig.start_spin_id)||BigInt(spin.id)<=BigInt(sig.last_processed_id)) continue;
      if(!flags[sig.strategy_key]||!profile.bot_token_cipher||!profile.chat_id_cipher){
        await pool.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE id=$1",[sig.id]);
        continue;
      }
      const attempt=BigInt(sig.attempts);
      const didMatch=matches(num,sig.kind,sig.target);
      if(didMatch){
        const label=attempt===0n?'SG':`G${attempt}`;
        const zero=(sig.kind==='cor'&&color(num)==='B'&&sig.target!=='B');
        const body=`✅ GREEN ${label}${zero?' (ZERO)':''} | ${TITLES[sig.strategy_key]}\n📡 Perfil: ${profile.label}\n🎯 Alvo: ${targetText(sig.strategy_key,sig.target)}\n🎲 Resultado: ${describeSpin(num)}\n🕒 ${new Date(spin.created_at).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})}`;
        await pool.query("UPDATE signals SET status='green',attempts=$2,last_processed_id=$3,closed_at=now() WHERE id=$1",[sig.id,attempt.toString(),spin.id]);
        await enqueue(profile.id,profile.user_id,tableId,sig.strategy_key,spin.id,sig.id,body,`result:${sig.id}:${spin.id}`);
      }else if(attempt>=BigInt(sig.gale_limit)){
        await pool.query("UPDATE signals SET status='red',last_processed_id=$2,closed_at=now() WHERE id=$1",[sig.id,spin.id]);
        await enqueue(profile.id,profile.user_id,tableId,sig.strategy_key,spin.id,sig.id,
          `❌ RED | ${TITLES[sig.strategy_key]}\n📡 Perfil: ${profile.label}\n🎯 Alvo: ${targetText(sig.strategy_key,sig.target)}\n🎲 Resultado: ${describeSpin(num)}\nLimite: G${sig.gale_limit}`,
          `result:${sig.id}:${spin.id}`);
      }else{
        const next=attempt+1n;
        await pool.query('UPDATE signals SET attempts=$2,last_processed_id=$3 WHERE id=$1',[sig.id,next.toString(),spin.id]);
        await enqueue(profile.id,profile.user_id,tableId,sig.strategy_key,spin.id,sig.id,
          `⚠️ GALE ${next} | ${TITLES[sig.strategy_key]}\n📡 Perfil: ${profile.label}\n🎯 Manter: ${targetText(sig.strategy_key,sig.target)}\n🎲 Último: ${describeSpin(num)}`,
          `gale:${sig.id}:${spin.id}`);
      }
    }
  }

  const analyses=getAnalyses(history);
  for(const profile of profiles){
    if(!profile.bot_token_cipher||!profile.chat_id_cipher||BigInt(spin.id)<=BigInt(profile.armed_after_id)) continue;
    for(const key of KEYS){
      if(profile.flags?.[key]!==true) continue;
      const a=analyses[key];
      if(!a?.occurrences||a.target===null||a.percentage<profile.threshold) continue;
      const exists=await pool.query("SELECT 1 FROM signals WHERE profile_id=$1 AND table_id=$2 AND strategy_key=$3 AND status='open'",[profile.id,tableId,key]);
      if(exists.rowCount) continue;
      const kind=key.startsWith('col')?'col':'cor'; // Padrão de números aponta para COR, como no Python original.
      const {rows:signals}=await pool.query(`INSERT INTO signals(profile_id,user_id,table_id,strategy_key,target,kind,start_spin_id,last_processed_id,gale_limit)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
       [profile.id,profile.user_id,tableId,key,String(a.target),kind,spin.id,profile.gale_limit]);
      if(!signals.length) continue;
      await enqueue(profile.id,profile.user_id,tableId,key,spin.id,signals[0].id,
        `🎯 SINAL | ${a.title}\n📡 Perfil: ${profile.label}\nApós resultado: ${describeSpin(num)}\nEntrada: ${targetText(key,a.target)}\nAmostra: ${a.occurrences} ocorrência(s), ${a.percentage}%\nAté G${profile.gale_limit}\nAguardar o próximo giro.`,
        `signal:${signals[0].id}`);
    }
  }
}

// Uma transação por mesa: giros, corte do anel e cursor da API são gravados juntos.
// Em falha ou reinício, não se insere novamente um giro cujo cursor já foi confirmado.
export async function ingestTable(client,id,raw){
  const now=snapshot(raw);
  if(!now) return {inserted:[],gap:false,ignored:true};
  const name=tableName(id,raw);
  if(!isSupportedTable(name)) return {inserted:[],gap:false,ignored:true};
  const history=await getHistory(id);
  let inserted=[],gap=false;
  try{
    await client.query('BEGIN');
    await client.query('INSERT INTO tables(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,name]);
    const {rows}=await client.query('SELECT last_snapshot FROM tables WHERE id=$1 FOR UPDATE',[id]);
    const previous=rows[0].last_snapshot;
    let numbers=[];
    if(!previous){
      // Primeiro acesso: os cinco resultados disponíveis são observações históricas,
      // sem disparar sinais retroativos. Para uma mesa migrada, não duplicar o último.
      if(!history.rows.length) numbers=[...now].reverse();
      else if(history.rows.at(-1).number!==now[0]) numbers=[now[0]];
    }else{
      ({numbers,gap}=inferNewNumbers(previous,now));
    }
    if(gap){
      // Um intervalo sem sobreposição invalida sinais em aberto: os gales foram perdidos.
      await client.query("UPDATE signals SET status='cancelled',closed_at=now() WHERE table_id=$1 AND status='open'",[id]);
      await client.query("UPDATE outbox SET status='cancelled' WHERE table_id=$1 AND status='queued'",[id]);
    }
    for(const n of numbers){
      const source=!previous?'initial':gap?'gap':'api';
      const {rows:added}=await client.query('INSERT INTO spins(table_id,number,source) VALUES($1,$2,$3) RETURNING id::text,number,source,created_at',[id,n,source]);
      inserted.push(added[0]);
    }
    if(numbers.length) await client.query(`DELETE FROM spins WHERE id IN
      (SELECT id FROM spins WHERE table_id=$1 ORDER BY id DESC OFFSET $2)`,[id,HISTORY_LIMIT]);
    await client.query(`UPDATE tables SET last_snapshot=$2,last_seen_at=now(),name=$3,
      gap_count=gap_count+$4,history_revision=history_revision+$5 WHERE id=$1`,[id,JSON.stringify(now),name,gap?1:0,numbers.length]);
    await client.query('COMMIT');
  }catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  }
  if(inserted.length){
    // Outro processo pode editar a mesa entre leituras: sincronizar cache a partir do DB.
    invalidateHistory(id);
    // Usar histórico anterior a cada giro para analisar o padrão no instante correto.
    for(const spin of inserted){
      applySpin(history,spin);
      if(spin.source==='api' || spin.source==='gap'){
        try{await processSignals(id,spin,history);}
        catch(err){console.error(`[sinais] Mesa ${id}, giro ${spin.id}:`,err.message);live.tableErrors++;}
      }
    }
  }
  return {inserted,gap,ignored:false};
}

async function publishHealth(error=null,received=0){
  try{
    await pool.query(`INSERT INTO collector_health(id,last_poll,last_success,last_error,received_total,table_count,table_errors)
      VALUES(1,now(),CASE WHEN $1::text IS NULL THEN now() ELSE NULL END,$1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET last_poll=excluded.last_poll,
        last_success=CASE WHEN $1::text IS NULL THEN now() ELSE collector_health.last_success END,
        last_error=excluded.last_error,received_total=collector_health.received_total+$2,
        table_count=$3,table_errors=$4`,[error,received,live.tableCount,live.tableErrors]);
  }catch(e){console.error('[saude-coletor]',e.message);}
}

export async function readCollectorHealth(){
  const {rows}=await pool.query('SELECT last_poll,last_success,last_error,received_total,table_count,table_errors FROM collector_health WHERE id=1');
  const row=rows[0];
  const fresh=row?.last_poll && Date.now()-new Date(row.last_poll).getTime()<Math.max(60000,(Number(process.env.POLL_MS)||2500)*8);
  return {online:!!fresh&&(!row.last_error||Number(row.table_count)>0&&Number(row.table_errors)>0),lastPoll:row?.last_poll||null,lastSuccess:row?.last_success||null,
    error:!fresh?'Coletor sem atualização recente':row?.last_error||null,
    received:Number(row?.received_total||0),tableCount:Number(row?.table_count||0),tableErrors:Number(row?.table_errors||0)};
}

export async function pollOnce(){
  if(busy) return;
  busy=true;
  let lockClient,locked=false;
  try{
    lockClient=await pool.connect();
    const {rows:lock}=await lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired',[POLL_LOCK]);
    locked=!!lock[0].acquired;
    live.leader=locked;
    if(!locked)return; // outro coletor já processa esta mesma consulta
    const response=await fetch(API,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'*/*',
      'origin':'https://br.888casino.com','referer':'https://br.888casino.com/','user-agent':'Mozilla/5.0'},body:postData,
      signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw Error(`Origem HTTP ${response.status}`);
    const body=await response.json();
    if(!body.LiveTables||typeof body.LiveTables!=='object'||Array.isArray(body.LiveTables)) throw Error('API sem LiveTables');
    let received=0,success=0;
    live.tableErrors=0;
    for(const [id,raw] of Object.entries(body.LiveTables)){
      try{
        const result=await ingestTable(lockClient,id,raw);
        if(result.ignored)continue;
        success++;
        received+=result.inserted.length;
      }catch(e){
        live.tableErrors++;
        console.error(`[mesa ${id}]`,e.message);
      }
    }
    if(!success) throw Error('API não forneceu mesas de roleta válidas para armazenamento');
    live.online=true;
    live.error=live.tableErrors?`${live.tableErrors} mesa(s) com falha; consulte os logs`:null;
    live.lastPoll=new Date().toISOString();
    live.lastSuccess=live.lastPoll;
    live.received+=received;
    live.tableCount=success;
    await publishHealth(live.error,received);
  }catch(e){
    live.online=false;
    live.error=String(e.message).slice(0,250);
    live.lastPoll=new Date().toISOString();
    live.tableCount=0;
    live.tableErrors=0;
    console.error('[coleta]',live.error);
    if(locked)await publishHealth(live.error);
  }finally{
    if(lockClient){
      if(locked) await lockClient.query('SELECT pg_advisory_unlock($1)',[POLL_LOCK]).catch(e=>console.error('[lock]',e.message));
      lockClient.release();
    }
    busy=false;
  }
}

export async function deliverOne(){
  if(sendBusy||Date.now()<nextOutboxCheckAt) return;
  sendBusy=true;
  try{
    const {rows}=await pool.query(`SELECT o.*,tp.label,tp.bot_token_cipher,tp.chat_id_cipher,tp.thread_id,tp.send_enabled,tp.flags,tp.armed_after_id,p.table_id AS selected_table
      FROM outbox o
      JOIN telegram_profiles tp ON tp.id=o.profile_id
      JOIN preferences p ON p.user_id=o.user_id
      WHERE o.status='queued' AND o.run_after<=now()
      ORDER BY o.id LIMIT 1`);
    const item=rows[0];
    if(!item){nextOutboxCheckAt=Date.now()+30000;return;}
    nextOutboxCheckAt=0;
    if(!item.send_enabled||item.selected_table!==item.table_id||!item.flags?.[item.strategy_key]
      ||BigInt(item.spin_id)<=BigInt(item.armed_after_id)||!item.bot_token_cipher||!item.chat_id_cipher){
      await pool.query("UPDATE outbox SET status='cancelled' WHERE id=$1",[item.id]);
      return;
    }
    const claim=await pool.query("UPDATE outbox SET status='processing',tries=tries+1 WHERE id=$1 AND status='queued' RETURNING id",[item.id]);
    if(!claim.rowCount)return; // envio já adquirido por outra instância
    const {rows:freshRows}=await pool.query(`SELECT o.status,tp.bot_token_cipher,tp.chat_id_cipher,tp.thread_id,tp.send_enabled,tp.flags,tp.armed_after_id,p.table_id AS selected_table
      FROM outbox o
      JOIN telegram_profiles tp ON tp.id=o.profile_id
      JOIN preferences p ON p.user_id=o.user_id
      WHERE o.id=$1`,[item.id]);
    const fresh=freshRows[0];
    if(!fresh) return;
    if(fresh.status!=='processing'||!fresh.send_enabled||fresh.selected_table!==item.table_id||!fresh.flags?.[item.strategy_key]
      ||BigInt(item.spin_id)<=BigInt(fresh.armed_after_id)||!fresh.bot_token_cipher||!fresh.chat_id_cipher){
      await pool.query("UPDATE outbox SET status='cancelled' WHERE id=$1",[item.id]).catch(()=>{});
      return;
    }
    try{
      const token=decrypt(fresh.bot_token_cipher),chatId=decrypt(fresh.chat_id_cipher);
      const payload={chat_id:chatId,text:item.body,disable_web_page_preview:true};
      if(fresh.thread_id) payload.message_thread_id=Number(fresh.thread_id);
      const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
      const json=await r.json();
      if(!r.ok||!json.ok) throw Error(`Telegram HTTP ${r.status}: ${String(json.description||'falha').slice(0,150)}`);
      await pool.query("UPDATE outbox SET status='sent',sent_at=now(),last_error=NULL WHERE id=$1",[item.id]);
    }catch(e){
      const retry=Number(item.tries)<3;
      await pool.query(`UPDATE outbox SET status=$2,run_after=now()+($3*interval '1 second'),last_error=$4 WHERE id=$1`,
        [item.id,retry?'queued':'failed',retry?10*(Number(item.tries)+1):0,String(e.message).slice(0,180)]).catch(()=>{});
      if(retry) nextOutboxCheckAt=Date.now()+10000*(Number(item.tries)+1);
    }
  }catch(e){
    console.error('[telegram]',e.message);
  }finally{
    sendBusy=false;
  }
}

export function startWorkers(){
  if(workerStarted)return;
  workerStarted=true;
  pool.query("UPDATE outbox SET status='queued',run_after=now()+interval '5 seconds' WHERE status='processing'")
    .then(()=>deliverOne()).catch(e=>console.error('[outbox recovery]',e.message));
  const interval=Math.max(2000,Number(process.env.POLL_MS)||2500);
  // Loop sequencial: a duração de uma rodada nunca se sobrepõe à próxima.
  const loop=async()=>{
    await pollOnce();
    setTimeout(loop,interval);
  };
  void loop();
  setInterval(deliverOne,1400);
  setInterval(()=>pool.query("DELETE FROM sessions WHERE expires_at<now()").catch(e=>console.error(e.message)),3600000);
}
