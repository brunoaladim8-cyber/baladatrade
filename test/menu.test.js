'use strict';
// Toda tela precisa ter um lugar no menu. Este teste existe porque as telas
// nascem em dois lugares — dez no index.html e seis injetadas pelo app.js — e
// é fácil criar a décima sétima e não perceber que ela caiu em OUTROS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');

const doHtml = [...html.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]);
const doJs = [...app.matchAll(/dataset\.view\s*=\s*'([a-z]+)'/g)].map(m => m[1]);
const todas = [...new Set([...doHtml, ...doJs])];

const grupos = [...app.matchAll(/\{ titulo: '[^']+', views: \[([^\]]*)\] \}/g)]
  .map(m => m[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean));
const agrupadas = new Set(grupos.flat());

test('o menu tem grupos definidos', () => {
  assert.ok(grupos.length >= 4, `esperava vários grupos, achei ${grupos.length}`);
});

test('toda tela do app está em algum grupo do menu', () => {
  const orfas = todas.filter(v => !agrupadas.has(v));
  assert.deepEqual(orfas, [], `telas sem grupo (cairiam em OUTROS): ${orfas.join(', ')}`);
});

test('nenhum grupo cita tela que não existe', () => {
  const fantasmas = [...agrupadas].filter(v => !todas.includes(v));
  assert.deepEqual(fantasmas, [], `grupos citam telas inexistentes: ${fantasmas.join(', ')}`);
});

test('nenhuma tela aparece em dois grupos', () => {
  const vistas = grupos.flat();
  const repetidas = vistas.filter((v, i) => vistas.indexOf(v) !== i);
  assert.deepEqual(repetidas, [], `telas em mais de um grupo: ${repetidas.join(', ')}`);
});

test('cada tela do menu tem uma seção correspondente na página', () => {
  const secoesHtml = [...html.matchAll(/<section id="([a-z]+)" class="view/g)].map(m => m[1]);
  const secoesJs = [...app.matchAll(/\.id\s*=\s*'([a-z]+)'/g)].map(m => m[1]);
  const secoes = new Set([...secoesHtml, ...secoesJs]);
  const semTela = todas.filter(v => !secoes.has(v));
  assert.deepEqual(semTela, [], `itens de menu sem seção: ${semTela.join(', ')}`);
});
