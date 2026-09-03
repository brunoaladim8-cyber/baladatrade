const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const {PROP_PROFILES,ACCOUNT_RULES,TPT_RULES,LUCID_RULES,riskState,detectSetup,backtest}=require('./mnq-engine');
const {calculateSpotPlan}=require('./spot-engine');
const {initDatabase,databaseHealth,saveSnapshot,history,portfolioBaseline,paperData,paperOrder,ledgerData,addLedgerEntry,deleteLedgerEntry,importLedgerEntries,saveMarketScan,marketScanHistory,saveTradePlan,tradePlanHistory,closeTradePlan,saveAlerts,alertHistory,savePositionWatch,positionWatches,updatePositionWatch}=require('./db');

const root = path.join(__dirname, 'public');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
let monitorAssetCache={assets:[],updatedAt:0};
const monitorFallback=['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK','AVAX','CAKE'].map(asset=>({symbol:`${asset}USDT`,label:`${asset} / USDT`,market:'Cripto · Binance',quantityLabel:asset,feed:'Binance'}));

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
function normalizeMarketSymbol(value){const clean=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(!clean)return'BTCUSDT';const quote=clean.match(/(USDT|USDC|FDUSD|TUSD|BTC|ETH|BNB|BRL)$/)?.[1];return quote&&clean.length>quote.length?clean:`${clean}USDT`}
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
  if(symbol==='MNQ'||symbol==='MNQ=F'){
    const candles=await mnqCandles(),last=candles.at(-1);
    if(!last?.close)throw new Error('Cotação pública do MNQ indisponível no momento.');
    return last.close;
  }
  const response=await fetch(`${marketBase()}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),data=await response.json();
  if(!response.ok||!Number(data.price))throw new Error(data.msg||'Par não encontrado na Binance.');
  return Number(data.price);
}

async function assetValueUsdt(asset,amount){
  if(['USDT','USDC','FDUSD','TUSD','USDP','DAI'].includes(asset))return amount;
  if(asset==='BRL'){const brlPerUsdt=await publicPrice('USDTBRL');return brlPerUsdt?amount/brlPerUsdt:0}
  return amount*await publicPrice(`${asset}USDT`);
}

async function syncBinancePay(){
  const endTime=Date.now(),startTime=endTime-89*24*60*60*1000;
  const response=await signedBinance('/sapi/v1/pay/transactions','GET',{startTime:String(startTime),endTime:String(endTime),limit:'100'}),rows=Array.isArray(response)?response:response.data||response.rows||[];
  const payRows=rows.filter(item=>String(item.orderType||'').toUpperCase()==='PAY');
  const entries=[];
  for(const item of payRows){const asset=String(item.currency||item.fundsDetail?.[0]?.currency||'USDT').toUpperCase(),amount=Math.abs(Number(item.amount||item.fundsDetail?.reduce((sum,row)=>sum+Number(row.amount||0),0)||0));if(!amount||!item.transactionId)continue;let amountUsdt=0;try{amountUsdt=await assetValueUsdt(asset,amount)}catch{}entries.push({occurredAt:new Date(Number(item.transactionTime||Date.now())).toISOString(),type:'expense',category:'Cartão/Binance Pay',description:`Pagamento Binance · ${asset}`,amountBrl:asset==='BRL'?amount:0,amountUsdt,source:'binance_pay',externalId:String(item.transactionId),notes:`Importado automaticamente. Valor original: ${amount} ${asset}. Conversão USDT usa cotação no momento da sincronização.`})}
  return {...await importLedgerEntries(entries),received:rows.length,eligible:payRows.length,periodDays:89,warning:'A API oficial expõe Binance Pay. Compras exclusivas do cartão que não aparecem como PAY precisam de extrato/CSV.'};
}

async function marginMonitor(){
  const [account,tickers]=await Promise.all([signedBinance('/sapi/v1/margin/account'),fetch(`${marketBase()}/api/v3/ticker/price`).then(r=>r.json())]),prices=new Map(tickers.map(x=>[x.symbol,Number(x.price)])),stable=new Set(['USDT','USDC','FDUSD','TUSD']);
  const positions=(account.userAssets||[]).map(row=>{const price=stable.has(row.asset)?1:prices.get(`${row.asset}USDT`)||0,free=Number(row.free),locked=Number(row.locked),borrowed=Number(row.borrowed),interest=Number(row.interest),net=Number(row.netAsset),debt=borrowed+interest;return {asset:row.asset,free,locked,borrowed,interest,net,price,netUsdt:net*price,debtUsdt:debt*price,direction:net<0?'SHORT':debt>0||net>0?'LONG':'FLAT'}}).filter(x=>Math.abs(x.netUsdt)>=.01||x.debtUsdt>=.01).sort((a,b)=>b.debtUsdt-a.debtUsdt||Math.abs(b.netUsdt)-Math.abs(a.netUsdt));
  const level=Number(account.marginLevel||0),alerts=[];if(level&&level<1.5)alerts.push({kind:'margin',level:'danger',title:'Nível de margem crítico',message:`Nível ${level.toFixed(2)}. Reduza dívida antes de nova operação.`,fingerprint:`margin-critical-${new Date().toISOString().slice(0,13)}`,payload:{level}});for(const p of positions.filter(x=>x.interest>0))alerts.push({kind:'interest',level:'warning',symbol:p.asset,title:`Juros em ${p.asset}`,message:`${p.interest} ${p.asset} acumulados.`,fingerprint:`interest-${p.asset}-${new Date().toISOString().slice(0,10)}`,payload:p});await saveAlerts(alerts);
  return {level,totalAssetUsdt:Number(account.totalAssetOfBtc||0)*(prices.get('BTCUSDT')||0),totalDebtUsdt:Number(account.totalLiabilityOfBtc||0)*(prices.get('BTCUSDT')||0),netUsdt:Number(account.totalNetAssetOfBtc||0)*(prices.get('BTCUSDT')||0),positions,alerts,updatedAt:new Date().toISOString()};
}

// ============================================================
// PENEIRA DO SCANNER — 02/09/2026
//
// O scanner listava seis candidatos lado a lado, todos com a mesma cara. Em
// 02/09 o Bruno escolheu o ARBUSDT: PULLBACK LONG, +14,06% em 24h — e volume
// de 0,4x, o MENOR da tela, tendo FF a 2,62x e LA a 3,9x na mesma lista.
// Pullback com volume secando e o padrao mais comum de repique que nao
// continua: a coluna existia, mas nao pesava em nada.
//
// A peneira nao esconde candidato — ela escreve o motivo de cada um NAO
// servir, e deixa os elegiveis no topo. Quem quiser entrar contra o filtro
// entra vendo o que esta contrariando.
// ============================================================
function peneira(x){
  const fora=[];
  if(x.setup==='ESTICADA')fora.push('Setup ESTICADA: perseguir alta ja feita.');
  if(x.setup==='OBSERVAR'||x.setup==='SEM DADOS')fora.push('Sem setup valido no momento.');
  if(Number(x.volumeRatio15)<1)fora.push(`Volume de 15m em ${Number(x.volumeRatio15||0).toFixed(2)}x da media: movimento sem confirmacao.`);
  if(Number(x.rsi15)>=75)fora.push(`RSI 15m em ${Math.round(x.rsi15)}: sobrecomprado.`);
  if(Number(x.atr15Pct)>=3)fora.push(`ATR 15m de ${Number(x.atr15Pct).toFixed(2)}%: stop tecnico exige posicao grande demais para capital pequeno.`);
  if(Number(x.change24h)>=25)fora.push(`Ja subiu ${Number(x.change24h).toFixed(1)}% em 24h.`);
  return {desqualificadores:fora,elegivel:fora.length===0};
}

async function setupScanner(){
  const coins=(await marketRadar(50)).slice(0,25),results=await Promise.all(coins.map(async coin=>{try{const [m15,h1]=await Promise.all([publicKlines(coin.symbol,'15m',80),publicKlines(coin.symbol,'1h',80)]),short=timeframeReading(m15,'15m'),long=timeframeReading(h1,'1h'),distanceEma=long.atr?Math.abs(coin.price-short.ema20)/long.atr:99;let setup='OBSERVAR',reason='Sem alinhamento suficiente';if(coin.change24h>0&&(coin.price-coin.low)/(coin.high-coin.low||1)>.9||short.rsi>=75){setup='ESTICADA';reason='Perto da máxima ou RSI curto elevado'}else if(long.trend==='ALTA'&&distanceEma<=.6&&short.rsi>=38&&short.rsi<=65){setup='PULLBACK LONG';reason='Tendência de 1h em alta e preço próximo da EMA20'}else if(long.trend==='BAIXA'&&short.trend==='BAIXA'&&short.rsi>30){setup='POSSÍVEL SHORT';reason='15m e 1h alinhados em baixa; confirme rompimento e stop'}else if(long.trend==='ALTA'&&short.trend==='ALTA'&&short.volumeRatio>=1.2){setup='FORÇA LONG';reason='15m e 1h em alta com volume relativo'}return {...coin,setup,reason,rsi15:short.rsi,atr15Pct:short.atrPct,volumeRatio15:short.volumeRatio,trend15:short.trend,trend1h:long.trend,...peneira({setup,rsi15:short.rsi,volumeRatio15:short.volumeRatio,atr15Pct:short.atrPct,change24h:coin.change24h})}}catch{return {...coin,setup:'SEM DADOS',reason:'Candles indisponíveis',desqualificadores:['Candles indisponíveis.'],elegivel:false}}}));
  results.sort((a,b)=>Number(b.elegivel)-Number(a.elegivel)||(b.volumeRatio15||0)-(a.volumeRatio15||0));
  const alerts=results.filter(x=>x.elegivel&&['PULLBACK LONG','POSSÍVEL SHORT','FORÇA LONG'].includes(x.setup)).map(x=>({kind:'setup',level:'info',symbol:x.symbol,title:`${x.setup}: ${x.symbol}`,message:x.reason,fingerprint:`setup-${x.symbol}-${x.setup}-${new Date().toISOString().slice(0,13)}`,payload:x}));await saveAlerts(alerts);return {setups:results,generatedAt:new Date().toISOString()};
}

async function evaluatePlans(){
  const plans=(await tradePlanHistory('',200)).filter(x=>x.status==='PLANNED'),evaluated=[];
  for(const plan of plans){let price;try{price=await publicPrice(plan.symbol)}catch{continue}const hitTarget=plan.direction==='LONG'?price>=plan.target:price<=plan.target,hitStop=plan.direction==='LONG'?price<=plan.stop:price>=plan.stop;let status='PLANNED',exit=price;if(hitTarget){status='TARGET';exit=plan.target}else if(hitStop){status='STOP';exit=plan.stop}const pnl=(plan.direction==='LONG'?exit-plan.entry:plan.entry-exit)*plan.quantity;if(status!=='PLANNED'){await closeTradePlan(plan.id,status,exit,pnl,new Date());await saveAlerts([{kind:'plan',level:status==='TARGET'?'info':'danger',symbol:plan.symbol,title:`Plano #${plan.id}: ${status}`,message:`Resultado aproximado ${pnl.toFixed(4)} USDT.`,fingerprint:`plan-${plan.id}-${status}`,payload:{planId:plan.id,pnl,exit}}])}evaluated.push({...plan,currentPrice:price,currentPnl:(plan.direction==='LONG'?price-plan.entry:plan.entry-price)*plan.quantity,status:status==='PLANNED'?plan.status:status})}return {plans:evaluated,updatedAt:new Date().toISOString()};
}

