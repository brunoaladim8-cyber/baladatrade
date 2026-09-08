const test=require('node:test');
const assert=require('node:assert/strict');
const {timeframeReading}=require('../server');

test('scanner ignora o candle ainda aberto',()=>{
  const now=Date.now();
  const fechados=Array.from({length:60},(_,i)=>({
    time:now-(60-i)*60000,
    closeTime:now-(59-i)*60000-1,
    open:100+i*.1,
    high:100.3+i*.1,
    low:99.7+i*.1,
    close:100+i*.1,
    volume:10,
    quoteVolume:100,
  }));
  const aberto={
    time:now,
    closeTime:now+60000,
    open:105.9,
    high:999,
    low:105,
    close:999,
    volume:1000,
    quoteVolume:10000,
  };
  const leitura=timeframeReading([...fechados,aberto],'15m');
  assert.equal(leitura.price,fechados.at(-1).close);
  assert.equal(leitura.volumeRatio,1);
  assert.ok(leitura.rsi<=100);
});
