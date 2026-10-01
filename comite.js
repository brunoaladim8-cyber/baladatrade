'use strict';

// ============================================================
// MESA DE AGENTES — 01/10/2026
//
// Bruno viu o TradingAgents (TauricResearch, ★109k) e pediu "bora pro Balada
// Trade". A ideia dele é boa e simples: em vez de UMA leitura da IA, uma mesa
// como a de uma corretora — três analistas olham o mesmo par por ângulos
// diferentes, um Touro e um Urso brigam em cima do que eles acharam, e um
// Gestor de Risco dá o veredito.
//
// O que NÃO veio do TradingAgents, de propósito:
//   - notícias e redes sociais: não temos fonte confiável ligada, e analista
//     sem dado inventa. Cada agente só vê os números do pretrade e do radar;
//   - execução: a mesa só dá parecer. execution='MANUAL_ONLY' sempre. Quem
//     manda ordem continua sendo o robô com as travas dele, ou o Bruno.
//
// As travas abaixo (limitarVeredito) valem MAIS que o modelo: se o código
// diz que não pode, a IA não convence ninguém do contrário.
// ============================================================

const VEREDITOS = ['ENTRAR_COM_PLANO', 'ESPERAR', 'EVITAR'];
const LEITURAS = ['ALTA', 'BAIXA', 'NEUTRA'];

const ANALISTAS = [
  {
    id: 'tecnico',
    nome: 'Analista Técnico',
    foco: 'tendência nos três tempos (15m, 1h, 4h), EMA20 x EMA50, RSI, ATR e se os tempos estão alinhados',
  },
  {
    id: 'fluxo',
    nome: 'Analista de Fluxo',
    foco: 'volume relativo, livro de ofertas (spread e desequilíbrio compra x venda), posição no intervalo de 24h e amplitude',
  },
  {
    id: 'contexto',
    nome: 'Analista de Contexto',
    foco: 'o mercado inteiro no radar das maiores moedas: quantas sobem, a força de BTC e ETH, e se este par anda junto ou contra',
  },
];

const REGRAS_DA_CASA =
  'Regras do BaladaTrade: somente Spot comprado (sem short, sem margem, sem alavancagem). ' +
  'Analise apenas os números recebidos; não invente notícia, evento ou dado. Não prometa lucro. ' +
  'Alta passada não garante alta futura. Responda em português do Brasil, frases curtas.';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Recorta o pretrade e o radar no que os agentes precisam. Menos texto = menos
// custo e menos chance de o modelo se agarrar a um campo irrelevante.
function montarDossie(mercado = {}, radar = []) {
  const frames = Array.isArray(mercado.frames) ? mercado.frames : [];
  const livro = mercado.orderBook || {};
  const moedas = Array.isArray(radar) ? radar.slice(0, 30) : [];
  const subindo = moedas.filter((c) => Number(c.change24h) > 0).length;
  const lider = (s) => {
    const c = moedas.find((x) => x.symbol === s);
    return c ? { symbol: s, change24h: num(c.change24h) } : null;
  };
  return {
    par: String(mercado.symbol || ''),
    preco: num(mercado.price),
    variacao24h: num(mercado.change24h),
    posicaoNoRange24hPct: num(mercado.rangePosition),
    amplitude24hPct: num(mercado.amplitude),
    alinhamento: mercado.alignment || null,
    tempos: frames.map((f) => ({
      tempo: f.label,
      tendencia: f.trend,
      rsi: num(f.rsi),
      ema20: num(f.ema20),
      ema50: num(f.ema50),
      atr: num(f.atr),
      volumeRelativo: num(f.volumeRatio),
      variacaoUltimoCandlePct: num(f.change),
    })),
    livro: {
      spreadPct: num(livro.spreadPct),
      desequilibrioPct: num(livro.imbalancePct),
      profundidadeCompraUsdt: num(livro.bidDepth),
      profundidadeVendaUsdt: num(livro.askDepth),
    },
    riscoDoSistema: mercado.risk || null,
    setupDoSistema: mercado.strategy
      ? { acao: mercado.strategy.action, direcao: mercado.strategy.direction, motivo: mercado.strategy.reason }
      : null,
    alertas: Array.isArray(mercado.warnings) ? mercado.warnings.slice(0, 8) : [],
    mercadoGeral: {
      moedasNoRadar: moedas.length,
      subindo24h: subindo,
      lideres: [lider('BTCUSDT'), lider('ETHUSDT')].filter(Boolean),
      top5: moedas.slice(0, 5).map((c) => ({ symbol: c.symbol, change24h: num(c.change24h), score: num(c.score) })),
    },
  };
}

