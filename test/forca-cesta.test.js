'use strict';
// O medidor do Super Power: a força estimada, o peso de cada ação e a regra
// que acende (ou não) o botão ATIVAR.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../forca-cesta');

const k = (time, open, high, low, close, volume) => ({ time, open, high, low, close, volume });
const comprando = (n, vol = 1000) => Array.from({ length: n }, (_, i) => k(i * 60000, 10, 11, 9.9, 11, vol));
const vendendo = (n, vol = 1000) => Array.from({ length: n }, (_, i) => k(i * 60000, 10, 10.1, 9, 9, vol));
const todas = (fn) => Object.fromEntries(F.CESTA.map((a) => [a.codigo, fn(a)]));

test('candle fechado na máxima é força +1; na mínima é −1', () => {
  assert.equal(F.posicaoNoCandle(k(0, 10, 11, 9, 11, 0)), 1);
  assert.equal(F.posicaoNoCandle(k(0, 10, 11, 9, 9, 0)), -1);
  assert.equal(F.posicaoNoCandle(k(0, 10, 11, 9, 10, 0)), 0);
  // sem faixa: vale a direção contra a abertura
  assert.equal(F.posicaoNoCandle(k(0, 10, 10.5, 10.5, 10.5, 0)), 1);
});

test('força da ação vai de −100 a +100 e pesa pelo volume', () => {
  assert.equal(F.forcaDaAcao(comprando(15)).forca, 100);
  assert.equal(F.forcaDaAcao(vendendo(15)).forca, -100);
  // um candle vendedor com volume 3x anula três compradores? não: 3 de +1×1000
  // contra 1 de −1×3000 dá zero.
  const misto = [...comprando(3, 1000), ...vendendo(1, 3000)];
  assert.equal(F.forcaDaAcao(misto).forca, 0);
  assert.equal(F.forcaDaAcao([]).forca, null);
});

test('sem volume (índice), a força cai para a média da posição', () => {
  assert.equal(F.forcaDaAcao(comprando(5, 0)).forca, 100);
});

test('Yahoo com minuto vazio (null) não vira preço zero', () => {
  const payload = { chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ open: [10, null], high: [11, null], low: [9, null], close: [10.5, null], volume: [500, null] }] } }] } };
  const c = F.candlesComVolume(payload);
  assert.equal(c.length, 1);
  assert.equal(c[0].volume, 500);
});

test('a força da cesta é ponderada pelo peso no Ibovespa', () => {
  // só a VALE3 comprando forte, o resto neutro: a força é o peso relativo da Vale
  const porAcao = todas((a) => ({ forca: a.codigo === 'VALE3' ? 100 : 0 }));
  const c = F.forcaDaCesta(porAcao);
  const pesoTotal = F.CESTA.reduce((s, a) => s + a.peso, 0);
  assert.equal(c.forca, Math.round((11.9 / pesoTotal) * 100));
  assert.equal(c.acoes[0].codigo, 'VALE3'); // a que mais influencia vem primeiro
  assert.equal(c.acoes[0].rotulo.texto, 'puxa pra cima');
});

test('ação sem dado fica fora da conta, e a cobertura mostra quanto a cesta enxerga', () => {
  const c = F.forcaDaCesta({ VALE3: { forca: 50 } });
  assert.equal(c.forca, 50);
  assert.equal(c.cobertura, 11.9);
  assert.equal(F.forcaDaCesta({}).forca, null);
});

test('sinal: força forte e maioria do peso do mesmo lado = COMPRA, com motivo', () => {
  const cesta = F.forcaDaCesta(todas(() => ({ forca: 60 })));
  const s = F.sinal(cesta, { pregaoAberto: true, variacaoJanelaPct: 0.05 });
  assert.equal(s.lado, 'COMPRA');
  assert.equal(s.winAtrasado, true);
  assert.match(s.motivo, /mesa de agentes/);
});

