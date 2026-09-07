'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarConfig, travasDeRisco, escolherCandidato, precosDoTrade, idDoTrade, paramsOTOCO, decidir } = require('../robo');
const { calculateSpotPlan } = require('../spot-engine');

// Filtros parecidos com os de um par USDT de verdade.
const FILTROS = [
  { filterType: 'PRICE_FILTER', tickSize: '0.0001' },
  { filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1', maxQty: '90000' },
  { filterType: 'NOTIONAL', minNotional: '5' },
];

const CANDIDATO = {
  symbol: 'ARBUSDT', price: 1, setup: 'PULLBACK LONG', reason: 'Tendência de 1h em alta',
  elegivel: true, atr15Pct: 1, volumeRatio15: 1.4, change24h: 3,
};

const CONTA_BOA = { saldoUsdt: 500, posicoesAbertas: 0, ordensHoje: 0, paresAbertos: [], perdaHojeUsdt: 0 };

// O capital que entra no dimensionamento é `min(saldo, notionalMaximo)` — o
// mesmo que o ciclo usa no server. O teto não é só um alarme depois da conta:
// ele ENTRA na conta, e é por isso que a ordem nunca nasce maior do que o
// limite. Alarme que dispara depois de calcular só serve para o robô ficar
// parado repetindo que a ordem é grande demais.
function capitalDoRobo(config, saldo = 500) {
  return Math.min(saldo, config.notionalMaximo);
}

function planoDe(candidato = CANDIDATO, config = normalizarConfig({}), saldo = 500) {
  const p = precosDoTrade(candidato, config);
  return calculateSpotPlan({
    symbol: candidato.symbol, capital: capitalDoRobo(config, saldo), riskPct: config.riscoPctPorOrdem,
    entry: p.entrada, stop: p.stop, target: p.alvo, filters: FILTROS,
  });
}

test('a config nasce em simulação e não aceita valor absurdo', () => {
  assert.equal(normalizarConfig({}).modo, 'SIMULACAO');
  assert.equal(normalizarConfig({ modo: 'REAL_MESMO' }).modo, 'SIMULACAO');
  assert.equal(normalizarConfig({ riscoPctPorOrdem: 90 }).riscoPctPorOrdem, 1);
  assert.equal(normalizarConfig({ intervaloSegundos: 1 }).intervaloSegundos, 60);
});

test('o kill switch para tudo, mesmo com a conta perfeita', () => {
  const r = travasDeRisco({ ...CONTA_BOA, killSwitch: true }, normalizarConfig({}));
  assert.equal(r.liberado, false);
  assert.ok(r.travas.some((t) => t.trava === 'KILL_SWITCH'));
});

test('a perda do dia encerra o dia', () => {
  const cfg = normalizarConfig({ perdaMaximaDiaUsdt: 20 });
  assert.equal(travasDeRisco({ ...CONTA_BOA, perdaHojeUsdt: 25 }, cfg).liberado, false);
  assert.equal(travasDeRisco({ ...CONTA_BOA, perdaHojeUsdt: 5 }, cfg).liberado, true);
});

test('o teto de ordens do dia é o freio contra loop', () => {
  const cfg = normalizarConfig({ maxOrdensPorDia: 2 });
  assert.ok(travasDeRisco({ ...CONTA_BOA, ordensHoje: 2 }, cfg).travas.some((t) => t.trava === 'ORDENS_DO_DIA'));
});

test('dado atrasado trava a decisão', () => {
  assert.ok(travasDeRisco({ ...CONTA_BOA, atrasoDadosMs: 300000 }, normalizarConfig({})).travas.some((t) => t.trava === 'DADOS_ATRASADOS'));
});

test('só passa quem a peneira aprovou', () => {
  const reprovado = { ...CANDIDATO, elegivel: false };
  assert.equal(escolherCandidato([reprovado], normalizarConfig({}), []), null);
  assert.equal(escolherCandidato([CANDIDATO], normalizarConfig({}), []).symbol, 'ARBUSDT');
});

test('não dobra posição num par que já está aberto', () => {
  assert.equal(escolherCandidato([CANDIDATO], normalizarConfig({}), ['ARBUSDT']), null);
});

test('setup ESTICADA nunca é escolhido', () => {
  assert.equal(escolherCandidato([{ ...CANDIDATO, setup: 'ESTICADA' }], normalizarConfig({}), []), null);
});

test('desempata pelo volume relativo', () => {
  const fraco = { ...CANDIDATO, symbol: 'AAAUSDT', volumeRatio15: 1.1 };
  const forte = { ...CANDIDATO, symbol: 'BBBUSDT', volumeRatio15: 3 };
  assert.equal(escolherCandidato([fraco, forte], normalizarConfig({}), []).symbol, 'BBBUSDT');
});

test('o stop sai do ATR e o alvo é o múltiplo de R configurado', () => {
  const cfg = normalizarConfig({ stopEmAtr: 1.5, alvoEmR: 2 });
  const p = precosDoTrade({ price: 100, atr15Pct: 2 }, cfg);
  assert.equal(p.stop, 97);            // 100 - 1,5 × 2%
  assert.equal(p.alvo, 106);           // 100 + 2 × 3
  assert.equal(p.risco, 3);
});

test('o id do trade é determinístico dentro do mesmo minuto', () => {
  const t = 1757200000000;
  assert.equal(idDoTrade('ARBUSDT', t), idDoTrade('ARBUSDT', t + 5000));
  assert.notEqual(idDoTrade('ARBUSDT', t), idDoTrade('ARBUSDT', t + 61000));
  assert.ok(idDoTrade('ARBUSDT', t).length <= 36);
});

test('o OTOCO põe o alvo acima, o stop abaixo e o limite do stop mais fundo', () => {
  const o = paramsOTOCO({ simbolo: 'arbusdt', quantidade: 10, entrada: 100, stop: 97, alvo: 106, id: 'x1' });
  assert.equal(o.symbol, 'ARBUSDT');
  assert.equal(o.workingSide, 'BUY');
  assert.equal(o.pendingSide, 'SELL');
  assert.equal(o.pendingAboveType, 'LIMIT_MAKER');
  assert.equal(o.pendingBelowType, 'STOP_LOSS_LIMIT');
  assert.ok(Number(o.pendingAbovePrice) > Number(o.workingPrice));
  assert.ok(Number(o.pendingBelowStopPrice) < Number(o.workingPrice));
  // O limite abaixo do gatilho é o que faz o stop executar num tranco.
  assert.ok(Number(o.pendingBelowPrice) < Number(o.pendingBelowStopPrice));
  // Cada perna tem nome próprio, e é por ele que se pergunta depois de um timeout.
  assert.equal(o.workingClientOrderId, 'x1e');
  assert.equal(o.pendingAboveClientOrderId, 'x1a');
  assert.equal(o.pendingBelowClientOrderId, 'x1s');
});

test('com tudo em ordem, decide COMPRAR e monta o OTOCO completo', () => {
  const d = decidir({ candidatos: [CANDIDATO], estado: CONTA_BOA, config: {}, plano: planoDe() });
  assert.equal(d.acao, 'COMPRAR');
  assert.equal(d.simbolo, 'ARBUSDT');
  assert.ok(d.quantidade > 0);
  assert.ok(d.ordem.listClientOrderId);
  assert.ok(d.notional <= d.config.notionalMaximo);
});

test('sem candidato, espera — e diz por quê', () => {
  const d = decidir({ candidatos: [], estado: CONTA_BOA, config: {} });
  assert.equal(d.acao, 'ESPERAR');
  assert.equal(d.motivo, 'SEM_SETUP');
  assert.ok(d.texto.length > 20);
});

test('travado é PARADO, e nunca chega a escolher moeda', () => {
  const d = decidir({ candidatos: [CANDIDATO], estado: { ...CONTA_BOA, killSwitch: true }, config: {}, plano: planoDe() });
  assert.equal(d.acao, 'PARADO');
  assert.equal(d.motivo, 'KILL_SWITCH');
  assert.equal(d.simbolo, undefined);
});

test('plano reprovado pelo spot-engine vira ESPERAR com o motivo dele', () => {
  const plano = { quantity: 0, allowed: false, blockers: ['Valor da posição abaixo do mínimo 5 USDT.'] };
  const d = decidir({ candidatos: [CANDIDATO], estado: CONTA_BOA, config: {}, plano });
  assert.equal(d.acao, 'ESPERAR');
  assert.equal(d.motivo, 'PLANO_NAO_FECHA');
  assert.match(d.texto, /mínimo 5 USDT/);
});

test('o teto entra no cálculo: conta grande não gera ordem grande', () => {
  // 10.000 USDT de saldo, teto de 100. A ordem tem de sair pequena — se o teto
  // só fosse conferido no fim, o robô ficaria travado para sempre numa conta
  // que cresceu.
  const cfg = normalizarConfig({ notionalMaximo: 100 });
  const d = decidir({
    candidatos: [CANDIDATO],
    estado: { ...CONTA_BOA, saldoUsdt: 10000 },
    config: cfg,
    plano: planoDe(CANDIDATO, cfg, 10000),
  });
  assert.equal(d.acao, 'COMPRAR');
  assert.ok(d.notional <= 100, `notional ${d.notional} passou do teto`);
});

test('ordem acima do teto ainda é barrada, como última defesa', () => {
  // Plano calculado com teto folgado, decisão avaliada com teto apertado: é o
  // que acontece se alguém baixar o limite entre um passo e outro.
  const plano = planoDe(CANDIDATO, normalizarConfig({ notionalMaximo: 100 }));
  const d = decidir({ candidatos: [CANDIDATO], estado: CONTA_BOA, config: { notionalMaximo: 5 }, plano });
  assert.equal(d.acao, 'ESPERAR');
  assert.equal(d.motivo, 'ACIMA_DO_TETO');
});

test('toda decisão traz um texto que explica — inclusive as de não operar', () => {
  const casos = [
    decidir({ candidatos: [], estado: CONTA_BOA, config: {} }),
    decidir({ candidatos: [CANDIDATO], estado: { ...CONTA_BOA, posicoesAbertas: 9 }, config: {} }),
    decidir({ candidatos: [CANDIDATO], estado: CONTA_BOA, config: {}, plano: planoDe() }),
  ];
  for (const c of casos) {
    assert.ok(c.texto && c.texto.length > 20, `sem explicação: ${c.motivo}`);
    assert.ok(c.motivo);
  }
});

// ============================================================
// OS QUATRO BUGS DE 07/09/2026
//
// Achados atacando o próprio código depois de ele estar pronto e no ar. Cada
// um destes testes existe porque o robô teria feito algo errado com dinheiro
// de verdade — e três deles em silêncio, sem nunca dar erro.
// ============================================================

const { contarPosicoes, minhasOrdens, entradasVencidas } = require('../robo');

test('BUG 1: a carteira do Bruno não conta para o teto de posições', () => {
  // Ele guarda BTC, ETH e SOL há meses. Isso não é risco que o robô tomou.
  // A versão anterior contava as três, batia no teto de 3 no primeiro ciclo e
  // ficava PARADO para sempre dizendo POSICOES_CHEIAS. Nunca teria comprado.
  const carteira = [{ simbolo: 'BTCUSDT' }, { simbolo: 'ETHUSDT' }, { simbolo: 'SOLUSDT' }];
  const c = contarPosicoes({ minhas: [], carteira });
  assert.equal(c.posicoesAbertas, 0, 'a carteira dele não é posição do robô');
  assert.equal(c.naCarteira, 3);

  const d = decidir({ candidatos: [CANDIDATO], estado: { ...CONTA_BOA, ...c }, config: {}, plano: planoDe() });
  assert.equal(d.acao, 'COMPRAR', 'com a carteira cheia ele ainda deve poder operar');
});

test('BUG 1b: mas ele não mexe num par que o Bruno já tem', () => {
  // Comprar o que ele já guarda mistura o estoque: o dia em que ele vender na
  // mão, o stop do robô fica sem saldo para executar.
  const c = contarPosicoes({ minhas: [], carteira: [{ simbolo: 'ARBUSDT' }] });
  assert.ok(c.paresAbertos.includes('ARBUSDT'));
  const d = decidir({ candidatos: [CANDIDATO], estado: { ...CONTA_BOA, ...c }, config: {}, plano: planoDe() });
  assert.equal(d.acao, 'ESPERAR', 'ARBUSDT já está na carteira dele');
});

test('BUG 2: entrada que ainda não preencheu conta e impede comprar de novo', () => {
  // A moeda não chegou na carteira, então ela era invisível — e o ciclo
  // seguinte comprava o MESMO par outra vez, dobrando a posição em silêncio.
  const c = contarPosicoes({ minhas: [{ simbolo: 'ARBUSDT', estado: 'AGUARDANDO' }], carteira: [] });
  assert.equal(c.posicoesAbertas, 1);
  assert.ok(c.paresAbertos.includes('ARBUSDT'));
  const d = decidir({ candidatos: [CANDIDATO], estado: { ...CONTA_BOA, ...c }, config: {}, plano: planoDe() });
  assert.equal(d.acao, 'ESPERAR', 'não pode comprar ARBUSDT de novo com a entrada na fila');
});

test('BUG 2b: posição já fechada não ocupa vaga', () => {
  const c = contarPosicoes({ minhas: [{ simbolo: 'ARBUSDT', estado: 'FECHADA' }, { simbolo: 'OPUSDT', estado: 'CANCELADA' }], carteira: [] });
  assert.equal(c.posicoesAbertas, 0);
  assert.deepEqual(c.paresAbertos, []);
});

test('BUG 2c: desprotegida ocupa vaga — é a que mais precisa de atenção', () => {
  const c = contarPosicoes({ minhas: [{ simbolo: 'ARBUSDT', estado: 'DESPROTEGIDA' }], carteira: [] });
  assert.equal(c.posicoesAbertas, 1);
});

test('BUG 3: o trailing só cancela ordem do próprio trade', () => {
  // A versão anterior mandava DELETE /openOrders com o símbolo, que apaga
  // TODAS as ordens abertas do par — inclusive as que o Bruno pôs na mão.
  const abertas = [
    { clientOrderId: 'btXYZARBUSDTs', side: 'SELL' },   // stop do robô
    { clientOrderId: 'btXYZARBUSDTa', side: 'SELL' },   // alvo do robô
    { clientOrderId: 'btXYZARBUSDTt9k2s', side: 'SELL' }, // trailing anterior
    { clientOrderId: 'minha-ordem-do-bruno', side: 'SELL' },
    { clientOrderId: 'web_4f9a2b', side: 'SELL' },       // colocada pelo site da Binance
    { clientOrderId: 'btOUTRODIFERENTEs', side: 'SELL' },
  ];
  const minhas = minhasOrdens(abertas, 'btXYZARBUSDT', 'SELL');
  assert.equal(minhas.length, 3);
  assert.ok(minhas.every(o => o.clientOrderId.startsWith('btXYZARBUSDT')));
  assert.ok(!minhas.some(o => o.clientOrderId === 'minha-ordem-do-bruno'), 'nunca cancelar ordem do Bruno');
  assert.ok(!minhas.some(o => o.clientOrderId === 'web_4f9a2b'), 'nunca cancelar ordem feita no site');
});

test('BUG 3b: sem ordemId não cancela nada — silêncio é melhor que às cegas', () => {
  assert.deepEqual(minhasOrdens([{ clientOrderId: 'qualquer', side: 'SELL' }], ''), []);
});

test('BUG 4: entrada parada há muito tempo vence', () => {
  // Ordem limite GTC espera para sempre. Preencher tarde é pior do que não
  // preencher: entra num setup que já não existe, com stop de um mercado que
  // já mudou.
  const agora = Date.parse('2026-09-07T12:00:00Z');
  const posicoes = [
    { simbolo: 'AUSDT', estado: 'AGUARDANDO', criada_em: '2026-09-07T11:40:00Z' }, // 20 min
    { simbolo: 'BUSDT', estado: 'AGUARDANDO', criada_em: '2026-09-07T11:55:00Z' }, // 5 min
    { simbolo: 'CUSDT', estado: 'ABERTA', criada_em: '2026-09-06T00:00:00Z' },     // comprada, não expira
  ];
  const vencidas = entradasVencidas(posicoes, 15, agora);
  assert.equal(vencidas.length, 1);
  assert.equal(vencidas[0].simbolo, 'AUSDT');
});

test('BUG 4b: posição comprada nunca vence por tempo', () => {
  const agora = Date.parse('2026-09-07T12:00:00Z');
  const antiga = [{ simbolo: 'X', estado: 'ABERTA', criada_em: '2025-01-01T00:00:00Z' }];
  assert.deepEqual(entradasVencidas(antiga, 15, agora), [], 'quem já comprou sai pelo stop ou pelo alvo, não pelo relógio');
});
