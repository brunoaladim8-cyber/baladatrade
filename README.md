# BaladaTrade

Central de trade com execução automática em Spot na Binance, gestão de risco,
diário e gamificação responsável. O sistema dá XP por planejar, respeitar
risco, documentar e revisar — nunca por operar mais.

## O robô

O BaladaTrade já sabia achar setup, filtrar o ruim, dimensionar a ordem e
dizer onde o stop deveria estar. Faltava alguém apertar o botão. É isso que o
robô faz, e nada além disso.

A cada ciclo ele:

1. confere se está ligado (no banco, não em memória);
2. lê a conta — saldo livre, posições abertas, ordens já enviadas hoje;
3. roda o `setupScanner` e aplica a `peneira`;
4. dimensiona pelo `spot-engine`, com taxa e `MIN_NOTIONAL` na conta;
5. passa pelas travas de risco;
6. **grava a intenção no banco**;
7. só então envia.

O passo 6 vir antes do 7 é o que impede a pior falha possível. O id da ordem
tem índice único no PostgreSQL: se dois ciclos se atropelarem, o segundo
`INSERT` falha e a segunda ordem nunca chega a existir.

### OTOCO: a proteção não depende do robô estar vivo

Entrada, stop e alvo saem juntos numa única chamada
(`POST /api/v3/orderList/otoco`). Quando a entrada preenche, a **própria
Binance** arma o stop e o alvo. A partir daí o robô pode cair, o Railway pode
reiniciar e a internet pode acabar — a proteção continua de pé no servidor da
corretora.

Robô que guarda o stop na própria memória morre no meio da posição e deixa o
dinheiro exposto. É assim que se perde uma conta dormindo.

### Depois da ordem: o ciclo se fecha

O robô não manda e esquece. A cada ciclo — e no instante do preenchimento,
quando o WebSocket está de pé — ele lê as três pernas do OTOCO na Binance e
conclui o que houve.

| Estado | O que significa |
|---|---|
| `AGUARDANDO` | A entrada está na fila e não preencheu |
| `ABERTA` | Comprada, com stop e alvo ativos na Binance |
| `DESPROTEGIDA` | **Comprada e sem nada segurando.** Alguém cancelou o OCO, ou um trailing falhou no meio. Alerta crítico e recolocação automática |
| `FECHADA` | Saiu no alvo ou no stop, com resultado líquido de taxas |
| `CANCELADA` | A entrada morreu sem preencher — não é prejuízo, é trade que não houve |

O resultado sai do quote realmente executado, não do preço pedido, e desconta
as comissões reais. Comissão paga em moeda que não dá para converter aqui
(BNB, por exemplo) é marcada como incerta em vez de estimada — custo chutado
por cima vira lucro que não existe.

É daqui que sai o número da trava de perda diária. Antes disso ela comparava
com zero e nunca disparava.

### Trailing: o guardião passa a mandar

O `guardiao-do-lucro.js` já sabia dizer "suba o stop para X". Era texto na tela
esperando alguém obedecer. Agora o robô obedece: passou de 1R, o stop vai para
a entrada; passou de 2R, trava 1R; de 3R em diante, trava metade do caminho
andado. O stop nunca desce.

**A janela descoberta, dita com todas as letras:** a Binance não tem
cancelar-e-recolocar atômico para lista OCO. Para subir o stop é preciso
cancelar o OCO e criar outro, e entre uma coisa e outra existem alguns segundos
sem proteção. Isso não dá para eliminar. Dá para reduzir, e é o que o código
faz: só mexe depois de 1R (então acontece poucas vezes), marca a posição como
`DESPROTEGIDA` durante a troca, e se a recolocação falhar dispara alerta
crítico e tenta de novo no ciclo seguinte.

A alternativa — nunca subir o stop — tem o custo conhecido de devolver o lucro
inteiro.

### Limite de peso da Binance

