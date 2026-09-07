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

## Feito em 07/09/2026

Os cinco itens que estavam nesta lista foram entregues:

1. **Resultado real por trade** — `resultado.js` lê as três pernas do OTOCO e
   conclui o desfecho, com taxas reais. É daqui que sai a trava de perda
   diária, que antes comparava com zero.
2. **Reconciliação no boot** — a corretora vira fonte da verdade; o banco se
   ajusta. Ordens órfãs são reportadas, nunca canceladas.
3. **Backoff de rate limit** — `limites.js` lê `x-mbx-used-weight-1m` e para em
   70% do teto; respeita `Retry-After` no 429 para não virar 418.
4. **Trailing pelo guardião** — o robô obedece o `guardiao-do-lucro.js` e sobe
   o stop sozinho. A janela descoberta entre cancelar e recolocar está
   documentada e mitigada, não escondida.
5. **WebSocket** — `user data stream` avisa no instante do preenchimento, com
   reconexão em espera crescente. O polling continua como rede de segurança.

Estado novo que nasceu disso e vale conhecer: **DESPROTEGIDA** — a entrada
preencheu e não há stop nem alvo ativos. Acontece se alguém cancelar o OCO pelo
aplicativo ou se um trailing falhar no meio. É o único estado que dispara
alerta crítico e recolocação automática.

## O que ainda falta

Em ordem de quanto cada um resolve:

1. **Saída por tempo.** Uma posição pode ficar semanas entre o stop e o alvo,
   segurando capital que renderia em outro lugar. Falta uma regra de "não
   andou em N horas, sai" — e ela precisa nascer do histórico, não de palpite.

2. **Curva de resultado do robô.** As posições fechadas já têm resultado
   líquido; falta o gráfico que mostra se ele ganha ou perde ao longo do tempo.
   É o único número que decide se o robô continua ligado.

3. **Peneira aprendida do próprio histórico.** Hoje os cortes da `peneira` são
   fixos (RSI 75, ATR 3%, volume 1x). Com resultado real gravado dá para
   descobrir quais deles realmente separam trade bom de ruim — e quais só
   estão atrapalhando.

4. **Short em margem.** Só faz sentido depois de o Spot mostrar resultado
   positivo por meses, e muda o risco por completo. Não é próximo passo.
