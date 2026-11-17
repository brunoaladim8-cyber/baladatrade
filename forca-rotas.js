'use strict';
// ============================================================
// ROTAS DO SUPER POWER — /api/forca/*. 16/11/2026
//
// Ficam fora do server.js de propósito: o servidor só repassa o pedido para
// cá (uma linha), e o que é do monitor do WIN mora junto.
//
//   GET  /api/forca/estado   WIN + cesta + séries para os gráficos
//   POST /api/forca/mesa     Touro × Urso × Risco leem a cesta (Claude)
//   POST /api/forca/ativar   scalp no SIMULADOR, só se força E mesa concordam
//
// A trava é conferida AQUI, no servidor, e não na tela: o botão apagado é
// conveniência; a recusa do servidor é a regra.
// ============================================================
const F = require('./forca-cesta');
const P = require('./pontos-dia');

const CACHE_MS = 30000;   // o dado grátis tem atraso; 30 s não perde nada
const MESA_VALE_MS = 3 * 60000; // veredito da mesa vale 3 min, depois pede de novo
const MESA_ESPERA_MS = 20000;

function criarRotasForca({ B3, cotacaoB3, ordemB3, chamarClaudeJson, json, body, fetchImpl = fetch, agora = () => Date.now() }) {
  const cache = new Map();
  let ultimaMesa = null;
  let mesaOcupada = false;
  let mesaEm = 0;

  const erro = (mensagem, status = 409) => Object.assign(new Error(mensagem), { statusCode: status });

  async function candlesDaAcao(acao) {
    const g = cache.get(acao.codigo);
    if (g && agora() - g.em < CACHE_MS) return g.dados;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(acao.yahoo)}?interval=1m&range=1d`;
    const r = await fetchImpl(url, { headers: { 'user-agent': 'BaladaTrade/1.0' }, signal: AbortSignal.timeout(10000) });
    const payload = await r.json().catch(() => ({}));
    const candles = F.candlesComVolume(payload);
    const meta = payload?.chart?.result?.[0]?.meta || {};
    const dados = { candles, preco: Number(meta.regularMarketPrice) || candles.at(-1)?.close || null, anterior: Number(meta.chartPreviousClose ?? meta.previousClose) || null };
    if (r.ok && candles.length) cache.set(acao.codigo, { em: agora(), dados });
    return dados;
  }

  async function estado() {
    const t = agora(), avisos = [];
    const [win, ...porAcao] = await Promise.all([
      cotacaoB3('WIN').catch((e) => { avisos.push(e.message); return null; }),
      ...F.CESTA.map((a) => candlesDaAcao(a).catch(() => { avisos.push(`${a.codigo}: sem dado no Yahoo agora.`); return { candles: [] }; })),
    ]);
    const inicio = B3.inicioDoDiaMs(t);
    const candlesPorAcao = {}, forcas = {}, acoes = {};
    F.CESTA.forEach((a, i) => {
      const d = porAcao[i] || { candles: [] };
      // do pregão de hoje; se ainda não abriu, o último pregão que existir
      const hoje = d.candles.filter((k) => k.time >= inicio);
      const cs = hoje.length ? hoje : d.candles;
      candlesPorAcao[a.codigo] = cs;
      const f = F.forcaDaAcao(cs);
      const variacaoPct = d.preco && d.anterior ? Math.round(((d.preco - d.anterior) / d.anterior) * 10000) / 100 : null;
      forcas[a.codigo] = { ...f, preco: d.preco, variacaoPct };
      acoes[a.codigo] = {
        // cada candle já leva a própria força, para a tela pintar o volume
        candles: cs.map((k) => ({ ...k, forca: Math.round(F.posicaoNoCandle(k) * 100) })),
        serieForca: F.serieDaForca({ [a.codigo]: cs }, cs.map((k) => k.time)),
      };
    });
    const cesta = F.forcaDaCesta(forcas);
    const winCandles = win ? win.candles.filter((k) => k.time >= B3.inicioDoDiaMs(win.candles.at(-1)?.time || t)) : [];
    const janela = winCandles.slice(-F.PADRAO.janela);
    const variacaoJanelaPct = janela.length > 1 ? Math.round(((janela.at(-1).close - janela[0].open) / janela[0].open) * 10000) / 100 : null;
    const pg = B3.pregao('WIN', t);
    const sinal = F.sinal(cesta, { pregaoAberto: pg.aberto, motivoPregao: pg.motivo, variacaoJanelaPct });
    const mesa = ultimaMesa && t - ultimaMesa.em < MESA_VALE_MS ? ultimaMesa : null;
    return {
      win: win ? { preco: B3.precoDeReferencia('WIN', win.preco), variacaoPct: win.fechamentoAnterior ? Math.round(((win.preco - win.fechamentoAnterior) / win.fechamentoAnterior) * 10000) / 100 : null, variacaoJanelaPct, candles: winCandles, pregao: pg } : null,
      cesta,
      serie: F.serieDaForca(candlesPorAcao, winCandles.map((k) => k.time)),
      acoes,
      sinal,
      mesa,
      ativar: F.podeAtivar(sinal, mesa),
      padrao: F.PADRAO,
      avisos,
      atrasado: true,
      fonte: 'Dado grátis do Yahoo: chega com atraso (~15 min nas ações) e sem lado agressor. A força é ESTIMADA por volume × fechamento no candle. Não use para operar dinheiro de verdade.',
      execucao: 'SIMULACAO',
      atualizadoEm: new Date(t).toISOString(),
    };
  }

  async function mesa() {
    if (!process.env.ANTHROPIC_API_KEY) throw erro('Mesa de agentes sem ANTHROPIC_API_KEY no Railway.');
    if (mesaOcupada) throw erro('A mesa já está reunida. Aguarde.', 429);
    const espera = MESA_ESPERA_MS - (agora() - mesaEm);
    if (espera > 0) throw erro(`Aguarde ${Math.ceil(espera / 1000)}s para chamar a mesa de novo.`, 429);
    mesaOcupada = true;
    try {
      const e = await estado();
      const resumo = {
        win: e.win && { preco: e.win.preco, variacaoDiaPct: e.win.variacaoPct, variacaoUltimos15minPct: e.win.variacaoJanelaPct, pregao: e.win.pregao },
        forcaDaCesta: e.cesta.forca, concordanciaDoPeso: e.cesta.concordancia, coberturaDoIndicePct: e.cesta.cobertura,
        acoes: e.cesta.acoes.map((a) => ({ codigo: a.codigo, pesoNoIbov: a.peso, forca: a.forca, influencia: a.influencia, variacaoDiaPct: a.variacaoPct })),
        sinalDoCodigo: e.sinal,
      };
      const leitura = await chamarClaudeJson({
        system: 'Você é a mesa de agentes do BaladaTrade para o mini índice (WIN), num SIMULADOR com dinheiro de mentira. Três vozes: o Touro defende comprar, o Urso defende vender ou esperar, e o Gestor de Risco dá o veredito final (COMPRA, VENDA ou ESPERAR). Leia só os números recebidos; a força das ações é ESTIMADA com dado atrasado. Não invente notícia. Não prometa lucro. Frases curtas, português simples. Na dúvida, ESPERAR.',
        prompt: `Leia a cesta e o WIN agora e devolva o JSON pedido. Dados: ${JSON.stringify(resumo)}`,
        schema: F.MESA_SCHEMA, maxTokens: 600,
      });
      ultimaMesa = { ...leitura, em: agora(), sinalNaHora: e.sinal.lado };
      return { mesa: ultimaMesa, ativar: F.podeAtivar(e.sinal, ultimaMesa), execucao: 'SIMULACAO' };
    } finally { mesaOcupada = false; mesaEm = agora(); }
  }

  async function ativar(data = {}) {
    const e = await estado();
    const ok = F.podeAtivar(e.sinal, e.mesa);
    if (!ok.ok) throw erro(ok.motivo);
    // O simulador B3 faz o resto: stop obrigatório, trava do dia, 1 tick de
    // deslize, uma posição por contrato. Nada aqui fala com corretora.
    const ordem = await ordemB3({ contrato: 'WIN', lado: e.sinal.lado, quantidade: Number(data.quantidade) || 1, stopPontos: Number(data.stopPontos), alvoPontos: Number(data.alvoPontos) });
    ultimaMesa = null; // um veredito, uma entrada
    return { ...ordem, motivo: ok.motivo, execucao: 'SIMULACAO' };
  }

  // Jogo dos Pontos: quanto o índice andou + as regras do contrato, que vêm
  // do simulador B3 (fonte única: CONTRATOS.WIN), nunca escritas de novo aqui.
  async function pontos() {
    const t = agora();
    const cot = await cotacaoB3('WIN');
    // O fechamentoAnterior do Yahoo com range=5d é o de ANTES dos 5 dias: não
    // serve. O jogo usa o último candle do pregão anterior.
    const jogo = P.jogoDosPontos(cot.candles, null);
    const c = B3.CONTRATOS.WIN;
    return {
      ...jogo,
      contrato: { codigo: 'WIN', valorPonto: c.valorPonto, tick: c.tick, valorTick: Math.round(c.valorPonto * c.tick * 100) / 100, margem: c.margem, referencia: c.referencia },
      pregao: B3.pregao('WIN', t),
      atrasado: true,
      fonte: 'Referência: Ibovespa à vista pelo Yahoo, com atraso. A variação em pontos anda praticamente junto com o WIN; o número absoluto do WIN tem a diferença de juros (~0,3%). Ao vivo de verdade só com o feed da corretora (MT5).',
      atualizadoEm: new Date(t).toISOString(),
    };
  }

  return async function rotasForca(req, res, pathname) {
    if (pathname === '/api/forca/estado' && req.method === 'GET') return json(res, 200, await estado());
    if (pathname === '/api/forca/pontos' && req.method === 'GET') return json(res, 200, await pontos());
    if (pathname === '/api/forca/mesa' && req.method === 'POST') return json(res, 200, await mesa());
    if (pathname === '/api/forca/ativar' && req.method === 'POST') return json(res, 200, await ativar(await body(req)));
    return json(res, 404, { error: 'Endpoint não encontrado' });
  };
}

module.exports = { criarRotasForca };
