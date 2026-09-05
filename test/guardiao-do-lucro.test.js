const test = require('node:test');
const assert = require('node:assert/strict');
const {
  multiploDeR, stopIdeal, devolucao, ordemDoGuardiao, ordensDaMesa,
  resumoDoGuardiao, precoEmR, DEVOLUCAO_QUE_PREOCUPA,
} = require('../guardiao-do-lucro.js');

// Um trade de referência: comprou a 100, stop em 90. Risco = 10 por unidade.
// Então 110 = 1R, 120 = 2R, 130 = 3R.
const base = { entrada: 100, stopInicial: 90, direcao: 'LONG', quantidade: 1 };

// ------------------------------------------------------------
// R — a unidade que faz tudo funcionar
// ------------------------------------------------------------

test('R mede o lucro em múltiplos do que foi arriscado', () => {
  assert.equal(multiploDeR({ ...base, preco: 110 }).r, 1);
  assert.equal(multiploDeR({ ...base, preco: 120 }).r, 2);
  assert.equal(multiploDeR({ ...base, preco: 95 }).r, -0.5);
  assert.equal(multiploDeR({ ...base, preco: 100 }).r, 0);
});

test('R funciona igual no vendido', () => {
  const v = { entrada: 100, stopInicial: 110, direcao: 'SHORT' };
  assert.equal(multiploDeR({ ...v, preco: 90 }).r, 1);
  assert.equal(multiploDeR({ ...v, preco: 105 }).r, -0.5);
});

test('sem stop não existe R — e o guardião recusa em vez de inventar', () => {
  assert.equal(multiploDeR({ entrada: 100, stopInicial: 0, preco: 110 }), null);
  // Stop do lado errado da entrada: risco negativo, conta não fecha.
  assert.equal(multiploDeR({ entrada: 100, stopInicial: 110, preco: 120, direcao: 'LONG' }), null);
});

// ------------------------------------------------------------
// A escada — cada degrau na hora certa
// ------------------------------------------------------------

test('abaixo de 1R o stop NÃO se mexe', () => {
  // Subir stop cedo é a forma mais comum de ser tirado de um trade bom.
  const s = stopIdeal({ ...base, preco: 105, pico: 108 });
  assert.equal(s.degrau, 'INICIAL');
  assert.equal(s.preco, 90);
});

test('em 1R o stop vai para a ENTRADA — o degrau mais importante', () => {
  const s = stopIdeal({ ...base, preco: 110, pico: 110 });
  assert.equal(s.degrau, 'ZERO_A_ZERO');
  assert.equal(s.preco, 100, 'a partir daqui o trade não pode mais dar prejuízo');
});

test('em 2R o stop garante 1R', () => {
  const s = stopIdeal({ ...base, preco: 120, pico: 120 });
  assert.equal(s.degrau, 'GARANTE_1R');
  assert.equal(s.preco, 110);
});

test('em 3R passa a trilhar metade do caminho andado', () => {
  const s = stopIdeal({ ...base, preco: 140, pico: 140 });
  assert.equal(s.degrau, 'TRILHA');
  assert.equal(s.rTravado, 2, 'metade de 4R');
  assert.equal(s.preco, 120);
});

test('a escada sobe pelo PICO — proteção conquistada não se perde', () => {
  // Valeu 4R e recuou para 2R: o stop continua onde o pico mandou.
  const s = stopIdeal({ ...base, preco: 120, pico: 140 });
  assert.equal(s.degrau, 'TRILHA');
  assert.equal(s.preco, 120, 'o stop não desce porque o preço recuou');
  assert.equal(s.rAtual, 2);
  assert.equal(s.rNoPico, 4);
});

test('a escada nunca devolve o stop para trás', () => {
  let anterior = 0;
  for (const preco of [110, 115, 120, 130, 140, 160, 200]) {
    const s = stopIdeal({ ...base, preco, pico: preco });
    assert.ok(s.preco >= anterior, `stop desceu de ${anterior} para ${s.preco} em ${preco}`);
    anterior = s.preco;
  }
});

test('no vendido a escada desce, e é o mesmo raciocínio', () => {
  const v = { entrada: 100, stopInicial: 110, direcao: 'SHORT' };
  assert.equal(stopIdeal({ ...v, preco: 90, pico: 90 }).preco, 100, '1R → entrada');
  assert.equal(stopIdeal({ ...v, preco: 80, pico: 80 }).preco, 90, '2R → garante 1R');
});

test('precoEmR converte múltiplo em preço nos dois sentidos', () => {
  assert.equal(precoEmR({ entrada: 100, riscoPorUnidade: 10, r: 2, direcao: 'LONG' }), 120);
  assert.equal(precoEmR({ entrada: 100, riscoPorUnidade: 10, r: 2, direcao: 'SHORT' }), 80);
});

// ------------------------------------------------------------
// Devolução
// ------------------------------------------------------------

test('devolução mede o quanto voltou desde o melhor preço', () => {
  assert.equal(Math.round(devolucao({ preco: 90, pico: 100 })), 11);
  assert.equal(devolucao({ preco: 100, pico: 100 }), 0);
  assert.equal(devolucao({ preco: 110, pico: 100 }), 0, 'acima do pico não é devolução');
});

test('devolução no vendido conta ao contrário', () => {
  assert.equal(Math.round(devolucao({ preco: 110, pico: 100, direcao: 'SHORT' })), 10);
});

