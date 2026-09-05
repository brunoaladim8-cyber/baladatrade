// ============================================================
// CALCULADORA DE ORDEM — 05/09/2026
//
// Pedido do Bruno: "quando der o comando na Binance pra comprar 10x, quero
// que apareça o valor, o lucro e o da compra — porque a Binance é muito
// complicada e sempre perco um pouco."
//
// O "sempre perco um pouco" quase nunca é o mercado. Com alavancagem, são
// três coisas somadas, e todas invisíveis na hora de clicar:
//
//  1. TAXA. Na Binance Futures, taker é 0,05% do tamanho da POSIÇÃO, não da
//     margem. Com 10x, entrar e sair custa 1% do seu dinheiro — antes de o
//     preço andar um centavo. Em 20x, 2%.
//  2. LIQUIDAÇÃO. Com 10x ela mora a ~10% do preço de entrada. Se o stop
//     estiver mais longe que isso, a corretora fecha antes do seu stop e você
//     perde a margem inteira, não o que planejou.
//  3. TAMANHO. A tela mostra a margem, mas quem se move é a posição. Trocar
//     um pelo outro é como se arrisca 10x mais do que se pretendia.
//
// Tudo aqui é função pura. Nenhuma consulta à corretora — são as contas que
// a tela dela não mostra junto.
// ============================================================

/** Taxas padrão da Binance Futures USDT-M, em %.
 *  Taker é quem entra a mercado — que é o que se faz com pressa, e é o caso
 *  do Bruno. Maker só vale para ordem limite que espera na fila. */
const TAXA = { TAKER: 0.05, MAKER: 0.02 };

/** Margem de manutenção da primeira faixa (até 50k USDT) nos pares grandes.
 *  Ela empurra a liquidação um pouco para MAIS PERTO do que a conta simples
 *  de 1/alavancagem sugere — e é justamente essa diferença que surpreende. */
const MANUTENCAO_PCT = 0.4;

/**
 * O TAMANHO REAL DA POSIÇÃO.
 *
 * A margem é o que sai da sua conta; a posição é o que se move no mercado.
 * Confundir os dois é o erro mais caro que existe em alavancagem.
 */
function tamanhoDaPosicao({ margem, alavancagem, precoEntrada }) {
  const m = Number(margem), a = Number(alavancagem), p = Number(precoEntrada);
  if (!(m > 0) || !(a >= 1) || !(p > 0)) return null;
  const notional = m * a;
  return { margem: m, alavancagem: a, notional, quantidade: notional / p, precoEntrada: p };
}

/**
 * ONDE A CORRETORA FECHA À FORÇA.
 *
 * Aproximação para margem ISOLADA. Não é o número exato da Binance (que varia
 * por faixa de notional e por par), e por isso a tela diz "aproximado" — mas
 * erra para o lado seguro: mostra a liquidação um pouco mais PERTO do que
 * costuma ser. Errar para perto assusta; errar para longe quebra.
 */
function precoDeLiquidacao({ precoEntrada, alavancagem, direcao = 'LONG', manutencaoPct = MANUTENCAO_PCT }) {
  const p = Number(precoEntrada), a = Number(alavancagem);
  if (!(p > 0) || !(a >= 1)) return null;
  const distancia = (1 / a) - (manutencaoPct / 100);
  if (distancia <= 0) return direcao === 'LONG' ? p : p; // alavancagem absurda
  return direcao === 'LONG' ? p * (1 - distancia) : p * (1 + distancia);
}

/** O custo de entrar e sair, em USDT. Incide sobre a POSIÇÃO, não a margem —
 *  é por isso que ele cresce junto com a alavancagem. */
function custoDasTaxas({ notional, taxaPct = TAXA.TAKER, ladosCobrados = 2 }) {
  return (Number(notional) || 0) * (Number(taxaPct) / 100) * ladosCobrados;
}

/** Quanto o preço precisa andar, em %, só para pagar as taxas.
 *  É o buraco de onde o trade sai antes de começar a ganhar. */
function empateEmPct({ taxaPct = TAXA.TAKER, ladosCobrados = 2 }) {
  return taxaPct * ladosCobrados;
}

function precoDeEmpate({ precoEntrada, direcao = 'LONG', taxaPct = TAXA.TAKER }) {
  const p = Number(precoEntrada);
  const pct = empateEmPct({ taxaPct }) / 100;
  return direcao === 'LONG' ? p * (1 + pct) : p * (1 - pct);
}

/** Resultado LÍQUIDO num preço de saída — já com as duas taxas descontadas.
 *  Bruto é ilusão: o que entra na conta é isto. */
function resultadoEm({ precoEntrada, precoSaida, quantidade, direcao = 'LONG', notional, taxaPct = TAXA.TAKER }) {
  const bruto = (direcao === 'LONG' ? precoSaida - precoEntrada : precoEntrada - precoSaida) * quantidade;
  const taxas = custoDasTaxas({ notional, taxaPct });
  return { bruto, taxas, liquido: bruto - taxas };
}

/**
 * A ORDEM INTEIRA, antes de clicar.
 *
 * Devolve os números E os avisos. O aviso é a parte que evita o prejuízo:
 * número sozinho o operador interpreta como quer, ainda mais com pressa.
 */
