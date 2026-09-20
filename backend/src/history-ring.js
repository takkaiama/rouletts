// Núcleo puro do histórico circular: não depende do banco.
export const HISTORY_LIMIT=2000;
export function applySpin(history,spin){
  const evicted=history.rows.length>=HISTORY_LIMIT?history.rows.shift():null;
  history.rows.push({id:String(spin.id),number:spin.number,source:spin.source,created_at:spin.created_at});
  history.analyses=null;
  return evicted;
}
export function visibleHistory(history,limit){return history.rows.slice(-limit).reverse();}
export function updatesSince(history,afterId,clientEpoch,limit){
  const latest=history.rows.at(-1)?.id||'0';
  const after=String(afterId||'0');
  const replace=()=>({replace:true,spins:visibleHistory(history,limit),latest});
  if(String(clientEpoch)!==String(history.epoch)||after==='0'||!/^\d+$/.test(after))return replace();
  if(after===latest)return {replace:false,spins:[],latest};
  const idx=history.rows.findIndex(x=>x.id===after);
  if(idx<0)return replace();
  const newer=history.rows.slice(idx+1).reverse();
  return newer.length>limit?replace():{replace:false,spins:newer,latest};
}
