// Porta para JS das estratégias numéricas, cores, colunas e consenso do script entregue.
export const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
export const color = n => n === 0 ? 'B' : RED.has(n) ? 'V' : 'P';
export const column = n => n === 0 ? 0 : ((n-1)%3)+1;
export const KEYS = ['n1','n2','n3','n4','cor2','cor3','cor4','col2','col3','col4','consenso'];
export const TITLES = {n1:'1 número',n2:'2 números',n3:'3 números',n4:'4 números',cor2:'2 cores',cor3:'3 cores',cor4:'4 cores',col2:'2 colunas',col3:'3 colunas',col4:'4 colunas',consenso:'Consenso numérico'};
const limits = {n1:5,n2:5,n3:5,n4:5,cor2:5,cor3:5,cor4:5,col2:5,col3:5,col4:5};
const category = (kind,n) => kind === 'col' ? column(n) : color(n);
const counts = (items,kind) => {
  const out = kind === 'col' ? {0:0,1:0,2:0,3:0} : {V:0,P:0,B:0};
  for(const n of items) out[category(kind,n)]++;
  return out;
};
export function analyze(history) {
  // history ASC, most recent last; matches original pattern search (excluding current suffix).
  const records=history.slice(-2000);
  const nums=records.map(x => typeof x === 'number' ? x : x.number);
  // 'gap' representa uma lacuna real na origem: não cruzar esse ponto para criar padrões.
  const gapPrefix=[0];
  for(const item of records) gapPrefix.push(gapPrefix.at(-1)+(item?.source==='gap'?1:0));
  const crossesGap=(start,end)=>gapPrefix[end]-gapPrefix[start+1]>0;

  const output = {};
  for (const key of KEYS.filter(k=>k!=='consenso')) {
    const kind = key.startsWith('n') ? 'num' : key.startsWith('cor') ? 'cor' : 'col';
    const length = Number(key.at(-1));
    const convert = x => kind === 'num' ? x : category(kind,x);
    const recent = nums.slice(-length).map(convert);
    const matched = [];
    const usable=nums.length>=length&&!crossesGap(nums.length-length,nums.length);
    if (usable && nums.length > length) {
      for (let i=0;i<nums.length-length;i++) {
        if(crossesGap(i,i+length+1))continue;
        let equal = true;
        for (let j=0;j<length;j++) if(convert(nums[i+j])!==recent[j]) {equal=false;break;}
        if(equal) matched.push({number:nums[i+length],time:history[history.length-nums.length+i+length]?.created_at ?? null});
      }
    }
    matched.reverse();
    // Script original limita exibição a cinco; para cores ele usava as primeiras
    // cinco, aqui padronizado para as cinco ocorrências MAIS recentes.
    const sampled = matched.slice(0,limits[key]);
    const values = sampled.map(x=>x.number);
    const c = counts(values,kind==='col'?'col':'cor');
    let pick = null, confidence = 0;
    if(values.length) {
      const order = kind==='col' ? [1,2,3,0] : ['V','P','B'];
      pick = order.reduce((a,b)=> c[b]>c[a]?b:a,order[0]);
      confidence = c[pick]/values.length*100;
    }
    output[key] = {key,title:TITLES[key],type:kind,sequence:usable?recent:[],occurrences:matched.length,sample:sampled,sampleCount:sampled.length,counts:c,target:pick,percentage:Number(confidence.toFixed(1)),gapLimited:!usable};
  }
  const combined = {V:0,P:0,B:0};
  for (const k of ['n1','n2','n3','n4']) for(const c of ['V','P','B']) combined[c]+=output[k].counts[c]||0;
  const total = combined.V+combined.P+combined.B;
  const target = total ? ['V','P','B'].reduce((a,b)=>combined[b]>combined[a]?b:a,'V') : null;
  output.consenso = {key:'consenso',title:TITLES.consenso,type:'cor',sequence:nums.slice(-1),occurrences:total,sample:[],counts:combined,target,percentage:target?Number((combined[target]/total*100).toFixed(1)):0};
  return output;
}
export function matches(number,kind,target) {
  if(kind==='col') return column(number)===Number(target);
  if(kind==='num') return number===Number(target);
  return color(number)===target || (color(number)==='B' && target!=='B'); // Branco como proteção nos alvos V/P.
}
// Os snapshots estão em ordem MAIS RECENTE -> MAIS ANTIGO.
export function inferNewNumbers(previous,current) {
  if(!Array.isArray(current)||!current.length||current.some(n=>!Number.isInteger(n)||n<0||n>36)) return {numbers:[],gap:false};
  if(!Array.isArray(previous)||!previous.length) return {numbers:[],gap:false}; // primeira observação, sem backfill de 5
  if(previous.length===current.length && current.every((n,i)=>n===previous[i])) return {numbers:[],gap:false};
  for(let shift=1;shift<=current.length;shift++) {
    if(current.length-shift>0 && current.slice(shift).every((n,i)=>previous[i]===n)) {
      return {numbers:current.slice(0,shift).reverse(),gap:false};
    }
  }
  return {numbers:[current[0]],gap:true}; // intervalo sem sobreposição: não inventar resultados
}
