# O prompt do robô

Este é o pedido, escrito do jeito que funciona. Cole em qualquer sessão nova
de Claude Code aberta na pasta do BaladaTrade quando quiser mexer no robô.

---

## Prompt para evoluir o robô

```
Você está no BaladaTrade, meu sistema de trade. Leia antes de mexer:

  robo.js               a decisão (função pura, sem rede)
  server.js             o ciclo que executa, seção "O CICLO DO ROBÔ"
  spot-engine.js        dimensionamento com tickSize, stepSize e MIN_NOTIONAL
  guardiao-do-lucro.js  onde o stop deve estar, em múltiplos de R
  test/robo.test.js     o que já está garantido

REGRAS QUE NÃO SE DISCUTEM:

1. Toda lógica de decisão fica em robo.js como função pura. Se precisa de
   rede, banco ou relógio para ser testada, está no arquivo errado.
2. Nada de stop guardado na memória do processo. Stop e alvo vão para dentro
   da Binance via OTOCO (POST /api/v3/orderList/otoco). Se o robô cair, a
   proteção continua de pé.
3. Grave a intenção no banco ANTES de enviar a ordem. O índice único em
   ordem_id é o que impede ordem duplicada — e ele tem de ser consultado
   antes da rede, nunca depois.
4. Timeout não é falha, é status desconhecido. Antes de concluir qualquer
   coisa, consulte GET /api/v3/order?origClientOrderId=... A ordem pode ter
   entrado mesmo com a resposta perdida.
5. Preço e quantidade arredondam por tickSize e stepSize, nunca por casas
   decimais fixas. Use as funções do spot-engine, não escreva outras.
6. Somente Spot comprado. Sem alavancagem, sem margem, sem futuros, sem short.
7. Toda decisão devolve um texto explicando o motivo — inclusive as de NÃO
   operar. Robô silencioso é indistinguível de robô quebrado.
8. Modo novo nasce em SIMULACAO. Trava nova nasce ligada.
9. Escreva o teste junto. O que gasta dinheiro precisa ser conferido sem
   gastar dinheiro.
10. Comentário explica POR QUÊ, não o quê. Siga o tom dos arquivos que já
    existem.

O QUE EU QUERO AGORA:

<escreva aqui>
```

---

## O pedido original, 07/09/2026

> "quero tudo mais automático possível, a gente perdeu movimento muito bom nas
> criptomoedas mesmo com todo sistema"

O diagnóstico foi esse: o sistema **avisava** mas não **agia**. Scanner,
peneira, dimensionamento e guardião já existiam — todos dependiam de um humano
acordado na frente da tela para virar ordem. O movimento passou enquanto
ninguém clicava.

O robô é a peça que faltava, e é só isso: quem aperta o botão.

---

## Próximos pedidos que fazem sentido

Em ordem de quanto cada um resolve:

1. **Trailing pelo guardião.** Hoje o OTOCO sai com stop fixo. O
   `guardiao-do-lucro.js` já sabe calcular onde o stop deveria estar em cada
   múltiplo de R — falta o robô cancelar o OCO e recolocar mais alto quando o
   trade passa de 1R. É o que separa quem fica com o lucro de quem devolve.

2. **WebSocket no lugar do polling.** O ciclo consulta preço por REST a cada
   60s. Com `user data stream` o robô sabe do preenchimento no instante em que
   acontece, gasta menos peso de rate limit e não decide com preço velho.

3. **Reconciliação no boot.** Ao subir, comparar `GET /api/v3/openOrders` e
   `/api/v3/myTrades` com o que está no banco. Hoje o robô confia no banco;
   se alguém cancelar uma ordem pelo app da Binance, ele não fica sabendo.

4. **Backoff de rate limit.** Ler `X-MBX-USED-WEIGHT` e respeitar
   `Retry-After` no 429. Sem isso, um dia ruim vira ban de 418 — que começa em
   2 minutos e chega a 3 dias.

5. **Resultado real por trade.** Fechar o ciclo: quando o OCO executa, gravar
   se saiu no stop ou no alvo e quanto foi o resultado líquido. Sem isso o
   `perdaMaximaDiaUsdt` nunca tem um número de verdade para comparar.

O item 5 é pré-requisito honesto do item 1: sem saber o resultado dos trades,
nenhuma trava de perda diária funciona de fato.
