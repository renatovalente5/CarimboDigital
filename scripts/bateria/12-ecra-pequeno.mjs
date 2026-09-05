/* =========================================================================
   Bateria · 12 — Ecrãs pequenos e conteúdo que transborda

   Um cartão de fidelidade abre-se numa mão, ao balcão, com o telemóvel que a
   pessoa tem — e o telemóvel que a pessoa tem é muitas vezes o mais pequeno
   que ainda se vende. A 320 px de largura não há folga nenhuma: um botão com
   uma frase comprida, uma medida em milímetros, uma barra fixa que pousa em
   cima da última linha, e a app deixa de servir para o que serve.

   Mede-se o mesmo em cada ecrã e em cada uma das quatro larguras:

   · O CORPO NÃO ROLA NA HORIZONTAL. `body.scrollWidth <= innerWidth`. É o
     sintoma que qualquer pessoa nota — a página abana de lado — e o mais
     fácil de deixar entrar sem ninguém dar por ele.

   · NINGUÉM SAI PELA DIREITA. E quando alguém sai, diz-se QUEM: percorrem-se
     os nós, mede-se `getBoundingClientRect().right` e guarda-se o mais fundo
     que rompe o pai. Sem o nome do culpado o defeito não é accionável e a
     correcção vira caça ao tesouro no CSS.

   · O TEXTO NÃO FICA CORTADO. Não é a mesma pergunta: um contentor com
     `overflow: hidden` não faz o corpo rolar — corta a informação em
     silêncio, que é pior, porque nem sequer se vê que falta. Mede-se pela
     geometria (que conta os `transform`) e não por `scrollWidth`, que os
     ignora e acusa de cortado o que está apenas empurrado para o sítio
     certo.

   · A BARRA DE BAIXO NÃO TAPA O FIM. Rola-se até ao fundo — que é o único
     sítio onde isto se vê — e mede-se a última coisa desenhada contra o
     cimo da barra fixa.

   Os sítios mais apertados visitam-se de propósito: a folha do código (um QR
   que não pode encolher abaixo do que a câmara lê), um painel aberto (uma
   folha que sobe do fundo), o ecrã do resultado do balcão (onde o nome do
   prémio entra dentro de um botão que não parte linha), o editor do cartão,
   e o cartaz do balcão, que é desenhado em MILÍMETROS para uma folha A4 e
   tem de caber num telemóvel na mesma.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '12 · Ecrãs pequenos e conteúdo que transborda';
export const desculpar = [/favicon/];

/* 320 é o iPhone SE de primeira geração e o mínimo que a WCAG pede sem
   rolamento lateral; 390 é o telemóvel do meio; 768 é o tablet ao alto, a
   largura em que a app deixa de ser «móvel»; 1280 é o portátil de quem abre
   o site. */
const ECRAS = [
  { largura: 320, altura: 568 },
  { largura: 390, altura: 844 },
  { largura: 768, altura: 1024 },
  { largura: 1280, altura: 800 },
];

/* =========================================================================
   A inspecção, feita na página

   Corre uma vez por ecrã e por largura e traz tudo o que se precisa para
   nomear o culpado. Vai num só guião para não pagar dezenas de idas e voltas
   ao browser por cada medição.
   ========================================================================= */

