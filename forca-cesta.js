'use strict';
// ============================================================
// FORÇA DA CESTA — o medidor do Super Power. 16/11/2026
//
// Pedido do Bruno: "a força compradora dessas ações diz o futuro do mini
// índice". A ideia é medir, ao mesmo tempo, se as ações que mais pesam no
// Ibovespa estão sendo compradas ou vendidas com força, e quanto cada uma
// empurra o WIN.
//
// HONESTIDADE DO DADO (não remover): o dado grátis (Yahoo) chega com atraso
// e NÃO traz o lado agressor. Por isso a força aqui é uma ESTIMATA por
// candle: volume × onde o candle fechou dentro da própria faixa (perto da
// máxima = comprador mandou; perto da mínima = vendedor mandou). Quando o
// feed real (MT5/Profit) entrar, troca-se só `forcaDoCandle` pelo saldo de
// agressão de verdade. O resto (pesos, cesta, sinal, telas) não muda.
//
// Tudo aqui é função pura: sem rede, sem banco, sem relógio. Teste em
// test/forca-cesta.test.js.
// ============================================================

// Pesos aproximados na carteira teórica do Ibovespa (set–dez/2026). VALE3,
// ITUB4 e PETR4 vêm do levantamento publicado; os demais são estimativa.
// Conferir na B3 a cada rebalanceamento (jan, mai, set). O peso só serve para
// dizer quanto cada ação empurra o índice: errar 0,5 ponto não muda o sinal.
const CESTA = [
  { codigo: 'VALE3', nome: 'Vale', yahoo: 'VALE3.SA', peso: 11.9 },
  { codigo: 'ITUB4', nome: 'Itaú', yahoo: 'ITUB4.SA', peso: 8.5 },
  { codigo: 'PETR4', nome: 'Petrobras', yahoo: 'PETR4.SA', peso: 7.7 },
  { codigo: 'BBDC4', nome: 'Bradesco', yahoo: 'BBDC4.SA', peso: 3.5 },
  { codigo: 'BBAS3', nome: 'Banco do Brasil', yahoo: 'BBAS3.SA', peso: 2.8 },
  { codigo: 'WEGE3', nome: 'WEG', yahoo: 'WEGE3.SA', peso: 2.7 },
  { codigo: 'B3SA3', nome: 'B3', yahoo: 'B3SA3.SA', peso: 2.6 },
  { codigo: 'ABEV3', nome: 'Ambev', yahoo: 'ABEV3.SA', peso: 2.5 },
];

const PADRAO = {
  janela: 15,        // candles de 1 min na conta da força (15 min)
  limiar: 40,        // |força da cesta| a partir daqui acende o sinal
  neutra: 20,        // |força da ação| abaixo disso = "neutra"
  concordancia: 0.6, // fração do PESO da cesta que precisa estar do mesmo lado
};

const arred = (v, casas = 0) => { const f = 10 ** casas; return Math.round(Number(v) * f) / f; };
const limita = (v, min, max) => Math.min(max, Math.max(min, v));

/** Candles do Yahoo COM volume. (O candlesDoYahoo do simulador B3 descarta o
 *  volume, porque o Ibovespa à vista não tem; aqui o volume é o principal.) */
