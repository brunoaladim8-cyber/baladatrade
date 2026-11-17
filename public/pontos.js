'use strict';
// ============================================================
// JOGO DOS PONTOS — a tela. 17/11/2026
// O placar vem de /api/forca/pontos (pontos-dia.js, com teste). As regras do
// contrato (ponto, tick, garantia) vêm do servidor, que lê do simulador B3:
// aqui não se escreve "0,20" nem "155" na mão. O simulador ao vivo usa as
// rotas do Simulador B3 que já existem (/api/b3/*).
// ============================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const LC = window.LightweightCharts;
  const CORES = { compra: '#1fe08f', venda: '#ff4d6d', espera: '#ffb020', ouro: '#ffd34d', ciano: '#38d6ff', cinza: '#8a97ad', grade: 'rgba(120,150,200,0.08)' };
  let jogo = null, b3 = null, grafico = null, serie = null, linhas = [], reguaDe = null, ocupado = false;
  let contrato = { valorPonto: 0.2, tick: 5, valorTick: 1, margem: 155 }; // até o servidor responder

  const num = (v, c = 0) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) : '—');
  const reais = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
  const pts = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))} pts`);
  const classe = (v) => (v > 0 ? 'compra-t' : v < 0 ? 'venda-t' : 'espera-t');
  const limpo = (v) => { const d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; };
  const t = (ms) => Math.floor(ms / 1000) - 3 * 3600;

  async function api(url, opcoes) {
    const r = await fetch(url, opcoes);
    const data = await r.json().catch(() => ({ error: 'Resposta inválida do servidor.' }));
    if (r.status === 401) { const e = new Error('Sessão expirada.'); e.sessao = true; throw e; }
    if (!r.ok) throw new Error(data.error || `Falha ${r.status}`);
    return data;
  }
  const post = (url, corpo) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
  function erro(texto, html = false) { const el = $('erro'); if (!texto) return el.classList.add('hidden'); el.classList.remove('hidden'); if (html) el.innerHTML = texto; else el.textContent = texto; }
  function msg(texto, tipo = '') { $('msg').textContent = texto; $('msg').className = `sp-msg ${tipo}`; }

  // ---------- placar ----------
  function desenharPlacar() {
    const h = jogo.hoje;
    const v = $('variacao');
    v.textContent = pts(h.variacao);
    v.className = `pt-pontos ${classe(h.variacao)}`;
    $('variacaoReais').textContent = `${h.variacao >= 0 ? '+' : '−'}${reais(Math.abs(h.reais))} por contrato · amplitude ${num(h.amplitude)} pts (${reais(h.reaisAmplitude)})`;
    $('leitura').textContent = jogo.leitura;
    $('atual').textContent = num(h.atual);
    $('abertura').textContent = num(h.abertura);
    $('maxima').textContent = num(h.maxima);
    $('minima').textContent = num(h.minima);
    $('amplitude').textContent = `${num(h.amplitude)} pts`;
    $('desdeFech').innerHTML = `<span class="${classe(h.desdeFechamento)}">${pts(h.desdeFechamento)}</span>`;
    $('gap').innerHTML = `<span class="${classe(h.gap)}">${pts(h.gap)}</span>`;
    $('posicao').textContent = `${h.posicaoPct}%`;
    const pg = $('pregao');
    pg.textContent = jogo.pregao?.aberto ? 'PREGÃO ABERTO' : 'FECHADO';
    pg.className = `sp-pregao ${jogo.pregao?.aberto ? 'aberto' : ''}`;
    pg.title = jogo.pregao?.motivo || '';

    // termômetro: 100% da média fica em 2/3 da barra, para caber o dia largo
    const u = jogo.usadoPct;
    $('termoBarra').style.setProperty('--w', `${Math.min(100, ((u || 0) / 150) * 100)}%`);
    $('usado').textContent = u == null ? '—' : `${u}%`;
    $('media').textContent = jogo.mediaAmplitude ? `da faixa média de ${num(jogo.mediaAmplitude)} pts dos últimos ${jogo.anteriores.length} pregões · fechamento médio a ${num(jogo.mediaVariacaoAbs)} pts da abertura` : 'sem pregões anteriores para comparar';
    $('faixaPonto').style.setProperty('--p', `${h.posicaoPct}%`);
  }

  function desenharRegras() {
    $('rPonto').textContent = reais(contrato.valorPonto);
    $('rTick').textContent = `${contrato.tick} pts`;
    $('rTickR').textContent = `= ${reais(contrato.valorTick)} por contrato`;
    $('rMargem').textContent = reais(contrato.margem);
    if (!$('cMargem').dataset.mexido) $('cMargem').value = contrato.margem;
  }

  function desenharCalc() {
    const capital = Number($('cCapital').value) || 0, qtd = Math.max(1, Math.floor(Number($('cQtd').value) || 1));
    const margem = Number($('cMargem').value) || contrato.margem, p = Number($('cPts').value) || 0;
    const garantia = qtd * margem, cabe = Math.floor(capital / margem);
    const resultado = p * contrato.valorPonto * qtd;
    $('calc').innerHTML = `
      <span>Garantia presa<br><b>${reais(garantia)}</b></span>
      <span>Seu capital permite<br><b>${num(cabe)} contrato${cabe === 1 ? '' : 's'}</b></span>
      <span>1 ponto com ${qtd} contrato${qtd === 1 ? '' : 's'}<br><b>${reais(contrato.valorPonto * qtd)}</b></span>
      <span>1 tick (${contrato.tick} pts)<br><b>${reais(contrato.valorTick * qtd)}</b></span>
      <span>${num(p)} pontos a favor<br><b class="compra-t">+${reais(Math.abs(resultado))}</b></span>
      <span>${num(p)} pontos contra<br><b class="venda-t">−${reais(Math.abs(resultado))}</b></span>
      ${garantia > capital ? `<span class="alerta">⚠ ${qtd} contratos precisam de ${reais(garantia)} de garantia e o capital é ${reais(capital)}. A corretora não deixa abrir.</span>` : ''}
      <span class="alerta">${capital > 0 && jogo?.mediaAmplitude ? `Um dia médio (${num(jogo.mediaAmplitude)} pts de faixa) contra você, com ${qtd} contrato${qtd === 1 ? '' : 's'}, seria ${reais(jogo.mediaAmplitude * contrato.valorPonto * qtd)}: ${num((jogo.mediaAmplitude * contrato.valorPonto * qtd / capital) * 100, 1)}% do capital. Por isso o stop é obrigatório.` : ''}</span>`;
  }

  // ---------- gráfico com marcas + régua ----------
  function criarGrafico() {
    grafico = LC.createChart($('gDia'), {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: CORES.cinza, fontFamily: 'Cascadia Mono, Consolas, monospace' },
      grid: { vertLines: { color: CORES.grade }, horzLines: { color: CORES.grade } },
      rightPriceScale: { borderColor: 'rgba(120,150,200,0.2)' },
      timeScale: { borderColor: 'rgba(120,150,200,0.2)', timeVisible: true, secondsVisible: false },
      localization: { locale: 'pt-BR' }, autoSize: true,
    });
    serie = grafico.addSeries(LC.CandlestickSeries, { upColor: CORES.compra, downColor: CORES.venda, borderVisible: false, wickUpColor: CORES.compra, wickDownColor: CORES.venda, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
    grafico.subscribeClick((p) => {
      if (!p?.point) return;
      const preco = serie.coordinateToPrice(p.point.y);
      if (preco == null) return;
      if (reguaDe === null) { reguaDe = preco; $('regua').textContent = `Régua: de ${num(preco)} → clique no 2º ponto`; return; }
      const qtd = Math.max(1, Number($('oQtd').value) || 1);
      const d = Math.round(preco - reguaDe);
      $('regua').innerHTML = `Régua: <span class="${classe(d)}">${pts(d)}</span> · ${num(Math.abs(d) / contrato.tick)} ticks · ${reais(Math.abs(d) * contrato.valorPonto * qtd)} com ${qtd} contrato${qtd === 1 ? '' : 's'}`;
      reguaDe = null;
    });
  }

  function desenharGrafico() {
    if (!LC) return;
    if (!grafico) criarGrafico();
    serie.setData(jogo.candles.map((k) => ({ time: t(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
    linhas.forEach((l) => serie.removePriceLine(l));
    const cor = { abertura: CORES.ciano, maxima: CORES.compra, minima: CORES.venda, anterior: CORES.cinza, faixa: CORES.ouro };
    linhas = jogo.niveis.map((n) => serie.createPriceLine({ price: n.preco, color: cor[n.tipo], lineWidth: n.tipo === 'faixa' ? 1 : 2, lineStyle: n.tipo === 'faixa' || n.tipo === 'anterior' ? LC.LineStyle.Dashed : LC.LineStyle.Solid, axisLabelVisible: true, title: n.nome }));
    for (const p of b3?.posicoes || []) {
      if (p.contrato !== 'WIN') continue;
      linhas.push(serie.createPriceLine({ price: p.entrada, color: '#ffffff', lineWidth: 2, axisLabelVisible: true, title: `entrada ${p.lado === 'COMPRA' ? '▲' : '▼'}` }));
      linhas.push(serie.createPriceLine({ price: p.stop, color: CORES.venda, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'stop' }));
      if (p.alvo) linhas.push(serie.createPriceLine({ price: p.alvo, color: CORES.compra, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'alvo' }));
    }
  }

  // ---------- barras ----------
  function barras(el, itens, { cheia = false } = {}) {
    const maior = Math.max(1, ...itens.map((i) => Math.abs(i.valor)));
    el.innerHTML = itens.map((i, n) => `<div class="pt-barra" data-n="${n}"><span>${limpo(i.rotulo)}</span><div class="trilho ${cheia ? 'cheia' : i.valor < 0 ? 'neg' : ''}"><i></i></div><b class="${cheia ? '' : classe(i.valor)}">${limpo(i.texto)}</b></div>`).join('') || '<p class="muted">Sem dados ainda.</p>';
    el.querySelectorAll('.pt-barra').forEach((b) => {
      const i = itens[Number(b.dataset.n)];
      const tr = b.querySelector('.trilho');
      tr.style.setProperty('--w', `${(Math.abs(i.valor) / maior) * (cheia ? 100 : 50)}%`);
      tr.style.setProperty('--cor', cheia ? CORES.ouro : i.valor > 0 ? CORES.compra : i.valor < 0 ? CORES.venda : CORES.espera);
    });
  }
  function desenharBarras() {
    barras($('horas'), jogo.horas.map((h) => ({ rotulo: h.rotulo, valor: h.variacao, texto: `${pts(h.variacao)} · ${reais(h.reais)}` })));
    const ddmm = (iso) => iso.slice(5).split('-').reverse().join('/');
    const dias = [...jogo.anteriores.map((d) => ({ ...d, rotulo: ddmm(d.data) })), { rotulo: `${ddmm(jogo.data)} hoje`, amplitude: jogo.hoje.amplitude, variacao: jogo.hoje.variacao }];
    barras($('dias'), dias.map((d) => ({ rotulo: d.rotulo, valor: d.amplitude, texto: `${num(d.amplitude)} pts · ${pts(d.variacao)}` })), { cheia: true });
  }

  // ---------- simulador ao vivo ----------
  function desenharSimulador() {
    const qtd = Math.max(1, Number($('oQtd').value) || 1), stop = Number($('oStop').value) || 0, alvo = Number($('oAlvo').value) || 0;
    $('oGarantia').value = reais(qtd * contrato.margem);
    $('oRisco').innerHTML = `Stop: <b class="venda-t">−${reais((stop + contrato.tick) * contrato.valorPonto * qtd)}</b> (com 1 tick de deslize) · Alvo: <b class="compra-t">${alvo ? `+${reais(alvo * contrato.valorPonto * qtd)}` : 'sem alvo'}</b> · cada ponto = <b>${reais(contrato.valorPonto * qtd)}</b>`;
    if (!b3) return;
    const c = b3.conta, d = b3.dia;
    $('conta').innerHTML = `<div><small>SALDO</small><b>${reais(c.saldo)}</b></div><div><small>GARANTIA LIVRE</small><b>${reais(c.livre)}</b></div><div><small>RESULTADO HOJE</small><b class="${classe(d.resultado)}">${reais(d.resultado)}</b></div><div><small>SITUAÇÃO</small><b class="${d.travado ? 'venda-t' : 'compra-t'}">${d.travado ? 'TRAVADO' : 'PODE OPERAR'}</b></div>`;
    const abertas = (b3.posicoes || []).filter((p) => p.contrato === 'WIN');
    $('posicoes').innerHTML = abertas.map((p) => {
      const vivo = p.aberto?.pontos ?? null;
      return `<div class="pt-pos" data-id="${p.id}" data-v="${vivo ?? 0}"><div><b>${p.lado === 'COMPRA' ? '▲ Comprado' : '▼ Vendido'} · ${p.quantidade} WIN</b><small>Entrada ${num(p.entrada)} · agora ${num(p.precoAtual)} · stop ${num(p.stop)} · alvo ${p.alvo ? num(p.alvo) : '—'}</small><small>Garantia presa ${reais(p.quantidade * contrato.margem)} · resultado ${reais(p.aberto?.liquido)}</small></div><div class="pt-vivo">${pts(vivo)}</div><button class="sp-btn" data-zerar="${p.id}">ZERAR</button></div>`;
    }).join('') || '<p class="muted">Nenhuma posição aberta no WIN. Compre ou venda acima para ver os pontos andando ao vivo.</p>';
    $('posicoes').querySelectorAll('.pt-pos').forEach((el) => el.style.setProperty('--cor', Number(el.dataset.v) >= 0 ? CORES.compra : CORES.venda));
  }

  async function ordem(lado) {
    msg(`Enviando ${lado === 'COMPRA' ? 'compra' : 'venda'} ao simulador…`);
    try {
      await post('/api/b3/ordem', { contrato: 'WIN', lado, quantidade: Number($('oQtd').value), stopPontos: Number($('oStop').value), alvoPontos: Number($('oAlvo').value) || null });
      msg(`${lado === 'COMPRA' ? 'Comprado' : 'Vendido'} no simulador. Os pontos andam com o preço de referência.`, 'ok');
      await atualizar();
    } catch (e) { msg(e.message, 'erro'); }
  }

  // ---------- ciclo ----------
  async function atualizar() {
    if (ocupado) return;
    ocupado = true;
    try {
      const [j, s] = await Promise.allSettled([api('/api/forca/pontos'), api('/api/b3/estado')]);
      if (j.status === 'rejected') throw j.reason;
      jogo = j.value;
      if (jogo.contrato) contrato = jogo.contrato;
      b3 = s.status === 'fulfilled' ? s.value : null;
      erro('');
      if (jogo.semDados) { erro(jogo.motivo); return; }
      desenharRegras(); desenharPlacar(); desenharGrafico(); desenharBarras(); desenharCalc(); desenharSimulador();
      if (!b3 && s.reason) $('conta').innerHTML = `<p class="muted">Simulador indisponível: ${limpo(s.reason.message)}</p>`;
      $('fonte').textContent = jogo.fonte;
      $('atualizado').textContent = `atualizado às ${new Date(jogo.atualizadoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
      document.querySelector('.pt-grande')?.classList.remove('pulsa'); void document.body.offsetWidth; document.querySelector('.pt-grande')?.classList.add('pulsa');
    } catch (e) {
      if (e.sessao) erro('Sessão expirada ou não entrou ainda. <a href="/">Entre no BaladaTrade</a> e volte.', true);
      else erro(`Não deu para ler o índice agora: ${e.message}`);
    } finally { ocupado = false; }
  }

  $('btnCompra').addEventListener('click', () => ordem('COMPRA'));
  $('btnVenda').addEventListener('click', () => ordem('VENDA'));
  $('posicoes').addEventListener('click', async (ev) => {
    const id = ev.target?.dataset?.zerar;
    if (!id) return;
    try { await post('/api/b3/zerar', { id: Number(id) }); msg('Posição zerada.', 'ok'); await atualizar(); } catch (e) { msg(e.message, 'erro'); }
  });
  $('cMargem').addEventListener('input', () => { $('cMargem').dataset.mexido = '1'; desenharCalc(); });
  ['cCapital', 'cQtd', 'cPts'].forEach((id) => $(id).addEventListener('input', desenharCalc));
  ['oQtd', 'oStop', 'oAlvo'].forEach((id) => $(id).addEventListener('input', desenharSimulador));
  setInterval(() => { $('relogio').textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }, 1000);
  setInterval(atualizar, 15000);
  desenharRegras(); desenharCalc(); desenharSimulador();
  atualizar();
})();
