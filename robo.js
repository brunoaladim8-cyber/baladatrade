// ============================================================
// O ROBÔ — 07/09/2026
//
// Pedido do Bruno em 07/09: "quero tudo mais automático possível, a gente
// perdeu movimento muito bom nas criptomoedas mesmo com todo sistema."
//
// E ele tem razão. O BaladaTrade já sabia tudo:
//
//   · o scanner ACHAVA o setup           (setupScanner)
//   · a peneira DESQUALIFICAVA o ruim    (peneira)
//   · o spot-engine DIMENSIONAVA a ordem (calculateSpotPlan)
//   · o guardião PROTEGIA o lucro        (guardiao-do-lucro)
//
// Faltava uma coisa só, e é a que custou o movimento: ALGUÉM APERTAR O BOTÃO.
// Todo o resto era diagnóstico esperando um humano acordado na frente da tela.
//
// ------------------------------------------------------------
// A DECISÃO DE ARQUITETURA QUE IMPORTA: OTOCO
// ------------------------------------------------------------
//
// A entrada, o stop e o alvo saem numa ÚNICA chamada, para dentro da Binance:
//
//     POST /api/v3/orderList/otoco
//
// A entrada fica na fila. Quando ela preenche, a PRÓPRIA BINANCE arma o stop
// e o alvo, sem perguntar nada a ninguém. A partir desse instante o robô pode
// morrer, o Railway pode reiniciar, a internet pode cair, o Mac pode desligar
// — a proteção continua viva no servidor da corretora.
//
// Isso é o oposto de um robô que guarda o stop na própria memória. Esse tipo
// morre no meio da posição e deixa o dinheiro exposto sem nada segurando. É
// assim que se perde uma conta inteira dormindo.
//
// Robô que "deixa lá" só é honesto se a proteção não depender dele estar vivo.
//
// ------------------------------------------------------------
// TUDO AQUI É FUNÇÃO PURA
// ------------------------------------------------------------
//
// Nenhuma chamada de rede, nenhum banco, nenhum relógio próprio. Recebe
// números e devolve a decisão. Quem executa é o server — e o que decide
// gastar dinheiro tem de poder ser testado sem gastar dinheiro.
// ============================================================

'use strict';

// O spot-engine já sabe arredondar pelo tickSize e pelo stepSize da Binance.
// Reaproveitar é obrigatório: preço arredondado por casa decimal em vez de
// pelo tick é a causa nº 1 de ordem recusada, e ter duas implementações
// diferentes disso no mesmo projeto é ter uma delas errada.
const { roundStep } = require('./spot-engine');

// ------------------------------------------------------------
// CONFIGURAÇÃO PADRÃO
//
// Todos os limites começam APERTADOS e o modo começa em SIMULAÇÃO. Um robô
// que nasce ligado e solto é um robô que quebra a conta antes de o dono
// entender o que ele faz.
// ------------------------------------------------------------
const CONFIG_PADRAO = {
  modo: 'SIMULACAO',        // SIMULACAO → decide e registra, não envia nada
                            // TESTNET   → envia de verdade, com dinheiro falso
                            // REAL      → dinheiro de verdade (exige trava extra)
  intervaloSegundos: 60,    // de quanto em quanto tempo ele olha o mercado
  setupsAceitos: ['PULLBACK LONG', 'FORÇA LONG'],
  riscoPctPorOrdem: 1,      // % do capital arriscado por trade
  notionalMaximo: 100,      // teto em USDT por ordem, redundante com MAX_ORDER_NOTIONAL
  maxPosicoes: 3,           // quantas posições abertas ao mesmo tempo
  maxOrdensPorDia: 6,       // freio contra loop maluco mandando ordem sem parar
  perdaMaximaDiaUsdt: 0,    // 0 = desligado. Acima disso, para o dia inteiro.
  alvoEmR: 2,              // alvo = 2x o que arrisca
  stopEmAtr: 1.5,          // stop = 1,5 ATR abaixo da entrada
  minutosParaEntrar: 15,    // depois disso a entrada que não preencheu é cancelada:
                            // o sinal que justificava aquele preço já venceu
  paresPermitidos: [],      // vazio = qualquer par que passe na peneira
  paresProibidos: [],
};

