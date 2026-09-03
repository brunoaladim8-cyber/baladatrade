'use strict';

function decimalPlaces(step){const text=String(step);if(text.includes('e-'))return Number(text.split('e-')[1]);return (text.split('.')[1]||'').replace(/0+$/,'').length}
function floorStep(value,step){const size=Number(step)||1,scale=10**Math.min(decimalPlaces(size),12);return Math.floor((Number(value)*scale+1e-9)/(size*scale))*size}
function roundStep(value,step,mode='nearest'){const size=Number(step)||1,ratio=Number(value)/size,result=mode==='down'?Math.floor(ratio+1e-12):mode==='up'?Math.ceil(ratio-1e-12):Math.round(ratio);return Number((result*size).toFixed(Math.min(decimalPlaces(size),12)))}
function filterValue(filters,type,key,fallback){const row=(filters||[]).find(item=>item.filterType===type);const value=Number(row?.[key]);return Number.isFinite(value)&&value>0?value:fallback}

function calculateSpotPlan(input={}){
  const symbol=String(input.symbol||'').toUpperCase(),capital=Number(input.capital),riskPct=Number(input.riskPct),entry=Number(input.entry),stop=Number(input.stop),target=Number(input.target),feeRate=Number.isFinite(Number(input.feeRate))?Number(input.feeRate):.001,filters=input.filters||[];
  if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error('Par Spot inválido.');
  if(![capital,riskPct,entry,stop,target].every(Number.isFinite)||capital<=0||riskPct<=0||riskPct>5||entry<=0||stop<=0||target<=0)throw new Error('Capital, risco, entrada, stop e alvo devem ser válidos.');
  if(!(stop<entry&&target>entry))throw new Error('No Spot comprado, o stop deve ficar abaixo da entrada e o alvo acima.');
  if(feeRate<0||feeRate>.01)throw new Error('Taxa fora do intervalo permitido.');
  const stepSize=filterValue(filters,'LOT_SIZE','stepSize',1e-8),minQty=filterValue(filters,'LOT_SIZE','minQty',stepSize),maxQty=filterValue(filters,'LOT_SIZE','maxQty',Number.MAX_SAFE_INTEGER),tickSize=filterValue(filters,'PRICE_FILTER','tickSize',1e-8),minNotional=filterValue(filters,'NOTIONAL','minNotional',filterValue(filters,'MIN_NOTIONAL','minNotional',0));
  const riskBudget=capital*riskPct/100,riskPerUnit=(entry-stop)+(entry+stop)*feeRate,quantityByRisk=riskBudget/riskPerUnit,quantityByCapital=capital/(entry*(1+feeRate)),rawQuantity=Math.min(quantityByRisk,quantityByCapital,maxQty),quantity=floorStep(rawQuantity,stepSize),notional=quantity*entry,entryFee=notional*feeRate,exitAtStop=quantity*stop,stopFee=exitAtStop*feeRate,exitAtTarget=quantity*target,targetFee=exitAtTarget*feeRate,lossGross=quantity*(entry-stop),lossNet=lossGross+entryFee+stopFee,gainGross=quantity*(target-entry),gainNet=gainGross-entryFee-targetFee,rrNet=lossNet>0?gainNet/lossNet:0,blockers=[];
  if(quantity<minQty)blockers.push(`Quantidade abaixo do mínimo ${minQty}.`);
  if(notional<minNotional)blockers.push(`Valor da posição abaixo do mínimo ${minNotional} USDT.`);
  if(lossNet>riskBudget+1e-8)blockers.push('Perda líquida estimada ultrapassa o risco máximo.');
  if(notional+entryFee>capital+1e-8)blockers.push('Saldo insuficiente considerando a taxa de entrada.');
  if(rrNet<1.3)blockers.push('Risco/retorno líquido abaixo de 1:1,30.');
  const oco={quantity,takeProfit:roundStep(target,tickSize,'down'),stopPrice:roundStep(stop,tickSize,'down'),stopLimit:roundStep(stop*(1-.001),tickSize,'down'),tickSize,stepSize,note:'Valores para conferência manual; nenhuma ordem foi enviada.'};
  return {symbol,mode:'SPOT_MANUAL',direction:'LONG',capital,riskPct,riskBudget,entry,stop,target,feeRate,quantity,notional,entryFee,stopFee,targetFee,lossGross,lossNet,gainGross,gainNet,riskRewardNet:rrNet,exposurePct:capital?notional/capital*100:0,filters:{stepSize,minQty,maxQty,tickSize,minNotional},oco,allowed:blockers.length===0,blockers,execution:'BLOCKED'};
}

module.exports={calculateSpotPlan,floorStep,roundStep};
