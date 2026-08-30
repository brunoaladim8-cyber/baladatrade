const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const {initDatabase,saveSnapshot,history,portfolioBaseline,paperData,paperOrder}=require('./db');

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
  const [account,earnResult,lockedResult,fundingResult]=await Promise.all([
    signedBinance('/api/v3/account'),
    signedBinance('/sapi/v1/simple-earn/flexible/position','GET',{current:'1',size:'100'}).catch(error=>({rows:[],_error:error.message})),
    signedBinance('/sapi/v1/simple-earn/locked/position','GET',{current:'1',size:'100'}).catch(error=>({rows:[],_error:error.message})),
    signedBinance('/sapi/v1/asset/get-funding-asset','POST').catch(error=>Object.assign([],{_error:error.message}))
  ]);
  const response=await fetch(`${binanceConfig().base}/api/v3/ticker/24hr`);
  if(!response.ok)throw new Error('Não foi possível consultar preços da Binance.');
  const tickers=await response.json(),bySymbol=new Map(tickers.map(item=>[item.symbol,item]));
  const stable=new Set(['USDT','USDC','FDUSD','TUSD','USDP','DAI']);
  const positions=[
    ...account.balances.map(balance=>({asset:balance.asset,quantity:Number(balance.free)+Number(balance.locked),wallet:'Spot'})),
    ...(earnResult.rows||[]).map(row=>({asset:row.asset,quantity:Number(row.totalAmount||0),wallet:'Simple Earn'})),
    ...(lockedResult.rows||[]).map(row=>({asset:row.asset,quantity:Number(row.amount||row.totalAmount||0),wallet:'Earn Bloqueado'})),
    ...(Array.isArray(fundingResult)?fundingResult:[]).map(row=>({asset:row.asset,quantity:Number(row.free||0)+Number(row.locked||0),wallet:'Funding'}))
  ].filter(item=>item.quantity>0);
  const merged=new Map();
  for(const item of positions){const current=merged.get(item.asset)||{asset:item.asset,quantity:0,wallets:[],walletAmounts:{}};current.quantity+=item.quantity;current.walletAmounts[item.wallet]=(current.walletAmounts[item.wallet]||0)+item.quantity;if(!current.wallets.includes(item.wallet))current.wallets.push(item.wallet);merged.set(item.asset,current)}
  const btcUsdt=Number(bySymbol.get('BTCUSDT')?.lastPrice||0),usdcUsdt=Number(bySymbol.get('USDCUSDT')?.lastPrice||1);
  const assets=[...merged.values()].map(item=>{
    if(stable.has(item.asset))return {...item,price:item.asset==='USDC'?usdcUsdt:1,value:item.quantity*(item.asset==='USDC'?usdcUsdt:1),changePct:0,priced:true};
    let ticker=bySymbol.get(`${item.asset}USDT`),price=Number(ticker?.lastPrice||0),changePct=Number(ticker?.priceChangePercent||0),priceSource='USDT';
    if(!price){ticker=bySymbol.get(`${item.asset}USDC`);price=Number(ticker?.lastPrice||0)*usdcUsdt;changePct=Number(ticker?.priceChangePercent||0);priceSource='USDC';}
    if(!price){ticker=bySymbol.get(`${item.asset}BTC`);price=Number(ticker?.lastPrice||0)*btcUsdt;changePct=Number(ticker?.priceChangePercent||0);priceSource='BTC';}
    return {...item,price,value:price?item.quantity*price:0,changePct,priced:Boolean(price),priceSource:price?priceSource:null};
  }).sort((a,b)=>b.value-a.value||a.asset.localeCompare(b.asset));
  const total=assets.reduce((sum,item)=>sum+item.value,0);
  const marketPreviousTotal=assets.reduce((sum,item)=>{const divisor=1+item.changePct/100;return sum+(divisor>0?item.value/divisor:item.value)},0);
  const marketChangeValue=total-marketPreviousTotal,marketChangePct=marketPreviousTotal?marketChangeValue/marketPreviousTotal*100:0;
  const walletWarnings=[];
  if(earnResult._error)walletWarnings.push('Simple Earn não pôde ser consultado com as permissões atuais.');
  if(lockedResult._error)walletWarnings.push('Earn bloqueado não pôde ser consultado com as permissões atuais.');
  if(fundingResult._error)walletWarnings.push('Funding não pôde ser consultado com as permissões atuais.');
  const walletTotals={};for(const item of assets)for(const [wallet,quantity] of Object.entries(item.walletAmounts))walletTotals[wallet]=(walletTotals[wallet]||0)+(item.price*quantity);
  return {total,changeValue:0,changePct:0,marketChangeValue,marketChangePct,assets,walletTotals,walletWarnings,partial:walletWarnings.length>0,capturedAt:new Date().toISOString()};
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

