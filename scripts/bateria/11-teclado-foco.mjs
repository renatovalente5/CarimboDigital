/* =========================================================================
   Bateria · 11 — Teclado, foco e alvos de toque

   Esta app vive num telemóvel, e por isso é fácil esquecer que também se
   conduz por teclado: um leitor de ecrã tabula, um teclado de Bluetooth
   tabula, e quem tem tremor usa um comutador que não faz outra coisa senão
   tabular. Tudo o que se testa aqui é a mesma pergunta feita de cinco
   maneiras: **dá para usar isto sem apontar o dedo a nada?**

   Três coisas que este módulo persegue de propósito:

   · O DIÁLOGO QUE NÃO É DIÁLOGO. Escrever `role="dialog" aria-modal="true"`
     é uma promessa de três partes — o foco entra, o foco não sai enquanto
     estiver aberto, e o Escape fecha. Um painel que só cumpre a primeira
     linha do HTML mente ao leitor de ecrã: ele anuncia «diálogo», declara o
     resto da página inexistente, e o teclado continua a passear por trás do
     véu, a carregar em botões que ninguém vê.

   · O FOCO QUE SE PERDE. Fechar um painel apaga o elemento que tinha o foco.
     Se ninguém o devolve, ele cai no `body` — e a tabulação seguinte volta ao
     PRINCÍPIO do documento. Quem estava no quinto botão de uma lista tem de
     lá voltar a pé. Não dá erro, não se vê numa fotografia, e é das coisas
     que mais depressa fazem desistir.

   · O ALVO PEQUENO DEMAIS. O CSS desta app escreve, em letras, «min-height:
     48px — WCAG 2.2 alvo mínimo, com folga». Mede-se se é verdade. Um botão
     de 27 px de altura encostado a um cartão inteiro é um botão que se falha,
     e falhar ao lado de «Juntar» quer dizer abrir o cartão errado.

   Duas notas sobre o método:

   · As teclas são teclas a sério, mandadas pelo protocolo do browser, com o
     modificador Shift quando é preciso andar para trás. Um `elemento.focus()`
     não prova ordem nenhuma — prova que o JavaScript sabe onde está o
     elemento, que não é a pergunta.

   · Nada aqui se mede num instante só. A página rola com `scroll-behavior:
     smooth` e os campos mudam de contorno com uma transição de 200 ms: quem
     medisse logo a seguir à tecla acusava de avariado o que está a meio de
     acontecer. Espera-se que a página assente antes de olhar.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '11 · Teclado, foco e alvos de toque';
export const desculpar = [/favicon/];

/* O mínimo do alvo de toque: 44 é o chão (WCAG 2.5.5, e a regra da Apple);
   48 é o que o nucleo.css promete por escrito e o que o Android pede. */
const MINIMO = 44;
const PROMETIDO = 48;

/* As variantes pequenas descem a 44 de propósito — 44 é a medida da Apple e
   o mínimo que um polegar quer. O que não pode acontecer é uma delas descer
   abaixo disso: aí a promessa da classe deixa de valer nada justamente onde
   é mais precisa. */
const forade = (lista) => lista.filter((a) =>
  !/pequeno|voltar/.test(String(a.tipo || '')) || Number(a.altura) < MINIMO);

/* =========================================================================
   Contraste — outra vez escrito de raiz

   O anel de foco tem de se ver contra o que tem por baixo (a WCAG 1.4.11
   pede 3:1). Não se importa o `contraste()` da app de propósito: se a fórmula
   dela estivesse errada, um teste que a usasse concordava com o erro.
   ========================================================================= */

function corParaRGB(css) {
  const n = String(css).match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 };
}

