const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const {PROP_PROFILES,ACCOUNT_RULES,TPT_RULES,LUCID_RULES,riskState,detectSetup,backtest}=require('./mnq-engine');
const {simularOrdem,margemParaRisco}=require('./calculadora-de-ordem');
const {calculateSpotPlan,roundStep:roundStepSpot,floorStep:floorStepSpot}=require('./spot-engine');
const {criarLimites}=require('./limites');
const {lerPosicao,perdaDoDia}=require('./resultado');
const {ordensDaMesa,resumoDoGuardiao,ordemDoGuardiao}=require('./guardiao-do-lucro');
const {normalizarConfig,escolherCandidato,precosDoTrade,decidir:decidirRobo,contarPosicoes,minhasOrdens,entradasVencidas,CONFIG_PADRAO}=require('./robo');
const {initDatabase,databaseHealth,saveSnapshot,history,portfolioBaseline,paperData,paperOrder,ledgerData,addLedgerEntry,deleteLedgerEntry,importLedgerEntries,saveMarketScan,marketScanHistory,saveTradePlan,tradePlanHistory,closeTradePlan,saveAlerts,alertHistory,savePositionWatch,positionWatches,updatePositionWatch,salvarDecisao,marcarDecisaoEnviada,decisoesDoRobo,ordensDoRoboHoje,estadoDoRobo,salvarEstadoDoRobo,abrirPosicao,posicoesEmAberto,atualizarPosicao,posicoesFechadasHoje,posicoesDoRobo}=require('./db');

const root = path.join(__dirname, 'public');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
let monitorAssetCache={assets:[],updatedAt:0};
const monitorFallback=['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK','AVAX','CAKE'].map(asset=>({symbol:`${asset}USDT`,label:`${asset} / USDT`,market:'Cripto · Binance',quantityLabel:asset,feed:'Binance'}));
const MAX_BODY_BYTES=1024*1024,LOGIN_WINDOW_MS=15*60*1000,LOGIN_MAX_FAILURES=5;
const loginFailures=new Map();
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()}
function loginBlocked(ip,now=Date.now()){const r=loginFailures.get(ip);if(!r)return false;if(now-r.startedAt>=LOGIN_WINDOW_MS){loginFailures.delete(ip);return false}return r.count>=LOGIN_MAX_FAILURES}
function recordLoginFailure(ip,now=Date.now()){const r=loginFailures.get(ip);if(!r||now-r.startedAt>=LOGIN_WINDOW_MS)loginFailures.set(ip,{count:1,startedAt:now});else r.count+=1}
function sameOrigin(req){if(String(req.headers['sec-fetch-site']||'').toLowerCase()==='cross-site')return false;const origin=req.headers.origin;if(!origin)return true;const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();try{return Boolean(host)&&new URL(origin).host===host}catch{return false}}
function applySecurityHeaders(req,res){res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests");res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=(), payment=()');if(String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https')res.setHeader('strict-transport-security','max-age=31536000; includeSubDomains')}
function ordensDoRoboParaPanico(abertas=[]){return abertas.filter(o=>String(o?.clientOrderId||'').startsWith('bt'))}

function json(res, status, payload) {
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const index = value.indexOf('=');
    try{return [value.slice(0,index).trim(),decodeURIComponent(value.slice(index+1))]}catch{return ['', '']}
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
  if(!String(req.headers['content-type']||'').toLowerCase().includes('application/json')){const error=new Error('Envie JSON com Content-Type application/json.');error.statusCode=415;throw error}
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>MAX_BODY_BYTES){const error=new Error('Corpo da requisição excede 1 MB.');error.statusCode=413;throw error}chunks.push(chunk)}
  try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{const error=new Error('JSON inválido.');error.statusCode=400;throw error}
}

// A Binance recusa qualquer ordem Spot abaixo de ~5 USDT (MIN_NOTIONAL). Um
// teto menor que isso nao "protege": impede o robo de existir, e sem avisar.
const MINIMO_NEGOCIAVEL = 5;

/** Le um numero do ambiente com honestidade.
 *
 *  `Number(process.env.X || 100)` parece certo e nao e: a string '0' e
 *  TRUTHY, entao `'0' || 100` devolve '0' e o teto vira zero. Foi exatamente
 *  isso que apareceu na tela do Bruno em 07/09 — "Teto por ordem: 0" — e com
 *  teto zero NENHUMA ordem passa, nunca, sem nenhuma mensagem explicando. */
function numeroDoAmbiente(nome, padrao, minimo = 0) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === null || String(bruto).trim() === '') return padrao;
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor < minimo) return padrao;
  return valor;
}

function binanceConfig() {
  return {
    key: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    base: process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision',
    live: process.env.ENABLE_LIVE_TRADING === 'true',
    max: numeroDoAmbiente('MAX_ORDER_NOTIONAL', 100, MINIMO_NEGOCIAVEL),
  };
}

// ============================================================
// FUTURES — onde a alavancagem realmente mora (05/09/2026)
//
// `signedBinance` fala com api.binance.com, que é o SPOT. Posição de 10x não
// existe lá: ela vive em fapi.binance.com, o Futures USDT-M. Eram dois
// endereços diferentes, e por isso o painel nunca conseguiu ver a posição
// alavancada que o Bruno abre de verdade.
//
// A chave é a MESMA; muda só o endereço e o caminho.
// ============================================================
function futuresBase() {
  return process.env.BINANCE_FUTURES_URL || 'https://fapi.binance.com';
}

async function signedFutures(endpoint, method='GET', params={}) {
  const cfg = binanceConfig();
  if (!cfg.key || !cfg.secret) throw new Error('Binance ainda não configurada no servidor.');
  const query = new URLSearchParams({...params, recvWindow:'5000', timestamp:String(Date.now())});
  query.set('signature', crypto.createHmac('sha256', cfg.secret).update(query.toString()).digest('hex'));
  const response = await fetch(`${futuresBase()}${endpoint}?${query}`, {method, headers:{'X-MBX-APIKEY':cfg.key}});
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || `Binance Futures respondeu ${response.status}`);
  return data;
}

/**
 * AS POSIÇÕES ALAVANCADAS, AO VIVO.
 *
 * A Binance já calcula e devolve o que a tela dela esconde em abas
 * diferentes: preço de liquidação, alavancagem, margem e resultado não
 * realizado. Aqui tudo aparece na mesma linha.
 *
 * Só entra o que tem quantidade diferente de zero — a Binance devolve TODOS
 * os pares, e a lista sem filtro passa de 300 linhas vazias.
 */
async function posicoesAlavancadas() {
  const cru = await signedFutures('/fapi/v2/positionRisk');
  return (Array.isArray(cru) ? cru : [])
    .filter(p => Number(p.positionAmt) !== 0)
    .map(p => {
      const qtd = Number(p.positionAmt);
      const entrada = Number(p.entryPrice);
      const marca = Number(p.markPrice);
      const direcao = qtd > 0 ? 'LONG' : 'SHORT';
      const notional = Math.abs(qtd) * marca;
      const liq = Number(p.liquidationPrice);
      return {
        simbolo: p.symbol,
        direcao,
        quantidade: Math.abs(qtd),
        precoEntrada: entrada,
        precoAtual: marca,
        alavancagem: Number(p.leverage),
        margem: Number(p.isolatedMargin) || (notional / (Number(p.leverage) || 1)),
        isolada: p.marginType === 'isolated',
        valorDaPosicao: notional,
        lucroAberto: Number(p.unRealizedProfit),
        precoDeLiquidacao: liq > 0 ? liq : null,
        // A distância até a liquidação é o número que decide se dá para
        // dormir com a posição aberta — e a Binance nunca mostra em %.
        distanciaAteLiquidacaoPct: liq > 0 ? Math.abs((liq / marca - 1) * 100) : null,
      };
    });
}

// O limitador e um so para o processo inteiro: o teto de peso da Binance e por
// IP, entao o robo, o radar e os graficos gastam do mesmo bolso. Ter um
// contador por modulo seria o mesmo que nao ter contador.
const limites = criarLimites({teto: Number(process.env.BINANCE_PESO_MAX || 6000)});

/** Chamada publica com o peso contabilizado. Nao assina nada, mas gasta do
 *  mesmo limite — e o scanner faz cinquenta destas por ciclo. */
async function fetchPublico(url, opcoes={}) {
  const permissao = limites.podeChamar();
  if (!permissao.pode) throw new Error(`Binance em espera: ${permissao.motivo}`);
  const response = await fetch(url, {signal: AbortSignal.timeout(10000), ...opcoes});
  limites.registrar(response.status, response.headers);
  return response;
}

async function signedBinance(endpoint, method='GET', params={}) {
  const cfg = binanceConfig();
  if (!cfg.key || !cfg.secret) throw new Error('Binance ainda não configurada no servidor.');
  // Parar aqui e o que evita o 418. Depois de um 429, insistir nao acelera
  // nada: aumenta o banimento, que comeca em minutos e chega a dias.
  const permissao = limites.podeChamar();
  if (!permissao.pode) throw new Error(`Binance em espera: ${permissao.motivo}`);
  const query = new URLSearchParams({...params, recvWindow:'5000', timestamp:String(Date.now())});
  query.set('signature', crypto.createHmac('sha256', cfg.secret).update(query.toString()).digest('hex'));
  const response = await fetch(`${cfg.base}${endpoint}?${query}`, {method,headers:{'X-MBX-APIKEY':cfg.key},signal:AbortSignal.timeout(10000)});
  limites.registrar(response.status, response.headers);
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || `Binance respondeu ${response.status}`);
  return data;
}