function candlesComVolume(payload) {
  const r = payload?.chart?.result?.[0];
  if (!r) return [];
  const q = r.indicators?.quote?.[0] || {};
  const val = (v) => (v === null || v === undefined ? NaN : Number(v));
  return (r.timestamp || [])
    .map((t, i) => ({
      time: t * 1000,
      open: val(q.open?.[i]),
      high: val(q.high?.[i]),
      low: val(q.low?.[i]),
      close: val(q.close?.[i]),
      volume: Number.isFinite(val(q.volume?.[i])) ? val(q.volume[i]) : 0,
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0);
}

/** Onde o candle fechou na própria faixa: +1 na máxima, −1 na mínima.
 *  Candle sem faixa (máxima = mínima) diz só a direção contra a abertura. */
function posicaoNoCandle(c) {
  const faixa = c.high - c.low;
  if (!(faixa > 0)) return c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
  return limita(((c.close - c.low) - (c.high - c.close)) / faixa, -1, 1);
}

/** Força estimada de UM candle, em "volume com sinal". */
function forcaDoCandle(c) {
  return posicaoNoCandle(c) * (Number(c.volume) || 0);
}

/** Força de uma ação nos últimos `janela` candles, de −100 a +100.
 *  É o volume com sinal dividido pelo volume total: +100 = todo o volume
 *  fechou na máxima; 0 = empate. Sem volume, cai para a média da posição. */
function forcaDaAcao(candles, janela = PADRAO.janela) {
  const ultimos = (candles || []).slice(-janela);
  if (!ultimos.length) return { forca: null, volume: 0, candles: 0 };
  const volume = ultimos.reduce((s, c) => s + (Number(c.volume) || 0), 0);
  let forca;
  if (volume > 0) forca = (ultimos.reduce((s, c) => s + forcaDoCandle(c), 0) / volume) * 100;
  else forca = (ultimos.reduce((s, c) => s + posicaoNoCandle(c), 0) / ultimos.length) * 100;
  return { forca: arred(limita(forca, -100, 100)), volume, candles: ultimos.length };
}

function rotulo(forca, neutra = PADRAO.neutra) {
  if (forca === null) return { texto: 'sem dado', lado: 0 };
  if (forca >= neutra) return { texto: 'puxa pra cima', lado: 1 };
  if (forca <= -neutra) return { texto: 'puxa pra baixo', lado: -1 };
  return { texto: 'neutra', lado: 0 };
}

/** A cesta inteira: força ponderada pelo peso no Ibovespa e a influência de
 *  cada ação (quantos pontos da força da cesta vêm dela). */
function forcaDaCesta(porAcao, opcoes = {}) {
  const cfg = { ...PADRAO, ...opcoes };
  const comDado = CESTA.filter((a) => porAcao[a.codigo] && porAcao[a.codigo].forca !== null);
  const pesoTotal = comDado.reduce((s, a) => s + a.peso, 0);
  const acoes = CESTA.map((a) => {
    const f = porAcao[a.codigo] || { forca: null, volume: 0 };
    const influencia = f.forca === null || !pesoTotal ? null : arred((a.peso * f.forca) / pesoTotal, 1);
    return { ...a, forca: f.forca, volume: f.volume || 0, variacaoPct: f.variacaoPct ?? null, preco: f.preco ?? null, influencia, ...{ rotulo: rotulo(f.forca, cfg.neutra) } };
  });
  const forca = pesoTotal ? arred(acoes.reduce((s, a) => s + (a.influencia || 0), 0)) : null;
  const lado = forca === null ? 0 : Math.sign(forca);
  const pesoNoLado = comDado.filter((a) => lado !== 0 && rotulo(porAcao[a.codigo].forca, cfg.neutra).lado === lado).reduce((s, a) => s + a.peso, 0);
  return {
    forca,
    concordancia: pesoTotal ? arred(pesoNoLado / pesoTotal, 2) : 0,
    cobertura: arred(pesoTotal, 1), // % do Ibovespa que a cesta está enxergando agora
    acoes: acoes.sort((x, y) => Math.abs(y.influencia || 0) - Math.abs(x.influencia || 0)),
  };
}

/** Série da força da cesta minuto a minuto, para desenhar por cima do WIN.
 *  `candlesPorAcao` = {VALE3:[...], ...}; `tempos` = os minutos do WIN. */
function serieDaForca(candlesPorAcao, tempos, janela = PADRAO.janela) {
  const indices = Object.fromEntries(Object.entries(candlesPorAcao).map(([k, v]) => [k, v || []]));
  const ponteiro = Object.fromEntries(Object.keys(indices).map((k) => [k, 0]));
  const serie = [];
  for (const t of tempos) {
    const porAcao = {};
    for (const [codigo, candles] of Object.entries(indices)) {
      // candles vêm em ordem; avança o ponteiro até o último candle <= t
      while (ponteiro[codigo] < candles.length && candles[ponteiro[codigo]].time <= t) ponteiro[codigo] += 1;
      const ate = ponteiro[codigo];
      if (ate === 0) continue;
      porAcao[codigo] = forcaDaAcao(candles.slice(Math.max(0, ate - janela), ate), janela);
    }
    const cesta = forcaDaCesta(porAcao);
    if (cesta.forca !== null) serie.push({ time: t, value: cesta.forca });
  }
  return serie;
}

/** O sinal que acende o botão ATIVAR. Regra escolhida pelo Bruno (16/11):
 *  força forte + a maioria do PESO do mesmo lado; depois ainda passa pela
 *  mesa de agentes. Sempre devolve o MOTIVO, inclusive quando é ESPERAR. */
function sinal(cesta, win = {}, opcoes = {}) {
  const cfg = { ...PADRAO, ...opcoes };
  if (!cesta || cesta.forca === null) return { lado: 'ESPERAR', motivo: 'Sem dado das ações agora.' };
  if (cesta.cobertura < 20) return { lado: 'ESPERAR', motivo: `A cesta só enxerga ${cesta.cobertura}% do índice agora. Pouco para decidir.` };
  if (win.pregaoAberto === false) return { lado: 'ESPERAR', motivo: win.motivoPregao || 'Pregão fechado.' };
  const f = cesta.forca;
  if (Math.abs(f) < cfg.limiar) return { lado: 'ESPERAR', motivo: `Força ${f > 0 ? '+' : ''}${f}: abaixo de ±${cfg.limiar}. Ninguém está mandando.` };
  const lado = f > 0 ? 'COMPRA' : 'VENDA';
  const pct = Math.round(cesta.concordancia * 100);
  if (cesta.concordancia < cfg.concordancia) return { lado: 'ESPERAR', motivo: `Força ${f > 0 ? '+' : ''}${f}, mas só ${pct}% do peso está do mesmo lado (mínimo ${Math.round(cfg.concordancia * 100)}%). Uma ação sozinha não é o índice.` };
  // WIN já andou muito na mesma direção na janela? Avisa, não bloqueia: o
  // backtest é que vai dizer se "atrasado" importa.
  const andou = Number(win.variacaoJanelaPct);
  const atrasado = Number.isFinite(andou) ? (lado === 'COMPRA' ? andou < 0.15 : andou > -0.15) : null;
  return {
    lado,
    forca: f,
    concordancia: cesta.concordancia,
    winAtrasado: atrasado,
    motivo: `Força ${f > 0 ? '+' : ''}${f} com ${pct}% do peso ${lado === 'COMPRA' ? 'comprando' : 'vendendo'}.${atrasado === true ? ' O WIN ainda não acompanhou.' : atrasado === false ? ' O WIN já andou junto: entrada mais arriscada.' : ''} Falta a mesa de agentes confirmar.`,
  };
}

/** A trava do código vale mais que a IA: a mesa só confirma o que o sinal
 *  já disse. Se discordar, ou se o sinal for ESPERAR, o botão não acende. */
function podeAtivar(sinalAtual, veredito) {
  if (!sinalAtual || sinalAtual.lado === 'ESPERAR') return { ok: false, motivo: sinalAtual?.motivo || 'Sem sinal.' };
  if (!veredito) return { ok: false, motivo: 'Peça a mesa de agentes antes de ativar.' };
  if (veredito.veredito !== sinalAtual.lado) return { ok: false, motivo: `A mesa disse ${veredito.veredito}, a força diz ${sinalAtual.lado}. Sem acordo, sem entrada.` };
  return { ok: true, motivo: `Força e mesa concordam: ${sinalAtual.lado}.` };
}

const MESA_SCHEMA = {
  type: 'object',
  properties: {
    veredito: { type: 'string', enum: ['COMPRA', 'VENDA', 'ESPERAR'] },
    confianca: { type: 'integer', minimum: 0, maximum: 100 },
    touro: { type: 'string' },
    urso: { type: 'string' },
    risco: { type: 'string' },
  },
  required: ['veredito', 'confianca', 'touro', 'urso', 'risco'],
  additionalProperties: false,
};

module.exports = { CESTA, PADRAO, MESA_SCHEMA, candlesComVolume, posicaoNoCandle, forcaDoCandle, forcaDaAcao, forcaDaCesta, serieDaForca, sinal, podeAtivar, rotulo };
