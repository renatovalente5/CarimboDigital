#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — gerador do site

   Node puro, sem dependências. É de propósito: isto tem de continuar a
   publicar daqui a três anos sem ninguém correr um `npm install`.

   O que faz:
     · lê _fonte/config.json e calcula a versão (para partir a cache)
     · copia os estilos e o JavaScript
     · preenche os moldes das duas apps e das páginas do site
     · escreve o manifesto, o service worker, os ícones e o sitemap
   ========================================================================= */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, statSync,
         readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const FONTE = join(RAIZ, '_fonte');
const SAIDA = join(RAIZ, '_site');

const config = JSON.parse(readFileSync(join(FONTE, 'config.json'), 'utf8'));

/* O prefixo dos caminhos sai do CNAME: com domínio próprio o site fica na
   raiz; sem ele, fica em /<nome-do-repositório>/. Derivar em vez de escrever
   à mão evita o clássico site publicado com todas as ligações partidas. */
const CNAME = join(RAIZ, 'CNAME');
const BASE = existsSync(CNAME) ? '' : '/CarimboDigital';

/* A versão é o resumo do conteúdo de tudo o que o browser guarda em cache.
   Muda quando o código muda, e só então. */
function versao() {
  const h = createHash('sha256');
  for (const pasta of ['estilos', 'js', 'app', 'balcao']) {
    const p = join(FONTE, pasta);
    if (!existsSync(p)) continue;
    for (const f of listar(p).sort()) h.update(readFileSync(f));
  }
  h.update(JSON.stringify(config));
  return h.digest('hex').slice(0, 10);
}

function listar(pasta) {
  const saida = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    /* «É pasta» decide-se pelo statSync, e não por não ter ponto no nome —
       um `.well-known` ou um `icones` sem extensão enganam a heurística e a
       subárvore desaparece em silêncio. */
    if (statSync(caminho).isDirectory()) saida.push(...listar(caminho));
    else saida.push(caminho);
  }
  return saida;
}

const VERSAO = versao();

const SUBSTITUICOES = {
  '{{BASE}}': BASE,
  '{{VERSAO}}': VERSAO,
  '{{NOME}}': config.nome,
  '{{DOMINIO}}': config.dominio,
  '{{DESCRICAO}}': config.descricao,
  '{{CONTACTO}}': config.contacto,
  '{{COR}}': config.cor,
  '{{ANO}}': String(new Date().getFullYear()),
  '{{CONFIG}}': JSON.stringify({ base: BASE, api: config.api || '', versao: VERSAO }),
  /* Dados da entidade. Enquanto não estiverem preenchidos aparecem como
     marcador visível — nunca como texto plausível mas falso, que é o pior
     dos dois mundos numa página legal. */
  '{{ENT_NOME}}': config.entidade?.nome || 'POR PREENCHER',
  /* Uma pessoa singular não tem forma jurídica. Em vez de escrever
     «POR PREENCHER» numa página legal — ou pior, inventar uma — a marca
     desaparece: o texto lê-se bem com ela e sem ela. */
  '{{ENT_FORMA}}': config.entidade?.forma
    ? ` (${config.entidade.forma})` : '',
  '{{ENT_NIF}}': config.entidade?.nif || 'POR PREENCHER',
  '{{ENT_MORADA}}': config.entidade?.morada || 'POR PREENCHER',
  '{{ENT_EMAIL}}': config.entidade?.email || config.contacto,
  '{{ENT_DADOS}}': config.entidade?.responsavel_dados || config.entidade?.nome || 'POR PREENCHER',
  '{{AVISO_RASCUNHO}}': config.producao ? '' :
    '<div class="caixa-aviso"><p><strong>Rascunho.</strong> Este texto está '
    + 'escrito mas ainda não tem os dados da entidade responsável. Antes de '
    + 'publicar o serviço a sério é preciso preencher <code>entidade</code> em '
    + '<code>_fonte/config.json</code> e pôr <code>producao: true</code>.</p></div>',
};

function preencher(texto) {
  let saida = texto;
  for (const [chave, valor] of Object.entries(SUBSTITUICOES)) {
    saida = saida.split(chave).join(valor);
  }
  return saida;
}

function escrever(destino, conteudo) {
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo);
}

/* --- limpar e recomeçar -------------------------------------------------- */
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });

/* Um `import` de módulo não passa pelo ?v= do <script> que o carregou: o
   browser (e o service worker) vão buscar `../js/nucleo.js` tal e qual, e
   ficam com a versão antiga colada durante dias. Por isso carimba-se a
   versão em todos os caminhos relativos de import, à saída. */
function versionarImports(texto) {
  return texto.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.js)\2/g,
    (_, antes, aspas, caminho) => `${antes}${aspas}${caminho}?v=${VERSAO}${aspas}`);
}

