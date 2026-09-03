const test = require('node:test');
const assert = require('node:assert');
const {leituraDaMesa, peneira} = require('../server.js');

// Reproduz o estado real da mesa em 02/09/2026: MNQ comprado a 29.414 e MNQ
// vendido a 29.800 ao mesmo tempo, mais APT comprado — as tres sem stop.
const posicoesDe0209 = [
  {symbol:'APTUSDT',direction:'LONG',quantity:30,pnl:0.84,currency:'USDT',hasStop:false,hasPlan:false},
  {symbol:'MNQ',direction:'SHORT',quantity:6,pnl:7407,currency:'USD',hasStop:false,hasPlan:false},
  {symbol:'MNQ',direction:'LONG',quantity:6,pnl:-2775,currency:'USD',hasStop:false,hasPlan:false},
];

test('a trava de MNQ aparece — nenhuma posicao sozinha a revela', () => {
  const {leitura} = leituraDaMesa(posicoesDe0209);
  const trava = leitura.travas.find(t => t.symbol === 'MNQ');
  assert.ok(trava, 'a trava de MNQ precisa ser detectada');
  assert.strictEqual(trava.travada, true, '6 comprados contra 6 vendidos e exposicao zero');
  assert.strictEqual(trava.exposicaoLiquida, 0);
  assert.strictEqual(trava.resultadoSomado, 4632, '7407 - 2775 = 4632, congelado');
});

test('exposicao parcial nao e tratada como trava total', () => {
  const {leitura} = leituraDaMesa([
    {symbol:'MNQ',direction:'LONG',quantity:6,pnl:100,currency:'USD',hasStop:true,hasPlan:true},
    {symbol:'MNQ',direction:'SHORT',quantity:2,pnl:-30,currency:'USD',hasStop:true,hasPlan:true},
  ]);
  const trava = leitura.travas[0];
  assert.strictEqual(trava.travada, false);
  assert.strictEqual(trava.exposicaoLiquida, 4, 'sobram 4 contratos comprados expostos');
});

test('posicao sem stop e contada e vira aviso de perigo', () => {
  const {leitura} = leituraDaMesa(posicoesDe0209);
  assert.strictEqual(leitura.semStop, 3);
  const perigo = leitura.avisos.find(a => a.level === 'danger');
  assert.ok(perigo, 'tres posicoes sem stop precisam gerar aviso de perigo');
  assert.match(perigo.title, /3 posicao/);
});

test('mesa protegida e sem posicoes opostas nao inventa aviso', () => {
  const {leitura} = leituraDaMesa([
    {symbol:'BTCUSDT',direction:'LONG',quantity:1,pnl:5,currency:'USDT',hasStop:true,hasPlan:true},
  ]);
  assert.strictEqual(leitura.semStop, 0);
  assert.strictEqual(leitura.travas.length, 0);
  assert.strictEqual(leitura.avisos.length, 0);
});

test('resultado e somado por moeda, sem misturar USD de futuros com USDT', () => {
  const {leitura} = leituraDaMesa(posicoesDe0209);
  assert.strictEqual(leitura.resultadoPorMoeda.USDT, 0.84);
  assert.strictEqual(leitura.resultadoPorMoeda.USD, 4632);
});

test('mesa vazia nao quebra', () => {
  const {leitura} = leituraDaMesa([]);
  assert.strictEqual(leitura.semStop, 0);
  assert.deepStrictEqual(leitura.travas, []);
});

// ---- peneira do scanner ----

// O caso real: ARBUSDT em 02/09/2026 — PULLBACK LONG, +14,06% em 24h, RSI 59,
// ATR 1,43% e volume 0,4x. Era o de MENOR volume da tela e foi o escolhido.
test('ARB de 02/09 e desqualificado pelo volume', () => {
  const r = peneira({setup:'PULLBACK LONG', rsi15:59, volumeRatio15:0.4, atr15Pct:1.43, change24h:14.06});
  assert.strictEqual(r.elegivel, false);
  assert.match(r.desqualificadores.join(' '), /Volume de 15m em 0.40x/);
});

test('FF de 02/09, com volume 2,62x, passa', () => {
  const r = peneira({setup:'FORÇA LONG', rsi15:71, volumeRatio15:2.62, atr15Pct:1.47, change24h:11.06});
  assert.strictEqual(r.elegivel, true);
  assert.deepStrictEqual(r.desqualificadores, []);
});

test('LA de 02/09 cai por ESTICADA e por RSI 82', () => {
  const r = peneira({setup:'ESTICADA', rsi15:82, volumeRatio15:3.9, atr15Pct:2.08, change24h:4.82});
  assert.strictEqual(r.elegivel, false);
  assert.strictEqual(r.desqualificadores.length, 2, 'ESTICADA e RSI sobrecomprado');
});

test('T de 02/09 cai por ATR alto, volume fraco e alta de 38%', () => {
  const r = peneira({setup:'PULLBACK LONG', rsi15:41, volumeRatio15:0.85, atr15Pct:3.8, change24h:38.44});
  assert.strictEqual(r.elegivel, false);
  assert.strictEqual(r.desqualificadores.length, 3);
});

test('cada desqualificador diz o motivo, nunca so "bloqueado"', () => {
  const r = peneira({setup:'PULLBACK LONG', rsi15:80, volumeRatio15:0.2, atr15Pct:5, change24h:30});
  for (const motivo of r.desqualificadores) {
    assert.ok(motivo.length > 15, `motivo vago: ${motivo}`);
    assert.match(motivo, /[.:]$/, `motivo sem pontuacao final: ${motivo}`);
  }
});

test('OBSERVAR nao vira candidato so por ter volume bom', () => {
  const r = peneira({setup:'OBSERVAR', rsi15:50, volumeRatio15:3, atr15Pct:1, change24h:2});
  assert.strictEqual(r.elegivel, false);
});