test('sinal: força fraca, concordância baixa ou pregão fechado = ESPERAR, sempre com motivo', () => {
  const fraca = F.forcaDaCesta(todas(() => ({ forca: 20 })));
  assert.equal(F.sinal(fraca, { pregaoAberto: true }).lado, 'ESPERAR');
  // Vale + Itaú comprando forte, o resto vendendo de leve: força passa de 40?
  // Não importa — se o peso do lado não chega a 60%, não acende.
  const dividida = F.forcaDaCesta(todas((a) => ({ forca: ['VALE3', 'ITUB4'].includes(a.codigo) ? 100 : -25 })));
  const s = F.sinal(dividida, { pregaoAberto: true }, { limiar: 10 });
  assert.equal(s.lado, 'ESPERAR');
  assert.match(s.motivo, /do peso/);
  const forte = F.forcaDaCesta(todas(() => ({ forca: 90 })));
  const fechado = F.sinal(forte, { pregaoAberto: false, motivoPregao: 'Fim de semana: a B3 não abre.' });
  assert.equal(fechado.lado, 'ESPERAR');
  assert.match(fechado.motivo, /Fim de semana/);
});

test('a trava vale mais que a IA: sem a mesa concordar, o botão não acende', () => {
  const s = { lado: 'COMPRA', motivo: 'x' };
  assert.equal(F.podeAtivar(s, null).ok, false);
  assert.equal(F.podeAtivar(s, { veredito: 'VENDA' }).ok, false);
  assert.equal(F.podeAtivar(s, { veredito: 'COMPRA' }).ok, true);
  assert.equal(F.podeAtivar({ lado: 'ESPERAR', motivo: 'fraca' }, { veredito: 'ESPERAR' }).ok, false);
});

// ---------- rotas (sem rede: Yahoo, simulador e IA são de mentira) ----------
const B3 = require('../b3-simulador');
const { criarRotasForca } = require('../forca-rotas');

function rotasDeTeste({ payload = {} } = {}) {
  const chamadas = { ordens: 0, mesa: 0 };
  const respostas = [];
  const rotas = criarRotasForca({
    B3,
    cotacaoB3: async () => ({ candles: [], preco: 180000, fechamentoAnterior: 179000 }),
    ordemB3: async () => { chamadas.ordens += 1; return { ok: true }; },
    chamarClaudeJson: async () => { chamadas.mesa += 1; return { veredito: 'ESPERAR', confianca: 50, touro: 't', urso: 'u', risco: 'r' }; },
    json: (res, status, corpo) => respostas.push({ status, corpo }),
    body: async () => ({ stopPontos: 100, alvoPontos: 100, quantidade: 1 }),
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  return { rotas, chamadas, respostas };
}

test('estado responde as 8 ações e avisa que o dado é atrasado', async () => {
  const { rotas, respostas } = rotasDeTeste();
  await rotas({ method: 'GET' }, {}, '/api/forca/estado');
  const { status, corpo } = respostas[0];
  assert.equal(status, 200);
  assert.equal(corpo.cesta.acoes.length, 8);
  assert.equal(corpo.atrasado, true);
  assert.equal(corpo.execucao, 'SIMULACAO');
  assert.equal(corpo.sinal.lado, 'ESPERAR');
});

test('ATIVAR sem sinal e sem mesa é recusado no servidor e não manda ordem', async () => {
  const { rotas, chamadas } = rotasDeTeste();
  await assert.rejects(rotas({ method: 'POST' }, {}, '/api/forca/ativar'), /Sem dado|mesa|Força/);
  assert.equal(chamadas.ordens, 0);
});

test('rota desconhecida do Super Power responde 404', async () => {
  const { rotas, respostas } = rotasDeTeste();
  await rotas({ method: 'GET' }, {}, '/api/forca/nada');
  assert.equal(respostas[0].status, 404);
});

test('o Super Power exige login', async () => {
  const http = require('node:http');
  const { handler } = require('../server');
  process.env.APP_PASSWORD = 'senha-sp'; process.env.AUTH_SECRET = 'segredo-sp-de-teste';
  const server = await new Promise((ok) => { const s = http.createServer(handler).listen(0, () => ok(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/forca/estado`);
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('série da força acompanha os minutos do WIN e só usa o passado', () => {
  const candles = { VALE3: [...vendendo(15), ...comprando(15).map((c) => ({ ...c, time: c.time + 15 * 60000 }))] };
  const tempos = [14 * 60000, 29 * 60000];
  const serie = F.serieDaForca(candles, tempos);
  assert.equal(serie.length, 2);
  assert.equal(serie[0].value, -100); // aos 14 min só existia venda
  assert.equal(serie[1].value, 100);  // aos 29 min a janela de 15 é toda compra
});
