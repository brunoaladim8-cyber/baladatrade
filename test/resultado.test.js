'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lerPosicao, precoMedio, somarTaxas, perdaDoDia } = require('../resultado');
const { criarLimites } = require('../limites');

const ENTRADA_CHEIA = { status: 'FILLED', executedQty: '10', cummulativeQuoteQty: '1000' }; // 10 a 100
const NA_FILA = { status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' };
const PENDENTE = { status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' };
const CANCELADA = { status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' };

test('preço médio sai do quote executado, não do preço pedido', () => {
  assert.equal(precoMedio({ executedQty: '4', cummulativeQuoteQty: '410' }), 102.5);
  assert.equal(precoMedio({ executedQty: '0', cummulativeQuoteQty: '0' }), 0);
});

test('entrada na fila é AGUARDANDO', () => {
  assert.equal(lerPosicao({ entrada: NA_FILA }).estado, 'AGUARDANDO');
});

test('entrada cancelada sem preencher não é prejuízo, é trade que não houve', () => {
  const r = lerPosicao({ entrada: CANCELADA });
  assert.equal(r.estado, 'CANCELADA');
  assert.match(r.texto, /Nenhum dinheiro entrou/);
});

test('comprada com as duas pernas vivas é ABERTA', () => {
  const r = lerPosicao({ entrada: ENTRADA_CHEIA, alvo: PENDENTE, stop: PENDENTE });
  assert.equal(r.estado, 'ABERTA');
  assert.equal(r.precoEntrada, 100);
  assert.equal(r.quantidade, 10);
});

test('fechou no alvo: resultado líquido desconta as duas taxas', () => {
  const r = lerPosicao({
    entrada: ENTRADA_CHEIA,
    alvo: { status: 'FILLED', executedQty: '10', cummulativeQuoteQty: '1100' },
    stop: { status: 'EXPIRED', executedQty: '0', cummulativeQuoteQty: '0' },
    fillsEntrada: [{ commission: '1', commissionAsset: 'USDT' }],
    fillsSaida: [{ commission: '1.1', commissionAsset: 'USDT' }],
  });
  assert.equal(r.estado, 'FECHADA');
  assert.equal(r.saidaTipo, 'ALVO');
  assert.equal(r.resultadoBruto, 100);
  assert.equal(Number(r.resultadoLiquido.toFixed(2)), 97.9);
  assert.equal(r.taxasIncertas, false);
});

test('fechou no stop: prejuízo vem negativo, sem maquiagem', () => {
  const r = lerPosicao({
    entrada: ENTRADA_CHEIA,
    alvo: { status: 'EXPIRED', executedQty: '0', cummulativeQuoteQty: '0' },
    stop: { status: 'FILLED', executedQty: '10', cummulativeQuoteQty: '970' },
  });
  assert.equal(r.saidaTipo, 'STOP');
  assert.equal(r.resultadoLiquido, -30);
  assert.match(r.texto, /stop fez o trabalho/);
});

test('DESPROTEGIDA: comprou e ficou sem stop nem alvo — o estado mais perigoso', () => {
  const r = lerPosicao({
    entrada: ENTRADA_CHEIA,
    alvo: { status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' },
    stop: { status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' },
  });
  assert.equal(r.estado, 'DESPROTEGIDA');
  assert.match(r.texto, /sem nada segurando/);
});

test('preenchimento parcial ainda é posição aberta', () => {
  const r = lerPosicao({
    entrada: { status: 'PARTIALLY_FILLED', executedQty: '3', cummulativeQuoteQty: '300' },
    alvo: PENDENTE, stop: PENDENTE,
  });
  assert.equal(r.estado, 'ABERTA');
  assert.equal(r.quantidade, 3);
});

test('comissão em moeda que não sabemos converter é marcada, nunca chutada', () => {
  const { taxas, incerto, naoConvertidas } = somarTaxas([{ commission: '0.02', commissionAsset: 'BNB' }]);
  assert.equal(taxas, 0);
  assert.equal(incerto, true);
  assert.equal(naoConvertidas[0].moeda, 'BNB');
});

test('a perda do dia só conta o que fechou', () => {
  const r = perdaDoDia([{ resultadoLiquido: -12 }, { resultadoLiquido: 30 }, { resultadoLiquido: -8 }]);
  assert.equal(r.perda, 20);
  assert.equal(r.ganho, 30);
  assert.equal(r.liquido, 10);
  assert.equal(r.trades, 3);
});

// ---- limites ----

test('o peso lido da própria Binance é o que manda', () => {
  const l = criarLimites({ teto: 100, folga: 0.7 });
  l.registrar(200, { 'x-mbx-used-weight-1m': '50' }, 1000);
  assert.equal(l.podeChamar(1000).pode, true);
  l.registrar(200, { 'x-mbx-used-weight-1m': '80' }, 2000);
  const r = l.podeChamar(2000);
  assert.equal(r.pode, false);
  assert.equal(r.tipo, 'PESO');
});

test('429 respeita o Retry-After, com um segundo de margem', () => {
  const l = criarLimites();
  l.registrar(429, { 'retry-after': '30' }, 10000);
  assert.equal(l.podeChamar(10000).pode, false);
  assert.equal(l.podeChamar(40000).pode, false);   // ainda dentro do castigo
  assert.equal(l.podeChamar(41001).pode, true);
});

test('418 é banimento e espera bem mais do que um 429', () => {
  const l = criarLimites();
  l.registrar(418, {}, 0);
  const e = l.estado(0);
  assert.equal(e.pausado, true);
  assert.equal(e.banimentos, 1);
  assert.ok(e.esperaMs > 60000, 'espera de 418 tem de ser maior que a de 429');
});

test('peso velho não segura o robô parado', () => {
  const l = criarLimites({ teto: 100, folga: 0.7 });
  l.registrar(200, { 'x-mbx-used-weight-1m': '95' }, 0);
  assert.equal(l.podeChamar(0).pode, false);
  assert.equal(l.podeChamar(70000).pode, true, 'leitura de mais de um minuto não vale mais');
});

test('aceita tanto Headers do fetch quanto objeto simples', () => {
  const l = criarLimites({ teto: 100 });
  l.registrar(200, new Headers({ 'x-mbx-used-weight-1m': '42' }), 0);
  assert.equal(l.estado(0).pesoUsado, 42);
});