// Múltiplos de R usados pelo guardião. O alvo em 2R não é gosto: com 2R você
// pode errar duas de cada três e ainda terminar no positivo.
const R_MINIMO_ACEITAVEL = 1.5;

/** Junta a config do usuário com o padrão, sem deixar passar valor absurdo.
 *  Validar aqui é o que impede um campo digitado errado na tela virar uma
 *  ordem de mil dólares. */
function normalizarConfig(entrada = {}) {
  const c = { ...CONFIG_PADRAO, ...entrada };
  const numero = (valor, min, max, padrao) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
  };
  return {
    modo: ['SIMULACAO', 'TESTNET', 'REAL'].includes(c.modo) ? c.modo : 'SIMULACAO',
    intervaloSegundos: numero(c.intervaloSegundos, 30, 3600, 60),
    setupsAceitos: Array.isArray(c.setupsAceitos) && c.setupsAceitos.length
      ? c.setupsAceitos.filter((s) => typeof s === 'string')
      : CONFIG_PADRAO.setupsAceitos,
    riscoPctPorOrdem: numero(c.riscoPctPorOrdem, 0.1, 5, 1),
    notionalMaximo: numero(c.notionalMaximo, 5, 100000, 100),
    maxPosicoes: numero(c.maxPosicoes, 1, 20, 3),
    maxOrdensPorDia: numero(c.maxOrdensPorDia, 1, 100, 6),
    perdaMaximaDiaUsdt: numero(c.perdaMaximaDiaUsdt, 0, 1000000, 0),
    alvoEmR: numero(c.alvoEmR, 1, 10, 2),
    stopEmAtr: numero(c.stopEmAtr, 0.5, 5, 1.5),
    minutosParaEntrar: numero(c.minutosParaEntrar, 1, 1440, 15),
    paresPermitidos: Array.isArray(c.paresPermitidos) ? c.paresPermitidos.map(String) : [],
    paresProibidos: Array.isArray(c.paresProibidos) ? c.paresProibidos.map(String) : [],
  };
}

// ------------------------------------------------------------
// AS TRAVAS
//
// Vêm ANTES de qualquer escolha de ativo, e por um motivo: a pergunta "posso
// operar agora?" não pode depender de qual moeda apareceu no scanner. Se a
// resposta for não, ela é não para todas.
//
// Ordem deliberada — do que para tudo para o que só adia.
// ------------------------------------------------------------
function travasDeRisco(estado = {}, config = CONFIG_PADRAO) {
  const travas = [];

  if (estado.desligadoManualmente) {
    travas.push({ trava: 'DESLIGADO', texto: 'O robô está desligado. Nada será enviado.' });
  }

  // O botão do pânico. Uma vez acionado, só um humano religa — de propósito.
  if (estado.killSwitch) {
    travas.push({ trava: 'KILL_SWITCH', texto: 'Kill switch acionado. Religar é decisão sua, não dele.' });
  }

  const perdaHoje = Number(estado.perdaHojeUsdt) || 0;
  if (config.perdaMaximaDiaUsdt > 0 && perdaHoje >= config.perdaMaximaDiaUsdt) {
    travas.push({
      trava: 'PERDA_DO_DIA',
      texto: `Perdeu ${perdaHoje.toFixed(2)} USDT hoje, e o limite é ${config.perdaMaximaDiaUsdt.toFixed(2)}. ` +
             'O dia acabou. Dia ruim vira dia catastrófico exatamente aqui, tentando recuperar.',
    });
  }

  const abertas = Number(estado.posicoesAbertas) || 0;
  if (abertas >= config.maxPosicoes) {
    travas.push({
      trava: 'POSICOES_CHEIAS',
      texto: `Já são ${abertas} posições abertas, o teto é ${config.maxPosicoes}. Concentração é o risco que ninguém vê chegando.`,
    });
  }

  const ordensHoje = Number(estado.ordensHoje) || 0;
  if (ordensHoje >= config.maxOrdensPorDia) {
    travas.push({
      trava: 'ORDENS_DO_DIA',
      texto: `${ordensHoje} ordens hoje, o teto é ${config.maxOrdensPorDia}. Este freio existe para o caso de o robô entrar em loop — e é o único que protege contra bug.`,
    });
  }

  // Dado velho é pior que dado nenhum: com preço parado o robô decide sobre um
  // mercado que já não existe.
  const atrasoMs = Number(estado.atrasoDadosMs);
  if (Number.isFinite(atrasoMs) && atrasoMs > 120000) {
    travas.push({
      trava: 'DADOS_ATRASADOS',
      texto: `Os preços estão ${Math.round(atrasoMs / 1000)}s atrasados. Decidir com dado velho é pior do que não decidir.`,
    });
  }

  const saldo = Number(estado.saldoUsdt);
  if (Number.isFinite(saldo) && saldo < 10) {
    travas.push({
      trava: 'SALDO_INSUFICIENTE',
      texto: `Saldo de ${saldo.toFixed(2)} USDT. O mínimo por ordem na Binance (MIN_NOTIONAL) costuma ser 5 USDT, e sem folga não dá para dimensionar risco.`,
    });
  }

  return { travas, liberado: travas.length === 0 };
}

