import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const folder=resolve(dirname(fileURLToPath(import.meta.url)),'../src');
const read=name=>readFileSync(resolve(folder,name),'utf8');

test('DDL contém quatro identidades PostgreSQL válidas e nenhuma sintaxe AS ID inválida',()=>{
  const code=read('db.js');
  assert.ok((code.match(/GENERATED ALWAYS AS IDENTITY PRIMARY KEY/g)||[]).length>=4);
  assert.doesNotMatch(code,/GENERATED\s+ALWAYS\s+AS\s+ID\b(?!ENTITY)/);
  assert.match(code,/CREATE TABLE IF NOT EXISTS users/);
  assert.match(code,/CREATE TABLE IF NOT EXISTS spins/);
  assert.match(code,/CREATE TABLE IF NOT EXISTS outbox/);
});
test('importações nomeadas locais existem nos arquivos correspondentes',()=>{
  for(const name of ['collector.js','server.js','security.js','history-cache.js']){
    const source=read(name);
    for(const [,names,target] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)){
      const dep=read(target.slice(2));
      for(const item of names.split(',').map(s=>s.trim().split(/\s+as\s+/)[0])){
        assert.ok(new RegExp('(?:export\\s+\\{[^}]*\\b'+item+'\\b|export\\s+(?:async\\s+)?(?:const|let|function|class)\\s+'+item+'\\b)').test(dep),
          name+' importa '+item+' de '+target+' sem exportação');
      }
    }
  }
  assert.doesNotMatch(read('collector.js'),/recentHistory/);
});
test('inserção administrativa e limpeza partilham a mesma transação',()=>{
  const code=read('server.js');
  assert.match(code,/await client\.query\('BEGIN'\)/);
  assert.match(code,/await trimSpins\(tableId,client\)/);
  assert.match(code,/await client\.query\('COMMIT'\)/);
});

test('health check consulta banco e prestart executa testes antes de iniciar',()=>{
  assert.match(read('server.js'),/app\.get\('\/api\/health',asyncRoute/);
  assert.match(read('server.js'),/database:'unavailable'/);
  const pkg=JSON.parse(readFileSync(resolve(folder,'../package.json'),'utf8'));
  assert.equal(pkg.scripts.prestart,'npm test');
});