// ------------------------------------------------------------
// A ordem — o que a tela mostra
// ------------------------------------------------------------

test('posição sem stop recebe a ÚNICA ordem que importa', () => {
  const o = ordemDoGuardiao({ simbolo: 'BTCUSDT', entrada: 100, stopInicial: 0, preco: 120 });
  assert.equal(o.acao, 'DEFINIR_STOP');
  assert.equal(o.urgencia, 'ALTA');
  assert.ok(/sem stop/i.test(o.texto));
});

test('toda ordem tem PREÇO EXATO — nunca "cuidado com a posição"', () => {
  const casos = [
    { ...base, simbolo: 'X', preco: 105, pico: 108 },
    { ...base, simbolo: 'X', preco: 110, pico: 110 },
    { ...base, simbolo: 'X', preco: 130, pico: 145 },
    { ...base, simbolo: 'X', preco: 95, pico: 101 },
  ];
  for (const c of casos) {
    const o = ordemDoGuardiao(c);
    assert.ok(typeof o.preco === 'number', `sem preço: ${JSON.stringify(c)}`);
    assert.ok(o.titulo.length > 5 && o.texto.length > 30, 'ordem sem motivo é ordem desobedecida');
  }
});

test('em 1R manda SUBIR o stop, com o preço no título', () => {
  const o = ordemDoGuardiao({ ...base, simbolo: 'BTCUSDT', preco: 110, pico: 110, stopAtual: 90 });
  assert.equal(o.acao, 'SUBIR_STOP');
  assert.ok(o.titulo.includes('100'));
  assert.ok(/não pode mais virar prejuízo/i.test(o.texto));
});

test('stop já no lugar certo não pede para mexer de novo', () => {
  const o = ordemDoGuardiao({ ...base, simbolo: 'X', preco: 110, pico: 110, stopAtual: 100 });
  assert.equal(o.acao, 'SEGURAR');
});

test('diferença de arredondamento não vira ordem', () => {
  // 99,98 contra 100 é ruído, não desproteção.
  const o = ordemDoGuardiao({ ...base, simbolo: 'X', preco: 110, pico: 110, stopAtual: 99.98 });
  assert.equal(o.acao, 'SEGURAR');
});

test('no vermelho, a ordem é NÃO MEXER', () => {
  const o = ordemDoGuardiao({ ...base, simbolo: 'X', preco: 95, pico: 101, stopAtual: 90 });
  assert.equal(o.acao, 'SEGURAR');
  assert.ok(/não mexa/i.test(o.texto));
  assert.ok(/prejuízo pequeno vira grande/i.test(o.texto));
});

test('devolução grande com stop protegido AVISA sem dar susto falso', () => {
  const o = ordemDoGuardiao({ ...base, simbolo: 'X', preco: 122, pico: 200, stopAtual: 150 });
  assert.equal(o.acao, 'ATENCAO');
  assert.ok(/não corre risco/i.test(o.texto), 'precisa dizer que o lucro está protegido');
});

test('o limite de devolução é um terço do movimento', () => {
  assert.equal(DEVOLUCAO_QUE_PREOCUPA, 33);
});

test('o lucro sai na moeda certa e com o multiplicador do contrato', () => {
  const o = ordemDoGuardiao({
    simbolo: 'MNQ', entrada: 29414, stopInicial: 29300, preco: 29800,
    pico: 29800, direcao: 'LONG', quantidade: 6, multiplicador: 2, moeda: 'USD', stopAtual: 29300,
  });
  assert.equal(o.lucroAtual, (29800 - 29414) * 6 * 2);
  assert.equal(o.moeda, 'USD');
});

test('números que não fecham devolvem REVISAR, não exceção', () => {
  const o = ordemDoGuardiao({ simbolo: 'X', entrada: 100, stopInicial: 110, preco: 120, direcao: 'LONG' });
  assert.equal(o.acao, 'REVISAR');
});

// ------------------------------------------------------------
// A mesa inteira
// ------------------------------------------------------------

test('o que exige ação vem PRIMEIRO — com dez posições, é o que salva', () => {
  const ordens = ordensDaMesa([
    { ...base, simbolo: 'CALMA', preco: 105, pico: 106, stopAtual: 90 },
    { simbolo: 'SEM_STOP', entrada: 100, stopInicial: 0, preco: 120 },
    { ...base, simbolo: 'SUBIR', preco: 120, pico: 120, stopAtual: 90 },
  ]);
  assert.equal(ordens[0].simbolo, 'SEM_STOP');
  assert.equal(ordens[1].simbolo, 'SUBIR');
  assert.equal(ordens[2].simbolo, 'CALMA');
});

test('o resumo diz quantas precisam de ação — o número que importa com pressa', () => {
  const r = resumoDoGuardiao(ordensDaMesa([
    { ...base, simbolo: 'A', preco: 120, pico: 120, stopAtual: 90 },
    { simbolo: 'B', entrada: 100, stopInicial: 0, preco: 120 },
    { ...base, simbolo: 'C', preco: 110, pico: 110, stopAtual: 100 },
  ]));
  assert.equal(r.total, 3);
  assert.equal(r.precisamDeAcao, 2);
  assert.equal(r.semStop, 1);
  assert.equal(r.protegidas, 1);
});

test('mesa vazia não quebra', () => {
  assert.deepEqual(ordensDaMesa([]), []);
  assert.equal(resumoDoGuardiao([]).total, 0);
});
