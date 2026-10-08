'use strict';

// ============================================================
// SIMULADOR B3 — MINI ÍNDICE (WIN) E MINI DÓLAR (WDO) — 07/10/2026
//
// Pedido do Bruno: "a gente começa com simulador no mini índice e no dólar".
//
// O QUE É E O QUE NÃO É
// Dinheiro simulado, regra de contrato de verdade: valor do ponto, tick,
// margem de day trade, stop obrigatório, trava de perda do dia e zeragem no
// fim do pregão. Nenhuma ordem sai daqui para corretora — o BaladaTrade não
// tem ligação com a B3.
//
// DE ONDE VEM O PREÇO, DITO COM TODAS AS LETRAS
// O preço do contrato futuro é dado pago (licença da bolsa). O que é público
// e grátis é a REFERÊNCIA: Ibovespa à vista para o WIN e dólar comercial para
// o WDO, pelo Yahoo. Em 07/10/2026 o WIN fechou em 204.920 e o Ibovespa em
// 204.302: 0,3% de diferença, que é o juro embutido no futuro. O MOVIMENTO
// acompanha; o número exato não. Por isso a tela diz "preço de referência",
// nunca "preço do WIN".
//
// A consequência que vira regra: o Ibovespa à vista só anda das 10h às 17h.
// Fora disso o WIN simulado fica parado, então o pregão simulado do WIN é
// 10h–16h50, e não o 9h–18h25 do contrato de verdade.
//
// Tudo aqui é função pura. O que mexe em dinheiro, mesmo simulado, tem de dar
// para conferir sem rede, sem banco e sem relógio próprio.
// ============================================================

const CONTRATOS = {
  WIN: {
    codigo: 'WIN',
    nome: 'Mini Índice',
    valorPonto: 0.2,
    tick: 5,
    casas: 0,
    // Margem mínima de day trade da B3 desde 02/02/2026. A corretora pode
    // exigir mais; menos, não.
    margem: 155,
    referencia: 'Ibovespa à vista',
    yahoo: '^BVSP',
    fator: 1,
    abre: '10:00',
    // Dez minutos antes de a referência parar, como a corretora faz com o
    // contrato de verdade.
    zera: '16:50',
    stopMin: 25,
    stopMax: 3000,
  },
  WDO: {
    codigo: 'WDO',
    nome: 'Mini Dólar',
    valorPonto: 10,
    tick: 0.5,
    casas: 1,
    margem: 140,
    referencia: 'Dólar comercial × 1.000',
    yahoo: 'BRL=X',
    fator: 1000,
    abre: '09:00',
    zera: '18:15',
    stopMin: 1,
    stopMax: 60,
  },
};

const LADOS = ['COMPRA', 'VENDA'];
const OFFSET_RECIFE_MS = 3 * 3600e3; // UTC-3 fixo: o Brasil não tem mais horário de verão.
const MINUTO = 60e3;
// Preço de referência mais velho que isso não serve para abrir posição:
// entrar com preço parado é simular um mercado que não existe mais.
const PRECO_VELHO_MIN = 20;

const CONFIG_PADRAO = {
  saldoInicial: 1000,
  limitePerdaDia: 100,
  maxContratos: { WIN: 5, WDO: 2 },
  // Sem número inventado: o custo depende da corretora. Começa em zero e a tela
  // avisa que não está incluído até o Bruno preencher.
  custoPorLado: { WIN: 0, WDO: 0 },
};

const arred2 = (n) => Math.round(Number(n) * 100) / 100;

function arredondaTick(preco, tick) {
  return Number((Math.round(Number(preco) / tick) * tick).toFixed(2));
}

const oposto = (lado) => (lado === 'COMPRA' ? 'VENDA' : 'COMPRA');

/** Junta o que veio da tela com o padrão, sem deixar passar valor absurdo. */
function normalizarConfig(entrada = {}) {
  const c = entrada && typeof entrada === 'object' ? entrada : {};
  const num = (v, min, max, padrao) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
  };
  const max = c.maxContratos || {};
  const custo = c.custoPorLado || {};
  return {
    saldoInicial: num(c.saldoInicial, 100, 1000000, CONFIG_PADRAO.saldoInicial),
    limitePerdaDia: num(c.limitePerdaDia, 10, 100000, CONFIG_PADRAO.limitePerdaDia),
    maxContratos: {
      WIN: Math.floor(num(max.WIN, 1, 50, CONFIG_PADRAO.maxContratos.WIN)),
      WDO: Math.floor(num(max.WDO, 1, 20, CONFIG_PADRAO.maxContratos.WDO)),
    },
    custoPorLado: {
      WIN: arred2(num(custo.WIN, 0, 50, 0)),
      WDO: arred2(num(custo.WDO, 0, 50, 0)),
    },
  };
}