// ------------------------------------------------------------
// QUEM CONTA COMO POSICAO — e por que sao duas perguntas
//
// Este bloco existe por causa de um bug que teria impedido o robo de comprar
// qualquer coisa, para sempre, sem nunca dar erro.
//
// A primeira versao contava como "posicao aberta" toda moeda da carteira que
// valesse mais de 5 USDT. Numa carteira normal — BTC, ETH e alguns alts — isso
// dava cinco, seis, sete "posicoes". Com teto de 3, o robo batia em
// POSICOES_CHEIAS no primeiro ciclo e ficava PARADO enquanto o mercado andava.
//
// Sao duas perguntas com respostas diferentes:
//
//   Quantas posicoes EU abri?   → so as minhas. O teto e sobre o risco que EU
//                                 estou tomando, nao sobre o que o Bruno
//                                 guarda ha meses e nao pretende vender.
//
//   Em que pares eu nao mexo?   → as minhas MAIS a carteira dele. Comprar uma
//                                 moeda que ele ja tem mistura o estoque: o
//                                 dia em que ele vender na mao, o meu stop
//                                 fica sem saldo para executar.
//
// E as minhas incluem as que ainda NAO preencheram. Sem isso uma entrada na
// fila e invisivel — a moeda nao chegou na carteira — e o ciclo seguinte
// compra o mesmo par outra vez, dobrando a posicao em silencio.
// ------------------------------------------------------------
function contarPosicoes({ minhas = [], carteira = [] } = {}) {
  const simbolo = (x) => String(x?.simbolo || x?.symbol || x || '').toUpperCase();
  const minhasAbertas = minhas.filter((p) => ['AGUARDANDO', 'ABERTA', 'ARMANDO', 'DESPROTEGIDA'].includes(p?.estado));
  return {
    posicoesAbertas: minhasAbertas.length,
    paresAbertos: [...new Set([...carteira.map(simbolo), ...minhasAbertas.map(simbolo)].filter(Boolean))],
    naCarteira: carteira.length,
  };
}

/**
 * As ordens abertas que sao DESTE trade, e nenhuma outra.
 *
 * Todas as pernas de uma posicao comecam com o mesmo `ordemId` — as originais
 * (`{id}e`, `{id}a`, `{id}s`) e as de cada trailing (`{id}t...`). E esse
 * prefixo que separa o que e do robo do que e do Bruno.
 *
 * A versao anterior do trailing cancelava com DELETE /openOrders passando so o
 * simbolo, o que apaga TODAS as ordens abertas daquele par — inclusive as que
 * o Bruno tivesse colocado na mao. O README prometia o contrario do que o
 * codigo fazia.
 */
function minhasOrdens(abertas = [], ordemId = '', lado = 'SELL') {
  if (!ordemId) return [];
  return abertas.filter((o) => String(o?.clientOrderId || '').startsWith(ordemId) && (!lado || o?.side === lado));
}

