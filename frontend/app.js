const $=id=>document.getElementById(id);
const KEYS=['n1','n2','n3','n4','cor2','cor3','cor4','col2','col3','col4','consenso'];
const TITLES={n1:'1 número',n2:'2 números',n3:'3 números',n4:'4 números',cor2:'2 cores',cor3:'3 cores',cor4:'4 cores',col2:'2 colunas',col3:'3 colunas',col4:'4 colunas',consenso:'Consenso numérico'};
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const DEFAULT_API='https://rouletts.onrender.com';
const state={
  api:localStorage.getItem('roleta_api')||DEFAULT_API,
  token:sessionStorage.getItem('roleta_token')||'',
  user:null,preferences:null,table:null,
  spins:[],analyses:{},signals:[],outbox:[],profiles:[],profileStats:{all:{}},
  currentProfileId:'',draftProfile:null,selectedNumber:null,
  cardsReady:false,busy:false,dialog:false,refreshTimer:null,liveTimer:null,liveBusy:false,
  historyEpoch:null,latestSpinId:'0',totalStored:0,toastTimer:null
};

const colorKey=n=>n===0?'green':RED.has(n)?'red':'black';
const colorSymbol=n=>n===0?'🟢':RED.has(n)?'🔴':'⚫';
const columnOf=n=>n===0?0:((Number(n)-1)%3)+1;
const columnSymbol=c=>({1:'1️⃣',2:'2️⃣',3:'3️⃣'})[c]||'—';
const categorySymbol={V:'🔴',P:'⚫',B:'🟢',0:'🟢',1:'1️⃣',2:'2️⃣',3:'3️⃣'};

