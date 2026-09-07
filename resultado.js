// ============================================================
// O RESULTADO DE VERDADE — 07/09/2026
//
// O robô mandava a ordem e nunca mais olhava. Sem saber o que aconteceu com
// cada trade, três coisas ficavam de enfeite:
//
//   · a trava de perda do dia não tinha número para comparar;
//   · o guardião não sabia quando subir o stop, porque não sabia se a entrada
//     tinha sequer preenchido;
//   · e o histórico dizia o que ele TENTOU, nunca o que deu.
//
// Este arquivo lê as três pernas do OTOCO na Binance e conclui o que houve.
// É função pura: recebe o que a corretora respondeu e devolve o estado e o
// resultado. Nenhuma chamada de rede — o que decide se um trade deu certo
// precisa poder ser conferido sem pedir nada a ninguém.
//
// ------------------------------------------------------------
// O ESTADO QUE NINGUÉM ESPERA E É O MAIS PERIGOSO
// ------------------------------------------------------------
//
// DESPROTEGIDA: a entrada preencheu, mas o alvo e o stop não estão mais lá.
// Acontece quando alguém cancela o OCO pelo aplicativo da Binance, ou quando o
// robô cancelou para subir o stop e a recolocação falhou.
//
// A posição existe, o dinheiro está no mercado e não há nada segurando. É
// pior do que estar no prejuízo — no prejuízo o stop responde. Por isso ela é
// um estado com nome próprio, e não um "aberta" qualquer.
// ============================================================

'use strict';

