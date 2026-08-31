'use strict';

const MNQ={pointValue:2,tickSize:.25,tickValue:.5};

const PROP_PROFILES={
  tpt_test:{firm:'Take Profit Trader',phase:'Teste',drawdown:'EOD',dailyLoss:null,consistency:50,minDays:3,newsAllowed:true,automation:'SIM_ONLY',source:'https://takeprofittraderhelp.zendesk.com/hc/en-us/sections/15168850786589-The-5-Core-Rules'},
  tpt_pro:{firm:'Take Profit Trader',phase:'PRO',drawdown:'INTRADAY',dailyLoss:null,consistency:null,minDays:null,newsAllowed:false,automation:'SIGNAL_ONLY',source:'https://takeprofittraderhelp.zendesk.com/hc/en-us/articles/15171769361053-PRO-Account-Rules'},
  tpt_pro_plus:{firm:'Take Profit Trader',phase:'PRO+',drawdown:'EOD',dailyLoss:null,consistency:null,minDays:null,newsAllowed:false,automation:'SIGNAL_ONLY',source:'https://try.takeprofittrader.com/TPT-FAQs-nf40-4-0725'},
  lucid_eval_eod:{firm:'Lucid Trading',phase:'Avaliação EOD',drawdown:'EOD',dailyLoss:'OPTIONAL',consistency:50,minDays:null,newsAllowed:true,automation:'SIM_ONLY',source:'https://support.lucidtrading.com/en/articles/15996664-luciddaily-evaluation'},
  lucid_eval_intraday:{firm:'Lucid Trading',phase:'Avaliação intraday',drawdown:'INTRADAY',dailyLoss:'OPTIONAL',consistency:50,minDays:null,newsAllowed:true,automation:'SIM_ONLY',source:'https://support.lucidtrading.com/en/articles/15996664-luciddaily-evaluation'},
  lucid_funded:{firm:'Lucid Trading',phase:'LucidDaily financiada',drawdown:'INTRADAY',dailyLoss:'OPTIONAL',consistency:null,minDays:null,newsAllowed:false,automation:'SIGNAL_ONLY',source:'https://support.lucidtrading.com/en/articles/15997244-luciddaily-funded-account'},
};

const LUCID_RULES={
  25000:{maxLoss:1000,dll:600,maxMicros:20},
  50000:{maxLoss:2000,dll:1200,maxMicros:40},
  100000:{maxLoss:3000,dll:1800,maxMicros:60},
  150000:{maxLoss:4500,dll:2700,maxMicros:100},
};
const TPT_RULES={
  25000:{maxLoss:1500,dll:null,maxMicros:30},
  50000:{maxLoss:2000,dll:null,maxMicros:60},
  100000:{maxLoss:3000,dll:null,maxMicros:120},
  150000:{maxLoss:4500,dll:null,maxMicros:150},
};
const ACCOUNT_RULES=LUCID_RULES;

