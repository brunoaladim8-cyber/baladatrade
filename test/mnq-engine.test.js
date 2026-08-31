const test=require('node:test');
const assert=require('node:assert/strict');
const {MNQ,PROP_PROFILES,riskState,detectSetup,positionSize,backtest,priceInZone}=require('../mnq-engine');

test('MNQ usa especificação correta de ponto e tick',()=>{
  assert.equal(MNQ.pointValue,2);
  assert.equal(MNQ.tickSize,.25);
  assert.equal(MNQ.tickValue,.5);
});

test('Lucid intraday acompanha patrimônio aberto e trava no limite',()=>{
  const state=riskState({profile:'lucid_funded',accountSize:50000,startBalance:50000,balance:50000,openPnl:1500,peakEquity:51500,sessionStartBalance:50000,dllEnabled:true});
  assert.equal(state.drawdown,'INTRADAY');
  assert.equal(state.threshold,49500);
  assert.equal(state.dailyFloor,48800);
  assert.equal(state.effectiveFloor,49500);
  assert.equal(state.remaining,2000);
});

test('Take Profit Trader Test usa drawdown EOD e consistência 50%',()=>{
  const profile=PROP_PROFILES.tpt_test;
  assert.equal(profile.drawdown,'EOD');
  assert.equal(profile.consistency,50);
  assert.equal(profile.dailyLoss,null);
});

test('TPT e Lucid aplicam limites próprios para conta de 50k',()=>{
  const tpt=riskState({profile:'tpt_test',accountSize:50000,balance:50000,peakEquity:50000});
  const lucid=riskState({profile:'lucid_eval_eod',accountSize:50000,balance:50000,peakEquity:50000});
  assert.equal(tpt.maxLoss,2000);
  assert.equal(tpt.maxMicros,60);
  assert.equal(lucid.maxLoss,2000);
  assert.equal(lucid.maxMicros,40);
  assert.equal(lucid.consistency,50);
});

test('TPT 25k usa drawdown 1500 e limite 30 micros',()=>{
  const state=riskState({profile:'tpt_pro',accountSize:25000,balance:25000,peakEquity:25000});
  assert.equal(state.maxLoss,1500);
  assert.equal(state.maxMicros,30);
  assert.equal(state.threshold,23500);
});

test('tamanho de posição nunca excede risco ou limite de micros',()=>{
  const setup={riskUsdPerContract:52};
  assert.equal(positionSize(setup,100,10),1);
  assert.equal(positionSize(setup,51,10),0);
  assert.equal(positionSize(setup,1000,3),3);
});

test('backtest rejeita série curta sem criar operações',()=>{
  const candles=Array.from({length:20},(_,i)=>({time:i,open:100,high:101,low:99,close:100,volume:1}));
  const result=backtest(candles,{riskBudget:100,maxMicros:1});
  assert.equal(result.summary.trades,0);
  assert.equal(result.summary.net,0);
});

test('stop e take em dólar são convertidos por quantidade e valor do ponto',()=>{
  const candles=Array.from({length:100},(_,i)=>({time:i,open:100+i,high:101+i,low:99+i,close:100+i,volume:1}));
  const original=detectSetup(candles,{contracts:2,stopDollar:80,targetDollar:104});
  if(original.entry){
    assert.equal(original.entryValid,true);
    assert.equal(priceInZone(original.entry,original.fib.zoneLow,original.fib.zoneHigh),true);
    assert.equal(original.entryType,'LIMIT_FIB_ZONE');
    assert.equal(original.riskUsdTotal,80);
    assert.equal(original.rewardUsdTotal,104);
    assert.equal(original.stopMode,'DOLLAR');
    assert.equal(original.targetMode,'DOLLAR');
  }else assert.ok(['AGUARDANDO_BOS','CONTRA_MACRO','SEM_IMPULSO'].includes(original.state));
});

test('trava qualquer entrada fora da zona Fibonacci',()=>{
  assert.equal(priceInZone(100,100,110),true);
  assert.equal(priceInZone(110,100,110),true);
  assert.equal(priceInZone(99.5,100,110),false);
  assert.equal(priceInZone(110.5,100,110),false);
});
