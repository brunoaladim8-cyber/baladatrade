# BaladaTrade

Diário de trades com métricas, gestão de risco e gamificação responsável. O sistema dá XP por planejar, respeitar risco, documentar e revisar — nunca por operar mais.

## Recursos

- Dashboard de resultado, acerto, profit factor e disciplina
- Curva de capital
- Diário de trades salvo no navegador
- Missões e níveis baseados em processo
- Calculadora de tamanho de posição
- Layout responsivo em verde, branco e preto
- Endpoint `/health` para deploy
- PWA instalável no celular
- Conector Binance Spot com Testnet padrão, assinatura HMAC e limite por ordem

## Binance (sempre Testnet primeiro)

Configure no servidor, nunca no navegador:

```bash
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_BASE_URL=https://testnet.binance.vision
MAX_ORDER_NOTIONAL=100
ENABLE_LIVE_TRADING=false
APP_TOKEN=uma-senha-longa
```

O endpoint de teste é `/api/binance/order/test`. O endpoint real permanece travado até `ENABLE_LIVE_TRADING=true` e ainda exige o cabeçalho de confirmação. Crie uma chave sem permissão de saque e com restrição de IP.

## Executar

```bash
npm start
```

Acesse `http://localhost:3000`. Testes: `npm test`.

## Limites da primeira versão

Os dados ficam no `localStorage` do navegador. Não há login, banco compartilhado ou integração com corretora. O BaladaTrade é educacional e não constitui recomendação financeira.