// ------------------------------------------------------------
// RELÓGIO DO PREGÃO (horário de Brasília)
// ------------------------------------------------------------

const minutosDe = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

function relogioRecife(agoraMs) {
  const d = new Date(Number(agoraMs) - OFFSET_RECIFE_MS);
  return {
    dia: d.toISOString().slice(0, 10),
    minutos: d.getUTCHours() * 60 + d.getUTCMinutes(),
    semana: d.getUTCDay(),
  };
}

/** Instante (ms UTC) de um horário de Brasília num dia AAAA-MM-DD. */
function instanteRecife(dia, hhmm) {
  const [a, m, d] = String(dia).split('-').map(Number);
  return Date.UTC(a, m - 1, d) + minutosDe(hhmm) * MINUTO + OFFSET_RECIFE_MS;
}

const inicioDoDiaMs = (agoraMs) => instanteRecife(relogioRecife(agoraMs).dia, '00:00');

/** O pregão simulado está aberto agora? Sempre devolve o motivo. */
function pregao(codigo, agoraMs) {
  const c = CONTRATOS[codigo];
  const r = relogioRecife(agoraMs);
  const zeraEm = instanteRecife(r.dia, c.zera);
  if (r.semana === 0 || r.semana === 6) {
    return { aberto: false, motivo: 'Fim de semana: a B3 não abre.', zeraEm };
  }
  if (r.minutos < minutosDe(c.abre)) {
    return { aberto: false, motivo: `O pregão simulado do ${codigo} abre às ${c.abre.replace(':00', 'h')}.`, zeraEm };
  }
  if (r.minutos >= minutosDe(c.zera)) {
    return { aberto: false, motivo: `O pregão simulado do ${codigo} fechou às ${c.zera.replace(':', 'h')}. Volta no próximo dia útil.`, zeraEm };
  }
  return { aberto: true, motivo: `Aberto até ${c.zera.replace(':', 'h')} (horário de Brasília).`, zeraEm };
}

// ------------------------------------------------------------
// PREÇO
// ------------------------------------------------------------

