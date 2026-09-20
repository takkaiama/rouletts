import crypto from 'node:crypto';
import {pool,uniqueId} from './db.js';
const hash = s=>crypto.createHash('sha256').update(s).digest('hex');
export const sha=hash;
export function passwordHash(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=crypto.scryptSync(password,salt,64).toString('hex');
  return `${salt}:${derived}`;
}
export function passwordValid(password,stored){
  const [salt,digest]=String(stored).split(':');
  if(!salt||!digest||digest.length!==128) return false;
  const a=crypto.scryptSync(password,salt,64), b=Buffer.from(digest,'hex');
  return crypto.timingSafeEqual(a,b);
}
export async function seedAdmin(){
  const result=await pool.query('SELECT COUNT(*)::integer AS count FROM users');
  if(result.rows[0].count!==0) return;
  const username=process.env.ADMIN_USERNAME, password=process.env.ADMIN_PASSWORD;
  if(!username||!password||password.length<12||password==='ALTERE_PARA_SENHA_FORTE_UNICA')
    throw Error('Configure ADMIN_USERNAME e ADMIN_PASSWORD (mínimo 12 caracteres) no Render.');
  const id=uniqueId();
  await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [id,username,passwordHash(password),'admin']);
  await pool.query('INSERT INTO preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  console.log('Conta administrativa inicial criada.');
}
export async function makeSession(userId){
  const token=crypto.randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[hash(token),userId]);
  return token;
}
export async function requireAuth(req,res,next){
  try {
    const value=req.get('authorization')||'';
    if(!value.startsWith('Bearer ')) return res.status(401).json({error:'Autenticação necessária'});
    const token=value.slice(7);
    if(token.length<30||token.length>150) return res.status(401).json({error:'Sessão inválida'});
    const {rows}=await pool.query(`SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash(token)]);
    if(!rows.length) return res.status(401).json({error:'Sessão expirada'});
    req.user=rows[0]; next();
  } catch(e){next(e);}
}
export function requireAdmin(req,res,next){return req.user?.role==='admin'?next():res.status(403).json({error:'Apenas administradores'});}
let encryptionKey;
export function setupEncryption(){
  const value=process.env.ENCRYPTION_KEY||'';
  if(!/^[a-f0-9]{64}$/i.test(value)) throw Error('ENCRYPTION_KEY precisa de 64 caracteres hexadecimais.');
  encryptionKey=Buffer.from(value,'hex');
}
export function encrypt(value){
  if(!value) return null;
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);
  const contents=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),contents]).toString('base64');
}
export function decrypt(value){
  if(!value) return '';
  const bytes=Buffer.from(value,'base64');
  const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
export const validUsername=s=>typeof s==='string'&&/^[a-zA-Z0-9_.-]{3,40}$/.test(s);
export const validPassword=s=>typeof s==='string'&&s.length>=12&&s.length<=200;
