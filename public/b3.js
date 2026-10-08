'use strict';
// ============================================================
// SIMULADOR B3 — a tela do mini índice (WIN) e do mini dólar (WDO). 07/10/2026
//
// As regras moram no servidor (b3-simulador.js, com teste). Esta tela só mostra
// e pede: nenhuma conta de dinheiro é feita aqui além da prévia do risco, e a
// prévia usa a mesma fórmula do servidor (stop + 1 tick de deslize).
// ============================================================
(function () {
  const sec = document.getElementById('bolsa');
  if (!sec) return;
  const q = (s) => sec.querySelector(s);
  const nav = document.querySelector('[data-view="bolsa"]');
  let contrato = 'WIN';
  let estado = null;
  let relogio = null;
  let grafico = null;
  let serie = null;
  let linhas = [];
  let ajustesPreenchidos = false;

  const reais = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
  const pontos = (v, casas = 0) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) : '—');
  const limpo = (v) => { const d = document.createElement('div'); d.textContent = v === null || v === undefined ? '' : String(v); return d.innerHTML; };
  const classe = (v) => (Number(v) > 0 ? 'positive' : Number(v) < 0 ? 'negative' : '');
  const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Recife' }) : '—');
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Recife' }) : '—');
  const TIPOS = { STOP: 'Stop', ALVO: 'Alvo', ZERAGEM: 'Zeragem', MANUAL: 'Zerada na mão' };

  async function api(url, opcoes) {
    const r = await fetch(url, opcoes);
    const data = await r.json().catch(() => ({ error: 'Resposta inválida do servidor.' }));
    if (r.status === 401) { document.getElementById('authWall')?.classList.remove('hidden'); throw new Error('Sessão expirada. Entre de novo e volte ao Simulador B3.'); }
    if (!r.ok) throw new Error(data.error || `Falha ${r.status}`);
    return data;
  }
  const post = (url, corpo) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });

  function aviso(el, texto, tipo = '') { el.textContent = texto || ''; el.className = `b3-msg ${tipo}`.trim(); }

  // ---------- desenho ----------
  function desenharCotas() {
    const cartoes = Object.values(estado.contratos).map((c) => {
      const aberto = c.pregao?.aberto;
      const idade = c.idadeMin === null ? '' : c.idadeMin <= 1 ? 'agora' : `há ${c.idadeMin} min`;
      return `<article class="panel b3-cota ${c.codigo === contrato ? 'ativa' : ''}" data-contrato="${c.codigo}">
        <div class="b3-cota-topo"><b>${c.codigo}</b><span class="tag ${aberto ? '' : 'b3-fechado'}">${aberto ? 'PREGÃO ABERTO' : 'FECHADO'}</span></div>
        <small>${limpo(c.nome)} · ref.: ${limpo(c.referencia)}</small>
        <strong>${pontos(c.preco, c.codigo === 'WDO' ? 1 : 0)}</strong>
        <span class="${classe(c.variacaoPct)}">${c.variacaoPct === null ? '—' : `${c.variacaoPct > 0 ? '+' : ''}${pontos(c.variacaoPct, 2)}% no dia`}</span>
        <small>${limpo(c.pregao?.motivo || '')}${idade ? ` · preço ${idade}` : ''}</small>
        <small>Ponto ${reais(c.valorPonto)} · tick ${pontos(c.tick, c.codigo === 'WDO' ? 1 : 0)} · margem ${reais(c.margem)}</small>
      </article>`;
    });
    q('#b3Cotas').innerHTML = cartoes.join('');
  }

  function desenharConta() {
    const c = estado.conta;
    const d = estado.dia;
    q('#b3Patrimonio').textContent = reais(c.patrimonio);
    const trava = q('#b3Trava');
    trava.textContent = d.travado ? 'TRAVA DO DIA LIGADA' : 'PODE OPERAR';
    trava.className = `tag ${d.travado ? 'b3-fechado' : ''}`.trim();
    const custos = estado.custosIncluidos ? '' : '<p class="b3-alerta">Custos de corretora e B3 não incluídos (R$ 0). Preencha nos Ajustes com o valor da sua corretora.</p>';
    q('#b3Conta').innerHTML = `<div class="b3-numeros">
        <div><small>SALDO</small><b>${reais(c.saldo)}</b></div>
        <div><small>RESULTADO HOJE</small><b class="${classe(d.resultado)}">${reais(d.resultado)}</b></div>
        <div><small>EM ABERTO</small><b class="${classe(c.resultadoAberto)}">${reais(c.resultadoAberto)}</b></div>
        <div><small>MARGEM LIVRE</small><b>${reais(c.livre)}</b></div>
      </div>
      <p class="muted">${limpo(d.motivo)} Operações hoje: ${d.operacoes} (${d.ganhos} ganho, ${d.perdas} perda). Começou com ${reais(c.saldoInicial)}.</p>${custos}`;
    const abertas = estado.posicoes;
    q('#b3Posicoes').innerHTML = abertas.length
      ? abertas.map((p) => {
        const casas = p.contrato === 'WDO' ? 1 : 0;
        return `<div class="b3-posicao">
          <div><b>${p.lado === 'COMPRA' ? 'Comprado' : 'Vendido'} · ${p.quantidade} ${p.contrato}</b>
          <small>Entrada ${pontos(p.entrada, casas)} · stop ${pontos(p.stop, casas)} · alvo ${p.alvo === null ? '—' : pontos(p.alvo, casas)} · agora ${pontos(p.precoAtual, casas)}</small>
          <small>Aberta às ${hora(p.aberta_em)}</small></div>
          <div class="b3-posicao-direita"><b class="${classe(p.aberto?.liquido)}">${reais(p.aberto?.liquido)}</b><small>${p.aberto ? `${pontos(p.aberto.pontos, casas)} pts` : ''}</small>
          <button type="button" class="secondary b3-zerar" data-id="${p.id}">Zerar</button></div>
        </div>`;
      }).join('')
      : '<p class="muted">Sem posição aberta.</p>';
  }

  function desenharHistorico() {
    const h = estado.historico;
    q('#b3Historico').innerHTML = h.length
      ? `<table><thead><tr><th>Quando</th><th>Operação</th><th>Entrada → saída</th><th>Saiu por</th><th>Resultado</th></tr></thead><tbody>${h.map((o) => {
        const casas = o.contrato === 'WDO' ? 1 : 0;
        return `<tr><td>${dataHora(o.fechada_em)}</td><td>${o.lado === 'COMPRA' ? 'Compra' : 'Venda'} ${o.quantidade} ${o.contrato}</td><td>${pontos(o.entrada, casas)} → ${pontos(o.saida, casas)}</td><td>${limpo(TIPOS[o.saida_tipo] || o.saida_tipo || '—')}</td><td class="${classe(o.resultado)}">${reais(o.resultado)}<small> ${pontos(o.pontos, casas)} pts</small></td></tr>`;
      }).join('')}</tbody></table>`
      : '<p class="muted">Nenhuma operação fechada ainda.</p>';
  }

  function desenharAjustes() {
    if (ajustesPreenchidos) return;
    const c = estado.config;
    q('#b3Limite').value = c.limitePerdaDia;
    q('#b3MaxWIN').value = c.maxContratos.WIN;
    q('#b3MaxWDO').value = c.maxContratos.WDO;
    q('#b3CustoWIN').value = c.custoPorLado.WIN;
    q('#b3CustoWDO').value = c.custoPorLado.WDO;
    ajustesPreenchidos = true;
  }

  function desenharBoleta() {
    sec.querySelectorAll('.b3-escolha [data-contrato]').forEach((b) => b.classList.toggle('selected', b.dataset.contrato === contrato));
    const spec = estado?.contratos?.[contrato];
    const stop = q('#b3Stop');
    const alvo = q('#b3Alvo');
    const qtd = q('#b3Qtd');
    stop.step = contrato === 'WDO' ? '0.5' : '5';
    alvo.step = stop.step;
    stop.min = contrato === 'WDO' ? '1' : '25';
    if (estado) qtd.max = String(estado.config.maxContratos[contrato]);
    if (!spec) return;
    const n = Math.max(1, Math.floor(Number(qtd.value) || 1));
    const s = Number(stop.value) || 0;
    const a = Number(alvo.value) || 0;
    const custo = (estado.config.custoPorLado[contrato] || 0) * n * 2;
    const risco = (s + spec.tick) * spec.valorPonto * n + custo;
    const ganho = a ? a * spec.valorPonto * n - custo : null;
    q('#b3Risco').innerHTML = s
      ? `Se o stop bater: <b class="negative">−${reais(risco)}</b>${ganho !== null ? ` · se o alvo bater: <b class="positive">+${reais(ganho)}</b>` : ''}<br><small>Margem: ${reais(spec.margem * n)} · cada ponto vale ${reais(spec.valorPonto * n)} com ${n} contrato${n > 1 ? 's' : ''}</small>`
      : 'Defina o stop em pontos: sem stop não há ordem.';
  }

  function desenharGrafico() {
    const c = estado?.contratos?.[contrato];
    q('#b3GraficoTitulo').textContent = c ? `${c.codigo} · ${c.nome} (${c.referencia})` : contrato;
    const host = q('#b3Grafico');
    if (!c || !c.grafico?.length || typeof LightweightCharts === 'undefined') {
      if (!grafico) host.innerHTML = '<div class="empty">Sem candles do pregão para mostrar agora.</div>';
      return;
    }
    if (!grafico) {
      host.innerHTML = '';
      grafico = LightweightCharts.createChart(host, { height: 340, layout: { background: { type: 'solid', color: '#fff' }, textColor: '#4f625a' }, grid: { vertLines: { color: '#edf2ef' }, horzLines: { color: '#edf2ef' } }, rightPriceScale: { borderColor: '#cdd9d1' }, timeScale: { timeVisible: true, secondsVisible: false }, localization: { locale: 'pt-BR' } });
      new ResizeObserver((e) => grafico?.applyOptions({ width: e[0].contentRect.width })).observe(host);
    }
    if (serie) { grafico.removeSeries(serie); serie = null; linhas = []; }
    serie = grafico.addSeries(LightweightCharts.CandlestickSeries, { upColor: '#0b7a53', downColor: '#e5484d', borderVisible: false, wickUpColor: '#0b7a53', wickDownColor: '#e5484d', priceFormat: { type: 'price', precision: c.codigo === 'WDO' ? 1 : 0, minMove: c.tick } });
    // O gráfico é em horário de Brasília: o eixo do LightweightCharts é UTC.
    serie.setData(c.grafico.map((k) => ({ ...k, time: k.time - 3 * 3600 })));
    const posicao = estado.posicoes.find((p) => p.contrato === c.codigo);
    if (posicao) {
      for (const [titulo, preco, cor] of [['Entrada', posicao.entrada, '#2563eb'], ['Stop', posicao.stop, '#e5484d'], ['Alvo', posicao.alvo, '#0b7a53']]) {
        if (Number(preco)) linhas.push(serie.createPriceLine({ price: Number(preco), color: cor, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: titulo }));
      }
    }
    grafico.timeScale().fitContent();
  }

  function desenhar() {
    desenharCotas();
    desenharConta();
    desenharHistorico();
    desenharAjustes();
    desenharBoleta();
    desenharGrafico();
    const avisos = [...(estado.avisos || []), ...(estado.fechadasAgora || []).map((f) => `${f.contrato}: ${f.texto} Resultado ${reais(f.resultado)}.`)];
    if (avisos.length) aviso(q('#b3Msg'), avisos.join(' '), 'b3-info');
    q('#b3Fonte').textContent = `${estado.fonte} Atualizado às ${hora(estado.atualizadoEm)}.`;
  }

  async function carregar() {
    try {
      estado = await api('/api/b3/estado');
      desenhar();
    } catch (error) {
      aviso(q('#b3Msg'), error.message, 'negative');
    }
  }

  function vigiar() {
    clearInterval(relogio);
    relogio = setInterval(() => {
      if (!sec.classList.contains('active')) { clearInterval(relogio); relogio = null; return; }
      carregar();
    }, 15000);
  }

  // ---------- ações ----------
  nav?.addEventListener('click', () => {
    const titulo = document.getElementById('viewTitle');
    if (titulo) titulo.textContent = 'Simulador B3';
    carregar();
    vigiar();
  });
  q('#b3Atualizar').addEventListener('click', carregar);

  sec.addEventListener('click', async (e) => {
    const escolha = e.target.closest('[data-contrato]');
    if (escolha && sec.contains(escolha) && !e.target.closest('.b3-zerar')) {
      contrato = escolha.dataset.contrato;
      if (contrato === 'WDO' && Number(q('#b3Stop').value) > 60) { q('#b3Stop').value = 5; q('#b3Alvo').value = 10; }
      if (contrato === 'WIN' && Number(q('#b3Stop').value) < 25) { q('#b3Stop').value = 150; q('#b3Alvo').value = 300; }
      if (estado) { desenharCotas(); desenharBoleta(); desenharGrafico(); }
      return;
    }
    const zerar = e.target.closest('.b3-zerar');
    if (zerar) {
      zerar.disabled = true;
      try {
        const r = await post('/api/b3/zerar', { id: Number(zerar.dataset.id) });
        aviso(q('#b3Msg'), r.jaTinhaSaido ? `A posição já tinha saído: ${r.texto} Resultado ${reais(r.resultado)}.` : `Zerada a ${pontos(r.saida, r.contrato === 'WDO' ? 1 : 0)}. Resultado ${reais(r.resultado)}.`, Number(r.resultado) >= 0 ? 'positive' : 'negative');
        await carregar();
      } catch (error) {
        aviso(q('#b3Msg'), error.message, 'negative');
        zerar.disabled = false;
      }
    }
  });

  sec.querySelectorAll('.b3-botoes [data-lado]').forEach((botao) => botao.addEventListener('click', async () => {
    const msg = q('#b3Msg');
    aviso(msg, 'Enviando ordem simulada…');
    sec.querySelectorAll('.b3-botoes button').forEach((b) => { b.disabled = true; });
    try {
      const r = await post('/api/b3/ordem', { contrato, lado: botao.dataset.lado, quantidade: Number(q('#b3Qtd').value), stopPontos: Number(q('#b3Stop').value), alvoPontos: q('#b3Alvo').value === '' ? null : Number(q('#b3Alvo').value) });
      aviso(msg, r.texto, 'positive');
      await carregar();
    } catch (error) {
      aviso(msg, error.message, 'negative');
    } finally {
      sec.querySelectorAll('.b3-botoes button').forEach((b) => { b.disabled = false; });
    }
  }));

  ['#b3Qtd', '#b3Stop', '#b3Alvo'].forEach((id) => q(id).addEventListener('input', () => { if (estado) desenharBoleta(); }));

  q('#b3Ajustes').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = q('#b3AjustesMsg');
    try {
      const r = await post('/api/b3/ajustes', { limitePerdaDia: Number(q('#b3Limite').value), maxWIN: Number(q('#b3MaxWIN').value), maxWDO: Number(q('#b3MaxWDO').value), custoWIN: Number(q('#b3CustoWIN').value), custoWDO: Number(q('#b3CustoWDO').value) });
      ajustesPreenchidos = false;
      aviso(msg, `Salvo: trava de ${reais(r.config.limitePerdaDia)} por dia, até ${r.config.maxContratos.WIN} WIN e ${r.config.maxContratos.WDO} WDO por ordem.`, 'positive');
      await carregar();
    } catch (error) {
      aviso(msg, error.message, 'negative');
    }
  });

  q('#b3Reiniciar').addEventListener('click', async () => {
    const msg = q('#b3AjustesMsg');
    const saldo = Number(q('#b3SaldoNovo').value);
    if (!window.confirm(`Apagar todas as operações simuladas e recomeçar com ${reais(saldo)}?`)) return;
    try {
      await post('/api/b3/reiniciar', { saldoInicial: saldo, confirmar: 'REINICIAR' });
      aviso(msg, `Conta simulada recomeçada com ${reais(saldo)}.`, 'positive');
      await carregar();
    } catch (error) {
      aviso(msg, error.message, 'negative');
    }
  });

  q('#b3Leitura').addEventListener('click', async () => {
    const caixa = q('#b3LeituraTexto');
    const botao = q('#b3Leitura');
    botao.disabled = true;
    caixa.innerHTML = '<p class="muted">O Claude está lendo o gráfico…</p>';
    try {
      const r = await post('/api/ai/b3-leitura', { contrato });
      const l = r.leitura;
      const casas = contrato === 'WDO' ? 1 : 0;
      caixa.innerHTML = `<div class="b3-leitura-topo"><span class="tag">${limpo(l.tendencia)}</span><small>${limpo(r.aviso)}</small></div>
        <p>${limpo(l.resumo)}</p>
        <div class="b3-numeros"><div><small>SUPORTE</small><b>${pontos(l.suporte, casas)}</b></div><div><small>RESISTÊNCIA</small><b>${pontos(l.resistencia, casas)}</b></div></div>
        <p><b>Plano para treinar:</b> ${limpo(l.planoParaTreinar)}</p>
        <p class="b3-alerta"><b>Cuidado:</b> ${limpo(l.cuidado)}</p>`;
    } catch (error) {
      caixa.innerHTML = `<p class="negative">${limpo(error.message)}</p>`;
    } finally {
      botao.disabled = false;
    }
  });
})();
