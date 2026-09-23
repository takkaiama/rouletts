import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyze,inferNewNumbers,matches} from '../src/strategies.js';
const collector=readFileSync(new URL('../src/collector.js',import.meta.url),'utf8');
const db=readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const historyCache=readFileSync(new URL('../src/history-cache.js',import.meta.url),'utf8');

test('duas roletas recebem listas independentes sem descartar números consecutivos iguais',()=>{
 const a=inferNewNumbers([7,4,1,32,0],[7,7,4,1,32]);
 const b=inferNewNumbers([4,1,22,9,3],[0,4,1,22,9]);
 assert.deepEqual(a,{numbers:[7],gap:false});
 assert.deepEqual(b,{numbers:[0],gap:false});
});
test('recupera vários giros da janela de 5 na ordem cronológica',()=>{
 const result=inferNewNumbers([10,9,8,7,6],[13,12,11,10,9]);
 assert.deepEqual(result,{numbers:[11,12,13],gap:false});
});
test('ausência de sobreposição é sinalizada como lacuna sem inventar números',()=>{
 assert.deepEqual(inferNewNumbers([10,9,8,7,6],[1,2,3,4,5]),{numbers:[1],gap:true});
 const history=[{number:7,source:'api'},{number:1,source:'gap'},{number:2,source:'api'}];
 assert.equal(analyze(history).n3.gapLimited,true); // não atravessar a lacuna na sequência atual
 assert.equal(analyze(history).n3.occurrences,0);
 assert.equal(analyze([...history,{number:4,source:'api'}]).n2.gapLimited,false); // padrão inteiramente após a lacuna
});
test('estratégia numérica aponta para a cor do próximo giro, não número inválido',()=>{
 const data=analyze([1,2,1,3,1,2,1]);
 assert.equal(data.n1.target,'P');
 assert.equal(matches(0,'cor',data.n1.target),true);
 assert.match(collector,/const kind=key\.startsWith\('col'\)\?'col':'cor'/);
 assert.match(collector,/const num=spin\.number;/);
 assert.match(collector,/american roulette/); // 00 não pode ser silenciosamente tratado como zero europeu
});
test('registra instantâneo e números na mesma transação e cancela sinais de lacunas',()=>{
 assert.match(collector,/async function ingestTable\(/);
 assert.match(collector,/await client\.query\('BEGIN'\)/);
 assert.match(collector,/UPDATE tables SET last_snapshot=/);
 assert.match(collector,/await client\.query\('COMMIT'\)/);
 assert.match(collector,/if\(gap\)\{/);
 assert.match(collector,/status='cancelled',closed_at=now\(\)/);
 assert.match(db,/history_revision bigint NOT NULL DEFAULT 0/);
 assert.match(historyCache,/SELECT history_revision FROM tables/);
 assert.match(server,/readCollectorHealth\(\)/);
});