/* --- estilos e JavaScript ------------------------------------------------ */
cpSync(join(FONTE, 'estilos'), join(SAIDA, 'estilos'), { recursive: true });
for (const ficheiro of listar(join(FONTE, 'js'))) {
  const destino = join(SAIDA, 'js', relative(join(FONTE, 'js'), ficheiro));
  escrever(destino, versionarImports(preencher(readFileSync(ficheiro, 'utf8'))));
}

/* --- as duas aplicações -------------------------------------------------- */
for (const app of ['app', 'balcao']) {
  const origem = join(FONTE, app);
  if (!existsSync(origem)) continue;
  for (const ficheiro of listar(origem)) {
    const rel = relative(origem, ficheiro);
    const destino = join(SAIDA, app, rel);
    if (['.html', '.js', '.css', '.webmanifest', '.json', '.svg'].includes(extname(ficheiro))) {
      const texto = preencher(readFileSync(ficheiro, 'utf8'));
      escrever(destino, extname(ficheiro) === '.js' ? versionarImports(texto) : texto);
    } else {
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(ficheiro, destino);
    }
  }
}

/* --- páginas do site ----------------------------------------------------- */
const parcial = (nome) => preencher(readFileSync(join(FONTE, 'parciais', nome), 'utf8'));
const MOLDE = readFileSync(join(FONTE, 'parciais', 'molde.html'), 'utf8');

const paginas = existsSync(join(FONTE, 'paginas')) ? listar(join(FONTE, 'paginas')) : [];
const rotas = [];