// ============================================================
// LEITURA DA MESA — 02/09/2026
//
// O monitor mostrava cada posicao sozinha e, por isso, escondia os dois
// problemas mais caros, que so existem no CONJUNTO:
//
// 1. TRAVA. Em 02/09 havia MNQ comprado a 29.414 e MNQ vendido a 29.800 ao
//    mesmo tempo. Exposicao direcional zero: o indice pode ir para 25.000 ou
//    33.000 que o resultado somado nao muda — so corre custo. Olhando linha a
//    linha, uma aparecia ganhando 7.407 e a outra perdendo 2.775, e nada
//    dizia que uma anulava a outra.
// 2. POSICAO SEM STOP. As tres estavam sem stop e sem alvo, com a barra
//    lateral marcando "0 dias de disciplina". O painel media disciplina e
//    nao cobrava a unica coisa que a define.
//
// Estas contas nao substituem julgamento; elas colocam na tela o que o olho
// nao junta sozinho.
// ============================================================
function leituraDaMesa(positions){
  const semStop=positions.filter(p=>!p.hasStop);
  const porSimbolo=new Map();
  for(const p of positions){const atual=porSimbolo.get(p.symbol)||{long:[],short:[]};atual[p.direction==='LONG'?'long':'short'].push(p);porSimbolo.set(p.symbol,atual)}
  const travas=[...porSimbolo.entries()].filter(([,lados])=>lados.long.length&&lados.short.length).map(([symbol,lados])=>{
    const qtdLong=lados.long.reduce((soma,p)=>soma+Number(p.quantity),0),qtdShort=lados.short.reduce((soma,p)=>soma+Number(p.quantity),0);
    const resultado=[...lados.long,...lados.short].reduce((soma,p)=>soma+p.pnl,0);
    return {symbol,qtdLong,qtdShort,exposicaoLiquida:qtdLong-qtdShort,travada:Math.abs(qtdLong-qtdShort)<1e-9,resultadoSomado:resultado,currency:lados.long[0]?.currency||lados.short[0]?.currency||'USDT'};
  });
  const porMoeda={};for(const p of positions){const moeda=p.currency||'USDT';porMoeda[moeda]=(porMoeda[moeda]||0)+p.pnl}
  const avisos=[];
  for(const t of travas)avisos.push({level:t.travada?'warning':'info',title:`${t.symbol}: posicoes opostas abertas`,message:t.travada?`${t.qtdLong} comprado(s) contra ${t.qtdShort} vendido(s). Exposicao direcional zero: o preco pode ir para qualquer lado que o resultado somado nao muda. Resultado travado em ${t.resultadoSomado.toFixed(2)} ${t.currency}.`:`${t.qtdLong} comprado(s) e ${t.qtdShort} vendido(s). Exposicao liquida de ${(t.qtdLong-t.qtdShort).toFixed(4)}; o resto esta travado.`});
  if(semStop.length)avisos.push({level:'danger',title:`${semStop.length} posicao(oes) sem stop`,message:`${semStop.map(p=>p.symbol).join(', ')}. Sem stop nao existe perda maxima: existe o preco que o mercado quiser.`});
  return {leitura:{semStop:semStop.length,semPlano:positions.filter(p=>!p.hasPlan).length,travas,resultadoPorMoeda:porMoeda,avisos}};
}

