/* =========================================================================
   Bateria · 13 — Modo escuro, modo claro e movimento reduzido

   Duas preferências que a pessoa não escolheu nesta app: já vinham do
   telemóvel. Uma app que não as respeita não é feia — é uma lanterna na cara
   às três da manhã, ou um estroboscópio a quem pediu para o mundo parar.

   Quatro coisas que este módulo persegue de propósito:

   · O CLARÃO DA ABERTURA. Quem escolheu o escuro não pode levar com um
     ecrã branco a cada arranque. Um guião no cabeçalho põe o tema antes de
     qualquer coisa da página — e isso só se prova a ler a cor de fundo no
     instante em que o `<body>` nasce, antes de haver pintura nenhuma. Aqui
     mede-se nos dois sentidos: escuro num sistema claro E claro num sistema
     escuro, porque o clarão ao contrário também existe.

   · A ESCOLHA CONTRA O SISTEMA. Fixar o claro num telemóvel em modo escuro
     é o caso em que a cascata se engana: basta o bloco do `@media` não
     excluir a escolha para o sistema ganhar. Por isso não se lê só o
     `data-tema` — lê-se a cor que saiu no fim.

   · O QUE O TEMA DEIXOU PARA TRÁS. Trocar as cores do documento é metade do
     trabalho: o `theme-color` pinta a barra do sistema numa app instalada e
     o `color-scheme` decide a cor das barras de deslocamento e dos campos
     nativos. Se estes dois ficarem a seguir o telemóvel enquanto o ecrã
     segue a escolha, a app fica com uma faixa do tema errado por cima.

   · O ESTROBOSCÓPIO. Esta app já sabe que `animation-duration: .01ms` não
     pára uma animação infinita — acelera-a até piscar. Por isso não basta
     ver que a regra do movimento reduzido existe: procura-se, com o
     movimento reduzido ligado, qualquer animação que ainda dê voltas
     infinitas — inclusive nas classes que hoje não estão em ecrã nenhum,
     sondadas uma a uma a partir das folhas de estilo.

   · O QUE SE VÊ, NÃO O QUE ESTÁ NO DOM. Trocar de tema troca dezenas de
     pares de cores de uma vez, e é aí que se perde um. Mas a varredura do
     contraste só conta o texto que uma pessoa consegue mesmo ler: no
     cabeçalho do site há cartões empilhados e o de baixo está tapado pelos
     outros — acusá-lo de ilegível seria inventar um defeito.

   Corre em modo de demonstração; o tema vive em `carimbo-demo:tema`.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '13 · Tema, modo escuro e movimento reduzido';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- as duas paletas, tal como o nucleo.css as declara -------------------- */
const PAPEL_CLARO = 'rgb(251, 250, 247)';
const PAPEL_ESCURO = 'rgb(14, 13, 18)';
const TINTA_CLARA = 'rgb(23, 22, 28)';     /* texto no tema claro */
const TINTA_ESCURA = 'rgb(244, 242, 247)'; /* texto no tema escuro */

/* =========================================================================
   Contraste — a WCAG 2 escrita outra vez, de raiz

   Não se importa o `contraste()` da app: um teste que usasse a fórmula dela
   concordaria com um erro dela. E aqui a pergunta é mesmo «isto lê-se?»,
   nos dois temas.
   ========================================================================= */

function corParaRGB(css) {
  const t = String(css).trim();
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
             b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const n = t.match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 };
}

const misturar = (frente, atras, alfa) => ({
  r: frente.r * alfa + atras.r * (1 - alfa),
  g: frente.g * alfa + atras.g * (1 - alfa),
  b: frente.b * alfa + atras.b * (1 - alfa),
});