function marketAlerts(coins){
  const alerts=[];
  for(const coin of coins){
    const volatility=coin.low?((coin.high-coin.low)/coin.low)*100:0;
    const position=coin.high>coin.low?(coin.price-coin.low)/(coin.high-coin.low):0;
    if(coin.score>=85&&coin.change24h>=3)alerts.push({id:`force-${coin.symbol}`,level:'info',symbol:coin.symbol,title:`${coin.asset} em força`,message:`${coin.change24h.toFixed(2)}% em 24h · nota ${coin.score}/100.`});
    if(coin.change24h<=-5)alerts.push({id:`fall-${coin.symbol}`,level:'danger',symbol:coin.symbol,title:`${coin.asset} em queda forte`,message:`${coin.change24h.toFixed(2)}% em 24h.`});
    if(volatility>=10)alerts.push({id:`vol-${coin.symbol}`,level:'warning',symbol:coin.symbol,title:`${coin.asset} volátil`,message:`Amplitude diária de ${volatility.toFixed(2)}%.`});
    if(position>=0.95&&coin.change24h>1)alerts.push({id:`high-${coin.symbol}`,level:'info',symbol:coin.symbol,title:`${coin.asset} perto da máxima`,message:`Preço está no topo do intervalo diário; evite perseguir alta.`});
  }
  return alerts.slice(0,30);
}

