const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const APP_VERSION = '1.5.0';
const OFFLINE_USER_KEY = 'biotec_bdt_offline_user_v1';
const CATALOG_KEY = 'biotec_bdt_catalogs_v1';
const RECORDS_KEY_PREFIX = 'biotec_bdt_records_v1_';
let currentUser = null;
let catalogs = { farms: [], operators: [], machines: [] };
let syncing = false;
const stopCodes = [
['01','Troca de material de corte'],['02','Aguardando peças'],['03','Transporte de máquinas / prancha'],['04','Falta de operador'],['05','Abastecimento e lubrificação'],['06','Manutenção corretiva'],['07','Manutenção preventiva'],['08','Treinamento e reciclagem'],['09','Mudança de eito / estaleiro / UP'],['10','Falta de frente de serviço'],['11','Lavagem do equipamento'],['12','Falta de combustível / lubrificante'],['13','Refeição e descanso'],['14','Reunião / DSS'],['15','Chuva / atolamento'],['16','Atraso na troca de turno'],['17','Auxílio a outro equipamento'],['18','Saúde / atestado'],['19','Feriado'],['20','Aguardando mecânico'],['21','IPU - inspeção'],['22','Limpeza (cabine e esteira)']];
const maintenanceCodes = new Set(['02','05','06','07','11','12','20','21','22']);

function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
function toast(msg,error=false){const t=$('#toast');t.textContent=msg;t.className=`toast show${error?' error':''}`;setTimeout(()=>t.className='toast',3000)}
async function api(url,opts={}){
  let r;
  try{r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts})}
  catch{const err=new Error('Sem conexão com o servidor.');err.network=true;throw err}
  let j={};try{j=await r.json()}catch{}
  if(!r.ok){const err=new Error(j.error||'Erro na operação.');err.status=r.status;throw err}
  return j
}
function cachedUser(){try{return JSON.parse(localStorage.getItem(OFFLINE_USER_KEY)||'null')}catch{return null}}
function cacheUser(user){localStorage.setItem(OFFLINE_USER_KEY,JSON.stringify(user))}
function recordsCacheKey(){return RECORDS_KEY_PREFIX+(currentUser?.id||'anon')}
function setConnectivity(){const el=$('#connectivity');if(!el)return;const online=navigator.onLine;el.textContent=online?'ONLINE':'OFFLINE';el.classList.toggle('offline',!online);updatePendingBadge()}
function showApp(user,{offline=false}={}){currentUser=user;cacheUser(user);$('#authScreen').classList.add('hidden');$('#app').classList.remove('hidden');$('#currentUser').textContent=user.username;$('#currentRole').textContent=user.role;$$('.admin-only').forEach(x=>x.classList.toggle('hidden',user.role!=='admin'));setConnectivity();loadCatalogs();if(offline)toast('Modo offline: dados serão sincronizados quando a internet voltar.')}
function showAuth({clearCached=false}={}){currentUser=null;if(clearCached)localStorage.removeItem(OFFLINE_USER_KEY);$('#app').classList.add('hidden');$('#authScreen').classList.remove('hidden')}
function openOfflineDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open('biotec-bdt-offline',1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('queue')){const st=db.createObjectStore('queue',{keyPath:'client_uuid'});st.createIndex('user_id','user_id',{unique:false});st.createIndex('status','status',{unique:false})}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function queuePut(item){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction('queue','readwrite');tx.objectStore('queue').put(item);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function queueDelete(id){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction('queue','readwrite');tx.objectStore('queue').delete(id);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function queueAll(){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction('queue','readonly');const req=tx.objectStore('queue').getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close()})}
async function queueGet(id){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction('queue','readonly');const req=tx.objectStore('queue').get(id);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close()})}
async function pendingForUser(){const all=await queueAll();return all.filter(x=>String(x.user_id)===String(currentUser?.id))}
async function updatePendingBadge(){const el=$('#pendingCount');if(!el||!currentUser)return;try{const q=await pendingForUser();el.textContent=q.length?`${q.length} pendente${q.length>1?'s':''}`:'0 pendentes';el.classList.toggle('has-pending',q.length>0)}catch{}}
async function saveOfflineRecord(data){const client_uuid=data.client_uuid||crypto.randomUUID();data.client_uuid=client_uuid;await queuePut({client_uuid,user_id:currentUser.id,username:currentUser.username,status:'PENDENTE',created_at:new Date().toISOString(),data});await updatePendingBadge();return client_uuid}
async function syncPending(){if(syncing||!navigator.onLine||!currentUser)return;syncing=true;try{const items=await pendingForUser();for(const item of items){try{item.status='ENVIANDO';item.last_error='';await queuePut(item);await updatePendingBadge();await api('/api/records',{method:'POST',body:JSON.stringify(item.data)});await queueDelete(item.client_uuid)}catch(err){item.status=err.network?'PENDENTE':'ERRO';item.last_error=err.message;await queuePut(item);if(err.status===401){toast('Sessão expirada. Entre novamente para sincronizar.',true);break}if(err.network)break}}}finally{syncing=false;await updatePendingBadge()}}

