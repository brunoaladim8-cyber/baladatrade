// ============================================================
// GUARDIÃO DO LUCRO — 05/09/2026
//
// O monitor já sabia o preço, o pico e quanto o movimento devolveu. O que ele
// nunca disse foi O QUE FAZER com isso. "Recuou 3,2% desde o melhor preço" é
// diagnóstico; o Bruno precisa de ordem: "sobe o stop para 79.100 agora".
//
// Pedido dele em 05/09: "quero pegar o movimento controlado, meu lucro; o
// monitor atrasa muito, preciso de alguma coisa me ajudando."
//
// A IDEIA CENTRAL, E É UMA SÓ:
//
//   Toda posição vencedora tem um ponto a partir do qual ela NÃO PODE MAIS
//   VIRAR PREJUÍZO. Passado esse ponto, o stop sobe e não desce nunca mais.
//
// É isso que separa quem fica com o lucro de quem devolve. Não é acertar a
// entrada — é não devolver a saída.
//
// TUDO AQUI É FUNÇÃO PURA: recebe números, devolve a ordem. Sem rede, sem
// banco, sem relógio. Dá para testar cada degrau da escada sozinho.
// ============================================================

/** Quanto o preço andou, medido em MÚLTIPLOS DO RISCO (R).
 *
 *  R é a distância entre a entrada e o stop inicial — o que se perde se der
 *  errado. Medir o lucro em R, e não em porcentagem, é o que permite comparar
 *  um trade de BTC com um de MNQ: 1R é sempre "ganhei o que arrisquei".
 *
 *  Sem stop não existe R, e sem R não existe gestão — por isso devolve null
 *  em vez de inventar um número. */
function multiploDeR({ entrada, stopInicial, preco, direcao = 'LONG' }) {
  const e = Number(entrada), s = Number(stopInicial), p = Number(preco);
  if (!(e > 0) || !(p > 0) || !(s > 0)) return null;
  const risco = direcao === 'LONG' ? e - s : s - e;
  if (!(risco > 0)) return null; // stop do lado errado da entrada
  const ganho = direcao === 'LONG' ? p - e : e - p;
  return { r: ganho / risco, riscoPorUnidade: risco };
}

/**
 * A ESCADA DE PROTEÇÃO.
 *
 * Cada degrau só existe porque o anterior já foi vencido — e nenhum deles
 * devolve o stop para trás. Os números não são arbitrários:
 *
 *  · 1R  → stop na ENTRADA. É o degrau mais importante da escada inteira.
 *          A partir daqui o trade não pode mais dar prejuízo, e é isso que
 *          permite segurar a posição sem medo.
 *  · 2R  → stop em +1R. Já garantiu o que arriscou.
 *  · 3R+ → trava metade do caminho andado. Solta o suficiente para o
 *          movimento respirar e não ser cuspido no primeiro repique.
 *
 * Abaixo de 1R o stop inicial NÃO se mexe. Subir stop cedo demais é a forma
 * mais comum de ser tirado de um trade que ia dar certo.
 */
const DEGRAUS = [
  { aPartirDeR: 3, travaEmR: null, metadeDoCaminho: true, nome: 'TRILHA' },
  { aPartirDeR: 2, travaEmR: 1, metadeDoCaminho: false, nome: 'GARANTE_1R' },
  { aPartirDeR: 1, travaEmR: 0, metadeDoCaminho: false, nome: 'ZERO_A_ZERO' },
];

/** O preço correspondente a um múltiplo de R. */
function precoEmR({ entrada, riscoPorUnidade, r, direcao = 'LONG' }) {
  return direcao === 'LONG'
    ? entrada + riscoPorUnidade * r
    : entrada - riscoPorUnidade * r;
}

/**
 * Onde o stop DEVE estar agora.
 *
 * Devolve também o degrau que mandou, para a tela poder dizer o porquê —
 * ordem sem motivo é ordem que o operador desobedece na primeira dúvida.
 */
