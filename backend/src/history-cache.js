// Cache compartilhado por mesa: a grade não relê os 2000 resultados a cada atualização.
import {pool} from './db.js';
import {analyze} from './strategies.js';
import {HISTORY_LIMIT} from './history-ring.js';
export {applySpin,visibleHistory,updatesSince,HISTORY_LIMIT} from './history-ring.js';
const histories=new Map();
const pending=new Map();
const generation=new Map();
let epoch=0;
export async function getHistory(tableId){
  if(histories.has(tableId))return histories.get(tableId);
  if(pending.has(tableId))return pending.get(tableId);
  const generationAtStart=generation.get(tableId)||0;
  const promise=(async()=>{
    const {rows}=await pool.query('SELECT id::text,number,source,created_at FROM spins WHERE table_id=$1 ORDER BY id DESC LIMIT $2',[tableId,HISTORY_LIMIT]);
    const history={rows:rows.reverse(),epoch:++epoch,analyses:null};
    if((generation.get(tableId)||0)===generationAtStart)histories.set(tableId,history);
    return history;
  })();
  pending.set(tableId,promise);
  try{return await promise;}finally{if(pending.get(tableId)===promise)pending.delete(tableId);}
}
export function invalidateHistory(tableId){
  generation.set(tableId,(generation.get(tableId)||0)+1);
  histories.delete(tableId);
}
export function getAnalyses(history){
  if(!history.analyses)history.analyses=analyze(history.rows);
  return history.analyses;
}
