'use strict';
// As rotas do Simulador B3 pedem login, explicam o que falta quando não há
// banco e recusam pedido torto antes de buscar preço ou chamar a IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { handler } = require('../server');

function serve() { return new Promise((resolve) => { const server = http.createServer(handler).listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })); }); }
function sessao() {
  process.env.APP_PASSWORD = 'senha-b3'; process.env.AUTH_SECRET = 'segredo-b3-de-teste';
  const exp = String(Date.now() + 3600000);
  return `baladatrade_session=${exp}.${crypto.createHmac('sha256', 'segredo-b3-de-teste').update(exp).digest('base64url')}`;
}

test('simulador B3 exige login', async () => {
  sessao();
  const { server, url } = await serve();
  try {
    assert.equal((await fetch(`${url}/api/b3/estado`)).status, 401);
  } finally { server.close(); }
});

test('sem banco, o simulador diz o que falta em vez de quebrar', async () => {
  const cookie = sessao(); const antes = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  const { server, url } = await serve();
  try {
    const r = await fetch(`${url}/api/b3/estado`, { headers: { cookie } });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Banco de dados não configurado/);
  } finally { server.close(); if (antes !== undefined) process.env.DATABASE_URL = antes; }
});

test('recomeçar a conta pede confirmação, e leitura só de WIN ou WDO', async () => {
  const cookie = sessao();
  const { server, url } = await serve();
  const post = (rota, corpo) => fetch(url + rota, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  try {
    assert.equal((await post('/api/b3/reiniciar', { saldoInicial: 1000 })).status, 400);
    const leitura = await post('/api/ai/b3-leitura', { contrato: 'PETR4' });
    assert.equal(leitura.status, 400);
    assert.match((await leitura.json()).error, /WIN ou WDO/);
    assert.equal((await post('/api/b3/zerar', { id: 'abc' })).status, 400);
  } finally { server.close(); }
});