const INSPECCAO = `
  const TOL = 1;
  const larg = window.innerWidth;

  const etiqueta = (n) => {
    if (!n) return '?';
    if (n === document.body) return 'body';
    let s = n.tagName.toLowerCase();
    if (n.id) return s + '#' + n.id;
    const c = typeof n.className === 'string' ? n.className.trim() : '';
    if (c) s += '.' + c.split(/\\s+/).slice(0, 2).join('.');
    return s;
  };
  const caminho = (n) => {
    const p = [];
    for (let c = n; c && c !== document.body && p.length < 3; c = c.parentElement) {
      p.unshift(etiqueta(c));
    }
    return p.join('>');
  };
  const resumo = (n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
  const fundura = (n) => {
    let d = 0;
    for (let c = n; c && c !== document.body; c = c.parentElement) d++;
    return d;
  };

  const corta = (e) => e.overflowX === 'hidden' || e.overflowX === 'clip'
                    || e.overflowY === 'hidden' || e.overflowY === 'clip';
  const rola  = (e) => e.overflowX === 'auto' || e.overflowX === 'scroll'
                    || e.overflowY === 'auto' || e.overflowY === 'scroll';

  const cache = new Map();
  const de = (n) => { let e = cache.get(n); if (!e) { e = getComputedStyle(n); cache.set(n, e); } return e; };

  const pintado = (n) => {
    const e = de(n);
    if (e.display === 'none' || e.visibility === 'hidden' || Number(e.opacity) === 0) return false;
    const r = n.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };

  const IGNORAR = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'HEAD']);
  const todos = [...document.body.querySelectorAll('*')].filter((n) => !IGNORAR.has(n.tagName));

  /* --- quem sai pela direita sem ninguém que o segure -------------------- */
  const foraDireita = [];
  for (const n of todos) {
    if (!pintado(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.right <= larg + TOL) continue;
    /* Um filho que sai de um contentor que corta ou rola não faz a PÁGINA
       rolar de lado: quem responde por ele é o contentor — e esse aparece
       aqui na mesma se também sair. */
    let guarda = null;
    for (let p = n.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pe = de(p);
      if (corta(pe) || rola(pe)) { guarda = p; break; }
    }
    if (guarda) continue;
    const pai = n.parentElement ? n.parentElement.getBoundingClientRect() : null;
    foraDireita.push({
      onde: caminho(n), texto: resumo(n),
      largura: Math.round(r.width), excesso: Math.round(r.right - larg),
      /* Quem rompe o pai é a origem; quem só o acompanha é vítima. */
      rompe: pai ? r.right > pai.right + TOL : true,
      fundura: fundura(n),
    });
  }

  /* --- texto cortado por um contentor que esconde ------------------------ */
  const cortados = [];
  for (const n of todos) {
    if (!pintado(n)) continue;
    /* Só quem tem texto PRÓPRIO: um contentor vazio a ser cortado não tira
       informação a ninguém. */
    const proprio = [...n.childNodes].some((f) => f.nodeType === 3 && f.textContent.trim());
    if (!proprio) continue;

    let clipador = null;
    for (let p = n.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pe = de(p);
      if (rola(pe)) break;                        /* dá para rolar: nada se perde */
      if (pe.textOverflow === 'ellipsis') break;  /* as reticências são de propósito */
      if (corta(pe)) { clipador = p; break; }
    }
    if (!clipador) continue;

    const ce = de(clipador);
    const cb = clipador.getBoundingClientRect();
    const bE = parseFloat(ce.borderLeftWidth) || 0;
    const bD = parseFloat(ce.borderRightWidth) || 0;
    const bC = parseFloat(ce.borderTopWidth) || 0;
    const bB = parseFloat(ce.borderBottomWidth) || 0;
    const r = n.getBoundingClientRect();
    const fora = Math.max(
      r.right - (cb.right - bD), (cb.left + bE) - r.left,
      r.bottom - (cb.bottom - bB), (cb.top + bC) - r.top);
    if (fora > 1) {
      cortados.push({
        onde: caminho(n), texto: resumo(n),
        dentroDe: etiqueta(clipador), fora: Math.round(fora),
      });
    }
  }

  /* --- reticências: o que a app decidiu encurtar -------------------------

     As reticências são um corte assumido, mas continuam a ser informação que
     a pessoa não lê — e num ecrã de 320 é onde aparecem primeiro.

     Fora da conta ficam os cartões das boas-vindas: são cenário, um baralho
     desenhado de propósito com 74 % da largura do ecrã para parecer um
     baralho pousado na mesa. Os nomes que lá estão são exemplos, não são os
     do negócio de ninguém. Tudo o resto conta. */
  const reticencias = [];
  for (const n of todos) {
    if (!pintado(n)) continue;
    if (de(n).textOverflow !== 'ellipsis') continue;
    if (n.closest('#boas-vindas')) continue;
    if (n.scrollWidth > n.clientWidth + 1) {
      reticencias.push({ onde: caminho(n), texto: resumo(n),
                         pede: n.scrollWidth, tem: n.clientWidth });
    }
  }

  /* --- botões ------------------------------------------------------------ */
  const botoes = [];
  for (const n of todos) {
    if (n.tagName !== 'BUTTON' && !n.classList.contains('btn')) continue;
    if (!pintado(n)) continue;
    const r = n.getBoundingClientRect();
    botoes.push({
      onde: caminho(n), texto: resumo(n),
      largura: Math.round(r.width), altura: Math.round(r.height),
      esquerda: Math.round(r.left), direita: Math.round(r.right),
      /* O texto de um botão não parte linha (white-space: nowrap): se o
         conteúdo pede mais do que a caixa dá, a frase sai por fora dela. */
      pede: n.scrollWidth, tem: n.clientWidth,
    });
  }

  return {
    larg,
    /* O que sobra depois de a barra de rolamento comer o que come — se ela
       ocupar espaço, é aqui que se vê, e a diferença explica um transbordo
       de poucos píxeis que de outra forma não faria sentido nenhum. */
    usavel: document.documentElement.clientWidth,
    corpo: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
    foraDireita: foraDireita.sort((a, b) => (b.rompe - a.rompe) || (b.fundura - a.fundura)),
    cortados, reticencias, botoes,
  };
`;

