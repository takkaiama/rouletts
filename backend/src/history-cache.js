// Um cache por mesa. Leituras concluídas após invalidação nunca ressuscitam dados antigos.
import {pool} from './db.js';
import {analyze} from './strategies.js';
import {HISTORY_LIMIT} from './history-ring.js';
export {applySpin,visibleHistory,updatesSince,HISTORY_LIMIT} from './history-ring.js';
const histories=new Map();
const pending=new Map();
const generation=new Map();
let epoch=0;
// Compartilhado entre web service e worker: revisão no PostgreSQL invalida o cache
// mesmo quando as inserções ocorreram em outro processo ou outra instância.
export async function getHistory(tableId){
  while(true){
    const cached=histories.get(tableId);
    if(cached&&Date.now()-cached.checkedAt<750)return cached;
    const {rows:versions}=await pool.query('SELECT history_revision FROM tables WHERE id=$1',[tableId]);
    const revision=String(versions[0]?.history_revision||'0');
    const existing=histories.get(tableId);
    if(existing&&existing.revision===revision){existing.checkedAt=Date.now();return existing;}
    if(existing)invalidateHistory(tableId);
    const wanted=generation.get(tableId)||0;
    let current=pending.get(tableId);
    if(!current || current.generation!==wanted || current.revision!==revision){
      const promise=pool.query('SELECT id::text,number,source,created_at FROM spins WHERE table_id=$1 ORDER BY id DESC LIMIT $2',[tableId,HISTORY_LIMIT])
        .then(({rows})=>{
          const history={rows:rows.reverse(),epoch:++epoch,analyses:null,revision,checkedAt:Date.now()};
          if((generation.get(tableId)||0)===wanted) histories.set(tableId,history);
          return history;
        });
      current={generation:wanted,revision,promise};
      pending.set(tableId,current);
      promise.finally(()=>{if(pending.get(tableId)===current)pending.delete(tableId);}).catch(()=>{});
    }
    const loaded=await current.promise;
    if((generation.get(tableId)||0)===wanted)return histories.get(tableId)||loaded;
  }
}
export function invalidateHistory(tableId){
  generation.set(tableId,(generation.get(tableId)||0)+1);
  histories.delete(tableId);
}
export function getAnalyses(history){
  if(!history.analyses)history.analyses=analyze(history.rows);
  return history.analyses;
}
