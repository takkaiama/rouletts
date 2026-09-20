const $=id=>document.getElementById(id);
const KEYS=['n1','n2','n3','n4','cor2','cor3','cor4','col2','col3','col4','consenso'];
const TITLES={n1:'1 número',n2:'2 números',n3:'3 números',n4:'4 números',cor2:'2 cores',cor3:'3 cores',cor4:'4 cores',col2:'2 colunas',col3:'3 colunas',col4:'4 colunas',consenso:'Consenso numérico'};
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const color=n=>n===0?'green':RED.has(n)?'red':'black';
const symbol={V:'🔴',P:'⚫',B:'🟢',0:'🟢',1:'1️⃣',2:'2️⃣',3:'3️⃣'};
const state={api:localStorage.getItem('roleta_api')||'',token:sessionStorage.getItem('roleta_token')||'',user:null,preferences:null,table:null,spins:[],analyses:{},signals:[],outbox:[],cardsReady:false,busy:false,dialog:false,refreshTimer:null,toastTimer:null};
function note(message,error=false){const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.style.display='block';clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.style.display='none',5200);}
function urlBase(s){try{const u=new URL(s);if(!['http:','https:'].includes(u.protocol))throw Error();return u.origin;}catch{return null;}}
async function api(path,method='GET',body=undefined){
  const res=await fetch(`${state.api}${path}`,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(state.token?{Authorization:`Bearer ${state.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(22000)});
  const json=await res.json().catch(()=>({}));
  if(res.status===401&&path!=='/api/login'){logout(false);throw Error('Sessão expirada. Entre novamente.');}
  if(!res.ok)throw Error(json.error||`Erro HTTP ${res.status}`);
  return json;
}
function logout(callApi=true){if(callApi&&state.token)api('/api/logout','POST',{}).catch(()=>{});state.token='';sessionStorage.removeItem('roleta_token');state.user=null;state.cardsReady=false;clearInterval(state.refreshTimer);$('loginView').classList.remove('hidden');$('appView').classList.add('hidden');$('loginPassword').value='';}
function enter(data){state.user=data.user;state.token=data.token;sessionStorage.setItem('roleta_token',data.token);$('whoami').textContent=`${data.user.username} · ${data.user.role==='admin'?'Admin':'Usuário'}`;$('adminButton').classList.toggle('hidden',data.user.role!=='admin');$('loginView').classList.add('hidden');$('appView').classList.remove('hidden');startRefresh();}
$('serverUrl').value=state.api;
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const base=urlBase($('serverUrl').value.trim());if(!base)return note('Informe uma URL http(s) válida do servidor.',true);state.api=base;localStorage.setItem('roleta_api',base);const btn=e.submitter;btn.disabled=true;try{const data=await api('/api/login','POST',{username:$('loginName').value.trim(),password:$('loginPassword').value});enter(data);}catch(err){note(err.message,true);}finally{btn.disabled=false;}});
$('logoutButton').addEventListener('click',()=>logout());
document.querySelectorAll('[data-eye]').forEach(b=>b.addEventListener('click',()=>{const el=$(b.dataset.eye);el.type=el.type==='password'?'text':'password';b.setAttribute('aria-label',el.type==='password'?'Mostrar':'Ocultar');}));
function shortTime(value){if(!value)return '—';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleTimeString('pt-BR',{hour12:false}):'—';}
function append(parent,tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);parent.appendChild(el);return el;}
async function fetchTables(){const tables=await api('/api/tables');const select=$('tableSelect'),current=select.value||state.preferences?.tableId||'';select.replaceChildren(new Option('Escolha uma roleta',''));
  for(const t of tables)select.add(new Option(`${t.name} · ${t.id}`,t.id));select.value=tables.some(t=>t.id===current)?current:'';
}
function renderGrid(){
  const grade=$('grade');grade.replaceChildren();$('emptyGrade').classList.toggle('hidden',state.spins.length>0);
  $('emptyGrade').textContent=state.preferences?.tableId?'Aguardando resultados da API para esta mesa.':'Selecione uma roleta para começar.';
  $('storedCount').textContent=String(state.totalStored??state.spins.length);
  $('lastNumber').textContent=state.spins.length?state.spins[0].number:'—';
  const fragment=document.createDocumentFragment();
  for(const spin of state.spins){const ball=append(fragment,'button',`ball ${color(spin.number)} ${spin.source==='api'||spin.source==='initial'?'':'manual'}`);ball.type='button';ball.dataset.id=spin.id;ball.dataset.number=String(spin.number);ball.title=`${spin.number} · ${shortTime(spin.created_at)} · ${spin.source}`;
    append(ball,'span','',spin.number.toString().padStart(2,'0'));append(ball,'small','',shortTime(spin.created_at));ball.addEventListener('click',()=>details(spin));}
  grade.appendChild(fragment);
}
function details(spin){const el=$('spinDetails');el.replaceChildren();el.classList.remove('hidden');const left=append(el,'span','',`Resultado ${spin.number} · ${shortTime(spin.created_at)} · Origem: ${spin.source}`);
  if(state.user?.role==='admin'){
    const actions=append(el,'div','details-actions');const edit=append(actions,'button','secondary','Editar');edit.addEventListener('click',async()=>{
      const value=prompt('Novo número (0 a 36):',String(spin.number));if(value===null)return;const number=Number(value);if(!/^\d+$/.test(value.trim())||!Number.isInteger(number)||number<0||number>36)return note('Número inválido.',true);
      try{await api(`/api/admin/spins/${spin.id}`,'PATCH',{number});note('Resultado corrigido e auditado.');await refresh();}catch(err){note(err.message,true);}
    });const del=append(actions,'button','danger','Excluir');del.addEventListener('click',async()=>{
      if(!confirm(`Excluir definitivamente o resultado ${spin.number} (${shortTime(spin.created_at)})?`))return;
      try{await api(`/api/admin/spins/${spin.id}`,'DELETE',{});el.classList.add('hidden');note('Registro excluído e auditado.');await refresh();}catch(err){note(err.message,true);}
    });
  }
}
function renderFlags(){const box=$('flagsGrid');box.replaceChildren();for(const key of KEYS){const label=append(box,'label',`flag-option ${state.preferences?.flags?.[key]?'selected':''}`);const input=append(label,'input');input.type='checkbox';input.checked=!!state.preferences?.flags?.[key];append(label,'span','',TITLES[key]);input.addEventListener('change',async()=>{
    const flags={...(state.preferences?.flags||{}),[key]:input.checked};try{await saveTelegram({flags});note('Seleção atualizada. Os próximos sinais usarão essa configuração.');}catch(err){input.checked=!input.checked;note(err.message,true);}label.classList.toggle('selected',input.checked);
  });}}
function buildCards(){const area=$('analysisArea');area.replaceChildren();for(const key of KEYS){const card=append(area,'article','strategy-card');card.dataset.key=key;
    const header=append(card,'div','card-head');append(header,'strong','',TITLES[key]);const actions=append(header,'div','card-actions');const send=append(actions,'span','send-pill','');send.dataset.send=key;
    const collapse=append(actions,'button','','▾');collapse.title='Recolher ou expandir';collapse.addEventListener('click',e=>{e.stopPropagation();const body=card.querySelector('.card-body');body.classList.toggle('hidden');collapse.textContent=body.classList.contains('hidden')?'▸':'▾';});
    const dock=append(actions,'button','','↩');dock.title='Voltar ao painel';dock.addEventListener('click',e=>{e.stopPropagation();card.classList.remove('floating');card.style.left='';card.style.top='';card.style.width='';card.style.height='';sessionStorage.removeItem(`roleta_card_${key}`);});
    append(card,'div','card-body');makeDraggable(card,header,key);
    const saved=sessionStorage.getItem(`roleta_card_${key}`);if(saved){try{const {x,y,w,h}=JSON.parse(saved);moveCard(card,x,y,w,h);}catch{}}
  }state.cardsReady=true;
}
function moveCard(card,x,y,w,h){card.classList.add('floating');card.style.left=`${Math.max(0,Math.min(x,innerWidth-90))}px`;card.style.top=`${Math.max(5,Math.min(y,innerHeight-50))}px`;if(w)card.style.width=`${Math.min(w,innerWidth-10)}px`;if(h)card.style.height=`${Math.min(h,innerHeight-5)}px`;}
function makeDraggable(card,handle,key){let drag=null;handle.addEventListener('pointerdown',e=>{
  if(e.target.closest('button')||e.button!==0)return;
  const rect=card.getBoundingClientRect();moveCard(card,rect.left,rect.top,rect.width,rect.height);
  drag={dx:e.clientX-rect.left,dy:e.clientY-rect.top};handle.setPointerCapture(e.pointerId);e.preventDefault();
});handle.addEventListener('pointermove',e=>{if(!drag)return;moveCard(card,e.clientX-drag.dx,e.clientY-drag.dy);});
  const end=()=>{if(!drag)return;drag=null;const r=card.getBoundingClientRect();sessionStorage.setItem(`roleta_card_${key}`,JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height}));};
  handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}
$('resetCards').addEventListener('click',()=>{for(const key of KEYS)sessionStorage.removeItem(`roleta_card_${key}`);buildCards();renderCards();});
function renderCards(){if(!state.cardsReady)buildCards();for(const key of KEYS){const card=document.querySelector(`[data-key="${key}"]`);const body=card?.querySelector('.card-body');if(!body)continue;const data=state.analyses[key];card.querySelector('[data-send]').textContent=state.preferences?.sendEnabled&&state.preferences?.flags?.[key]?'● Telegram':'';
    const collapsed=body.classList.contains('hidden');body.replaceChildren();body.classList.toggle('hidden',collapsed);
    if(!data){append(body,'p','', 'Aguardando histórico da mesa.');continue;}
    const sequence=data.sequence.map(s=>data.type==='num'?String(s):symbol[s]||s).join(' → ');
    append(body,'div','sequence',sequence?`Padrão atual: ${sequence}`:'Aguardando sequência');
    const stats=append(body,'div','stats');const sample=append(stats,'div','statbox');append(sample,'b','',data.occurrences);append(sample,'span','','Ocorrências históricas');
    const pct=append(stats,'div','statbox');append(pct,'b','',`${data.percentage}%`);append(pct,'span','','Na amostra recente');
    const target=append(stats,'div','statbox');append(target,'b','',data.target===null?'—':symbol[data.target]||data.target);append(target,'span','','Categoria mais frequente');
    const dist=append(body,'div','distribution');for(const [cat,n]of Object.entries(data.counts||{}))append(dist,'span','dist-item',`${symbol[cat]||cat} ${n}`);
    const sampleRow=append(body,'div','sample');for(const item of data.sample||[])append(sampleRow,'span','',`${item.number} · ${shortTime(item.time)}`);
    if(!data.sample?.length)append(sampleRow,'span','', 'Nenhuma ocorrência disponível');
  }}
function renderLogs(){const signals=$('signalsList'),outbox=$('outboxList');signals.replaceChildren();outbox.replaceChildren();if(!state.signals.length)append(signals,'div','empty','Nenhum sinal registrado.');
  for(const item of state.signals){const box=append(signals,'div','log-item');const head=append(box,'strong','',`${TITLES[item.strategy_key]} · ${item.status.toUpperCase()} · ${shortTime(item.created_at)}`);append(box,'span','',`Alvo: ${symbol[item.target]||item.target} | Gale: ${item.attempts} / ${item.gale_limit}`);}
  if(!state.outbox.length)append(outbox,'div','empty','Nenhuma mensagem enviada ou pendente.');
  for(const item of state.outbox){const box=append(outbox,'div','log-item');append(box,'strong','',`${TITLES[item.strategy_key]} · ${item.status} · ${shortTime(item.created_at)}`);append(box,'span','',item.body);if(item.last_error)append(box,'small','error-text',item.last_error);}
}
function setTelegramForm(pref){$('telegramEnabled').checked=pref.sendEnabled;$('botToken').placeholder=pref.hasToken?'Token salvo com segurança; deixe vazio para manter':'Token não configurado';$('chatId').placeholder=pref.hasChat?'Chat ID salvo; deixe vazio para manter':'Chat ID não configurado';$('threadId').value=pref.threadId||'';$('galeLimit').value=pref.galeLimit;$('threshold').value=pref.threshold;}
async function refresh(){if(!state.token||state.busy||state.dialog)return;state.busy=true;try{const wasTable=state.preferences?.tableId;const data=await api('/api/state');state.user=data.user;state.preferences=data.preferences;state.table=data.table;state.spins=data.spins;state.analyses=data.analyses;state.signals=data.signals;state.outbox=data.outbox;state.totalStored=data.totalStored;
  const collector=data.collector;const pill=$('livePill');pill.className=`pill ${collector.online?'ok':'error'}`;pill.textContent=collector.online?'● Coleta conectada':`● ${collector.error?'Coleta indisponível':'Conectando'}`;pill.title=collector.error||'';$('lastSync').textContent=shortTime(collector.lastPoll);
  $('whoami').textContent=`${data.user.username} · ${data.user.role==='admin'?'Admin':'Usuário'}`;$('adminButton').classList.toggle('hidden',data.user.role!=='admin');
  if(wasTable!==data.preferences.tableId||(!$('tableSelect').value&&$('tableSelect').options.length<=1))await fetchTables();$('tableSelect').value=data.preferences.tableId||'';
  const count=data.preferences.displayLimit;$('countSelect').value=[50,100,200,500,1000,2000].includes(count)?String(count):'custom';$('customBox').classList.toggle('hidden',$('countSelect').value!=='custom');$('customCount').value=count;
  if(document.activeElement!==$('botToken')&&document.activeElement!==$('chatId')&&document.activeElement!==$('galeLimit')&&document.activeElement!==$('threshold'))setTelegramForm(data.preferences);
  renderGrid();renderCards();renderFlags();renderLogs();
}catch(e){if(state.token)note(e.message,true);}finally{state.busy=false;}}
function startRefresh(){clearInterval(state.refreshTimer);state.cardsReady=false;fetchTables().then(refresh).catch(e=>note(e.message,true));state.refreshTimer=setInterval(refresh,2500);}
async function savePref(body){const r=await api('/api/preferences','PATCH',body);state.preferences=r.preferences;await refresh();}
$('tableSelect').addEventListener('change',async e=>{e.target.disabled=true;try{await savePref({tableId:e.target.value});$('spinDetails').classList.add('hidden');note('Mesa alterada. Os sinais anteriores foram cancelados.');}catch(err){note(err.message,true);}finally{e.target.disabled=false;}});
$('countSelect').addEventListener('change',async e=>{if(e.target.value==='custom'){$('customBox').classList.remove('hidden');$('customCount').focus();return;}try{await savePref({displayLimit:Number(e.target.value)});}catch(err){note(err.message,true);}});
$('customCount').addEventListener('change',async e=>{const n=Number(e.target.value);if(!Number.isInteger(n)||n<1||n>2000)return note('Quantidade entre 1 e 2.000.',true);try{await savePref({displayLimit:n});}catch(err){note(err.message,true);}});
function telegramBody(changes={}){return {sendEnabled:$('telegramEnabled').checked,flags:{...(state.preferences?.flags||{})},botToken:$('botToken').value.trim(),chatId:$('chatId').value.trim(),threadId:$('threadId').value.trim(),galeLimit:$('galeLimit').value.trim(),threshold:Number($('threshold').value),...changes};}
async function saveTelegram(changes={}){const r=await api('/api/telegram','PATCH',telegramBody(changes));state.preferences=r.preferences;$('botToken').value='';$('chatId').value='';setTelegramForm(r.preferences);renderFlags();return r;}
$('telegramEnabled').addEventListener('change',async e=>{e.target.disabled=true;try{const result=await saveTelegram({sendEnabled:e.target.checked});note(result.message);await refresh();}catch(err){e.target.checked=!e.target.checked;note(err.message,true);}finally{e.target.disabled=false;}});
$('telegramForm').addEventListener('submit',async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const r=await saveTelegram();note('Configurações salvas. '+r.message);await refresh();}catch(err){note(err.message,true);}finally{btn.disabled=false;}});
$('verifyTelegram').addEventListener('click',async e=>{e.target.disabled=true;try{const r=await api('/api/telegram/verify','POST',{botToken:$('botToken').value.trim(),chatId:$('chatId').value.trim()});note(`Bot @${r.bot} · Sala ${r.chat}. O teste não enviou mensagens.`);}catch(err){note(err.message,true);}finally{e.target.disabled=false;}});
$('adminButton').addEventListener('click',async()=>{$('adminModal').classList.remove('hidden');state.dialog=true;await loadAdmin().catch(e=>note(e.message,true));});
$('closeAdmin').addEventListener('click',()=>{$('adminModal').classList.add('hidden');state.dialog=false;refresh();});
async function loadAdmin(){const [users,audit]=await Promise.all([api('/api/admin/users'),api('/api/admin/audit')]);const box=$('usersList');box.replaceChildren();for(const user of users){const row=append(box,'div','user-line');const info=append(row,'div');append(info,'strong','',user.username);append(info,'small','',user.role);const buttons=append(row,'div','buttons');
  const edit=append(buttons,'button','secondary','Editar');edit.addEventListener('click',async()=>{
    const username=prompt('Nome de usuário:',user.username);if(username===null)return;const role=prompt('Perfil: user ou admin',user.role);if(role===null)return;const password=prompt('Nova senha (deixe vazio para manter):','');if(password===null)return;
    try{await api(`/api/admin/users/${user.id}`,'PATCH',{username,role,...(password?{password}:{})});note('Conta atualizada.');await loadAdmin();}catch(err){note(err.message,true);}
  });const del=append(buttons,'button','danger','Excluir');del.disabled=user.id===state.user.id;del.addEventListener('click',async()=>{if(!confirm(`Excluir a conta ${user.username}?`))return;try{await api(`/api/admin/users/${user.id}`,'DELETE',{});note('Conta excluída.');await loadAdmin();}catch(err){note(err.message,true);}});
}
const auditBox=$('auditList');auditBox.replaceChildren();for(const item of audit){const x=append(auditBox,'div','log-item');append(x,'strong','',`${item.action} · ${shortTime(item.created_at)}`);append(x,'span','',JSON.stringify(item.detail));}
}
$('createUserForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/users','POST',{username:$('newUsername').value.trim(),password:$('newPassword').value,role:$('newRole').value});$('newUsername').value='';$('newPassword').value='';note('Conta criada.');await loadAdmin();}catch(err){note(err.message,true);}});
$('addSpinForm').addEventListener('submit',async e=>{e.preventDefault();if(!state.preferences?.tableId)return note('Escolha uma mesa.',true);try{await api('/api/admin/spins','POST',{tableId:state.preferences.tableId,number:Number($('manualNumber').value)});$('manualNumber').value='';note('Resultado manual registrado.');}catch(err){note(err.message,true);}});
if(state.token&&state.api){api('/api/me').then(user=>enter({user,token:state.token})).catch(()=>logout(false));}
