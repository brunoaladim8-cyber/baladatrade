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
npm start   # http://localhost:3000
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
