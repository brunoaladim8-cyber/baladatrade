const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateSpotPlan,floorStep}=require('../spot-engine');

const filters=[
  {filterType:'PRICE_FILTER',tickSize:'0.01'},
  {filterType:'LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},
  {filterType:'NOTIONAL',minNotional:'5'}
];

test('quantidade Spot respeita risco, saldo, step e taxas',()=>{
  const plan=calculateSpotPlan({symbol:'BTCUSDT',capital:1000,riskPct:1,entry:100,stop:95,target:112,feeRate:.001,filters});
  assert.equal(plan.quantity,1.924);
  assert.ok(plan.lossNet<=10);
  assert.ok(plan.notional+plan.entryFee<=1000);
  assert.equal(plan.allowed,true);
});

test('quantidade nunca é arredondada para cima',()=>{
  assert.equal(floorStep(1.2349,.001),1.234);
  assert.equal(floorStep(.000019,.00001),.00001);
});

test('bloqueia mínimo nocional e relação líquida ruim',()=>{
  const plan=calculateSpotPlan({symbol:'ETHUSDT',capital:4,riskPct:1,entry:100,stop:99,target:100.5,filters});
  assert.equal(plan.allowed,false);
  assert.ok(plan.blockers.some(x=>x.includes('mínimo')));
  assert.ok(plan.blockers.some(x=>x.includes('1:1,30')));
});

test('Spot rejeita stop acima ou alvo abaixo da entrada',()=>{
  assert.throws(()=>calculateSpotPlan({symbol:'SOLUSDT',capital:100,riskPct:1,entry:100,stop:101,target:110,filters}),/stop deve ficar abaixo/);
});