/* A barra fixa mede-se com a página rolada até ao fim: é lá — e só lá — que
   ela pousa em cima da última linha do conteúdo. */
const BARRA = `
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const barra = document.querySelector('.barra');
  const principal = document.querySelector('#principal');
  if (!barra || !principal) return null;
  const b = barra.getBoundingClientRect();

  let fundo = null;
  for (const n of principal.querySelectorAll('*')) {
    const e = getComputedStyle(n);
    if (e.display === 'none' || e.visibility === 'hidden' || Number(e.opacity) === 0) continue;
    if (e.position === 'fixed') continue;
    if (!(n.textContent || '').trim()) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (!fundo || r.bottom > fundo.baixo) fundo = { no: n, baixo: r.bottom };
  }
  if (!fundo) return null;
  const n = fundo.no;
  const classe = typeof n.className === 'string' && n.className.trim()
    ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
  return {
    tapado: Math.round(fundo.baixo - b.top),
    /* Numa página que cabe no ecrã a barra nunca chega ao conteúdo: dizer que
       não o tapa não prova nada. Isto diz se a medição teve alguma coisa em
       que morder. */
    rola: document.body.scrollHeight > window.innerHeight + 4,
    quem: n.id ? n.tagName.toLowerCase() + '#' + n.id : n.tagName.toLowerCase() + classe,
    texto: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
  };
`;

/* =========================================================================
   Ajudas
   ========================================================================= */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera que o desenho assente antes de medir.
 *
 * Os painéis e a folha do código entram com uma animação. Nenhuma delas mexe
 * na largura — mas medir a meio de uma transição é a forma mais barata de
 * inventar um defeito que não existe, e duas voltas de pintura mais um
 * quarto de segundo custam menos do que um relatório errado.
 */
async function assentar(palco) {
  await palco.js(`await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r))); return true`);
  await dormir(250);
}

const linhaFora = (lista) => lista.slice(0, 3)
  .map((c) => `${c.onde} «${c.texto}» sai ${c.excesso}px (largura ${c.largura})`).join(' · ');

const linhaCorte = (lista) => lista.slice(0, 3)
  .map((c) => `${c.onde} «${c.texto}» ${c.fora}px fora de ${c.dentroDe}`).join(' · ');

/**
 * Mede um ecrã e faz as afirmações que valem para todos.
 *
 * Devolve o relatório, para quem chamou poder afirmar mais coisas sobre o
 * que só existe naquele ecrã.
 */
