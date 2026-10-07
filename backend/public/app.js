const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let currentUser = null;
let catalogs = { farms: [], operators: [] };
const stopCodes = [
['01','Troca de material de corte'],['02','Aguardando peças'],['03','Transporte de máquinas / prancha'],['04','Falta de operador'],['05','Abastecimento e lubrificação'],['06','Manutenção corretiva'],['07','Manutenção preventiva'],['08','Treinamento e reciclagem'],['09','Mudança de eito / estaleiro / UP'],['10','Falta de frente de serviço'],['11','Lavagem do equipamento'],['12','Falta de combustível / lubrificante'],['13','Refeição e descanso'],['14','Reunião / DSS'],['15','Chuva / atolamento'],['16','Atraso na troca de turno'],['17','Auxílio a outro equipamento'],['18','Saúde / atestado'],['19','Feriado'],['20','Aguardando mecânico'],['21','IPU - inspeção'],['22','Limpeza (cabine e esteira)']];
const maintenanceCodes = new Set(['02','05','06','07','11','12','20','21','22']);

function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
function toast(msg,error=false){const t=$('#toast');t.textContent=msg;t.className=`toast show${error?' error':''}`;setTimeout(()=>t.className='toast',2600)}
async function api(url,opts={}){const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||'Erro na operação.');return j}
function showApp(user){currentUser=user;$('#authScreen').classList.add('hidden');$('#app').classList.remove('hidden');$('#currentUser').textContent=user.username;$('#currentRole').textContent=user.role;$$('.admin-only').forEach(x=>x.classList.toggle('hidden',user.role!=='admin'));loadCatalogs();}
function showAuth(){currentUser=null;$('#app').classList.add('hidden');$('#authScreen').classList.remove('hidden')}

