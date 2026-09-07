process.env.APP_PASSWORD='x';process.env.AUTH_SECRET='y';
const crypto=require('node:crypto'),http=require('node:http');
const {handler}=require('../server.js');
const exp=String(Date.now()+3600000),sig=crypto.createHmac('sha256','y').update(exp).digest('base64url');
const cookie='baladatrade_session='+exp+'.'+sig;

const GET=['/api/system/health','/api/binance/status','/api/robo/estado','/api/robo/historico','/api/robo/posicoes',
'/api/market/radar?limit=5','/api/market/symbols','/api/market/setups','/api/market/klines?symbol=BTCUSDT&interval=1h',
'/api/market/pretrade?symbol=BTCUSDT','/api/market/scans?symbol=BTCUSDT','/api/mnq/profiles','/api/paper/account',
'/api/ledger','/api/alerts','/api/positions/assets','/api/positions/quote?symbol=BTCUSDT','/api/positions/monitor',
'/api/portfolio/history','/api/trade-plans','/api/earn/overview','/api/margin/monitor','/api/binance/account',
'/api/binance/trades?symbol=BTCUSDT','/api/binance/posicoes'];
const POST=[['/api/ordem/simular',{margem:100,alavancagem:10,precoEntrada:100,stop:98,alvo:106}],
['/api/ordem/pelo-risco',{perdaMaxima:10,precoEntrada:100,stop:98}],
['/api/spot/plan',{symbol:'BTCUSDT',capital:500,riskPct:1,entry:60000,stop:59000,target:62000}],
['/api/mnq/analyze',{profile:'tpt_test',accountSize:50000,balance:50000}],
['/api/robo/ciclo',{}]];

const cats={OK:[],CREDENCIAL:[],BANCO:[],QUEBRADO:[]};
function classificar(rota,status,texto){
  if(status===200)return cats.OK.push(rota);
  if(/Binance ainda não configurada|Binance em espera|Agente Anthropic/i.test(texto))return cats.CREDENCIAL.push(rota);
  if(/Banco de dados não configurado|PostgreSQL/i.test(texto))return cats.BANCO.push(rota);
  cats.QUEBRADO.push(`${rota} [${status}] ${texto.slice(0,110)}`);
}
const s=http.createServer(handler).listen(0,async()=>{
  const b='http://127.0.0.1:'+s.address().port;
  for(const r of GET){
    try{const res=await fetch(b+r,{headers:{cookie}});classificar(r,res.status,await res.text())}
    catch(e){cats.QUEBRADO.push(`${r} [EXCEÇÃO] ${e.message}`)}
  }
  for(const [r,body] of POST){
    try{const res=await fetch(b+r,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});classificar(r,res.status,await res.text())}
    catch(e){cats.QUEBRADO.push(`${r} [EXCEÇÃO] ${e.message}`)}
  }
  console.log(`\n✅ FUNCIONAM (${cats.OK.length}):`);cats.OK.forEach(x=>console.log('  ',x));
  console.log(`\n🔑 PRECISAM DE CHAVE BINANCE (${cats.CREDENCIAL.length}):`);cats.CREDENCIAL.forEach(x=>console.log('  ',x));
  console.log(`\n🗄  PRECISAM DE BANCO (${cats.BANCO.length}):`);cats.BANCO.forEach(x=>console.log('  ',x));
  console.log(`\n❌ QUEBRADOS (${cats.QUEBRADO.length}):`);cats.QUEBRADO.forEach(x=>console.log('  ',x));
  s.close();
});
