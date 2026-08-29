const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {initDatabase,saveSnapshot,history}=require('./db');

const root = path.join(__dirname, 'public');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};

function json(res, status, payload) {
  res.writeHead(status, {'content-type':'application/json'});
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index).trim(), decodeURIComponent(value.slice(index + 1))];
  }));
}

function authSecret() {
  return process.env.AUTH_SECRET || '';
}

function sign(value) {
  return crypto.createHmac('sha256', authSecret()).update(value).digest('base64url');
}

function authorized(req) {
  if (!process.env.APP_PASSWORD || !authSecret()) return false;
  const token = parseCookies(req).baladatrade_session;
  if (!token) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = sign(expires);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function passwordMatches(received) {
  const expected = Buffer.from(process.env.APP_PASSWORD || '');
  const actual = Buffer.from(String(received || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function binanceConfig() {
  return {
    key: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    base: process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision',
    live: process.env.ENABLE_LIVE_TRADING === 'true',
    max: Number(process.env.MAX_ORDER_NOTIONAL || 100),
  };
}

async function signedBinance(endpoint, method='GET', params={}) {
  const cfg = binanceConfig();
  if (!cfg.key || !cfg.secret) throw new Error('Binance ainda não configurada no servidor.');
  const query = new URLSearchParams({...params, recvWindow:'5000', timestamp:String(Date.now())});
  query.set('signature', crypto.createHmac('sha256', cfg.secret).update(query.toString()).digest('hex'));
  const response = await fetch(`${cfg.base}${endpoint}?${query}`, {method, headers:{'X-MBX-APIKEY':cfg.key}});
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || `Binance respondeu ${response.status}`);
  return data;
}

async function portfolioSummary(){
  const account=await signedBinance('/api/v3/account');
  const response=await fetch(`${binanceConfig().base}/api/v3/ticker/24hr`);
  if(!response.ok)throw new Error('Não foi possível consultar preços da Binance.');
  const tickers=await response.json(),bySymbol=new Map(tickers.map(item=>[item.symbol,item]));
  const stable=new Set(['USDT','USDC','FDUSD','TUSD']);
  const assets=account.balances.map(balance=>({asset:balance.asset,quantity:Number(balance.free)+Number(balance.locked)})).filter(item=>item.quantity>0).map(item=>{
    if(stable.has(item.asset))return {...item,price:1,value:item.quantity,changePct:0};
    const ticker=bySymbol.get(`${item.asset}USDT`);if(!ticker)return null;
    const price=Number(ticker.lastPrice),changePct=Number(ticker.priceChangePercent);
    return {...item,price,value:item.quantity*price,changePct};
  }).filter(Boolean).sort((a,b)=>b.value-a.value).slice(0,50);
  const total=assets.reduce((sum,item)=>sum+item.value,0);
  const previousTotal=assets.reduce((sum,item)=>sum+(item.value/(1+item.changePct/100)||item.value),0);
  const changeValue=total-previousTotal,changePct=previousTotal?changeValue/previousTotal*100:0;
  return {total,changeValue,changePct,assets,capturedAt:new Date().toISOString()};
}

function marketBase(){return 'https://api.binance.com'}
async function marketRadar(limit=50){
  const response=await fetch(`${marketBase()}/api/v3/ticker/24hr`);
  if(!response.ok)throw new Error('Radar de mercado indisponível.');
  const blocked=/^(USDC|FDUSD|TUSD|USDP|DAI|EUR|BRL|TRY|BIDR|AEUR|BUSD)$/;
  const leveraged=/(UP|DOWN|BULL|BEAR)$/;
  const rows=(await response.json()).filter(t=>t.symbol.endsWith('USDT')).map(t=>({
    symbol:t.symbol,asset:t.symbol.slice(0,-4),price:Number(t.lastPrice),change24h:Number(t.priceChangePercent),
    volume:Number(t.quoteVolume),high:Number(t.highPrice),low:Number(t.lowPrice),trades:Number(t.count)
  })).filter(t=>t.price>0&&t.volume>0&&!blocked.test(t.asset)&&!leveraged.test(t.asset)).sort((a,b)=>b.volume-a.volume).slice(0,Math.min(Math.max(limit,1),50));
  const maxVolume=Math.max(...rows.map(r=>Math.log10(r.volume+1)));
  return rows.map(row=>{
    const volumeScore=Math.log10(row.volume+1)/maxVolume*35;
    const momentumScore=Math.max(0,Math.min(35,17.5+row.change24h*2.2));
    const range=row.high-row.low,position=range?((row.price-row.low)/range)*20:10;
    const activity=Math.min(10,Math.log10(row.trades+1));
    const score=Math.round(Math.max(0,Math.min(100,volumeScore+momentumScore+position+activity)));
    const state=score>=85?'Aquecida':score>=70?'Força':score>=50?'Observação':score>=30?'Fraca':'Fraqueza';
    return {...row,score,state};
  }).sort((a,b)=>b.score-a.score);
}

function portfolioAlerts(summary){
  const alerts=[];
  for(const asset of summary.assets){
    const concentration=summary.total?asset.value/summary.total*100:0;
    if(concentration>=60)alerts.push({level:'warning',asset:asset.asset,message:`${asset.asset} representa ${concentration.toFixed(1)}% da carteira.`});
    if(Math.abs(asset.changePct)>=5)alerts.push({level:asset.changePct<0?'danger':'info',asset:asset.asset,message:`${asset.asset} variou ${asset.changePct.toFixed(2)}% em 24h.`});
  }
  if(Math.abs(summary.changePct)>=3)alerts.push({level:summary.changePct<0?'danger':'info',asset:'CARTEIRA',message:`A carteira variou ${summary.changePct.toFixed(2)}% em 24h.`});
  return alerts;
}

async function api(req, res, pathname) {
  if (pathname === '/api/auth/session') return json(res, 200, {authenticated:authorized(req)});
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!process.env.APP_PASSWORD || !authSecret()) return json(res,503,{error:'Autenticação ainda não configurada'});
    const data = await body(req);
    if (!passwordMatches(data.password)) return json(res,401,{error:'Senha incorreta'});
    const expires = String(Date.now() + 12 * 60 * 60 * 1000);
    res.writeHead(200, {'content-type':'application/json','set-cookie':`baladatrade_session=${expires}.${sign(expires)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});
    return res.end(JSON.stringify({authenticated:true}));
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    res.writeHead(200, {'content-type':'application/json','set-cookie':'baladatrade_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
    return res.end(JSON.stringify({authenticated:false}));
  }
  if (!authorized(req)) return json(res, 401, {error:'Não autorizado'});
  const cfg = binanceConfig();
  if (pathname === '/api/binance/status') return json(res, 200, {configured:Boolean(cfg.key&&cfg.secret), environment:cfg.base.includes('testnet')?'testnet':'real', liveEnabled:cfg.live, maxOrderNotional:cfg.max});
  try {
    if (pathname === '/api/binance/account' && req.method === 'GET') {
      const account = await signedBinance('/api/v3/account');
      return json(res, 200, {balances:account.balances.filter(x=>Number(x.free)||Number(x.locked)), canTrade:account.canTrade});
    }
    if (pathname === '/api/portfolio/refresh' && req.method === 'POST') {
      const summary=await portfolioSummary();
      const saved=await saveSnapshot(summary);
      return json(res,200,{...summary,alerts:portfolioAlerts(summary),snapshotId:saved.id});
    }
    if (pathname === '/api/portfolio/history' && req.method === 'GET') return json(res,200,{history:await history(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||30))});
    if (pathname === '/api/market/radar' && req.method === 'GET') return json(res,200,{coins:await marketRadar(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||50)),updatedAt:new Date().toISOString()});
    if ((pathname === '/api/binance/order/test' || pathname === '/api/binance/order') && req.method === 'POST') {
      const order = await body(req);
      const symbol = String(order.symbol||'').toUpperCase();
      const side = String(order.side||'').toUpperCase();
      const quantity = Number(order.quantity), price = Number(order.price);
      if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !['BUY','SELL'].includes(side) || !(quantity>0) || !(price>0)) return json(res,400,{error:'Ordem inválida'});
      if (quantity*price > cfg.max) return json(res,400,{error:`Valor acima do limite de ${cfg.max} USDT`});
      const real = pathname === '/api/binance/order';
      if (real && (!cfg.live || req.headers['x-confirm-live'] !== 'CONFIRMAR-ORDEM-REAL')) return json(res,403,{error:'Trading real bloqueado pela trava de segurança'});
      const result = await signedBinance(real?'/api/v3/order':'/api/v3/order/test','POST',{symbol,side,type:'LIMIT',timeInForce:'GTC',quantity:String(quantity),price:String(price)});
      return json(res,200,{ok:true,mode:real?'real':'test',result});
    }
    return json(res,404,{error:'Endpoint não encontrado'});
  } catch (error) { return json(res,502,{error:error.message}); }
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({status:'ok', app:'BaladaTrade'}));
  }
  if (url.pathname.startsWith('/api/')) return void api(req,res,url.pathname);
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'});
    res.end(data);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  http.createServer(handler).listen(port, '0.0.0.0', () => {
    console.log(`BaladaTrade ativo na porta ${port}`);
  });
  initDatabase().then(ok=>console.log(ok?'PostgreSQL conectado':'PostgreSQL não configurado')).catch(error=>console.error('Falha PostgreSQL:',error.message));
}
module.exports = {handler};