async function boot(){
  addTripRow(); addStopRow(); setToday(); updateSummary();
  try{const me=await api('/api/me');showApp(me.user);await loadRecords();}catch{showAuth()}
  try{const s=await api('/api/setup/status');if(s.needsSetup){$('#authSubtitle').textContent='Primeiro acesso — crie o administrador';$('#loginForm button').textContent='Criar administrador';$('#loginForm').dataset.setup='1';}}catch{}
}
function setToday(){const el=$('[name="work_date"]');if(el&&!el.value){const d=new Date();const off=d.getTimezoneOffset();el.value=new Date(d.getTime()-off*60000).toISOString().slice(0,10)}}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#authError').textContent='';try{const payload={username:$('#loginUser').value,password:$('#loginPass').value};const j=await api(e.currentTarget.dataset.setup?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(payload)});showApp(j.user);e.currentTarget.dataset.setup='';$('#authSubtitle').textContent='Acesso ao sistema';$('#loginForm button').textContent='Entrar';await loadRecords();}catch(err){$('#authError').textContent=err.message}});
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'}).catch(()=>{});showAuth()};
$$('.tab').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='admin'&&currentUser?.role!=='admin')return;$$('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('main > section').forEach(x=>x.classList.add('hidden'));$(`#tab-${b.dataset.tab}`).classList.remove('hidden');if(b.dataset.tab==='records')loadRecords();if(b.dataset.tab==='admin')loadAdmin();});

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

let machineTimer;
$('#machineCode').addEventListener('input',()=>{clearTimeout(machineTimer);$('#machineDescription').value='';const q=$('#machineCode').value.trim();if(!q){$('#machineSuggest').classList.add('hidden');return}machineTimer=setTimeout(()=>searchMachines(q),120)});
$('#machineCode').addEventListener('blur',()=>setTimeout(()=>{const q=$('#machineCode').value.trim();if(q&&!$('#machineDescription').value)searchMachines(q,true)},120));
async function searchMachines(q,forceExact=false){try{const {machines}=await api(`/api/machines?q=${encodeURIComponent(q)}`);const box=$('#machineSuggest');box.innerHTML=machines.map(m=>`<div class="suggestion" data-code="${esc(m.code)}" data-desc="${esc(m.description)}"><strong>${esc(m.code)}</strong>${esc(m.description)}</div>`).join('');box.classList.toggle('hidden',!machines.length);box.querySelectorAll('.suggestion').forEach(x=>x.onclick=()=>selectMachine(x.dataset.code,x.dataset.desc));const exact=machines.find(m=>compact(m.code)===compact(q)||digits(m.code)===digits(q));if(exact)selectMachine(exact.code,exact.description,false);else if(forceExact)$('#machineDescription').value=''}catch{}}
function compact(v){return String(v).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function digits(v){const d=String(v).replace(/\D/g,'').replace(/^0+/,'');return d||'0'}
function selectMachine(code,desc,hide=true){$('#machineCode').value=code;$('#machineDescription').value=desc;if(hide)$('#machineSuggest').classList.add('hidden')}
document.addEventListener('click',e=>{if(!e.target.closest('.machine-field'))$('#machineSuggest').classList.add('hidden')});

async function loadCatalogs(){
  if(!currentUser)return;
  try{
    catalogs=await api('/api/catalogs');
    $('#farmList').innerHTML=(catalogs.farms||[]).map(v=>`<option value="${esc(v)}"></option>`).join('');
    $('#operatorList').innerHTML=(catalogs.operators||[]).map(o=>`<option value="${esc(o.name)}">${esc(o.employee_id||'')}</option>`).join('');
  }catch{}
}
$('[name="operator_name"]').addEventListener('change',()=>{const v=$('[name="operator_name"]').value.trim().toLowerCase();const o=(catalogs.operators||[]).find(x=>String(x.name).toLowerCase()===v);if(o&&o.employee_id)$('[name="employee_id"]').value=o.employee_id});

$('#bdtForm').addEventListener('reset',()=>setTimeout(()=>{$('#machineDescription').value='';$('#tripsBody').innerHTML='';$('#stopsBody').innerHTML='';addTripRow();addStopRow();setToday();updateSummary();},0));
$('#bdtForm').addEventListener('submit',async e=>{e.preventDefault();updateSummary();const f=new FormData(e.currentTarget),data=Object.fromEntries(f.entries());data.trips=rowsToData('#tripsBody');data.interventions=rowsToData('#stopsBody');try{const j=await api('/api/records',{method:'POST',body:JSON.stringify(data)});toast(`BDT #${j.record.id} salvo.`);e.currentTarget.reset();await Promise.all([loadRecords(),loadCatalogs()])}catch(err){toast(err.message,true)}});

async function loadRecords(){if(!currentUser)return;try{const {records}=await api('/api/records');$('#recordsBody').innerHTML=records.map(r=>`<tr><td>${r.id}</td><td>${esc(r.work_date)}</td><td>${esc(r.shift)}</td><td>${esc(r.farm)}</td><td>${esc(r.machine_code)}</td><td>${esc(r.machine_description)}</td><td>${esc(r.operator_name)}</td><td>${esc(r.total_trips)}</td><td>${esc(r.created_by_name||'')}</td><td><button class="btn secondary view-record" data-id="${r.id}">Ver</button>${currentUser.role==='admin'?` <button class="btn ghost danger delete-record" data-id="${r.id}">Excluir</button>`:''}</td></tr>`).join('')||'<tr><td colspan="10">Nenhum registro.</td></tr>';$$('.view-record').forEach(b=>b.onclick=()=>viewRecord(b.dataset.id));$$('.delete-record').forEach(b=>b.onclick=()=>deleteRecord(b.dataset.id));}catch(err){toast(err.message,true)}}
$('#refreshRecords').onclick=()=>{loadRecords();loadCatalogs()};
async function viewRecord(id){try{const {record}=await api(`/api/records/${id}`);$('#recordDetail').textContent=JSON.stringify(record,null,2);$('#recordDialog').showModal()}catch(err){toast(err.message,true)}}
async function deleteRecord(id){if(!confirm(`Excluir BDT #${id}?`))return;try{await api(`/api/records/${id}`,{method:'DELETE'});toast('Registro excluído.');await Promise.all([loadRecords(),loadCatalogs()])}catch(err){toast(err.message,true)}}
$('#closeDialog').onclick=()=>$('#recordDialog').close();

async function loadAdmin(){if(currentUser?.role!=='admin')return;try{const [{users},{machines}]=await Promise.all([api('/api/users'),api('/api/machines/all')]);$('#usersList').innerHTML=users.map(u=>`<div class="list-row"><strong>${esc(u.username)}</strong><select data-user-role="${u.id}"><option value="user" ${u.role==='user'?'selected':''}>User</option><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option></select><label><input type="checkbox" data-user-active="${u.id}" ${u.active?'checked':''}> Ativo</label><button class="btn secondary save-user" data-id="${u.id}">Salvar</button></div>`).join('');$$('.save-user').forEach(b=>b.onclick=()=>saveUser(b.dataset.id));$('#machinesList').innerHTML=machines.map(m=>`<div class="list-row machine-row"><strong>${esc(m.code)}</strong><span>${esc(m.description)}</span><button class="btn ghost danger del-machine" data-id="${m.id}">Desativar</button></div>`).join('');$$('.del-machine').forEach(b=>b.onclick=()=>delMachine(b.dataset.id));}catch(err){toast(err.message,true)}}
$('#userForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/users',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('Usuário criado.');loadAdmin()}catch(err){toast(err.message,true)}});
async function saveUser(id){const role=$(`[data-user-role="${id}"]`).value,active=$(`[data-user-active="${id}"]`).checked;try{await api(`/api/users/${id}`,{method:'PATCH',body:JSON.stringify({role,active})});toast('Usuário atualizado.');loadAdmin()}catch(err){toast(err.message,true)}}
$('#machineForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/machines',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('BT salvo.');await Promise.all([loadAdmin(),loadCatalogs()])}catch(err){toast(err.message,true)}});
async function delMachine(id){try{await api(`/api/machines/${id}`,{method:'DELETE'});toast('BT desativado.');loadAdmin()}catch(err){toast(err.message,true)}}

setInterval(updateSummary,1000);
boot();
