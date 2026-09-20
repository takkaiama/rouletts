import test from 'node:test';
import assert from 'node:assert/strict';
import {color,column,analyze,inferNewNumbers,matches} from '../src/strategies.js';
test('cores europeias e colunas, incluindo zero',()=>{
 assert.equal(color(0),'B');assert.equal(color(1),'V');assert.equal(color(2),'P');assert.equal(color(36),'V');
 assert.equal(column(0),0);assert.equal(column(1),1);assert.equal(column(11),2);assert.equal(column(36),3);
});
test('identifica sequências e conta o resultado seguinte sem incluir a sequência atual',()=>{
 const a=analyze([1,2,1,3,1,2,1]);
 assert.equal(a.n1.sequence[0],1);assert.equal(a.n1.occurrences,3);
 assert.equal(a.n2.occurrences,1);assert.equal(a.n2.sample[0].number,3);
 assert.equal(a.consenso.occurrences>0,true);
});
test('snapshot novo não injeta históricos de cinco',()=>{
 assert.deepEqual(inferNewNumbers(null,[3,2,1,0,8]).numbers,[]);
 assert.deepEqual(inferNewNumbers([4,3,2,1,0],[5,4,3,2,1]),{numbers:[5],gap:false});
 assert.deepEqual(inferNewNumbers([4,3,2,1,0],[6,5,4,3,2]),{numbers:[5,6],gap:false});
 assert.deepEqual(inferNewNumbers([4,3,2,1,0],[4,4,3,2,1]),{numbers:[4],gap:false});
 assert.deepEqual(inferNewNumbers([4,3,2,1,0],[4,3,2,1,0]),{numbers:[],gap:false});
 assert.deepEqual(inferNewNumbers([4,3,2,1,0],[6,5,8,9,10]),{numbers:[6],gap:true});
});
test('proteção do zero só para cor; colunas são exatas',()=>{
 assert.equal(matches(0,'cor','V'),true);
 assert.equal(matches(0,'cor','P'),true);
 assert.equal(matches(0,'cor','B'),true);
 assert.equal(matches(0,'col','1'),false);
 assert.equal(matches(0,'col','0'),true);
});