async function medir(palco, certo, onde, l) {
  await assentar(palco);
  const r = await palco.js(INSPECCAO);

  certo(r.corpo <= r.larg + 1,
    `${onde} @${l}: o corpo não rola na horizontal`,
    `scrollWidth=${r.corpo} > innerWidth=${r.larg} (útil ${r.usavel})`
    + ` — ${linhaFora(r.foraDireita) || 'sem culpado à vista'}`);

  certo(r.foraDireita.length === 0,
    `${onde} @${l}: nenhum elemento sai pela direita`,
    `${r.foraDireita.length} — ${linhaFora(r.foraDireita)}`);

  certo(r.cortados.length === 0,
    `${onde} @${l}: nenhum texto fica cortado por dentro`,
    `${r.cortados.length} — ${linhaCorte(r.cortados)}`);

  certo(r.reticencias.length === 0,
    `${onde} @${l}: nenhum texto útil fica encurtado com reticências`,
    r.reticencias.slice(0, 3)
      .map((t) => `${t.onde} «${t.texto}» pede ${t.pede}px e tem ${t.tem}px`).join(' · '));

  /* Um botão que não cabe é o pior dos transbordos: é o sítio onde se toca. */
  const apertados = r.botoes.filter((b) => b.pede > b.tem + 1);
  certo(apertados.length === 0,
    `${onde} @${l}: o texto dos botões cabe dentro dos botões`,
    apertados.slice(0, 3).map((b) => `«${b.texto}» pede ${b.pede}px e tem ${b.tem}px`).join(' · '));

  const derramados = r.botoes.filter((b) => b.direita > r.larg + 1 || b.esquerda < -1);
  certo(derramados.length === 0,
    `${onde} @${l}: os botões cabem no ecrã`,
    derramados.slice(0, 3).map((b) => `«${b.texto}» ${b.esquerda}→${b.direita} em ${r.larg}`).join(' · '));

  /* O alvo mínimo da WCAG 2.2 são 24 px; a app promete 48 em todos os `.btn`.
     Um botão que encolhe num ecrã apertado deixa de se acertar com o polegar. */
  const pequenos = r.botoes.filter((b) => b.altura < 24);
  certo(pequenos.length === 0,
    `${onde} @${l}: nenhum botão encolhe abaixo do alvo mínimo`,
    pequenos.slice(0, 3).map((b) => `«${b.texto}» ${b.largura}×${b.altura}`).join(' · '));

  return r;
}

/** A barra de baixo não pode pousar em cima da última linha do conteúdo. */
async function medirBarra(palco, certo, onde, l) {
  const b = await palco.js(BARRA);
  if (!b) return null;
  /* Dois píxeis de folga: a barra tem um fio de 1 px em cima, e o arredondar
     de um `dvh` chega para o outro. */
  certo(b.tapado <= 2,
    `${onde} @${l}: a barra de baixo não tapa o fim do conteúdo`,
    `«${b.texto}» (${b.quem}) acaba ${b.tapado}px por baixo do cimo da barra`);
  return b;
}

/* Volta ao topo entre medições: a barra mede-se com a página no fundo, e a
   medição seguinte tem de começar onde a pessoa a encontra. */
const aoTopo = (palco) => palco.js(
  "window.scrollTo({ top: 0, behavior: 'instant' }); return true");

/* =========================================================================
   A app do cliente
   ========================================================================= */

const BARRA_ITEM = (n) => `.barra-item:nth-child(${n})`;

