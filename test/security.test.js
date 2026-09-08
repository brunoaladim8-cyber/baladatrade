const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {handler,ordensDoRoboParaPanico,configDoRobo}=require('../server');

function serve(){return new Promise(resolve=>{const server=http.createServer(handler).listen(0,()=>resolve({server,url:`http://127.0.0.1:${server.address().port}`}))})}
function close(server){return new Promise(resolve=>server.close(resolve))}

test('pânico seleciona somente ordens criadas pelo BaladaTrade',()=>{
  const abertas=[
    {symbol:'BTCUSDT',clientOrderId:'btabcBTCUSDTs',orderId:1},
    {symbol:'ETHUSDT',clientOrderId:'manual-entrada',orderId:2},
    {symbol:'SOLUSDT',clientOrderId:'btxyzSOLUSDTa',orderId:3},
  ];
  assert.deepEqual(ordensDoRoboParaPanico(abertas).map(x=>x.orderId),[1,3]);
});

test('modo REAL bloqueado volta para simulação, nunca para Testnet',()=>{
  const oldLive=process.env.ENABLE_LIVE_TRADING,oldPermit=process.env.ROBO_PERMITE_REAL;
  process.env.ENABLE_LIVE_TRADING='false';delete process.env.ROBO_PERMITE_REAL;
  assert.equal(configDoRobo({modo:'REAL'}).modo,'SIMULACAO');
  if(oldLive===undefined)delete process.env.ENABLE_LIVE_TRADING;else process.env.ENABLE_LIVE_TRADING=oldLive;
  if(oldPermit===undefined)delete process.env.ROBO_PERMITE_REAL;else process.env.ROBO_PERMITE_REAL=oldPermit;
});

test('respostas incluem cabeçalhos de segurança',async()=>{
  const {server,url}=await serve();
  try{
    const response=await fetch(url+'/health');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }finally{await close(server)}
});

test('JSON inválido retorna 400 e o servidor continua vivo',async()=>{
  process.env.APP_PASSWORD='segura-teste';process.env.AUTH_SECRET='segredo-de-teste-longo';
  const {server,url}=await serve();
  try{
    const invalid=await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{'});
    assert.equal(invalid.status,400);
    const health=await fetch(url+'/health');assert.equal(health.status,200);
  }finally{await close(server)}
});

test('corpo maior que 1 MB retorna 413',async()=>{
  process.env.APP_PASSWORD='segura-teste';process.env.AUTH_SECRET='segredo-de-teste-longo';
  const {server,url}=await serve();
  try{
    const response=await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'x'.repeat(1024*1024)})});
    assert.equal(response.status,413);
  }finally{await close(server)}
});

test('origem cruzada é recusada antes de uma mutação',async()=>{
  process.env.APP_PASSWORD='segura-teste';process.env.AUTH_SECRET='segredo-de-teste-longo';
  const {server,url}=await serve();
  try{
    const response=await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'https://ataque.example','sec-fetch-site':'cross-site'},body:JSON.stringify({password:'segura-teste'})});
    assert.equal(response.status,403);
  }finally{await close(server)}
});

test('login limita tentativas repetidas',async()=>{
  process.env.APP_PASSWORD='segura-teste';process.env.AUTH_SECRET='segredo-de-teste-longo';
  const {server,url}=await serve();
  try{
    const headers={'content-type':'application/json','x-forwarded-for':'203.0.113.77'};
    for(let i=0;i<5;i++){const r=await fetch(url+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({password:'errada'})});assert.equal(r.status,401)}
    const blocked=await fetch(url+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({password:'errada'})});
    assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  }finally{await close(server)}
});