function luz({ r, g, b }) {
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

const razao = (a, b) => (Math.max(luz(a), luz(b)) + 0.05) / (Math.min(luz(a), luz(b)) + 0.05);

/** O mínimo da WCAG AA: 3 para texto grande, 4,5 para o resto. */
const minimoPara = (px, peso) => (px >= 24 || (px >= 18.66 && peso >= 700) ? 3 : 4.5);

/**
 * Cada pedaço de texto que uma pessoa consegue mesmo ler, com a cor que tem
 * e o fundo em que assenta — subindo até quem pinta mesmo um fundo e
 * multiplicando pelo caminho as opacidades, porque o que chega aos olhos é a
 * mistura.
 *
 * Duas afinações que mudaram o resultado, e por isso ficam explicadas:
 *
 * · MEDE-SE ONDE ESTÃO AS LETRAS, não onde está a caixa. Um `div` ocupa a
 *   largura toda; as letras ocupam um pedaço dela. Pergunta-se ao `Range`
 *   pelas caixas do texto e é aí que se aponta o dedo.
 *
 * · TEXTO TAPADO NÃO CONTA. No cabeçalho do site há três cartões empilhados
 *   e o de baixo está quase todo escondido pelos outros. Acusar de ilegível
 *   o que ninguém vê é gastar a atenção de quem lê o relatório com um
 *   fantasma — e a seguir ninguém acredita nos que são verdadeiros.
 *
 * Como quase tudo numa página fica fora do ecrã, a varredura desce a página
 * aos saltos e vai juntando o que encontra pelo caminho.
 */
const MEDIR_TEXTOS = `
  const opaco = (cor) => { const p = String(cor).match(/[\\d.]+/g);
    return p && (p.length < 4 || Number(p[3]) > 0.95); };

  const caixasDoTexto = (n) => {
    const alcance = document.createRange();
    const caixas = [];
    for (const c of n.childNodes) {
      if (c.nodeType !== 3 || !c.textContent.trim()) continue;
      alcance.selectNodeContents(c);
      for (const b of alcance.getClientRects()) {
        if (b.width >= 2 && b.height >= 2) caixas.push(b);
      }
    }
    return caixas;
  };

  /* Está à vista quem responde a um dedo apontado às suas próprias letras. */
  const legivelAgora = (n) => {
    for (const b of caixasDoTexto(n)) {
      for (const [fx, fy] of [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.3, 0.25], [0.7, 0.75]]) {
        const x = b.left + b.width * fx, y = b.top + b.height * fy;
        if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
        const em = document.elementFromPoint(x, y);
        if (em && (em === n || n.contains(em))) return true;
      }
    }
    return false;
  };

  const medir = (n) => {
    const e = getComputedStyle(n);
    let alfa = Number(e.opacity), p = n.parentElement, fundo = null;
    while (p) {
      const pe = getComputedStyle(p);
      /* Um gradiente ou uma fotografia por baixo não se resolve com uma
         conta — mede-se o que se pode e diz-se que o resto não se mediu. */
      if (pe.backgroundImage !== 'none') { fundo = 'imagem'; break; }
      if (opaco(pe.backgroundColor)) { fundo = pe.backgroundColor; break; }
      alfa *= Number(pe.opacity); p = p.parentElement;
    }
    if (e.backgroundImage !== 'none') fundo = 'imagem';
    else if (opaco(e.backgroundColor)) fundo = e.backgroundColor;
    return {
      onde: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className
        ? '.' + n.className.trim().split(/\\s+/).join('.') : ''),
      texto: n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 28),
      cor: e.color, fundo: fundo || 'rgb(255, 255, 255)', alfa,
      px: parseFloat(e.fontSize), peso: Number(e.fontWeight) || 400,
    };
  };

  const candidatos = [...document.querySelectorAll('body *')].filter((n) =>
    [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
  const colhido = new Map();
  const alturaTotal = Math.max(document.documentElement.scrollHeight, innerHeight);
  const passo = Math.max(120, innerHeight * 0.8);
  const antes = scrollY;
  for (let y = 0; y < alturaTotal + passo; y += passo) {
    /* «instant» de propósito: o site declara deslocamento suave, e com ele a
       posição só chega lá daqui a uns frames — mediríamos o sítio errado. */
    scrollTo({ top: y, behavior: 'instant' });
    document.documentElement.getBoundingClientRect();
    for (let i = 0; i < candidatos.length; i++) {
      if (colhido.has(i)) continue;
      if (!legivelAgora(candidatos[i])) continue;
      colhido.set(i, medir(candidatos[i]));
    }
  }
  scrollTo({ top: antes, behavior: 'instant' });
  return [...colhido.values()];`;

/**
 * Varre a página e devolve o que se mediu e o que reprovou.
 *
 * O `quantos` não é enfeite: é o controlo. Uma varredura que não encontre
 * texto nenhum devolve «zero pares abaixo do mínimo» e passa por boa — que é
 * a pior forma de um teste mentir.
 */
async function varrerContraste(palco) {
  const medidos = await palco.js(MEDIR_TEXTOS);
  return { quantos: medidos.length, maus: reprovados(medidos) };
}

/** Os pares que não chegam ao mínimo, do pior para o menos mau. */
function reprovados(medidos) {
  const maus = [];
  for (const t of medidos) {
    if (t.fundo === 'imagem') continue;
    const cor = corParaRGB(t.cor), fundo = corParaRGB(t.fundo);
    if (!cor || !fundo) continue;
    const efectiva = misturar(cor, fundo, t.alfa * (cor.a ?? 1));
    const c = razao(efectiva, fundo);
    const m = minimoPara(t.px, t.peso);
    if (c < m) maus.push({ c, linha: `${t.onde} «${t.texto}» ${c.toFixed(2)}:1 (pede ${m})` });
  }
  return maus.sort((a, b) => a.c - b.c).map((x) => x.linha);
}

/* =========================================================================
   Ler o tema que está em vigor
   ========================================================================= */

const olharTema = (palco) => palco.js(`
  const html = getComputedStyle(document.documentElement);
  const corpo = getComputedStyle(document.body);
  const b = document.querySelector('#botao-tema');
  return {
    dataset: document.documentElement.dataset.tema || null,
    guardado: localStorage.getItem('carimbo-demo:tema'),
    fundo: corpo.backgroundColor,
    tinta: corpo.color,
    esquema: html.colorScheme,
    /* O sol tem um <circle>; a lua é só um <path>. É como se distinguem. */
    icone: b ? (/<circle/.test(b.innerHTML) ? 'sol' : 'lua') : null,
    /* Só uma das etiquetas está em vigor de cada vez — a que casa com o meio. */
    barraSistema: [...document.querySelectorAll('meta[name="theme-color"]')]
      .filter((m) => !m.media || matchMedia(m.media).matches).map((m) => m.content).pop() || null,
  }`);

/* =========================================================================
   Animações

   `getAnimations()` diz o que está mesmo a correr agora; os estilos
   computados dizem o que a folha promete a cada elemento. Precisa-se dos
   dois: o primeiro apanha o que uma pintura acabou de arrancar, o segundo
   apanha o que ainda vai arrancar.
   ========================================================================= */

const ANIMADAS = `
  const fora = [];
  for (const n of document.querySelectorAll('body, body *')) {
    const e = getComputedStyle(n);
    for (const pseudo of ['', '::before', '::after']) {
      const s = pseudo ? getComputedStyle(n, pseudo) : e;
      if (s.animationName === 'none' || !s.animationName) continue;
      fora.push({
        onde: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className
          ? '.' + n.className.trim().split(/\\s+/).join('.') : '') + pseudo,
        nome: s.animationName, dur: s.animationDuration, voltas: s.animationIterationCount,
      });
    }
  }
  return fora;`;

/* O `Infinity` não sobrevive à viagem de volta (vira `null`); troca-se por
   uma palavra ainda dentro da página. */
const ACORRER = `
  return document.getAnimations().map((a) => {
    const t = a.effect ? a.effect.getTiming() : {};
    return {
      estado: a.playState,
      nome: a.animationName || a.transitionProperty || 'sem nome',
      voltas: t.iterations === Infinity ? 'infinite' : (t.iterations ?? 1),
      ms: Number(t.duration) || 0,
    };
  });`;

/**
 * Todas as regras das folhas de estilo que declaram uma animação.
 *
 * Cuidado com a travessia: no Chrome de hoje uma `CSSStyleRule` também tem
 * `cssRules` (é o aninhamento de CSS). Quem pergunta primeiro por `cssRules`
 * trata cada regra normal como um grupo, salta-a, e a varredura devolve zero
 * — verde de mentira. Pergunta-se primeiro pelo selector.
 */
const REGRAS_COM_ANIMACAO = `
  const fora = [];
  const andar = (regras, meio) => {
    for (const r of regras) {
      if (r.selectorText) {
        if (/animation/.test(r.style.cssText)) {
          fora.push({ sel: r.selectorText, meio,
            dur: r.style.animationDuration || '', nome: r.style.animationName || '',
            css: r.style.cssText.replace(/\\s+/g, ' ').slice(0, 120) });
        }
        if (r.cssRules && r.cssRules.length) andar(r.cssRules, meio);
        continue;
      }
      if (r.cssRules && r.constructor.name !== 'CSSKeyframesRule') {
        andar(r.cssRules, r.conditionText ? ((meio ? meio + ' & ' : '') + r.conditionText) : meio);
      }
    }
  };
  for (const f of document.styleSheets) {
    try { andar(f.cssRules, ''); } catch (e) { fora.push({ sel: '(folha inacessível)', meio: '', css: String(f.href) }); }
  }
  return fora;`;

/**
 * Uma sonda por selector: fabrica um elemento que case com o último composto
 * («.esqueleto», «.carimbo[data-novo="sim"]») e lê-lhe o estilo computado.
 * É a única forma de provar uma classe que hoje não está em ecrã nenhum — e
 * `.esqueleto`, a única animação infinita desta app, é exactamente essa.
 */
const SONDA = `
  window.__sonda = (sel) => {
    const um = sel.split(',')[0].trim();
    const comp = um.split(/[\\s>+~]+/).filter(Boolean).pop() || '';
    const pseudo = (comp.match(/::[a-z-]+$/) || [''])[0];
    const limpo = comp.replace(/::[a-z-]+$/, '');
    const etiqueta = (limpo.match(/^[a-z][a-z0-9-]*/i) || [''])[0];
    const n = document.createElement(etiqueta || 'div');
    for (const c of limpo.match(/\\.[A-Za-z0-9_-]+/g) || []) n.classList.add(c.slice(1));
    for (const a of limpo.match(/\\[[^\\]]+\\]/g) || []) {
      const m = a.slice(1, -1).match(/^([^=]+)(?:=["']?([^"']*)["']?)?$/);
      if (m) n.setAttribute(m[1], m[2] ?? '');
    }
    n.style.position = 'fixed'; n.style.left = '-9999px'; n.style.top = '0';
    n.textContent = '.';
    document.body.append(n);
    const e = getComputedStyle(n, pseudo || undefined);
    const r = { nome: e.animationName, dur: e.animationDuration, voltas: e.animationIterationCount };
    n.remove();
    return r;
  };
  return true`;

/** Segundos de uma duração de CSS («1.4s», «620ms»). */
function segundos(texto) {
  const t = String(texto).split(',')[0].trim();
  if (t.endsWith('ms')) return parseFloat(t) / 1000;
  return parseFloat(t) || 0;
}

/** Sonda todos os selectores animados da página e devolve o que sobrou vivo. */
async function sondarTodos(palco) {
  const regras = await palco.js(REGRAS_COM_ANIMACAO);
  await palco.js(SONDA);
  const sels = [...new Set(regras.map((r) => r.sel))];
  const lidas = await palco.js(`const sels = ${JSON.stringify(sels)};
    return sels.map((s) => ({ sel: s, ...window.__sonda(s) }));`);
  return { regras, sondas: lidas };
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* =======================================================================
     1 · A app segue o tema do sistema
     O tema emula-se ANTES de navegar: é assim que a pessoa abre a app, com
     o telemóvel já em modo escuro, e não a meio.
     ======================================================================= */

  await palco.tema('light');
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra');

  const abriuClaro = await olharTema(palco);
  certo(abriuClaro.fundo === PAPEL_CLARO && abriuClaro.tinta === TINTA_CLARA,
    'abrir com o telemóvel em claro: a app abre clara', JSON.stringify(abriuClaro));

  /* Agora o mesmo com o telemóvel escuro, e a abrir de novo — não a mudar a
     meio. É o caso da pessoa que tem o modo escuro ligado desde sempre. */
  await palco.tema('dark');
  await palco.ir('/app/?demo=1');
  await palco.esperar('#barra');
  await palco.captura('13-app-escuro-do-sistema');

  const sistemaEscuro = await olharTema(palco);
  certo(sistemaEscuro.dataset === null && sistemaEscuro.guardado === null,
    'sistema escuro: sem escolha feita, a app não marca nada no html',
    JSON.stringify(sistemaEscuro));
  certo(sistemaEscuro.fundo === PAPEL_ESCURO,
    'sistema escuro: o fundo da app é escuro sem ninguém ter pedido',
    String(sistemaEscuro.fundo));
  certo(sistemaEscuro.tinta === TINTA_ESCURA,
    'sistema escuro: e o texto clareia com ele', String(sistemaEscuro.tinta));
  certo(sistemaEscuro.barraSistema === '#0E0D12',
    'sistema escuro: a barra do sistema (theme-color) também escurece',
    String(sistemaEscuro.barraSistema));
  certo(sistemaEscuro.icone === 'sol',
    'sistema escuro: o botão mostra o sol — o que se ganha ao tocar-lhe',
    String(sistemaEscuro.icone));

  /* O telemóvel passa a claro com a app aberta (é o que o relógio do
     sistema faz ao nascer do sol). A app tem de acompanhar, inteira. */
  await palco.tema('light');
  const sistemaClaro = await olharTema(palco);
  certo(sistemaClaro.fundo === PAPEL_CLARO,
    'o sistema passou a claro: a app clareia sem ser preciso recarregar',
    String(sistemaClaro.fundo));
  certo(sistemaClaro.tinta === TINTA_CLARA,
    'o sistema passou a claro: e o texto escurece', String(sistemaClaro.tinta));
  certo(sistemaClaro.barraSistema === '#FBFAF7',
    'o sistema passou a claro: a barra do sistema acompanha',
    String(sistemaClaro.barraSistema));
  /* O ícone é desenhado uma vez, no arranque, a partir do `matchMedia`.
     Se ninguém ouvir a mudança, fica a prometer o contrário do que faz. */
  certo(sistemaClaro.icone === 'lua',
    'o sistema passou a claro: o botão passa a mostrar a lua',
    `mostra a ${sistemaClaro.icone}`);

  /* =======================================================================
     2 · O botão: sistema → claro → escuro → sistema
     ======================================================================= */

  await palco.clicar('#botao-tema');
  const um = await olharTema(palco);
  certo(um.dataset === 'claro' && um.guardado === '"claro"',
    'botão, 1.º toque: fixa o claro e guarda a escolha', JSON.stringify(um));
  certo(um.fundo === PAPEL_CLARO,
    'botão, 1.º toque: e o ecrã fica claro', String(um.fundo));

  await palco.clicar('#botao-tema');
  const dois = await olharTema(palco);
  certo(dois.dataset === 'escuro' && dois.guardado === '"escuro"',
    'botão, 2.º toque: fixa o escuro', JSON.stringify(dois));
  certo(dois.fundo === PAPEL_ESCURO && dois.tinta === TINTA_ESCURA,
    'botão, 2.º toque: o ecrã escurece mesmo, com o sistema em claro',
    `${dois.fundo} / ${dois.tinta}`);
  certo(dois.icone === 'sol',
    'botão, 2.º toque: o ícone acompanha a escolha', String(dois.icone));
  await palco.captura('13-app-escuro-por-escolha');

  await palco.clicar('#botao-tema');
  const tres = await olharTema(palco);
  certo(tres.dataset === null && tres.guardado === '"sistema"',
    'botão, 3.º toque: devolve a escolha ao sistema e o ciclo fecha',
    JSON.stringify(tres));
  certo(tres.fundo === PAPEL_CLARO,
    'botão, 3.º toque: o ecrã volta ao que o telemóvel manda (claro)',
    String(tres.fundo));

  /* =======================================================================
     3 · A escolha ganha ao sistema, e aguenta-se depois de recarregar
     ======================================================================= */

  await palco.clicar('#botao-tema');           /* claro   */
  await palco.clicar('#botao-tema');           /* escuro  */
  await palco.tema('dark');
  await palco.clicar('#botao-tema');           /* sistema */
  await palco.clicar('#botao-tema');           /* claro, contra um sistema escuro */

  const contraCorrente = await olharTema(palco);
  certo(contraCorrente.dataset === 'claro' && contraCorrente.fundo === PAPEL_CLARO,
    'escolha contra o sistema: o claro escolhido ganha a um telemóvel escuro',
    JSON.stringify(contraCorrente));

  await palco.recarregar();
  await palco.esperar('#barra');
  const depoisDaRecarga = await olharTema(palco);
  certo(depoisDaRecarga.dataset === 'claro' && depoisDaRecarga.guardado === '"claro"',
    'recarregar: a escolha continua guardada', JSON.stringify(depoisDaRecarga));
  certo(depoisDaRecarga.fundo === PAPEL_CLARO,
    'recarregar: e continua a ganhar ao tema do sistema',
    String(depoisDaRecarga.fundo));

  /* =======================================================================
     4 · Sem clarão ao arrancar

     O guião do cabeçalho promete pôr o tema antes de a página pintar. Prova-
     se a espiar o momento exacto em que o `<body>` nasce: aí ainda não houve
     pintura nenhuma, e a cor de fundo que já estiver calculada é a cor que a
     pessoa vai ver. Mede-se nas duas direcções — o clarão branco de quem
     escolheu escuro, e o escurão de quem escolheu claro.
     ======================================================================= */

  const espia = await palco.enviar('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__pintura = { corpoNasceu: null, temaNoNascimento: null, primeiroFrame: null };
      new MutationObserver((_, obs) => {
        if (!document.body) return;
        window.__pintura.corpoNasceu = getComputedStyle(document.body).backgroundColor;
        window.__pintura.temaNoNascimento = document.documentElement.dataset.tema || null;
        obs.disconnect();
      }).observe(document.documentElement || document, { childList: true, subtree: true });
      requestAnimationFrame(() => {
        window.__pintura.primeiroFrame = document.body
          ? getComputedStyle(document.body).backgroundColor : null;
      });`,
  }, palco.sessao);

  /* (a) escuro escolhido, telemóvel claro — o clarão branco clássico */
  await palco.tema('light');
  await palco.js(`localStorage.setItem('carimbo-demo:tema', '"escuro"'); return true`);
  await palco.recarregar();
  await palco.esperar('#barra');
  const arranqueEscuro = await palco.js('return window.__pintura');
  certo(arranqueEscuro && arranqueEscuro.temaNoNascimento === 'escuro',
    'arranque escuro: o tema já está no <html> quando o <body> nasce',
    JSON.stringify(arranqueEscuro));
  certo(arranqueEscuro && arranqueEscuro.corpoNasceu === PAPEL_ESCURO,
    'arranque escuro: o fundo do body já é escuro à nascença — nada de clarão branco',
    JSON.stringify(arranqueEscuro));
  certo(arranqueEscuro && arranqueEscuro.primeiroFrame === PAPEL_ESCURO,
    'arranque escuro: e continua escuro no primeiro frame pintado',
    JSON.stringify(arranqueEscuro));

  /* --- o que sobra claro à volta do ecrã escuro -------------------------- */

  /* O documento escureceu. Falta o que não é documento: a faixa do sistema
     por cima (numa app instalada é ela que emoldura o ecrã todo) e as
     superfícies que o browser pinta sozinho — barras de deslocamento, campos
     nativos, o fundo do sobre-deslize. As cores de sistema do CSS (`Canvas`,
     `CanvasText`) dizem exactamente com que tema o browser está a pintá-las:
     é a prova, e não uma suposição. */
  const bordas = await palco.js(`
    const sonda = document.createElement('div');
    sonda.style.cssText = 'position:fixed;left:-9999px;color:CanvasText;background:Canvas';
    document.body.append(sonda);
    const e = getComputedStyle(sonda);
    const r = { nativoFundo: e.backgroundColor, nativoTinta: e.color };
    sonda.remove();
    return r`);
  const escuroEscolhido = await olharTema(palco);

  certo(escuroEscolhido.barraSistema === '#0E0D12',
    'escuro escolhido: a faixa do sistema (theme-color) segue a escolha, não o telemóvel',
    `o ecrã é escuro e a theme-color em vigor é ${escuroEscolhido.barraSistema}`);
  certo(escuroEscolhido.esquema === 'dark',
    'escuro escolhido: o color-scheme segue a escolha',
    `color-scheme = ${escuroEscolhido.esquema}`);
  const nativo = corParaRGB(bordas.nativoFundo);
  certo(!!nativo && luz(nativo) < 0.2,
    'escuro escolhido: as superfícies que o browser pinta sozinho (barras, campos nativos) também escurecem',
    `Canvas = ${bordas.nativoFundo}, CanvasText = ${bordas.nativoTinta}`);

  /* (b) claro escolhido, telemóvel escuro — o mesmo defeito ao contrário */
  await palco.tema('dark');
  await palco.js(`localStorage.setItem('carimbo-demo:tema', '"claro"'); return true`);
  await palco.recarregar();
  await palco.esperar('#barra');
  const arranqueClaro = await palco.js('return window.__pintura');
  certo(arranqueClaro && arranqueClaro.corpoNasceu === PAPEL_CLARO
    && arranqueClaro.primeiroFrame === PAPEL_CLARO,
    'arranque claro: quem escolheu claro num telemóvel escuro também não leva com um flash',
    JSON.stringify(arranqueClaro));

  await palco.enviar('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: espia.identifier }, palco.sessao).catch(() => {});

  /* =======================================================================
     5 · A carteira lê-se nos dois temas

     Trocar dez variáveis de cor é fácil; o caro é um par que sobreviva à
     troca por acaso. Mede-se o que está no ecrã, com a paleta de um lado e
     com a do outro.
     ======================================================================= */

  /* A escolha põe-se na gaveta em vez de se carregar duas vezes no botão: já
     ficou provado lá atrás que o botão a escreve lá, e aqui o que interessa é
     a paleta que sai — não o caminho até ela. */
  for (const [emulado, escolha, etiqueta] of [
    ['light', 'claro', 'claro'], ['dark', 'escuro', 'escuro']]) {
    await palco.tema(emulado);
    await palco.js(`localStorage.setItem('carimbo-demo:tema', '"${escolha}"'); return true`);
    await palco.recarregar();
    await palco.esperar('#principal .pilha .cartao', 10000);
    const { quantos, maus } = await varrerContraste(palco);
    certo(quantos >= 20,
      `app · tema ${etiqueta}: a varredura encontrou texto para medir`,
      `mediu ${quantos} pedaços de texto`);
    certo(maus.length === 0,
      `app · tema ${etiqueta}: os ${quantos} pedaços de texto da carteira passam o mínimo da WCAG`,
      `${maus.length} pares abaixo — ${maus.slice(0, 4).join(' · ')}`);
  }

  /* =======================================================================
     6 · Movimento reduzido

     Primeiro o controlo: se a emulação não chegasse à página, tudo o que
     vem a seguir passaria por não haver animação nenhuma para encontrar.
     ======================================================================= */

  await palco.js(`localStorage.removeItem('carimbo-demo:tema'); return true`);
  await palco.tema('light');
  await palco.movimento('no-preference');
  await palco.recarregar();
  await palco.esperar('#barra');

  const comMovimento = await sondarTodos(palco);
  const infinitasNormais = comMovimento.sondas.filter((s) => s.voltas === 'infinite');
  certo(comMovimento.sondas.some((s) => s.nome !== 'none'),
    'controlo: com movimento normal a app tem mesmo animações para travar',
    `${comMovimento.sondas.filter((s) => s.nome !== 'none').length} de ${comMovimento.sondas.length} selectores animam`);
  certo(infinitasNormais.length > 0,
    'controlo: e pelo menos uma delas dá voltas infinitas (o esqueleto de carregamento)',
    infinitasNormais.map((s) => `${s.sel} ${s.nome} ${s.dur}`).join(' · '));

  const transicaoNormal = await palco.estilo('.saltar', 'transition-duration');

  /* E o segundo controlo: o contador de animações vivas tem de conseguir ver
     alguma coisa. Sem isto, «nada estava a mexer-se» podia ser só um
     instrumento avariado a dizer que sim a tudo. */
  await palco.clicar('.barra-item:nth-child(3)');
  await palco.esperar('#folha-codigo', 8000);
  const vivasNormais = await palco.js(ACORRER);
  certo(vivasNormais.length > 0,
    'controlo: com movimento normal o contador de animações vê o ecrã do código a entrar',
    `${vivasNormais.length} animações — ${vivasNormais.slice(0, 3).map((a) => a.nome).join(', ')}`);
  await palco.clicar('.codigo-fechar');
  await palco.sumir('#folha-codigo', 4000);

  await palco.movimento('reduce');
  await dormir(150);
  const transicaoTravada = await palco.estilo('.saltar', 'transition-duration');
  certo(segundos(transicaoNormal) > 0.05 && segundos(transicaoTravada) <= 0.01,
    'controlo: com movimento reduzido as transições encolhem — a preferência chega mesmo à página',
    `${transicaoNormal} → ${transicaoTravada}`);
  certo(await palco.estilo('html', 'scroll-behavior') === 'auto',
    'movimento reduzido: o deslocamento suave da página também pára',
    String(await palco.estilo('html', 'scroll-behavior')));

  /* --- nenhuma animação sobrevive, nem as que não estão em ecrã ---------- */

  const travado = await sondarTodos(palco);

  /* Uma folha que não se deixe ler deixa um buraco na varredura — e o buraco
     aparece como «não há animações infinitas», que é o que se quer ouvir. */
  const fechadas = travado.regras.filter((r) => r.sel === '(folha inacessível)');
  certo(fechadas.length === 0,
    'movimento reduzido: as folhas de estilo estão todas legíveis a partir da página',
    fechadas.map((r) => r.css).join(' · '));

  const infinitas = travado.sondas.filter((s) => s.voltas === 'infinite');
  certo(infinitas.length === 0,
    'movimento reduzido: nenhum selector das folhas de estilo continua a dar voltas infinitas',
    infinitas.map((s) => `${s.sel} → ${s.nome} ${s.dur} ×${s.voltas}`).join(' · '));

  /* O defeito que já mordeu esta app: a animação infinita não parada, só
     acelerada, vira estroboscópio. Procura-se a forma exacta. */
  const estroboscopio = travado.sondas.filter((s) =>
    s.nome !== 'none' && s.voltas === 'infinite' && segundos(s.dur) < 0.1);
  certo(estroboscopio.length === 0,
    'movimento reduzido: nenhuma animação infinita foi acelerada até piscar em vez de parar',
    estroboscopio.map((s) => `${s.sel} ${s.dur} ×${s.voltas}`).join(' · '));

  /* E a mesma pergunta às regras, não às sondas: um bloco de movimento
     reduzido que carregue uma duração minúscula é o próprio erro escrito. */
  const blocosReduzidos = travado.regras.filter((r) => /reduced-motion/.test(r.meio));
  certo(blocosReduzidos.length > 0,
    'movimento reduzido: as folhas de estilo têm mesmo um bloco para a preferência',
    `${blocosReduzidos.length} regras`);
  const duracaoCurta = blocosReduzidos.filter((r) =>
    r.dur && segundos(r.dur) > 0 && segundos(r.dur) < 0.1 && !/none/.test(r.nome || ''));
  certo(duracaoCurta.length === 0,
    'movimento reduzido: o bloco cancela as animações em vez de lhes cortar a duração',
    duracaoCurta.map((r) => `${r.sel} ${r.css}`).join(' · '));

  /* --- e nos ecrãs a sério, com painéis abertos -------------------------- */

  const ecras = [
    ['carteira', async () => { await palco.clicar('.barra-item:nth-child(1)'); }],
    ['prémios', async () => { await palco.clicar('.barra-item:nth-child(4)'); }],
    ['código', async () => {
      await palco.clicar('.barra-item:nth-child(3)');
      await palco.esperar('#folha-codigo', 8000);
    }],
  ];

  for (const [onde, ir] of ecras) {
    await ir();
    await dormir(250);
    const vivas = await palco.js(ANIMADAS);
    certo(vivas.length === 0,
      `movimento reduzido · ${onde}: nenhum elemento do ecrã ficou com animação`,
      vivas.slice(0, 4).map((v) => `${v.onde} ${v.nome} ${v.dur} ×${v.voltas}`).join(' · '));

    /* Uma leitura só apanharia uma fresta. Amostra-se ao longo de um segundo
       e afirma-se sobre o conjunto.
       O que se procura é movimento que a pessoa chegue a ver: uma transição
       encolhida para 1 ms é a preferência a ser respeitada, não desrespeitada
       — se entrasse nesta conta, o teste acusava de avariado o próprio
       remédio, e ainda por cima só de vez em quando. */
    const amostras = [];
    for (let i = 0; i < 4; i++) {
      amostras.push(await palco.js(ACORRER));
      await dormir(260);
    }
    const aMexer = amostras.flat().filter((a) => a.estado === 'running'
      && (a.voltas === 'infinite' || a.voltas > 1 || a.ms > 100));
    certo(aMexer.length === 0,
      `movimento reduzido · ${onde}: em quatro leituras ao longo de um segundo nada estava a mexer-se`,
      aMexer.slice(0, 4).map((a) => `${a.nome} ×${a.voltas} ${a.ms}ms (${a.estado})`).join(' · '));
  }

  await palco.captura('13-codigo-sem-movimento');
  await palco.clicar('.codigo-fechar');
  await palco.sumir('#folha-codigo', 4000);

  /* --- os confetes, que a app promete não atirar ------------------------- */

  /* Chama-se a função do núcleo directamente: os confetes só nascem quando um
     cartão se completa ao balcão, e o que se quer provar aqui é a guarda, não
     o caminho até lá. */
  const confetesTravados = await palco.js(`
    const m = await import('../js/nucleo.js');
    m.confetes();
    const houve = document.querySelectorAll('.confetes .confete').length;
    for (const c of document.querySelectorAll('.confetes')) c.remove();
    return houve;`);
  certo(confetesTravados === 0,
    'movimento reduzido: os confetes não caem a quem pediu menos movimento',
    `caíram ${confetesTravados}`);

  await palco.movimento('no-preference');
  const confetesNormais = await palco.js(`
    const m = await import('../js/nucleo.js');
    m.confetes();
    const pecas = [...document.querySelectorAll('.confetes .confete')];
    const e = pecas[0] ? getComputedStyle(pecas[0]) : null;
    const r = { quantos: pecas.length, voltas: e ? e.animationIterationCount : null,
                dur: e ? e.animationDuration : null };
    for (const c of document.querySelectorAll('.confetes')) c.remove();
    return r;`);
  certo(confetesNormais.quantos > 0,
    'controlo: com movimento normal os confetes caem mesmo',
    JSON.stringify(confetesNormais));
  certo(confetesNormais.voltas === '1',
    'confetes: caem uma vez e só uma — nunca em ciclo',
    JSON.stringify(confetesNormais));

  /* =======================================================================
     7 · O site e o cartaz, nos dois temas

     O site não tem botão de tema: segue o telemóvel e mais nada. O cartaz é
     para imprimir — a folha tem de sair igual, venha o leitor de que tema
     vier, porque o papel não tem modo escuro.
     ======================================================================= */

  await palco.tamanho(1280, 900);

  for (const [caminho, etiqueta] of [['/', 'início'], ['/negocios/', 'negócios']]) {
    await palco.tema('light');
    await palco.ir(caminho);
    const claroSite = await palco.js(`return {
      fundo: getComputedStyle(document.body).backgroundColor,
      tinta: getComputedStyle(document.body).color }`);
    const claro = await varrerContraste(palco);

    await palco.tema('dark');
    await dormir(200);
    const escuroSite = await palco.js(`return {
      fundo: getComputedStyle(document.body).backgroundColor,
      tinta: getComputedStyle(document.body).color }`);
    const escuro = await varrerContraste(palco);
    await palco.captura(`13-site-${etiqueta}-escuro`);

    certo(claroSite.fundo === PAPEL_CLARO && claroSite.tinta === TINTA_CLARA,
      `site · ${etiqueta}: com o sistema claro é papel claro e tinta escura`,
      JSON.stringify(claroSite));
    certo(escuroSite.fundo === PAPEL_ESCURO && escuroSite.tinta === TINTA_ESCURA,
      `site · ${etiqueta}: com o sistema escuro vira papel escuro e tinta clara`,
      JSON.stringify(escuroSite));
    certo(claro.quantos >= 25 && escuro.quantos >= 25,
      `site · ${etiqueta}: a varredura encontrou texto para medir nos dois temas`,
      `claro ${claro.quantos}, escuro ${escuro.quantos}`);
    certo(claro.maus.length === 0,
      `site · ${etiqueta}: no tema claro os ${claro.quantos} pedaços de texto passam o mínimo da WCAG`,
      `${claro.maus.length} pares abaixo — ${claro.maus.slice(0, 4).join(' · ')}`);
    certo(escuro.maus.length === 0,
      `site · ${etiqueta}: e no tema escuro também`,
      `${escuro.maus.length} pares abaixo — ${escuro.maus.slice(0, 4).join(' · ')}`);
  }

  /* --- o cartaz --------------------------------------------------------- */

  /* Duas cores, ambas de comerciantes que a demonstração usa: o roxo da casa
     (que a `marcaSegura` deixa passar tal e qual) e o azul da gelataria (que
     ela tem de escurecer até a tinta branca aguentar). São casos diferentes:
     no segundo a cor sai da conta encostada ao mínimo, e qualquer opacidade
     posta a seguir cai para baixo dele. */
  const cartazes = [
    ['sem cor pedida (o roxo da casa)', ''],
    ['com a cor de um comerciante claro', '&c=%233F8FC0'],
  ];
  const CARTAZ_BASE = '/balcao/cartaz.html?n=Caf%C3%A9%20Torrado'
    + '&p=Um%20caf%C3%A9%20por%20conta%20da%20casa&s=cafe-torrado';
  const olharCartaz = () => palco.js(`
    const folha = document.getElementById('folha');
    const quadro = document.querySelector('.quadro');
    return {
      folhaFundo: getComputedStyle(folha).backgroundColor,
      folhaTinta: getComputedStyle(folha).color,
      quadroFundo: quadro ? getComputedStyle(quadro).backgroundColor : null,
      qr: document.querySelectorAll('.quadro svg').length,
      corpo: getComputedStyle(document.body).backgroundColor,
    }`);

  for (const [etiqueta, cor] of cartazes) {
    await palco.tema('light');
    await palco.ir(CARTAZ_BASE + cor, { esperarPor: '.quadro svg' });
    const cartazClaro = await olharCartaz();
    const claro = await varrerContraste(palco);

    await palco.tema('dark');
    await dormir(200);
    const cartazEscuro = await olharCartaz();
    const escuro = await varrerContraste(palco);
    await palco.captura(`13-cartaz-escuro${cor ? '-cor' : ''}`);

    certo(cartazClaro.qr === 1,
      `cartaz ${etiqueta}: o código sai desenhado`, `${cartazClaro.qr} svg`);
    certo(cartazEscuro.folhaFundo === cartazClaro.folhaFundo
      && cartazEscuro.folhaTinta === cartazClaro.folhaTinta,
      `cartaz ${etiqueta}: a folha que se imprime sai igual nos dois temas — o papel não tem modo escuro`,
      `claro ${cartazClaro.folhaFundo}/${cartazClaro.folhaTinta} vs escuro ${cartazEscuro.folhaFundo}/${cartazEscuro.folhaTinta}`);
    certo(cartazEscuro.quadroFundo === 'rgb(255, 255, 255)',
      `cartaz ${etiqueta}: o quadro do código continua branco no tema escuro — um QR precisa do contraste todo`,
      String(cartazEscuro.quadroFundo));
    certo(claro.quantos >= 5 && escuro.quantos >= 5,
      `cartaz ${etiqueta}: a varredura encontrou texto para medir nos dois temas`,
      `claro ${claro.quantos}, escuro ${escuro.quantos}`);
    certo(claro.maus.length === 0,
      `cartaz ${etiqueta}: no tema claro os ${claro.quantos} pedaços de texto do cartaz lêem-se`,
      `${claro.maus.length} pares abaixo — ${claro.maus.slice(0, 4).join(' · ')}`);
    certo(escuro.maus.length === 0,
      `cartaz ${etiqueta}: e no tema escuro também`,
      `${escuro.maus.length} pares abaixo — ${escuro.maus.slice(0, 4).join(' · ')}`);

    /* O cartaz declara `color-scheme: light` — diz, por escrito, que é uma
       página de papel. Se o que a rodeia escurecer com o telemóvel, a
       declaração e o ecrã contam histórias diferentes, e as barras de
       deslocamento ficam do tema que a folha diz não ter. */
    certo(cartazEscuro.corpo === cartazClaro.corpo,
      `cartaz ${etiqueta}: a página que segura a folha respeita o «color-scheme: light» que declara`,
      `claro ${cartazClaro.corpo} vs escuro ${cartazEscuro.corpo}`);
  }

  /* --- e o movimento reduzido também vale fora da app ------------------- */

  await palco.movimento('reduce');
  await dormir(150);
  for (const [caminho, etiqueta] of [['/', 'site'], [CARTAZ_BASE, 'cartaz']]) {
    await palco.ir(caminho);
    const fora = await sondarTodos(palco);
    const vivas = fora.sondas.filter((s) => s.voltas === 'infinite');
    certo(vivas.length === 0,
      `movimento reduzido · ${etiqueta}: nada continua a andar em ciclo infinito`,
      vivas.map((s) => `${s.sel} → ${s.nome} ${s.dur}`).join(' · '));
    const noEcra = await palco.js(ANIMADAS);
    certo(noEcra.length === 0,
      `movimento reduzido · ${etiqueta}: nenhum elemento do ecrã ficou com animação`,
      noEcra.slice(0, 4).map((v) => `${v.onde} ${v.nome} ${v.dur}`).join(' · '));
  }

  await palco.tamanho(390, 844);
}