async function monitorPositions(){
  const watches=await positionWatches(),positions=[];
  const errors=[];
  for(const watch of watches){let price;try{price=await publicPrice(watch.symbol)}catch(error){errors.push({id:watch.id,symbol:watch.symbol,error:error.message});continue}const isLong=watch.direction==='LONG',multiplier=watch.symbol==='MNQ'?2:1,currency=watch.symbol==='MNQ'?'USD':'USDT',peak=isLong?Math.max(watch.peak_price,price):Math.min(watch.peak_price,price),pnl=(isLong?price-watch.entry:watch.entry-price)*watch.quantity*multiplier,pnlPct=(isLong?price/watch.entry-1:watch.entry/price-1)*100,moveFromPeak=(isLong?price/peak-1:peak/price-1)*100,events=[];if(watch.stop&&(isLong?price<=watch.stop:price>=watch.stop))events.push({level:'danger',title:`STOP atingido: ${watch.symbol}`,message:`Preço ${price}. Stop planejado ${watch.stop}.`});if(watch.target&&(isLong?price>=watch.target:price<=watch.target))events.push({level:'info',title:`ALVO atingido: ${watch.symbol}`,message:`Preço ${price}. Alvo planejado ${watch.target}.`});if(watch.trailing_pct&&Math.abs(moveFromPeak)>=watch.trailing_pct)events.push({level:'warning',title:`Devolução do movimento: ${watch.symbol}`,message:`Preço recuou ${Math.abs(moveFromPeak).toFixed(2)}% desde o melhor preço ${peak}.`});await updatePositionWatch(watch.id,peak);if(events.length)await saveAlerts(events.map(event=>({kind:'position',symbol:watch.symbol,...event,fingerprint:`position-${watch.id}-${event.title.split(':')[0]}-${new Date().toISOString().slice(0,13)}`,payload:{watchId:watch.id,price,pnl,pnlPct,peak}})));const giveBackValue=Math.abs(peak-price)*watch.quantity*multiplier,peakPnl=(isLong?peak-watch.entry:watch.entry-peak)*watch.quantity*multiplier,hasStop=Boolean(watch.stop),hasTarget=Boolean(watch.target),distanceToStopPct=hasStop?(isLong?price/watch.stop-1:watch.stop/price-1)*100:null,distanceToTargetPct=hasTarget?(isLong?watch.target/price-1:price/watch.target-1)*100:null;positions.push({...watch,currentPrice:price,peakPrice:peak,pnl,pnlPct,moveFromPeak,giveBackValue,peakPnl,hasStop,hasTarget,hasPlan:hasStop&&hasTarget,distanceToStopPct,distanceToTargetPct,events,currency,multiplier,feed:watch.symbol==='MNQ'?'CME via feed público':'Binance'})}return {positions,errors,...leituraDaMesa(positions),updatedAt:new Date().toISOString()};
}