async function appDoCliente(palco, certo, l) {
  /* Cada largura começa do zero: senão as boas-vindas só se veem na primeira
     e a carteira de cada largura é a que a largura anterior deixou. */
  await palco.ir('/app/?demo=1');
  await palco.limparArmazenamento();
  await palco.ir('/app/?demo=1');

  /* As boas-vindas são o primeiro ecrã de todos e um dos mais apertados:
     três cartões inclinados, um título grande e dois botões, numa altura
     fixa. Medem-se antes de se passarem. */
  await palco.esperar('#boas-vindas');
  await medir(palco, certo, 'app · boas-vindas', l);

  await passarBoasVindas(palco);
  await palco.esperar('#barra');
  await palco.esperar('#principal .pilha .cartao', 10000);

  await medir(palco, certo, 'app · carteira', l);
  const fundoDaCarteira = await medirBarra(palco, certo, 'app · carteira', l);
  /* Sem isto a afirmação de cima podia passar por a carteira caber toda no
     ecrã — e então não estaria a provar nada sobre a barra. */
  certo(!!fundoDaCarteira && fundoDaCarteira.rola,
    `app · carteira @${l}: a carteira é mais alta do que o ecrã, logo a barra tem o que tapar`,
    fundoDaCarteira ? 'a página cabe toda no ecrã' : 'não medi a barra');
  await aoTopo(palco);
  await palco.captura(`12-app-carteira-${l}`);

  /* Um cartão aberto: a grelha grande, o histórico, a morada e o telefone. */
  await palco.clicar('#principal .pilha > .cartao:nth-of-type(2)');
  await palco.esperar('#principal .cartao-grande', 8000);
  await medir(palco, certo, 'app · cartão aberto', l);
  await medirBarra(palco, certo, 'app · cartão aberto', l);
  await aoTopo(palco);
  await palco.captura(`12-app-cartao-${l}`);

  /* A folha do código: um QR que tem de ser grande o suficiente para a
     câmara do balcão o ler, num ecrã que pode ter 320 px de largura. */
  await palco.clicar('#principal .btn-cheio.btn-grande');
  await palco.esperar('#folha-codigo', 8000);
  await palco.esperar('#codigo-qr svg', 8000);
  const folha = await medir(palco, certo, 'app · folha do código', l);
  const qr = await palco.medir('#codigo-qr svg');
  /* Uma câmara de balcão a 20 cm precisa de módulos com dois píxeis; um QR
     de versão 4 tem 33 módulos, e abaixo de 160 px a leitura começa a
     falhar quando o ecrã tem brilho a menos ou uma dedada. */
  certo(qr && qr.largura >= 160,
    `app · folha do código @${l}: o QR fica grande o suficiente para a câmara ler`,
    qr ? `${Math.round(qr.largura)}×${Math.round(qr.altura)}px` : 'não desenhou QR');
  certo(qr && qr.x >= -1 && qr.x + qr.largura <= folha.larg + 1,
    `app · folha do código @${l}: o QR cabe todo no ecrã`,
    qr ? `${Math.round(qr.x)}→${Math.round(qr.x + qr.largura)} num ecrã de ${folha.larg}` : '');
  await palco.captura(`12-app-codigo-${l}`);
  await palco.clicar('#folha-codigo .codigo-fechar');
  await palco.sumir('#folha-codigo', 6000);

  /* Descobrir, prémios e perfil. */
  for (const [ecra, ficheiro, indice] of [['descobrir', 'descobrir', 2],
                                          ['prémios', 'premios', 4],
                                          ['perfil', 'perfil', 5]]) {
    await palco.clicar(BARRA_ITEM(indice));
    await palco.esperar('#principal h1.titulo-grande', 8000);
    await medir(palco, certo, `app · ${ecra}`, l);
    await medirBarra(palco, certo, `app · ${ecra}`, l);
    await aoTopo(palco);
    await palco.captura(`12-app-${ficheiro}-${l}`);
  }

  /* Um painel aberto — a folha que sobe do fundo, com um campo e um botão
     grande lá dentro. É o sítio mais apertado da app depois do código. */
  await palco.clicar('#principal section:first-of-type .lista .linha:first-child');
  await palco.esperar('#campo-email', 6000);
  const painel = await medir(palco, certo, 'app · painel aberto', l);

  const enviar = painel.botoes.find((b) => b.texto.includes('Enviar o código'));
  certo(!!enviar && enviar.direita <= painel.larg + 1 && enviar.esquerda >= -1,
    `app · painel aberto @${l}: o botão de enviar cabe no ecrã`,
    enviar ? `${enviar.esquerda}→${enviar.direita} em ${painel.larg}` : 'não encontrei o botão');

  /* Uma folha que rola de lado não tem forma de se voltar a alinhar: é uma
     folha, não um mapa. */
  const rolaPainel = await palco.js(`
    const f = document.querySelector('.painel-folha');
    return f ? { pede: f.scrollWidth, tem: f.clientWidth } : null;`);
  certo(rolaPainel && rolaPainel.pede <= rolaPainel.tem + 1,
    `app · painel aberto @${l}: a folha do painel não rola de lado`,
    rolaPainel ? `pede ${rolaPainel.pede}px e tem ${rolaPainel.tem}px` : 'sem painel');
  await palco.captura(`12-app-painel-${l}`);
  await palco.tecla('Escape');
  await palco.sumir('#painel', 6000);
}