async function boot(){
  addTripRow(); addStopRow(); setToday(); updateSummary(); setConnectivity();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
  try{const me=await api('/api/me');showApp(me.user);await loadRecords();await syncPending()}catch(err){const u=cachedUser();if(u&&(!navigator.onLine||err.network)){showApp(u,{offline:true});await loadRecords()}else showAuth()}
  if(navigator.onLine){try{const setup=await api('/api/setup/status');if(setup.needsSetup){$('#authSubtitle').textContent='Primeiro acesso — crie o administrador';$('#loginForm button').textContent='Criar administrador';$('#loginForm').dataset.setup='1'}}catch{}}
}

function setToday(){const el=$('[name="work_date"]');if(el&&!el.value){const d=new Date();const off=d.getTimezoneOffset();el.value=new Date(d.getTime()-off*60000).toISOString().slice(0,10)}}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#authError').textContent='';if(!navigator.onLine){$('#authError').textContent='O primeiro login deste dispositivo precisa ser feito com internet.';return}try{const payload={username:$('#loginUser').value,password:$('#loginPass').value};const j=await api(e.currentTarget.dataset.setup?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(payload)});showApp(j.user);e.currentTarget.dataset.setup='';$('#authSubtitle').textContent='Acesso ao sistema';$('#loginForm button').textContent='Entrar';await loadRecords();await syncPending()}catch(err){$('#authError').textContent=err.message}});
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'}).catch(()=>{});showAuth({clearCached:true})};
$$('.tab').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='admin'&&currentUser?.role!=='admin')return;if(b.dataset.tab==='admin'&&!navigator.onLine){toast('Administração requer conexão com a internet.',true);return}$$('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('main > section').forEach(x=>x.classList.add('hidden'));$(`#tab-${b.dataset.tab}`).classList.remove('hidden');if(b.dataset.tab==='records')loadRecords();if(b.dataset.tab==='admin')loadAdmin()});

function stopOptions(){return `<option value="">—</option>${stopCodes.map(([c,d])=>`<option value="${c}">${c} - ${esc(d)}</option>`).join('')}`}
function addTripRow(){
  const n=$('#tripsBody').children.length+1,tr=document.createElement('tr');
  tr.innerHTML=`<td class="trip-n">${String(n).padStart(2,'0')}</td><td><input data-k="origin"></td><td><input data-k="destination"></td><td><input data-k="start" type="time"></td><td><input data-k="end" type="time"></td><td><input data-k="cycle" readonly></td><td><select data-k="stop_code">${stopOptions()}</select></td><td><button type="button" class="icon-btn">×</button></td>`;
  tr.querySelector('button').onclick=()=>{tr.remove();renumberTrips();updateSummary()};
  tr.querySelectorAll('input,select').forEach(el=>['input','change','blur'].forEach(ev=>el.addEventListener(ev,()=>{updateTripCycle(tr);updateSummary()})));
  $('#tripsBody').appendChild(tr);
}
function renumberTrips(){[...$('#tripsBody').children].forEach((tr,i)=>tr.querySelector('.trip-n').textContent=String(i+1).padStart(2,'0'))}
function addStopRow(){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><select data-k="code">${stopOptions()}</select></td><td><input data-k="start" type="time"></td><td><input data-k="end" type="time"></td><td><input data-k="reason"></td><td><input data-k="minutes" readonly></td><td><button type="button" class="icon-btn">×</button></td>`;
  tr.querySelector('button').onclick=()=>{tr.remove();updateSummary()};
  tr.querySelectorAll('input,select').forEach(el=>['input','change','blur'].forEach(ev=>el.addEventListener(ev,()=>{updateStopMinutes(tr);updateSummary()})));
  $('#stopsBody').appendChild(tr);
}
$('#addTrip').onclick=()=>{addTripRow();updateSummary()};
$('#addStop').onclick=()=>{addStopRow();updateSummary()};
function rowsToData(sel){return [...$(sel).children].map(tr=>Object.fromEntries([...tr.querySelectorAll('input,select')].map(i=>[i.dataset.k,i.value.trim()]))).filter(o=>Object.entries(o).some(([k,v])=>k!=='cycle'&&k!=='minutes'&&v))}

function parseNum(v){const x=String(v??'').trim().replace(/\s/g,'').replace(',','.');if(!x)return null;const n=Number(x);return Number.isFinite(n)?n:null}
function minutesBetween(start,end){if(!start||!end)return null;const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);if([sh,sm,eh,em].some(Number.isNaN))return null;let a=sh*60+sm,b=eh*60+em;if(b<a)b+=1440;return b-a}
function fmtHoursFromMinutes(min){if(min==null||!Number.isFinite(min))return '';return (min/60).toFixed(2).replace('.',',')}
function fmtDecimal(n){return n==null||!Number.isFinite(n)?'':Number(n.toFixed(2)).toString().replace('.',',')}
function updateTripCycle(tr){const m=minutesBetween(tr.querySelector('[data-k="start"]').value,tr.querySelector('[data-k="end"]').value);tr.querySelector('[data-k="cycle"]').value=m==null?'':String(m)}
function updateStopMinutes(tr){const m=minutesBetween(tr.querySelector('[data-k="start"]').value,tr.querySelector('[data-k="end"]').value);tr.querySelector('[data-k="minutes"]').value=m==null?'':String(m)}
function updateSummary(){
  const hi=parseNum($('[name="hourmeter_initial"]')?.value),hf=parseNum($('[name="hourmeter_final"]')?.value);
  const hh=hi!=null&&hf!=null&&hf>=hi?hf-hi:null;
  $('[name="hourmeter_hours"]').value=fmtDecimal(hh);
  $('[name="operated_hours"]').value=fmtDecimal(hh);

  const sm=minutesBetween($('[name="shift_start"]')?.value,$('[name="shift_end"]')?.value);
  $('[name="shift_hours"]').value=fmtHoursFromMinutes(sm);

  const trips=[...$('#tripsBody').children].filter(tr=>[...tr.querySelectorAll('input,select')].some(el=>!['cycle','stop_code'].includes(el.dataset.k)&&el.value.trim()));
  $('[name="total_trips"]').value=String(trips.length);

  let totalStop=0,maintenance=0,operational=0;
  [...$('#stopsBody').children].forEach(tr=>{
    updateStopMinutes(tr);
    const code=tr.querySelector('[data-k="code"]').value;
    const mins=parseNum(tr.querySelector('[data-k="minutes"]').value)||0;
    if(code){totalStop+=mins;if(maintenanceCodes.has(code))maintenance+=mins;else operational+=mins}
  });
  const unproductive = sm!=null&&hh!=null ? Math.max(sm/60-hh,0) : totalStop/60;
  $('[name="unproductive_hours"]').value=fmtDecimal(unproductive);
  $('[name="operational_stops"]').value=fmtHoursFromMinutes(operational);
  $('[name="maintenance_stops"]').value=fmtHoursFromMinutes(maintenance);
}
['hourmeter_initial','hourmeter_final','shift_start','shift_end'].forEach(n=>{const el=$(`[name="${n}"]`);if(el)['input','change','keyup','blur'].forEach(ev=>el.addEventListener(ev,updateSummary))});

function populateMachineSelect(machines=[]){
  const sel=$('#machineCode');
  if(!sel)return;
  const current=sel.value;
  sel.innerHTML='<option value="">Selecione o BT</option>'+machines.map(m=>`<option value="${esc(m.code)}" data-desc="${esc(m.description)}">${esc(m.code)} — ${esc(m.description)}</option>`).join('');
  if([...sel.options].some(o=>o.value===current)) sel.value=current;
  updateMachineDescription();
}
function updateMachineDescription(){
  const sel=$('#machineCode');
  const opt=sel?.selectedOptions?.[0];
  $('#machineDescription').value=opt?.dataset?.desc||'';
}
$('#machineCode').addEventListener('change',updateMachineDescription);

async function loadCatalogs(){
  if(!currentUser)return;
  try{if(!navigator.onLine)throw Object.assign(new Error('offline'),{network:true});catalogs=await api('/api/catalogs');localStorage.setItem(CATALOG_KEY,JSON.stringify(catalogs))}
  catch(err){try{catalogs=JSON.parse(localStorage.getItem(CATALOG_KEY)||'null')||catalogs}catch{}if(!catalogs.farms?.length&&!catalogs.machines?.length&&err.status)toast(err.message,true)}
  const farm=$('#farmSelect'),currentFarm=farm.value;farm.innerHTML='<option value="">Selecione a fazenda</option>'+(catalogs.farms||[]).map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if([...farm.options].some(o=>o.value===currentFarm))farm.value=currentFarm;$('#operatorList').innerHTML=(catalogs.operators||[]).map(o=>`<option value="${esc(o.name)}">${esc(o.employee_id||'')}</option>`).join('');populateMachineSelect(catalogs.machines||[])
}
$('[name="operator_name"]').addEventListener('change',()=>{const v=$('[name="operator_name"]').value.trim().toLowerCase();const o=(catalogs.operators||[]).find(x=>String(x.name).toLowerCase()===v);if(o&&o.employee_id)$('[name="employee_id"]').value=o.employee_id});

$('#bdtForm').addEventListener('reset',()=>setTimeout(()=>{$('#machineDescription').value='';$('#tripsBody').innerHTML='';$('#stopsBody').innerHTML='';addTripRow();addStopRow();setToday();updateSummary();},0));
$('#bdtForm').addEventListener('submit',async e=>{e.preventDefault();updateSummary();const f=new FormData(e.currentTarget),data=Object.fromEntries(f.entries());data.trips=rowsToData('#tripsBody');data.interventions=rowsToData('#stopsBody');data.client_uuid=crypto.randomUUID();try{if(!navigator.onLine)throw Object.assign(new Error('offline'),{network:true});const j=await api('/api/records',{method:'POST',body:JSON.stringify(data)});toast(`BDT #${j.record.id} salvo.`);e.currentTarget.reset();await Promise.all([loadRecords(),loadCatalogs()])}catch(err){if(err.network){await saveOfflineRecord(data);toast('BDT salvo offline. Sincronização automática pendente.');e.currentTarget.reset();await loadRecords()}else toast(err.message,true)}});

async function loadRecords(){
  if(!currentUser)return;let records=[];
  try{if(!navigator.onLine)throw Object.assign(new Error('offline'),{network:true});const j=await api('/api/records');records=j.records||[];localStorage.setItem(recordsCacheKey(),JSON.stringify(records))}
  catch(err){try{records=JSON.parse(localStorage.getItem(recordsCacheKey())||'[]')}catch{records=[]}if(!err.network&&err.status)toast(err.message,true)}
  const pending=await pendingForUser().catch(()=>[]);
  const pendingRows=pending.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).map(q=>{const r=q.data,status=q.status==='ERRO'?`ERRO: ${esc(q.last_error||'')}`:q.status;return `<tr class="pending-row"><td>LOCAL</td><td>${esc(r.work_date)}</td><td>${esc(r.shift)}</td><td>${esc(r.farm)}</td><td>${esc(r.machine_code)}</td><td>${esc(r.machine_description)}</td><td>${esc(r.operator_name)}</td><td>${esc(r.total_trips)}</td><td>${esc(q.username)}</td><td><span class="sync-state">${status}</span> <button class="btn secondary view-local" data-id="${esc(q.client_uuid)}">Ver</button></td></tr>`}).join('');
  const serverRows=records.map(r=>`<tr><td>${r.id}</td><td>${esc(r.work_date)}</td><td>${esc(r.shift)}</td><td>${esc(r.farm)}</td><td>${esc(r.machine_code)}</td><td>${esc(r.machine_description)}</td><td>${esc(r.operator_name)}</td><td>${esc(r.total_trips)}</td><td>${esc(r.created_by_name||'')}</td><td><button class="btn secondary view-record" data-id="${r.id}">Ver</button>${currentUser.role==='admin'&&navigator.onLine?` <button class="btn ghost danger delete-record" data-id="${r.id}">Excluir</button>`:''}</td></tr>`).join('');
  $('#recordsBody').innerHTML=pendingRows+serverRows||'<tr><td colspan="10">Nenhum registro.</td></tr>';$$('.view-record').forEach(b=>b.onclick=()=>viewRecord(b.dataset.id));$$('.view-local').forEach(b=>b.onclick=()=>viewLocalRecord(b.dataset.id));$$('.delete-record').forEach(b=>b.onclick=()=>deleteRecord(b.dataset.id));await updatePendingBadge()
}
async function viewLocalRecord(id){const item=await queueGet(id);if(!item)return toast('Registro offline não encontrado.',true);$('#recordDetail').textContent=JSON.stringify({...item.data,_sincronizacao:item.status,_erro:item.last_error||null},null,2);$('#recordDialog').showModal()}
window.addEventListener('online',async()=>{setConnectivity();toast('Internet restabelecida. Sincronizando...');await syncPending();await Promise.all([loadRecords(),loadCatalogs()])});
window.addEventListener('offline',()=>{setConnectivity();toast('Sem internet. O BDT continuará funcionando offline.')});
setInterval(()=>{if(navigator.onLine&&currentUser)syncPending()},30000);
$('#refreshRecords').onclick=()=>{loadRecords();loadCatalogs()};
async function viewRecord(id){try{const {record}=await api(`/api/records/${id}`);$('#recordDetail').textContent=JSON.stringify(record,null,2);$('#recordDialog').showModal()}catch(err){toast(err.message,true)}}
async function deleteRecord(id){if(!confirm(`Excluir BDT #${id}?`))return;try{await api(`/api/records/${id}`,{method:'DELETE'});toast('Registro excluído.');await Promise.all([loadRecords(),loadCatalogs()])}catch(err){toast(err.message,true)}}
$('#closeDialog').onclick=()=>$('#recordDialog').close();

async function loadAdmin(){
  if(currentUser?.role!=='admin')return;
  if(!navigator.onLine){toast('Administração requer conexão com a internet.',true);return;}
  try{
    const [{users},{machines},{farms}]=await Promise.all([api('/api/users'),api('/api/machines/all'),api('/api/farms/all')]);
    $('#usersList').innerHTML=users.map(u=>`<div class="list-row"><strong>${esc(u.username)}</strong><select data-user-role="${u.id}"><option value="user" ${u.role==='user'?'selected':''}>User</option><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option></select><label><input type="checkbox" data-user-active="${u.id}" ${u.active?'checked':''}> Ativo</label><button class="btn secondary save-user" data-id="${u.id}">Salvar</button></div>`).join('');
    $$('.save-user').forEach(b=>b.onclick=()=>saveUser(b.dataset.id));

    $('#machinesList').innerHTML=machines.map(m=>`<div class="catalog-row ${m.active?'':'inactive'}"><input data-machine-code="${m.id}" value="${esc(m.code)}"><input data-machine-desc="${m.id}" value="${esc(m.description)}"><label class="active-check"><input type="checkbox" data-machine-active="${m.id}" ${m.active?'checked':''}> Ativo</label><button class="btn secondary save-machine" data-id="${m.id}">Salvar</button><button class="btn ghost danger delete-machine" data-id="${m.id}">Excluir</button></div>`).join('');
    $$('.save-machine').forEach(b=>b.onclick=()=>saveMachine(b.dataset.id));
    $$('.delete-machine').forEach(b=>b.onclick=()=>deleteMachine(b.dataset.id));

    $('#farmsList').innerHTML=farms.map(f=>`<div class="catalog-row farm-row ${f.active?'':'inactive'}"><input data-farm-name="${f.id}" value="${esc(f.name)}"><label class="active-check"><input type="checkbox" data-farm-active="${f.id}" ${f.active?'checked':''}> Ativa</label><button class="btn secondary save-farm" data-id="${f.id}">Salvar</button><button class="btn ghost danger delete-farm" data-id="${f.id}">Excluir</button></div>`).join('');
    $$('.save-farm').forEach(b=>b.onclick=()=>saveFarm(b.dataset.id));
    $$('.delete-farm').forEach(b=>b.onclick=()=>deleteFarm(b.dataset.id));
  }catch(err){toast(err.message,true)}
}
$('#userForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/users',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('Usuário criado.');loadAdmin()}catch(err){toast(err.message,true)}});
async function saveUser(id){const role=$(`[data-user-role="${id}"]`).value,active=$(`[data-user-active="${id}"]`).checked;try{await api(`/api/users/${id}`,{method:'PATCH',body:JSON.stringify({role,active})});toast('Usuário atualizado.');loadAdmin()}catch(err){toast(err.message,true)}}