// ============================================================
// MESA EARN — 03/09/2026
//
// O que a tela da Binance nao responde: quanto do meu dinheiro esta PARADO.
// Em 03/09/2026 o Earn do Bruno mostrava quatro posicoes rendendo — C, HEMI,
// OPG e USDC — somando cerca de cinco centavos de dolar, enquanto 14,19 USDT
// dormiam na carteira Spot a 0% ao ano. A tela da corretora exibe o que esta
// aplicado; ela nao cobra o que nao esta.
//
// Simple Earn Flexible resgata na hora, entao capital de trade parado entre
// operacoes nao precisa render zero. O calculo aqui e deliberadamente honesto:
// mostra o ganho anual em dinheiro, nao so o APR em percentual. Em conta
// pequena, "7,52% ao ano" soa muito e vale centavos — e quem decide com o
// numero certo na frente decide melhor.
// ============================================================
async function earnOverview(){
  const [posicoes,catalogo,conta,precos]=await Promise.all([
    signedBinance('/sapi/v1/simple-earn/flexible/position','GET',{current:'1',size:'100'}).catch(e=>({rows:[],_error:e.message})),
    signedBinance('/sapi/v1/simple-earn/flexible/list','GET',{current:'1',size:'100'}).catch(e=>({rows:[],_error:e.message})),
    signedBinance('/api/v3/account').catch(e=>({balances:[],_error:e.message})),
    fetch(`${binanceConfig().base}/api/v3/ticker/price`).then(r=>r.json()).catch(()=>[]),
  ]);
  const porSimbolo=new Map((Array.isArray(precos)?precos:[]).map(x=>[x.symbol,Number(x.price)]));
  const estaveis=new Set(['USDT','USDC','FDUSD','TUSD','USDP','DAI']);
  const emDolar=(ativo,quantidade)=>{
    const q=Number(quantidade)||0;
    if(estaveis.has(ativo))return q;
    return q*(porSimbolo.get(`${ativo}USDT`)||porSimbolo.get(`${ativo}USDC`)||0);
  };
  // APR por ativo: o catalogo traz varios produtos por moeda; fica o melhor.
  const melhorApr=new Map();
  for(const linha of catalogo.rows||[]){
    const apr=Number(linha.latestAnnualPercentageRate||0)*100;
    if(!melhorApr.has(linha.asset)||apr>melhorApr.get(linha.asset).apr)melhorApr.set(linha.asset,{apr,podeSubscrever:linha.canPurchase!==false,produtoId:linha.productId});
  }
  const aplicado=(posicoes.rows||[]).map(linha=>{
    const quantidade=Number(linha.totalAmount||0),valor=emDolar(linha.asset,quantidade);
    const apr=Number(linha.latestAnnualPercentageRate||0)*100||melhorApr.get(linha.asset)?.apr||0;
    return {ativo:linha.asset,quantidade,valorUsd:valor,apr,ganhoAnualUsd:valor*apr/100,
            acumulado:Number(linha.cumulativeTotalRewards||linha.totalRewards||0),autoSubscribe:Boolean(linha.canRedeem&&linha.autoSubscribe)};
  }).sort((a,b)=>b.valorUsd-a.valorUsd);
  // O ponto cego: saldo livre na Spot que poderia estar rendendo.
  const parado=(conta.balances||[]).map(b=>{
    const livre=Number(b.free||0);if(!(livre>0))return null;
    const valor=emDolar(b.asset,livre),oferta=melhorApr.get(b.asset);
    if(!oferta||!oferta.podeSubscrever)return null;
    return {ativo:b.asset,quantidade:livre,valorUsd:valor,apr:oferta.apr,ganhoAnualUsd:valor*oferta.apr/100};
  }).filter(Boolean).sort((a,b)=>b.ganhoAnualUsd-a.ganhoAnualUsd);
  const totalAplicado=aplicado.reduce((soma,x)=>soma+x.valorUsd,0);
  const totalParado=parado.reduce((soma,x)=>soma+x.valorUsd,0);
  const ganhoAtualAno=aplicado.reduce((soma,x)=>soma+x.ganhoAnualUsd,0);
  const ganhoPotencialAno=parado.reduce((soma,x)=>soma+x.ganhoAnualUsd,0);
  const avisos=[];
  if(totalParado>totalAplicado*2&&totalParado>1)avisos.push({level:'warning',title:'A maior parte do seu saldo esta parada',
    message:`${totalParado.toFixed(2)} USD livres na Spot contra ${totalAplicado.toFixed(2)} USD aplicados. Flexible resgata na hora, entao capital entre operacoes nao precisa render zero.`});
  if(ganhoPotencialAno>0&&ganhoPotencialAno<1)avisos.push({level:'info',title:'O ganho cabe em centavos — decida com o numero, nao com o percentual',
    message:`Aplicar tudo que esta parado renderia cerca de ${ganhoPotencialAno.toFixed(4)} USD por ANO. APR alto em conta pequena continua sendo centavos.`});
  if(posicoes._error)avisos.push({level:'danger',title:'Posicoes do Earn indisponiveis',message:posicoes._error});
  return {aplicado,parado,totais:{totalAplicado,totalParado,ganhoAtualAno,ganhoPotencialAno,
          aprMedioPonderado:totalAplicado?ganhoAtualAno/totalAplicado*100:0},avisos,
          execution:'LEITURA_APENAS',updatedAt:new Date().toISOString()};
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
    fetchPublico(`${marketBase()}/api/v3/ticker/24hr`),
    fetchPublico(`${marketBase()}/api/v3/exchangeInfo`),
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
  const response=await fetchPublico(`${marketBase()}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),data=await response.json();
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
  const [account,tickers]=await Promise.all([signedBinance('/sapi/v1/margin/account'),fetchPublico(`${marketBase()}/api/v3/ticker/price`).then(r=>r.json())]),prices=new Map(tickers.map(x=>[x.symbol,Number(x.price)])),stable=new Set(['USDT','USDC','FDUSD','TUSD']);
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
  for(const watch of watches){let price;try{price=await publicPrice(watch.symbol)}catch(error){errors.push({id:watch.id,symbol:watch.symbol,error:error.message});continue}const isLong=watch.direction==='LONG',multiplier=watch.symbol==='MNQ'?2:1,currency=watch.symbol==='MNQ'?'USD':'USDT',peak=isLong?Math.max(watch.peak_price,price):Math.min(watch.peak_price,price),pnl=(isLong?price-watch.entry:watch.entry-price)*watch.quantity*multiplier,pnlPct=(isLong?price/watch.entry-1:watch.entry/price-1)*100,moveFromPeak=(isLong?price/peak-1:peak/price-1)*100,events=[];if(watch.stop&&(isLong?price<=watch.stop:price>=watch.stop))events.push({level:'danger',title:`STOP atingido: ${watch.symbol}`,message:`Preço ${price}. Stop planejado ${watch.stop}.`});if(watch.target&&(isLong?price>=watch.target:price<=watch.target))events.push({level:'info',title:`ALVO atingido: ${watch.symbol}`,message:`Preço ${price}. Alvo planejado ${watch.target}.`});if(watch.trailing_pct&&Math.abs(moveFromPeak)>=watch.trailing_pct)events.push({level:'warning',title:`Devolução do movimento: ${watch.symbol}`,message:`Preço recuou ${Math.abs(moveFromPeak).toFixed(2)}% desde o melhor preço ${peak}.`});await updatePositionWatch(watch.id,peak);if(events.length)await saveAlerts(events.map(event=>({kind:'position',symbol:watch.symbol,...event,fingerprint:`position-${watch.id}-${event.title.split(':')[0]}-${new Date().toISOString().slice(0,13)}`,payload:{watchId:watch.id,price,pnl,pnlPct,peak}})));const giveBackValue=Math.abs(peak-price)*watch.quantity*multiplier,peakPnl=(isLong?peak-watch.entry:watch.entry-peak)*watch.quantity*multiplier,hasStop=Boolean(watch.stop),hasTarget=Boolean(watch.target),distanceToStopPct=hasStop?(isLong?price/watch.stop-1:watch.stop/price-1)*100:null,distanceToTargetPct=hasTarget?(isLong?watch.target/price-1:price/watch.target-1)*100:null;positions.push({...watch,currentPrice:price,peakPrice:peak,pnl,pnlPct,moveFromPeak,giveBackValue,peakPnl,hasStop,hasTarget,hasPlan:hasStop&&hasTarget,distanceToStopPct,distanceToTargetPct,events,currency,multiplier,feed:watch.symbol==='MNQ'?'CME via feed público':'Binance'})}// O GUARDIÃO entra aqui. A leitura da mesa diz o que ESTÁ acontecendo;
  // o guardião diz O QUE FAZER, com preço exato. Diagnóstico sem ordem é o
  // que faz o operador decidir sozinho no calor — e é aí que se erra.
  const ordens=ordensDaMesa(positions.map(p=>({
    simbolo:p.symbol, entrada:Number(p.entry), stopInicial:Number(p.stop||0),
    stopAtual:Number(p.stop||0), preco:Number(p.currentPrice), pico:Number(p.peakPrice),
    direcao:p.direction, quantidade:Number(p.quantity), multiplicador:p.multiplier, moeda:p.currency,
  })));
  return {positions,errors,ordens,guardiao:resumoDoGuardiao(ordens),...leituraDaMesa(positions),updatedAt:new Date().toISOString()};
}

function ema(values,period){if(!values.length)return 0;const k=2/(period+1);return values.slice(1).reduce((value,item)=>item*k+value*(1-k),values[0])}
function atr(candles,period=14){const ranges=candles.map((c,i)=>Math.max(c.high-c.low,i?Math.abs(c.high-candles[i-1].close):0,i?Math.abs(c.low-candles[i-1].close):0));const sample=ranges.slice(-period);return sample.length?sample.reduce((a,b)=>a+b,0)/sample.length:0}
function rsi(values,period=14){if(values.length<2)return 50;const changes=values.slice(1).map((v,i)=>v-values[i]).slice(-period),gain=changes.reduce((s,v)=>s+Math.max(v,0),0)/changes.length,loss=changes.reduce((s,v)=>s+Math.max(-v,0),0)/changes.length;return loss?100-(100/(1+gain/loss)):100}
async function publicKlines(symbol,interval,limit=120){const response=await fetchPublico(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),data=await response.json();if(!response.ok)throw new Error(data.msg||'Candles indisponíveis.');return data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),closeTime:Number(row[6]),quoteVolume:Number(row[7])}))}

async function mnqCandles(){
  const end=Math.floor(Date.now()/1000),start=end-59*24*60*60,url=`https://query1.finance.yahoo.com/v8/finance/chart/MNQ=F?period1=${start}&period2=${end}&interval=15m&includePrePost=true`;
  const response=await fetch(url,{headers:{'user-agent':'BaladaTrade/1.0'}}),payload=await response.json(),result=payload.chart?.result?.[0];
  if(!response.ok||!result)throw new Error(payload.chart?.error?.description||'Candles do MNQ indisponíveis no provedor público.');
  const quote=result.indicators?.quote?.[0]||{};
  return (result.timestamp||[]).map((time,i)=>({time:time*1000,open:Number(quote.open?.[i]),high:Number(quote.high?.[i]),low:Number(quote.low?.[i]),close:Number(quote.close?.[i]),volume:Number(quote.volume?.[i]||0)})).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
}
function timeframeReading(candles,label){const fechados=candles.filter(c=>!Number.isFinite(c.closeTime)||c.closeTime<=Date.now()),serie=fechados.length>=2?fechados:candles.slice(0,-1),closes=serie.map(c=>c.close),last=serie.at(-1),previous=serie.at(-2),ema20=ema(closes.slice(-60),20),ema50=ema(closes.slice(-100),50),atrValue=atr(serie),janelaVolume=serie.slice(-21,-1),avgVolume=janelaVolume.reduce((s,c)=>s+c.quoteVolume,0)/Math.max(janelaVolume.length,1),volumeRatio=avgVolume?last.quoteVolume/avgVolume:0,change=previous?.close?(last.close-previous.close)/previous.close*100:0;return {label,price:last.close,change,ema20,ema50,atr:atrValue,atrPct:last.close?atrValue/last.close*100:0,rsi:rsi(closes),volumeRatio,trend:last.close>ema20&&ema20>ema50?'ALTA':last.close<ema20&&ema20<ema50?'BAIXA':'LATERAL'}}

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

// ============================================================
// O QUE ACONTECEU DEPOIS DA ORDEM — 07/09/2026
//
// Até aqui o robô mandava e nunca mais olhava. Isso deixava três coisas de
// enfeite: a trava de perda do dia (sem número para comparar), o guardião
// (sem saber se a entrada preencheu) e o histórico (dizia o que ele TENTOU).
//
// Este bloco fecha o ciclo. Ele lê as três pernas do OTOCO na Binance,
// conclui o que houve (resultado.js decide, sem rede) e grava.
// ============================================================

/** As três pernas de um trade, perguntadas pelo nome que demos a cada uma.
 *  É por isso que o id determinístico existe: sem ele não há como perguntar
 *  "o que aconteceu com aquela ordem" depois de um timeout ou um reinício. */
async function pernasDoTrade(simbolo, ordemId) {
  const nomes = [['entrada', 'e'], ['alvo', 'a'], ['stop', 's']];
  const pernas = {};
  for (const [nome, sufixo] of nomes) {
    // -2013 ("Order does not exist") é resposta legítima: as pernas pendentes
    // do OTOCO só nascem quando a entrada preenche. Tratar como erro faria o
    // robô achar que perdeu a posição toda vez que ela ainda está na fila.
    pernas[nome] = await signedBinance('/api/v3/order', 'GET', { symbol: simbolo, origClientOrderId: `${ordemId}${sufixo}` }).catch(() => null);
  }
  return pernas;
}

/** As comissões de uma ordem específica. Só vale a pena perguntar quando a
 *  perna executou — myTrades custa peso e não muda depois de fechada. */
async function fillsDaOrdem(simbolo, orderId, baseAsset) {
  if (!orderId) return [];
  const trades = await signedBinance('/api/v3/myTrades', 'GET', { symbol: simbolo, orderId: String(orderId) }).catch(() => []);
  return (Array.isArray(trades) ? trades : []).map(t => ({
    ...t,
    // Quando a comissão sai na própria moeda comprada, ela reduz a quantidade;
    // converter pelo preço do fill é exato, não estimativa.
    commissionEmBase: String(t.commissionAsset || '').toUpperCase() === String(baseAsset || '').toUpperCase(),
  }));
}

/**
 * Confere TODAS as posições que ainda podem mudar e grava o desfecho.
 *
 * Devolve também o que exige ação humana — posição desprotegida é a única
 * coisa aqui que não pode esperar o próximo ciclo.
 */
async function conferirPosicoes() {
  const abertas = await posicoesEmAberto().catch(() => []);
  const conferidas = [], alertas = [];

  for (const pos of abertas) {
    const base = pos.simbolo.replace(/USDT$/, '');
    const pernas = await pernasDoTrade(pos.simbolo, pos.ordem_id).catch(() => null);
    if (!pernas) continue;

    // Só busca comissão quando alguma perna de saída executou: é o único
    // momento em que o número muda, e myTrades custa peso.
    const saiu = [pernas.alvo, pernas.stop].find(p => Number(p?.executedQty) > 0);
    const leitura = lerPosicao({
      entrada: pernas.entrada, alvo: pernas.alvo, stop: pernas.stop,
      fillsEntrada: Number(pernas.entrada?.executedQty) > 0 ? await fillsDaOrdem(pos.simbolo, pernas.entrada.orderId, base) : [],
      fillsSaida: saiu ? await fillsDaOrdem(pos.simbolo, saiu.orderId, base) : [],
    });

    const campos = { estado: leitura.estado, texto: leitura.texto };
    if (leitura.quantidade !== undefined) campos.quantidade = leitura.quantidade;
    if (leitura.precoEntrada) campos.precoEntrada = leitura.precoEntrada;
    if (leitura.custo !== undefined) campos.custo = leitura.custo;
    if (leitura.taxas !== undefined) campos.taxas = leitura.taxas;
    if (leitura.taxasIncertas !== undefined) campos.taxasIncertas = leitura.taxasIncertas;

    // A posição passa a existir de verdade no instante do preenchimento. É
    // daqui que o guardião passa a ter direito de opinar sobre o stop.
    if ((leitura.estado === 'ABERTA' || leitura.estado === 'DESPROTEGIDA') && !pos.preco_entrada) {
      campos.abertaEm = new Date().toISOString();
    }

    if (leitura.estado === 'FECHADA') {
      campos.precoSaida = leitura.precoSaida;
      campos.saidaTipo = leitura.saidaTipo;
      campos.recebido = leitura.recebido;
      campos.resultadoLiquido = leitura.resultadoLiquido;
      campos.fechadaEm = new Date().toISOString();
      alertas.push({
        kind: 'robo', level: leitura.resultadoLiquido >= 0 ? 'info' : 'warning', symbol: pos.simbolo,
        title: `${pos.simbolo} fechou no ${leitura.saidaTipo === 'ALVO' ? 'alvo' : 'stop'}`,
        message: leitura.texto, fingerprint: `robo-fim-${pos.ordem_id}`, payload: { leitura },
      });
    }

    if (leitura.estado === 'DESPROTEGIDA') {
      alertas.push({
        kind: 'robo', level: 'critical', symbol: pos.simbolo,
        title: `${pos.simbolo} está SEM STOP na Binance`,
        message: leitura.texto,
        fingerprint: `robo-desprotegida-${pos.ordem_id}-${new Date().toISOString().slice(0, 13)}`,
        payload: { leitura },
      });
    }

    await atualizarPosicao(pos.ordem_id, campos).catch(() => {});
    conferidas.push({ ordemId: pos.ordem_id, simbolo: pos.simbolo, ...leitura });
  }

  if (alertas.length) await saveAlerts(alertas).catch(() => {});
  return { conferidas, alertas, em: new Date().toISOString() };
}

// ============================================================
// TRAILING — o guardião passa a mandar de verdade
//
// O guardiao-do-lucro já sabia dizer "suba o stop para X". Até hoje isso era
// texto na tela esperando alguém obedecer. Agora o robô obedece sozinho.
//
// ------------------------------------------------------------
// A JANELA DESCOBERTA, dita com todas as letras
// ------------------------------------------------------------
//
// A Binance não tem "cancelar e recolocar" atômico para lista OCO. Para subir
// o stop é preciso CANCELAR o OCO e criar outro — e entre uma coisa e outra
// existem alguns segundos em que a posição fica sem proteção.
//
// Isso é um risco real e não dá para eliminá-lo. Dá para reduzi-lo:
//
//   · só mexe quando o trade já passou de 1R, então acontece poucas vezes;
//   · se a recolocação falhar, grita CRÍTICO e tenta de novo no ciclo seguinte;
//   · a posição fica marcada como DESPROTEGIDA até o novo OCO existir.
//
// A alternativa — nunca subir o stop — tem o custo conhecido de devolver o
// lucro inteiro. Entre alguns segundos descoberto e devolver o movimento, a
// escolha é essa, feita de olhos abertos.
// ============================================================

async function trailingDoGuardiao(pos, precoAtual) {
  if (pos.estado !== 'ABERTA' || !(Number(pos.preco_entrada) > 0)) return null;

  const pico = Math.max(Number(pos.pico_preco) || 0, precoAtual);
  if (pico > (Number(pos.pico_preco) || 0)) await atualizarPosicao(pos.ordem_id, { picoPreco: pico }).catch(() => {});

  const ordem = ordemDoGuardiao({
    simbolo: pos.simbolo,
    entrada: Number(pos.preco_entrada),
    stopInicial: Number(pos.stop_pedido),
    stopAtual: Number(pos.stop_atual) || Number(pos.stop_pedido),
    preco: precoAtual, pico, direcao: 'LONG',
    quantidade: Number(pos.quantidade) || Number(pos.quantidade_pedida),
  });

  if (ordem.acao !== 'SUBIR_STOP' || !(ordem.preco > 0)) return { mexeu: false, ordem };

  // Os filtros só são buscados quando o stop VAI mesmo mudar. Buscar a cada
  // ciclo, para quase sempre concluir que não há nada a fazer, é peso jogado
  // fora — e peso é o que leva ao 418.
  const info = await fetchPublico(`${marketBase()}/api/v3/exchangeInfo?symbol=${pos.simbolo}`).then(r => r.json()).catch(() => null);
  const tick = Number((info?.symbols?.[0]?.filters || []).find(f => f.filterType === 'PRICE_FILTER')?.tickSize) || 1e-8;
  const novoStop = roundStepSpot(ordem.preco, tick, 'down');
  const novoLimite = roundStepSpot(novoStop * 0.997, tick, 'down');
  // Nunca abaixa o stop. Esta linha é a regra inteira do guardião em código:
  // proteção conquistada não se devolve.
  if (!(novoStop > (Number(pos.stop_atual) || Number(pos.stop_pedido)))) return { mexeu: false, ordem };

  const quantidade = Number(pos.quantidade) || Number(pos.quantidade_pedida);
  const geracao = `t${Date.now().toString(36).slice(-5)}`;
  const novoId = `${pos.ordem_id}${geracao}`.slice(0, 36);

  // 1) cancela SÓ a proteção deste trade — a janela descoberta começa aqui
  //
  // Isto era `DELETE /api/v3/openOrders` com o símbolo, que apaga TODAS as
  // ordens abertas daquele par — inclusive as que o Bruno tivesse colocado na
  // mão. O README prometia "o robô não cancela o que não é dele" e o código
  // fazia o contrário, sem avisar. Agora cancela pelo nome das próprias
  // pernas: cancelar uma perna do OCO derruba o par inteiro, e nada mais.
  const canceladas = await cancelarProtecao(pos);
  if (!canceladas.length) return { mexeu: false, ordem, texto: 'Não achei a proteção atual para trocar. Deixei como está — melhor não mexer do que cancelar às cegas.' };
  await atualizarPosicao(pos.ordem_id, { estado: 'DESPROTEGIDA', texto: 'Trocando o stop de lugar. A posição fica descoberta por alguns segundos.' }).catch(() => {});

  // 2) recoloca com o stop mais alto — e fecha a janela
  const nova = await protegerPosicao(pos, { stop: novoStop, alvo: Number(pos.alvo_pedido), motivo: 'trailing' });
  try {
    if (!nova.ok) throw new Error(nova.erro);
    await atualizarPosicao(pos.ordem_id, {
      estado: 'ABERTA', stopAtual: nova.stop || novoStop, trailingDegrau: ordem.degrau,
      trailingEm: new Date().toISOString(),
      texto: `${ordem.titulo} — ${ordem.texto}`,
    }).catch(() => {});
    await saveAlerts([{
      kind: 'robo', level: 'info', symbol: pos.simbolo,
      title: `Stop subiu para ${nova.stop || novoStop} em ${pos.simbolo}`,
      message: ordem.texto, fingerprint: `robo-trail-${novoId}`, payload: { ordem, novoStop },
    }]).catch(() => {});
    return { mexeu: true, novoStop: nova.stop || novoStop, degrau: ordem.degrau, ordem, resposta: nova.resposta };
  } catch (error) {
    // O pior caso do arquivo inteiro: cancelou e não conseguiu recolocar.
    // Grita alto, deixa marcada como DESPROTEGIDA e tenta de novo no próximo
    // ciclo. Silêncio aqui seria a posição ficar sem stop sem ninguém saber.
    await saveAlerts([{
      kind: 'robo', level: 'critical', symbol: pos.simbolo,
      title: `${pos.simbolo} FICOU SEM STOP ao subir a proteção`,
      message: `O OCO antigo foi cancelado e o novo falhou: ${error.message}. A posição está descoberta e o robô vai tentar recolocar no próximo ciclo.`,
      fingerprint: `robo-trail-falhou-${novoId}`, payload: { erro: error.message },
    }]).catch(() => {});
    return { mexeu: false, falhou: true, erro: error.message, ordem };
  }
}

/** Passa o guardião em cada posição comprada e sobe o stop onde ele mandar.
 *  Uma consulta de preço por posição — e só quem já passou de 1R chega a
 *  mexer em ordem. */
async function subirStopsDoDia() {
  const abertas = (await posicoesEmAberto().catch(() => [])).filter(p => p.estado === 'ABERTA' && Number(p.preco_entrada) > 0);
  const feitos = [];
  for (const pos of abertas) {
    const preco = await publicPrice(pos.simbolo).catch(() => null);
    if (!preco) continue;
    const r = await trailingDoGuardiao(pos, preco).catch(error => ({ mexeu: false, falhou: true, erro: error.message }));
    if (r) feitos.push({ simbolo: pos.simbolo, ...r });
  }
  return feitos;
}

/**
 * Cancela apenas as ordens DESTE trade, uma a uma, pelo nome que demos a elas.
 *
 * Todas as pernas de uma posição — as originais (`{id}e`, `{id}a`, `{id}s`) e
 * as de cada trailing (`{id}t...`) — começam com o mesmo `ordem_id`. É esse
 * prefixo que separa o que é do robô do que é do Bruno, e é por isso que o id
 * determinístico continua pagando: aqui ele é a diferença entre cancelar a
 * própria proteção e apagar a ordem manual de alguém.
 */
async function cancelarProtecao(pos) {
  const abertas = await signedBinance('/api/v3/openOrders', 'GET', { symbol: pos.simbolo }).catch(() => []);
  const minhas = minhasOrdens(Array.isArray(abertas) ? abertas : [], pos.ordem_id, 'SELL');
  const feitas = [];
  for (const o of minhas) {
    // Cancelar uma perna do OCO derruba a outra junto, então a segunda
    // chamada costuma responder "não existe" — o que é sucesso, não erro.
    const r = await signedBinance('/api/v3/order', 'DELETE', { symbol: pos.simbolo, origClientOrderId: o.clientOrderId }).catch(() => null);
    if (r) feitas.push(o.clientOrderId);
  }
  return feitas;
}

/**
 * ENTRADAS QUE NÃO PREENCHERAM.
 *
 * A entrada é uma ordem limite GTC: sem prazo, ela espera para sempre. Uma
 * ordem parada não é neutra — ela segura USDT que não pode ser usado em outro
 * setup, ocupa uma das vagas de posição, e principalmente representa uma ideia
 * que já venceu. O sinal que justificou aquele preço tinha quinze minutos de
 * validade, não três dias.
 *
 * Preencher tarde é pior do que não preencher: entra num setup que já não
 * existe, com um stop calculado para um mercado que já mudou.
 */
async function expirarEntradasVelhas(minutos = 15) {
  const abertas = entradasVencidas(await posicoesEmAberto().catch(() => []), minutos);
  const expiradas = [];
  for (const pos of abertas) {
    const r = await signedBinance('/api/v3/order', 'DELETE', { symbol: pos.simbolo, origClientOrderId: `${pos.ordem_id}e` }).catch(() => null);
    // Se a Binance diz que a ordem não existe, ela preencheu ou já morreu no
    // meio do caminho. Não marca como cancelada: deixa a conferência decidir
    // com os dados dela, em vez de escrever um desfecho por dedução.
    if (!r) continue;
    await atualizarPosicao(pos.ordem_id, {
      estado: 'CANCELADA', fechadaEm: new Date().toISOString(),
      texto: `A entrada esperou ${minutos} minutos e não preencheu. O setup que justificava esse preço já venceu — cancelei em vez de entrar atrasado.`,
    }).catch(() => {});
    expiradas.push(pos.simbolo);
  }
  return expiradas;
}

/**
 * COLOCA A PROTEÇÃO — e é aqui que mora a armadilha mais cara do projeto.
 *
 * A quantidade da venda NÃO é a que a gente comprou. É a que a gente TEM.
 *
 * Quando a conta não paga taxa em BNB, a Binance cobra a comissão na própria
 * moeda comprada: você pede 100 ARB, a ordem executa, e ficam 99,9 ARB na
 * carteira. Uma venda programada para 100 é recusada por saldo insuficiente —
 * e a posição fica no mercado sem nada segurando, exatamente no caso em que
 * ninguém está olhando.
 *
 * Por isso a proteção é sempre dimensionada pelo saldo real, arredondado para
 * BAIXO no stepSize. Sobrar poeira é irrelevante; faltar centésimo derruba a
 * ordem inteira.
 */
async function protegerPosicao(pos, { stop, alvo, motivo = 'protecao' }) {
  const base = pos.simbolo.replace(/USDT$/, '');

  // 1) Ja existe protecao viva? Nao coloca outra. Duas ordens de venda para
  //    uma compra so fazem a segunda tentar vender o que ja nao existe.
  const abertas = await signedBinance('/api/v3/openOrders', 'GET', { symbol: pos.simbolo }).catch(() => []);
  if (minhasOrdens(Array.isArray(abertas) ? abertas : [], pos.ordem_id, 'SELL').length) {
    return { ok: true, jaTinha: true };
  }

  // 2) Quanto existe de verdade na carteira
  const conta = await signedBinance('/api/v3/account').catch(() => null);
  const saldo = Number((conta?.balances || []).find(b => b.asset === base)?.free) || 0;

  const info = await fetchPublico(`${marketBase()}/api/v3/exchangeInfo?symbol=${pos.simbolo}`).then(r => r.json()).catch(() => null);
  const filtros = info?.symbols?.[0]?.filters || [];
  const tick = Number(filtros.find(f => f.filterType === 'PRICE_FILTER')?.tickSize) || 1e-8;
  const passo = Number(filtros.find(f => f.filterType === 'LOT_SIZE')?.stepSize) || 1e-8;
  const minimo = Number(filtros.find(f => f.filterType === 'LOT_SIZE')?.minQty) || passo;

  const quantidade = floorStepSpot(Math.min(saldo, Number(pos.quantidade) || saldo), passo);
  if (!(quantidade >= minimo)) {
    return { ok: false, erro: `Saldo de ${base} é ${saldo}, abaixo do mínimo negociável. Não dá para proteger o que não dá para vender.` };
  }

  const stopPreco = roundStepSpot(stop, tick, 'down');
  const stopLimite = roundStepSpot(stop * 0.997, tick, 'down');
  const alvoPreco = roundStepSpot(alvo, tick, 'down');
  const id = `${pos.ordem_id}${motivo === 'trailing' ? 't' : 'r'}${Date.now().toString(36).slice(-5)}`.slice(0, 32);

  const pernas = {
    symbol: pos.simbolo, side: 'SELL', quantity: String(quantidade),
    listClientOrderId: id,
    aboveType: 'LIMIT_MAKER', abovePrice: String(alvoPreco), aboveClientOrderId: `${id}a`,
    belowType: 'STOP_LOSS_LIMIT', belowStopPrice: String(stopPreco), belowPrice: String(stopLimite),
    belowTimeInForce: 'GTC', belowClientOrderId: `${id}s`,
  };

  try {
    const r = await signedBinance('/api/v3/orderList/oco', 'POST', pernas);
    return { ok: true, quantidade, stop: stopPreco, alvo: alvoPreco, resposta: r };
  } catch (error) {
    // O OCO pode ser recusado por um motivo que NAO impede o stop: o alvo e um
    // LIMIT_MAKER, e se o preco ja passou dele a Binance recusa a lista
    // inteira. Perder o alvo custa lucro; perder o stop custa a conta. Entao
    // se o par nao entra, o stop entra sozinho.
    try {
      const so = await signedBinance('/api/v3/order', 'POST', {
        symbol: pos.simbolo, side: 'SELL', type: 'STOP_LOSS_LIMIT',
        quantity: String(quantidade), stopPrice: String(stopPreco), price: String(stopLimite),
        timeInForce: 'GTC', newClientOrderId: `${id}s`,
      });
      return { ok: true, somenteStop: true, quantidade, stop: stopPreco, resposta: so, erroDoPar: error.message };
    } catch (erroDoStop) {
      return { ok: false, erro: `${error.message} | e o stop sozinho também falhou: ${erroDoStop.message}` };
    }
  }
}

/** Recoloca a proteção de qualquer posição que esteja descoberta — venha de
 *  um trailing que falhou ou de alguém que cancelou o OCO pelo aplicativo. */
async function reprotegerDesprotegidas() {
  const abertas = await posicoesEmAberto().catch(() => []);
  const feitas = [];
  for (const pos of abertas.filter(p => p.estado === 'DESPROTEGIDA' && Number(p.quantidade) > 0)) {
    const stop = Number(pos.stop_atual) || Number(pos.stop_pedido);
    const r = await protegerPosicao(pos, { stop, alvo: Number(pos.alvo_pedido), motivo: 'reprotecao' });
    if (r.ok) {
      await atualizarPosicao(pos.ordem_id, {
        estado: 'ABERTA', stopAtual: r.stop || stop,
        texto: r.jaTinha ? 'A proteção já estava lá — alarme falso, nada foi duplicado.'
          : r.somenteStop ? `Proteção recolocada só com o stop em ${r.stop}. O alvo foi recusado (${r.erroDoPar}) — sem alvo dá para viver, sem stop não.`
          : 'Proteção recolocada na Binance.',
      }).catch(() => {});
      feitas.push({ simbolo: pos.simbolo, ...r });
    } else {
      await saveAlerts([{
        kind: 'robo', level: 'critical', symbol: pos.simbolo,
        title: `${pos.simbolo} continua SEM STOP`,
        message: r.erro, fingerprint: `robo-nua-${pos.ordem_id}-${new Date().toISOString().slice(0, 13)}`,
        payload: { erro: r.erro },
      }]).catch(() => {});
      feitas.push({ simbolo: pos.simbolo, erro: r.erro });
    }
  }
  return feitas;
}

/**
 * RECONCILIAÇÃO NO BOOT.
 *
 * O robô confiava no banco. Se alguém cancelasse uma ordem pelo aplicativo da
 * Binance, ou se o processo caísse entre o cancelar e o recolocar, ele subia
 * acreditando numa realidade que já não existia.
 *
 * Aqui a corretora é a fonte da verdade, e o banco se ajusta a ela.
 */
async function reconciliarNoBoot() {
  const relatorio = { conferidas: [], reprotegidas: [], orfas: [], erro: null };
  try {
    const resultado = await conferirPosicoes();
    relatorio.conferidas = resultado.conferidas;
    relatorio.reprotegidas = await reprotegerDesprotegidas();

    // Ordens abertas na Binance que o robô não reconhece. Ele NÃO cancela:
    // podem ser ordens que o Bruno colocou na mão, e robô que apaga ordem de
    // gente é pior do que robô que não sabe de nada. Só reporta.
    const naBinance = await signedBinance('/api/v3/openOrders').catch(() => []);
    const nossas = new Set((await posicoesEmAberto().catch(() => [])).map(p => p.ordem_id));
    relatorio.orfas = (Array.isArray(naBinance) ? naBinance : [])
      .filter(o => !nossas.has(String(o.clientOrderId || '').replace(/[eas]$/, '')))
      .map(o => ({ simbolo: o.symbol, id: o.clientOrderId, lado: o.side, tipo: o.type, preco: o.price }));

    if (relatorio.orfas.length) {
      await saveAlerts([{
        kind: 'robo', level: 'warning', symbol: null,
        title: `${relatorio.orfas.length} ordem(ns) aberta(s) que o robô não reconhece`,
        message: 'Podem ser suas, colocadas na mão. O robô não cancela o que não é dele — só avisa.',
        fingerprint: `robo-orfas-${new Date().toISOString().slice(0, 13)}`,
        payload: { orfas: relatorio.orfas },
      }]).catch(() => {});
    }
  } catch (error) {
    relatorio.erro = error.message;
  }
  return relatorio;
}

// ============================================================
// O CICLO DO ROBÔ — 07/09/2026
//
// Aqui o robô deixa de ser função pura e encosta no dinheiro. Tudo que decide
// mora em robo.js e é testável sem rede; o que sobra para cá é buscar os
// números, mandar a ordem e gravar o que aconteceu.
//
// A SEQUÊNCIA É DELIBERADA — e é sempre a mesma:
//
//   1. o robô está ligado?          (banco, não memória)
//   2. como está a conta?           (saldo, posições, ordens de hoje)
//   3. o que o mercado oferece?     (scanner + peneira do Bruno)
//   4. a conta fecha?               (spot-engine, com taxa e MIN_NOTIONAL)
//   5. pode?                        (travas de risco)
//   6. GRAVA a intenção             ← antes de enviar, sempre
//   7. envia
//
// O passo 6 vir ANTES do 7 é o detalhe que evita o pior bug possível. O id da
// ordem tem índice único no banco: se dois ciclos se atropelarem, o segundo
// INSERT falha e a segunda ordem nunca chega a existir. A trava fica no banco,
// não numa variável — variável some quando o processo reinicia.
// ============================================================

let cicloEmAndamento = false;   // um ciclo por vez. Sem isso, um ciclo lento é
                                // ultrapassado pelo seguinte e os dois compram.
let agendador = null;
let ultimoResultado = null;

/** A config vem do ambiente e o banco pode sobrescrever — menos o modo REAL,
 *  que exige as duas travas antigas do projeto (ENABLE_LIVE_TRADING e o teto
 *  de notional). Nenhuma tela deve conseguir ligar dinheiro de verdade
 *  sozinha: isso continua sendo decisão de quem tem acesso ao servidor. */
function configDoRobo(doBanco = {}) {
  const tetoGlobal = numeroDoAmbiente('MAX_ORDER_NOTIONAL', 100, MINIMO_NEGOCIAVEL);
  const cfg = normalizarConfig({
    ...doBanco,
    modo: doBanco.modo || process.env.ROBO_MODO || 'SIMULACAO',
    notionalMaximo: Number(doBanco.notionalMaximo) || tetoGlobal,
  });
  const podeReal = process.env.ENABLE_LIVE_TRADING === 'true' && process.env.ROBO_PERMITE_REAL === 'true';
  if (cfg.modo === 'REAL' && !podeReal) cfg.modo = 'SIMULACAO';
  // O teto do robô nunca passa o teto global do projeto — mas também nunca cai
  // abaixo do mínimo negociável, porque abaixo disso ele não seria um limite:
  // seria um robô desligado fingindo estar ligado.
  cfg.notionalMaximo = Math.max(MINIMO_NEGOCIAVEL, Math.min(cfg.notionalMaximo, tetoGlobal));
  return cfg;
}

/** O retrato da conta: quanto tem livre, o que já está comprado e quantas
 *  ordens saíram hoje. Sem isto o robô decide no escuro.
 *
 *  Em SIMULAÇÃO ele usa a carteira do simulador que o projeto já tem. Isso é
 *  de propósito: dá para ver o robô raciocinando ANTES de existir qualquer
 *  chave de API no servidor — e um robô que só dá para observar depois de
 *  entregar a chave da corretora nunca é observado. */
async function retratoDaConta(modo = 'SIMULACAO') {
  if (modo === 'SIMULACAO') {
    const papel = await paperSummary().catch(() => null);
    const abertos = (papel?.positions || []).filter(p => Number(p.value) >= 5);
    return {
      // Sem banco e sem chave, ainda assim 1.000 USDT de mentira: o robô tem
      // de conseguir mostrar como pensa mesmo numa instalação recém-criada.
      saldoUsdt: Number(papel?.account?.cash_usdt ?? 1000),
      paresAbertos: abertos.map(p => p.symbol),
      posicoesAbertas: abertos.length,
      abertos,
      ordensHoje: await ordensDoRoboHoje().catch(() => 0),
      origem: papel ? 'SIMULADOR' : 'SIMULADOR_SEM_BANCO',
    };
  }
  const conta = await signedBinance('/api/v3/account');
  const saldos = (conta.balances || []).filter(b => Number(b.free) + Number(b.locked) > 0);
  const usdt = saldos.find(b => b.asset === 'USDT');
  const saldoUsdt = usdt ? Number(usdt.free) : 0;

  // Posição aberta = qualquer moeda que não seja stablecoin com valor de pé.
  // Poeira de 2 dólares não é posição, e contar poeira como posição faz o robô
  // achar que está cheio e parar de operar sem motivo.
  const stables = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);
  const abertos = [];
  for (const b of saldos) {
    if (stables.has(b.asset)) continue;
    const quantidade = Number(b.free) + Number(b.locked);
    const valor = await assetValueUsdt(b.asset, quantidade).catch(() => 0);
    if (valor >= 5) abertos.push({ asset: b.asset, simbolo: `${b.asset}USDT`, quantidade, valor });
  }

  return {
    saldoUsdt,
    paresAbertos: abertos.map(x => x.simbolo),
    posicoesAbertas: abertos.length,
    abertos,
    ordensHoje: await ordensDoRoboHoje().catch(() => 0),
  };
}