/* =========================================================================
   O balcão
   ========================================================================= */

/**
 * Põe o cartão do café a um carimbo do prémio e devolve o número do cliente.
 *
 * Serve para se chegar ao ecrã do resultado no estado que interessa: aquele
 * em que o nome do prémio entra DENTRO de um botão que não parte linha.
 */
async function prepararPremio(palco) {
  return palco.js(`
    const cru = localStorage.getItem('carimbo-demo:demo');
    if (!cru) return null;
    const e = JSON.parse(cru);
    const cartao = (e.cartoes || []).find((c) => c.programaId === 'p-torrado');
    if (!cartao) return null;
    cartao.carimbos = 9;
    cartao.ultimoEm = new Date(Date.now() - 86400000).toISOString();
    localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
    const cliente = (e.clientes || []).find((c) => c.id === cartao.clienteId);
    return cliente ? cliente.publico : null;`);
}

async function balcao(palco, certo, l, publico) {
  /* Só a marca de «já entrei» é que se apaga: o resto do armazenamento é a
     demonstração inteira — clientes, cartões e movimentos — e é dela que o
     balcão vive. */
  await palco.js("localStorage.removeItem('carimbo-demo:balcao-entrou'); return true");
  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 8000);
  await medir(palco, certo, 'balcão · entrada', l);
  await palco.captura(`12-balcao-entrada-${l}`);

  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra', 10000);
  await palco.esperar('#visor-estado', 8000);
  /* Sem câmara no browser da bateria o visor fica na mensagem de recusa —
     que é justamente o estado em que este ecrã tem mais texto. */
  await palco.esperarTexto('Sem acesso à câmara', 8000);
  await medir(palco, certo, 'balcão · carimbar', l);
  await medirBarra(palco, certo, 'balcão · carimbar', l);
  await aoTopo(palco);
  await palco.captura(`12-balcao-carimbar-${l}`);

  /* O painel do número escrito à mão. */
  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero', 6000);
  await medir(palco, certo, 'balcão · painel do número', l);
  await palco.captura(`12-balcao-manual-${l}`);

  /* E o ecrã que aparece depois de carimbar — o único que toda a gente que
     trabalha ao balcão vê dezenas de vezes por dia. Com um prémio ganho, é
     aqui que o nome do prémio entra dentro de um botão. */
  await palco.escrever('#campo-numero', publico);
  await palco.clicar('.painel-folha .btn-cheio');
  await palco.esperar('#resultado', 8000);
  await palco.esperarTexto('Entreguei', 6000);
  const res = await medir(palco, certo, 'balcão · resultado', l);

  const entregar = res.botoes.find((b) => b.texto.startsWith('Entreguei'));
  certo(!!entregar && entregar.pede <= entregar.tem + 1,
    `balcão · resultado @${l}: o nome do prémio cabe dentro do botão de entregar`,
    entregar ? `«${entregar.texto}» pede ${entregar.pede}px e o botão tem ${entregar.tem}px`
      : 'não apareceu botão de entregar');
  await palco.captura(`12-balcao-resultado-${l}`);

  await palco.js("document.querySelector('#resultado')?.remove(); return true");
  await palco.sumir('#resultado', 4000);

  for (const [ecra, indice] of [['hoje', 2], ['clientes', 3], ['o cartão', 4]]) {
    await palco.clicar(BARRA_ITEM(indice));
    await palco.esperar('#principal h1.titulo-grande', 8000);
    await medir(palco, certo, `balcão · ${ecra}`, l);
    await medirBarra(palco, certo, `balcão · ${ecra}`, l);
    await aoTopo(palco);
  }
  await palco.captura(`12-balcao-programa-${l}`);
}

/* =========================================================================
   O site
   ========================================================================= */