// A Binance considera preenchido só o que já executou. PARTIALLY_FILLED conta
// como posição aberta: existe moeda comprada, ainda que menos do que se pediu.
const VIVOS = new Set(['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW']);
const MORTOS = new Set(['CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'PENDING_CANCEL']);

function n(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

/** Preço médio realmente pago ou recebido. Sai do quote acumulado dividido
 *  pela quantidade executada — nunca do preço que se PEDIU. O preço pedido é
 *  intenção; o executado é o que entrou na conta. */
function precoMedio(perna) {
  const qtd = n(perna?.executedQty);
  const quote = n(perna?.cummulativeQuoteQty);
  return qtd > 0 ? quote / qtd : 0;
}

function executou(perna) {
  return n(perna?.executedQty) > 0;
}

/**
 * As taxas, somadas com honestidade.
 *
 * A comissão da Binance pode vir em três moedas diferentes, e cada uma pede um
 * tratamento:
 *
 *   USDT        → é o próprio custo, entra direto.
 *   moeda base  → saiu da quantidade comprada; converte pelo preço do fill.
 *   BNB (ou outra) → não dá para converter sem uma cotação que não temos aqui.
 *
 * O terceiro caso NÃO é chutado. Ele é listado à parte e marcado como
 * incerto — um custo estimado por cima vira lucro que não existe, e é assim
 * que um sistema começa a mentir para o dono.
 */
function somarTaxas(fills = [], moedaCotacao = 'USDT') {
  let taxas = 0;
  const naoConvertidas = [];
  for (const fill of fills) {
    const valor = n(fill?.commission);
    if (valor <= 0) continue;
    const moeda = String(fill?.commissionAsset || '').toUpperCase();
    const preco = n(fill?.price);
    if (moeda === moedaCotacao) taxas += valor;
    else if (preco > 0 && moeda && moeda !== moedaCotacao && fill?.commissionEmBase) taxas += valor * preco;
    else naoConvertidas.push({ moeda, valor });
  }
  return { taxas, naoConvertidas, incerto: naoConvertidas.length > 0 };
}

/**
 * O QUE ACONTECEU COM O TRADE.
 *
 * `pernas` são as três ordens do OTOCO, do jeito que a Binance devolve em
 * GET /api/v3/order: { entrada, alvo, stop }. Qualquer uma pode vir nula
 * quando ainda não existe — as pendentes do OTOCO só nascem depois que a
 * entrada preenche.
 */
function lerPosicao({ entrada, alvo, stop, fillsEntrada = [], fillsSaida = [], moedaCotacao = 'USDT' } = {}) {
  const entrou = executou(entrada);
  const statusEntrada = String(entrada?.status || '').toUpperCase();

  // Ainda na fila: a entrada existe e não preencheu nada.
  if (!entrou && VIVOS.has(statusEntrada)) {
    return { estado: 'AGUARDANDO', saidaTipo: null, texto: 'A entrada está na fila e ainda não preencheu.' };
  }

  // Morreu sem comprar nada. Não é prejuízo — é um trade que não aconteceu.
  if (!entrou) {
    return {
      estado: 'CANCELADA',
      saidaTipo: null,
      texto: statusEntrada === 'EXPIRED'
        ? 'A entrada expirou sem preencher. Nenhum dinheiro entrou no mercado.'
        : 'A entrada foi cancelada antes de preencher. Nenhum dinheiro entrou no mercado.',
    };
  }

  const quantidade = n(entrada.executedQty);
  const custo = n(entrada.cummulativeQuoteQty);
  const precoEntrada = precoMedio(entrada);
  const taxaEntrada = somarTaxas(fillsEntrada, moedaCotacao);

  const alvoExecutou = executou(alvo);
  const stopExecutou = executou(stop);

  if (alvoExecutou || stopExecutou) {
    const saida = alvoExecutou ? alvo : stop;
    const tipo = alvoExecutou ? 'ALVO' : 'STOP';
    const recebido = n(saida.cummulativeQuoteQty);
    const precoSaida = precoMedio(saida);
    const taxaSaida = somarTaxas(fillsSaida, moedaCotacao);
    const taxas = taxaEntrada.taxas + taxaSaida.taxas;
    const bruto = recebido - custo;

    return {
      estado: 'FECHADA',
      saidaTipo: tipo,
      quantidade,
      precoEntrada,
      precoSaida,
      custo,
      recebido,
      taxas,
      taxasIncertas: taxaEntrada.incerto || taxaSaida.incerto,
      comissoesNaoConvertidas: [...taxaEntrada.naoConvertidas, ...taxaSaida.naoConvertidas],
      resultadoBruto: bruto,
      resultadoLiquido: bruto - taxas,
      texto: tipo === 'ALVO'
        ? `Fechou no alvo: ${(bruto - taxas).toFixed(2)} ${moedaCotacao} líquidos.`
        : `Fechou no stop: ${(bruto - taxas).toFixed(2)} ${moedaCotacao}. O stop fez o trabalho dele.`,
    };
  }

  // Comprou e as duas pernas de saída morreram sem executar. A posição existe
  // e está no mercado SEM NADA SEGURANDO.
  const alvoMorto = !alvo || MORTOS.has(String(alvo.status || '').toUpperCase());
  const stopMorto = !stop || MORTOS.has(String(stop.status || '').toUpperCase());
  if (alvoMorto && stopMorto) {
    return {
      estado: 'DESPROTEGIDA',
      saidaTipo: null,
      quantidade,
      precoEntrada,
      custo,
      taxas: taxaEntrada.taxas,
      texto: 'A entrada preencheu mas não há stop nem alvo ativos na Binance. A posição está no mercado sem nada segurando — isto exige ação agora.',
    };
  }

  return {
    estado: 'ABERTA',
    saidaTipo: null,
    quantidade,
    precoEntrada,
    custo,
    taxas: taxaEntrada.taxas,
    texto: 'Comprada, com stop e alvo ativos dentro da Binance.',
  };
}

/**
 * A PERDA DO DIA, que é o número que liga a trava mais importante.
 *
 * Conta só o que FECHOU: prejuízo aberto ainda pode virar lucro, e travar o
 * dia por causa de posição que ainda está andando é parar de operar no meio
 * de um trade que não terminou.
 */
function perdaDoDia(posicoesFechadas = []) {
  let perda = 0, ganho = 0, trades = 0;
  for (const p of posicoesFechadas) {
    const r = n(p?.resultadoLiquido ?? p?.resultado_usdt);
    trades += 1;
    if (r < 0) perda += Math.abs(r); else ganho += r;
  }
  return { perda, ganho, liquido: ganho - perda, trades };
}

module.exports = { lerPosicao, precoMedio, somarTaxas, perdaDoDia, VIVOS, MORTOS };
