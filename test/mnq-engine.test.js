const test=require('node:test');
const assert=require('node:assert/strict');
const {MNQ,PROP_PROFILES,riskState,positionSize,backtest}=require('../mnq-engine');

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