function roundTick(value){return Math.round(value/MNQ.tickSize)*MNQ.tickSize}
function priceInZone(price,zoneLow,zoneHigh){return Number.isFinite(price)&&Number.isFinite(zoneLow)&&Number.isFinite(zoneHigh)&&price>=zoneLow-MNQ.tickSize/2&&price<=zoneHigh+MNQ.tickSize/2}
function ema(values,period){if(!values.length)return 0;const k=2/(period+1);return values.slice(1).reduce((a,v)=>v*k+a*(1-k),values[0])}
function atr(candles,period=14){const rows=candles.map((c,i)=>Math.max(c.high-c.low,i?Math.abs(c.high-candles[i-1].close):0,i?Math.abs(c.low-candles[i-1].close):0));const sample=rows.slice(-period);return sample.length?sample.reduce((a,b)=>a+b,0)/sample.length:0}
function aggregate(candles,size=4){const out=[];for(let i=0;i<candles.length;i+=size){const rows=candles.slice(i,i+size);if(rows.length<size)break;out.push({time:rows[0].time,open:rows[0].open,high:Math.max(...rows.map(x=>x.high)),low:Math.min(...rows.map(x=>x.low)),close:rows.at(-1).close,volume:rows.reduce((s,x)=>s+(x.volume||0),0)})}return out}
function pivots(candles,wings=3){const highs=[],lows=[];for(let i=wings;i<candles.length-wings;i++){const window=candles.slice(i-wings,i+wings+1),c=candles[i];if(window.every((x,j)=>j===wings||c.high>x.high))highs.push({index:i,price:c.high,time:c.time});if(window.every((x,j)=>j===wings||c.low<x.low))lows.push({index:i,price:c.low,time:c.time})}return {highs,lows}}
function macroTrend(candles){const hourly=aggregate(candles,4),closes=hourly.map(x=>x.close),fast=ema(closes,20),slow=ema(closes,50),price=closes.at(-1)||0;return {trend:fast>slow&&price>fast?'LONG':fast<slow&&price<fast?'SHORT':'NEUTRAL',ema20:fast,ema50:slow,price}}
function riskState(input={}){
  const profile=PROP_PROFILES[input.profile]||PROP_PROFILES.tpt_test,size=Number(input.accountSize)||50000,ruleSet=profile.firm==='Take Profit Trader'?TPT_RULES:LUCID_RULES,rules=ruleSet[size]||ruleSet[50000];
  const start=Number(input.startBalance)||size,balance=Number(input.balance)||start,openPnl=Number(input.openPnl)||0,sessionStart=Number(input.sessionStartBalance)||balance,peak=Math.max(Number(input.peakEquity)||balance,balance+openPnl),dllEnabled=input.dllEnabled!==false;
  const maxLoss=Number(input.maxLoss)||rules.maxLoss,lockedFloor=start+100,rawFloor=(profile.drawdown==='INTRADAY'?peak:Number(input.peakClosedBalance)||balance)-maxLoss,threshold=Math.min(rawFloor,lockedFloor),dailyFloor=dllEnabled&&profile.dailyLoss==='OPTIONAL'?sessionStart-(Number(input.dailyLoss)||rules.dll):-Infinity;
  const effectiveFloor=Math.max(threshold,dailyFloor),equity=balance+openPnl,remaining=equity-effectiveFloor;
  return {profileKey:input.profile||'tpt_test',...profile,accountSize:size,maxLoss,maxMicros:rules.maxMicros,threshold,peakEquity:peak,dailyFloor:Number.isFinite(dailyFloor)?dailyFloor:null,effectiveFloor,equity,remaining,blocked:remaining<=0,warning:remaining<=maxLoss*.2};
}

