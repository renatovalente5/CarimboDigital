/* =========================================================================
   Bateria · 15 — o site público

   O site é a única parte do Carimbo Digital que uma pessoa vê antes de
   confiar nele. Não tem JavaScript nenhum, o que o torna simples de servir e
   traiçoeiro de testar: não há estado para conduzir, só texto e ligações —
   e é exactamente aí que os defeitos se escondem sem fazer barulho.

   Quatro coisas que este módulo persegue de propósito:

   · A LIGAÇÃO QUE NÃO VAI DAR A LADO NENHUM. Um `href` partido não rebenta,
     não avisa e não aparece em captura nenhuma: só devolve 404 a quem lá
     carregou. Por isso percorrem-se TODOS os `a[href]` das cinco páginas,
     resolvem-se contra a página onde estão (as relativas incluídas) e
     pede-se cada uma ao servidor. Contar ficheiros não prova ligações.

   · O NÚMERO QUE FUGIU DA PÁGINA LEGAL. Os prazos de conservação da política
     de privacidade são lidos do Worker na construção, porque já tinham
     fugido uma vez — a página prometia 20 minutos e o código apagava aos 15.
     Aqui lê-se o Worker outra vez, do zero, e compara-se com o que está
     escrito no ecrã. Se a ligação se partir, parte aqui.

   · O TEXTO QUE NÃO SE LÊ. A app teve o contraste medido e corrigido; o site
     nunca. Mede-se aqui de raiz — a WCAG escrita outra vez, para não
     concordar com um erro da app — em claro e em escuro, elemento a
     elemento, com as opacidades multiplicadas pelo caminho.

   · O QUE A CONSTRUÇÃO PROMETE E NINGUÉM CUMPRE. Um marcador `{{...}}` por
     resolver, um «POR PREENCHER» numa página legal, uma regra de CSS que
     espera um atributo que ninguém escreve. São todos silenciosos.

   Não precisa do modo de demonstração: o site não fala com o Worker. As duas
   apps só são abertas para provar que os botões de topo lá vão dar — e com o
   armazenamento limpo elas param nas boas-vindas, sem tocar na rede.
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

/* O mesmo raciocínio do gerador e do servidor: com domínio próprio o site
   fica na raiz, sem ele fica debaixo do nome do repositório. Derivar em vez
   de escrever à mão é o que impede este módulo de mentir quando o CNAME
   aparecer. */
const BASE = existsSync(join(RAIZ, 'CNAME')) ? '' : '/CarimboDigital';

const config = JSON.parse(readFileSync(join(RAIZ, '_fonte', 'config.json'), 'utf8'));
const FONTE_WORKER = readFileSync(join(RAIZ, 'worker', 'src', 'index.js'), 'utf8');

export const nome = '15 · O site público';
export const ecra = { largura: 1280, altura: 900 };
export const desculpar = [/favicon/];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   As quatro páginas, e o que a fonte diz que elas deviam ser

   O título e a descrição não são copiados para aqui à mão: leem-se do
   cabeçalho YAML da própria página. Assim o teste continua a valer quando o
   texto mudar — e um título que mude na fonte sem chegar ao <head> passa a
   ser uma falha, que é o que se quer.
   ========================================================================= */

