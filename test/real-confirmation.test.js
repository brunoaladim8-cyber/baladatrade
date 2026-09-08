const test=require('node:test');
const assert=require('node:assert/strict');
const {confirmacaoRealValida}=require('../server');

test('simulação e Testnet não exigem confirmação de dinheiro real',()=>{
  assert.equal(confirmacaoRealValida({headers:{}},'SIMULACAO'),true);
  assert.equal(confirmacaoRealValida({headers:{}},'TESTNET'),true);
});

test('ciclo REAL exige o cabeçalho exato',()=>{
  assert.equal(confirmacaoRealValida({headers:{}},'REAL'),false);
  assert.equal(confirmacaoRealValida({headers:{'x-confirm-live':'errado'}},'REAL'),false);
  assert.equal(confirmacaoRealValida({headers:{'x-confirm-live':'CONFIRMAR-ROBO-REAL'}},'REAL'),true);
});