function detectSetup(candles,options={}){
  if(!Array.isArray(candles)||candles.length<80)return {state:'SEM_DADOS',reason:'São necessários pelo menos 80 candles de 15 minutos.'};
  const confirmed=candles.slice(0,-3),last=confirmed.at(-1),macro=macroTrend(confirmed),a=atr(confirmed,14),p=pivots(confirmed,3),buffer=a*(Number(options.bosBufferAtr)||.1),recentHigh=[...p.highs].reverse().find(x=>x.index<confirmed.length-1),recentLow=[...p.lows].reverse().find(x=>x.index<confirmed.length-1);
  let direction=null,broken=null,impulseStart=null;
  if(recentHigh&&last.close>recentHigh.price+buffer){direction='LONG';broken=recentHigh;impulseStart=[...p.lows].reverse().find(x=>x.index<recentHigh.index)||recentLow}
  else if(recentLow&&last.close<recentLow.price-buffer){direction='SHORT';broken=recentLow;impulseStart=[...p.highs].reverse().find(x=>x.index<recentLow.index)||recentHigh}
  if(!direction)return {state:'AGUARDANDO_BOS',reason:'Nenhum fechamento confirmou quebra de estrutura.',macro,atr:a,lastClose:last.close,pivots:p};
  if(macro.trend!==direction)return {state:'CONTRA_MACRO',reason:`BOS ${direction}, mas tendência macro está ${macro.trend}.`,direction,macro,atr:a,broken};
  if(!impulseStart)return {state:'SEM_IMPULSO',reason:'Não foi possível ancorar o impulso anterior.',direction,macro,atr:a,broken};
  const end=direction==='LONG'?Math.max(...confirmed.slice(impulseStart.index).map(x=>x.high)):Math.min(...confirmed.slice(impulseStart.index).map(x=>x.low)),start=impulseStart.price,range=Math.abs(end-start),fib50=direction==='LONG'?end-range*.5:end+range*.5,fib618=direction==='LONG'?end-range*.618:end+range*.618,zoneLow=Math.min(fib50,fib618),zoneHigh=Math.max(fib50,fib618),inZone=last.low<=zoneHigh&&last.high>=zoneLow,rejection=direction==='LONG'?inZone&&last.close>zoneHigh:inZone&&last.close<zoneLow;
  // A confirmação acontece no fechamento do candle, mas a entrada planejada precisa
  // continuar dentro da retração de 50–61,8%. Não confundir confirmação com execução.
  const confirmationPrice=roundTick(last.close),entry=roundTick((zoneLow+zoneHigh)/2),entryValid=priceInZone(entry,zoneLow,zoneHigh),contracts=Math.max(1,Number(options.contracts)||1),stopDollar=Number(options.stopDollar)||Number(options.riskBudget)||100,targetDollar=Number(options.targetDollar)||stopDollar*1.3,riskPoints=stopDollar/(contracts*MNQ.pointValue),rewardPoints=targetDollar/(contracts*MNQ.pointValue),stop=roundTick(direction==='LONG'?entry-riskPoints:entry+riskPoints),target=roundTick(direction==='LONG'?entry+rewardPoints:entry-rewardPoints),actualRiskPoints=Math.abs(entry-stop),actualRewardPoints=Math.abs(target-entry),setupConfirmed=rejection&&entryValid;
  return {state:setupConfirmed?'ENTRADA_CONFIRMADA':'AGUARDANDO_PULLBACK',reason:setupConfirmed?'Rejeição confirmada; entrada planejada dentro da zona Fibonacci.':'BOS confirmado; aguardando preço rejeitar a zona 50–61,8%.',direction,macro,atr:a,broken,impulse:{start,end},fib:{fifty:fib50,sixtyOneEight:fib618,zoneLow,zoneHigh},inZone,rejection,confirmationPrice,entry,entryValid,entryType:'LIMIT_FIB_ZONE',stop,target,riskPoints:actualRiskPoints,rewardPoints:actualRewardPoints,riskUsdPerContract:actualRiskPoints*MNQ.pointValue,rewardUsdPerContract:actualRewardPoints*MNQ.pointValue,riskUsdTotal:actualRiskPoints*MNQ.pointValue*contracts,rewardUsdTotal:actualRewardPoints*MNQ.pointValue*contracts,contractsRequested:contracts,stopMode:'DOLLAR',targetMode:'DOLLAR'};
}

function positionSize(setup,riskBudget,maxMicros=1){if(!setup.riskUsdPerContract)return 0;return Math.max(0,Math.min(maxMicros,Math.floor(Number(riskBudget)/setup.riskUsdPerContract)))}

function backtest(candles,options={}){
  const trades=[];let open=null;for(let i=80;i<candles.length;i++){const c=candles[i];if(open){const stopHit=open.direction==='LONG'?c.low<=open.stop:c.high>=open.stop,targetHit=open.direction==='LONG'?c.high>=open.target:c.low<=open.target;if(stopHit||targetHit){const exit=stopHit?open.stop:open.target,pnl=(open.direction==='LONG'?exit-open.entry:open.entry-exit)*MNQ.pointValue*open.contracts;trades.push({...open,exit,exitTime:c.time,outcome:stopHit?'STOP':'TARGET',pnl});open=null}continue}const setup=detectSetup(candles.slice(0,i+1),{...options,contracts:Number(options.maxMicros)||1});if(setup.state==='ENTRADA_CONFIRMADA'){const contracts=positionSize(setup,Number(options.riskBudget)||100,Number(options.maxMicros)||1);if(contracts)open={direction:setup.direction,entry:setup.entry,stop:setup.stop,target:setup.target,contracts,entryTime:c.time,riskUsd:setup.riskUsdPerContract*contracts}}}
  const net=trades.reduce((s,t)=>s+t.pnl,0),wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0),grossWin=wins.reduce((s,t)=>s+t.pnl,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));let equity=0,peak=0,maxDrawdown=0;for(const t of trades){equity+=t.pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity)}return {trades,summary:{trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length*100:0,net,grossWin,grossLoss,profitFactor:grossLoss?grossWin/grossLoss:null,maxDrawdown}};
}

module.exports={MNQ,PROP_PROFILES,ACCOUNT_RULES,TPT_RULES,LUCID_RULES,ema,atr,pivots,macroTrend,riskState,detectSetup,positionSize,backtest,priceInZone};
