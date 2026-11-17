'use strict';
// ============================================================
// SUPER POWER — a tela. 16/11/2026
// Toda conta (força, sinal, trava) é feita no servidor (forca-cesta.js, com
// teste). Aqui só se desenha e se pede. A única conta local é a prévia do
// risco em reais, com a mesma regra do simulador (stop + 1 tick de deslize).
// ============================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const LC = window.LightweightCharts;
  const PONTO = 0.2, TICK = 5;
  const CORES = { compra: '#1fe08f', venda: '#ff4d6d', espera: '#ffb020', ouro: '#ffd34d', ciano: '#38d6ff', grade: 'rgba(120,150,200,0.08)', texto: '#8a97ad' };
  // Uma cor fixa por ação no gráfico de linhas (não é sinal, é identidade).
  const COR_ACAO = { VALE3: '#38d6ff', ITUB4: '#ff9d2e', PETR4: '#1fe08f', BBDC4: '#ff4d6d', BBAS3: '#ffd34d', WEGE3: '#7cf2ff', B3SA3: '#c9d6ea', ABEV3: '#ff7ab8' };

  let estado = null, graficos = null, ocupado = false;

  const limpo = (v) => { const d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; };
  const num = (v, casas = 0) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) : '—');
  const reais = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
  const sinalTxt = (v, casas = 0) => (v == null ? '—' : `${v > 0 ? '+' : ''}${num(v, casas)}`);
  const classe = (v) => (v > 0 ? 'compra-t' : v < 0 ? 'venda-t' : 'espera-t');
  // O eixo do LightweightCharts é UTC; o pregão é em Brasília.
  const t = (ms) => Math.floor(ms / 1000) - 3 * 3600;

  /** A cor que decide: verde/vermelho com intensidade pela força; âmbar no meio. */
  function corDaForca(f, alfa = null) {
    if (f == null) return 'rgba(120,130,150,0.35)';
    const a = alfa ?? Math.min(1, 0.25 + Math.abs(f) / 100 * 0.75);
    if (f >= 20) return `rgba(31,224,143,${a})`;
    if (f <= -20) return `rgba(255,77,109,${a})`;
    return `rgba(255,176,32,${alfa ?? 0.55})`;
  }

  async function api(url, opcoes) {
    const r = await fetch(url, opcoes);
    const data = await r.json().catch(() => ({ error: 'Resposta inválida do servidor.' }));
    if (r.status === 401) { const e = new Error('SESSAO'); e.sessao = true; throw e; }
    if (!r.ok) throw new Error(data.error || `Falha ${r.status}`);
    return data;
  }
  const post = (url, corpo) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });

  function mostrarErro(texto, html = false) {
    const el = $('erro');
    if (!texto) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (html) el.innerHTML = texto; else el.textContent = texto;
  }

  // ---------- gráficos ----------
  const base = (altura) => ({
    height: altura,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: CORES.texto, fontFamily: 'Cascadia Mono, Consolas, monospace' },
    grid: { vertLines: { color: CORES.grade }, horzLines: { color: CORES.grade } },
    rightPriceScale: { borderColor: 'rgba(120,150,200,0.2)' },
    timeScale: { borderColor: 'rgba(120,150,200,0.2)', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: { locale: 'pt-BR' },
    autoSize: true,
  });

  function criarGraficos() {
    if (!LC) { mostrarErro('A biblioteca de gráficos não carregou. Recarregue a página.'); return null; }
    // 1) WIN + força da cesta em painel separado
    const win = LC.createChart($('gWin'), base(460));
    const velas = win.addSeries(LC.CandlestickSeries, { upColor: CORES.compra, downColor: CORES.venda, borderVisible: false, wickUpColor: CORES.compra, wickDownColor: CORES.venda, priceFormat: { type: 'price', precision: 0, minMove: 5 } });
    const forcaHist = win.addSeries(LC.HistogramSeries, { priceFormat: { type: 'price', precision: 0, minMove: 1 }, base: 0 }, 1);
    const forcaLinha = win.addSeries(LC.LineSeries, { color: CORES.ouro, lineWidth: 2, priceLineVisible: false, lastValueVisible: true }, 1);
    forcaLinha.createPriceLine({ price: 40, color: CORES.compra, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'compra' });
    forcaLinha.createPriceLine({ price: -40, color: CORES.venda, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'venda' });
    try { win.panes()[1]?.setHeight(140); } catch { /* versão sem painéis redimensionáveis */ }

    // 2) força de cada ação no dia
    const linhas = LC.createChart($('gLinhas'), base(300));
    const seriesLinhas = {};
    for (const [codigo, cor] of Object.entries(COR_ACAO)) seriesLinhas[codigo] = linhas.addSeries(LC.LineSeries, { color: cor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: codigo });
    seriesLinhas.VALE3.createPriceLine({ price: 40, color: 'rgba(31,224,143,0.6)', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
    seriesLinhas.VALE3.createPriceLine({ price: -40, color: 'rgba(255,77,109,0.6)', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });

    return { win, velas, forcaHist, forcaLinha, linhas, seriesLinhas, acoes: {} };
  }

  function graficoDaAcao(codigo) {
    if (graficos.acoes[codigo]) return graficos.acoes[codigo];
    const host = document.querySelector(`[data-grafico="${codigo}"]`);
    if (!host) return null;
    const c = LC.createChart(host, { ...base(170), rightPriceScale: { borderColor: 'rgba(120,150,200,0.2)', scaleMargins: { top: 0.08, bottom: 0.3 } }, timeScale: { visible: false } });
    const velas = c.addSeries(LC.CandlestickSeries, { upColor: CORES.compra, downColor: CORES.venda, borderVisible: false, wickUpColor: CORES.compra, wickDownColor: CORES.venda, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    const vol = c.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
    graficos.acoes[codigo] = { c, velas, vol };
    return graficos.acoes[codigo];
  }

  // ---------- desenho ----------
  function desenharFita(cesta) {
    const itens = cesta.acoes.map((a) => `<span><b>${limpo(a.codigo)}</b><span class="${classe(a.variacaoPct)}">${num(a.preco, 2)} ${a.variacaoPct == null ? '' : `${sinalTxt(a.variacaoPct, 2)}%`}</span> · força <span class="${classe(a.forca)}">${sinalTxt(a.forca)}</span></span>`).join('');
    $('fita').innerHTML = itens + itens; // duas vezes: a fita dá a volta sem emenda
  }

  function desenharHeroi() {
    const w = estado.win;
    $('winPreco').textContent = w ? num(w.preco) : '—';
    $('winVar').innerHTML = w ? `<span class="${classe(w.variacaoPct)}">${sinalTxt(w.variacaoPct, 2)}% no dia</span>` : 'sem preço agora';
    $('winJanela').textContent = w?.variacaoJanelaPct == null ? '—' : `${sinalTxt(w.variacaoJanelaPct, 2)}%`;
    const pg = $('pregao');
    pg.textContent = w?.pregao?.aberto ? 'PREGÃO ABERTO' : 'FECHADO';
    pg.className = `sp-pregao ${w?.pregao?.aberto ? 'aberto' : ''}`;
    pg.title = w?.pregao?.motivo || '';

    const f = estado.cesta.forca;
    $('forcaNum').textContent = sinalTxt(f);
    $('forcaNum').className = '';
    const lado = f == null ? '—' : f >= 40 ? 'COMPRADOR FORTE' : f >= 20 ? 'comprador' : f <= -40 ? 'VENDEDOR FORTE' : f <= -20 ? 'vendedor' : 'equilíbrio';
    $('forcaLado').textContent = lado;
    $('forcaLado').className = classe(f >= 20 ? 1 : f <= -20 ? -1 : 0);
    $('agulha').style.setProperty('--angulo', `${Math.max(-100, Math.min(100, f || 0)) * 0.9}deg`);

    const s = estado.sinal;
    const v = $('veredito');
    v.className = `sp-painel sp-veredito inclina-dir ${s.lado === 'COMPRA' ? 'compra' : s.lado === 'VENDA' ? 'venda' : 'espera'}`;
    document.body.className = s.lado === 'COMPRA' ? 'sinal-compra' : s.lado === 'VENDA' ? 'sinal-venda' : '';
    $('sinalLado').textContent = s.lado;
    $('sinalMotivo').textContent = s.motivo;

    // O que decide, item por item: cada luz é uma condição do código.
    const p = estado.padrao, c = estado.cesta, m = estado.mesa;
    const itens = [
      [Math.abs(f || 0) >= p.limiar ? 'ok' : 'nao', `Força da cesta além de ±${p.limiar} (agora ${sinalTxt(f)})`],
      [c.concordancia >= p.concordancia ? 'ok' : 'nao', `${Math.round(p.concordancia * 100)}% do peso do mesmo lado (agora ${Math.round((c.concordancia || 0) * 100)}%)`],
      [c.cobertura >= 20 ? 'ok' : 'nao', `Cesta enxergando o índice (${num(c.cobertura, 1)}% do Ibov)`],
      [estado.win?.pregao?.aberto ? 'ok' : 'nao', estado.win?.pregao?.aberto ? 'Pregão aberto' : (estado.win?.pregao?.motivo || 'Pregão fechado')],
      [s.winAtrasado == null ? 'talvez' : s.winAtrasado ? 'ok' : 'talvez', s.winAtrasado ? 'WIN ainda não acompanhou (entrada cedo)' : s.winAtrasado === false ? 'WIN já andou junto (entrada tarde)' : 'WIN x cesta: aguardando sinal'],
      [m ? (m.veredito === s.lado ? 'ok' : 'nao') : 'talvez', m ? `Mesa disse ${m.veredito} (${m.confianca}% de confiança)` : 'Mesa de agentes ainda não falou'],
    ];
    $('checklist').innerHTML = itens.map(([luz, texto]) => `<li><span class="sp-luz ${luz}"></span>${limpo(texto)}</li>`).join('');
  }

  function desenharGraficoWin() {
    const velas = (estado.win?.candles || []).map((k) => ({ time: t(k.time), open: k.open, high: k.high, low: k.low, close: k.close }));
    graficos.velas.setData(velas);
    const serie = (estado.serie || []).map((p) => ({ time: t(p.time), value: p.value }));
    graficos.forcaLinha.setData(serie);
    graficos.forcaHist.setData(serie.map((p) => ({ ...p, color: corDaForca(p.value, 0.55) })));
  }

  function desenharTorres() {
    const acoes = estado.cesta.acoes;
    const maior = Math.max(10, ...acoes.map((a) => Math.abs(a.influencia || 0)));
    $('torres').innerHTML = acoes.map((a) => {
      const sobe = (a.influencia || 0) >= 0;
      return `<div class="sp-torre ${sobe ? 'sobe' : 'desce'}" data-codigo="${limpo(a.codigo)}">
        <span class="sp-torre-val ${classe(a.influencia)}">${sinalTxt(a.influencia, 1)}</span>
        <div class="sp-prisma"><div class="sp-face frente"></div><div class="sp-face lado"></div><div class="sp-face tampa"></div></div>
        <span class="sp-torre-nome">${limpo(a.codigo)}</span></div>`;
    }).join('');
    // altura e cor pelo CSSOM (a política de segurança não deixa style inline no HTML)
    $('torres').querySelectorAll('.sp-torre').forEach((el) => {
      const a = acoes.find((x) => x.codigo === el.dataset.codigo);
      const h = Math.max(4, (Math.abs(a.influencia || 0) / maior) * 128);
      const prisma = el.querySelector('.sp-prisma');
      prisma.style.setProperty('--h', `${h}px`);
      el.style.setProperty('--cor', corDaForca(a.forca, 1));
    });
  }

  function desenharMapa() {
    const c = estado.cesta;
    // colunas da grade de 12 pelo peso: as grandes ocupam mais
    const pesoTotal = c.acoes.reduce((s, a) => s + a.peso, 0);
    const ordenadas = [...c.acoes].sort((a, b) => b.peso - a.peso);
    $('mapa').innerHTML = ordenadas.map((a) => `<div class="sp-celula" data-codigo="${limpo(a.codigo)}"><b>${limpo(a.codigo)}</b><span>${sinalTxt(a.forca)}</span><small>${num(a.peso, 1)}% do Ibov · ${limpo(a.rotulo.texto)}</small></div>`).join('');
    $('mapa').querySelectorAll('.sp-celula').forEach((el) => {
      const a = c.acoes.find((x) => x.codigo === el.dataset.codigo);
      const span = Math.max(3, Math.round((a.peso / pesoTotal) * 24));
      el.style.gridColumn = `span ${Math.min(12, span)}`;
      el.style.gridRow = a.peso >= 7 ? 'span 2' : 'span 1';
      el.style.setProperty('--cor', corDaForca(a.forca, a.forca == null ? 0.2 : Math.min(0.85, 0.15 + Math.abs(a.forca) / 120)));
    });
    $('cobertura').textContent = `A cesta enxerga ${num(c.cobertura, 1)}% do Ibovespa. ${Math.round((c.concordancia || 0) * 100)}% desse peso está do lado da força.`;
  }

  function desenharLinhas() {
    for (const [codigo, s] of Object.entries(graficos.seriesLinhas)) {
      const dados = (estado.acoes[codigo]?.serieForca || []).map((p) => ({ time: t(p.time), value: p.value }));
      s.setData(dados);
    }
    $('chipsLinhas').innerHTML = Object.keys(COR_ACAO).map((c) => `<span class="sp-chip" data-cor="${c}">${c}</span>`).join('');
    $('chipsLinhas').querySelectorAll('.sp-chip').forEach((el) => el.style.setProperty('--cor', COR_ACAO[el.dataset.cor]));
  }

  function desenharAcoes() {
    const grade = $('gradeAcoes');
    const ordem = estado.cesta.acoes;
    if (!grade.dataset.pronta) {
      grade.innerHTML = ordem.map((a) => `<article class="sp-painel sp-acao" id="card-${limpo(a.codigo)}">
        <div class="sp-acao-topo"><div><b>${limpo(a.codigo)}</b><small>${limpo(a.nome)} · ${num(a.peso, 1)}% do Ibov</small></div>
          <div class="sp-acao-preco"><strong data-campo="preco">—</strong><span data-campo="var">—</span></div></div>
        <div class="sp-grafico mini" data-grafico="${limpo(a.codigo)}"></div>
        <div class="sp-barra" data-campo="barra"><i></i></div>
        <div class="sp-acao-rodape"><span>força <b data-campo="forca">—</b></span><span data-campo="rotulo">—</span><span>influência <b data-campo="infl">—</b></span></div>
      </article>`).join('');
      grade.dataset.pronta = '1';
    }
    for (const a of ordem) {
      const card = $(`card-${a.codigo}`);
      if (!card) continue;
      const campo = (n) => card.querySelector(`[data-campo="${n}"]`);
      campo('preco').textContent = num(a.preco, 2);
      campo('var').innerHTML = `<span class="${classe(a.variacaoPct)}">${a.variacaoPct == null ? '—' : `${sinalTxt(a.variacaoPct, 2)}%`}</span>`;
      campo('forca').textContent = sinalTxt(a.forca);
      campo('forca').className = classe(a.forca >= 20 ? 1 : a.forca <= -20 ? -1 : 0);
      campo('rotulo').textContent = a.rotulo.texto;
      campo('infl').textContent = sinalTxt(a.influencia, 1);
      const barra = campo('barra');
      barra.classList.toggle('neg', (a.forca || 0) < 0);
      barra.style.setProperty('--w', `${Math.min(50, Math.abs(a.forca || 0) / 2)}%`);
      barra.style.setProperty('--cor', corDaForca(a.forca, 1));
      card.style.borderColor = Math.abs(a.forca || 0) >= 40 ? corDaForca(a.forca, 0.7) : '';

      const g = graficoDaAcao(a.codigo);
      const candles = estado.acoes[a.codigo]?.candles || [];
      if (g) {
        g.velas.setData(candles.map((k) => ({ time: t(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
        // volume pintado pela força daquele minuto: é aqui que se vê quem mandou
        g.vol.setData(candles.map((k) => ({ time: t(k.time), value: k.volume, color: corDaForca(k.forca, 0.75) })));
      }
    }
  }

  function desenharMesa(m) {
    if (!m) return;
    const vozes = [['🐂 TOURO', m.touro, CORES.compra], ['🐻 URSO', m.urso, CORES.venda], [`🛡 GESTOR DE RISCO · ${m.veredito} · ${m.confianca}%`, m.risco, CORES.ouro]];
    $('vozes').innerHTML = vozes.map(([n, txt]) => `<div class="sp-voz" data-cor="${n}"><b>${limpo(n)}</b>${limpo(txt)}</div>`).join('');
    $('vozes').querySelectorAll('.sp-voz').forEach((el, i) => el.style.setProperty('--cor', vozes[i][2]));
  }

  function desenharAtivar() {
    const a = estado.ativar;
    $('btnAtivar').disabled = !a.ok;
    $('ativarMotivo').textContent = a.motivo;
    $('ativarMotivo').className = `sp-motivo ${a.ok ? 'compra-t' : ''}`;
  }

  function desenharRisco() {
    const stop = Number($('stop').value), alvo = Number($('alvo').value), qtd = Math.max(1, Number($('qtd').value) || 1);
    const perda = (stop + TICK) * PONTO * qtd, ganho = alvo * PONTO * qtd;
    $('risco').innerHTML = `Se bater o stop: <b class="venda-t">−${reais(perda)}</b> (com 1 tick de deslize) · se bater o alvo: <b class="compra-t">+${reais(ganho)}</b> · relação <b>${stop ? num(alvo / stop, 2) : '—'} : 1</b> · custos da corretora à parte.`;
  }

  function desenhar() {
    desenharFita(estado.cesta);
    desenharHeroi();
    desenharGraficoWin();
    desenharTorres();
    desenharMapa();
    desenharLinhas();
    desenharAcoes();
    desenharAtivar();
    if (estado.mesa) desenharMesa(estado.mesa);
    $('fonte').textContent = estado.fonte + (estado.avisos?.length ? ` · Avisos: ${estado.avisos.join(' · ')}` : '');
    $('atualizado').textContent = `atualizado às ${new Date(estado.atualizadoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    document.querySelectorAll('.sp-heroi .sp-painel').forEach((el) => { el.classList.remove('pulsa'); void el.offsetWidth; el.classList.add('pulsa'); });
  }

  async function atualizar() {
    if (ocupado) return;
    ocupado = true;
    try {
      estado = await api('/api/forca/estado');
      mostrarErro('');
      if (!graficos) graficos = criarGraficos();
      if (graficos) desenhar();
    } catch (e) {
      if (e.sessao) mostrarErro('Sessão expirada ou não entrou ainda. <a href="/">Entre no BaladaTrade</a> e volte para o Super Power.', true);
      else mostrarErro(`Não deu para ler o mercado agora: ${e.message}`);
    } finally { ocupado = false; }
  }

  function msg(texto, tipo = '') { $('msg').textContent = texto; $('msg').className = `sp-msg ${tipo}`; }

  $('btnMesa').addEventListener('click', async () => {
    $('btnMesa').disabled = true; msg('A mesa está reunida: Touro, Urso e Gestor de Risco lendo a cesta…');
    try {
      const r = await post('/api/forca/mesa');
      desenharMesa(r.mesa);
      if (estado) { estado.mesa = r.mesa; estado.ativar = r.ativar; desenharHeroi(); desenharAtivar(); }
      msg(r.ativar.motivo, r.ativar.ok ? 'ok' : '');
    } catch (e) { msg(e.sessao ? 'Sessão expirada. Entre de novo.' : e.message, 'erro'); }
    finally { $('btnMesa').disabled = false; }
  });

  $('btnAtivar').addEventListener('click', async () => {
    $('btnAtivar').disabled = true; msg('Enviando o scalp para o simulador…');
    try {
      const r = await post('/api/forca/ativar', { alvoPontos: Number($('alvo').value), stopPontos: Number($('stop').value), quantidade: Number($('qtd').value) });
      msg(`${r.motivo} Ordem no SIMULADOR. Acompanhe no Simulador B3.`, 'ok');
      await atualizar();
    } catch (e) { msg(e.sessao ? 'Sessão expirada. Entre de novo.' : e.message, 'erro'); desenharAtivar(); }
  });

  ['alvo', 'stop', 'qtd'].forEach((id) => $(id).addEventListener('input', desenharRisco));
  setInterval(() => { $('relogio').textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }, 1000);
  setInterval(atualizar, 30000);
  desenharRisco();
  atualizar();
})();
