import test from 'node:test';
import assert from 'node:assert/strict';
import {applySpin,updatesSince,HISTORY_LIMIT,visibleHistory} from '../src/history-ring.js';
const h=(num)=>({rows:Array.from({length:num},(_,i)=>({id:String(i+1),number:(i+1)%37,source:'api'})),epoch:8,analyses:null});
test('anel de 2000 retém exatamente os mais recentes, inclusive valores repetidos',()=>{
 const history=h(HISTORY_LIMIT);const evicted=applySpin(history,{id:'2001',number:3,source:'api'});
 assert.equal(evicted.id,'1');assert.equal(history.rows.length,2000);
 assert.equal(history.rows.at(-1).id,'2001');assert.equal(history.rows[0].id,'2');
 assert.equal(visibleHistory(history,2)[0].id,'2001');
});
test('cliente recebe apenas resultados novos ou substituição quando houve edição',()=>{
 const history=h(20);
 assert.deepEqual(updatesSince(history,'20',8,10),{replace:false,spins:[],latest:'20'});
 applySpin(history,{id:'21',number:20,source:'api'});
 assert.deepEqual(updatesSince(history,'20',8,10).spins.map(s=>s.id),['21']);
 assert.equal(updatesSince(history,'21',9,10).replace,true);
 assert.equal(updatesSince(history,'1',8,10).replace,true);
});