function ema(values,period){if(!values.length)return 0;const k=2/(period+1);return values.slice(1).reduce((value,item)=>item*k+value*(1-k),values[0])}
function atr(candles,period=14){const ranges=candles.map((c,i)=>Math.max(c.high-c.low,i?Math.abs(c.high-candles[i-1].close):0,i?Math.abs(c.low-candles[i-1].close):0));const sample=ranges.slice(-period);return sample.length?sample.reduce((a,b)=>a+b,0)/sample.length:0}
function rsi(values,period=14){if(values.length<2)return 50;const changes=values.slice(1).map((v,i)=>v-values[i]).slice(-period),gain=changes.reduce((s,v)=>s+Math.max(v,0),0)/changes.length,loss=changes.reduce((s,v)=>s+Math.max(-v,0),0)/changes.length;return loss?100-(100/(1+gain/loss)):100}
async function publicKlines(symbol,interval,limit=120){const response=await fetch(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),data=await response.json();if(!response.ok)throw new Error(data.msg||'Candles indisponíveis.');return data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),quoteVolume:Number(row[7])}))}

async function mnqCandles(){
  const end=Math.floor(Date.now()/1000),start=end-59*24*60*60,url=`https://query1.finance.yahoo.com/v8/finance/chart/MNQ=F?period1=${start}&period2=${end}&interval=15m&includePrePost=true`;
  const response=await fetch(url,{headers:{'user-agent':'BaladaTrade/1.0'}}),payload=await response.json(),result=payload.chart?.result?.[0];
  if(!response.ok||!result)throw new Error(payload.chart?.error?.description||'Candles do MNQ indisponíveis no provedor público.');
  const quote=result.indicators?.quote?.[0]||{};
  return (result.timestamp||[]).map((time,i)=>({time:time*1000,open:Number(quote.open?.[i]),high:Number(quote.high?.[i]),low:Number(quote.low?.[i]),close:Number(quote.close?.[i]),volume:Number(quote.volume?.[i]||0)})).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
}
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

