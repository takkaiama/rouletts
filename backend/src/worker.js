import 'dotenv/config';
import {initDb,pool} from './db.js';
import {setupEncryption} from './security.js';
import {startWorkers} from './collector.js';
if(!process.env.DATABASE_URL)throw Error('Configure DATABASE_URL');
setupEncryption();
try{
  await initDb();
  startWorkers();
  console.log('[worker] coleta de todas as mesas iniciada; serviço independente do navegador');
}catch(error){
  console.error('[worker] Falha de inicialização:',error.message);
  await pool.end();
  process.exitCode=1;
}