const SCHEMA_ANALISTA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leitura: { type: 'string', enum: LEITURAS },
    nota: { type: 'number' },
    pontos: { type: 'array', items: { type: 'string' } },
    riscos: { type: 'array', items: { type: 'string' } },
  },
  required: ['leitura', 'nota', 'pontos', 'riscos'],
};

const SCHEMA_DEBATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tese: { type: 'string' },
    argumentos: { type: 'array', items: { type: 'string' } },
    oQueMeFariaMudar: { type: 'string' },
  },
  required: ['tese', 'argumentos', 'oQueMeFariaMudar'],
};

const SCHEMA_GESTOR = {
  type: 'object',
  additionalProperties: false,
  properties: {
    veredito: { type: 'string', enum: VEREDITOS },
    confianca: { type: 'number' },
    resumo: { type: 'string' },
    quemGanhouODebate: { type: 'string', enum: ['TOURO', 'URSO', 'EMPATE'] },
    condicaoDeEntrada: { type: 'string' },
    oQueInvalida: { type: 'string' },
  },
  required: ['veredito', 'confianca', 'resumo', 'quemGanhouODebate', 'condicaoDeEntrada', 'oQueInvalida'],
};

function pedidoDoAnalista(analista, dossie) {
  return {
    system: `Você é o ${analista.nome} da mesa do BaladaTrade. Seu foco: ${analista.foco}. ${REGRAS_DA_CASA} ` +
      'Dê uma nota de 0 (muito ruim para comprar) a 100 (muito bom para comprar). Máximo 4 pontos e 3 riscos.',
    prompt: `Analise o par ${dossie.par} só pelo seu foco. Dados: ${JSON.stringify(dossie)}`,
    schema: SCHEMA_ANALISTA,
    maxTokens: 700,
  };
}

function pedidoDoDebate(lado, dossie, relatorios) {
  const papel = lado === 'touro'
    ? 'o Pesquisador TOURO: defenda a compra com os melhores argumentos que os dados permitem'
    : 'o Pesquisador URSO: defenda NÃO comprar agora, com os riscos mais fortes que os dados mostram';
  return {
    system: `Você é ${papel}. ${REGRAS_DA_CASA} Use só o que os analistas e os dados trouxeram. Máximo 4 argumentos.`,
    prompt: `Par ${dossie.par}. Relatórios dos analistas: ${JSON.stringify(relatorios)}. Dados: ${JSON.stringify(dossie)}`,
    schema: SCHEMA_DEBATE,
    maxTokens: 700,
  };
}

function pedidoDoGestor(dossie, relatorios, touro, urso, plano) {
  return {
    system: `Você é o Gestor de Risco da mesa do BaladaTrade e dá o veredito final. ${REGRAS_DA_CASA} ` +
      'ENTRAR_COM_PLANO só quando analistas e debate sustentam a compra E o risco do sistema não é alto. ' +
      'Na dúvida, ESPERAR. Confiança de 0 a 100. A execução é sempre manual: você não manda ordem.',
    prompt: `Par ${dossie.par}. Analistas: ${JSON.stringify(relatorios)}. Touro: ${JSON.stringify(touro)}. ` +
      `Urso: ${JSON.stringify(urso)}. Plano calculado pelo sistema (pode ser nulo): ${JSON.stringify(plano || null)}. ` +
      `Dados: ${JSON.stringify(dossie)}`,
    schema: SCHEMA_GESTOR,
    maxTokens: 800,
  };
}

const limitar = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));

function normalizarAnalista(r = {}) {
  return {
    leitura: LEITURAS.includes(r.leitura) ? r.leitura : 'NEUTRA',
    nota: limitar(r.nota, 0, 100),
    pontos: (Array.isArray(r.pontos) ? r.pontos : []).slice(0, 4).map(String),
    riscos: (Array.isArray(r.riscos) ? r.riscos : []).slice(0, 3).map(String),
  };
}