function cabecalhoDaFonte(ficheiro) {
  const cru = readFileSync(join(RAIZ, '_fonte', 'paginas', ficheiro), 'utf8');
  const m = cru.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = {};
  if (m) {
    for (const linha of m[1].split('\n')) {
      const i = linha.indexOf(':');
      if (i > 0) meta[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
    }
  }
  return meta;
}

const PAGINAS = [
  { rota: '/', fonte: 'inicio.html' },
  { rota: '/negocios/', fonte: 'negocios.html' },
  { rota: '/privacidade/', fonte: 'privacidade.html' },
  { rota: '/termos/', fonte: 'termos.html' },
].map((p) => ({ ...p, esperado: cabecalhoDaFonte(p.fonte) }));

/**
 * Uma constante numérica do Worker.
 *
 * Escrita de raiz e não importada do gerador de propósito: se o gerador
 * passar a ler mal, um teste que usasse a função dele concordava com o erro.
 */
function constanteDoWorker(nome) {
  const m = FONTE_WORKER.match(new RegExp(`\\bconst\\s+${nome}\\s*=\\s*(\\d+)\\s*;`));
  return m ? Number(m[1]) : null;
}

const PRAZOS = {
  ENTRADA_MINUTOS: constanteDoWorker('ENTRADA_MINUTOS'),
  SESSAO_DIAS: constanteDoWorker('SESSAO_DIAS'),
  USADOS_HORAS: constanteDoWorker('USADOS_HORAS'),
  JANELA: constanteDoWorker('JANELA'),
};

/* =========================================================================
   Contraste — medido aqui, de raiz

   Igual ao que o módulo 02 faz com o cartão, e pela mesma razão: se a
   fórmula da app estiver errada, um teste que a importasse concordaria com
   o erro. Isto é a WCAG 2 escrita outra vez.
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

function misturar(frente, atras, alfa) {
  return {
    r: frente.r * alfa + atras.r * (1 - alfa),
    g: frente.g * alfa + atras.g * (1 - alfa),
    b: frente.b * alfa + atras.b * (1 - alfa),
  };
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

/** O mínimo da WCAG AA: 3 para texto grande, 4,5 para o resto. */
function minimoPara(px, peso) {
  const grande = px >= 24 || (px >= 18.66 && peso >= 700);
  return grande ? 3 : 4.5;
}

/**
 * Despeja cada elemento que tenha texto próprio, com a cor e o fundo em que
 * assenta.
 *
 * O fundo procura-se a subir: o primeiro antepassado que pinte mesmo alguma
 * coisa opaca. Pelo caminho multiplicam-se as opacidades, porque o que chega
 * aos olhos é a mistura e não a cor declarada. Um elemento que pinte o seu
 * próprio fundo é caso à parte — aí a opacidade desmaia texto e fundo ao
 * mesmo tempo e a razão entre eles não muda.
 */
async function medirTextos(palco) {
  return palco.js(`
    const opaco = (cor) => { const p = String(cor).match(/[\\d.]+/g);
      return p && (p.length < 4 || Number(p[3]) > 0.95); };
    const nomear = (n) => n.tagName.toLowerCase()
      + (typeof n.className === 'string' && n.className.trim()
        ? '.' + n.className.trim().split(/\\s+/).join('.') : '');

    const saida = [];
    for (const n of document.querySelectorAll('body *')) {
      if (n.closest('[hidden]')) continue;
      const proprio = [...n.childNodes]
        .filter((c) => c.nodeType === 3 && c.textContent.trim().length > 1)
        .map((c) => c.textContent).join(' ').replace(/\\s+/g, ' ').trim();
      if (!proprio) continue;

      const e = getComputedStyle(n);
      if (e.display === 'none' || e.visibility === 'hidden') continue;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;

      let alfa, fundo = null;
      if (opaco(e.backgroundColor)) { alfa = 1; fundo = e.backgroundColor; }
      else {
        alfa = Number(e.opacity);
        let p = n.parentElement;
        while (p) {
          const pe = getComputedStyle(p);
          if (opaco(pe.backgroundColor)) { fundo = pe.backgroundColor; break; }
          alfa *= Number(pe.opacity);
          p = p.parentElement;
        }
      }

      saida.push({
        onde: nomear(n), texto: proprio.slice(0, 28),
        cor: e.color, fundo: fundo || 'rgb(255, 255, 255)', alfa,
        px: parseFloat(e.fontSize), peso: Number(e.fontWeight) || 400,
      });
    }
    return saida;`);
}

function avaliarTextos(medidos) {
  const saida = [];
  for (const t of medidos) {
    const cor = corParaRGB(t.cor), fundo = corParaRGB(t.fundo);
    if (!cor || !fundo) continue;
    const efectiva = misturar(cor, fundo, t.alfa * (cor.a ?? 1));
    saida.push({
      ...t,
      contraste: razao(efectiva, fundo),
      minimo: minimoPara(t.px, t.peso),
    });
  }
  return saida;
}

const linhaDeFalha = (t) => `${t.onde} «${t.texto}» ${t.contraste.toFixed(2)}:1`
  + ` (pede ${t.minimo}, ${t.px}px, opacidade ${t.alfa.toFixed(2)})`;

/* =========================================================================
   Ler a cabeça de uma página
   ========================================================================= */

async function cabeca(palco) {
  return palco.js(`
    const q = (s, a) => { const n = document.querySelector(s); return n ? n.getAttribute(a) : null; };
    return {
      url: location.pathname,
      titulo: document.title,
      lang: document.documentElement.getAttribute('lang'),
      charset: q('meta[charset]', 'charset'),
      viewport: q('meta[name="viewport"]', 'content'),
      descricao: q('meta[name="description"]', 'content'),
      canonico: q('link[rel="canonical"]', 'href'),
      robots: q('meta[name="robots"]', 'content'),
      ogTipo: q('meta[property="og:type"]', 'content'),
      ogTitulo: q('meta[property="og:title"]', 'content'),
      ogDescricao: q('meta[property="og:description"]', 'content'),
      ogUrl: q('meta[property="og:url"]', 'content'),
      ogImagem: q('meta[property="og:image"]', 'content'),
      ogLocal: q('meta[property="og:locale"]', 'content'),
      twitter: q('meta[name="twitter:card"]', 'content'),
      temas: [...document.querySelectorAll('meta[name="theme-color"]')]
        .map((n) => (n.getAttribute('media') || 'sempre') + '=' + n.getAttribute('content')),
      h1: [...document.querySelectorAll('h1')]
        .map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
      temPrincipal: !!document.getElementById('principal'),
      temCabecalho: !!document.querySelector('header.cabecalho'),
      temRodape: !!document.querySelector('footer.rodape'),
      marcadores: (document.documentElement.outerHTML.match(/\\{\\{[^}]*\\}\\}/g) || []).slice(0, 3),
      porPreencher: document.documentElement.outerHTML.includes('POR PREENCHER'),
      rascunho: document.body.innerText.includes('Rascunho.'),
      lixo: (document.body.innerText.match(/undefined|NaN|\\[object Object\\]/g) || []).slice(0, 3),
      corpo: document.body.innerText.replace(/\\s+/g, ' ').trim(),
      /* O innerText só traz o que está aberto: as respostas dentro de um
         <details> fechado não aparecem lá. Para procurar uma frase no texto
         da página é preciso o textContent, que as traz na mesma. */
      corpoTodo: document.body.textContent.replace(/\\s+/g, ' ').trim(),
    };`);
}

/** Todas as ligações da página, já resolvidas contra o endereço onde estão. */
async function ligacoes(palco) {
  return palco.js(`
    return [...document.querySelectorAll('a[href]')].map((a) => {
      const cru = a.getAttribute('href');
      let u = null;
      try { u = new URL(cru, location.href); } catch (e) { /* href impossível */ }
      return {
        cru,
        texto: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        protocolo: u ? u.protocol : null,
        mesmaOrigem: !!u && u.origin === location.origin,
        semAncora: u && u.origin === location.origin ? u.origin + u.pathname + u.search : null,
        caminho: u && u.origin === location.origin ? u.pathname : null,
        ancora: u ? decodeURIComponent(u.hash.slice(1)) : '',
        externo: !!u && u.origin !== location.origin && /^https?:$/.test(u.protocol),
        alvo: u ? u.href : null,
      };
    });`);
}

/** Pede cada endereço ao servidor e devolve o estado que ele deu. */
async function estados(palco, urls) {
  return palco.js(`
    const saida = {};
    for (const u of ${JSON.stringify(urls)}) {
      try {
        const r = await fetch(u, { redirect: 'manual' });
        saida[u] = r.status;
      } catch (e) { saida[u] = 'não respondeu: ' + e.message; }
    }
    return saida;`);
}

/** Carrega uma página e diz quais destas âncoras lá existem mesmo. */
async function ancorasDe(palco, caminho, ancoras) {
  await palco.ir(caminho.replace(BASE, '') || '/');
  return palco.js(`
    const saida = {};
    for (const a of ${JSON.stringify(ancoras)}) saida[a] = !!document.getElementById(a);
    return saida;`);
}

/** Espera que a página pare de deslizar, e diz onde ficou. */
async function scrollAssente(palco, tecto = 3000) {
  const limite = Date.now() + tecto;
  let anterior = null, iguais = 0;
  for (;;) {
    const y = await palco.js('return Math.round(window.scrollY)');
    if (y === anterior) { iguais++; if (iguais >= 3) return y; } else { iguais = 0; }
    anterior = y;
    if (Date.now() > limite) return y;
    await dormir(100);
  }
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* O site é um site: tem de ser visto num ecrã de site. As ligações do topo
     só existem acima de 760px, e é nesse tamanho que a maior parte de quem
     chega por uma pesquisa o abre. O telemóvel vem no fim, à parte. */
  await palco.tamanho(1280, 900);
  await palco.ir('/');

  /* =======================================================================
     1. As quatro páginas abrem
     ======================================================================= */

  const cabecas = {};
  for (const p of PAGINAS) {
    await palco.ir(p.rota);
    const c = await cabeca(palco);
    cabecas[p.rota] = c;

    const estado = await palco.js(
      `const r = await fetch(location.href); return r.status`);
    certo(estado === 200, `${p.rota}: o servidor devolve 200`, String(estado));
    certo(c.url === `${BASE}${p.rota}`,
      `${p.rota}: fica no endereço que se pediu`, String(c.url));
    certo(c.lang === 'pt-PT', `${p.rota}: o html declara pt-PT`, String(c.lang));
    certo(String(c.charset).toLowerCase() === 'utf-8',
      `${p.rota}: declara utf-8`, String(c.charset));
    certo(/width=device-width/.test(String(c.viewport)),
      `${p.rota}: tem viewport de telemóvel`, String(c.viewport));
    certo(c.h1.length === 1,
      `${p.rota}: tem exactamente um h1`, `tem ${c.h1.length}: ${c.h1.join(' | ')}`);
    certo(!!c.h1[0] && c.h1[0].length > 5,
      `${p.rota}: o h1 diz alguma coisa`, String(c.h1[0]));
    certo(c.temPrincipal && c.temCabecalho && c.temRodape,
      `${p.rota}: traz cabeçalho, conteúdo e rodapé`,
      `principal=${c.temPrincipal} cabeçalho=${c.temCabecalho} rodapé=${c.temRodape}`);
    certo(c.corpo.length > 600,
      `${p.rota}: o corpo tem mesmo texto`, `${c.corpo.length} caracteres`);
  }

  await palco.ir('/');
  await palco.captura('15-inicio');

  /* =======================================================================
     2. Títulos, descrições e o resto da cabeça

     O que aqui se compara não foi escrito à mão: sai do cabeçalho YAML da
     própria página. Um título que mude na fonte e não chegue ao <head>
     denuncia-se sozinho.
     ======================================================================= */

  for (const p of PAGINAS) {
    const c = cabecas[p.rota];
    certo(c.titulo === p.esperado.titulo,
      `${p.rota}: o título é o que a fonte manda`,
      `«${c.titulo}» ≠ «${p.esperado.titulo}»`);
    /* Acima disto o Google corta a meio, e o corte cai quase sempre no
       pedaço que distinguia esta página das outras. */
    certo(c.titulo.length <= 65,
      `${p.rota}: o título cabe num resultado de pesquisa`,
      `${c.titulo.length} caracteres`);

    certo(c.descricao === p.esperado.resumo,
      `${p.rota}: a descrição é a que a fonte manda`,
      `«${c.descricao}» ≠ «${p.esperado.resumo}»`);
    certo(c.descricao && c.descricao.length >= 50 && c.descricao.length <= 165,
      `${p.rota}: a descrição tem tamanho de descrição (50 a 165)`,
      `${c.descricao ? c.descricao.length : 0} caracteres`);

    const canonicoEsperado = `https://${config.dominio}${p.rota}`;
    certo(c.canonico === canonicoEsperado,
      `${p.rota}: o canónico aponta para si próprio`,
      `${c.canonico} ≠ ${canonicoEsperado}`);

    certo(c.ogTitulo === c.titulo,
      `${p.rota}: o og:title acompanha o título`, `${c.ogTitulo} ≠ ${c.titulo}`);
    certo(c.ogDescricao === c.descricao,
      `${p.rota}: o og:description acompanha a descrição`, String(c.ogDescricao));
    certo(c.ogUrl === c.canonico,
      `${p.rota}: o og:url acompanha o canónico`, `${c.ogUrl} ≠ ${c.canonico}`);
    certo(c.ogTipo === 'website', `${p.rota}: og:type é website`, String(c.ogTipo));
    certo(c.ogLocal === 'pt_PT', `${p.rota}: og:locale é pt_PT`, String(c.ogLocal));
    certo(c.twitter === 'summary_large_image',
      `${p.rota}: o cartão do Twitter é o grande`, String(c.twitter));
    /* Duas cores de barra: uma para o telemóvel em claro, outra para o
       escuro. Uma só e metade das pessoas fica com a barra errada. */
    certo(c.temas.length === 2 && c.temas.some((t) => t.includes('light'))
      && c.temas.some((t) => t.includes('dark')),
      `${p.rota}: declara cor de barra para claro e para escuro`, c.temas.join(' · '));
  }

  const titulos = PAGINAS.map((p) => cabecas[p.rota].titulo);
  certo(new Set(titulos).size === titulos.length,
    'cabeça: cada página tem o seu título — não há dois iguais', titulos.join(' | '));
  const descricoes = PAGINAS.map((p) => cabecas[p.rota].descricao);
  certo(new Set(descricoes).size === descricoes.length,
    'cabeça: cada página tem a sua descrição', descricoes.join(' | '));
  const canonicos = PAGINAS.map((p) => cabecas[p.rota].canonico);
  certo(new Set(canonicos).size === canonicos.length,
    'cabeça: cada página tem o seu canónico', canonicos.join(' | '));

  /* =======================================================================
     3. A imagem social

     É a única coisa do site que se vê antes de o site abrir: é ela que
     aparece no WhatsApp quando alguém partilha a ligação. Se o ficheiro não
     existir, não há erro nenhum — aparece um rectângulo vazio.
     ======================================================================= */

  const imagens = PAGINAS.map((p) => cabecas[p.rota].ogImagem);
  certo(new Set(imagens).size === 1 && imagens[0],
    'social: as quatro páginas anunciam a mesma imagem', imagens.join(' | '));
  certo(/^https:\/\//.test(String(imagens[0])),
    'social: o og:image é um endereço absoluto — um caminho relativo não serve a nenhum leitor',
    String(imagens[0]));

  /* O endereço aponta para o domínio final; o ficheiro que ele nomeia tem de
     existir mesmo no que se publica. Traduz-se o caminho para este servidor. */
  const caminhoSocial = BASE + new URL(String(imagens[0])).pathname;
  const social = await palco.js(`
    const r = await fetch(${JSON.stringify(caminhoSocial)});
    if (!r.ok) return { estado: r.status };
    const b = await r.blob();
    const bmp = await createImageBitmap(b);
    return { estado: r.status, tipo: b.type, bytes: b.size,
             largura: bmp.width, altura: bmp.height };`);
  certo(social.estado === 200,
    `social: o ficheiro ${caminhoSocial} existe no site construído`,
    JSON.stringify(social));
  certo(social.largura >= 1200 && social.altura >= 630,
    'social: a imagem tem pelo menos 1200×630, o mínimo que o Facebook aceita sem esticar',
    `${social.largura}×${social.altura}`);
  certo(Math.abs(social.largura / social.altura - 1.91) < 0.06,
    'social: e a proporção de 1,91:1 que os cartões grandes recortam',
    `${(social.largura / social.altura).toFixed(3)}:1`);
  certo(social.bytes > 5000 && social.bytes < 1200000,
    'social: pesa o que uma imagem social pesa', `${social.bytes} bytes`);

  /* =======================================================================
     4. Todas as ligações internas vão dar a algum sítio

     Isto é o coração do módulo. Um `href` partido é o defeito mais barato de
     cometer e o mais caro de descobrir: não rebenta, não avisa, e só quem
     carregou é que leva com o 404.
     ======================================================================= */

  const todas = [];
  for (const p of PAGINAS) {
    await palco.ir(p.rota);
    for (const l of await ligacoes(palco)) todas.push({ ...l, onde: p.rota });
  }

  certo(todas.length >= 40,
    'ligações: há mesmo ligações para verificar nas quatro páginas',
    `apanhei ${todas.length}`);

  const vazias = todas.filter((l) => !l.cru || l.cru.trim() === ''
    || l.cru.trim() === '#' || /\{\{|\}\}/.test(l.cru));
  certo(vazias.length === 0,
    'ligações: nenhuma está vazia, a «#» ou com marcador por resolver',
    vazias.map((l) => `${l.onde}: «${l.cru}» (${l.texto})`).join(' · '));

  /* Um caminho absoluto sem o prefixo do GitHub Pages aponta para fora do
     site — é o clássico site publicado com as ligações todas partidas. */
  if (BASE) {
    const nus = todas.filter((l) => l.mesmaOrigem && l.caminho
      && !l.caminho.startsWith(BASE + '/') && l.caminho !== BASE);
    certo(nus.length === 0,
      `ligações: todos os caminhos internos levam o prefixo ${BASE}`,
      nus.map((l) => `${l.onde}: ${l.cru}`).join(' · '));
  }

  const internas = [...new Set(todas.filter((l) => l.mesmaOrigem && l.semAncora)
    .map((l) => l.semAncora))].sort();
  certo(internas.length >= 6,
    'ligações: há endereços internos distintos para pedir ao servidor',
    `${internas.length} endereços`);

  const respostas = await estados(palco, internas);
  const partidas = internas.filter((u) => respostas[u] !== 200);
  certo(partidas.length === 0,
    `ligações: as ${internas.length} internas devolvem todas 200`,
    partidas.map((u) => `${u.replace(/^https?:\/\/[^/]+/, '')} → ${respostas[u]}`
      + ` (de ${todas.filter((l) => l.semAncora === u).map((l) => l.onde).join(', ')})`).join(' · '));

  /* Uma âncora que não existe não dá 404: dá uma página que não salta para
     lado nenhum, e ninguém percebe porquê. */
  const porAncora = new Map();
  for (const l of todas) {
    if (!l.mesmaOrigem || !l.ancora) continue;
    const caminho = new URL(l.semAncora).pathname;
    if (!porAncora.has(caminho)) porAncora.set(caminho, new Set());
    porAncora.get(caminho).add(l.ancora);
  }
  let ancorasVistas = 0;
  for (const [caminho, conjunto] of porAncora) {
    const lista = [...conjunto];
    const existe = await ancorasDe(palco, caminho, lista);
    const faltam = lista.filter((a) => !existe[a]);
    ancorasVistas += lista.length;
    certo(faltam.length === 0,
      `âncoras: ${caminho} tem as secções ${lista.map((a) => `#${a}`).join(', ')}`,
      `faltam ${faltam.map((a) => `#${a}`).join(', ')}`);
  }
  certo(ancorasVistas >= 3,
    'âncoras: houve âncoras para verificar', `${ancorasVistas} verificadas`);

  const externas = [...new Set(todas.filter((l) => l.externo).map((l) => l.alvo))];
  certo(externas.length > 0 && externas.every((u) => u.startsWith('https://')),
    'ligações: as externas são todas por https',
    externas.filter((u) => !u.startsWith('https://')).join(' · ') || `${externas.length} externas`);

  const correios = [...new Set(todas.filter((l) => l.protocolo === 'mailto:')
    .map((l) => l.cru.replace('mailto:', '')))];
  certo(correios.length > 0 && correios.every((e) => e === config.contacto
    || e === config.entidade.email),
    'ligações: os mailto usam o contacto do config, sem endereços perdidos',
    correios.join(' · '));

  /* =======================================================================
     5. Os botões de topo levam mesmo às apps

     Um `href` certo não prova nada se o botão estiver tapado, sem tamanho ou
     debaixo do cabeçalho. Estes carregam-se com o rato.
     ======================================================================= */

  for (const p of PAGINAS) {
    await palco.ir(p.rota);
    const topo = await palco.js(`
      const a = document.querySelector('header.cabecalho a.btn');
      if (!a) return null;
      return { texto: a.textContent.trim(), href: a.getAttribute('href'),
               altura: Math.round(a.getBoundingClientRect().height) };`);
    certo(!!topo && topo.href === `${BASE}/app/`,
      `${p.rota}: o botão do topo aponta para a app`, JSON.stringify(topo));
    certo(!!topo && topo.texto === 'Abrir a app',
      `${p.rota}: e diz o que faz`, topo ? topo.texto : 'não há botão');
    certo(await palco.visivel('header.cabecalho a.btn'),
      `${p.rota}: o botão do topo está à vista`);
    /* A WCAG 2.2 pede 24 px de alvo; o sistema promete 40 no botão pequeno. */
    certo(!!topo && topo.altura >= 40,
      `${p.rota}: o botão do topo tem alvo de dedo`, `${topo ? topo.altura : 0}px`);
  }

  await palco.ir('/');
  await palco.clicar('header.cabecalho a.btn');
  await palco.pronta(10000);
  await dormir(400);
  certo(await palco.js('return location.pathname') === `${BASE}/app/`,
    'topo: carregar no botão leva mesmo à app do cliente',
    String(await palco.js('return location.pathname')));
  certo(await palco.ver('#aplicacao') && await palco.visivel('#boas-vindas'),
    'topo: e a app do cliente abre de facto, nas boas-vindas',
    `#aplicacao=${await palco.ver('#aplicacao')} #boas-vindas=${await palco.visivel('#boas-vindas')}`);

  await palco.ir('/negocios/');
  const paraBalcao = await palco.js(`
    const a = [...document.querySelectorAll('.heroi a.btn')]
      .find((x) => x.getAttribute('href') === ${JSON.stringify(`${BASE}/balcao/`)});
    if (!a) return null;
    a.id = 'alvo-balcao';
    return a.textContent.trim();`);
  certo(!!paraBalcao, 'negócios: o herói tem um botão para o balcão', String(paraBalcao));
  await palco.clicar('#alvo-balcao');
  await palco.pronta(10000);
  await dormir(400);
  certo(await palco.js('return location.pathname') === `${BASE}/balcao/`,
    'negócios: o botão do herói leva mesmo ao balcão',
    String(await palco.js('return location.pathname')));
  certo(await palco.visivel('#entrada'),
    'negócios: e o balcão abre na entrada');

  /* O rodapé é a outra porta, e é o único sítio do site que a anuncia. */
  await palco.ir('/termos/');
  await palco.js(`
    const a = [...document.querySelectorAll('footer.rodape a')]
      .find((x) => x.getAttribute('href') === ${JSON.stringify(`${BASE}/balcao/`)});
    if (a) a.id = 'rodape-balcao';
    return !!a`);
  certo(await palco.ver('#rodape-balcao'),
    'rodapé: há uma porta para o balcão em todas as páginas');
  await palco.clicar('#rodape-balcao');
  await palco.pronta(10000);
  await dormir(400);
  certo(await palco.js('return location.pathname') === `${BASE}/balcao/`,
    'rodapé: a ligação do balcão leva mesmo ao balcão',
    String(await palco.js('return location.pathname')));

  /* E o caminho por onde uma pessoa chega às páginas legais. */
  await palco.ir('/');
  await palco.js(`
    const a = [...document.querySelectorAll('footer.rodape a')]
      .find((x) => x.getAttribute('href') === ${JSON.stringify(`${BASE}/privacidade/`)});
    if (a) a.id = 'rodape-privacidade';
    return !!a`);
  await palco.clicar('#rodape-privacidade');
  await palco.pronta(10000);
  await dormir(300);
  certo(await palco.js('return location.pathname') === `${BASE}/privacidade/`,
    'rodapé: a privacidade alcança-se a carregar, não só a escrever o endereço',
    String(await palco.js('return location.pathname')));

  /* =======================================================================
     6. A página 404
     ======================================================================= */

  const perdido = `${BASE}/isto-nao-existe-de-certeza/`;
  const quatroZeroQuatro = await palco.js(`
    const r = await fetch(${JSON.stringify(perdido)});
    const t = await r.text();
    return { estado: r.status, tamanho: t.length, texto: t };`);
  certo(quatroZeroQuatro.estado === 404,
    '404: um endereço que não existe devolve 404, e não 200',
    String(quatroZeroQuatro.estado));
  certo(quatroZeroQuatro.tamanho > 500,
    '404: e devolve uma página, não uma linha de texto',
    `${quatroZeroQuatro.tamanho} bytes`);

  await palco.ir('/isto-nao-existe-de-certeza/');
  const c404 = await cabeca(palco);
  certo(c404.temCabecalho && c404.temRodape,
    '404: quem se perde continua dentro do site, com cabeçalho e rodapé');

  /* A pessoa que escreveu mal o endereço tem de perceber que se enganou. Uma
     página que devolve 404 e mostra a página inicial deixa-a a pensar que o
     que procurava desapareceu — ou pior, que o clicou mal. */
  certo(/não encontr|não existe esta|página não|404/i.test(c404.corpoTodo),
    '404: a página diz a quem lá chega que o endereço não existe',
    `título «${c404.titulo}», e o corpo começa por «${c404.corpo.slice(0, 60)}»`);

  /* E os motores de busca têm de ouvir o mesmo. Um canónico a apontar para a
     página inicial diz-lhes que cada endereço partido É a página inicial. */
  certo(c404.canonico !== cabecas['/'].canonico,
    '404: não se anuncia aos motores como sendo a página inicial',
    `canónico ${c404.canonico}`);

  const inicioCru = await palco.js(`
    const r = await fetch(${JSON.stringify(`${BASE}/`)}); return await r.text()`);
  certo(quatroZeroQuatro.texto !== inicioCru,
    '404: não é uma cópia byte a byte da página inicial',
    `${quatroZeroQuatro.texto.length} bytes iguais aos ${inicioCru.length} do índice`);

  /* =======================================================================
     7. Marcadores por resolver

     `{{ENT_NIF}}` numa página legal é pior do que um número errado: percebe-se
     logo que ninguém leu aquilo antes de publicar.
     ======================================================================= */

  for (const p of PAGINAS) {
    const c = cabecas[p.rota];
    certo(c.marcadores.length === 0,
      `${p.rota}: nenhum marcador {{...}} por resolver`, c.marcadores.join(' · '));
    certo(!c.porPreencher,
      `${p.rota}: nenhum «POR PREENCHER» à vista`);
    certo(c.lixo.length === 0,
      `${p.rota}: nada de «undefined», «NaN» ou «[object Object]»`, c.lixo.join(' · '));
  }

  const ficheirosCrus = await palco.js(`
    const saida = {};
    for (const f of ['robots.txt', 'sitemap.xml']) {
      const r = await fetch(${JSON.stringify(BASE)} + '/' + f);
      saida[f] = { estado: r.status, texto: await r.text() };
    }
    return saida;`);
  for (const f of ['robots.txt', 'sitemap.xml']) {
    certo(ficheirosCrus[f].estado === 200 && !/\{\{/.test(ficheirosCrus[f].texto),
      `${f}: existe e não tem marcadores por resolver`,
      `${ficheirosCrus[f].estado} · ${ficheirosCrus[f].texto.slice(0, 60)}`);
  }

  /* =======================================================================
     8. As páginas legais têm quem responde

     O DL 7/2004 (art. 10) e o RGPD (art. 13) obrigam a nome, NIF, morada e
     contacto. Já aconteceu noutro sítio: o backoffice apagou a morada e o CI
     publicou na mesma. Aqui procura-se no ecrã, não no ficheiro de dados.
     ======================================================================= */

  const entidade = config.entidade || {};
  for (const chave of ['nome', 'nif', 'morada', 'email', 'responsavel_dados']) {
    certo(!!String(entidade[chave] || '').trim(),
      `config: a entidade tem ${chave} preenchido`, String(entidade[chave]));
  }
  certo(config.producao === true,
    'config: o site está marcado como produção — as páginas legais valem a sério',
    String(config.producao));

  for (const rota of ['/privacidade/', '/termos/']) {
    const corpo = cabecas[rota].corpo;
    certo(corpo.includes(entidade.nome),
      `${rota}: diz quem responde («${entidade.nome}»)`);
    certo(new RegExp(`NIF\\s+${entidade.nif}`).test(corpo),
      `${rota}: diz o NIF, e diz que é um NIF`,
      (corpo.match(/NIF[^.]{0,20}/) || ['não encontrei a palavra NIF'])[0]);
    certo(corpo.includes(entidade.morada),
      `${rota}: diz a morada por inteiro`,
      (corpo.match(/morada em[^.]{0,90}/) || ['não encontrei a morada'])[0]);
    certo(!cabecas[rota].rascunho,
      `${rota}: já não traz o aviso de rascunho`);
  }

  for (const rota of ['/privacidade/', '/termos/']) {
    await palco.ir(rota);
    const escrever = await palco.js(`
      return [...document.querySelectorAll('#principal a[href^="mailto:"]')]
        .map((a) => a.getAttribute('href').replace('mailto:', ''))`);
    certo(escrever.length > 0 && escrever.every((e) => e === entidade.email),
      `${rota}: dá um endereço a quem quiser escrever, e é o da entidade`,
      escrever.join(' · ') || 'nenhum');
  }

  /* O nome do responsável pelos dados é um campo à parte no config — se
     ninguém o usar, é um campo que se preenche e não vai a lado nenhum. */
  certo(cabecas['/privacidade/'].corpo.includes(entidade.responsavel_dados),
    'privacidade: o responsável pelo tratamento dos dados aparece na página',
    String(entidade.responsavel_dados));

  /* A autoridade de controlo é o recurso de quem se sentir mal tratado: o
     RGPD (art. 13, n.º 2, al. d) obriga a dizer que ele existe. */
  await palco.ir('/privacidade/');
  const autoridade = await palco.js(
    `return [...document.querySelectorAll('#principal a')].map((a) => a.href)`);
  certo(autoridade.some((u) => /cnpd\.pt/.test(u)),
    'privacidade: aponta a CNPD a quem quiser reclamar', autoridade.join(' '));
  /* E a resolução alternativa de litígios, do lado dos termos. */
  await palco.ir('/termos/');
  const litigios = await palco.js(
    `return [...document.querySelectorAll('#principal a')].map((a) => a.href)`);
  certo(litigios.some((u) => /consumidor\.gov\.pt/.test(u)),
    'termos: aponta a via de resolução de litígios de consumo', litigios.join(' '));

  /* =======================================================================
     9. Os prazos de conservação batem certo com o Worker

     Foram escritos à mão uma vez e fugiram: a página prometia 20 minutos e o
     código apagava aos 15. Passaram a ser lidos de worker/src/index.js na
     construção. Isto verifica que a ligação não se partiu — lendo o Worker
     outra vez, aqui, sem passar pelo gerador.
     ======================================================================= */

  for (const [chave, valor] of Object.entries(PRAZOS)) {
    certo(Number.isInteger(valor) && valor > 0,
      `worker: a constante ${chave} continua a existir e é um número`, String(valor));
  }

  await palco.ir('/privacidade/');
  const conservacao = await palco.js(`
    const titulo = [...document.querySelectorAll('#principal h2')]
      .find((h) => /Durante quanto tempo/i.test(h.textContent));
    if (!titulo) return null;
    let n = titulo.nextElementSibling;
    while (n && n.tagName !== 'UL') n = n.nextElementSibling;
    if (!n) return null;
    return [...n.querySelectorAll('li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim());`);

  certo(Array.isArray(conservacao) && conservacao.length >= 4,
    'privacidade: há uma lista de prazos de conservação',
    conservacao ? `${conservacao.length} linhas` : 'não encontrei a secção');

  const prazoNaLista = (rotulo, unidade) => {
    const linha = (conservacao || []).find((l) => l.startsWith(rotulo));
    if (!linha) return { linha: null, valor: null };
    const m = linha.match(new RegExp(`(\\d+)\\s*${unidade}`));
    return { linha, valor: m ? Number(m[1]) : null };
  };

  const usados = prazoNaLista('Códigos já usados', 'horas');
  certo(usados.valor === PRAZOS.USADOS_HORAS,
    `privacidade: os códigos usados guardam-se as ${PRAZOS.USADOS_HORAS} horas que o Worker cumpre`,
    `a página diz ${usados.valor} — «${usados.linha}»`);

  const sessoes = prazoNaLista('Sessões', 'dias');
  certo(sessoes.valor === PRAZOS.SESSAO_DIAS,
    `privacidade: as sessões duram os ${PRAZOS.SESSAO_DIAS} dias que o Worker cumpre`,
    `a página diz ${sessoes.valor} — «${sessoes.linha}»`);

  const email = prazoNaLista('Códigos enviados por email', 'minutos');
  certo(email.valor === PRAZOS.ENTRADA_MINUTOS,
    `privacidade: o código do email vale os ${PRAZOS.ENTRADA_MINUTOS} minutos que o Worker cumpre`,
    `a página diz ${email.valor} — «${email.linha}»`);

  /* A janela do código QR não passa por marcador nenhum: está escrita à mão
     em três sítios do site. Enquanto coincidir com o Worker está tudo bem —
     e no dia em que deixar de coincidir, é aqui que se sabe. */
  certo(PRAZOS.JANELA === 15 && cabecas['/privacidade/'].corpo.includes('quinze segundos'),
    `privacidade: «quinze segundos» é a janela que o Worker usa (JANELA=${PRAZOS.JANELA})`,
    `JANELA=${PRAZOS.JANELA}, a página diz «quinze segundos»`);
  for (const rota of ['/', '/negocios/']) {
    /* Dentro de um <details> fechado — daí o textContent e não o innerText. */
    certo(new RegExp(`muda a cada ${PRAZOS.JANELA} segundos`).test(cabecas[rota].corpoTodo),
      `${rota}: a resposta às perguntas diz os ${PRAZOS.JANELA} segundos do Worker`,
      (cabecas[rota].corpoTodo.match(/muda a cada \d+ segundos/) || ['não diz'])[0]);
  }

  /* =======================================================================
     10. As duas apps ficam fora dos motores de busca

     São aplicações, não páginas: indexadas, um resultado de pesquisa leva
     alguém directamente ao ecrã de balcão de outra pessoa.
     ======================================================================= */

  for (const app of ['/app/', '/balcao/']) {
    await palco.ir(app);
    const c = await cabeca(palco);
    certo(/noindex/.test(String(c.robots)),
      `${app}: tem noindex`, String(c.robots));
  }
  for (const p of PAGINAS) {
    certo(cabecas[p.rota].robots === null,
      `${p.rota}: NÃO tem noindex — é uma página para ser encontrada`,
      String(cabecas[p.rota].robots));
  }

  const robots = ficheirosCrus['robots.txt'].texto;
  certo(/Disallow:\s*\S*\/app\//.test(robots),
    'robots.txt: fecha a porta a /app/', robots.slice(0, 120));
  certo(/Disallow:\s*\S*\/balcao\//.test(robots),
    'robots.txt: fecha a porta a /balcao/', robots.slice(0, 120));
  certo(robots.includes(`https://${config.dominio}/sitemap.xml`),
    'robots.txt: aponta o sitemap', robots.slice(0, 200));

  const mapa = ficheirosCrus['sitemap.xml'].texto;
  const rotasNoMapa = [...mapa.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  certo(rotasNoMapa.length === PAGINAS.length,
    `sitemap: anuncia as ${PAGINAS.length} páginas públicas`,
    `anuncia ${rotasNoMapa.length}: ${rotasNoMapa.join(' ')}`);
  certo(PAGINAS.every((p) => rotasNoMapa.includes(`https://${config.dominio}${p.rota}`)),
    'sitemap: e são exactamente estas quatro',
    rotasNoMapa.join(' '));
  certo(!/\/(app|balcao)\//.test(mapa),
    'sitemap: as aplicações ficam de fora', mapa.slice(0, 300));

  const doMapa = rotasNoMapa.map((u) => BASE + new URL(u).pathname);
  const respostasMapa = await estados(palco, doMapa);
  certo(doMapa.every((u) => respostasMapa[u] === 200),
    'sitemap: cada endereço anunciado existe mesmo',
    doMapa.filter((u) => respostasMapa[u] !== 200)
      .map((u) => `${u} → ${respostasMapa[u]}`).join(' · '));

  /* =======================================================================
     11. O cabeçalho e o rodapé, em todas as páginas
     ======================================================================= */

  for (const p of PAGINAS) {
    await palco.ir(p.rota);
    const rodape = await palco.js(`
      return [...document.querySelectorAll('footer.rodape a')]
        .map((a) => a.getAttribute('href'))`);
    for (const obrigatoria of [`${BASE}/privacidade/`, `${BASE}/termos/`, `${BASE}/app/`]) {
      certo(rodape.includes(obrigatoria),
        `${p.rota}: o rodapé leva a ${obrigatoria}`, rodape.join(' '));
    }
    certo(cabecas[p.rota].corpo.includes(`© ${new Date().getFullYear()} Carimbo Digital`),
      `${p.rota}: o rodapé traz o ano corrente`,
      (cabecas[p.rota].corpo.match(/© \d{4}[^·]*/) || ['sem ano'])[0]);
  }

  /* A barra de cima é pegajosa: tem de continuar lá depois de se rolar. */
  await palco.ir('/');
  await palco.rolar(1200);
  await scrollAssente(palco);
  const pegajosa = await palco.js(`
    const c = document.querySelector('header.cabecalho');
    const r = c.getBoundingClientRect();
    return { topo: Math.round(r.top), altura: Math.round(r.height),
             posicao: getComputedStyle(c).position, y: Math.round(window.scrollY) };`);
  certo(pegajosa.y > 400, 'cabeçalho: a página rolou mesmo', JSON.stringify(pegajosa));
  certo(pegajosa.posicao === 'sticky' && pegajosa.topo <= 1,
    'cabeçalho: continua colado ao topo depois de rolar', JSON.stringify(pegajosa));

  /* O CSS promete uma linha por baixo do cabeçalho assim que a página rola —
     é o que separa a barra translúcida do conteúdo que lhe passa por baixo.
     Amostra-se ao longo de quase um segundo para não julgar um instante. */
  const amostras = [];
  for (let i = 0; i < 6; i++) {
    amostras.push(await palco.js(`
      const c = document.querySelector('header.cabecalho');
      return { rolado: c.dataset.rolado ?? null,
               borda: getComputedStyle(c).borderBottomColor };`));
    await dormir(140);
  }
  certo(amostras.some((a) => a.borda !== 'rgba(0, 0, 0, 0)'),
    'cabeçalho: ganha a linha de separação depois de a página rolar',
    `data-rolado=${amostras.map((a) => a.rolado).join('/')},`
    + ` borda=${amostras[amostras.length - 1].borda}`);

  /* Uma âncora que aterre debaixo do cabeçalho esconde o título da secção a
     que se saltou — o clique parece não ter feito nada. */
  await palco.ir('/#como');
  await scrollAssente(palco);
  const aterragem = await palco.js(`
    const c = document.querySelector('header.cabecalho').getBoundingClientRect();
    const alvo = document.querySelector('#como .olho') || document.querySelector('#como');
    const a = alvo.getBoundingClientRect();
    return { fundoDoCabecalho: Math.round(c.bottom), topoDoAlvo: Math.round(a.top),
             texto: alvo.textContent.trim(), y: Math.round(window.scrollY) };`);
  certo(aterragem.y > 100,
    'âncora: #como salta mesmo para a secção', JSON.stringify(aterragem));
  certo(aterragem.topoDoAlvo >= aterragem.fundoDoCabecalho,
    'âncora: o título da secção não fica escondido debaixo do cabeçalho pegajoso',
    `«${aterragem.texto}» a ${aterragem.topoDoAlvo}px, cabeçalho até ${aterragem.fundoDoCabecalho}px`);

  /* A primeira paragem do teclado em cada página. Guardado fora do ecrã, tem
     de entrar quando recebe o foco — senão é um botão invisível. */
  await palco.ir('/');
  await palco.js(`document.querySelector('.saltar').focus(); return true`);
  await dormir(400);
  const salto = await palco.js(`
    const s = document.querySelector('.saltar');
    const r = s.getBoundingClientRect();
    return { topo: Math.round(r.top), altura: Math.round(r.height),
             focado: document.activeElement === s, destino: s.getAttribute('href') };`);
  certo(salto.focado && salto.topo >= 0 && salto.topo < 200,
    'saltar: a ligação de salto entra no ecrã quando recebe o foco',
    JSON.stringify(salto));
  certo(salto.destino === '#principal',
    'saltar: e aponta para o conteúdo principal', String(salto.destino));

  /* =======================================================================
     12. As perguntas abrem
     ======================================================================= */

  await palco.ir('/');
  const quantasPerguntas = await palco.contar('details.pergunta');
  certo(quantasPerguntas >= 5,
    'perguntas: a página inicial responde às perguntas do costume',
    `${quantasPerguntas} perguntas`);
  certo(await palco.contar('details.pergunta[open]') === 0,
    'perguntas: começam todas fechadas');

  await palco.clicar('details.pergunta:first-of-type summary');
  await dormir(250);
  certo(await palco.contar('details.pergunta[open]') === 1,
    'perguntas: carregar numa abre-a',
    `${await palco.contar('details.pergunta[open]')} abertas`);
  certo(await palco.visivel('details.pergunta[open] .pergunta-corpo'),
    'perguntas: e a resposta fica à vista');

  await palco.clicar('details.pergunta:first-of-type summary');
  await dormir(250);
  certo(await palco.contar('details.pergunta[open]') === 0,
    'perguntas: e volta a fechar-se',
    `${await palco.contar('details.pergunta[open]')} abertas`);

  /* =======================================================================
     13. O texto lê-se — em claro e em escuro

     A app teve o contraste medido e oito pares corrigidos. O site nunca foi
     medido. Aqui mede-se elemento a elemento, com as opacidades
     multiplicadas pelo caminho, porque o que chega aos olhos é a mistura.
     ======================================================================= */

  /* Os cartões do herói são a mesma peça que a app desenha, mas aqui as
     cores estão escritas à mão no HTML em vez de passarem pelo
     `marcaSegura()` — que é justamente a função que garante que a tinta se lê
     por cima da cor do comerciante, seja ela qual for. Mede-se a promessa
     que ficou de fora. */
  await palco.ir('/');
  const herois = await palco.js(`
    return [...document.querySelectorAll('.heroi-cartao')].map((n) => ({
      nome: n.querySelector('.cartao-nome')?.textContent.trim() ?? '?',
      m: n.style.getPropertyValue('--m').trim(),
      mTxt: n.style.getPropertyValue('--m-txt').trim(),
      claro: n.dataset.claro ?? null,
    }));`);
  certo(herois.length === 3,
    'herói: a página inicial mostra o baralho de três cartões',
    `${herois.length} cartões`);
  await palco.captura('15-heroi');

  /* O baralho está muito sobreposto: dos três cartões, só o da frente mostra
     texto — os outros dois assomam 3% cada, e nem uma letra deles chega aos
     olhos. Por isso o que tem de se ler mesmo é o da frente, e é isso que se
     mede: se um dia a pilha trocar de ordem ou de z-index, o herói fica a
     mostrar um cartão tapado. */
  const frente = await palco.js(`
    const c = document.querySelector('.heroi-cartao');
    const alvos = [...c.querySelectorAll('.cartao-nome, .cartao-premio')];
    return alvos.map((n) => {
      const r = n.getBoundingClientRect();
      let vistos = 0;
      for (let i = 1; i <= 9; i++) {
        const e = document.elementFromPoint(r.x + r.width * i / 10, r.y + r.height / 2);
        if (e === n || n.contains(e)) vistos++;
      }
      return { texto: n.textContent.trim().slice(0, 24), vistos };
    });`);
  certo(frente.length > 0 && frente.every((f) => f.vistos >= 8),
    'herói: o cartão da frente do baralho mostra mesmo o texto, sem nada por cima',
    JSON.stringify(frente));

  /* Cada par cor/tinta tem de cumprir o mesmo mínimo que o `marcaSegura()`
     garante na app. Um cartão do herói que não o cumpra é uma promessa
     quebrada na montra — e fica a um ajuste de sobreposição de distância de
     passar a ser texto ilegível à vista de toda a gente. */
  for (const h of herois) {
    const cor = corParaRGB(h.m), tinta = corParaRGB(h.mTxt);
    const r = cor && tinta ? razao(tinta, cor) : 0;
    const alternativa = cor
      ? (razao(corParaRGB('#141318'), cor) > r ? '#141318' : 'nenhuma tinta cheia')
      : '?';
    certo(r >= 4.5,
      `herói · ${h.nome}: a tinta ${h.mTxt} lê-se por cima de ${h.m}`,
      `${r.toFixed(2)}:1, abaixo de 4,5 — o marcaSegura() da app teria escolhido ${alternativa}`);
    /* `data-claro` é o que diz ao CSS se o cartão é claro; tem de concordar
       com a tinta escolhida, senão as variantes do cartão pintam ao contrário. */
    certo(h.claro === (String(h.mTxt).toUpperCase() === '#FFFFFF' ? 'nao' : 'sim'),
      `herói · ${h.nome}: o data-claro concorda com a tinta`,
      `data-claro=${h.claro}, tinta=${h.mTxt}`);
  }

  for (const modo of ['light', 'dark']) {
    await palco.tema(modo);
    const falhas = [];
    let medidos = 0;
    for (const p of PAGINAS) {
      await palco.ir(p.rota);
      await dormir(150);
      const avaliados = avaliarTextos(await medirTextos(palco));
      medidos += avaliados.length;
      for (const t of avaliados) {
        if (t.contraste >= t.minimo - 0.005) continue;
        falhas.push({ ...t, linha: `${p.rota} · ${linhaDeFalha(t)}` });
      }
    }
    certo(medidos > 200,
      `contraste (${modo}): houve texto que chegasse para medir`,
      `${medidos} elementos`);
    certo(falhas.length === 0,
      `contraste (${modo}): todo o texto do site passa o mínimo da WCAG AA`,
      `${falhas.length} pares abaixo — `
      + falhas.sort((a, b) => a.contraste - b.contraste).slice(0, 8)
        .map((t) => t.linha).join(' · '));
  }
  await palco.tema('light');

  /* =======================================================================
     14. No telemóvel

     A maior parte de quem chega a isto chega pelo telemóvel — e é o telemóvel
     que denuncia uma tabela larga de mais ou uma grelha que não recolhe.
     ======================================================================= */

  await palco.tamanho(390, 844);
  for (const p of PAGINAS) {
    await palco.ir(p.rota);
    await dormir(150);
    const largo = await palco.js(`
      const doc = document.documentElement;
      const culpados = [];
      for (const n of document.querySelectorAll('body *')) {
        const r = n.getBoundingClientRect();
        if (r.width < 1) continue;
        if (r.right > innerWidth + 1 || r.left < -1) {
          culpados.push(n.tagName.toLowerCase()
            + (typeof n.className === 'string' && n.className.trim()
              ? '.' + n.className.trim().split(/\\s+/).join('.') : '')
            + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
        }
        if (culpados.length > 4) break;
      }
      return { scroll: doc.scrollWidth, janela: innerWidth, culpados };`);
    certo(largo.scroll <= largo.janela + 1,
      `${p.rota} a 390px: não há barra de deslocamento na horizontal`,
      `scrollWidth ${largo.scroll} > ${largo.janela} · ${largo.culpados.join(' · ')}`);
    certo(await palco.visivel('header.cabecalho a.btn'),
      `${p.rota} a 390px: o botão de abrir a app continua à vista`);
  }
  await palco.ir('/');
  await palco.captura('15-telemovel-inicio');

  /* A tabela dos dados tratados é larga por natureza. O CSS embrulha-a num
     `.rolavel` de propósito — se a embrulhagem falhar, é a página inteira que
     passa a deslizar para o lado. */
  await palco.ir('/privacidade/');
  const tabela = await palco.js(`
    const t = document.querySelector('#principal table');
    if (!t) return null;
    const caixa = t.closest('.rolavel');
    return { temCaixa: !!caixa,
             desliza: caixa ? getComputedStyle(caixa).overflowX : null,
             larguraTabela: Math.round(t.scrollWidth),
             larguraCaixa: caixa ? Math.round(caixa.clientWidth) : null };`);
  certo(!!tabela && tabela.temCaixa && tabela.desliza === 'auto',
    'privacidade: a tabela dos dados desliza dentro da sua caixa',
    JSON.stringify(tabela));

  await palco.tamanho(1280, 900);
}