async function site(palco, certo, l) {
  for (const [caminho, onde] of [['/', 'site · início'],
                                 ['/negocios/', 'site · negócios'],
                                 ['/privacidade/', 'site · privacidade'],
                                 ['/termos/', 'site · termos']]) {
    await palco.ir(caminho);
    await medir(palco, certo, onde, l);
  }
  await palco.captura(`12-site-termos-${l}`);
}

/* =========================================================================
   O cartaz do balcão

   Uma folha A4 medida em milímetros. 210 mm são 794 px — mais do dobro de um
   telemóvel — e o `max-width: 100%` encolhe a folha mas não encolhe nada do
   que lá está dentro, que continua em milímetros. É o único sítio do produto
   onde uma medida de papel se vê num ecrã, e é por isso que se testa aqui.
   ========================================================================= */

async function cartaz(palco, certo, l) {
  await palco.ir('/balcao/cartaz.html?n=Pastelaria%20do%20Rossio&c=%23B0446A'
    + '&p=Ao%20d%C3%A9cimo%20caf%C3%A9%2C%20o%20bolo%20%C3%A9%20por%20conta%20da%20casa'
    + '&s=pastelaria-do-rossio', { esperarPor: '#folha' });
  await palco.esperar('#quadro svg', 8000);

  const r = await medir(palco, certo, 'cartaz', l);

  const folha = await palco.js(`
    const f = document.getElementById('folha');
    const q = document.getElementById('quadro');
    if (!f || !q) return null;
    const rf = f.getBoundingClientRect(), rq = q.getBoundingClientRect();
    const svg = q.querySelector('svg');
    const rs = svg ? svg.getBoundingClientRect() : null;
    return {
      folha: { largura: Math.round(rf.width), altura: Math.round(rf.height),
               esquerda: Math.round(rf.left), direita: Math.round(rf.right) },
      quadro: { esquerda: Math.round(rq.left), direita: Math.round(rq.right) },
      qr: rs ? { largura: Math.round(rs.width), altura: Math.round(rs.height) } : null,
      pedeLargura: f.scrollWidth, temLargura: f.clientWidth,
      pedeAltura: f.scrollHeight, temAltura: f.clientHeight,
    };`);

  certo(!!folha && folha.quadro.esquerda >= folha.folha.esquerda - 1
    && folha.quadro.direita <= folha.folha.direita + 1,
    `cartaz @${l}: o quadro do QR cabe dentro da folha`,
    folha ? `quadro ${folha.quadro.esquerda}→${folha.quadro.direita}`
      + ` numa folha de ${folha.folha.esquerda}→${folha.folha.direita}` : 'sem folha');

  certo(!!folha && folha.qr && folha.qr.largura <= r.larg + 1,
    `cartaz @${l}: o QR cabe no ecrã`,
    folha && folha.qr ? `${folha.qr.largura}px num ecrã de ${r.larg}` : 'sem QR');

  /* A folha tem `overflow: hidden`: o que não couber desaparece sem aviso —
     e o que desaparece primeiro é o prémio, as instruções e o endereço, que
     são as três razões por que o cartaz existe. */
  certo(!!folha && folha.pedeLargura <= folha.temLargura + 1,
    `cartaz @${l}: nada da folha fica escondido pelo lado`,
    folha ? `o conteúdo pede ${folha.pedeLargura}px e a folha dá ${folha.temLargura}px` : '');
  certo(!!folha && folha.pedeAltura <= folha.temAltura + 1,
    `cartaz @${l}: nada da folha fica escondido por baixo`,
    folha ? `o conteúdo pede ${folha.pedeAltura}px de altura e a folha dá ${folha.temAltura}px` : '');

  await palco.captura(`12-cartaz-${l}`);
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  for (const { largura, altura } of ECRAS) {
    await palco.tamanho(largura, altura);
    await appDoCliente(palco, certo, largura);

    const publico = await prepararPremio(palco);
    certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(String(publico)),
      `@${largura}: há um cliente de demonstração para o balcão carimbar`,
      String(publico));

    await balcao(palco, certo, largura, publico);
    await site(palco, certo, largura);
    await cartaz(palco, certo, largura);
  }
}