/** Candles do Yahoo já convertidos para pontos do contrato (×1.000 no dólar). */
function candlesDoYahoo(payload, fator = 1) {
  const r = payload?.chart?.result?.[0];
  if (!r) return { candles: [], preco: null, fechamentoAnterior: null };
  const q = r.indicators?.quote?.[0] || {};
  // Number(null) é 0, e zero passaria como preço. O Yahoo manda null no minuto
  // sem negócio: isso é buraco, não preço.
  const val = (v) => (v === null || v === undefined ? NaN : Number(v) * fator);
  const candles = (r.timestamp || [])
    .map((t, i) => ({
      time: t * 1000,
      open: val(q.open?.[i]),
      high: val(q.high?.[i]),
      low: val(q.low?.[i]),
      close: val(q.close?.[i]),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0);
  const meta = r.meta || {};
  const preco = Number.isFinite(Number(meta.regularMarketPrice)) ? Number(meta.regularMarketPrice) * fator : candles.at(-1)?.close ?? null;
  const anterior = Number(meta.chartPreviousClose ?? meta.previousClose);
  return { candles, preco, fechamentoAnterior: Number.isFinite(anterior) ? anterior * fator : null };
}

/** Preço da referência no tick do contrato. */
function precoDeReferencia(codigo, preco) {
  return arredondaTick(preco, CONTRATOS[codigo].tick);
}

/** Preço em que a ordem a mercado executa: um tick CONTRA quem opera. Simulador
 *  que executa no preço exato da tela ensina um resultado que não existe. */
function precoDeExecucao(codigo, lado, preco, ticks = 1) {
  const { tick } = CONTRATOS[codigo];
  const sinal = lado === 'COMPRA' ? 1 : -1;
  return arredondaTick(arredondaTick(preco, tick) + sinal * ticks * tick, tick);
}

/** Stop e alvo em preço, a partir da distância em pontos. */
function precosDaOrdem(codigo, lado, entrada, stopPontos, alvoPontos) {
  const { tick } = CONTRATOS[codigo];
  const s = lado === 'COMPRA' ? 1 : -1;
  return {
    entrada,
    stop: arredondaTick(entrada - s * stopPontos, tick),
    alvo: alvoPontos ? arredondaTick(entrada + s * alvoPontos, tick) : null,
  };
}

// ------------------------------------------------------------
// RESULTADO
// ------------------------------------------------------------

function resultadoDaOperacao({ contrato, lado, quantidade, entrada, saida, custoPorLado = 0 }) {
  const c = CONTRATOS[contrato];
  const s = lado === 'COMPRA' ? 1 : -1;
  const pontos = Number(((Number(saida) - Number(entrada)) * s).toFixed(2));
  const bruto = arred2(pontos * c.valorPonto * quantidade);
  const custos = arred2(Number(custoPorLado) * quantidade * 2);
  return { pontos, bruto, custos, liquido: arred2(bruto - custos) };
}

/** Quanto se perde em reais se o stop for executado (com o deslize de 1 tick). */
function riscoEmReais(codigo, quantidade, stopPontos, custoPorLado = 0) {
  const c = CONTRATOS[codigo];
  return arred2((Number(stopPontos) + c.tick) * c.valorPonto * quantidade + Number(custoPorLado) * quantidade * 2);
}

// ------------------------------------------------------------
// A ORDEM: o que precisa ser verdade para ela existir
// ------------------------------------------------------------

function validarOrdem(pedido = {}, ctx = {}) {
  const contrato = String(pedido.contrato || '').toUpperCase();
  const lado = String(pedido.lado || '').toUpperCase();
  const c = CONTRATOS[contrato];
  if (!c) return { ok: false, motivo: 'Escolha WIN (mini índice) ou WDO (mini dólar).' };
  if (!LADOS.includes(lado)) return { ok: false, motivo: 'Escolha comprar ou vender.' };
  const config = normalizarConfig(ctx.config);
  const quantidade = Number(pedido.quantidade);
  const maximo = config.maxContratos[contrato];
  if (!Number.isInteger(quantidade) || quantidade < 1) return { ok: false, motivo: 'Quantidade precisa ser um número inteiro de contratos, a partir de 1.' };
  if (quantidade > maximo) return { ok: false, motivo: `Máximo de ${maximo} ${contrato} por ordem (Ajustes).` };
  // Sem stop não há ordem. É a regra do BaladaTrade inteiro: a perda é
  // decidida ANTES da entrada, não durante.
  const stopPontos = arredondaTick(Number(pedido.stopPontos), c.tick);
  if (!(stopPontos >= c.stopMin && stopPontos <= c.stopMax)) {
    return { ok: false, motivo: `Stop obrigatório: de ${c.stopMin} a ${c.stopMax} pontos no ${contrato}.` };
  }
  let alvoPontos = null;
  if (pedido.alvoPontos !== undefined && pedido.alvoPontos !== null && pedido.alvoPontos !== '' && Number(pedido.alvoPontos) !== 0) {
    alvoPontos = arredondaTick(Number(pedido.alvoPontos), c.tick);
    if (!(alvoPontos >= c.stopMin && alvoPontos <= c.stopMax * 3)) {
      return { ok: false, motivo: `Alvo de ${c.stopMin} a ${c.stopMax * 3} pontos, ou deixe vazio.` };
    }
  }
  const pregaoAgora = ctx.pregao || { aberto: false, motivo: 'Horário do pregão desconhecido.' };
  if (!pregaoAgora.aberto) return { ok: false, motivo: pregaoAgora.motivo };
  if (ctx.idadePrecoMin !== undefined && ctx.idadePrecoMin > PRECO_VELHO_MIN) {
    return { ok: false, motivo: `O preço de referência está parado há ${Math.round(ctx.idadePrecoMin)} min. Entrar com preço velho é simular um mercado que já passou.` };
  }
  if (ctx.temAberta) return { ok: false, motivo: `Já existe posição aberta em ${contrato}. Zere antes de abrir outra.` };
  const resultadoHoje = Number(ctx.resultadoHoje) || 0;
  if (resultadoHoje <= -config.limitePerdaDia) {
    return { ok: false, motivo: `Trava do dia: você perdeu R$ ${(-resultadoHoje).toFixed(2).replace('.', ',')} hoje e o limite é R$ ${config.limitePerdaDia.toFixed(2).replace('.', ',')}. Volta amanhã.` };
  }
  const margem = c.margem * quantidade;
  const livre = (Number(ctx.saldo) || 0) - (Number(ctx.margemEmUso) || 0);
  if (margem > livre) {
    return { ok: false, motivo: `Saldo simulado insuficiente: ${quantidade} ${contrato} pedem R$ ${margem.toFixed(2).replace('.', ',')} de margem e há R$ ${Math.max(0, livre).toFixed(2).replace('.', ',')} livres.` };
  }
  return { ok: true, ordem: { contrato, lado, quantidade, stopPontos, alvoPontos } };
}

// ------------------------------------------------------------
// A SAÍDA: stop, alvo ou fim do pregão
// ------------------------------------------------------------

/**
 * Lê os candles DEPOIS da entrada e diz se a posição já saiu.
 *
 * - O candle da entrada não conta: ele tem preços de antes de a ordem existir.
 * - Stop e alvo no mesmo candle: vale o STOP. Sem o tick a tick não dá para
 *   saber quem veio primeiro, e o simulador erra para o lado que custa.
 * - Abriu além do stop (gap): executa na abertura, que é pior que o stop.
 * - Chegou a hora da zeragem: sai no último preço antes dela.
 */
function avaliarSaida(posicao, candles = [], agoraMs = Date.now()) {
  const c = CONTRATOS[posicao.contrato];
  const compra = posicao.lado === 'COMPRA';
  const abertaEm = Number(posicao.abertaEmMs);
  const zeraEm = instanteRecife(relogioRecife(abertaEm).dia, c.zera);
  const inicio = Math.floor(abertaEm / MINUTO) * MINUTO + MINUTO;
  const depois = candles.filter((k) => k.time >= inicio && k.time < zeraEm).sort((a, b) => a.time - b.time);
  for (const k of depois) {
    const bateuStop = compra ? k.low <= posicao.stop : k.high >= posicao.stop;
    if (bateuStop) {
      const preco = compra ? Math.min(posicao.stop, k.open) : Math.max(posicao.stop, k.open);
      return { sair: true, tipo: 'STOP', preco: arredondaTick(preco, c.tick), em: k.time + MINUTO, texto: 'O stop foi atingido.' };
    }
    const bateuAlvo = posicao.alvo !== null && posicao.alvo !== undefined && (compra ? k.high >= posicao.alvo : k.low <= posicao.alvo);
    if (bateuAlvo) {
      const preco = compra ? Math.max(posicao.alvo, k.open) : Math.min(posicao.alvo, k.open);
      return { sair: true, tipo: 'ALVO', preco: arredondaTick(preco, c.tick), em: k.time + MINUTO, texto: 'O alvo foi atingido.' };
    }
  }
  if (agoraMs >= zeraEm) {
    const ultimo = depois.at(-1) || candles.filter((k) => k.time < zeraEm).sort((a, b) => a.time - b.time).at(-1);
    if (ultimo) {
      return { sair: true, tipo: 'ZERAGEM', preco: arredondaTick(ultimo.close, c.tick), em: zeraEm, texto: `Fim do pregão simulado (${c.zera.replace(':', 'h')}): posição zerada, como a corretora faz no day trade.` };
    }
  }
  return { sair: false };
}

// ------------------------------------------------------------
// O DIA
// ------------------------------------------------------------

function resumoDoDia(fechadasHoje = [], configEntrada = {}) {
  const config = normalizarConfig(configEntrada);
  const resultados = fechadasHoje.map((o) => Number(o.resultado) || 0);
  const resultado = arred2(resultados.reduce((a, b) => a + b, 0));
  const travado = resultado <= -config.limitePerdaDia;
  return {
    resultado,
    operacoes: resultados.length,
    ganhos: resultados.filter((r) => r > 0).length,
    perdas: resultados.filter((r) => r < 0).length,
    limitePerdaDia: config.limitePerdaDia,
    travado,
    motivo: travado
      ? `Trava do dia ligada: perdeu R$ ${(-resultado).toFixed(2).replace('.', ',')}. Novas ordens só amanhã.`
      : `Pode perder mais R$ ${(config.limitePerdaDia + Math.min(0, resultado)).toFixed(2).replace('.', ',')} hoje antes da trava.`,
  };
}

// ------------------------------------------------------------
// PARA A LEITURA DO CLAUDE: só números, nada de opinião pronta
// ------------------------------------------------------------

function ema(valores, periodo) {
  if (!valores.length) return null;
  const k = 2 / (periodo + 1);
  return valores.slice(1).reduce((a, v) => v * k + a * (1 - k), valores[0]);
}

function agrupar(candles, minutos) {
  const blocos = new Map();
  for (const k of candles) {
    const chave = Math.floor(k.time / (minutos * MINUTO));
    const b = blocos.get(chave);
    if (!b) blocos.set(chave, { time: chave * minutos * MINUTO, open: k.open, high: k.high, low: k.low, close: k.close });
    else { b.high = Math.max(b.high, k.high); b.low = Math.min(b.low, k.low); b.close = k.close; }
  }
  return [...blocos.values()].sort((a, b) => a.time - b.time);
}

function resumoTecnico(codigo, candles = [], fechamentoAnterior = null, agoraMs = Date.now()) {
  const c = CONTRATOS[codigo];
  const hoje = inicioDoDiaMs(agoraMs);
  let doDia = candles.filter((k) => k.time >= hoje);
  // Antes da abertura (ou no fim de semana) a leitura é do último pregão.
  if (!doDia.length && candles.length) {
    const ultimoDia = inicioDoDiaMs(candles.at(-1).time);
    doDia = candles.filter((k) => k.time >= ultimoDia);
  }
  if (doDia.length < 10) return { semDados: true, motivo: 'Poucos candles no pregão para ler.' };
  const cinco = agrupar(doDia, 5);
  const fechamentos = cinco.map((k) => k.close);
  const ultimo = doDia.at(-1).close;
  const maxima = Math.max(...doDia.map((k) => k.high));
  const minima = Math.min(...doDia.map((k) => k.low));
  const trs = cinco.map((k, i) => Math.max(k.high - k.low, i ? Math.abs(k.high - cinco[i - 1].close) : 0, i ? Math.abs(k.low - cinco[i - 1].close) : 0));
  const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
  const r = (n) => arredondaTick(n, c.tick);
  return {
    contrato: codigo,
    referencia: c.referencia,
    preco: r(ultimo),
    aberturaDoDia: r(doDia[0].open),
    maximaDoDia: r(maxima),
    minimaDoDia: r(minima),
    fechamentoAnterior: fechamentoAnterior ? r(fechamentoAnterior) : null,
    variacaoDiaPct: fechamentoAnterior ? Number(((ultimo / fechamentoAnterior - 1) * 100).toFixed(2)) : null,
    posicaoNoRangePct: maxima > minima ? Math.round(((ultimo - minima) / (maxima - minima)) * 100) : 50,
    ema20_5m: fechamentos.length >= 20 ? r(ema(fechamentos.slice(-60), 20)) : null,
    ema50_5m: fechamentos.length >= 50 ? r(ema(fechamentos.slice(-100), 50)) : null,
    atr14_5m_pontos: Number(atr.toFixed(c.casas)),
    candles5m: cinco.length,
    valorDoPonto: c.valorPonto,
    tick: c.tick,
  };
}

const LEITURA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tendencia: { type: 'string', enum: ['ALTA', 'BAIXA', 'LATERAL'] },
    resumo: { type: 'string' },
    suporte: { type: 'number' },
    resistencia: { type: 'number' },
    planoParaTreinar: { type: 'string' },
    cuidado: { type: 'string' },
  },
  required: ['tendencia', 'resumo', 'suporte', 'resistencia', 'planoParaTreinar', 'cuidado'],
};

module.exports = {
  CONTRATOS,
  LADOS,
  CONFIG_PADRAO,
  PRECO_VELHO_MIN,
  arredondaTick,
  oposto,
  normalizarConfig,
  relogioRecife,
  instanteRecife,
  inicioDoDiaMs,
  pregao,
  candlesDoYahoo,
  precoDeReferencia,
  precoDeExecucao,
  precosDaOrdem,
  resultadoDaOperacao,
  riscoEmReais,
  validarOrdem,
  avaliarSaida,
  resumoDoDia,
  agrupar,
  resumoTecnico,
  LEITURA_SCHEMA,
};
