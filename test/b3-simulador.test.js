'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B3 = require('../b3-simulador');

// 07/10/2026 é uma quarta-feira. Recife = UTC-3.
const recife = (hh, mm = 0, dia = 7) => Date.UTC(2026, 9, dia, hh + 3, mm);

test('contratos com a regra de verdade: ponto, tick e margem da B3', () => {
  assert.equal(B3.CONTRATOS.WIN.valorPonto, 0.2);
  assert.equal(B3.CONTRATOS.WIN.tick, 5);
  assert.equal(B3.CONTRATOS.WIN.margem, 155);
  assert.equal(B3.CONTRATOS.WDO.valorPonto, 10);
  assert.equal(B3.CONTRATOS.WDO.tick, 0.5);
  assert.equal(B3.CONTRATOS.WDO.margem, 140);
});

test('preço vai para o tick do contrato', () => {
  assert.equal(B3.arredondaTick(204302.33, 5), 204300);
  assert.equal(B3.arredondaTick(5021.6, 0.5), 5021.5);
  assert.equal(B3.precoDeReferencia('WDO', 5021.75), 5022);
});

test('ordem a mercado executa um tick contra quem opera', () => {
  assert.equal(B3.precoDeExecucao('WIN', 'COMPRA', 204300), 204305);
  assert.equal(B3.precoDeExecucao('WIN', 'VENDA', 204300), 204295);
  assert.equal(B3.precoDeExecucao('WDO', 'COMPRA', 5021.5), 5022);
});

test('stop e alvo saem da distância em pontos, no lado certo', () => {
  assert.deepEqual(B3.precosDaOrdem('WIN', 'COMPRA', 204305, 200, 400), { entrada: 204305, stop: 204105, alvo: 204705 });
  assert.deepEqual(B3.precosDaOrdem('WIN', 'VENDA', 204305, 200, 400), { entrada: 204305, stop: 204505, alvo: 203905 });
  assert.equal(B3.precosDaOrdem('WDO', 'COMPRA', 5022, 5, null).alvo, null);
});

test('resultado em reais: pontos × valor do ponto × contratos − custos', () => {
  const win = B3.resultadoDaOperacao({ contrato: 'WIN', lado: 'COMPRA', quantidade: 2, entrada: 204305, saida: 204705, custoPorLado: 0.25 });
  assert.deepEqual(win, { pontos: 400, bruto: 160, custos: 1, liquido: 159 });
  const wdo = B3.resultadoDaOperacao({ contrato: 'WDO', lado: 'VENDA', quantidade: 1, entrada: 5022, saida: 5012 });
  assert.equal(wdo.bruto, 100);
  const perda = B3.resultadoDaOperacao({ contrato: 'WIN', lado: 'VENDA', quantidade: 1, entrada: 204000, saida: 204200 });
  assert.equal(perda.liquido, -40);
});

test('risco em reais inclui o tick de deslize do stop', () => {
  assert.equal(B3.riscoEmReais('WIN', 1, 200), 41);
  assert.equal(B3.riscoEmReais('WDO', 2, 5), 110);
});

test('pregão simulado: WIN 10h–16h50, WDO 9h–18h15, fim de semana fechado', () => {
  assert.equal(B3.pregao('WIN', recife(14)).aberto, true);
  assert.equal(B3.pregao('WIN', recife(9, 30)).aberto, false);
  assert.match(B3.pregao('WIN', recife(9, 30)).motivo, /abre às 10h/);
  assert.equal(B3.pregao('WDO', recife(9, 30)).aberto, true);
  assert.equal(B3.pregao('WIN', recife(16, 55)).aberto, false);
  assert.equal(B3.pregao('WDO', recife(18, 20)).aberto, false);
  assert.equal(B3.pregao('WIN', recife(14, 0, 10)).aberto, false, 'sábado');
});

const CTX = { config: {}, saldo: 1000, margemEmUso: 0, resultadoHoje: 0, temAberta: false, pregao: { aberto: true }, idadePrecoMin: 1 };

test('ordem válida sai com stop arredondado para o tick', () => {
  const r = B3.validarOrdem({ contrato: 'win', lado: 'compra', quantidade: 2, stopPontos: 203, alvoPontos: '' }, CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ordem, { contrato: 'WIN', lado: 'COMPRA', quantidade: 2, stopPontos: 205, alvoPontos: null });
});

test('sem stop não existe ordem', () => {
  const r = B3.validarOrdem({ contrato: 'WIN', lado: 'COMPRA', quantidade: 1 }, CTX);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /Stop obrigatório/);
});

