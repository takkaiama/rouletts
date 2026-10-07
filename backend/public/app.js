const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let currentUser = null;
const stopCodes = [
['01','Troca de material de corte'],['02','Aguardando peças'],['03','Transporte de máquinas / prancha'],['04','Falta de operador'],['05','Abastecimento e lubrificação'],['06','Manutenção corretiva'],['07','Manutenção preventiva'],['08','Treinamento e reciclagem'],['09','Mudança de eito / estaleiro / UP'],['10','Falta de frente de serviço'],['11','Lavagem do equipamento'],['12','Falta de combustível / lubrificante'],['13','Refeição e descanso'],['14','Reunião / DSS'],['15','Chuva / atolamento'],['16','Atraso na troca de turno'],['17','Auxílio a outro equipamento'],['18','Saúde / atestado'],['19','Feriado'],['20','Aguardando mecânico'],['21','IPU - inspeção'],['22','Limpeza (cabine e esteira)']];

function toast(msg, error=false){const t=$('#toast');t.textContent=msg;t.className=`toast show${error?' error':''}`;setTimeout(()=>t.className='toast',2600)}
async function api(url, opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||'Erro na operação.');return j}
function showApp(user){currentUser=user;$('#authScreen').classList.add('hidden');$('#app').classList.remove('hidden');$('#currentUser').textContent=user.username;$('#currentRole').textContent=user.role;$$('.admin-only').forEach(x=>x.classList.toggle('hidden',user.role!=='admin'));}
function showAuth(){currentUser=null;$('#app').classList.add('hidden');$('#authScreen').classList.remove('hidden')}

async function boot(){
  $('#stopCodes').innerHTML=stopCodes.map(([c,d])=>`<div><strong>${c}</strong> ${d}</div>`).join('');
  addTripRow(); addStopRow();
  try{const me=await api('/api/me');showApp(me.user);await loadRecords();}catch{showAuth()}
  try{const s=await api('/api/setup/status');if(s.needsSetup){$('#authSubtitle').textContent='Primeiro acesso — crie o administrador';$('#loginForm button').textContent='Criar administrador';$('#loginForm').dataset.setup='1';}}catch{}
}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#authError').textContent='';try{const payload={username:$('#loginUser').value,password:$('#loginPass').value};const j=await api(e.currentTarget.dataset.setup?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(payload)});showApp(j.user);e.currentTarget.dataset.setup='';$('#authSubtitle').textContent='Acesso ao sistema';$('#loginForm button').textContent='Entrar';await loadRecords();}catch(err){$('#authError').textContent=err.message}});
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'}).catch(()=>{});showAuth()};