Toda resposta da Binance diz quanto peso você já gastou no minuto
(`x-mbx-used-weight-1m`). O robô lê esse número e **para em 70% do teto**,
antes de levar o 429. Depois de um 429 ele respeita o `Retry-After` em vez de
insistir — insistir é o que transforma 429 em 418, que é banimento de IP e vai
de 2 minutos a 3 dias.

O contador é um só para o processo inteiro, porque o limite é por IP: robô,
radar e gráficos gastam do mesmo bolso.

### WebSocket: saber na hora

O ciclo roda a cada 60 segundos, então o robô descobria o preenchimento até um
minuto depois — justo o minuto em que o preço mais anda. Com o `user data
stream` ele sabe no instante, e reconhece o evento como seu pelo
`clientOrderId` que ele mesmo deu.

**O polling não sai de cena.** WebSocket cai, `listenKey` expira, rede oscila.
O stream é o caminho rápido; o ciclo continua sendo a rede de segurança.
Requer Node 22+ (WebSocket global); sem ele o robô funciona igual, só descobre
o preenchimento no ciclo seguinte.

### Reconciliação no boot

Ao subir, a **corretora é a fonte da verdade** e o banco se ajusta a ela. Sem
isso o robô voltava acreditando numa realidade que podia ter mudado enquanto
ele estava fora: ordem cancelada pelo aplicativo, posição que fechou, ou um
trailing interrompido no meio.

Ordens abertas que ele não reconhece são **reportadas, nunca canceladas** —
podem ser suas, colocadas na mão. Robô que apaga ordem de gente é pior do que
robô que não sabe de nada.

### O que ele não faz

- Não opera alavancado, margem, futuros nem short.
- Não faz média em posição perdedora.
- Não aumenta posição para recuperar prejuízo.
- Não opera sem PostgreSQL fora do modo simulação.
- Não liga sozinho depois de um kill switch.

### Modos

| Modo | O que acontece |
|---|---|
| `SIMULACAO` | Decide, explica e registra. **Não envia nada.** Funciona até sem chave de API. |
| `TESTNET` | Envia de verdade, com dinheiro falso. |
| `REAL` | Dinheiro de verdade. Exige `ENABLE_LIVE_TRADING=true` **e** `ROBO_PERMITE_REAL=true` no servidor, mais o cabeçalho `x-confirm-live: CONFIRMAR-ROBO-REAL` para ligar. Sem isso ele cai sozinho para Testnet. |

### Travas de risco

Todas conferidas antes de escolher qualquer moeda:

- kill switch acionado;
- perda máxima do dia atingida;
- número máximo de posições abertas;
- número máximo de ordens por dia (o freio contra bug em loop);
- dados de mercado atrasados mais de 2 minutos;
- saldo insuficiente para respeitar o `MIN_NOTIONAL`;
- teto de notional por ordem, que entra no cálculo e não só no alarme.

### O botão vermelho

`POST /api/robo/panico` desliga o robô, trava o religamento e cancela todas as
ordens abertas na Binance. Só um humano solta depois, em
`POST /api/robo/soltar-panico`.

### Rotas

| Rota | O que faz |
|---|---|
| `GET /api/robo/estado` | Painel: ligado, modo, limites, última decisão |
| `GET /api/robo/historico` | Toda decisão, inclusive as de não operar |
| `POST /api/robo/ciclo` | Roda um ciclo agora (respeita todas as travas) |
| `POST /api/robo/config` | Salva os limites |
| `POST /api/robo/ligar` | Liga e agenda os ciclos |
| `POST /api/robo/desligar` | Desliga |
| `POST /api/robo/panico` | Para tudo e cancela ordens |
| `POST /api/robo/soltar-panico` | Solta o kill switch |
| `GET /api/robo/posicoes` | Posições, resultado do dia, peso e stream |
| `POST /api/robo/conferir` | Confere as posições na Binance agora |
| `POST /api/robo/reconciliar` | Reconciliação completa contra a corretora |

## Diagnóstico