/**
 * As entradas que esperaram demais.
 *
 * A entrada e uma ordem limite GTC: sem prazo, ela espera para sempre. Ordem
 * parada nao e neutra — segura USDT que nao pode ser usado em outro setup,
 * ocupa uma vaga de posicao, e representa uma ideia que ja venceu. O sinal que
 * justificou aquele preco valia quinze minutos, nao tres dias.
 *
 * Preencher tarde e pior do que nao preencher: entra num setup que ja nao
 * existe, com um stop calculado para um mercado que ja mudou.
 */
function entradasVencidas(posicoes = [], minutos = 15, agoraMs = Date.now()) {
  const limite = Math.max(1, Number(minutos) || 15) * 60000;
  return posicoes.filter((p) => {
    if (p?.estado !== 'AGUARDANDO') return false;
    const nascida = new Date(p?.criada_em || p?.criadaEm || 0).getTime();
    return Number.isFinite(nascida) && nascida > 0 && agoraMs - nascida > limite;
  });
}

// ------------------------------------------------------------
// A ESCOLHA
//
// O scanner devolve dezenas de moedas. O robô compra UMA por ciclo — a
// melhor. Comprar várias de uma vez no mesmo sinal é como três apostas
// viram uma só, correlacionada, sem ninguém perceber.
// ------------------------------------------------------------
function escolherCandidato(candidatos = [], config = CONFIG_PADRAO, jaAberto = []) {
  const abertos = new Set(jaAberto.map((s) => String(s).toUpperCase()));
  const proibidos = new Set(config.paresProibidos.map((s) => s.toUpperCase()));
  const permitidos = new Set(config.paresPermitidos.map((s) => s.toUpperCase()));

  const elegiveis = candidatos.filter((x) => {
    const simbolo = String(x.symbol || '').toUpperCase();
    if (!x.elegivel) return false;                              // reprovou na peneira do Bruno
    if (!config.setupsAceitos.includes(x.setup)) return false;
    if (abertos.has(simbolo)) return false;                     // não dobra posição no mesmo par
    if (proibidos.has(simbolo)) return false;
    if (permitidos.size && !permitidos.has(simbolo)) return false;
    if (!(Number(x.price) > 0) || !(Number(x.atr15Pct) > 0)) return false;
    return true;
  });

  // Desempate por volume relativo: entre dois setups iguais, o que tem mais
  // gente dentro é o que tem mais chance de andar. Volume é a única
  // confirmação que não depende de opinião.
  elegiveis.sort((a, b) => (Number(b.volumeRatio15) || 0) - (Number(a.volumeRatio15) || 0));

  return elegiveis[0] || null;
}

// ------------------------------------------------------------
// OS PREÇOS DO TRADE
//
// O stop sai do ATR, não de um palpite em porcentagem: 1,5 ATR respeita a
// volatilidade REAL daquela moeda naquele momento. Stop fixo de 2% é apertado
// demais para uma e frouxo demais para outra — e ser cuspido do trade por
// causa disso é o erro mais frequente e mais evitável que existe.
// ------------------------------------------------------------
function precosDoTrade(candidato, config = CONFIG_PADRAO) {
  const entrada = Number(candidato.price);
  const atrPct = Number(candidato.atr15Pct);
  if (!(entrada > 0) || !(atrPct > 0)) return null;

  const distancia = entrada * (atrPct / 100) * config.stopEmAtr;
  const stop = entrada - distancia;
  const alvo = entrada + distancia * config.alvoEmR;

  if (!(stop > 0) || stop >= entrada) return null;

  return {
    entrada,
    stop,
    alvo,
    risco: distancia,
    razao: config.alvoEmR,
  };
}

