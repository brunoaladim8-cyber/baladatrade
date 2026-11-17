'use strict';
// ============================================================
// JOGO DOS PONTOS — quanto o índice andou. 17/11/2026
//
// Pedido do Bruno: "quanto o índice andou no dia, na hora, quantos pontos
// marca no gráfico, como saber quantos pontos varia ao vivo".
//
// Conta em PONTOS do índice. Hoje a referência é o Ibovespa à vista (Yahoo),
// que anda praticamente junto com o WIN; o número absoluto do WIN tem a
// diferença de juros (~0,3%), mas a VARIAÇÃO em pontos é quase a mesma.
// 1 ponto do WIN = R$ 0,20 por contrato.
//
// Função pura: sem rede, sem relógio. Teste em test/pontos-dia.test.js.
// ============================================================
const VALOR_PONTO = 0.2;
const FUSO_MS = 3 * 3600 * 1000; // Brasília (sem horário de verão desde 2019)
const DIA_MS = 86400000;

const r0 = (v) => Math.round(Number(v));
const reais = (pts, contratos = 1) => Math.round(pts * VALOR_PONTO * contratos * 100) / 100;
const chaveDoDia = (ms) => Math.floor((ms - FUSO_MS) / DIA_MS);
const horaDe = (ms) => new Date(ms - FUSO_MS).getUTCHours();
const dataDe = (chave) => new Date(chave * DIA_MS).toISOString().slice(0, 10);

/** Resumo de um conjunto de candles em pontos. */
function resumo(candles) {
  if (!candles?.length) return null;
  let max = -Infinity, min = Infinity, quandoMax = null, quandoMin = null;
  for (const k of candles) {
    if (k.high > max) { max = k.high; quandoMax = k.time; }
    if (k.low < min) { min = k.low; quandoMin = k.time; }
  }
  const abertura = candles[0].open, atual = candles.at(-1).close;
  return {
    abertura: r0(abertura), atual: r0(atual), maxima: r0(max), minima: r0(min),
    variacao: r0(atual - abertura), amplitude: r0(max - min),
    quandoMax, quandoMin,
    // onde o preço está dentro da faixa do dia: 0 = na mínima, 100 = na máxima
    posicaoPct: max > min ? Math.round(((atual - min) / (max - min)) * 100) : 50,
  };
}

/** Separa os candles por pregão (dia de Brasília), em ordem. */
function porDia(candles) {
  const dias = new Map();
  for (const k of candles || []) {
    const c = chaveDoDia(k.time);
    if (!dias.has(c)) dias.set(c, []);
    dias.get(c).push(k);
  }
  return [...dias.entries()].sort((a, b) => a[0] - b[0]).map(([chave, cs]) => ({ chave, data: dataDe(chave), candles: cs }));
}

/** Quanto andou em cada hora do pregão. */
function porHora(candles) {
  const horas = new Map();
  for (const k of candles || []) {
    const h = horaDe(k.time);
    if (!horas.has(h)) horas.set(h, []);
    horas.get(h).push(k);
  }
  return [...horas.entries()].sort((a, b) => a[0] - b[0]).map(([hora, cs]) => {
    const s = resumo(cs);
    return { hora, rotulo: `${String(hora).padStart(2, '0')}h`, variacao: s.variacao, amplitude: s.amplitude, abertura: s.abertura, fechamento: s.atual, maxima: s.maxima, minima: s.minima, reais: reais(s.variacao) };
  });
}

/** O placar completo. `candles` = vários dias de candles de 1 min (o Yahoo
 *  manda 5 dias), `fechamentoAnterior` = fechamento oficial do dia anterior. */
function jogoDosPontos(candles, fechamentoAnterior = null) {
  const dias = porDia(candles);
  if (!dias.length) return { semDados: true, motivo: 'Sem candles do índice agora.' };
  const hojeDia = dias.at(-1);
  const anteriores = dias.slice(0, -1).map((d) => {
    const s = resumo(d.candles);
    return { data: d.data, amplitude: s.amplitude, variacao: s.variacao, maxima: s.maxima, minima: s.minima };
  });
  const hoje = resumo(hojeDia.candles);
  const ref = Number.isFinite(Number(fechamentoAnterior)) && fechamentoAnterior > 0
    ? fechamentoAnterior
    : (dias.length > 1 ? dias.at(-2).candles.at(-1).close : null);
  const mediaAmplitude = anteriores.length ? r0(anteriores.reduce((s, d) => s + d.amplitude, 0) / anteriores.length) : null;
  const mediaVariacaoAbs = anteriores.length ? r0(anteriores.reduce((s, d) => s + Math.abs(d.variacao), 0) / anteriores.length) : null;
  const usadoPct = mediaAmplitude ? Math.round((hoje.amplitude / mediaAmplitude) * 100) : null;

  // Os níveis que vão marcados no gráfico.
  const niveis = [
    { nome: 'Abertura', preco: hoje.abertura, tipo: 'abertura' },
    { nome: 'Máxima', preco: hoje.maxima, tipo: 'maxima' },
    { nome: 'Mínima', preco: hoje.minima, tipo: 'minima' },
  ];
  if (ref) niveis.push({ nome: 'Fech. anterior', preco: r0(ref), tipo: 'anterior' });
  for (const d of [500, 1000]) {
    niveis.push({ nome: `+${d}`, preco: hoje.abertura + d, tipo: 'faixa' });
    niveis.push({ nome: `−${d}`, preco: hoje.abertura - d, tipo: 'faixa' });
  }

  return {
    data: hojeDia.data,
    hoje: { ...hoje, reais: reais(hoje.variacao), reaisAmplitude: reais(hoje.amplitude), desdeFechamento: ref ? r0(hoje.atual - ref) : null, gap: ref ? r0(hoje.abertura - ref) : null },
    horas: porHora(hojeDia.candles),
    anteriores,
    mediaAmplitude, mediaVariacaoAbs, usadoPct,
    leitura: leitura(hoje, usadoPct, mediaAmplitude),
    niveis,
    candles: hojeDia.candles,
    valorPonto: VALOR_PONTO,
  };
}

/** Uma frase do que o placar diz, sem prever nada. */
function leitura(hoje, usadoPct, media) {
  const lado = hoje.variacao > 0 ? 'subindo' : hoje.variacao < 0 ? 'caindo' : 'no zero a zero';
  const base = `O índice está ${lado} ${Math.abs(hoje.variacao)} pontos desde a abertura (${hoje.variacao >= 0 ? '+' : '−'}R$ ${Math.abs(reais(hoje.variacao)).toFixed(2).replace('.', ',')} por contrato).`;
  if (usadoPct === null) return base;
  if (usadoPct >= 100) return `${base} Já andou ${usadoPct}% da faixa média dos últimos pregões (${media} pts): dia mais largo que o normal.`;
  if (usadoPct >= 70) return `${base} Já usou ${usadoPct}% da faixa média (${media} pts): sobra pouco espaço, se o dia for normal.`;
  return `${base} Usou ${usadoPct}% da faixa média (${media} pts): ainda tem espaço, se o dia for normal.`;
}

/** A régua: distância entre dois preços clicados no gráfico. */
function regua(de, ate, contratos = 1) {
  const pts = r0(Number(ate) - Number(de));
  return { pontos: pts, reais: reais(pts, contratos), ticks: Math.round(pts / 5) };
}

module.exports = { VALOR_PONTO, resumo, porDia, porHora, jogoDosPontos, regua, reais };
