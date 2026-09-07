// ============================================================
// LIMITES DA BINANCE — 07/09/2026
//
// A Binance não avisa duas vezes. Ela responde 429 quando você passou do peso
// permitido e, se você insistir depois do 429, responde 418 — que é banimento
// de IP e começa em cerca de 2 minutos, escalando até 3 dias.
//
// Um robô que roda sozinho é exatamente o tipo de programa que leva 418:
// ninguém está olhando quando ele começa a insistir.
//
// O QUE ESTE ARQUIVO FAZ, E É UMA COISA SÓ:
//
//   Lê o que a própria Binance já diz em toda resposta — quanto peso você já
//   gastou no minuto — e para ANTES de levar o 429. Depois de um 429, respeita
//   o Retry-After em vez de tentar de novo na hora.
//
// Cada resposta REST traz o cabeçalho `x-mbx-used-weight-1m`. Ele é a verdade
// contada pela corretora, e é melhor do que qualquer contagem que a gente
// fizesse do lado de cá: o peso de cada rota muda, e o limite é por IP — o que
// significa que outras partes do sistema gastam do mesmo bolso.
//
// O relógio entra por parâmetro para dar para testar sem esperar de verdade.
// ============================================================

'use strict';

// O teto documentado é 6.000 por minuto. Parar em 70% deixa folga para o
// resto do BaladaTrade (radar, gráficos, painel) usar o mesmo IP sem que um
// derrube o outro. Encostar no teto e torcer é o mesmo que não ter limite.
const TETO_PADRAO = 6000;
const FOLGA = 0.7;

// Sem Retry-After no cabeçalho, estes são os padrões. O do 418 é maior de
// propósito: banimento não se resolve tentando mais cedo.
const ESPERA_429 = 60;
const ESPERA_418 = 300;

function criarLimites({ teto = TETO_PADRAO, folga = FOLGA } = {}) {
  let pesoUsado = 0;
  let pausadoAte = 0;
  let motivoDaPausa = '';
  let ultimaLeitura = 0;
  let banimentos = 0;

  /** Lê o que a resposta da Binance disse sobre o consumo.
   *  `headers` aceita tanto um Headers do fetch quanto um objeto simples. */
  function registrar(status, headers, agora = Date.now()) {
    const ler = (nome) => {
      if (!headers) return null;
      const valor = typeof headers.get === 'function' ? headers.get(nome) : headers[nome];
      return valor === undefined || valor === null ? null : String(valor);
    };

    const peso = Number(ler('x-mbx-used-weight-1m') ?? ler('x-mbx-used-weight'));
    if (Number.isFinite(peso) && peso >= 0) { pesoUsado = peso; ultimaLeitura = agora; }

    if (status === 429 || status === 418) {
      const retry = Number(ler('retry-after'));
      const segundos = Number.isFinite(retry) && retry > 0
        ? retry
        : (status === 418 ? ESPERA_418 : ESPERA_429);
      // Um segundo a mais do que ela pediu. Voltar no limite exato é a forma
      // mais fácil de transformar um 429 em 418.
      pausadoAte = agora + (segundos + 1) * 1000;
      motivoDaPausa = status === 418
        ? `A Binance baniu o IP por ${segundos}s. Insistir agora aumenta o banimento.`
        : `Passou do limite de peso. A Binance pediu ${segundos}s de espera.`;
      if (status === 418) banimentos += 1;
      return { pausado: true, ateMs: pausadoAte, motivo: motivoDaPausa };
    }

    return { pausado: pausadoAte > agora, ateMs: pausadoAte, motivo: motivoDaPausa };
  }

  /** Já dá para mandar a próxima requisição? Duas razões para não: castigo
   *  ativo depois de um 429, ou peso perto demais do teto. */
  function podeChamar(agora = Date.now()) {
    if (pausadoAte > agora) {
      return { pode: false, motivo: motivoDaPausa, esperaMs: pausadoAte - agora, tipo: 'CASTIGO' };
    }
    // A leitura de peso só vale dentro do minuto dela. Peso velho não segura
    // nada, e tratar peso velho como atual faz o robô parar sem motivo.
    const recente = agora - ultimaLeitura < 60000;
    if (recente && pesoUsado >= teto * folga) {
      return {
        pode: false,
        motivo: `Peso em ${pesoUsado} de ${teto} no minuto. Parando em ${Math.round(folga * 100)}% para não levar 429.`,
        esperaMs: 60000 - (agora - ultimaLeitura),
        tipo: 'PESO',
      };
    }
    return { pode: true, motivo: '', esperaMs: 0, tipo: 'LIVRE' };
  }

  /** Pausa manual — usada quando o erro vem por outro caminho (timeout de
   *  rede repetido, por exemplo) e insistir não vai ajudar. */
  function pausar(segundos, motivo, agora = Date.now()) {
    pausadoAte = Math.max(pausadoAte, agora + Math.max(1, Number(segundos) || 1) * 1000);
    motivoDaPausa = motivo || 'Pausa manual.';
    return pausadoAte;
  }

  function estado(agora = Date.now()) {
    return {
      pesoUsado,
      teto,
      pesoPct: teto ? Math.round((pesoUsado / teto) * 100) : 0,
      pausado: pausadoAte > agora,
      pausadoAte: pausadoAte || null,
      esperaMs: Math.max(0, pausadoAte - agora),
      motivo: pausadoAte > agora ? motivoDaPausa : '',
      banimentos,
      leituraHaMs: ultimaLeitura ? agora - ultimaLeitura : null,
    };
  }

  return { registrar, podeChamar, pausar, estado };
}

module.exports = { criarLimites, TETO_PADRAO, FOLGA, ESPERA_429, ESPERA_418 };