function note(message,error=false){
  const el=$('toast');
  el.textContent=message;
  el.classList.toggle('error',error);
  el.style.display='block';
  clearTimeout(state.toastTimer);
  state.toastTimer=setTimeout(()=>el.style.display='none',5200);
}
async function api(path,method='GET',body=undefined){
  const res=await fetch(`${state.api}${path}`,{
    method,
    headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(state.token?{Authorization:`Bearer ${state.token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
    cache:'no-store',
    signal:AbortSignal.timeout(22000)
  });
  const json=await res.json().catch(()=>({}));
  if(res.status===401&&path!=='/api/login'){logout(false);throw Error('Sessão expirada. Entre novamente.');}
  if(!res.ok) throw Error(json.error||`Erro HTTP ${res.status}`);
  return json;
}
function shortTime(value){if(!value)return '—';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleTimeString('pt-BR',{hour12:false}):'—';}
function append(parent,tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);parent.appendChild(el);return el;}
function emptyProfile(){return {id:'',label:'',sendEnabled:false,hasToken:false,hasChat:false,threadId:'',galeLimit:'1',threshold:64,flags:Object.fromEntries(KEYS.map(k=>[k,false]))};}
function currentProfile(){return state.profiles.find(p=>p.id===state.currentProfileId)||(!state.currentProfileId?state.draftProfile:null)||null;}
function ensureDraft(){if(!state.draftProfile) state.draftProfile=emptyProfile(); return state.draftProfile;}
function profileStatsForCurrent(){return (state.currentProfileId && state.profileStats?.[state.currentProfileId]) || state.profileStats?.all || null;}
function visibleCountForNumber(number){return state.spins.filter(s=>s.number===number).length;}
function spinLabel(n,showColumn=true){
  const num=Number(n);
  if(num===0) return '0 🟢 Zero';
  const col=columnOf(num);
  return `${String(num).padStart(2,'0')} ${colorSymbol(num)}${showColumn?` C${col}`:''}`;
}
function targetLabel(key,target){
  if(target===null||target===undefined||target==='') return '—';
  if(key?.startsWith('n')) return target==='B'?'Zero 🟢':`${categorySymbol[target]||target} + Zero 🟢`;
  if(key?.startsWith('col')) return `C${target} ${columnSymbol(Number(target))}`;
  if(target==='B') return 'Zero 🟢';
  return `${categorySymbol[target]||target} + Zero 🟢`;
}
function sequenceToken(type,value){
  if(type==='num') return spinLabel(Number(value));
  if(type==='col') return `C${value} ${columnSymbol(Number(value))}`;
  if(value==='B') return 'Zero 🟢';
  return categorySymbol[value]||value;
}
function distributionLabel(type,key,value){
  if(type==='col') return `C${key} ${columnSymbol(Number(key))}: ${value}`;
  if(String(key)==='B') return `Zero 🟢: ${value}`;
  return `${categorySymbol[key]||key}: ${value}`;
}
function logout(callApi=true){
  if(callApi&&state.token) api('/api/logout','POST',{}).catch(()=>{});
  state.token='';
  sessionStorage.removeItem('roleta_token');
  state.user=null;
  state.cardsReady=false;
  state.selectedNumber=null;
  clearInterval(state.refreshTimer);clearInterval(state.liveTimer);
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('loginPassword').value='';
}
function enter(data){
  state.user=data.user;
  state.token=data.token;
  sessionStorage.setItem('roleta_token',data.token);
  $('whoami').textContent=`${data.user.username} · ${data.user.role==='admin'?'Admin':'Usuário'}`;
  $('adminButton').classList.toggle('hidden',data.user.role!=='admin');
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  startRefresh();
}

$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=e.submitter;
  btn.disabled=true;
  try{enter(await api('/api/login','POST',{username:$('loginName').value.trim(),password:$('loginPassword').value}));}
  catch(err){note(err.message,true);}finally{btn.disabled=false;}
});
$('logoutButton').addEventListener('click',()=>logout());
document.querySelectorAll('[data-eye]').forEach(b=>b.addEventListener('click',()=>{const el=$(b.dataset.eye);el.type=el.type==='password'?'text':'password';}));

async function fetchTables(){
  const tables=await api('/api/tables');
  const select=$('tableSelect');
  const current=select.value||state.preferences?.tableId||'';
  select.replaceChildren(new Option('Escolha uma roleta',''));
  for(const t of tables) select.add(new Option(t.displayName||t.name,t.id));
  select.value=tables.some(t=>t.id===current)?current:'';
}

function showSpinDetails(spin){
  const box=$('spinDetails');
  box.replaceChildren();
  if(!spin){box.classList.add('hidden');return;}
  const count=visibleCountForNumber(spin.number);
  box.classList.remove('hidden');
  const text=`Selecionado: ${spinLabel(spin.number)} · ${shortTime(spin.created_at)} · ${count} ocorrência(s) visível(is)`;
  const line=append(box,'div','');
  line.innerHTML=`<b>${text}</b>`;
}
function selectNumber(number,spin){
  state.selectedNumber=state.selectedNumber===number?null:number;
  renderGrid();
  showSpinDetails(state.selectedNumber===null?null:spin);
}
function renderGrid(){
  const grade=$('grade');
  grade.replaceChildren();
  $('emptyGrade').classList.toggle('hidden',state.spins.length>0);
  $('emptyGrade').textContent=state.preferences?.tableId?'Aguardando resultados desta roleta.':'Selecione uma roleta para começar.';
  $('storedCount').textContent=String(state.totalStored??state.spins.length);
  $('lastNumber').textContent=state.spins.length?state.spins[0].number:'—';
  const fragment=document.createDocumentFragment();
  for(const spin of state.spins){
    const classes=['ball',colorKey(spin.number)];
    if(spin.source==='manual') classes.push('manual');
    if(state.selectedNumber!==null && spin.number===state.selectedNumber) classes.push('match');
    if(state.selectedNumber!==null && spin.id===state.spins.find(s=>s.number===state.selectedNumber)?.id) classes.push('selected');
    const ball=append(fragment,'button',classes.join(' '));
    ball.type='button';
    ball.title=`${spinLabel(spin.number)} · ${shortTime(spin.created_at)}`;
    append(ball,'span','',String(spin.number).padStart(2,'0'));
    append(ball,'small','',shortTime(spin.created_at));
    ball.addEventListener('click',()=>selectNumber(spin.number,spin));
  }
  grade.appendChild(fragment);
}

function buildCards(){
  const area=$('analysisArea');
  area.replaceChildren();
  for(const key of KEYS){
    const card=append(area,'article','strategy-card');
    card.dataset.key=key;
    const header=append(card,'div','card-head');
    append(header,'strong','',TITLES[key]);
    const actions=append(header,'div','card-actions');
    const send=append(actions,'span','send-pill','');send.dataset.send=key;
    const collapse=append(actions,'button','','▾');
    collapse.title='Recolher';
    collapse.addEventListener('click',e=>{e.stopPropagation();const body=card.querySelector('.card-body');body.classList.toggle('hidden');collapse.textContent=body.classList.contains('hidden')?'▸':'▾';});
    const dock=append(actions,'button','','↩');
    dock.title='Voltar ao painel';
    dock.addEventListener('click',e=>{e.stopPropagation();card.classList.remove('floating');card.style.left='';card.style.top='';card.style.width='';card.style.height='';sessionStorage.removeItem(`roleta_card_${key}`);});
    append(card,'div','card-body');
    makeDraggable(card,header,key);
    const saved=sessionStorage.getItem(`roleta_card_${key}`);
    if(saved){try{const {x,y,w,h}=JSON.parse(saved);moveCard(card,x,y,w,h);}catch{}}
  }
  state.cardsReady=true;
}
function moveCard(card,x,y,w,h){card.classList.add('floating');card.style.left=`${Math.max(0,Math.min(x,innerWidth-90))}px`;card.style.top=`${Math.max(5,Math.min(y,innerHeight-50))}px`;if(w)card.style.width=`${Math.min(w,innerWidth-10)}px`;if(h)card.style.height=`${Math.min(h,innerHeight-5)}px`;}
function makeDraggable(card,handle,key){let drag=null;handle.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.button!==0)return;const rect=card.getBoundingClientRect();moveCard(card,rect.left,rect.top,rect.width,rect.height);drag={dx:e.clientX-rect.left,dy:e.clientY-rect.top};handle.setPointerCapture(e.pointerId);e.preventDefault();});handle.addEventListener('pointermove',e=>{if(!drag)return;moveCard(card,e.clientX-drag.dx,e.clientY-drag.dy);});const end=()=>{if(!drag)return;drag=null;const r=card.getBoundingClientRect();sessionStorage.setItem(`roleta_card_${key}`,JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height}));};handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);}
$('resetCards').addEventListener('click',()=>{for(const key of KEYS)sessionStorage.removeItem(`roleta_card_${key}`);buildCards();renderCards();});
function renderCards(){
  if(!state.cardsReady) buildCards();
  const profile=currentProfile()||emptyProfile();
  for(const key of KEYS){
    const card=document.querySelector(`[data-key="${key}"]`);
    const body=card?.querySelector('.card-body');
    if(!body) continue;
    card.querySelector('[data-send]').textContent=profile.sendEnabled&&profile.flags?.[key]?'● ativo':'';
    const collapsed=body.classList.contains('hidden');
    body.replaceChildren();
    body.classList.toggle('hidden',collapsed);
    const data=state.analyses[key];
    if(!data){append(body,'p','',state.preferences?.tableId?'Aguardando histórico.':'Selecione uma roleta.');continue;}
    append(body,'div','sequence',`Padrão: ${(data.sequence||[]).map(v=>sequenceToken(data.type,v)).join(' → ')||'—'}`);
    const stats=append(body,'div','stats');
    const a=append(stats,'div','statbox');append(a,'b','',data.occurrences||0);append(a,'span','', 'Ocorrências no histórico');
    const b=append(stats,'div','statbox');append(b,'b','',`${data.percentage||0}%`);append(b,'span','', `Amostra: ${data.sampleCount??data.sample?.length??0}`);
    const c=append(stats,'div','statbox');append(c,'b','',data.target===null?'—':targetLabel(key,data.target));append(c,'span','', 'Tendência');
    if(data.gapLimited)append(body,'p','', 'Aguardando sequência completa após lacuna na coleta.');
    const dist=append(body,'div','distribution');
    for(const [name,value] of Object.entries(data.counts||{})){append(dist,'span','dist-item',distributionLabel(data.type,name,value));}
    const sample=append(body,'div','sample');
    if(data.sample?.length){for(const item of data.sample){const chip=append(sample,'span','accent',`${spinLabel(item.number)} · ${shortTime(item.time)}`);chip.title='Resultado seguinte nas ocorrências';}}
    else append(sample,'span','', 'Sem ocorrências disponíveis');
  }
}

function renderProfileStats(){
  const box=$('profileStats');
  box.replaceChildren();
  const stats=profileStatsForCurrent();
  if(!stats||(!stats.total && !stats.closed && !stats.open && !stats.cancelled)){
    append(box,'div','summary-card','');
    box.firstChild.innerHTML='<b>0</b><span>Nenhum sinal no histórico atual</span>';
    return;
  }
  const cards=[
    ['Assertividade',`${stats.accuracy||0}%`],
    ['Greens',stats.greens||0],
    ['Reds',stats.reds||0],
    ['SG',stats.sg||0],
    ['G1',stats.g1||0],
    ['G2',stats.g2||0],
    ['G3+', (stats.g3||0)+(stats.g4Plus||0)],
    ['Abertos',stats.open||0],
    ['Canc.',stats.cancelled||0],
    ['Seq. green atual',stats.currentGreenStreak||0],
    ['Melhor green',stats.bestGreenStreak||0],
    ['Melhor red',stats.bestRedStreak||0],
  ];
  for(const [label,value] of cards){const item=append(box,'div','summary-card');append(item,'b','',value);append(item,'span','',label);}
}
function renderLogs(){
  const signals=$('signalsList'),outbox=$('outboxList');
  signals.replaceChildren();outbox.replaceChildren();
  if(!state.signals.length) append(signals,'div','empty','Nenhum sinal registrado.');
  for(const item of state.signals){
    const box=append(signals,'div','log-item');
    append(box,'strong','',`${item.profile_label||'Sem perfil'} · ${TITLES[item.strategy_key]} · ${item.status.toUpperCase()} · ${shortTime(item.created_at)}`);
    append(box,'span','',`Alvo: ${targetLabel(item.strategy_key,item.target)} · Andamento: ${item.attempts}/${item.gale_limit}`);
  }
  if(!state.outbox.length) append(outbox,'div','empty','Nenhuma mensagem enviada ou pendente.');
  for(const item of state.outbox){
    const box=append(outbox,'div','log-item');
    append(box,'strong','',`${item.profile_label||'Sem perfil'} · ${TITLES[item.strategy_key]} · ${item.status} · ${shortTime(item.created_at)}`);
    append(box,'span','',item.body);
    if(item.last_error) append(box,'small','error-text',item.last_error);
  }
}

function setTelegramForm(profile){
  profile=profile||emptyProfile();
  $('profileLabel').value=profile.label||'';
  $('telegramEnabled').checked=!!profile.sendEnabled;
  $('botToken').value='';$('chatId').value='';
  $('botToken').placeholder=profile.hasToken?'Token salvo; deixe vazio para manter':'Token não configurado';
  $('chatId').placeholder=profile.hasChat?'Chat ID salvo; deixe vazio para manter':'Chat ID não configurado';
  $('threadId').value=profile.threadId||'';
  $('galeLimit').value=profile.galeLimit||'1';
  $('threshold').value=profile.threshold??64;
  renderFlags();
}
function renderFlags(){
  const box=$('flagsGrid');box.replaceChildren();
  const profile=currentProfile()||emptyProfile();
  for(const key of KEYS){
    const label=append(box,'label',`flag-option ${profile.flags?.[key]?'selected':''}`);
    const input=append(label,'input');input.type='checkbox';input.checked=!!profile.flags?.[key];
    append(label,'span','',TITLES[key]);
    input.addEventListener('change',()=>{
      const target=state.currentProfileId ? currentProfile() : ensureDraft();
      target.flags={...(target.flags||{}),[key]:input.checked};
      label.classList.toggle('selected',input.checked);
      renderCards();
    });
  }
}
function renderProfiles(){
  const box=$('profilesList');box.replaceChildren();
  if(!state.profiles.length){append(box,'div','empty','Nenhum perfil salvo.');$('deleteProfileBtn').disabled=true;return;}
  $('deleteProfileBtn').disabled=!state.currentProfileId;
  for(const profile of state.profiles){
    const item=append(box,'button',`profile-item ${profile.id===state.currentProfileId?'active':''}`);
    item.type='button';
    const line=append(item,'div','line');
    append(line,'strong','',profile.label);
    const dot=append(line,'span',`status-dot ${profile.sendEnabled?'on':''}`);
    dot.title=profile.sendEnabled?'Envio ativo':'Envio desativado';
    append(item,'small','',`${profile.sendEnabled?'Envio ativo':'Envio desligado'} · ${KEYS.filter(k=>profile.flags?.[k]).length} estratégia(s)`);
    if(profile.threadId) append(item,'small','',`Tópico: ${profile.threadId}`);
    item.addEventListener('click',()=>{state.currentProfileId=profile.id;setTelegramForm(profile);renderProfiles();renderCards();renderProfileStats();});
  }
}
function syncProfiles(profiles){
  state.profiles=profiles||[];
  if(!state.profiles.length){state.currentProfileId='';state.draftProfile=emptyProfile();setTelegramForm(state.draftProfile);} 
  else if(!state.profiles.some(p=>p.id===state.currentProfileId)){state.currentProfileId=state.profiles[0].id;state.draftProfile=emptyProfile();setTelegramForm(currentProfile());}
  renderProfiles();renderCards();renderProfileStats();
}
function collectProfileBody(){
  const profile=currentProfile()||ensureDraft();
  return {label:$('profileLabel').value.trim(),sendEnabled:$('telegramEnabled').checked,flags:{...(profile.flags||{})},botToken:$('botToken').value.trim(),chatId:$('chatId').value.trim(),threadId:$('threadId').value.trim(),galeLimit:$('galeLimit').value.trim(),threshold:Number($('threshold').value)};
}
async function saveCurrentProfile(){
  const profile=currentProfile();
  const body=collectProfileBody();
  if(profile?.id){
    const r=await api(`/api/telegram/profiles/${profile.id}`,'PATCH',body);
    syncProfiles(r.profiles);
    state.currentProfileId=r.profile.id;
    setTelegramForm(currentProfile());
    return r;
  }
  const r=await api('/api/telegram/profiles','POST',body);
  syncProfiles(r.profiles);
  state.currentProfileId=r.profile.id;
  state.draftProfile=emptyProfile();
  setTelegramForm(currentProfile());
  return r;
}

async function refresh(){
  if(!state.token||state.busy||state.dialog) return;
  state.busy=true;
  try{
    const data=await api('/api/state');
    state.user=data.user;state.preferences=data.preferences;state.table=data.table;state.spins=data.spins;state.analyses=data.analyses;
    state.signals=data.signals;state.outbox=data.outbox;state.totalStored=data.totalStored;state.historyEpoch=data.historyEpoch;state.latestSpinId=data.latestSpinId;
    state.profileStats=data.profileStats||{all:{}};
    syncProfiles(data.profiles||[]);
    const collector=data.collector||{};
    const pill=$('livePill');pill.className=`pill ${collector.online?'ok':'error'}`;pill.textContent=collector.online?(collector.error?'● Coleta parcial':'● Coleta conectada'):`● ${collector.error?'Coleta indisponível':'Conectando'}`;pill.title=collector.error||'';$('lastSync').textContent=shortTime(collector.lastPoll);
    $('whoami').textContent=`${data.user.username} · ${data.user.role==='admin'?'Admin':'Usuário'}`;$('adminButton').classList.toggle('hidden',data.user.role!=='admin');
    await fetchTables(); // mesas novas entram na lista mesmo após o login
    $('tableSelect').value=data.preferences.tableId||'';
    const count=data.preferences.displayLimit;$('countSelect').value=[50,100,200,500,1000,2000].includes(count)?String(count):'custom';$('customBox').classList.toggle('hidden',$('countSelect').value!=='custom');$('customCount').value=count;
    if(!['profileLabel','botToken','chatId','threadId','galeLimit','threshold'].includes(document.activeElement?.id||'')) setTelegramForm(currentProfile());
    renderGrid();renderCards();renderProfileStats();renderLogs();
    if(state.selectedNumber!==null){const spin=state.spins.find(s=>s.number===state.selectedNumber);showSpinDetails(spin||null);}else $('spinDetails').classList.add('hidden');
  }catch(err){if(state.token)note(err.message,true);}finally{state.busy=false;}
}
async function liveRefresh(){
  if(!state.token||!state.preferences?.tableId||state.busy||state.liveBusy||state.dialog) return;
  state.liveBusy=true;
  const tableId=state.preferences.tableId;
  try{
    const q=new URLSearchParams({tableId,limit:String(state.preferences.displayLimit),afterId:state.latestSpinId,epoch:String(state.historyEpoch)});
    const d=await api(`/api/live?${q}`);
    if(tableId!==state.preferences?.tableId) return;
    const pill=$('livePill');pill.className=`pill ${d.collector.online?'ok':'error'}`;pill.textContent=d.collector.online?(d.collector.error?'● Coleta parcial':'● Coleta conectada'):`● ${d.collector.error?'Coleta indisponível':'Conectando'}`;pill.title=d.collector.error||'';$('lastSync').textContent=shortTime(d.collector.lastPoll);
    state.totalStored=d.totalStored;state.historyEpoch=d.epoch;state.latestSpinId=d.latest;
    if(d.replace){state.spins=d.spins;state.analyses=d.analyses||state.analyses;renderGrid();renderCards();}
    else if(d.spins.length){const ids=new Set(d.spins.map(s=>s.id));state.spins=[...d.spins,...state.spins.filter(s=>!ids.has(s.id))].slice(0,state.preferences.displayLimit);state.analyses=d.analyses||state.analyses;renderGrid();renderCards();}
    else $('storedCount').textContent=String(state.totalStored);
    if(state.selectedNumber!==null){const spin=state.spins.find(s=>s.number===state.selectedNumber);showSpinDetails(spin||null);}
  }catch(err){if(state.token)note(err.message,true);}finally{state.liveBusy=false;}
}
function startRefresh(){clearInterval(state.refreshTimer);clearInterval(state.liveTimer);state.cardsReady=false;fetchTables().then(refresh).catch(err=>note(err.message,true));state.liveTimer=setInterval(liveRefresh,2500);state.refreshTimer=setInterval(refresh,30000);}
async function savePref(body){const r=await api('/api/preferences','PATCH',body);state.preferences=r.preferences;await refresh();}
$('tableSelect').addEventListener('change',async e=>{e.target.disabled=true;try{state.selectedNumber=null;showSpinDetails(null);await savePref({tableId:e.target.value});note('Roleta alterada.');}catch(err){note(err.message,true);}finally{e.target.disabled=false;}});
$('countSelect').addEventListener('change',async e=>{if(e.target.value==='custom'){$('customBox').classList.remove('hidden');$('customCount').focus();return;}try{await savePref({displayLimit:Number(e.target.value)});}catch(err){note(err.message,true);}});
$('customCount').addEventListener('change',async e=>{const n=Number(e.target.value);if(!Number.isInteger(n)||n<1||n>2000)return note('Quantidade entre 1 e 2.000.',true);try{await savePref({displayLimit:n});}catch(err){note(err.message,true);}});

$('newProfileBtn').addEventListener('click',()=>{state.currentProfileId='';state.draftProfile=emptyProfile();setTelegramForm(state.draftProfile);renderProfiles();renderCards();renderProfileStats();note('Novo perfil pronto para cadastro.');});
$('deleteProfileBtn').addEventListener('click',async()=>{const profile=currentProfile();if(!profile?.id)return;if(!confirm(`Excluir o perfil “${profile.label}”? O envio será interrompido imediatamente.`))return;try{const r=await api(`/api/telegram/profiles/${profile.id}`,'DELETE',{});syncProfiles(r.profiles);note('Perfil excluído e envios cancelados.');await refresh();}catch(err){note(err.message,true);}});
$('telegramForm').addEventListener('submit',async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const creating=!currentProfile()?.id;const r=await saveCurrentProfile();note((creating?'Perfil criado. ':'Perfil salvo. ')+r.message);await refresh();}catch(err){note(err.message,true);}finally{btn.disabled=false;}});
$('verifyTelegram').addEventListener('click',async e=>{e.target.disabled=true;try{const r=await api('/api/telegram/verify','POST',{botToken:$('botToken').value.trim(),chatId:$('chatId').value.trim()});note(`Bot @${r.bot} · Sala ${r.chat}. O teste não enviou mensagens.`);}catch(err){note(err.message,true);}finally{e.target.disabled=false;}});
$('telegramEnabled').addEventListener('change',()=>renderCards());

$('adminButton').addEventListener('click',async()=>{$('adminModal').classList.remove('hidden');state.dialog=true;await loadAdmin().catch(err=>note(err.message,true));});
$('closeAdmin').addEventListener('click',()=>{$('adminModal').classList.add('hidden');state.dialog=false;refresh();});
async function loadAdmin(){
  const [users,audit]=await Promise.all([api('/api/admin/users'),api('/api/admin/audit')]);
  const box=$('usersList');box.replaceChildren();
  for(const user of users){
    const row=append(box,'div','user-line');
    const info=append(row,'div');append(info,'strong','',user.username);append(info,'small','',user.role);
    const buttons=append(row,'div','buttons');
    const edit=append(buttons,'button','secondary','Editar');
    edit.addEventListener('click',async()=>{const username=prompt('Nome de usuário:',user.username);if(username===null)return;const role=prompt('Perfil: user ou admin',user.role);if(role===null)return;const password=prompt('Nova senha (deixe vazio para manter):','');if(password===null)return;try{await api(`/api/admin/users/${user.id}`,'PATCH',{username,role,...(password?{password}:{})});note('Conta atualizada.');await loadAdmin();}catch(err){note(err.message,true);}});
    const del=append(buttons,'button','danger','Excluir');del.disabled=user.id===state.user.id;del.addEventListener('click',async()=>{if(!confirm(`Excluir a conta ${user.username}?`))return;try{await api(`/api/admin/users/${user.id}`,'DELETE',{});note('Conta excluída.');await loadAdmin();}catch(err){note(err.message,true);}});
  }
  const auditBox=$('auditList');auditBox.replaceChildren();
  for(const item of audit){const x=append(auditBox,'div','log-item');append(x,'strong','',`${item.action} · ${shortTime(item.created_at)}`);append(x,'span','',JSON.stringify(item.detail));}
}
$('createUserForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/users','POST',{username:$('newUsername').value.trim(),password:$('newPassword').value,role:$('newRole').value});$('newUsername').value='';$('newPassword').value='';note('Conta criada.');await loadAdmin();}catch(err){note(err.message,true);}});

if(state.token&&state.api){api('/api/me').then(user=>enter({user,token:state.token})).catch(()=>logout(false));}