$('#machineForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/machines',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('BT adicionado.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}});
async function saveMachine(id){
  const code=$(`[data-machine-code="${id}"]`).value;
  const description=$(`[data-machine-desc="${id}"]`).value;
  const active=$(`[data-machine-active="${id}"]`).checked;
  try{await api(`/api/machines/${id}`,{method:'PATCH',body:JSON.stringify({code,description,active})});toast(active?'BT atualizado.':'BT desativado e removido da lista.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}
}
async function deleteMachine(id){
  if(!confirm('Excluir este BT do cadastro? Os BDTs já salvos não serão apagados.'))return;
  try{await api(`/api/machines/${id}`,{method:'DELETE'});toast('BT excluído do cadastro.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}
}

$('#farmForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/farms',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('Fazenda adicionada.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}});
async function saveFarm(id){
  const name=$(`[data-farm-name="${id}"]`).value;
  const active=$(`[data-farm-active="${id}"]`).checked;
  try{await api(`/api/farms/${id}`,{method:'PATCH',body:JSON.stringify({name,active})});toast(active?'Fazenda atualizada.':'Fazenda desativada e removida da lista.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}
}
async function deleteFarm(id){
  if(!confirm('Excluir esta fazenda do cadastro? Os BDTs já salvos não serão apagados.'))return;
  try{await api(`/api/farms/${id}`,{method:'DELETE'});toast('Fazenda excluída do cadastro.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}
}

setInterval(updateSummary,1000);
boot();
