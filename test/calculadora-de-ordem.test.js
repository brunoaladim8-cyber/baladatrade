const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TAXA, MANUTENCAO_PCT, tamanhoDaPosicao, precoDeLiquidacao, custoDasTaxas,
  empateEmPct, precoDeEmpate, resultadoEm, simularOrdem, margemParaRisco,
} = require('../calculadora-de-ordem.js');

// O caso do Bruno: 100 USDT de margem, 10x, comprando BTC a 80.000.
const ordem = { margem: 100, alavancagem: 10, precoEntrada: 80000, direcao: 'LONG' };

// ------------------------------------------------------------
// Margem x posição — o erro mais caro da alavancagem
// ------------------------------------------------------------

test('100 USDT em 10x compram 1.000 USDT de posição', () => {
  const p = tamanhoDaPosicao(ordem);
  assert.equal(p.notional, 1000, 'é a posição que se move, não a margem');
  assert.equal(p.quantidade, 0.0125);
});

test('dados incompletos devolvem null em vez de número inventado', () => {
  assert.equal(tamanhoDaPosicao({ margem: 0, alavancagem: 10, precoEntrada: 80000 }), null);
  assert.equal(tamanhoDaPosicao({ margem: 100, alavancagem: 0, precoEntrada: 80000 }), null);
});

// ------------------------------------------------------------
// Liquidação — o número que a Binance esconde numa aba
// ------------------------------------------------------------

test('com 10x a liquidação fica a menos de 10% do preço', () => {
  const liq = precoDeLiquidacao({ precoEntrada: 80000, alavancagem: 10 });
  const dist = (1 - liq / 80000) * 100;
  assert.ok(dist > 9 && dist < 10, `distância ${dist.toFixed(2)}% fora do esperado`);
  // A manutenção puxa a liquidação para MAIS PERTO que 1/alavancagem.
  assert.ok(liq > 80000 * 0.9, 'a conta simples de 10% erra para o lado perigoso');
});

test('quanto maior a alavancagem, mais perto a liquidação', () => {
  const d = (a) => Math.abs(1 - precoDeLiquidacao({ precoEntrada: 80000, alavancagem: a }) / 80000) * 100;
  assert.ok(d(5) > d(10) && d(10) > d(20));
  assert.ok(d(20) < 5, 'em 20x um repique de 5% liquida');
});

test('no vendido a liquidação fica ACIMA da entrada', () => {
  const liq = precoDeLiquidacao({ precoEntrada: 80000, alavancagem: 10, direcao: 'SHORT' });
  assert.ok(liq > 80000);
});

// ------------------------------------------------------------
// Taxas — o "sempre perco um pouco"
// ------------------------------------------------------------

test('a taxa incide sobre a POSIÇÃO, não sobre a margem', () => {
  // 0,05% de 1.000 USDT, entrando e saindo = 1 USDT. Sobre 100 de margem, é 1%.
  assert.equal(custoDasTaxas({ notional: 1000 }), 1);
  assert.equal(TAXA.TAKER, 0.05);
});

test('em 10x, entrar e sair já custa 1% da margem antes de o preço andar', () => {
  const r = simularOrdem(ordem);
  assert.equal(r.taxas, 1);
  assert.equal((r.taxas / r.margem) * 100, 1);
});

test('o preço de empate fica ACIMA da entrada — abaixo dele, verde ainda é prejuízo', () => {
  const e = precoDeEmpate({ precoEntrada: 80000 });
  assert.ok(e > 80000);
  assert.equal(empateEmPct({}), 0.1, 'duas pontas de 0,05%');
});

test('o resultado devolvido é LÍQUIDO, com as taxas já descontadas', () => {
  const r = resultadoEm({ precoEntrada: 80000, precoSaida: 82000, quantidade: 0.0125, notional: 1000 });
  assert.equal(r.bruto, 25);
  assert.equal(r.taxas, 1);
  assert.equal(r.liquido, 24, 'bruto é ilusão; o que entra na conta é o líquido');
});

// ------------------------------------------------------------
// A simulação inteira
// ------------------------------------------------------------

test('mostra o que compra, o que ganha e o que perde', () => {
  const r = simularOrdem({ ...ordem, stop: 78400, alvo: 84000 });
  assert.equal(r.valorDaCompra, 1000);
  assert.equal(r.lucroNoAlvo, 49, '(84000−80000)×0,0125 − 1 de taxa');
  assert.equal(r.perdaNoStop, -21, '(78400−80000)×0,0125 − 1 de taxa');
});