/** Um ciclo completo. `forcado` só ignora o "ligado"; nunca ignora o kill
 *  switch nem os limites de risco — botão de teste que fura trava de risco
 *  deixa de ser teste. */
async function cicloDoRobo({ forcado = false } = {}) {
  if (cicloEmAndamento) return { acao: 'PARADO', motivo: 'JA_RODANDO', texto: 'O ciclo anterior ainda não terminou. Pulei este para não mandar ordem duplicada.' };
  cicloEmAndamento = true;
  const comecou = Date.now();

  try {
    const salvo = await estadoDoRobo().catch(() => ({ ligado: false, killSwitch: false, config: {} }));
    const cfg = configDoRobo(salvo.config);
    const ambiente=binanceConfig();
    if(cfg.modo==='TESTNET'&&!ambiente.base.includes('testnet'))return (ultimoResultado={acao:'PARADO',motivo:'TESTNET_NAO_ISOLADA',texto:'Testnet bloqueada: as chaves e a URL configuradas pertencem à Binance real. Configure credenciais exclusivas da Spot Test Network antes de usar este modo.',config:cfg,em:comecou});
    if(cfg.modo==='REAL'&&(!ambiente.live||process.env.ROBO_PERMITE_REAL!=='true'||ambiente.base.includes('testnet')))return (ultimoResultado={acao:'PARADO',motivo:'REAL_NAO_AUTORIZADO',texto:'Modo real bloqueado pelas travas do servidor.',config:cfg,em:comecou});

    if (!salvo.ligado && !forcado) {
      return (ultimoResultado = { acao: 'PARADO', motivo: 'DESLIGADO', texto: 'O robô está desligado. Ligue no painel para ele começar a olhar o mercado.', config: cfg, em: comecou });
    }

    // ANTES de pensar em comprar qualquer coisa nova, fecha o que já está
    // aberto. Decidir entrada nova sem saber o resultado das anteriores é
    // como a trava de perda do dia deixa de existir na prática.
    let posicoes = { conferidas: [] }, trailings = [];
    if (cfg.modo !== 'SIMULACAO') {
      posicoes = await conferirPosicoes().catch(error => ({ conferidas: [], erro: error.message }));
      await expirarEntradasVelhas(cfg.minutosParaEntrar).catch(() => []);
      trailings = await subirStopsDoDia().catch(() => []);
      await reprotegerDesprotegidas().catch(() => []);
    }
    const fechadasHoje = await posicoesFechadasHoje().catch(() => []);
    const dia = perdaDoDia(fechadasHoje);

    const conta = await retratoDaConta(cfg.modo);
    const scan = await setupScanner();
    const candidatos = scan.setups || [];

    // O plano só existe depois de escolher o par: os filtros (tickSize,
    // stepSize, MIN_NOTIONAL) são de cada par, e é neles que a conta fecha
    // ou não fecha.
    const escolhido = escolherCandidato(candidatos, cfg, conta.paresAbertos);
    let plano = null;
    if (escolhido) {
      const precos = precosDoTrade(escolhido, cfg);
      if (precos) {
        const info = await fetchPublico(`${marketBase()}/api/v3/exchangeInfo?symbol=${escolhido.symbol}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
        const mercado = info?.symbols?.[0];
        if (mercado?.status === 'TRADING' && mercado.isSpotTradingAllowed) {
          // calculateSpotPlan LANÇA quando os números não fecham. Isso não é
          // falha do ciclo — é o motivo de não operar, e vira ESPERAR logo
          // abaixo com a explicação do próprio engine.
          try {
            plano = calculateSpotPlan({
              symbol: escolhido.symbol,
              capital: Math.min(conta.saldoUsdt, cfg.notionalMaximo),
              riskPct: cfg.riscoPctPorOrdem,
              entry: precos.entrada, stop: precos.stop, target: precos.alvo,
              filters: mercado.filters,
            });
          } catch (error) {
            plano = { quantity: 0, allowed: false, blockers: [error.message] };
          }
        }
      }
    }

    // ------------------------------------------------------------
    // QUEM CONTA COMO POSICAO ABERTA — corrigido em 07/09/2026
    //
    // Estava contando TODA moeda da carteira que valesse mais de 5 USDT. Com
    // uma carteira normal — BTC, ETH e alguns alts — o robo batia no teto de
    // 3 posicoes no primeiro ciclo e ficava PARADO para sempre, dizendo
    // POSICOES_CHEIAS. Ele nunca teria comprado nada. Era exatamente o "nao
    // pega, nao serve".
    //
    // Sao duas perguntas diferentes e eu tinha juntado numa so:
    //
    //   quantas posicoes EU abri?      → so as minhas contam para o teto
    //   em que pares eu nao mexo?      → as minhas MAIS o que o Bruno ja tem
    //
    // A segunda inclui a carteira dele de proposito: comprar uma moeda que
    // ele ja guarda mistura o estoque dele com o meu, e o dia em que ele
    // vender na mao o meu stop fica sem saldo para executar.
    //
    // E as minhas incluem as AGUARDANDO. Sem isso, uma entrada que ainda nao
    // preencheu era invisivel — a moeda nao esta na carteira — e o ciclo
    // seguinte comprava o MESMO par de novo, dobrando a posicao em silencio.
    // ------------------------------------------------------------
    const minhasPosicoes = cfg.modo === 'SIMULACAO' ? [] : await posicoesEmAberto().catch(() => []);
    const contagem = cfg.modo === 'SIMULACAO'
      ? { posicoesAbertas: conta.posicoesAbertas, paresAbertos: conta.paresAbertos, naCarteira: conta.posicoesAbertas }
      : contarPosicoes({ minhas: minhasPosicoes, carteira: conta.abertos || [] });

    const estado = {
      ...conta,
      posicoesAbertas: contagem.posicoesAbertas,
      paresAbertos: contagem.paresAbertos,
      naCarteira: contagem.naCarteira,
      desligadoManualmente: !salvo.ligado && !forcado,
      killSwitch: salvo.killSwitch,
      atrasoDadosMs: Date.now() - new Date(scan.generatedAt).getTime(),
      // Agora é um número de verdade, tirado do que FECHOU hoje. Antes disto
      // a trava de perda diária nunca disparava, porque comparava com zero.
      perdaHojeUsdt: dia.perda,
    };

    const decisao = decidirRobo({ candidatos, estado, config: cfg, plano, agoraMs: Date.now() });
    decisao.modo = cfg.modo;
    decisao.duracaoMs = Date.now() - comecou;
    decisao.dia = dia;
    decisao.posicoes = posicoes.conferidas;
    decisao.trailings = trailings.filter(t => t.mexeu || t.falhou);
    decisao.limites = limites.estado();

    // ---- passo 6: GRAVA ANTES DE ENVIAR ----
    let linha = null;
    if (decisao.acao === 'COMPRAR') {
      linha = await salvarDecisao({
        acao: decisao.acao, motivo: decisao.motivo, texto: decisao.texto,
        simbolo: decisao.simbolo, modo: cfg.modo, quantidade: decisao.quantidade,
        entrada: Number(decisao.ordem.workingPrice), stop: Number(decisao.ordem.pendingBelowStopPrice),
        alvo: Number(decisao.ordem.pendingAbovePrice), notional: decisao.notional,
        riscoUsdt: decisao.riscoUsdt, ordemId: decisao.id, enviado: false,
        payload: { candidato: decisao.candidato, ordem: decisao.ordem },
      }).catch(() => null);

      if (linha === null) {
        // O id já estava no banco: outro ciclo (ou uma tentativa anterior que
        // deu timeout) já cuidou deste trade. Não mandar é o comportamento
        // certo — duplicar posição é pior do que perder uma entrada.
        decisao.acao = 'ESPERAR';
        decisao.motivo = 'JA_DECIDIDO';
        decisao.texto = `${decisao.simbolo}: esta ordem já foi registrada neste minuto. Não vou mandar de novo.`;
        linha = null;
      } else if (linha?.semBanco) {
        // Sem PostgreSQL não existe índice único, e sem índice único não
        // existe proteção contra mandar a mesma ordem duas vezes. Em
        // simulação isso é inofensivo (nada é enviado) e o robô continua
        // mostrando como pensa; com dinheiro em jogo, ele para e diz por quê.
        if (cfg.modo === 'SIMULACAO') {
          decisao.semBanco = true;
        } else {
          decisao.acao = 'PARADO';
          decisao.motivo = 'SEM_BANCO';
          decisao.texto = 'O PostgreSQL não está configurado. Sem ele não há registro nem proteção contra ordem duplicada, e eu não mando ordem sem as duas.';
          linha = null;
        }
      }
    } else {
      await salvarDecisao({ acao: decisao.acao, motivo: decisao.motivo, texto: decisao.texto, simbolo: decisao.simbolo || null, modo: cfg.modo, enviado: false, payload: { travas: decisao.travas || [] } }).catch(() => null);
    }

    // ---- passo 7: envia ----
    if (decisao.acao === 'COMPRAR' && (linha || decisao.semBanco)) {
      if (cfg.modo === 'SIMULACAO') {
        decisao.enviado = false;
        decisao.texto += ' (SIMULAÇÃO — nenhuma ordem foi enviada.)';
      } else {
        try {
          const resposta = await signedBinance('/api/v3/orderList/otoco', 'POST', decisao.ordem);
          decisao.enviado = true;
          decisao.resposta = resposta;
          if (linha?.id) await marcarDecisaoEnviada(linha.id, true, null, { ordem: decisao.ordem, resposta });
          // A posição nasce aqui, no instante em que a ordem existe na
          // corretora. É este registro que permite descobrir depois se ela
          // preencheu, onde saiu e quanto deu.
          await abrirPosicao({
            ordemId: decisao.id, orderListId: resposta?.orderListId,
            simbolo: decisao.simbolo, quantidade: decisao.quantidade,
            entrada: Number(decisao.ordem.workingPrice),
            stop: Number(decisao.ordem.pendingBelowStopPrice),
            alvo: Number(decisao.ordem.pendingAbovePrice),
          }).catch(() => {});
          await saveAlerts([{
            kind: 'robo', level: 'info', symbol: decisao.simbolo,
            title: `Robô comprou ${decisao.simbolo}`, message: decisao.texto,
            fingerprint: `robo-${decisao.id}`, payload: { ordem: decisao.ordem, resposta },
          }]).catch(() => {});
        } catch (error) {
          // Timeout NÃO é falha: é status desconhecido. Por isso a consulta por
          // origClientOrderId antes de qualquer conclusão — a ordem pode ter
          // entrado mesmo com a resposta perdida no caminho.
          const conferida = await signedBinance('/api/v3/order', 'GET', { symbol: decisao.simbolo, origClientOrderId: `${decisao.id}e` }).catch(() => null);
          const entrou = Boolean(conferida?.orderId);
          decisao.enviado = entrou;
          decisao.erro = entrou
            ? `A resposta se perdeu, mas a ordem ENTROU (${conferida.status}). Não reenviei.`
            : error.message;
          if (linha?.id) await marcarDecisaoEnviada(linha.id, entrou, decisao.erro, { ordem: decisao.ordem, conferida });
        }
      }
    }

    await salvarEstadoDoRobo({ ultimoCiclo: new Date().toISOString() }).catch(() => {});
    return (ultimoResultado = decisao);
  } catch (error) {
    const falha = { acao: 'ERRO', motivo: 'FALHA_NO_CICLO', texto: error.message, em: comecou, duracaoMs: Date.now() - comecou };
    await salvarDecisao({ acao: 'ERRO', motivo: 'FALHA_NO_CICLO', texto: error.message, modo: 'DESCONHECIDO', enviado: false, payload: {} }).catch(() => {});
    return (ultimoResultado = falha);
  } finally {
    cicloEmAndamento = false;
  }
}

// ============================================================
// WEBSOCKET — saber na hora, não no próximo ciclo
//
// O ciclo roda a cada 60 segundos. Isso significa que o robô descobria o
// preenchimento da entrada até um minuto depois de acontecer — e é justamente
// nesse minuto que o preço anda mais, logo depois de o mercado aceitar a
// ordem.
//
// O `user data stream` da Binance avisa no instante. Cada mudança de ordem
// chega como um evento `executionReport`, com o `clientOrderId` que nós mesmos
// demos a cada perna. É por isso que o id determinístico compensa três vezes:
// evita ordem duplicada, permite perguntar depois de um timeout, e aqui
// permite reconhecer o evento como nosso sem consultar nada.
//
// O POLLING NÃO SAI DE CENA. O WebSocket cai, o listenKey expira, a rede
// oscila. Ele é o caminho rápido; o ciclo continua sendo a rede de segurança.
// Trocar um pelo outro seria trocar atraso por cegueira.
// ============================================================

let ws = null, listenKey = null, keepAlive = null, reconexao = null, tentativas = 0;
let ultimoEvento = 0;

function websocketDisponivel() {
  return typeof WebSocket === 'function';
}

function baseWs() {
  const base = binanceConfig().base;
  return base.includes('testnet')
    ? 'wss://stream.testnet.binance.vision/ws'
    : 'wss://stream.binance.com:9443/ws';
}

async function abrirStream() {
  const cfg = binanceConfig();
  if (!cfg.key || !cfg.secret || !websocketDisponivel()) return false;
  try {
    const r = await signedBinance('/api/v3/userDataStream', 'POST').catch(async () => {
      // Este endpoint não é assinado: ele só quer a API key no cabeçalho.
      const res = await fetch(`${cfg.base}/api/v3/userDataStream`, { method: 'POST', headers: { 'X-MBX-APIKEY': cfg.key } });
      limites.registrar(res.status, res.headers);
      return res.json();
    });
    listenKey = r?.listenKey;
    if (!listenKey) return false;

    ws = new WebSocket(`${baseWs()}/${listenKey}`);
    ws.addEventListener('message', evento => {
      ultimoEvento = Date.now();
      let dados = null;
      try { dados = JSON.parse(evento.data); } catch { return; }
      if (dados.e !== 'executionReport') return;
      const id = String(dados.c || '');
      // Só reage ao que é nosso: o prefixo 'bt' é a assinatura do robô.
      if (!id.startsWith('bt')) return;
      // Preenchimento ou morte de perna muda o estado da posição — vale
      // conferir na hora em vez de esperar o ciclo.
      if (['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(dados.X || ''))) {
        conferirPosicoes().catch(() => {});
      }
    });
    ws.addEventListener('close', () => agendarReconexao('conexão fechada'));
    ws.addEventListener('error', () => agendarReconexao('erro na conexão'));
    ws.addEventListener('open', () => { tentativas = 0; console.log('Robô: stream da Binance conectado'); });

    // O listenKey morre em 60 minutos sem renovação. Renovar a cada 30 é a
    // recomendação da Binance, e deixa uma renovação inteira de margem para
    // uma falhar sem derrubar a conexão.
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = setInterval(async () => {
      await fetch(`${cfg.base}/api/v3/userDataStream?listenKey=${listenKey}`, { method: 'PUT', headers: { 'X-MBX-APIKEY': cfg.key } })
        .catch(() => agendarReconexao('keepalive falhou'));
    }, 30 * 60 * 1000);
    if (keepAlive.unref) keepAlive.unref();
    return true;
  } catch (error) {
    agendarReconexao(error.message);
    return false;
  }
}

/** Reconexão com espera crescente. Reconectar em loop apertado depois de uma
 *  queda é a forma mais rápida de gastar o limite de 300 conexões por 5
 *  minutos e ficar sem stream justo quando ele é mais necessário. */
function agendarReconexao(motivo) {
  if (reconexao) return;
  tentativas = Math.min(tentativas + 1, 6);
  const espera = Math.min(2 ** tentativas, 60) * 1000;
  console.log(`Robô: stream caiu (${motivo}). Reconectando em ${espera / 1000}s.`);
  reconexao = setTimeout(async () => {
    reconexao = null;
    fecharStream(false);
    await abrirStream();
  }, espera);
  if (reconexao.unref) reconexao.unref();
}

function fecharStream(definitivo = true) {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  if (definitivo && reconexao) { clearTimeout(reconexao); reconexao = null; }
  try { ws?.close(); } catch {}
  ws = null;
}

function estadoDoStream() {
  return {
    disponivel: websocketDisponivel(),
    conectado: Boolean(ws) && ws.readyState === 1,
    ultimoEventoHaMs: ultimoEvento ? Date.now() - ultimoEvento : null,
    tentativas,
    nota: websocketDisponivel()
      ? 'O ciclo continua rodando mesmo com o stream de pé: ele é a rede de segurança.'
      : 'Este Node não tem WebSocket global. O robô funciona igual, só descobre o preenchimento no ciclo seguinte.',
  };
}

/** Liga o relógio. Um `setInterval` só, guardado numa variável, para religar
 *  não criar dois agendadores mandando ordem em dobro. */
function ligarAgendador(segundos) {
  if (agendador) clearInterval(agendador);
  const intervalo = Math.max(30, Number(segundos) || 60) * 1000;
  agendador = setInterval(() => { cicloDoRobo().catch(error => console.error('Robô:', error.message)); }, intervalo);
  if (agendador.unref) agendador.unref();
  // O stream sobe junto, mas nunca substitui o ciclo.
  abrirStream().catch(() => {});
  return intervalo;
}

function pararAgendador() {
  if (agendador) clearInterval(agendador);
  agendador = null;
  fecharStream();
}

/** O painel: o que ele é, o que ele fez e por quê. */
async function painelDoRobo() {
  const salvo = await estadoDoRobo().catch(() => ({ ligado: false, killSwitch: false, config: {}, ultimoCiclo: null, semBanco: true }));
  const cfg = configDoRobo(salvo.config);
  const chaves = binanceConfig();

  // Tudo que impede o robô de trabalhar, dito antes de ele tentar.
  const impedimentos = [];
  if (salvo.semBanco && cfg.modo !== 'SIMULACAO') impedimentos.push('O PostgreSQL não está configurado. Fora da simulação o robô não opera sem ele: é o banco que impede ordem duplicada.');
  if (!chaves.key || !chaves.secret) {
    if (cfg.modo === 'SIMULACAO') impedimentos.push('Sem chave da Binance. Em simulação ele funciona assim mesmo, mas não vai enviar nada nunca.');
    else impedimentos.push('Sem BINANCE_API_KEY e BINANCE_API_SECRET no servidor não há como enviar ordem.');
  }
  if (cfg.notionalMaximo < MINIMO_NEGOCIAVEL) impedimentos.push(`O teto por ordem está em ${cfg.notionalMaximo} USDT e a Binance recusa ordem Spot abaixo de ${MINIMO_NEGOCIAVEL}. Nenhuma ordem passaria.`);
  if (salvo.killSwitch) impedimentos.push('O kill switch está acionado. Solte antes de ligar.');

  return {
    ligado: salvo.ligado,
    killSwitch: salvo.killSwitch,
    agendadorAtivo: Boolean(agendador),
    modo: cfg.modo,
    modoRealPermitido: process.env.ENABLE_LIVE_TRADING === 'true' && process.env.ROBO_PERMITE_REAL === 'true',
    config: cfg,
    ultimoCiclo: salvo.ultimoCiclo,
    ultimoResultado,
    stream: estadoDoStream(),
    limites: limites.estado(),
    // O painel tem de responder a pergunta que o Bruno faz olhando a tela:
    // "isso aqui vai fazer alguma coisa?". Antes ele mostrava os limites e
    // deixava a conclusao por conta de quem olhava.
    podeOperar: impedimentos.length === 0,
    impedimentos,
    protecao: 'Entrada, stop e alvo saem juntos num OTOCO. Depois que a entrada preenche, o stop e o alvo vivem dentro da Binance — se o robô cair, eles continuam de pé.',
    atualizadoEm: new Date().toISOString(),
  };
}

async function api(req, res, pathname) {
  if(!['GET','HEAD'].includes(req.method)&&!sameOrigin(req))return json(res,403,{error:'Origem não autorizada'});
  if (pathname === '/api/auth/session') return json(res, 200, {authenticated:authorized(req)});
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!process.env.APP_PASSWORD || !authSecret()) return json(res,503,{error:'Autenticação ainda não configurada'});
    const ip=clientIp(req);
    if(loginBlocked(ip)){res.setHeader('retry-after',String(Math.ceil(LOGIN_WINDOW_MS/1000)));return json(res,429,{error:'Muitas tentativas. Aguarde 15 minutos.'})}
    const data = await body(req);
    if (!passwordMatches(data.password)){recordLoginFailure(ip);return json(res,401,{error:'Senha incorreta'})}
    loginFailures.delete(ip);
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
  if (pathname === '/api/system/health' && req.method === 'GET') {
    // O DIAGNOSTICO. 07/09/2026: "muita coisa nao pega nao serve".
    //
    // Quase nada estava quebrado — faltava uma variavel de ambiente aqui, uma
    // permissao ali, e a tela ficava vazia sem dizer por que. Tela vazia e
    // indistinguivel de tela quebrada, e a diferenca entre "falta configurar"
    // e "esta com defeito" e a unica que importa para quem vai consertar.
    const banco=await databaseHealth(),chaves=binanceConfig(),robo=await estadoDoRobo().catch(()=>({ligado:false}));
    const item=(nome,ok,detalhe,comoResolver)=>({nome,ok,detalhe,comoResolver:ok?null:comoResolver});
    const itens=[
      item('Aplicação',true,'No ar e respondendo.'),
      item('Banco de dados',banco.online===true,banco.message,'Configure DATABASE_URL no Railway. Sem banco: nada de histórico, posições, ledger ou diário — e o robô só opera em simulação.'),
      item('Chave da Binance',Boolean(chaves.key&&chaves.secret),chaves.key?`Conectada em ${chaves.base.includes('testnet')?'Testnet':'produção'}.`:'Não configurada.','Adicione BINANCE_API_KEY e BINANCE_API_SECRET. Crie a chave sem permissão de saque e com restrição de IP.'),
      item('Preços do mercado',true,'Binance pública, sem chave.'),
      item('Teto por ordem',chaves.max>=MINIMO_NEGOCIAVEL,`${chaves.max} USDT por ordem.`,`MAX_ORDER_NOTIONAL está abaixo de ${MINIMO_NEGOCIAVEL} USDT, que é o mínimo que a Binance aceita. Nenhuma ordem passaria.`),
      item('Trading real',chaves.live,chaves.live?'Liberado no servidor.':'Bloqueado — só Testnet e simulação.','Só libere com ENABLE_LIVE_TRADING=true quando quiser dinheiro de verdade. Ficar bloqueado é o estado seguro.'),
      item('Robô',Boolean(robo.ligado),robo.ligado?'Ligado, olhando o mercado.':'Desligado.','Ligue na aba Robô. Ele começa em simulação e não envia nada.'),
      item('Análises com Claude',Boolean(process.env.ANTHROPIC_API_KEY),process.env.ANTHROPIC_API_KEY?'Disponível.':'Sem chave.','Opcional. Adicione ANTHROPIC_API_KEY para as leituras de mercado e a auditoria de plano.'),
      item('Alertas no WhatsApp',Boolean(process.env.WHATSAPP_WEBHOOK_URL),process.env.WHATSAPP_WEBHOOK_URL?'Configurado.':'Sem webhook.','Opcional. Configure WHATSAPP_WEBHOOK_URL para receber alertas fora do app.'),
    ];
    return json(res,200,{
      itens,
      prontos:itens.filter(x=>x.ok).length,
      total:itens.length,
      essenciaisOk:itens.slice(0,5).every(x=>x.ok),
      peso:limites.estado(),
      stream:estadoDoStream(),
      database:banco,marketFeed:'Binance público',app:true,
      updatedAt:new Date().toISOString(),
    });
  }
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
      const response=await fetchPublico(`${marketBase()}/api/v3/exchangeInfo`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Lista de mercados indisponível.');
      const symbols=data.symbols.filter(item=>item.status==='TRADING').map(item=>({symbol:item.symbol,base:item.baseAsset,quote:item.quoteAsset,spot:item.isSpotTradingAllowed}));
      return json(res,200,{symbols,count:symbols.length,updatedAt:new Date().toISOString()});
    }
    if (pathname === '/api/market/klines' && req.method === 'GET') {
      const url=new URL(req.url,'http://localhost'),symbol=normalizeMarketSymbol(url.searchParams.get('symbol')),interval=String(url.searchParams.get('interval')||'1d');
      if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!['15m','1h','4h','1d','1w'].includes(interval))return json(res,400,{error:'Par ou intervalo inválido.'});
      const response=await fetchPublico(`${marketBase()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`),data=await response.json();
      if(!response.ok)throw new Error(data.msg||'Gráfico indisponível.');
      return json(res,200,{symbol,interval,candles:data.map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])}))});
    }
    if (pathname === '/api/market/pretrade' && req.method === 'GET') {
      const symbol=normalizeMarketSymbol(new URL(req.url,'http://localhost').searchParams.get('symbol'));
      if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{error:'Par inválido.'});
      const [ticker,book,exchangeInfo,isolatedPairs,...sets]=await Promise.all([
        fetchPublico(`${marketBase()}/api/v3/ticker/24hr?symbol=${symbol}`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Ticker indisponível.');return d}),
        fetchPublico(`${marketBase()}/api/v3/depth?symbol=${symbol}&limit=100`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Livro de ofertas indisponível.');return d}),
        fetchPublico(`${marketBase()}/api/v3/exchangeInfo?symbol=${symbol}`).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.msg||'Informações do mercado indisponíveis.');return d}),
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
      const response=await fetchPublico(`${marketBase()}/api/v3/exchangeInfo?symbol=${symbol}`,{signal:AbortSignal.timeout(10000)}),info=await response.json();if(!response.ok)throw new Error(info.msg||'Filtros do par indisponíveis.');const market=info.symbols?.[0];if(!market||market.status!=='TRADING'||!market.isSpotTradingAllowed)return json(res,400,{error:'Este par não está disponível para Spot.'});
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
    // ---- ROBÔ ----
    if (pathname === '/api/robo/estado' && req.method === 'GET') return json(res,200,await painelDoRobo());
    if (pathname === '/api/robo/historico' && req.method === 'GET') return json(res,200,{decisoes:await decisoesDoRobo(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||50))});
    if (pathname === '/api/robo/ciclo' && req.method === 'POST') return json(res,200,{decisao:await cicloDoRobo({forcado:true}),painel:await painelDoRobo()});
    if (pathname === '/api/robo/posicoes' && req.method === 'GET') {
      const fechadas=await posicoesFechadasHoje().catch(()=>[]);
      // Sem banco o painel mostra vazio com explicacao, em vez de quebrar. Uma
      // tela de robo que da erro parece robo quebrado, e a diferenca entre
      // "sem banco" e "quebrado" e exatamente a que o Bruno precisa enxergar.
      const posicoes=await posicoesDoRobo(Number(new URL(req.url,'http://localhost').searchParams.get('limit')||50)).catch(()=>null);
      return json(res,200,{posicoes:posicoes||[],semBanco:posicoes===null,hoje:perdaDoDia(fechadas),limites:limites.estado(),stream:estadoDoStream()});
    }
    if (pathname === '/api/robo/conferir' && req.method === 'POST') {
      const conferidas=await conferirPosicoes();
      const reprotegidas=await reprotegerDesprotegidas().catch(()=>[]);
      return json(res,200,{...conferidas,reprotegidas,hoje:perdaDoDia(await posicoesFechadasHoje().catch(()=>[]))});
    }
    if (pathname === '/api/robo/reconciliar' && req.method === 'POST') return json(res,200,await reconciliarNoBoot());
    if (pathname === '/api/robo/config' && req.method === 'POST') {
      const dados=await body(req),cfg=normalizarConfig(dados.config||dados);
      await salvarEstadoDoRobo({config:cfg});
      if(agendador)ligarAgendador(cfg.intervaloSegundos);
      return json(res,200,{ok:true,painel:await painelDoRobo()});
    }
    if (pathname === '/api/robo/ligar' && req.method === 'POST') {
      const salvo=await estadoDoRobo();
      if(salvo.killSwitch)return json(res,403,{error:'O kill switch está acionado. Solte o kill switch antes de ligar.'});
      const cfg=configDoRobo(salvo.config);
      // Ligar em REAL exige confirmação explícita no cabeçalho, igual à ordem
      // manual. Um clique distraído no painel não pode virar dinheiro de
      // verdade — é a mesma trava que já protegia /api/binance/order.
      if(cfg.modo==='REAL'&&req.headers['x-confirm-live']!=='CONFIRMAR-ROBO-REAL')return json(res,403,{error:'Robô em modo REAL exige o cabeçalho de confirmação.'});
      await salvarEstadoDoRobo({ligado:true});
      ligarAgendador(cfg.intervaloSegundos);
      return json(res,200,{ok:true,painel:await painelDoRobo()});
    }
    if (pathname === '/api/robo/desligar' && req.method === 'POST') {
      pararAgendador();
      await salvarEstadoDoRobo({ligado:false});
      return json(res,200,{ok:true,painel:await painelDoRobo()});
    }
    // O BOTÃO VERMELHO. Desliga, trava o religamento e cancela TODAS as ordens
    // abertas dos pares que o robô tocou. Só um humano solta depois.
    if (pathname === '/api/robo/panico' && req.method === 'POST') {
      pararAgendador();
      await salvarEstadoDoRobo({ligado:false,killSwitch:true});
      const abertas=await signedBinance('/api/v3/openOrders').catch(()=>[]),minhas=ordensDoRoboParaPanico(Array.isArray(abertas)?abertas:[]),canceladas=[],listas=new Set();
      for(const ordem of minhas){const listId=Number(ordem.orderListId);if(Number.isFinite(listId)&&listId>=0){if(listas.has(listId))continue;listas.add(listId);const resultado=await signedBinance('/api/v3/orderList','DELETE',{symbol:ordem.symbol,orderListId:String(listId)}).catch(error=>({erro:error.message}));canceladas.push({simbolo:ordem.symbol,orderListId:listId,resultado})}else{const resultado=await signedBinance('/api/v3/order','DELETE',{symbol:ordem.symbol,orderId:String(ordem.orderId)}).catch(error=>({erro:error.message}));canceladas.push({simbolo:ordem.symbol,orderId:ordem.orderId,resultado})}}
      const falhas=canceladas.filter(x=>x.resultado?.erro);
      return json(res,falhas.length?502:200,{ok:falhas.length===0,encontradas:minhas.length,canceladas,preservadas:(Array.isArray(abertas)?abertas.length:0)-minhas.length,falhas,painel:await painelDoRobo()});
    }
    if (pathname === '/api/robo/soltar-panico' && req.method === 'POST') {
      await salvarEstadoDoRobo({killSwitch:false});
      return json(res,200,{ok:true,painel:await painelDoRobo()});
    }
    if (pathname === '/api/earn/overview' && req.method === 'GET') return json(res,200,await earnOverview());
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
        try{const response=await fetchPublico(`${marketBase()}/api/v3/exchangeInfo`,{signal:AbortSignal.timeout(10000)}),data=await response.json();if(!response.ok)throw new Error(data.msg||'Catálogo indisponível.');const preferred=monitorFallback.map(x=>x.symbol);crypto=(data.symbols||[]).filter(item=>item.status==='TRADING'&&item.isSpotTradingAllowed&&item.quoteAsset==='USDT'&&!/(UP|DOWN|BULL|BEAR)$/.test(item.baseAsset)).map(item=>({symbol:item.symbol,label:`${item.baseAsset} / USDT`,market:'Cripto · Binance',quantityLabel:item.baseAsset,feed:'Binance'})).sort((a,b)=>{const ai=preferred.indexOf(a.symbol),bi=preferred.indexOf(b.symbol);if(ai>=0||bi>=0)return (ai<0?999:ai)-(bi<0?999:bi);return a.label.localeCompare(b.label)});monitorAssetCache={assets:crypto,updatedAt:Date.now()};source='Binance'}catch(error){crypto=crypto.length?crypto:monitorFallback;source=monitorAssetCache.assets.length?'cache':'fallback';stale=true}}
      const mnq={symbol:'MNQ',label:'MNQ · Micro E-mini Nasdaq-100',market:'Futuros EUA',quantityLabel:'Contratos',feed:'Yahoo Finance indicativo'};
      return json(res,200,{assets:[mnq,...crypto],count:crypto.length+1,source,stale,updatedAt:new Date(monitorAssetCache.updatedAt||Date.now()).toISOString()});
    }
    if (pathname === '/api/positions/quote' && req.method === 'GET') {const symbol=String(new URL(req.url,'http://localhost').searchParams.get('symbol')||'').toUpperCase();if(!/^(MNQ|[A-Z0-9]{5,20})$/.test(symbol))return json(res,400,{error:'Ativo inválido.'});return json(res,200,{symbol,price:await publicPrice(symbol),currency:symbol==='MNQ'?'USD':'USDT',feed:symbol==='MNQ'?'CME via feed público':'Binance',updatedAt:new Date().toISOString()});}
    if (pathname === '/api/positions/monitor' && req.method === 'GET') return json(res,200,await monitorPositions());
    // A ORDEM ANTES DE CLICAR. O Bruno digita o que vai fazer e vê o valor da
    // compra, o lucro no alvo, a perda no stop, as taxas e — o que a Binance
    // esconde numa aba — o preço de liquidação.
    if (pathname === '/api/ordem/simular' && req.method === 'POST') {
      const corpo = await body(req);
      return json(res, 200, simularOrdem({
        margem: Number(corpo.margem), alavancagem: Number(corpo.alavancagem),
        precoEntrada: Number(corpo.precoEntrada), stop: Number(corpo.stop || 0),
        alvo: Number(corpo.alvo || 0), direcao: corpo.direcao === 'SHORT' ? 'SHORT' : 'LONG',
      }));
    }

    // O caminho inverso, e o que deveria ser o padrão: diz quanto pode perder
    // e o tamanho da ordem sai como consequência.
    if (pathname === '/api/ordem/pelo-risco' && req.method === 'POST') {
      const corpo = await body(req);
      const r = margemParaRisco({
        perdaMaximaUsdt: Number(corpo.perdaMaxima), precoEntrada: Number(corpo.precoEntrada),
        stop: Number(corpo.stop), direcao: corpo.direcao === 'SHORT' ? 'SHORT' : 'LONG',
        alavancagem: Number(corpo.alavancagem || 10),
      });
      return r ? json(res, 200, r)
               : json(res, 400, { erro: 'Confira o preço de entrada e o stop — o stop precisa estar do lado certo da entrada.' });
    }

    if (pathname === '/api/binance/posicoes' && req.method === 'GET') {
      try {
        const posicoes = await posicoesAlavancadas();
        const ordens = ordensDaMesa(posicoes.map(p => ({
          simbolo: p.simbolo, entrada: p.precoEntrada,
          // Sem stop cadastrado, a liquidação É o stop — e é o pior stop que
          // existe, porque leva a margem inteira junto.
          stopInicial: 0, preco: p.precoAtual, pico: p.precoAtual,
          direcao: p.direcao, quantidade: p.quantidade, moeda: 'USDT',
        })));
        return json(res, 200, { posicoes, ordens, atualizadoEm: new Date().toISOString() });
      } catch (error) {
        return json(res, 200, { posicoes: [], erro: error.message, atualizadoEm: new Date().toISOString() });
      }
    }
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
  } catch (error) {const status=Number(error.statusCode)||502;return json(res,status,{error:status>=500?'Falha ao processar a solicitação.':error.message}); }
}

function handler(req, res) {
  applySecurityHeaders(req,res);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({status:'ok', app:'BaladaTrade'}));
  }
  if (url.pathname.startsWith('/api/')) return void api(req,res,url.pathname).catch(error=>{if(!res.headersSent)json(res,Number(error.statusCode)||500,{error:Number(error.statusCode)<500?error.message:'Falha ao processar a solicitação.'})});
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(root, requested));
  const relative=path.relative(root,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403);return res.end('Forbidden')}
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
  initDatabase().then(async ok=>{
    console.log(ok?'PostgreSQL conectado':'PostgreSQL não configurado');
    if(!ok)return;
    // O robô volta do jeito que estava. O Railway reinicia sozinho (deploy,
    // troca de máquina, falta de memória) e um robô que não volta é um robô
    // que só parece estar cuidando da conta.
    //
    // Volta APENAS se estava ligado e sem kill switch — reinício não pode
    // desfazer um desligamento que o Bruno fez de propósito.
    const salvo=await estadoDoRobo().catch(()=>null);
    if(salvo?.ligado&&!salvo.killSwitch){
      const cfg=configDoRobo(salvo.config);
      // A CORRETORA E A FONTE DA VERDADE, o banco se ajusta a ela. Sem isto o
      // robo subia acreditando numa realidade que podia ter mudado enquanto
      // ele estava fora: ordem cancelada pelo aplicativo, posicao que fechou,
      // ou um trailing interrompido no meio deixando a posicao descoberta.
      if(cfg.modo!=='SIMULACAO'){
        const r=await reconciliarNoBoot();
        console.log(`Robô: ${r.conferidas.length} posição(ões) conferida(s), ${r.reprotegidas.length} reprotegida(s), ${r.orfas.length} ordem(ns) órfã(s)${r.erro?` — ${r.erro}`:''}`);
      }
      ligarAgendador(cfg.intervaloSegundos);
      console.log(`Robô religado em modo ${cfg.modo}, ciclo de ${cfg.intervaloSegundos}s`);
    }else{
      console.log('Robô desligado. Ligue em /api/robo/ligar quando quiser.');
    }
  }).catch(error=>console.error('Falha PostgreSQL:',error.message));
}
module.exports = {handler,leituraDaMesa,peneira,ordensDoRoboParaPanico,configDoRobo,timeframeReading};