test('travas: contratos, pregão, preço velho, posição aberta, perda do dia e margem', () => {
  const base = { contrato: 'WIN', lado: 'VENDA', quantidade: 1, stopPontos: 150 };
  assert.match(B3.validarOrdem({ ...base, quantidade: 6 }, CTX).motivo, /Máximo de 5/);
  assert.match(B3.validarOrdem(base, { ...CTX, pregao: { aberto: false, motivo: 'fechado agora' } }).motivo, /fechado agora/);
  assert.match(B3.validarOrdem(base, { ...CTX, idadePrecoMin: 45 }).motivo, /parado há 45 min/);
  assert.match(B3.validarOrdem(base, { ...CTX, temAberta: true }).motivo, /Zere antes/);
  assert.match(B3.validarOrdem(base, { ...CTX, resultadoHoje: -100 }).motivo, /Trava do dia/);
  assert.match(B3.validarOrdem(base, { ...CTX, saldo: 100 }).motivo, /insuficiente/);
  assert.equal(B3.validarOrdem(base, { ...CTX, resultadoHoje: -99.99 }).ok, true);
});

const candle = (hh, mm, open, high, low, close) => ({ time: recife(hh, mm), open, high, low, close });
const COMPRADO = { contrato: 'WIN', lado: 'COMPRA', stop: 204105, alvo: 204705, abertaEmMs: recife(14, 0) + 30e3 };

test('o candle da entrada não conta, e o alvo fecha a posição', () => {
  const candles = [
    candle(14, 0, 204300, 204320, 204000, 204310), // tem preço de antes da ordem: ignorado
    candle(14, 1, 204400, 204800, 204350, 204750),
  ];
  const s = B3.avaliarSaida(COMPRADO, candles, recife(14, 5));
  assert.equal(s.tipo, 'ALVO');
  assert.equal(s.preco, 204705);
});

test('stop e alvo no mesmo candle: vale o stop', () => {
  const s = B3.avaliarSaida(COMPRADO, [candle(14, 1, 204300, 204800, 204000, 204500)], recife(14, 5));
  assert.equal(s.tipo, 'STOP');
  assert.equal(s.preco, 204105);
});

test('gap além do stop executa na abertura, que é pior', () => {
  const vendido = { contrato: 'WIN', lado: 'VENDA', stop: 204505, alvo: null, abertaEmMs: recife(14, 0) + 30e3 };
  const s = B3.avaliarSaida(vendido, [candle(14, 1, 204600, 204650, 204550, 204600)], recife(14, 5));
  assert.equal(s.tipo, 'STOP');
  assert.equal(s.preco, 204600);
});

test('sem stop nem alvo até 16h50, a posição é zerada no último preço', () => {
  const candles = [candle(14, 1, 204300, 204400, 204200, 204350), candle(16, 49, 204380, 204400, 204360, 204390)];
  assert.equal(B3.avaliarSaida(COMPRADO, candles, recife(16, 0)).sair, false);
  const s = B3.avaliarSaida(COMPRADO, candles, recife(16, 51));
  assert.equal(s.tipo, 'ZERAGEM');
  assert.equal(s.preco, 204390);
});

test('resumo do dia diz quanto ainda pode perder antes da trava', () => {
  const r = B3.resumoDoDia([{ resultado: 30 }, { resultado: -50 }, { resultado: -60 }], { limitePerdaDia: 100 });
  assert.equal(r.resultado, -80);
  assert.equal(r.travado, false);
  assert.match(r.motivo, /R\$ 20,00/);
  assert.equal(B3.resumoDoDia([{ resultado: -120 }], { limitePerdaDia: 100 }).travado, true);
});

test('Yahoo: dólar vira pontos do WDO e candle quebrado é descartado', () => {
  const payload = { chart: { result: [{ meta: { regularMarketPrice: 5.0216, chartPreviousClose: 5.0218 }, timestamp: [1, 2], indicators: { quote: [{ open: [5.02, null], high: [5.03, 5.04], low: [5.01, 5.0], close: [5.0216, 5.03] }] } }] } };
  const d = B3.candlesDoYahoo(payload, 1000);
  assert.equal(d.candles.length, 1);
  assert.equal(Math.round(d.preco * 10) / 10, 5021.6);
  assert.equal(Math.round(d.candles[0].close * 10) / 10, 5021.6);
  assert.equal(B3.candlesDoYahoo({}, 1).preco, null);
});

test('resumo técnico leva só números e pede pregão com dados', () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({ time: recife(10, 0) + i * 60e3, open: 204000 + i, high: 204010 + i, low: 203990 + i, close: 204005 + i }));
  const r = B3.resumoTecnico('WIN', candles, 203500, recife(12, 0));
  assert.equal(r.contrato, 'WIN');
  assert.equal(r.maximaDoDia, 204130);
  assert.ok(r.ema20_5m > 0);
  assert.equal(B3.resumoTecnico('WIN', candles.slice(0, 5), null, recife(12, 0)).semDados, true);
});

test('ajustes absurdos voltam para o padrão', () => {
  const c = B3.normalizarConfig({ limitePerdaDia: -5, maxContratos: { WIN: 999, WDO: 3 }, custoPorLado: { WIN: 0.3 } });
  assert.equal(c.limitePerdaDia, 100);
  assert.equal(c.maxContratos.WIN, 5);
  assert.equal(c.maxContratos.WDO, 3);
  assert.equal(c.custoPorLado.WIN, 0.3);
  assert.equal(c.custoPorLado.WDO, 0);
});