function simularOrdem({
  margem, alavancagem, precoEntrada, stop, alvo,
  direcao = 'LONG', taxaPct = TAXA.TAKER,
}) {
  const pos = tamanhoDaPosicao({ margem, alavancagem, precoEntrada });
  if (!pos) return { ok: false, motivo: 'DADOS_INVALIDOS', mensagem: 'Preencha margem, alavancagem e preço de entrada.' };

  const liq = precoDeLiquidacao({ precoEntrada, alavancagem, direcao });
  const taxas = custoDasTaxas({ notional: pos.notional, taxaPct });
  const empate = precoDeEmpate({ precoEntrada, direcao, taxaPct });

  const noStop = stop > 0
    ? resultadoEm({ precoEntrada, precoSaida: Number(stop), quantidade: pos.quantidade, direcao, notional: pos.notional, taxaPct })
    : null;
  const noAlvo = alvo > 0
    ? resultadoEm({ precoEntrada, precoSaida: Number(alvo), quantidade: pos.quantidade, direcao, notional: pos.notional, taxaPct })
    : null;

  const avisos = [];

  // O AVISO MAIS IMPORTANTE DA TELA INTEIRA.
  // Stop além da liquidação significa que a corretora fecha antes de você, e
  // aí não se perde o planejado: perde-se a margem toda.
  if (stop > 0 && liq) {
    const stopAlemDaLiquidacao = direcao === 'LONG' ? Number(stop) <= liq : Number(stop) >= liq;
    if (stopAlemDaLiquidacao) {
      avisos.push({
        nivel: 'GRAVE',
        titulo: 'Você é liquidado ANTES do seu stop',
        texto: `A corretora fecha em ${liq.toFixed(2)}, e o seu stop está em ${Number(stop).toFixed(2)}. ` +
               `Nessa ordem você não perde o que planejou — perde a margem inteira (${pos.margem.toFixed(2)} USDT). ` +
               'Reduza a alavancagem ou aproxime o stop.',
      });
    }
  }

  // Perder mais de 5% da margem num trade é o caminho conhecido para a conta
  // não sobreviver a uma sequência ruim.
  if (noStop && Math.abs(noStop.liquido) > pos.margem * 0.5) {
    avisos.push({
      nivel: 'ALTO',
      titulo: `O stop custa ${Math.abs(noStop.liquido).toFixed(2)} USDT`,
      texto: `Isso é ${((Math.abs(noStop.liquido) / pos.margem) * 100).toFixed(0)}% da margem desta ordem. ` +
             'Com alavancagem, um stop desse tamanho não aguenta três erros seguidos.',
    });
  }

  // O buraco das taxas, dito em preço e não em porcentagem.
  avisos.push({
    nivel: 'INFO',
    titulo: `As taxas custam ${taxas.toFixed(2)} USDT`,
    texto: `Entrar e sair já consome ${((taxas / pos.margem) * 100).toFixed(2)}% da sua margem. ` +
           `O trade só passa a ganhar acima de ${empate.toFixed(2)} — abaixo disso, mesmo no verde, você está pagando para operar.`,
  });

  if (noStop && noAlvo && noStop.liquido < 0) {
    const razao = noAlvo.liquido / Math.abs(noStop.liquido);
    avisos.push({
      nivel: razao >= 2 ? 'BOM' : razao >= 1 ? 'INFO' : 'ALTO',
      titulo: `Ganha ${razao.toFixed(2)} para cada 1 que arrisca`,
      texto: razao >= 2
        ? 'Proporção boa: dá para errar mais vezes do que acerta e ainda terminar no positivo.'
        : razao >= 1
          ? 'Proporção apertada: precisa acertar mais da metade das vezes só para empatar.'
          : 'Você arrisca mais do que pode ganhar. Só compensa se acertar quase sempre — e ninguém acerta.',
      razao,
    });
  }

  const distLiq = liq ? Math.abs((liq / precoEntrada - 1) * 100) : null;

  return {
    ok: true,
    // O QUE VOCÊ ESTÁ COMPRANDO
    margem: pos.margem,
    alavancagem: pos.alavancagem,
    valorDaCompra: pos.notional,
    quantidade: pos.quantidade,
    precoEntrada: pos.precoEntrada,

    // O QUE PODE ACONTECER
    lucroNoAlvo: noAlvo ? noAlvo.liquido : null,
    lucroNoAlvoBruto: noAlvo ? noAlvo.bruto : null,
    perdaNoStop: noStop ? noStop.liquido : null,
    taxas,
    precoDeEmpate: empate,

    // O QUE A BINANCE NÃO MOSTRA JUNTO
    precoDeLiquidacao: liq,
    distanciaAteLiquidacaoPct: distLiq,

    avisos,
  };
}

/**
 * O CAMINHO INVERSO, e é o que deveria ser o padrão.
 *
 * Em vez de "tenho 100 USDT, quanto compro?", pergunta "quanto posso perder?"
 * — e a alavancagem sai como consequência, não como escolha. É assim que se
 * opera alavancado sem quebrar: o risco manda no tamanho, nunca o contrário.
 */
function margemParaRisco({ perdaMaximaUsdt, precoEntrada, stop, direcao = 'LONG', alavancagem = 10, taxaPct = TAXA.TAKER }) {
  const p = Number(precoEntrada), s = Number(stop), perda = Number(perdaMaximaUsdt);
  if (!(p > 0) || !(s > 0) || !(perda > 0)) return null;
  const distancia = direcao === 'LONG' ? p - s : s - p;
  if (!(distancia > 0)) return null;

  // As taxas entram na conta do risco: ignorá-las é arriscar mais do que se
  // pretendia, todas as vezes.
  const custoRelativo = (taxaPct / 100) * 2;
  const quantidade = perda / (distancia + p * custoRelativo);
  const notional = quantidade * p;

  return {
    quantidade,
    valorDaCompra: notional,
    margemNecessaria: notional / alavancagem,
    alavancagem,
    perdaEstimada: perda,
  };
}

module.exports = { TAXA, MANUTENCAO_PCT, tamanhoDaPosicao, precoDeLiquidacao, custoDasTaxas, empateEmPct, precoDeEmpate, resultadoEm, simularOrdem, margemParaRisco };