function luz({ r, g, b }) {
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

function razao(a, b) {
  const la = luz(a), lb = luz(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* =========================================================================
   Teclado

   O `palco.tecla()` não sabe modificadores, e sem Shift+Tab não há forma de
   provar que o cabeçalho vem antes do conteúdo. Manda-se o evento pelo mesmo
   canal que ele usa — `modifiers: 8` é o Shift.
   ========================================================================= */

async function tab(palco, { tras = false } = {}) {
  const tecla = {
    windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    code: 'Tab', key: 'Tab', modifiers: tras ? 8 : 0,
  };
  await palco.enviar('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...tecla }, palco.sessao);
  await palco.enviar('Input.dispatchKeyEvent', { type: 'keyUp', ...tecla }, palco.sessao);
  await palco.js('await new Promise((r) => setTimeout(r, 45)); return true');
}

const dormir = (palco, ms) =>
  palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);

/**
 * Espera que a página pare de rolar.
 *
 * O `html { scroll-behavior: smooth }` faz o browser levar uns trezentos
 * milissegundos a trazer à vista o elemento que acabou de receber o foco.
 * Medir a meio do caminho dá uma leitura verdadeira de um instante que não
 * interessa a ninguém — e faz passar por escondido o que está a chegar.
 */
async function assentar(palco, tecto = 2500) {
  const limite = Date.now() + tecto;
  let anterior = null;
  for (;;) {
    const y = await palco.js('return Math.round(window.scrollY)');
    if (y === anterior) return y;
    anterior = y;
    if (Date.now() > limite) return y;
    await dormir(palco, 120);
  }
}

/* =========================================================================
   Ler o foco

   Mais fundo do que o `palco.focado()`: interessa também onde está o
   elemento na página, se está dentro do que está aberto por cima, e o
   desenho que o browser lhe está a dar neste momento.
   ========================================================================= */

const CHAVE = `(n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
  + (typeof n.className === 'string' && n.className.trim()
     ? '.' + n.className.trim().split(/\\s+/).join('.') : '')
  + '|' + (n.getAttribute('aria-label') || (n.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 22)`;

const DESENHO = `(n) => { const e = getComputedStyle(n);
  return { contorno: e.outlineStyle + ' ' + e.outlineWidth + ' ' + e.outlineColor,
           sombra: e.boxShadow, borda: e.borderColor + ' ' + e.borderWidth,
           corDoContorno: e.outlineColor }; }`;

/**
 * Quem tem o foco agora. Com `dentroDe`, diz também se está dentro do que
 * está aberto por cima — e essa pergunta tem de ser feita a CADA passo da
 * tabulação, não no fim: perguntar no fim é perguntar por um instante só, e
 * um foco que sai e volta a entrar passaria despercebido.
 */
const FOCADO = (dentroDe = null) => `
  const chave = ${CHAVE};
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return null;
  const r = a.getBoundingClientRect();
  return {
    chave: chave(a),
    classe: typeof a.className === 'string' ? a.className : '',
    /* A posição no DOCUMENTO, e não no ecrã: a tabulação rola a página, e
       duas leituras no ecrã dão y's que saltam para trás sem nada estar
       trocado. */
    y: Math.round(r.top + window.scrollY),
    noPrincipal: !!a.closest('#principal'),
    dentro: ${dentroDe ? `!!a.closest(${JSON.stringify(dentroDe)})` : 'null'},
    ...(${DESENHO})(a),
  };`;

const focado = (palco, dentroDe) => palco.js(FOCADO(dentroDe));

/** Quem tem o foco, em duas palavras, para o detalhe de uma falha. */
const nomear = (f) => (f ? f.chave : 'o body — o foco caiu no chão');

/** Está o foco dentro de `seletor`? */
const focoDentroDe = (palco, seletor) => palco.js(
  `const a = document.activeElement;
   return !!(a && a.closest && a.closest(${JSON.stringify(seletor)}))`);

/**
 * Tabula `quantos` passos com uma coisa aberta por cima, e devolve as
 * paragens já com a resposta a «isto ainda está dentro do diálogo?» tirada
 * no momento em que lá se chegou.
 */
async function percorrerDentroDe(palco, seletor, quantos) {
  const paragens = [];
  for (let i = 0; i < quantos; i++) {
    await tab(palco);
    paragens.push(await focado(palco, seletor));
  }
  return paragens;
}

const fugiram = (paragens) => paragens.filter((f) => f === null || f.dentro === false);

/**
 * Dá a volta ao documento até cair na ligação «Saltar para o conteúdo».
 *
 * Não há maneira de repor o ponto de partida da tabulação a partir do
 * JavaScript — um `blur()` não lhe toca, e a app põe o foco no `#principal`
 * a cada mudança de ecrã, o que faz o primeiro Tab começar a meio da página.
 * Dando a volta chega-se ao princípio verdadeiro, que é a primeira paragem
 * de qualquer página das duas apps.
 */
async function irAoPrincipio(palco, voltas = 40) {
  for (let i = 0; i < voltas; i++) {
    await tab(palco);
    const f = await focado(palco);
    if (f && f.classe.includes('saltar')) return f;
  }
  return null;
}

/** Tabula `quantos` passos e devolve o que ficou com o foco em cada um. */
async function percorrer(palco, quantos, opcoes) {
  const paragens = [];
  for (let i = 0; i < quantos; i++) {
    await tab(palco, opcoes);
    paragens.push(await focado(palco));
  }
  return paragens;
}

/**
 * Uma volta completa ao ecrã, do princípio até voltar ao princípio.
 * Devolve as paragens pela ordem, já sem a repetição do fim.
 */
async function voltaCompleta(palco, tecto = 30) {
  const primeira = await irAoPrincipio(palco);
  if (!primeira) return null;
  const paragens = [primeira];
  for (let i = 0; i < tecto; i++) {
    await tab(palco);
    const f = await focado(palco);
    /* Entre o fim do documento e o princípio o browser mete uma paragem sua
       — a barra de endereço, que aqui não existe. Vale `null` e não conta. */
    if (f === null) continue;
    if (f.chave === primeira.chave) return paragens;
    paragens.push(f);
  }
  return paragens;
}

/* =========================================================================
   Alvos de toque

   A excepção «inline» da WCAG 2.5.8 está aqui de propósito e é legítima: um
   link no meio de uma frase não pode ter 44 px de altura sem esticar a
   entrelinha do texto todo. Tudo o resto conta — e um botão que o CSS põe em
   `inline-flex`, como o «Juntar» do Descobrir, não é um link no meio de uma
   frase.

   Os alvos vão-se juntando num registo comum às visitas todas, com a chave a
   ser o tipo de peça e não o texto que ela leva: o mesmo `.btn-pequeno` que
   aparece em quatro ecrãs é um defeito só, e não quatro.
   ========================================================================= */

const ALVOS = `
  return [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
    .filter((n) => {
      if (n.disabled) return false;
      const e = getComputedStyle(n);
      if (e.display === 'none' || e.visibility === 'hidden' || Number(e.opacity) === 0) return false;
      if (e.display === 'inline') return false;        /* excepção «inline» */
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((n) => { const r = n.getBoundingClientRect();
      return {
        tipo: n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
          + (typeof n.className === 'string' && n.className.trim()
             ? '.' + n.className.trim().split(/\\s+/).join('.') : ''),
        texto: (n.getAttribute('aria-label') || n.textContent || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 22),
        largura: Math.round(r.width), altura: Math.round(r.height),
      }; });`;

/** Junta o que está no ecrã ao registo, guardando sempre a pior medida. */
async function recolherAlvos(palco, registo, onde) {
  for (const a of await palco.js(ALVOS)) {
    const ja = registo.get(a.tipo);
    if (!ja || a.largura * a.altura < ja.largura * ja.altura) {
      registo.set(a.tipo, { ...a, onde });
    }
  }
  return registo;
}

const pequenos = (registo, minimo) => [...registo.values()]
  .filter((a) => a.largura < minimo || a.altura < minimo)
  .sort((a, b) => a.largura * a.altura - b.largura * b.altura);

/** Os `.btn` mais baixos do que o próprio CSS do `.btn` promete. */
const baixos = (registo, minimo) => [...registo.values()]
  .filter((a) => /(^|\.)btn(\.|$)/.test(a.tipo) && a.altura < minimo)
  .sort((a, b) => a.altura - b.altura);

const listar = (lista) => lista
  .map((a) => `«${a.texto}» ${a.largura}×${a.altura} (${a.tipo.split('.').pop()}, ${a.onde})`)
  .join(' · ');

/* =========================================================================
   Diálogos
   ========================================================================= */

async function diagnosticarDialogo(palco, seletor) {
  return palco.js(`
    const n = document.querySelector(${JSON.stringify(seletor)});
    if (!n) return null;
    const rotulado = n.getAttribute('aria-labelledby');
    return {
      papel: n.getAttribute('role'),
      modal: n.getAttribute('aria-modal'),
      nome: n.getAttribute('aria-label')
        || (rotulado && document.getElementById(rotulado)
            ? document.getElementById(rotulado).textContent.trim() : null),
    };`);
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  const alvosApp = new Map();
  const alvosBalcao = new Map();

  /* =======================================================================
     A app do cliente
     ======================================================================= */

  await palco.ir('/app/?demo=1');
  await palco.esperar('#bv-seguinte');
  await recolherAlvos(palco, alvosApp, 'boas-vindas');

  /* Os pontinhos dos passos anunciam-se como uma lista de separadores e não
     têm separador nenhum lá dentro: um leitor de ecrã lê «lista de
     separadores» e depois não encontra nada para percorrer. São uma
     decoração — ou levam `role="tab"` nos filhos, ou não levam papel nenhum. */
  const pontos = await palco.js(`
    const c = document.querySelector('.bv-pontos');
    if (!c) return null;
    return { papel: c.getAttribute('role'),
             filhos: [...c.children].map((n) => n.getAttribute('role') || 'sem papel') };`);
  certo(pontos && (pontos.papel !== 'tablist' || pontos.filhos.every((p) => p === 'tab')),
    'boas-vindas: os pontos dos passos não se anunciam como uma lista de separadores vazia',
    pontos ? `role=${pontos.papel}, filhos=[${pontos.filhos.join(', ')}]` : 'não há pontos');

  await passarBoasVindas(palco);
  await palco.esperar('#barra');
  await palco.esperar('#principal .pilha .cartao', 10000);
  await recolherAlvos(palco, alvosApp, 'carteira');

  /* --- a volta ao ecrã da carteira --------------------------------------- */

  const volta = await voltaCompleta(palco);
  certo(!!volta && volta.length > 3,
    'carteira: o Tab dá a volta ao ecrã e volta ao princípio',
    volta ? `${volta.length} paragens` : 'nunca cheguei à ligação de saltar');

  /* A comparação é peça a peça, e não por tipo de peça: cinco cartões são
     cinco `button.cartao`, e um deles a ficar de fora da tabulação passaria
     despercebido se se comparassem só as classes. */
  const naCarteira = await palco.js(ALVOS);
  const vistos = new Set((volta || []).map((f) => f.chave));
  const esquecidos = naCarteira.filter((a) => !vistos.has(`${a.tipo}|${a.texto}`));
  certo(esquecidos.length === 0,
    `carteira: a tabulação chega aos ${naCarteira.length} controlos do ecrã, um a um`,
    `ficaram de fora: ${esquecidos.map((a) => `${a.tipo} «${a.texto}»`).join(' · ')}`);

  const ordem = (volta || []).map((f) => f.chave);
  certo(ordem[0] && ordem[0].includes('saltar'),
    'carteira: a primeira paragem é a ligação «Saltar para o conteúdo»', String(ordem[0]));
  certo(ordem[1] && ordem[1].includes('botao-tema'),
    'carteira: a segunda é o botão do cabeçalho, antes do conteúdo', String(ordem[1]));
  certo(ordem.length > 5 && ordem[ordem.length - 1].includes('barra-item'),
    'carteira: a barra de navegação fica para o fim, como está no ecrã',
    String(ordem[ordem.length - 1]));

  /* Dentro do conteúdo, a ordem de tabulação tem de descer pela página. Um
     salto para trás quer dizer que o que se lê e o que se tabula divergiram —
     e quem não vê o ecrã fica sem forma de adivinhar onde está. */
  const noConteudo = (volta || []).filter((f) => f.noPrincipal);
  const desce = noConteudo.every((f, i) => i === 0 || f.y >= noConteudo[i - 1].y);
  certo(noConteudo.length > 2 && desce,
    'carteira: dentro do conteúdo o foco desce pela página, nunca salta para trás',
    noConteudo.map((f) => `${f.chave.split('|')[1]}@${f.y}`).join(' → '));

  /* Um `tabindex` positivo é a maneira clássica de partir a ordem sem dar por
     isso: passa à frente de todo o resto do documento. */
  const positivos = await palco.js(`
    return [...document.querySelectorAll('[tabindex]')]
      .filter((n) => Number(n.getAttribute('tabindex')) > 0)
      .map((n) => n.tagName + '[tabindex=' + n.getAttribute('tabindex') + ']');`);
  certo(positivos.length === 0,
    'carteira: nenhum tabindex positivo a furar a fila', positivos.join(', '));

  /* O Shift+Tab mede-se a partir do MEIO da fila, e não de onde o foco
     calhou estar.

     Estando no primeiro elemento focável, recuar sai do documento e o foco
     cai no `body` — comportamento certo, e que depende do sistema: no Mac o
     Chrome dá a volta, no Linux do CI não dá. A afirmação passava aqui e
     reprovava lá, a acusar a app de uma coisa que é do browser. Põe-se o
     foco no último separador da barra e recua-se de lá, que é uma pergunta
     sobre a app e não sobre o sistema operativo. */
  await palco.js(`document.querySelectorAll('.barra-item')[4].focus(); return true`);
  const daBarra = await palco.focado();
  const atras = await percorrer(palco, 1, { tras: true });
  certo(atras[0] && daBarra && atras[0].chave !== `${daBarra.etiqueta}|${daBarra.texto}`,
    'carteira: o Shift+Tab anda mesmo para trás',
    `${daBarra ? daBarra.texto : '?'} ⇤ ${atras.map(nomear).join(' ')}`);

  /* --- o indicador de foco ----------------------------------------------- */

  /* Duas passagens: apanha-se o desenho de cada paragem COM o foco, e depois
     lê-se o mesmo elemento SEM ele. Comparar cada um com o vizinho não
     servia — cada peça tem o seu desenho de base. */
  await irAoPrincipio(palco);
  const comFoco = [];
  for (let i = 0; i < 13; i++) {
    const f = await palco.js(`
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      a.dataset.t11 = '${i}';
      return { i: '${i}', chave: (${CHAVE})(a), ...(${DESENHO})(a) };`);
    if (f) comFoco.push(f);
    await tab(palco);
  }
  await palco.js('document.activeElement && document.activeElement.blur(); return true');
  /* As transições de cor duram 200 ms: lê-se depois de elas acabarem, senão
     mede-se o meio do caminho e o «sem foco» ainda tem a cor do «com foco». */
  await dormir(palco, 400);
  const semFoco = await palco.js(`
    const o = {};
    for (const n of document.querySelectorAll('[data-t11]')) o[n.dataset.t11] = (${DESENHO})(n);
    return o;`);

  const invisiveis = comFoco.filter((f) => {
    const s = semFoco[f.i];
    return !s || (f.contorno === s.contorno && f.sombra === s.sombra && f.borda === s.borda);
  });
  certo(comFoco.length > 5 && invisiveis.length === 0,
    `carteira: os ${comFoco.length} controlos mudam de aspecto quando recebem o foco`,
    `sem mudança nenhuma: ${invisiveis.map((f) => f.chave).join(' · ')}`);

  /* Mudar não chega: o anel tem de se ver contra o que tem por baixo. */
  const fundos = await palco.js(`
    const opaco = (c) => { const p = String(c).match(/[\\d.]+/g);
      return p && (p.length < 4 || Number(p[3]) > 0.95); };
    const o = {};
    for (const n of document.querySelectorAll('[data-t11]')) {
      let p = n.parentElement, fundo = 'rgb(255, 255, 255)';
      while (p) { const c = getComputedStyle(p).backgroundColor;
        if (opaco(c)) { fundo = c; break; } p = p.parentElement; }
      o[n.dataset.t11] = fundo;
    }
    return o;`);
  const fracos = comFoco
    .map((f) => ({ ...f, contraste: razao(corParaRGB(f.corDoContorno), corParaRGB(fundos[f.i])) }))
    .filter((f) => f.contraste < 3);
  certo(fracos.length === 0,
    'carteira: o anel de foco tem 3:1 contra o fundo em que assenta',
    fracos.map((f) => `${f.chave} ${f.contraste.toFixed(2)}:1`).join(' · '));

  /* --- a ligação de saltar ----------------------------------------------- */

  const saltar = await irAoPrincipio(palco);
  certo(!!saltar, 'saltar: a ligação existe e a tabulação chega-lhe');
  /* Ela vive fora do ecrã até ser focada, e a vinda é uma rolagem suave: só
     depois de a página assentar é que faz sentido perguntar se se vê. */
  await assentar(palco);
  const caixaSaltar = await palco.medir('.saltar');
  certo(await palco.visivel('.saltar'),
    'saltar: com o foco, a ligação aparece — escondida não serve de nada',
    JSON.stringify(caixaSaltar));
  certo(caixaSaltar && caixaSaltar.y >= 0 && caixaSaltar.y < 200,
    'saltar: e assenta no cimo do ecrã', JSON.stringify(caixaSaltar));

  await palco.tecla('Enter');
  const depoisDoSalto = await focado(palco);
  certo(depoisDoSalto && depoisDoSalto.chave.includes('#principal'),
    'saltar: o Enter leva o foco para o conteúdo principal', nomear(depoisDoSalto));

  const aSeguirAoSalto = (await percorrer(palco, 1))[0];
  certo(aSeguirAoSalto && aSeguirAoSalto.noPrincipal,
    'saltar: e o Tab seguinte já está dentro do conteúdo, não de volta ao cabeçalho',
    nomear(aSeguirAoSalto));

  /* --- o Enter acciona ---------------------------------------------------- */

  await palco.js("document.querySelector('.barra-item:nth-child(2)').focus(); return true");
  await palco.tecla('Enter');
  await palco.esperar('#principal .cartao-descobrir', 8000);
  certo(await palco.texto('#principal h1') === 'Descobrir',
    'teclado: o Enter num separador da barra muda mesmo de ecrã',
    String(await palco.texto('#principal h1')));

  /* --- descobrir: o botão que se falha ------------------------------------ */

  await recolherAlvos(palco, alvosApp, 'descobrir');
  const selos = (await palco.js(ALVOS)).filter((a) => a.tipo.includes('cartao-selo'));
  /* Interessa o de «Juntar»: os outros dizem «Já tens» e são um atalho para a
     carteira, não a acção que o ecrã existe para dar. */
  const juntar = selos.find((a) => a.texto.startsWith('Juntar')) || selos[0];
  certo(juntar && juntar.largura >= MINIMO && juntar.altura >= MINIMO,
    `descobrir: o botão de juntar um cartão tem ${MINIMO}×${MINIMO} px — é a acção do ecrã`,
    juntar ? `«${juntar.texto}» tem ${juntar.largura}×${juntar.altura}` : 'não encontrei o botão');

  /* --- um cartão aberto: o botão de voltar -------------------------------- */

  await palco.clicar('.barra-item:nth-child(1)');
  await palco.esperar('#principal .pilha .cartao', 8000);
  await palco.clicar('#principal .pilha > .cartao:nth-of-type(2)');
  await palco.esperar('#principal .voltar', 8000);
  await recolherAlvos(palco, alvosApp, 'cartão aberto');
  await palco.js("document.querySelector('#principal .voltar').focus(); return true");
  await palco.tecla('Enter');
  await palco.esperar('#principal .pilha .cartao', 8000);
  certo(await palco.texto('#principal h1.titulo-grande') === 'Os meus cartões',
    'teclado: o Enter no botão de voltar devolve a carteira',
    String(await palco.texto('#principal h1.titulo-grande')));

  /* --- perfil ------------------------------------------------------------- */

  await palco.clicar('.barra-item:nth-child(5)');
  await palco.esperar('#principal .linha-perigo');
  await recolherAlvos(palco, alvosApp, 'perfil');

  /* --- o painel: entrar, ficar, sair -------------------------------------- */

  /* Recomeça-se com o endereço limpo. O Enter na ligação de saltar deixou lá
     «#principal», e um `history.back()` que caia numa entrada com fragmento
     faz o BROWSER focar o alvo do fragmento — o que mascarava, com um foco
     que não é da app, onde o foco fica mesmo ao fechar um painel. */
  await palco.ir('/app/?demo=1');
  await palco.esperar('#barra');
  await palco.clicar('.barra-item:nth-child(5)');
  await palco.esperar('#principal .linha-perigo');

  const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#campo-email');
  /* O painel do código desta mesma app foca o campo ao fim de 120 ms; dá-se
     folga de sobra antes de dizer que este não foca nada. */
  await dormir(palco, 400);
  await recolherAlvos(palco, alvosApp, 'painel da conta');

  const dialogoPainel = await diagnosticarDialogo(palco, '#painel .painel-folha');
  certo(dialogoPainel && dialogoPainel.papel === 'dialog' && dialogoPainel.modal === 'true'
    && !!dialogoPainel.nome,
    'painel: anuncia-se como diálogo modal e com nome', JSON.stringify(dialogoPainel));

  /* Quem escreve `aria-modal="true"` está a dizer ao leitor de ecrã que o
     resto da página deixou de existir. O foco tem de entrar no painel — senão
     o leitor de ecrã fica calado em cima de um sítio que já não conta, e a
     pessoa não sabe que se abriu alguma coisa. */
  certo(await focoDentroDe(palco, '#painel'),
    'painel: ao abrir, o foco entra no painel',
    `ficou em ${nomear(await focado(palco))}`);

  const dentro = await percorrerDentroDe(palco, '#painel', 4);
  certo(fugiram(dentro).length === 0,
    'painel: com o painel aberto, o Tab fica lá dentro e não passeia pela página tapada',
    dentro.map((f) => `${nomear(f)}${f && f.dentro ? '' : ' ✗fora'}`).join(' → '));

  /* Este painel não põe cá o foco — mas o do código põe, e o do balcão
     também. Põe-se o foco onde ele devia estar para fazer a pergunta que
     interessa ao `fecharPainel`: quando o painel desaparece, leva consigo o
     elemento focado; alguém o devolve a algum sítio? */
  const abriuOPainel = await palco.js(
    `return (${CHAVE})(document.querySelector(${JSON.stringify(LINHA_CONTA)}))`);
  await palco.js("document.querySelector('#campo-email').focus(); return true");

  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'painel: o Escape fecha-o');

  const depoisDeFechar = await focado(palco);
  certo(depoisDeFechar && depoisDeFechar.chave === abriuOPainel,
    'painel: ao fechar, o foco volta ao botão que o abriu',
    `${nomear(depoisDeFechar)} — devia ser ${abriuOPainel}`);

  /* --- a folha do código: o diálogo que tapa o ecrã todo ------------------ */

  await palco.clicar('.barra-item:nth-child(3)');
  await palco.esperar('#folha-codigo', 8000);
  await dormir(palco, 300);
  await recolherAlvos(palco, alvosApp, 'folha do código');
  await palco.captura('11-codigo');

  const dialogoCodigo = await diagnosticarDialogo(palco, '#folha-codigo');
  certo(dialogoCodigo && dialogoCodigo.papel === 'dialog' && dialogoCodigo.modal === 'true'
    && !!dialogoCodigo.nome,
    'código: a folha anuncia-se como diálogo modal e com nome', JSON.stringify(dialogoCodigo));

  certo(await focoDentroDe(palco, '#folha-codigo'),
    'código: ao abrir, o foco entra na folha',
    `ficou em ${nomear(await focado(palco))}`);

  const naFolha = await percorrerDentroDe(palco, '#folha-codigo', 4);
  certo(fugiram(naFolha).length === 0,
    'código: o Tab não sai da folha para os botões que ela está a tapar',
    naFolha.map((f) => `${nomear(f)}${f && f.dentro ? '' : ' ✗fora'}`).join(' → '));

  /* A folha ocupa o ecrã inteiro e é o único sítio da app onde não há para
     onde fugir com o polegar. O Escape é o gesto do teclado para «fecha
     isso», e é o mesmo que o painel já entende. */
  await palco.tecla('Escape');
  await dormir(palco, 400);
  certo(!(await palco.ver('#folha-codigo')),
    'código: o Escape fecha a folha, como fecha os painéis');

  /* Fecha-se pelo botão, também com o teclado: interessa saber onde fica o
     foco depois de o elemento que o tinha desaparecer do documento. */
  if (await palco.ver('#folha-codigo')) {
    await palco.js("document.querySelector('.codigo-fechar').focus(); return true");
    await palco.tecla('Enter');
    await palco.sumir('#folha-codigo', 4000);
  }
  const depoisDoCodigo = await focado(palco);
  certo(depoisDoCodigo !== null,
    'código: ao fechar a folha o foco não fica no chão', nomear(depoisDoCodigo));

  /* A prova do que isso custa: com o foco no chão, o Tab seguinte não
     continua de onde se estava — recomeça no princípio do documento. */
  const aSeguirAoCodigo = (await percorrer(palco, 1))[0];
  certo(aSeguirAoCodigo && !aSeguirAoCodigo.chave.includes('saltar'),
    'código: e a tabulação continua onde estava, sem atirar a pessoa para o topo da página',
    `o Tab a seguir caiu em ${nomear(aSeguirAoCodigo)}`);

  /* --- o balanço dos alvos da app ---------------------------------------- */

  certo(pequenos(alvosApp, MINIMO).length === 0,
    `app: nenhum tipo de alvo de toque abaixo de ${MINIMO}×${MINIMO} px`,
    listar(pequenos(alvosApp, MINIMO)));

  /* O `.btn` do núcleo tem uma promessa escrita ao lado da declaração:
     «min-height: 48px — WCAG 2.2 alvo mínimo, com folga». Quem a desfaz é uma
     variante da própria classe, o que a torna difícil de ver a ler o CSS. */
  certo(forade(baixos(alvosApp, PROMETIDO)).length === 0,
    `app: a classe .btn cumpre ${PROMETIDO} px, ou ${MINIMO} nas variantes pequenas`,
    listar(forade(baixos(alvosApp, PROMETIDO))));

  /* =======================================================================
     O balcão

     Do outro lado do balcão o teclado é raro — mas é uma app com formulários,
     e um formulário sem teclado não é um formulário. E os diálogos de
     resultado são o que a pessoa vê cinquenta vezes por dia.
     ======================================================================= */

  const publico = await palco.js(
    "return (JSON.parse(localStorage.getItem('carimbo-demo:cliente') || 'null') || {}).publico || null");

  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn');
  await recolherAlvos(palco, alvosBalcao, 'entrada');

  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#botao-manual', 10000);
  await recolherAlvos(palco, alvosBalcao, 'carimbar');

  const voltaBalcao = await voltaCompleta(palco);
  const noBalcao = await palco.js(ALVOS);
  const vistosBalcao = new Set((voltaBalcao || []).map((f) => f.chave));
  const esquecidosBalcao = noBalcao.filter((a) => !vistosBalcao.has(`${a.tipo}|${a.texto}`));
  certo(voltaBalcao && esquecidosBalcao.length === 0,
    `balcão: a tabulação chega aos ${noBalcao.length} controlos do ecrã de carimbar`,
    `ficaram de fora: ${esquecidosBalcao.map((a) => a.tipo).join(' · ')}`);

  /* O painel do número à mão faz o que o painel da conta não faz: põe lá o
     foco. É a prova de que o outro é um esquecimento e não uma decisão. */
  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero');
  await dormir(palco, 400);
  await recolherAlvos(palco, alvosBalcao, 'painel do número');
  certo(await palco.js("return !!document.activeElement && document.activeElement.id === 'campo-numero'"),
    'balcão: o painel do número à mão põe o foco no campo', nomear(await focado(palco)));

  /* Um campo mostra que tem o foco pelo contorno e pelo halo, e não por um
     outline — vale na mesma, desde que mude alguma coisa. As duas leituras
     são tiradas com as transições já paradas, dos dois lados. */
  const campoComFoco = await palco.js(`return (${DESENHO})(document.querySelector('#campo-numero'))`);
  await palco.js('document.activeElement.blur(); return true');
  await dormir(palco, 400);
  const campoSemFoco = await palco.js(`return (${DESENHO})(document.querySelector('#campo-numero'))`);
  certo(campoComFoco.borda !== campoSemFoco.borda || campoComFoco.sombra !== campoSemFoco.sombra
    || campoComFoco.contorno !== campoSemFoco.contorno,
    'balcão: o campo do número mostra que tem o foco',
    `com foco ${campoComFoco.borda} / ${campoComFoco.sombra.slice(0, 34)}`
    + ` · sem foco ${campoSemFoco.borda} / ${campoSemFoco.sombra.slice(0, 34)}`);

  /* Devolve-se o foco ao campo — é lá que ele está na vida real, porque este
     painel foi ele próprio pô-lo lá — e fecha-se. */
  await palco.js("document.querySelector('#campo-numero').focus(); return true");
  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'balcão: o Escape fecha o painel do número');
  certo((await focado(palco)) !== null,
    'balcão: e o foco não fica no chão quando o campo desaparece com o painel',
    nomear(await focado(palco)));

  /* --- os diálogos de resultado ------------------------------------------- */

  certo(!!publico, 'balcão: a demonstração tem um cliente para carimbar', String(publico));

  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero');
  await palco.escrever('#campo-numero', publico || 'ZZZZZZ');
  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('#resultado', 8000);
  await dormir(palco, 300);
  await recolherAlvos(palco, alvosBalcao, 'resultado do carimbo');
  await palco.captura('11-balcao-resultado');

  const dialogoResultado = await diagnosticarDialogo(palco, '#resultado');
  certo(dialogoResultado && dialogoResultado.papel === 'dialog'
    && dialogoResultado.modal === 'true',
    'balcão: o resultado do carimbo anuncia-se como diálogo modal',
    JSON.stringify(dialogoResultado));
  certo(dialogoResultado && !!dialogoResultado.nome,
    'balcão: e traz nome — um diálogo sem nome é anunciado só como «diálogo»',
    JSON.stringify(dialogoResultado));

  /* Com o resultado aberto o foco continua onde estava — atrás do véu, no
     botão de escrever o número. Um Enter distraído abre um painel POR BAIXO
     do resultado, e quem está ao balcão fica com dois ecrãs empilhados sem
     perceber de onde veio o segundo. */
  const noResultado = await percorrerDentroDe(palco, '#resultado', 3);
  certo(fugiram(noResultado).length === 0,
    'balcão: com o resultado aberto, o Tab fica lá dentro',
    noResultado.map((f) => `${nomear(f)}${f && f.dentro ? '' : ' ✗fora'}`).join(' → '));

  /* O resultado também se fecha sozinho ao fim de seis segundos: confirma-se
     que ainda lá está antes de carregar no Escape, senão o teste dava-se por
     satisfeito com um desaparecimento que não é dele. */
  const aindaLa = await palco.ver('#resultado');
  await palco.tecla('Escape');
  await dormir(palco, 400);
  certo(aindaLa && !(await palco.ver('#resultado')), 'balcão: o Escape fecha o resultado',
    aindaLa ? 'continuou aberto' : 'já se tinha fechado sozinho — inconclusivo');
  await palco.js("document.querySelector('#resultado') && document.querySelector('#resultado').remove(); return true");

  /* O diálogo de erro é o que aparece quando o código não presta, e é o único
     da app com `role="alertdialog"`. Tapa o ecrã como os outros: tem de o
     dizer, e tem de ter nome. */
  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero');
  await palco.escrever('#campo-numero', 'ZZZZZZ');
  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('#resultado', 8000);

  const dialogoErro = await diagnosticarDialogo(palco, '#resultado');
  certo(dialogoErro && dialogoErro.papel === 'alertdialog',
    'balcão: o erro do carimbo é um alertdialog', JSON.stringify(dialogoErro));
  certo(dialogoErro && dialogoErro.modal === 'true' && !!dialogoErro.nome,
    'balcão: e também ele diz que é modal e traz nome', JSON.stringify(dialogoErro));

  /* --- botões só com ícone ------------------------------------------------ */

  /* Um botão que só tem um desenho lá dentro é mudo para quem não o vê. */
  const mudos = await palco.js(`
    const chave = ${CHAVE};
    return [...document.querySelectorAll('button, a[href]')].filter((n) => {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const t = (n.textContent || '').replace(/\\s+/g, '').trim();
      return !t && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')
        && !n.getAttribute('title');
    }).map(chave);`);
  certo(mudos.length === 0,
    'balcão: nenhum botão só com ícone fica sem rótulo lido em voz alta', mudos.join(' · '));

  certo(await palco.atributo('#botao-negocio', 'aria-label') === 'O meu negócio',
    'balcão: o botão de engrenagem do cabeçalho diz o que é',
    String(await palco.atributo('#botao-negocio', 'aria-label')));

  /* --- o balanço dos alvos do balcão -------------------------------------- */

  certo(pequenos(alvosBalcao, MINIMO).length === 0,
    `balcão: nenhum tipo de alvo de toque abaixo de ${MINIMO}×${MINIMO} px`,
    listar(pequenos(alvosBalcao, MINIMO)));
  certo(forade(baixos(alvosBalcao, PROMETIDO)).length === 0,
    `balcão: e a classe .btn cumpre também aqui ${PROMETIDO} px, ou ${MINIMO} nas pequenas`,
    listar(forade(baixos(alvosBalcao, PROMETIDO))));
}