// ------------------------------------------------------------
// O IDENTIFICADOR — a peça que evita comprar duas vezes
//
// Todo trade nasce com um nome próprio, e ele é DETERMINÍSTICO: mesmo par,
// mesmo minuto, mesmo nome.
//
// Por que isso importa mais do que parece: se o POST der timeout, você não
// sabe se a Binance recebeu ou não. Reenviar às cegas é como se compra duas
// vezes. Com o id determinístico, o reenvio esbarra em "Duplicate order sent"
// e é recusado pela própria corretora — e além disso dá para PERGUNTAR o que
// aconteceu, via GET /api/v3/order?origClientOrderId=...
//
// Timeout não é falha: é status desconhecido. Quem trata os dois igual duplica
// posição.
// ------------------------------------------------------------
function idDoTrade(simbolo, agoraMs = Date.now(), sufixo = '') {
  const par = String(simbolo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const balde = Math.floor(agoraMs / 60000); // um id por minuto
  const base = `bt${balde.toString(36)}${par}`;
  const nome = sufixo ? `${base}${sufixo}` : base;
  return nome.slice(0, 36); // limite da Binance
}

// ------------------------------------------------------------
// A ORDEM COMPLETA, pronta para a corretora
//
// Um único POST leva os três: entrada, alvo e stop.
//
//   working  = a entrada (LIMIT de compra)
//   above    = o ALVO   (preço acima  → LIMIT_MAKER de venda)
//   below    = o STOP   (preço abaixo → STOP_LOSS_LIMIT de venda)
//
// O stop limite sai um pouco abaixo do gatilho. Se saísse no mesmo preço, num
// tranco o livro passa por cima e a ordem não executa — o stop vira enfeite
// justo no dia em que ele era necessário.
// ------------------------------------------------------------
function paramsOTOCO({ simbolo, quantidade, entrada, stop, alvo, id, limiteDoStop, folgaStopPct = 0.3 }) {
  const q = String(quantidade);
  // O spot-engine já entrega o stopLimit no tick certo. Só calcula aqui quando
  // ele não veio — e mesmo assim com a mesma folga, para não haver dois
  // comportamentos diferentes dependendo de quem chamou.
  const limite = Number(limiteDoStop) > 0 ? Number(limiteDoStop) : stop * (1 - folgaStopPct / 100);
  return {
    symbol: String(simbolo).toUpperCase(),
    listClientOrderId: id,

    workingType: 'LIMIT',
    workingSide: 'BUY',
    workingPrice: String(entrada),
    workingQuantity: q,
    workingTimeInForce: 'GTC',
    workingClientOrderId: `${id}e`, // 'e' de entrada

    pendingSide: 'SELL',
    pendingQuantity: q,

    pendingAboveType: 'LIMIT_MAKER',
    pendingAbovePrice: String(alvo),
    pendingAboveClientOrderId: `${id}a`, // 'a' de alvo

    pendingBelowType: 'STOP_LOSS_LIMIT',
    pendingBelowStopPrice: String(stop),
    pendingBelowPrice: String(limite),
    pendingBelowTimeInForce: 'GTC',
    pendingBelowClientOrderId: `${id}s`, // 's' de stop
  };
}

// ------------------------------------------------------------
// A DECISÃO INTEIRA
//
// Uma função, entrada de números, saída de decisão. É esta que o server chama
// a cada ciclo, e é esta que os testes cobrem — porque o que gasta dinheiro
// precisa poder ser conferido sem gastar dinheiro.
//
// Ela SEMPRE devolve um motivo, inclusive quando não faz nada. "O robô não
// operou hoje" sem explicação é indistinguível de "o robô está quebrado".
// ------------------------------------------------------------
function decidir({ candidatos = [], estado = {}, config = {}, plano = null, agoraMs = Date.now() }) {
  const cfg = normalizarConfig(config);
  const risco = travasDeRisco(estado, cfg);

  if (!risco.liberado) {
    return {
      acao: 'PARADO',
      motivo: risco.travas[0].trava,
      texto: risco.travas[0].texto,
      travas: risco.travas,
      config: cfg,
      em: agoraMs,
    };
  }

  const escolhido = escolherCandidato(candidatos, cfg, estado.paresAbertos || []);
  if (!escolhido) {
    return {
      acao: 'ESPERAR',
      motivo: 'SEM_SETUP',
      texto: `Nenhum dos ${candidatos.length} pares passou na peneira agora. Não entrar também é operar — a maioria dos prejuízos nasce de trade que não precisava existir.`,
      travas: [],
      config: cfg,
      em: agoraMs,
    };
  }

  const precos = precosDoTrade(escolhido, cfg);
  if (!precos) {
    return {
      acao: 'ESPERAR',
      motivo: 'PRECOS_INVALIDOS',
      texto: `${escolhido.symbol} apareceu no scanner mas os números não fecham (ATR ou preço zerado). Não dá para dimensionar risco às cegas.`,
      travas: [],
      config: cfg,
      em: agoraMs,
    };
  }

  // O plano vem do spot-engine, que já arredondou pelo tickSize e pelo
  // stepSize, já cobrou as taxas dentro do risco e já conferiu o MIN_NOTIONAL.
  // Se ele diz que não fecha, a Binance recusaria a ordem de qualquer jeito —
  // e é muito melhor descobrir aqui do que numa mensagem de erro dela.
  if (!plano || !(Number(plano.quantity) > 0) || plano.allowed === false) {
    const porque = plano?.blockers?.length
      ? plano.blockers.join(' ')
      : 'Não sobrou quantidade depois do arredondamento.';
    return {
      acao: 'ESPERAR',
      motivo: 'PLANO_NAO_FECHA',
      texto: `${escolhido.symbol}: ${porque}`,
      candidato: escolhido,
      precos,
      plano,
      config: cfg,
      em: agoraMs,
    };
  }

  const notional = Number(plano.notional) || Number(plano.quantity) * precos.entrada;
  if (notional > cfg.notionalMaximo) {
    return {
      acao: 'ESPERAR',
      motivo: 'ACIMA_DO_TETO',
      texto: `A ordem daria ${notional.toFixed(2)} USDT e o teto é ${cfg.notionalMaximo.toFixed(2)}. O teto vence o cálculo, sempre.`,
      candidato: escolhido,
      precos,
      config: cfg,
      em: agoraMs,
    };
  }

  if (cfg.alvoEmR < R_MINIMO_ACEITAVEL) {
    return {
      acao: 'ESPERAR',
      motivo: 'RAZAO_RUIM',
      texto: `Alvo em ${cfg.alvoEmR}R arrisca quase o que ganha. Abaixo de ${R_MINIMO_ACEITAVEL}R só compensa acertando quase sempre — e ninguém acerta.`,
      config: cfg,
      em: agoraMs,
    };
  }

  // Os preços que VÃO para a corretora saem todos do plano, já no tick certo.
  // A entrada arredonda para BAIXO de propósito: numa compra, arredondar para
  // cima é pagar mais caro do que o cálculo de risco previu.
  const tick = Number(plano.filters?.tickSize) || 1e-8;
  const entrada = roundStep(precos.entrada, tick, 'down');
  const id = idDoTrade(escolhido.symbol, agoraMs);

  return {
    acao: 'COMPRAR',
    motivo: escolhido.setup,
    texto: `${escolhido.symbol}: ${escolhido.reason}. Entra em ${entrada}, stop ${plano.oco.stopPrice}, alvo ${plano.oco.takeProfit}. ` +
           `Arrisca ${plano.lossNet.toFixed(2)} USDT para ganhar ${plano.gainNet.toFixed(2)} — ${plano.riskRewardNet.toFixed(2)} para 1, já com as taxas.`,
    simbolo: String(escolhido.symbol).toUpperCase(),
    candidato: escolhido,
    precos,
    plano,
    quantidade: Number(plano.quantity),
    notional,
    riscoUsdt: plano.lossNet,
    ganhoUsdt: plano.gainNet,
    id,
    ordem: paramsOTOCO({
      simbolo: escolhido.symbol,
      quantidade: plano.quantity,
      entrada,
      stop: plano.oco.stopPrice,
      alvo: plano.oco.takeProfit,
      limiteDoStop: plano.oco.stopLimit,
      id,
    }),
    config: cfg,
    em: agoraMs,
  };
}

module.exports = {
  CONFIG_PADRAO,
  R_MINIMO_ACEITAVEL,
  normalizarConfig,
  travasDeRisco,
  contarPosicoes,
  minhasOrdens,
  entradasVencidas,
  escolherCandidato,
  precosDoTrade,
  idDoTrade,
  paramsOTOCO,
  decidir,
};