async function publicPrice(symbol){
  const response=await fetch(`${marketBase()}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),data=await response.json();
  if(!response.ok||!Number(data.price))throw new Error(data.msg||'Par não encontrado na Binance.');
  return Number(data.price);
}

async function paperSummary(){
  const data=await paperData();
  const positions=await Promise.all(data.positions.map(async position=>{const price=await publicPrice(position.symbol);const value=position.quantity*price,cost=position.quantity*position.average_price_usdt;return {...position,price,value,pnl:value-cost,pnlPct:cost?(value-cost)/cost*100:0}}));
  const positionsValue=positions.reduce((sum,item)=>sum+item.value,0),equity=data.account.cash_usdt+positionsValue;
  return {...data,positions,equity,positionsValue,totalPnl:equity-data.account.initial_usdt,totalPnlPct:data.account.initial_usdt?(equity-data.account.initial_usdt)/data.account.initial_usdt*100:0,mode:'simulação'};
}

async function marketAgentAnalysis(){
  if(!process.env.ANTHROPIC_API_KEY)throw new Error('Agente Anthropic ainda não configurado. Adicione ANTHROPIC_API_KEY no Railway.');
  const coins=await marketRadar(50);
  const sample=coins.slice(0,15).map(({symbol,price,change24h,volume,high,low,trades,score,state})=>({symbol,price,change24h,volume,high,low,trades,score,state}));
  const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
  const message=await client.messages.create({
    model:process.env.ANTHROPIC_MODEL||'claude-sonnet-4-6',max_tokens:1200,temperature:0.2,
    system:'Você é um analista quantitativo cauteloso. Analise somente os dados fornecidos. Não prometa lucro, não dê ordem de compra/venda e não invente notícias. Alta passada não prevê alta futura. Responda apenas JSON válido.',
    messages:[{role:'user',content:`Analise este radar spot USDT. Retorne {"summary":"...","cautions":["..."],"assets":[{"symbol":"...","label":"FORÇA|OBSERVAR|RISCO","reason":"..."}]}. Escolha no máximo 6 ativos e cite variação, volume/score ou posição no range como evidência. Dados: ${JSON.stringify(sample)}`}]
  });
  const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('').replace(/^```json\s*|\s*```$/g,'');
  let analysis;try{analysis=JSON.parse(text)}catch{throw new Error('O agente retornou uma análise inválida. Tente novamente.');}
  return {analysis,model:message.model,generatedAt:new Date().toISOString(),disclaimer:'Análise educacional baseada em dados de mercado; não é recomendação financeira.'};
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
      const baseline=await portfolioBaseline(),changeValue=baseline?summary.total-baseline.total_usdt:0,changePct=baseline?.total_usdt?changeValue/baseline.total_usdt*100:0;
      const complete={...summary,changeValue,changePct,comparisonAt:baseline?.captured_at||null};
      if(complete.partial)return json(res,206,{...complete,alerts:portfolioAlerts(complete),snapshotId:null,integrityWarning:'Leitura parcial: o histórico não foi alterado para evitar apagar ou distorcer dados.'});
      const saved=await saveSnapshot(complete);
      return json(res,200,{...complete,alerts:portfolioAlerts(complete),snapshotId:saved.id});
    }
    if (pathname === '/api/portfolio/history' && req.method === 'GET') return json(res,200,{history:await history(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||30))});
    if (pathname === '/api/market/radar' && req.method === 'GET') {const coins=await marketRadar(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||50));return json(res,200,{coins,alerts:marketAlerts(coins),updatedAt:new Date().toISOString()});}
    if (pathname === '/api/market/symbols' && req.method === 'GET') {
      const response=await fetch(`${marketBase()}/api/v3/exchangeInfo`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Lista de mercados indisponível.');
      const symbols=data.symbols.filter(item=>item.status==='TRADING').map(item=>({symbol:item.symbol,base:item.baseAsset,quote:item.quoteAsset,spot:item.isSpotTradingAllowed}));
      return json(res,200,{symbols,count:symbols.length,updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/market/klines' && req.method === 'GET') {
      const url=new URL(req.url,'http://localhost'),symbol=String(url.searchParams.get('symbol')||'SOLUSDT').toUpperCase(),interval=String(url.searchParams.get('interval')||'1d');
      if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!['15m','1h','4h','1d','1w'].includes(interval))return json(res,400,{error:'Par ou intervalo inválido.'});
      const response=await fetch(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Gráfico indisponível.');
      return json(res,200,{symbol,interval,candles:data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])}))});
    }
    if (pathname === '/api/paper/account' && req.method === 'GET') return json(res,200,await paperSummary());
    if (pathname === '/api/paper/order' && req.method === 'POST') {
      const order=await body(req),symbol=String(order.symbol||'').toUpperCase(),side=String(order.side||'').toUpperCase(),amount=Number(order.amount);
      if(!/^[A-Z0-9]{2,16}USDT$/.test(symbol)||!['BUY','SELL'].includes(side)||!(amount>0)||amount>100000)return json(res,400,{error:'Ordem simulada inválida.'});
      const price=await publicPrice(symbol),quantity=side==='BUY'?amount/price:amount;
      await paperOrder({symbol,asset:symbol.slice(0,-4),side,quantity,price});
      return json(res,200,{ok:true,price,account:await paperSummary()});
    }
    if (pathname === '/api/ai/market-analysis' && req.method === 'POST') return json(res,200,await marketAgentAnalysis());
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