function normalizarDebate(r = {}) {
  return {
    tese: String(r.tese || ''),
    argumentos: (Array.isArray(r.argumentos) ? r.argumentos : []).slice(0, 4).map(String),
    oQueMeFariaMudar: String(r.oQueMeFariaMudar || ''),
  };
}

// O código manda mais que o modelo. Devolve o veredito final e, quando
// rebaixa, o motivo — robô silencioso é indistinguível de robô quebrado.
function limitarVeredito(gestor = {}, mercado = {}, plano = null) {
  let veredito = VEREDITOS.includes(gestor.veredito) ? gestor.veredito : 'ESPERAR';
  const travas = [];
  const risco = Number(mercado.risk && mercado.risk.score);
  const direcao = mercado.strategy && mercado.strategy.direction;
  if (veredito === 'ENTRAR_COM_PLANO') {
    if (Number.isFinite(risco) && risco >= 65) travas.push(`risco do sistema em ${risco}/100 (alto)`);
    if (direcao === 'SHORT') travas.push('o setup do sistema é de venda e aqui só se opera Spot comprado');
    if (mercado.alignment === 'BAIXA') travas.push('os três tempos estão em baixa');
    if (plano && plano.allowed === false) travas.push('o plano calculado foi bloqueado pelas regras de risco');
    if (travas.length) veredito = Number.isFinite(risco) && risco >= 65 ? 'EVITAR' : 'ESPERAR';
  }
  return {
    veredito,
    vereditoDaIa: gestor.veredito || null,
    travas,
    confianca: limitar(gestor.confianca, 0, 100),
    resumo: String(gestor.resumo || ''),
    quemGanhouODebate: ['TOURO', 'URSO', 'EMPATE'].includes(gestor.quemGanhouODebate) ? gestor.quemGanhouODebate : 'EMPATE',
    condicaoDeEntrada: String(gestor.condicaoDeEntrada || ''),
    oQueInvalida: String(gestor.oQueInvalida || ''),
  };
}

// `chamar({system, prompt, schema, maxTokens})` devolve o JSON já lido. Vem de
// fora para o teste rodar sem rede e sem gastar token.
async function rodarMesa({ mercado, radar = [], plano = null, chamar }) {
  if (!mercado || !mercado.symbol) throw new Error('Busque o par antes de chamar a mesa.');
  if (typeof chamar !== 'function') throw new Error('Mesa sem modelo configurado.');
  const dossie = montarDossie(mercado, radar);

  // 1) analistas em paralelo — cada um só com o seu foco
  const brutos = await Promise.all(ANALISTAS.map((a) => chamar(pedidoDoAnalista(a, dossie))));
  const analistas = ANALISTAS.map((a, i) => ({ id: a.id, nome: a.nome, ...normalizarAnalista(brutos[i]) }));
  const relatorios = analistas.map(({ nome, leitura, nota, pontos, riscos }) => ({ nome, leitura, nota, pontos, riscos }));

  // 2) debate: Touro e Urso leem os mesmos relatórios
  const [touroBruto, ursoBruto] = await Promise.all([
    chamar(pedidoDoDebate('touro', dossie, relatorios)),
    chamar(pedidoDoDebate('urso', dossie, relatorios)),
  ]);
  const touro = normalizarDebate(touroBruto);
  const urso = normalizarDebate(ursoBruto);

  // 3) gestor de risco decide, e as travas do código têm a palavra final
  const gestorBruto = await chamar(pedidoDoGestor(dossie, relatorios, touro, urso, plano));
  const decisao = limitarVeredito(gestorBruto, mercado, plano);

  return {
    par: dossie.par,
    analistas,
    debate: { touro, urso },
    decisao,
    chamadas: ANALISTAS.length + 3,
    execution: 'MANUAL_ONLY',
    geradoEm: new Date().toISOString(),
    aviso: 'Parecer educacional da mesa de agentes. Não é recomendação financeira e não envia ordem.',
  };
}

module.exports = {
  ANALISTAS,
  VEREDITOS,
  SCHEMA_ANALISTA,
  SCHEMA_DEBATE,
  SCHEMA_GESTOR,
  montarDossie,
  limitarVeredito,
  normalizarAnalista,
  rodarMesa,
};