async function spotAgentAudit(plan,market={}){
  if(!process.env.ANTHROPIC_API_KEY)throw new Error('Auditor Claude ainda não configurado.');
  const safeMarket={symbol:plan.symbol,price:Number(market.price||0),alignment:String(market.alignment||''),risk:market.risk||{},strategy:market.strategy||{},warnings:Array.isArray(market.warnings)?market.warnings.slice(0,10):[],generatedAt:market.generatedAt||null};
  const safePlan={symbol:plan.symbol,direction:plan.direction,capital:plan.capital,riskPct:plan.riskPct,riskBudget:plan.riskBudget,entry:plan.entry,stop:plan.stop,target:plan.target,quantity:plan.quantity,notional:plan.notional,lossNet:plan.lossNet,gainNet:plan.gainNet,riskRewardNet:plan.riskRewardNet,allowed:plan.allowed,blockers:plan.blockers,execution:'MANUAL_ONLY',automation:'DISABLED'};
  const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
  const auditSchema={type:'object',additionalProperties:false,properties:{verdict:{type:'string',enum:['APROVADO_PARA_AVALIACAO','AGUARDAR','BLOQUEADO','DADOS_INSUFICIENTES']},summary:{type:'string'},checks:{type:'array',items:{type:'object',additionalProperties:false,properties:{rule:{type:'string'},status:{type:'string',enum:['PASS','FAIL','WARNING']},evidence:{type:'string'}},required:['rule','status','evidence']}},risks:{type:'array',items:{type:'string'}},nextCondition:{type:'string'},confidence:{type:'number'}},required:['verdict','summary','checks','risks','nextCondition','confidence']};
  const message=await client.messages.create({model:process.env.ANTHROPIC_MODEL||'claude-sonnet-4-6',max_tokens:1600,temperature:.1,output_config:{format:{type:'json_schema',schema:auditSchema}},system:'Você é o Auditor Claude do BaladaTrade. Audite apenas os números recebidos. Não dê ordem de compra, não prometa lucro, não altere entrada/stop/alvo/quantidade e jamais aprove um plano com allowed=false. execution=MANUAL_ONLY e automation=DISABLED são proteções esperadas, não falhas. Use confidence como percentual de 0 a 100. Seja conciso: no máximo 8 checks e 5 risks.',messages:[{role:'user',content:`Audite este plano Binance Spot manual. Plano: ${JSON.stringify(safePlan)} Mercado: ${JSON.stringify(safeMarket)}`}]},{signal:AbortSignal.timeout(30000)});
  const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('').replace(/^```json\s*|\s*```$/g,'');let audit;try{audit=JSON.parse(text)}catch{throw new Error('Claude retornou uma auditoria inválida.');}
  const verdicts=new Set(['APROVADO_PARA_AVALIACAO','AGUARDAR','BLOQUEADO','DADOS_INSUFICIENTES']);if(!verdicts.has(audit.verdict))throw new Error('Claude retornou um veredito inválido.');if(!plan.allowed&&audit.verdict==='APROVADO_PARA_AVALIACAO')audit.verdict='BLOQUEADO';
  audit.confidence=Math.max(0,Math.min(100,Number(audit.confidence)||0));
  return {audit,model:message.model,generatedAt:new Date().toISOString(),execution:'MANUAL_ONLY',disclaimer:'Auditoria educacional; a decisão e a execução permanecem manuais.'};
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
  if (pathname === '/api/system/health' && req.method === 'GET') return json(res,200,{app:true,database:await databaseHealth(),marketFeed:'Binance público',updatedAt:new Date().toISOString()});
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
    if (pathname === '/api/mnq/profiles' && req.method === 'GET') return json(res,200,{profiles:PROP_PROFILES,ruleSets:{tpt:TPT_RULES,lucid:LUCID_RULES},contract:{symbol:'MNQ',pointValue:2,tickSize:.25,tickValue:.5},execution:'SIMULATION_ONLY',updatedAt:new Date().toISOString()});
    if (pathname === '/api/mnq/analyze' && req.method === 'POST') {
      const data=await body(req),candles=Array.isArray(data.candles)&&data.candles.length?data.candles:await mnqCandles(),profile=String(data.profile||'tpt_test'),accountSize=Number(data.accountSize||50000),requestedContracts=Math.max(1,Math.floor(Number(data.contracts)||1)),stopDollar=Number(data.stopDollar||100),targetDollar=Number(data.targetDollar||130),riskBudget=stopDollar;
      if(!PROP_PROFILES[profile]||!ACCOUNT_RULES[accountSize]||!(stopDollar>0)||!(targetDollar>0))return json(res,400,{error:'Stop e take em dólar devem ser maiores que zero.'});
      const setup=detectSetup(candles,{bosBufferAtr:Number(data.bosBufferAtr||.1),contracts:requestedContracts,stopDollar,targetDollar}),risk=riskState({profile,accountSize,startBalance:Number(data.startBalance||accountSize),balance:Number(data.balance||accountSize),openPnl:Number(data.openPnl||0),peakEquity:Number(data.peakEquity||data.balance||accountSize),peakClosedBalance:Number(data.peakClosedBalance||data.balance||accountSize),sessionStartBalance:Number(data.sessionStartBalance||data.balance||accountSize),dllEnabled:data.dllEnabled!==false,dailyLoss:Number(data.dailyLoss||0)}),contracts=Math.min(requestedContracts,risk.maxMicros);
      const blockers=[];if(risk.blocked)blockers.push('Limite de perda da conta atingido.');if(risk.warning)blockers.push('Menos de 20% do drawdown disponível.');if(requestedContracts>risk.maxMicros)blockers.push(`O perfil permite no máximo ${risk.maxMicros} micros.`);if(data.newsWindow&&risk.newsAllowed===false)blockers.push('Janela de notícia proibida: permaneça sem posição e sem ordens.');if(setup.state!=='ENTRADA_CONFIRMADA')blockers.push(setup.reason);if(setup.state==='ENTRADA_CONFIRMADA'&&!setup.entryValid)blockers.push('TRAVA DE SEGURANÇA: entrada calculada fora da zona Fibonacci.');if(setup.state==='ENTRADA_CONFIRMADA'&&setup.riskUsdTotal>riskBudget)blockers.push(`Stop total de US$ ${setup.riskUsdTotal.toFixed(2)} supera o risco por operação.`);if(setup.state==='ENTRADA_CONFIRMADA'&&setup.riskUsdTotal>risk.remaining)blockers.push('O stop ultrapassa o drawdown restante da conta.');
      return json(res,200,{instrument:'MNQ',timeframe:'15m',setup,risk,contracts,riskBudget,allowed:blockers.length===0,blockers,candles:candles.slice(-180),contract:{pointValue:2,tickSize:.25,tickValue:.5},execution:risk.automation==='SIGNAL_ONLY'?'SIGNAL_ONLY':'SIMULATION_ONLY',updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/mnq/backtest' && req.method === 'POST') {
      const data=await body(req),candles=Array.isArray(data.candles)&&data.candles.length?data.candles:await mnqCandles(),stopDollar=Number(data.stopDollar||100),targetDollar=Number(data.targetDollar||130),maxMicros=Math.max(1,Math.min(100,Number(data.maxMicros||1)));
      if(!(stopDollar>0)||!(targetDollar>0))return json(res,400,{error:'Stop e take em dólar devem ser maiores que zero.'});
      return json(res,200,{instrument:'MNQ',timeframe:'15m',...backtest(candles,{riskBudget:stopDollar,stopDollar,targetDollar,maxMicros,bosBufferAtr:Number(data.bosBufferAtr||.1)}),candles:candles.length,execution:'SIMULATION_ONLY',warning:'Resultado histórico não garante resultado futuro. Dados públicos podem conter atrasos ou lacunas.'});
    }
    if (pathname === '/api/market/radar' && req.method === 'GET') {const coins=await marketRadar(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||50));return json(res,200,{coins,alerts:marketAlerts(coins),updatedAt:new Date().toISOString()});}
    if (pathname === '/api/market/symbols' && req.method === 'GET') {
      const response=await fetch(`${marketBase()}/api/v3/exchangeInfo`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Lista de mercados indisponível.');
      const symbols=data.symbols.filter(item=>item.status==='TRADING').map(item=>({symbol:item.symbol,base:item.baseAsset,quote:item.quoteAsset,spot:item.isSpotTradingAllowed}));
      return json(res,200,{symbols,count:symbols.length,updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/market/klines' && req.method === 'GET') {
      const url=new URL(req.url,'http://localhost'),symbol=normalizeMarketSymbol(url.searchParams.get('symbol')),interval=String(url.searchParams.get('interval')||'1d');
      if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!['15m','1h','4h','1d','1w'].includes(interval))return json(res,400,{error:'Par ou intervalo inválido.'});
      const response=await fetch(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Gráfico indisponível.');
      return json(res,200,{symbol,interval,candles:data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])}))});
    }
    if (pathname === '/api/market/pretrade' && req.method === 'GET') {
      const symbol=normalizeMarketSymbol(new URL(req.url,'http://localhost').searchParams.get('symbol'));
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
      const fast=frames[0],atrUnit=fast.atr||price*.01;let strategy={action:'SEM SETUP',direction:null,reason:'Tendência, posição e momentum ainda não oferecem uma regra clara.',entryZone:null,stop:null,target:null,riskPct:.5,minRiskReward:2};
      if(rangePosition>=85||fast.rsi>=72)strategy={...strategy,action:'ESPERAR',reason:'Preço esticado perto da máxima ou RSI elevado. A estratégia espera pullback e novo candle de confirmação.',entryZone:{from:fast.ema20-atrUnit*.2,to:fast.ema20+atrUnit*.2}};
      else if(aligned==='ALTA'&&fast.rsi>=42&&fast.rsi<=68&&fast.volumeRatio>=.8){const entry=fast.ema20,stop=entry-atrUnit,target=entry+atrUnit*2;strategy={...strategy,action:'PULLBACK LONG',direction:'LONG',reason:'Períodos em alta, RSI não extremo e preço em região planejável.',entryZone:{from:entry-atrUnit*.2,to:entry+atrUnit*.2},stop,target}}
      else if(aligned==='BAIXA'&&fast.rsi>=35&&fast.rsi<=60){const entry=fast.ema20,stop=entry+atrUnit,target=entry-atrUnit*2;strategy={...strategy,action:'CONTINUAÇÃO SHORT',direction:'SHORT',reason:'Períodos em baixa sem sobrevenda extrema. Exige confirmação abaixo da EMA20.',entryZone:{from:entry-atrUnit*.2,to:entry+atrUnit*.2},stop,target}}
      const warnings=[];if(rangePosition>=90)warnings.push('Preço nos 10% superiores do intervalo de 24h: risco de perseguir alta.');if(amplitude>=10)warnings.push('Amplitude diária acima de 10%: volatilidade extrema.');if(frames[0].volumeRatio>=2)warnings.push('Volume de 15m acima de 2x a média recente.');if(frames[0].rsi>=75)warnings.push('RSI de 15m sobrecomprado; continuação não é garantida.');if(aligned==='MISTA')warnings.push('Períodos não estão alinhados; movimento pode ser apenas ruído curto.');if(spreadPct>=.2)warnings.push('Spread elevado: entrada e saída podem ter slippage relevante.');
      const scan={symbol,price,open:Number(ticker.openPrice),high,low,change24h:Number(ticker.priceChangePercent),quoteVolume:Number(ticker.quoteVolume),amplitude,rangePosition,distanceHighPct:high?(price-high)/high*100:0,frames,alignment:aligned,warnings,risk:{score:riskPoints,label:riskLabel},strategy,marketAccess:{spot:Boolean(market.isSpotTradingAllowed),crossMargin,isolatedMargin,maxLeverage:isolatedMargin?10:crossMargin?5:1,note:'O selo indica elegibilidade do par, não limite disponível nem autorização para tomar empréstimo.'},orderBook:{bestBid,bestAsk,spreadPct,bidDepth,askDepth,imbalancePct:bookImbalance},generatedAt:new Date().toISOString()};
      const saved=await saveMarketScan(scan).catch(()=>null);return json(res,200,{...scan,savedScanId:saved?.id||null});
    }
    if (pathname === '/api/market/scans' && req.method === 'GET') {const url=new URL(req.url,'http://localhost'),symbol=String(url.searchParams.get('symbol')||'').toUpperCase();if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{error:'Par inválido.'});return json(res,200,{symbol,scans:await marketScanHistory(symbol,Number(url.searchParams.get('limit')||50))});}
    if (pathname === '/api/spot/plan' && req.method === 'POST') {
      const data=await body(req),symbol=normalizeMarketSymbol(data.symbol);
      if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!symbol.endsWith('USDT'))return json(res,400,{error:'Escolha um par Spot cotado em USDT.'});
      const response=await fetch(`${marketBase()}/api/v3/exchangeInfo?symbol=${symbol}`,{signal:AbortSignal.timeout(10000)}),info=await response.json();if(!response.ok)throw new Error(info.msg||'Filtros do par indisponíveis.');const market=info.symbols?.[0];if(!market||market.status!=='TRADING'||!market.isSpotTradingAllowed)return json(res,400,{error:'Este par não está disponível para Spot.'});
      const plan=calculateSpotPlan({symbol,capital:Number(data.capital),riskPct:Number(data.riskPct),entry:Number(data.entry),stop:Number(data.stop),target:Number(data.target),feeRate:data.feeRate===undefined ? .001 : Number(data.feeRate),filters:market.filters});
      // 02/09/2026 — ENTRADA ESTICADA. O scanner marcou ARBUSDT como PULLBACK
      // LONG a 0,1233; quando a tela de trade abriu, o par estava 0,1322 —
      // +7,2%. O pullback que gerou o sinal ja tinha sido comprado, e nada na
      // tela dizia isso. Buscar o preco agora custa uma chamada e transforma
      // "entrada que parecia boa" em "entrada X% acima do mercado".
      const precoAgora=await publicPrice(symbol).catch(()=>null);
      const desvioPct=precoAgora?(Number(data.entry)/precoAgora-1)*100:null;
      const contexto={precoAgora,desvioPct,esticada:desvioPct!==null&&desvioPct>1.5,abaixoDoMercado:desvioPct!==null&&desvioPct<-1.5};
      return json(res,200,{plan,contexto,market:{baseAsset:market.baseAsset,quoteAsset:market.quoteAsset,status:market.status},updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/market/setups' && req.method === 'GET') return json(res,200,await setupScanner());
    if (pathname === '/api/margin/monitor' && req.method === 'GET') return json(res,200,await marginMonitor());
    if (pathname === '/api/trade-plans' && req.method === 'GET') {const url=new URL(req.url,'http://localhost'),symbol=String(url.searchParams.get('symbol')||'').toUpperCase();return json(res,200,{plans:await tradePlanHistory(symbol,Number(url.searchParams.get('limit')||50))});}
    if (pathname === '/api/trade-plans/evaluate' && req.method === 'POST') return json(res,200,await evaluatePlans());
    if (pathname === '/api/trade-plans' && req.method === 'POST') {const data=await body(req),symbol=String(data.symbol||'').toUpperCase(),numbers=['entry','stop','target','capital','riskPct','riskMoney','quantity','leverage','riskReward'];if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!['LONG','SHORT'].includes(data.direction)||numbers.some(key=>!Number.isFinite(Number(data[key]))||Number(data[key])<=0))return json(res,400,{error:'Plano inválido.'});const saved=await saveTradePlan({...data,symbol,...Object.fromEntries(numbers.map(key=>[key,Number(data[key])]))});return json(res,201,{ok:true,saved});}
    if (pathname === '/api/binance/trades' && req.method === 'GET') {
      const url=new URL(req.url,'http://localhost'),symbol=String(url.searchParams.get('symbol')||'').toUpperCase();
      if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{error:'Par inválido.'});
      const spot=await signedBinance('/api/v3/myTrades','GET',{symbol,limit:'500'}).catch(error=>Object.assign([],{_error:error.message}));
      const warnings=[];if(spot._error)warnings.push(`Spot: ${spot._error}`);
      return json(res,200,{symbol,spot:summarizeTrades(spot,'Spot'),warnings,scope:'SPOT_READ_ONLY',updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/paper/account' && req.method === 'GET') return json(res,200,await paperSummary());
    if (pathname === '/api/ledger' && req.method === 'GET') return json(res,200,await ledgerData(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||200)));
    if (pathname === '/api/ledger/sync-binance' && req.method === 'POST') return json(res,200,{ok:true,...await syncBinancePay(),ledger:await ledgerData(200)});
    if (pathname === '/api/alerts' && req.method === 'GET') return json(res,200,{alerts:await alertHistory(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||100)),whatsappConfigured:Boolean(process.env.WHATSAPP_WEBHOOK_URL)});
    if (pathname === '/api/positions/assets' && req.method === 'GET') {
      let crypto=monitorAssetCache.assets,source='cache',stale=false;
      if(!crypto.length||Date.now()-monitorAssetCache.updatedAt>15*60*1000){
        try{const response=await fetch(`${marketBase()}/api/v3/exchangeInfo`,{signal:AbortSignal.timeout(10000)}),data=await response.json();if(!response.ok)throw new Error(data.msg||'Catálogo indisponível.');const preferred=monitorFallback.map(x=>x.symbol);crypto=(data.symbols||[]).filter(item=>item.status==='TRADING'&&item.isSpotTradingAllowed&&item.quoteAsset==='USDT'&&!/(UP|DOWN|BULL|BEAR)$/.test(item.baseAsset)).map(item=>({symbol:item.symbol,label:`${item.baseAsset} / USDT`,market:'Cripto · Binance',quantityLabel:item.baseAsset,feed:'Binance'})).sort((a,b)=>{const ai=preferred.indexOf(a.symbol),bi=preferred.indexOf(b.symbol);if(ai>=0||bi>=0)return (ai<0?999:ai)-(bi<0?999:bi);return a.label.localeCompare(b.label)});monitorAssetCache={assets:crypto,updatedAt:Date.now()};source='Binance'}catch(error){crypto=crypto.length?crypto:monitorFallback;source=monitorAssetCache.assets.length?'cache':'fallback';stale=true}}
      const mnq={symbol:'MNQ',label:'MNQ · Micro E-mini Nasdaq-100',market:'Futuros EUA',quantityLabel:'Contratos',feed:'Yahoo Finance indicativo'};
      return json(res,200,{assets:[mnq,...crypto],count:crypto.length+1,source,stale,updatedAt:new Date(monitorAssetCache.updatedAt||Date.now()).toISOString()});
    }
    if (pathname === '/api/positions/quote' && req.method === 'GET') {const symbol=String(new URL(req.url,'http://localhost').searchParams.get('symbol')||'').toUpperCase();if(!/^(MNQ|[A-Z0-9]{5,20})$/.test(symbol))return json(res,400,{error:'Ativo inválido.'});return json(res,200,{symbol,price:await publicPrice(symbol),currency:symbol==='MNQ'?'USD':'USDT',feed:symbol==='MNQ'?'CME via feed público':'Binance',updatedAt:new Date().toISOString()});}
    if (pathname === '/api/positions/monitor' && req.method === 'GET') return json(res,200,await monitorPositions());
    if (pathname === '/api/positions/watch' && req.method === 'POST') {const data=await body(req),symbol=String(data.symbol||'').toUpperCase(),direction=String(data.direction||'LONG').toUpperCase(),entry=Number(data.entry),quantity=Number(data.quantity),stop=Number(data.stop||0),target=Number(data.target||0),trailingPct=Number(data.trailingPct||0);if(!/^(MNQ|[A-Z0-9]{5,20})$/.test(symbol)||!['LONG','SHORT'].includes(direction)||!Number.isFinite(entry)||entry<=0||!Number.isFinite(quantity)||quantity<=0||trailingPct<0||trailingPct>20)return json(res,400,{error:'Monitor inválido.'});await publicPrice(symbol);const saved=await savePositionWatch({symbol,direction,entry,quantity,stop,target,trailingPct});return json(res,201,{ok:true,saved,monitor:await monitorPositions()});}
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
    if (pathname === '/api/ai/spot-audit' && req.method === 'POST') {const data=await body(req);if(!data.plan||typeof data.plan!=='object')return json(res,400,{error:'Calcule o plano Spot antes da auditoria.'});return json(res,200,await spotAgentAudit(data.plan,data.market||{}));}
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
module.exports = {handler,leituraDaMesa,peneira};
