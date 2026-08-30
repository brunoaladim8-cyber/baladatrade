const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const {initDatabase,saveSnapshot,history,portfolioBaseline,paperData,paperOrder,ledgerData,addLedgerEntry,deleteLedgerEntry}=require('./db');

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
  const [account,earnResult,lockedResult,fundingResult,marginResult]=await Promise.all([
    signedBinance('/api/v3/account'),
    signedBinance('/sapi/v1/simple-earn/flexible/position','GET',{current:'1',size:'100'}).catch(error=>({rows:[],_error:error.message})),
    signedBinance('/sapi/v1/simple-earn/locked/position','GET',{current:'1',size:'100'}).catch(error=>({rows:[],_error:error.message})),
    signedBinance('/sapi/v1/asset/get-funding-asset','POST').catch(error=>Object.assign([],{_error:error.message})),
    signedBinance('/sapi/v1/margin/account').catch(error=>({_error:error.message,userAssets:[]}))
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
  const holdingsTotal=assets.reduce((sum,item)=>sum+item.value,0),marginNet=Number(marginResult.totalNetAssetOfBtc||0)*btcUsdt,total=holdingsTotal+marginNet;
  const marketPreviousTotal=assets.reduce((sum,item)=>{const divisor=1+item.changePct/100;return sum+(divisor>0?item.value/divisor:item.value)},0);
  const marketChangeValue=total-marketPreviousTotal,marketChangePct=marketPreviousTotal?marketChangeValue/marketPreviousTotal*100:0;
  const walletWarnings=[];
  if(earnResult._error)walletWarnings.push('Simple Earn não pôde ser consultado com as permissões atuais.');
  if(lockedResult._error)walletWarnings.push('Earn bloqueado não pôde ser consultado com as permissões atuais.');
  if(fundingResult._error)walletWarnings.push('Funding não pôde ser consultado com as permissões atuais.');
  if(marginResult._error)walletWarnings.push('Margem não pôde ser consultada: dívidas podem não estar incluídas.');
  const walletTotals={};for(const item of assets)for(const [wallet,quantity] of Object.entries(item.walletAmounts))walletTotals[wallet]=(walletTotals[wallet]||0)+(item.price*quantity);
  if(!marginResult._error)walletTotals.Margem=marginNet;
  const margin={available:!marginResult._error,level:Number(marginResult.marginLevel||0),assetsUsdt:Number(marginResult.totalAssetOfBtc||0)*btcUsdt,debtUsdt:Number(marginResult.totalLiabilityOfBtc||0)*btcUsdt,netUsdt:marginNet,debts:(marginResult.userAssets||[]).filter(x=>Number(x.borrowed)+Number(x.interest)>0).map(x=>({asset:x.asset,borrowed:Number(x.borrowed),interest:Number(x.interest),netAsset:Number(x.netAsset)}))};
  return {total,changeValue:0,changePct:0,marketChangeValue,marketChangePct,assets,walletTotals,walletWarnings,margin,partial:walletWarnings.length>0,capturedAt:new Date().toISOString()};
}

function marketBase(){return 'https://api.binance.com'}
async function marketRadar(limit=50){
  const [response,exchangeResponse,isolatedResult]=await Promise.all([
    fetch(`${marketBase()}/api/v3/ticker/24hr`),
    fetch(`${marketBase()}/api/v3/exchangeInfo`),
    signedBinance('/sapi/v1/margin/isolated/allPairs').catch(()=>[])
  ]);
  if(!response.ok)throw new Error('Radar de mercado indisponível.');
  const exchange=exchangeResponse.ok?await exchangeResponse.json():{symbols:[]};
  const marginSymbols=new Set((exchange.symbols||[]).filter(s=>s.isMarginTradingAllowed||s.permissions?.includes('MARGIN')).map(s=>s.symbol));
  const isolatedSymbols=new Set((Array.isArray(isolatedResult)?isolatedResult:isolatedResult.rows||[]).filter(s=>s.isMarginTrade!==false).map(s=>s.symbol));
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
    const crossMargin=marginSymbols.has(row.symbol),isolatedMargin=isolatedSymbols.has(row.symbol);
    return {...row,score,state,crossMargin,isolatedMargin,maxLeverage:isolatedMargin?10:crossMargin?5:1};
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

function ema(values,period){if(!values.length)return 0;const k=2/(period+1);return values.slice(1).reduce((value,item)=>item*k+value*(1-k),values[0])}
function atr(candles,period=14){const ranges=candles.map((c,i)=>Math.max(c.high-c.low,i?Math.abs(c.high-candles[i-1].close):0,i?Math.abs(c.low-candles[i-1].close):0));const sample=ranges.slice(-period);return sample.length?sample.reduce((a,b)=>a+b,0)/sample.length:0}
function rsi(values,period=14){if(values.length<2)return 50;const changes=values.slice(1).map((v,i)=>v-values[i]).slice(-period),gain=changes.reduce((s,v)=>s+Math.max(v,0),0)/changes.length,loss=changes.reduce((s,v)=>s+Math.max(-v,0),0)/changes.length;return loss?100-(100/(1+gain/loss)):100}
async function publicKlines(symbol,interval,limit=120){const response=await fetch(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),data=await response.json();if(!response.ok)throw new Error(data.msg||'Candles indisponíveis.');return data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),quoteVolume:Number(row[7])}))}
function timeframeReading(candles,label){const closes=candles.map(c=>c.close),last=candles.at(-1),previous=candles.at(-2),ema20=ema(closes.slice(-60),20),ema50=ema(closes.slice(-100),50),atrValue=atr(candles),avgVolume=candles.slice(-21,-1).reduce((s,c)=>s+c.quoteVolume,0)/Math.max(candles.slice(-21,-1).length,1),volumeRatio=avgVolume?last.quoteVolume/avgVolume:0,change=previous?.close?(last.close-previous.close)/previous.close*100:0;return {label,price:last.close,change,ema20,ema50,atr:atrValue,atrPct:last.close?atrValue/last.close*100:0,rsi:rsi(closes),volumeRatio,trend:last.close>ema20&&ema20>ema50?'ALTA':last.close<ema20&&ema20<ema50?'BAIXA':'LATERAL'}}