A primeira tela abre com o diagnóstico: o que está funcionando, o que falta e
**como resolver cada coisa**. Tela vazia é indistinguível de tela quebrada, e a
diferença entre "falta configurar" e "está com defeito" é a única que importa
para quem vai consertar.

O que falta aparece em âmbar, não em vermelho — falta configurar não é defeito.

## Como testar tudo

```bash
npm test        # 115 testes: decisão, risco, resultado, limites e menu
npm run rotas   # bate em todas as rotas e classifica o que responde
```

O `npm run rotas` separa quatro coisas que costumam ser confundidas:

| | |
|---|---|
| ✅ **Funcionam** | respondem 200 sem depender de nada |
| 🔑 **Precisam de chave** | a rota está certa, falta `BINANCE_API_KEY` |
| 🗄 **Precisam de banco** | a rota está certa, falta `DATABASE_URL` |
| ❌ **Quebrados** | erro de verdade, para consertar |

Há também um teste que garante que **nenhuma tela fica órfã no menu**. As telas
nascem em dois lugares — dez no `index.html` e seis injetadas pelo `app.js` — e
sem esse teste é fácil criar a décima sétima e não perceber.

## O menu

Dezesseis telas, organizadas por pergunta em vez de por ordem de chegada:

| Grupo | Telas |
|---|---|
| **OPERAR** | Robô, Mesa Spot, Central Pro, Monitor |
| **MERCADO** | Radar 50, Todos os mercados |
| **MEU DINHEIRO** | Visão geral, Minha holding, Earn, Gastos e resultado |
| **TREINO E REGISTRO** | Simulador Spot, Diário, Missões, Gestão de risco |
| **AJUSTES** | Binance, Robô MNQ |

## Outros recursos

- Dashboard de resultado, acerto, profit factor e disciplina
- Radar de 50 moedas com peneira de setups
- Guardião do lucro: onde o stop deve estar, em múltiplos de R
- Calculadora de ordem alavancada com preço de liquidação e empate
- Mesa Earn: cobra o que está parado, não só o que rende
- Robô MNQ para prop firm — **somente simulação**, porque as regras das mesas
  proíbem automação
- Ledger financeiro e sync de Binance Pay
- Curva de capital, diário, missões e níveis
- PWA instalável no celular
- Endpoint `/health` para deploy

## Configuração

Tudo no servidor, nunca no navegador:

```bash
DATABASE_URL=postgres://...
APP_PASSWORD=uma-senha-longa
AUTH_SECRET=outro-segredo-longo

BINANCE_PESO_MAX=6000        # teto de peso por minuto; ele para em 70%
# Atenção: MAX_ORDER_NOTIONAL abaixo de 5 é ignorado. A Binance recusa ordem
# Spot abaixo disso, então um teto menor não protegeria — impediria o robô de
# existir, sem avisar.

BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_BASE_URL=https://testnet.binance.vision
MAX_ORDER_NOTIONAL=100

ENABLE_LIVE_TRADING=false
ROBO_PERMITE_REAL=false
ROBO_MODO=SIMULACAO

ANTHROPIC_API_KEY=...        # opcional, para as análises
WHATSAPP_WEBHOOK_URL=...     # opcional, para alertas
```

Crie a chave da Binance **sem permissão de saque** e com restrição de IP.

## Executar

```bash
npm start   # http://localhost:3000 — requer Node 22+
npm test
```

## Limites e avisos

O robô opera **somente Spot comprado**, sem alavancagem. Derivativos da
Binance não são oferecidos a residentes no Brasil, e o projeto não tenta
contornar isso.

Automação não conserta estratégia ruim: ela repete a mesma decisão com mais
disciplina e sem cansaço. O que a automação conserta é o que costuma custar
mais caro — tirar o stop, dobrar aposta, entrar sem plano e ficar sem
proteção enquanto se dorme.

O BaladaTrade é educacional e não constitui recomendação financeira.
