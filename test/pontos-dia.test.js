'use strict';
// O Jogo dos Pontos: quanto o índice andou no dia, por hora, contra a média,
// e a régua do gráfico. 1 ponto do WIN = R$ 0,20 por contrato.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pontos-dia');

const H = 3600000;
// 10h de Brasília = 13h UTC
const dia = (n) => Date.UTC(2026, 10, 10 + n, 13, 0, 0);
const k = (time, open, high, low, close) => ({ time, open, high, low, close });

function pregao(n, abertura, passos) {
  // um candle por hora, andando `passos` pontos por hora
  let p = abertura;
  return passos.map((d, i) => { const c = k(dia(n) + i * H, p, Math.max(p, p + d) + 10, Math.min(p, p + d) - 10, p + d); p += d; return c; });
}

test('placar do dia: variação, máxima, mínima, amplitude e reais', () => {
  const candles = [...pregao(0, 170000, [100, -50]), ...pregao(1, 171000, [200, 300, -100])];
  const j = P.jogoDosPontos(candles);
  assert.equal(j.hoje.abertura, 171000);
  assert.equal(j.hoje.atual, 171400);
  assert.equal(j.hoje.variacao, 400);
  assert.equal(j.hoje.reais, 80); // 400 pts × R$ 0,20
  assert.equal(j.hoje.maxima, 171510);
  assert.equal(j.hoje.minima, 170990);
  assert.equal(j.hoje.amplitude, 520);
  // gap contra o fechamento do pregão anterior (170050)
  assert.equal(j.hoje.gap, 950);
});

test('pontos por hora, em horário de Brasília', () => {
  const j = P.jogoDosPontos(pregao(1, 171000, [200, 300, -100]));
  assert.deepEqual(j.horas.map((h) => h.rotulo), ['10h', '11h', '12h']);
  assert.deepEqual(j.horas.map((h) => h.variacao), [200, 300, -100]);
  assert.equal(j.horas[2].reais, -20);
});

test('termômetro: quanto da faixa média dos dias anteriores já foi usado', () => {
  const candles = [...pregao(0, 170000, [400]), ...pregao(1, 170000, [400]), ...pregao(2, 170000, [200])];
  const j = P.jogoDosPontos(candles);
  assert.equal(j.mediaAmplitude, 420);
  assert.equal(j.hoje.amplitude, 220);
  assert.equal(j.usadoPct, 52);
  assert.match(j.leitura, /ainda tem espaço/);
});

test('níveis marcados no gráfico: abertura, máxima, mínima, anterior e faixas ±500/±1000', () => {
  const j = P.jogoDosPontos(pregao(1, 171000, [100]), 170000);
  const nomes = j.niveis.map((n) => n.nome);
  for (const n of ['Abertura', 'Máxima', 'Mínima', 'Fech. anterior', '+500', '−500', '+1000', '−1000']) assert.ok(nomes.includes(n), n);
  assert.equal(j.niveis.find((n) => n.nome === '+1000').preco, 172000);
});

test('régua: distância em pontos, ticks e reais por contrato', () => {
  assert.deepEqual(P.regua(170000, 170250, 2), { pontos: 250, reais: 100, ticks: 50 });
  assert.equal(P.regua(170250, 170000).reais, -50);
});

test('rota /api/forca/pontos traz as regras do contrato do simulador B3 (fonte única)', async () => {
  const B3 = require('../b3-simulador');
  const { criarRotasForca } = require('../forca-rotas');
  const respostas = [];
  const rotas = criarRotasForca({
    B3,
    cotacaoB3: async () => ({ candles: pregao(1, 171000, [200, -100]), preco: 171100, fechamentoAnterior: 1 }),
    ordemB3: async () => ({}), chamarClaudeJson: async () => ({}),
    json: (res, status, corpo) => respostas.push({ status, corpo }), body: async () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await rotas({ method: 'GET' }, {}, '/api/forca/pontos');
  const { status, corpo } = respostas[0];
  assert.equal(status, 200);
  assert.equal(corpo.contrato.valorPonto, B3.CONTRATOS.WIN.valorPonto);
  assert.equal(corpo.contrato.margem, B3.CONTRATOS.WIN.margem);
  assert.equal(corpo.contrato.valorTick, Math.round(B3.CONTRATOS.WIN.valorPonto * B3.CONTRATOS.WIN.tick * 100) / 100);
  assert.equal(corpo.hoje.variacao, 100);
  // o fechamentoAnterior "1" do Yahoo (range 5d) é ignorado de propósito
  assert.equal(corpo.hoje.desdeFechamento, null);
});

test('sem candles, diz o motivo em vez de quebrar', () => {
  assert.equal(P.jogoDosPontos([]).semDados, true);
});