function stopIdeal({ entrada, stopInicial, preco, pico, direcao = 'LONG' }) {
  const m = multiploDeR({ entrada, stopInicial, preco, direcao });
  if (!m) return null;

  const alto = Number(pico) > 0 ? Number(pico) : Number(preco);
  const rNoPico = multiploDeR({ entrada, stopInicial, preco: alto, direcao })?.r ?? m.r;

  for (const degrau of DEGRAUS) {
    // A escada sobe pelo PICO, não pelo preço atual. Se o trade já valeu 3R e
    // recuou para 2R, a proteção conquistada não se perde — foi ganha.
    if (rNoPico < degrau.aPartirDeR) continue;

    const rTravado = degrau.metadeDoCaminho ? rNoPico / 2 : degrau.travaEmR;
    return {
      degrau: degrau.nome,
      rAtual: m.r,
      rNoPico,
      rTravado,
      preco: precoEmR({ entrada, riscoPorUnidade: m.riscoPorUnidade, r: rTravado, direcao }),
      riscoPorUnidade: m.riscoPorUnidade,
    };
  }

  return {
    degrau: 'INICIAL',
    rAtual: m.r,
    rNoPico,
    rTravado: -1,
    preco: Number(stopInicial),
    riscoPorUnidade: m.riscoPorUnidade,
  };
}

/** Quanto do movimento já foi devolvido desde o melhor preço, em %. */
function devolucao({ preco, pico, direcao = 'LONG' }) {
  const p = Number(preco), a = Number(pico);
  if (!(p > 0) || !(a > 0)) return 0;
  return direcao === 'LONG'
    ? Math.max(0, (a / p - 1) * 100)
    : Math.max(0, (p / a - 1) * 100);
}

/** A partir daqui a devolução deixa de ser respiro e vira sinal.
 *  Um terço do movimento é o ponto em que a maioria das pernas que continuam
 *  já retomou — passar disso é mais comum em movimento que acabou. */
const DEVOLUCAO_QUE_PREOCUPA = 33;

/**
 * A ORDEM. É o que a tela mostra em letra grande.
 *
 * Sempre com PREÇO EXATO e MOTIVO. "Cuidado com a posição" não é ordem —
 * é o operador que tem de decidir sozinho, no calor, e é aí que se erra.
 */