$$('.tab').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='admin'&&currentUser?.role!=='admin')return;$$('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('main > section').forEach(x=>x.classList.add('hidden'));$(`#tab-${b.dataset.tab}`).classList.remove('hidden');if(b.dataset.tab==='records')loadRecords();if(b.dataset.tab==='admin')loadAdmin();});

function addTripRow(){const n=$('#tripsBody').children.length+1;const tr=document.createElement('tr');tr.innerHTML=`<td class="trip-n">${String(n).padStart(2,'0')}</td><td><input data-k="origin"></td><td><input data-k="destination"></td><td><input data-k="start" type="time"></td><td><input data-k="end" type="time"></td><td><input data-k="cycle"></td><td><input data-k="stop_code"></td><td><button type="button" class="icon-btn">×</button></td>`;tr.querySelector('button').onclick=()=>{tr.remove();renumberTrips()};$('#tripsBody').appendChild(tr)}
function renumberTrips(){[...$('#tripsBody').children].forEach((tr,i)=>tr.querySelector('.trip-n').textContent=String(i+1).padStart(2,'0'))}
function addStopRow(){const tr=document.createElement('tr');tr.innerHTML=`<td><input data-k="code"></td><td><input data-k="start" type="time"></td><td><input data-k="end" type="time"></td><td><input data-k="reason"></td><td><input data-k="minutes"></td><td><button type="button" class="icon-btn">×</button></td>`;tr.querySelector('button').onclick=()=>tr.remove();$('#stopsBody').appendChild(tr)}
$('#addTrip').onclick=addTripRow;$('#addStop').onclick=addStopRow;
function rowsToData(sel){return [...$(sel).children].map(tr=>Object.fromEntries([...tr.querySelectorAll('input')].map(i=>[i.dataset.k,i.value.trim()]))).filter(o=>Object.values(o).some(Boolean))}

let machineTimer;
$('#machineCode').addEventListener('input',()=>{clearTimeout(machineTimer);$('#machineDescription').value='';const q=$('#machineCode').value.trim();if(!q){$('#machineSuggest').classList.add('hidden');return}machineTimer=setTimeout(()=>searchMachines(q),180)});
async function searchMachines(q){try{const {machines}=await api(`/api/machines?q=${encodeURIComponent(q)}`);const box=$('#machineSuggest');box.innerHTML=machines.map(m=>`<div class="suggestion" data-code="${esc(m.code)}" data-desc="${esc(m.description)}"><strong>${esc(m.code)}</strong>${esc(m.description)}</div>`).join('');box.classList.toggle('hidden',!machines.length);box.querySelectorAll('.suggestion').forEach(x=>x.onclick=()=>{selectMachine(x.dataset.code,x.dataset.desc)});const exact=machines.find(m=>compact(m.code)===compact(q));if(exact)selectMachine(exact.code,exact.description,false)}catch{}}
function compact(v){return String(v).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function selectMachine(code,desc,hide=true){$('#machineCode').value=code;$('#machineDescription').value=desc;if(hide)$('#machineSuggest').classList.add('hidden')}
document.addEventListener('click',e=>{if(!e.target.closest('.machine-field'))$('#machineSuggest').classList.add('hidden')});

$('#bdtForm').addEventListener('reset',()=>setTimeout(()=>{$('#machineDescription').value='';$('#tripsBody').innerHTML='';$('#stopsBody').innerHTML='';addTripRow();addStopRow();},0));
$('#bdtForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const data=Object.fromEntries(f.entries());data.trips=rowsToData('#tripsBody');data.interventions=rowsToData('#stopsBody');try{const j=await api('/api/records',{method:'POST',body:JSON.stringify(data)});toast(`BDT #${j.record.id} salvo.`);e.currentTarget.reset();await loadRecords();}catch(err){toast(err.message,true)}});

async function loadRecords(){if(!currentUser)return;try{const {records}=await api('/api/records');$('#recordsBody').innerHTML=records.map(r=>`<tr><td>${r.id}</td><td>${esc(r.work_date)}</td><td>${esc(r.shift)}</td><td>${esc(r.farm)}</td><td>${esc(r.machine_code)}</td><td>${esc(r.machine_description)}</td><td>${esc(r.operator_name)}</td><td>${esc(r.total_trips)}</td><td>${esc(r.created_by_name||'')}</td><td><button class="btn secondary view-record" data-id="${r.id}">Ver</button>${currentUser.role==='admin'?` <button class="btn ghost danger delete-record" data-id="${r.id}">Excluir</button>`:''}</td></tr>`).join('')||'<tr><td colspan="10">Nenhum registro.</td></tr>';$$('.view-record').forEach(b=>b.onclick=()=>viewRecord(b.dataset.id));$$('.delete-record').forEach(b=>b.onclick=()=>deleteRecord(b.dataset.id));}catch(err){toast(err.message,true)}}
$('#refreshRecords').onclick=loadRecords;
async function viewRecord(id){try{const {record}=await api(`/api/records/${id}`);$('#recordDetail').textContent=JSON.stringify(record,null,2);$('#recordDialog').showModal()}catch(err){toast(err.message,true)}}
async function deleteRecord(id){if(!confirm(`Excluir BDT #${id}?`))return;try{await api(`/api/records/${id}`,{method:'DELETE'});toast('Registro excluído.');loadRecords()}catch(err){toast(err.message,true)}}
$('#closeDialog').onclick=()=>$('#recordDialog').close();

async function loadAdmin(){if(currentUser?.role!=='admin')return;try{const [{users},{machines}]=await Promise.all([api('/api/users'),api('/api/machines/all')]);$('#usersList').innerHTML=users.map(u=>`<div class="list-row"><strong>${esc(u.username)}</strong><select data-user-role="${u.id}"><option value="user" ${u.role==='user'?'selected':''}>User</option><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option></select><label><input type="checkbox" data-user-active="${u.id}" ${u.active?'checked':''}> Ativo</label><button class="btn secondary save-user" data-id="${u.id}">Salvar</button></div>`).join('');$$('.save-user').forEach(b=>b.onclick=()=>saveUser(b.dataset.id));$('#machinesList').innerHTML=machines.map(m=>`<div class="list-row machine-row"><strong>${esc(m.code)}</strong><span>${esc(m.description)}</span><button class="btn ghost danger del-machine" data-id="${m.id}">Desativar</button></div>`).join('');$$('.del-machine').forEach(b=>b.onclick=()=>delMachine(b.dataset.id));}catch(err){toast(err.message,true)}}
$('#userForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/users',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('Usuário criado.');loadAdmin()}catch(err){toast(err.message,true)}});
async function saveUser(id){const role=$(`[data-user-role="${id}"]`).value,active=$(`[data-user-active="${id}"]`).checked;try{await api(`/api/users/${id}`,{method:'PATCH',body:JSON.stringify({role,active})});toast('Usuário atualizado.');loadAdmin()}catch(err){toast(err.message,true)}}
$('#machineForm').addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/machines',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('BT salvo.');loadAdmin()}catch(err){toast(err.message,true)}});
async function delMachine(id){try{await api(`/api/machines/${id}`,{method:'DELETE'});toast('BT desativado.');loadAdmin()}catch(err){toast(err.message,true)}}
function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
boot();