function summarizeTrades(rows,market){
  const trades=(rows||[]).map(t=>({market,id:t.id,time:Number(t.time),side:t.isBuyer?'BUY':'SELL',price:Number(t.price),quantity:Number(t.qty),quote:Number(t.quoteQty||Number(t.price)*Number(t.qty)),commission:Number(t.commission||0),commissionAsset:t.commissionAsset})).sort((a,b)=>b.time-a.time);
  const aggregate=list=>{const quantity=list.reduce((sum,t)=>sum+t.quantity,0),quote=list.reduce((sum,t)=>sum+t.quote,0);return {count:list.length,quantity,quote,averagePrice:quantity?quote/quantity:0}};
  return {market,trades,buy:aggregate(trades.filter(t=>t.side==='BUY')),sell:aggregate(trades.filter(t=>t.side==='SELL'))};
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
  if(summary.margin?.debtUsdt>0)alerts.push({level:summary.margin.level&&summary.margin.level<1.5?'danger':'warning',asset:'MARGEM',message:`Dívida de ${summary.margin.debtUsdt.toFixed(2)} USDT · nível ${summary.margin.level.toFixed(2)}. Quite ou reduza antes de operar.`});
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
    if (pathname === '/api/market/pretrade' && req.method === 'GET') {
      const symbol=String(new URL(req.url,'http://localhost').searchParams.get('symbol')||'').toUpperCase();
      if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{error:'Par inválido.'});
      const [ticker,book,exchangeInfo,isolatedPairs,...sets]=await Promise.all([
        fetch(`${marketBase()}/api/v3/ticker/24hr?symbol=${symbol}`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Ticker indisponível.');return d}),
        fetch(`${marketBase()}/api/v3/depth?symbol=${symbol}&limit=100`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Livro de ofertas indisponível.');return d}),
        fetch(`${marketBase()}/api/v3/exchangeInfo?symbol=${symbol}`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Informações do mercado indisponíveis.');return d}),
        signedBinance('/sapi/v1/margin/isolated/allPairs').catch(()=>[]),
        ...['15m','1h','4h'].map(interval=>publicKlines(symbol,interval,120))
      ]);
      const frames=sets.map((candles,i)=>timeframeReading(candles,['15 minutos','1 hora','4 horas'][i])),price=Number(ticker.lastPrice),low=Number(ticker.lowPrice),high=Number(ticker.highPrice),range=high-low,rangePosition=range?(price-low)/range*100:0,amplitude=low?range/low*100:0,aligned=frames.every(f=>f.trend==='ALTA')?'ALTA':frames.every(f=>f.trend==='BAIXA')?'BAIXA':'MISTA';
      const bids=(book.bids||[]).map(([p,q])=>[Number(p),Number(q)]),asks=(book.asks||[]).map(([p,q])=>[Number(p),Number(q)]),bestBid=bids[0]?.[0]||0,bestAsk=asks[0]?.[0]||0,spreadPct=bestBid&&bestAsk?(bestAsk-bestBid)/((bestAsk+bestBid)/2)*100:0;
      const band=.005,bidDepth=bids.filter(([p])=>p>=price*(1-band)).reduce((sum,[p,q])=>sum+p*q,0),askDepth=asks.filter(([p])=>p<=price*(1+band)).reduce((sum,[p,q])=>sum+p*q,0),bookImbalance=bidDepth+askDepth?(bidDepth-askDepth)/(bidDepth+askDepth)*100:0;
      const market=exchangeInfo.symbols?.[0]||{},crossMargin=Boolean(market.isMarginTradingAllowed||market.permissions?.includes('MARGIN')),isolatedRows=Array.isArray(isolatedPairs)?isolatedPairs:isolatedPairs.rows||[],isolatedMargin=isolatedRows.some(item=>item.symbol===symbol&&item.isMarginTrade!==false);
      let riskPoints=0;if(rangePosition>=90)riskPoints+=30;else if(rangePosition>=80)riskPoints+=15;if(amplitude>=10)riskPoints+=25;else if(amplitude>=6)riskPoints+=12;if(frames[0].rsi>=75)riskPoints+=20;else if(frames[0].rsi>=68)riskPoints+=10;if(frames[0].volumeRatio>=2)riskPoints+=15;if(aligned==='MISTA')riskPoints+=10;if(spreadPct>=.2)riskPoints+=20;else if(spreadPct>=.08)riskPoints+=10;riskPoints=Math.min(100,riskPoints);
      const riskLabel=riskPoints>=65?'RISCO ALTO':riskPoints>=35?'ATENÇÃO':'RISCO MODERADO';
      const warnings=[];if(rangePosition>=90)warnings.push('Preço nos 10% superiores do intervalo de 24h: risco de perseguir alta.');if(amplitude>=10)warnings.push('Amplitude diária acima de 10%: volatilidade extrema.');if(frames[0].volumeRatio>=2)warnings.push('Volume de 15m acima de 2x a média recente.');if(frames[0].rsi>=75)warnings.push('RSI de 15m sobrecomprado; continuação não é garantida.');if(aligned==='MISTA')warnings.push('Períodos não estão alinhados; movimento pode ser apenas ruído curto.');if(spreadPct>=.2)warnings.push('Spread elevado: entrada e saída podem ter slippage relevante.');
      return json(res,200,{symbol,price,open:Number(ticker.openPrice),high,low,change24h:Number(ticker.priceChangePercent),quoteVolume:Number(ticker.quoteVolume),amplitude,rangePosition,distanceHighPct:high?(price-high)/high*100:0,frames,alignment:aligned,warnings,risk:{score:riskPoints,label:riskLabel},marketAccess:{spot:Boolean(market.isSpotTradingAllowed),crossMargin,isolatedMargin,maxLeverage:isolatedMargin?10:crossMargin?5:1,note:'O selo indica elegibilidade do par, não limite disponível nem autorização para tomar empréstimo.'},orderBook:{bestBid,bestAsk,spreadPct,bidDepth,askDepth,imbalancePct:bookImbalance},generatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/binance/trades' && req.method === 'GET') {
      const url=new URL(req.url,'http://localhost'),symbol=String(url.searchParams.get('symbol')||'').toUpperCase();
      if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{error:'Par inválido.'});
      const [spot,margin]=await Promise.all([
        signedBinance('/api/v3/myTrades','GET',{symbol,limit:'500'}).catch(error=>Object.assign([],{_error:error.message})),
        signedBinance('/sapi/v1/margin/myTrades','GET',{symbol,limit:'500'}).catch(error=>Object.assign([],{_error:error.message}))
      ]);
      const warnings=[];if(spot._error)warnings.push(`Spot: ${spot._error}`);if(margin._error)warnings.push(`Margem: ${margin._error}`);
      return json(res,200,{symbol,spot:summarizeTrades(spot,'Spot'),margin:summarizeTrades(margin,'Margem Cross'),warnings,updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/paper/account' && req.method === 'GET') return json(res,200,await paperSummary());
    if (pathname === '/api/ledger' && req.method === 'GET') return json(res,200,await ledgerData(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||200)));
    if (pathname === '/api/ledger' && req.method === 'POST') {
      const entry=await body(req),type=String(entry.type||''),description=String(entry.description||'').trim(),amountBrl=Number(entry.amountBrl||0),amountUsdt=Number(entry.amountUsdt||0);
      if(!['expense','trade_pnl','fee','interest','transfer','income'].includes(type)||!description||description.length>160||amountBrl<0||amountUsdt<0||(!amountBrl&&!amountUsdt))return json(res,400,{error:'Lançamento financeiro inválido.'});
      const saved=await addLedgerEntry({occurredAt:entry.occurredAt||new Date().toISOString(),type,category:String(entry.category||'Outros').slice(0,40),description,amountBrl,amountUsdt,notes:String(entry.notes||'').slice(0,1000)});
      return json(res,201,{ok:true,saved,ledger:await ledgerData(200)});
    }
    if (pathname.startsWith('/api/ledger/') && req.method === 'DELETE') {const id=Number(pathname.split('/').pop());if(!Number.isInteger(id)||id<1)return json(res,400,{error:'ID inválido.'});await deleteLedgerEntry(id);return json(res,200,{ok:true});}
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