for (const ficheiro of paginas) {
  const cru = readFileSync(ficheiro, 'utf8');
  const meta = {};
  let corpo = cru;
  const cabecalho = cru.match(/^---\n([\s\S]*?)\n---\n/);
  if (cabecalho) {
    for (const linha of cabecalho[1].split('\n')) {
      const i = linha.indexOf(':');
      if (i > 0) meta[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
    }
    corpo = cru.slice(cabecalho[0].length);
  }
  const nome = relative(join(FONTE, 'paginas'), ficheiro).replace(/\.html$/, '');
  const rota = nome === 'inicio' ? '' : `/${nome}`;
  const destino = nome === 'inicio' ? join(SAIDA, 'index.html') : join(SAIDA, nome, 'index.html');

  const html = preencher(MOLDE)
    .split('{{CABECALHO}}').join(parcial('cabecalho.html'))
    .split('{{RODAPE}}').join(parcial('rodape.html'))
    .split('{{TITULO}}').join(meta.titulo || config.nome)
    .split('{{RESUMO}}').join(meta.resumo || config.descricao)
    .split('{{CANONICO}}').join(`https://${config.dominio}${rota}${rota ? '/' : '/'}`)
    .split('{{CLASSE}}').join(meta.classe || '')
    .split('{{CORPO}}').join(preencher(corpo));

  escrever(destino, html);
  rotas.push({ rota: `${rota}/`, prioridade: meta.prioridade || (rota ? '0.6' : '1.0') });
}

/* --- manifesto ----------------------------------------------------------- */
escrever(join(SAIDA, 'app', 'manifest.webmanifest'), JSON.stringify({
  name: 'Carimbo Digital', short_name: 'Carimbo',
  description: config.descricao,
  start_url: `${BASE}/app/`, scope: `${BASE}/app/`,
  display: 'standalone', display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait',
  background_color: '#FBFAF7', theme_color: '#FBFAF7',
  lang: 'pt-PT', dir: 'ltr',
  categories: ['lifestyle', 'shopping', 'utilities'],
  icons: [
    { src: `${BASE}/icones/192.png`, sizes: '192x192', type: 'image/png' },
    { src: `${BASE}/icones/512.png`, sizes: '512x512', type: 'image/png' },
    { src: `${BASE}/icones/mascara.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [{
    name: 'Mostrar o meu código', short_name: 'Código',
    url: `${BASE}/app/?acao=codigo`,
    icons: [{ src: `${BASE}/icones/192.png`, sizes: '192x192' }],
  }],
}, null, 2));

escrever(join(SAIDA, 'balcao', 'manifest.webmanifest'), JSON.stringify({
  name: 'Carimbo Digital Balcão', short_name: 'Balcão',
  description: 'Carimba os cartões dos teus clientes.',
  start_url: `${BASE}/balcao/`, scope: `${BASE}/balcao/`,
  display: 'standalone', orientation: 'portrait',
  background_color: '#0E0D12', theme_color: '#0E0D12',
  lang: 'pt-PT',
  icons: [
    { src: `${BASE}/icones/balcao-192.png`, sizes: '192x192', type: 'image/png' },
    { src: `${BASE}/icones/balcao-512.png`, sizes: '512x512', type: 'image/png' },
  ],
}, null, 2));

/* --- service workers ----------------------------------------------------- */
/* Um por aplicação, e cada um com o âmbito da sua pasta.

   Um único service worker em /sw.js apanharia o âmbito do site inteiro — e
   o site de apresentação passava a ser servido da cache, com a página da app
   a aparecer no lugar da página inicial quando a rede tossisse. As páginas
   normais não ganham nada em ser guardadas; as apps é que têm de abrir sem
   rede.

   Três estratégias dentro de cada um:
   · navegações (o HTML)  -> rede primeiro. Sem isto uma versão nova nunca
                             chega: o HTML é a única coisa cujo endereço não
                             muda, e servi-lo da cache prende o utilizador a
                             uma versão antiga para sempre.
   · ficheiros com ?v=    -> cache primeiro, e nem se vai à rede confirmar.
                             O endereço já muda a cada versão.
   · o resto              -> cache primeiro com atualização em segundo plano.

   Os pedidos à API nunca são guardados: um cartão em cache é um cartão com o
   número de carimbos errado, e isso vê-se ao balcão. */
for (const app of ['app', 'balcao']) {
  const ficheiro = app === 'app' ? 'app.js' : 'balcao.js';
  const casco = [
    `${BASE}/${app}/`,
    `${BASE}/${app}/${ficheiro}?v=${VERSAO}`,
    `${BASE}/estilos/nucleo.css?v=${VERSAO}`,
    `${BASE}/estilos/app.css?v=${VERSAO}`,
    ...(app === 'balcao' ? [`${BASE}/estilos/balcao.css?v=${VERSAO}`] : []),
    `${BASE}/js/nucleo.js?v=${VERSAO}`,
    `${BASE}/js/api.js?v=${VERSAO}`,
    ...(app === 'app'
      ? [`${BASE}/js/qr.js?v=${VERSAO}`]
      : [`${BASE}/js/qr-leitor.js?v=${VERSAO}`]),
  ];

  escrever(join(SAIDA, app, 'sw.js'), `/* Carimbo Digital ${app} — service worker (versão ${VERSAO}) */
const CACHE = 'carimbo-${app}-${VERSAO}';
const CASCO = ${JSON.stringify(casco, null, 2)};

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' força ir à rede: o GitHub Pages serve tudo com
    // max-age=600, e sem isto o casco novo era guardado a partir da cache
    // velha do browser — instalando uma versão nova com ficheiros antigos.
    await Promise.allSettled(CASCO.map((u) =>
      fetch(new Request(u, { cache: 'reload' })).then((r) => r.ok && c.put(u, r))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const nome of await caches.keys()) {
      if (nome.startsWith('carimbo-${app}-') && nome !== CACHE) await caches.delete(nome);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const pedido = ev.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);
  if (url.origin !== location.origin) return;          // a API vai sempre à rede

  if (pedido.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        const r = await fetch(pedido);
        if (r.ok) (await caches.open(CACHE)).put(pedido, r.clone());
        return r;
      } catch {
        const c = await caches.open(CACHE);
        return (await c.match(pedido)) || (await c.match('${BASE}/${app}/'))
            || new Response('Sem ligação.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(pedido);
    if (guardado) {
      if (!url.search.includes('v=')) {
        fetch(pedido).then((r) => { if (r.ok) cache.put(pedido, r.clone()); }).catch(() => {});
      }
      return guardado;
    }
    try {
      const r = await fetch(pedido);
      if (r.ok) cache.put(pedido, r.clone());
      return r;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
`);
}

/* --- ícones -------------------------------------------------------------- */
if (existsSync(join(FONTE, 'imagens'))) {
  cpSync(join(FONTE, 'imagens'), join(SAIDA, 'icones'), { recursive: true });
  /* O favicon tem de estar na raiz: é lá que os browsers e os leitores de
     feeds o vão procurar quando o <link> não chega. */
  cpSync(join(FONTE, 'imagens', 'favicon.svg'), join(SAIDA, 'favicon.svg'));
}

/* --- ficheiros de raiz --------------------------------------------------- */
if (existsSync(CNAME)) cpSync(CNAME, join(SAIDA, 'CNAME'));

escrever(join(SAIDA, 'robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /balcao/\n\n`
  + `Sitemap: https://${config.dominio}/sitemap.xml\n`);

escrever(join(SAIDA, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  + rotas.map((r) => `  <url><loc>https://${config.dominio}${r.rota}</loc>`
      + `<priority>${r.prioridade}</priority></url>`).join('\n')
  + `\n</urlset>\n`);

/* --- 404 ----------------------------------------------------------------- */
if (existsSync(join(SAIDA, 'index.html'))) {
  const molde = readFileSync(join(SAIDA, 'index.html'), 'utf8');
  escrever(join(SAIDA, '404.html'), molde);
}

console.log(`Carimbo Digital gerado. versão ${VERSAO}, base "${BASE || '/'}", `
  + `${rotas.length} páginas, ${listar(SAIDA).length} ficheiros.`);