test('AVISA quando a liquidação vem antes do stop — o aviso mais importante', () => {
  // Stop 15% abaixo, com 10x: a corretora fecha antes, em ~9,6%.
  const r = simularOrdem({ ...ordem, stop: 68000, alvo: 90000 });
  const grave = r.avisos.find((a) => a.nivel === 'GRAVE');
  assert.ok(grave, 'este é o aviso que evita perder a margem inteira');
  assert.ok(/liquidado ANTES/i.test(grave.titulo));
  assert.ok(/margem inteira/i.test(grave.texto));
});

test('stop dentro da liquidação NÃO dispara o aviso grave', () => {
  const r = simularOrdem({ ...ordem, stop: 78400, alvo: 84000 });
  assert.ok(!r.avisos.some((a) => a.nivel === 'GRAVE'));
});

test('o custo das taxas é sempre dito, mesmo quando tudo está certo', () => {
  const r = simularOrdem({ ...ordem, stop: 78400, alvo: 84000 });
  const t = r.avisos.find((a) => /taxas custam/i.test(a.titulo));
  assert.ok(t);
  assert.ok(/pagando para operar/i.test(t.texto));
});

test('avisa quando o stop come metade da margem', () => {
  const r = simularOrdem({ ...ordem, stop: 75500, alvo: 90000 });
  assert.ok(r.avisos.some((a) => /O stop custa/i.test(a.titulo)));
});

test('mostra quanto ganha para cada 1 que arrisca', () => {
  const bom = simularOrdem({ ...ordem, stop: 79000, alvo: 83000 });
  const razaoBoa = bom.avisos.find((a) => a.razao !== undefined);
  assert.ok(razaoBoa.razao >= 2);
  assert.ok(/errar mais vezes do que acerta/i.test(razaoBoa.texto));

  const ruim = simularOrdem({ ...ordem, stop: 76000, alvo: 81000 });
  const razaoRuim = ruim.avisos.find((a) => a.razao !== undefined);
  assert.ok(razaoRuim.razao < 1);
  assert.ok(/ninguém acerta/i.test(razaoRuim.texto));
});

test('a distância até a liquidação sai em %, que é como se decide', () => {
  const r = simularOrdem(ordem);
  assert.ok(r.distanciaAteLiquidacaoPct > 9 && r.distanciaAteLiquidacaoPct < 10);
});

test('dados faltando devolvem motivo legível, não exceção', () => {
  const r = simularOrdem({ margem: 0, alavancagem: 10, precoEntrada: 80000 });
  assert.equal(r.ok, false);
  assert.ok(/Preencha/i.test(r.mensagem));
});

// ------------------------------------------------------------
// O caminho inverso — o risco manda no tamanho
// ------------------------------------------------------------

test('a partir do quanto pode perder, devolve o tamanho da ordem', () => {
  const m = margemParaRisco({ perdaMaximaUsdt: 20, precoEntrada: 80000, stop: 78400, alavancagem: 10 });
  // Distância de 1.600 por unidade, mais as taxas embutidas.
  assert.ok(m.quantidade > 0.011 && m.quantidade < 0.0125);
  assert.equal(Math.round(m.margemNecessaria * 100) / 100, Math.round((m.valorDaCompra / 10) * 100) / 100);
});

test('as taxas entram no cálculo do risco — ignorá-las arrisca mais do que se quer', () => {
  const com = margemParaRisco({ perdaMaximaUsdt: 20, precoEntrada: 80000, stop: 78400 });
  const semTaxa = 20 / (80000 - 78400);
  assert.ok(com.quantidade < semTaxa, 'com taxa, a posição tem de ser menor');
});

test('stop do lado errado devolve null', () => {
  assert.equal(margemParaRisco({ perdaMaximaUsdt: 20, precoEntrada: 80000, stop: 82000, direcao: 'LONG' }), null);
});

test('as rotas usam a função de corpo que EXISTE no servidor', () => {
  // Em 05/09 escrevi `readBody(req)` — função que nunca existiu neste projeto.
  // O `node --check` passa (é sintaxe válida) e o erro só apareceria no
  // primeiro clique do Bruno. Sintaxe válida não é código que funciona.
  const fs = require('node:fs');
  const server = fs.readFileSync(new URL('../server.js', `file://${__dirname}/`), 'utf8');
  assert.ok(!/await readBody\(req\)/.test(server), 'readBody não existe neste servidor');
  assert.ok(/const corpo = await body\(req\)/.test(server), 'as rotas novas precisam usar body()');
});

test('as duas rotas da calculadora estão registradas', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(new URL('../server.js', `file://${__dirname}/`), 'utf8');
  assert.ok(server.includes("'/api/ordem/simular'"));
  assert.ok(server.includes("'/api/ordem/pelo-risco'"));
  assert.ok(server.includes("'/api/binance/posicoes'"), 'as posições ao vivo do Futures');
});
