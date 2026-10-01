'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { montarDossie, limitarVeredito, normalizarAnalista, rodarMesa, ANALISTAS } = require('../comite');

const MERCADO = {
  symbol: 'ARBUSDT', price: 1.02, change24h: 3.1, rangePosition: 60, amplitude: 5, alignment: 'ALTA',
  frames: [
    { label: '15 minutos', trend: 'ALTA', rsi: 58, ema20: 1.01, ema50: 0.99, atr: 0.01, volumeRatio: 1.3, change: 0.4 },
    { label: '1 hora', trend: 'ALTA', rsi: 61, ema20: 1, ema50: 0.97, atr: 0.02, volumeRatio: 1.1, change: 0.8 },
    { label: '4 horas', trend: 'ALTA', rsi: 63, ema20: 0.98, ema50: 0.94, atr: 0.04, volumeRatio: 1, change: 1.2 },
  ],
  orderBook: { spreadPct: 0.02, imbalancePct: 12, bidDepth: 50000, askDepth: 39000 },
  risk: { score: 20, label: 'RISCO MODERADO' },
  strategy: { action: 'PULLBACK LONG', direction: 'LONG', reason: 'Períodos em alta' },
  warnings: [],
};
const RADAR = [
  { symbol: 'BTCUSDT', change24h: 1.5, score: 70 },
  { symbol: 'ETHUSDT', change24h: -0.5, score: 50 },
  { symbol: 'ARBUSDT', change24h: 3.1, score: 80 },
];

test('dossiê leva só números do pretrade e o resumo do mercado', () => {
  const d = montarDossie(MERCADO, RADAR);
  assert.equal(d.par, 'ARBUSDT');
  assert.equal(d.tempos.length, 3);
  assert.equal(d.tempos[0].tempo, '15 minutos');
  assert.equal(d.mercadoGeral.subindo24h, 2);
  assert.deepEqual(d.mercadoGeral.lideres.map((l) => l.symbol), ['BTCUSDT', 'ETHUSDT']);
});

test('analista com resposta torta vira NEUTRA com nota limitada', () => {
  const r = normalizarAnalista({ leitura: 'FOGUETE', nota: 400, pontos: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(r.leitura, 'NEUTRA');
  assert.equal(r.nota, 100);
  assert.equal(r.pontos.length, 4);
  assert.deepEqual(r.riscos, []);
});

test('travas do código vencem a IA: risco alto vira EVITAR', () => {
  const d = limitarVeredito({ veredito: 'ENTRAR_COM_PLANO', confianca: 90 }, { ...MERCADO, risk: { score: 70 } });
  assert.equal(d.veredito, 'EVITAR');
  assert.equal(d.vereditoDaIa, 'ENTRAR_COM_PLANO');
  assert.ok(d.travas[0].includes('70'));
});

test('setup de venda, tempos em baixa ou plano bloqueado não deixam ENTRAR', () => {
  assert.equal(limitarVeredito({ veredito: 'ENTRAR_COM_PLANO' }, { ...MERCADO, strategy: { direction: 'SHORT' } }).veredito, 'ESPERAR');
  assert.equal(limitarVeredito({ veredito: 'ENTRAR_COM_PLANO' }, { ...MERCADO, alignment: 'BAIXA' }).veredito, 'ESPERAR');
  assert.equal(limitarVeredito({ veredito: 'ENTRAR_COM_PLANO' }, MERCADO, { allowed: false }).veredito, 'ESPERAR');
  const livre = limitarVeredito({ veredito: 'ENTRAR_COM_PLANO', confianca: 70 }, MERCADO, { allowed: true });
  assert.equal(livre.veredito, 'ENTRAR_COM_PLANO');
  assert.deepEqual(livre.travas, []);
});

test('veredito desconhecido da IA cai em ESPERAR', () => {
  assert.equal(limitarVeredito({ veredito: 'ALL_IN' }, MERCADO).veredito, 'ESPERAR');
});

test('a mesa roda 3 analistas, touro, urso e gestor, sem rede e sem ordem', async () => {
  const pedidos = [];
  const chamar = async (p) => {
    pedidos.push(p);
    if (p.system.includes('Gestor de Risco')) return { veredito: 'ENTRAR_COM_PLANO', confianca: 66, resumo: 'ok', quemGanhouODebate: 'TOURO', condicaoDeEntrada: 'pullback na EMA20', oQueInvalida: 'perder 0,98' };
    if (p.system.includes('TOURO') || p.system.includes('URSO')) return { tese: 't', argumentos: ['x'], oQueMeFariaMudar: 'y' };
    return { leitura: 'ALTA', nota: 70, pontos: ['p'], riscos: ['r'] };
  };
  const r = await rodarMesa({ mercado: MERCADO, radar: RADAR, plano: { allowed: true }, chamar });
  assert.equal(pedidos.length, ANALISTAS.length + 3);
  assert.equal(r.analistas.length, 3);
  assert.equal(r.debate.touro.tese, 't');
  assert.equal(r.decisao.veredito, 'ENTRAR_COM_PLANO');
  assert.equal(r.execution, 'MANUAL_ONLY');
  for (const p of pedidos) assert.ok(p.system.includes('somente Spot comprado'));
});

test('sem par ou sem modelo a mesa recusa com motivo', async () => {
  await assert.rejects(() => rodarMesa({ mercado: {}, chamar: async () => ({}) }), /Busque o par/);
  await assert.rejects(() => rodarMesa({ mercado: MERCADO }), /sem modelo/);
});

test('a mesa não toca em ordem: o arquivo não chama Binance nem rota de execução', () => {
  const fonte = readFileSync(path.join(__dirname, '..', 'comite.js'), 'utf8');
  for (const proibido of ['/api/v3/order', 'otoco', 'signedBinance', 'fetch(']) assert.ok(!fonte.includes(proibido), proibido);
});