function ordemDoGuardiao({
  simbolo, entrada, stopInicial, stopAtual, preco, pico,
  direcao = 'LONG', quantidade = 0, multiplicador = 1, moeda = 'USDT',
}) {
  const semStop = !(Number(stopInicial) > 0);
  if (semStop) {
    // Sem stop não há gestão possível. Este é o único caso em que o guardião
    // recusa a calcular: fingir que dá para proteger o que não tem risco
    // definido seria dar falsa segurança.
    return {
      simbolo, acao: 'DEFINIR_STOP', urgencia: 'ALTA',
      titulo: 'Esta posição não tem stop',
      texto: 'Sem stop não dá para saber quanto você arrisca, e sem isso nada aqui consegue proteger o seu lucro. Defina o stop antes de qualquer outra coisa.',
      preco: null,
    };
  }

  const ideal = stopIdeal({ entrada, stopInicial, preco, pico, direcao });
  if (!ideal) {
    return {
      simbolo, acao: 'REVISAR', urgencia: 'ALTA',
      titulo: 'Os números desta posição não fecham',
      texto: 'O stop está do lado errado da entrada, ou algum valor veio zerado. Confira entrada, stop e direção.',
      preco: null,
    };
  }

  const dev = devolucao({ preco, pico, direcao });
  const lucro = (direcao === 'LONG' ? preco - entrada : entrada - preco) * quantidade * multiplicador;

  // O stop atual já está onde deveria? Comparar com folga de 0,05% evita
  // ficar mandando ajustar por diferença de arredondamento.
  const atual = Number(stopAtual) > 0 ? Number(stopAtual) : Number(stopInicial);
  const jaProtegido = direcao === 'LONG'
    ? atual >= ideal.preco * 0.9995
    : atual <= ideal.preco * 1.0005;

  const casas = ideal.preco >= 1000 ? 0 : ideal.preco >= 1 ? 2 : 6;
  const alvo = ideal.preco.toFixed(casas);

  if (!jaProtegido && ideal.degrau !== 'INICIAL') {
    const porQue = {
      ZERO_A_ZERO: 'O trade já valeu o que você arriscou. A partir daqui ele não pode mais virar prejuízo.',
      GARANTE_1R: 'Já andou o dobro do risco. Garanta o que arriscou e deixe o resto correr.',
      TRILHA: 'Trave metade do caminho andado — solto o bastante para o movimento respirar, apertado o bastante para não devolver tudo.',
    }[ideal.degrau];

    return {
      simbolo, acao: 'SUBIR_STOP',
      urgencia: dev >= DEVOLUCAO_QUE_PREOCUPA ? 'ALTA' : 'MEDIA',
      titulo: `Suba o stop para ${alvo}`,
      texto: porQue,
      preco: Number(alvo),
      rAtual: ideal.rAtual, rNoPico: ideal.rNoPico,
      lucroAtual: lucro, moeda, devolucao: dev, degrau: ideal.degrau,
    };
  }

  if (dev >= DEVOLUCAO_QUE_PREOCUPA) {
    return {
      simbolo, acao: 'ATENCAO', urgencia: 'MEDIA',
      titulo: `Devolveu ${dev.toFixed(1)}% do movimento`,
      texto: `Seu stop já está protegido em ${alvo}, então o lucro não corre risco. Mas passar de um terço de devolução é mais comum em movimento que acabou do que em movimento que continua.`,
      preco: Number(alvo),
      rAtual: ideal.rAtual, rNoPico: ideal.rNoPico,
      lucroAtual: lucro, moeda, devolucao: dev, degrau: ideal.degrau,
    };
  }

  if (ideal.rAtual < 0) {
    return {
      simbolo, acao: 'SEGURAR', urgencia: 'BAIXA',
      titulo: 'Ainda contra você — o stop inicial responde',
      texto: `Não mexa. Foi para isso que o stop de ${atual.toFixed(casas)} foi colocado, e mexer em stop no vermelho é como um prejuízo pequeno vira grande.`,
      preco: atual, rAtual: ideal.rAtual, rNoPico: ideal.rNoPico,
      lucroAtual: lucro, moeda, devolucao: dev, degrau: ideal.degrau,
    };
  }

  return {
    simbolo, acao: 'SEGURAR', urgencia: 'BAIXA',
    titulo: ideal.degrau === 'INICIAL'
      ? `A caminho: ${ideal.rAtual.toFixed(2)}R`
      : `Protegido em ${alvo}`,
    texto: ideal.degrau === 'INICIAL'
      ? `Ainda não chegou em 1R. Subir o stop antes disso é a forma mais comum de ser tirado de um trade que ia dar certo.`
      : 'O stop já está no lugar certo. Deixe correr.',
    preco: Number(alvo),
    rAtual: ideal.rAtual, rNoPico: ideal.rNoPico,
    lucroAtual: lucro, moeda, devolucao: dev, degrau: ideal.degrau,
  };
}

/** As ordens de todas as posições, com o que exige ação no topo.
 *  Ordenar por urgência é o que faz o painel servir com dez posições abertas
 *  — sem isso, a que importa fica no fim da lista. */
function ordensDaMesa(posicoes = []) {
  const peso = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
  return posicoes
    .map((p) => ordemDoGuardiao(p))
    .sort((a, b) => (peso[a.urgencia] ?? 3) - (peso[b.urgencia] ?? 3)
      || (b.devolucao ?? 0) - (a.devolucao ?? 0));
}

/** Resumo do topo. `precisamDeAcao` é o único número que importa quando ele
 *  abre a tela com pressa. */
function resumoDoGuardiao(ordens = []) {
  return {
    total: ordens.length,
    precisamDeAcao: ordens.filter((o) => o.urgencia === 'ALTA' || o.acao === 'SUBIR_STOP').length,
    semStop: ordens.filter((o) => o.acao === 'DEFINIR_STOP').length,
    protegidas: ordens.filter((o) => o.degrau && o.degrau !== 'INICIAL' && o.acao !== 'SUBIR_STOP').length,
  };
}

module.exports = { multiploDeR, DEGRAUS, precoEmR, stopIdeal, devolucao, DEVOLUCAO_QUE_PREOCUPA, ordemDoGuardiao, ordensDaMesa, resumoDoGuardiao };
