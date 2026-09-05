/* =========================================================================
   Bateria · 16 — PWA: service worker, manifesto e offline

   Esta app não vive num separador: vive no ecrã inicial de um telemóvel, ao
   lado do WhatsApp. Quem a instala deixa de ver a barra de endereço e deixa
   de ter como recarregar à força — e passa a esperar que ela abra na fila do
   café, no metro, ou num sítio onde a rede não chega. Nada disto se vê a
   olhar para o ecrã com Wi-Fi ligado.

   O que este módulo persegue:

   · O SERVICE WORKER QUE NÃO CHEGA A FICAR ACTIVO. Registar não é instalar.
     Espera-se pelo `ready` com tecto de tempo e exige-se que a PRIMEIRA
     visita já fique controlada — é para isso que lá está o `skipWaiting()`
     com o `clients.claim()`.

   · O CASCO COM UM ENDEREÇO ERRADO. O `install` guarda o casco com um
     `Promise.allSettled` e um `r.ok &&` à frente: um endereço que responda
     404 é deitado fora em silêncio, o service worker instala na mesma, e a
     app só se descobre partida quando alguém ficar sem rede. Por isso a
     lista do casco é lida do próprio `sw.js` e conferida uma a uma contra o
     que ficou mesmo na cache.

   · OS DOIS ÂMBITOS A PISAREM-SE. São duas apps na mesma origem. Um service
     worker com âmbito a mais serve a app do cliente a quem pediu o balcão —
     ou o site de apresentação a partir de uma cache que ninguém esperava.

   · A VERSÃO VELHA SERVIDA PARA SEMPRE. O HTML é a única coisa cujo endereço
     não muda de versão para versão. Se for servido da cache, quem instalou
     em Janeiro fica em Janeiro. Prova-se a envenenar a cache e a exigir que
     a rede ganhe.

   · OS DOIS QUADRADOS IGUAIS NO ECRÃ INICIAL. Quem instala a app e o balcão
     no mesmo telemóvel — e é o caso do dono do café — não pode ficar com
     dois ícones que não se distinguem.

   Duas afirmações estão VERMELHAS de propósito, e é o que este módulo veio
   cá encontrar:

   · O ATALHO QUE NÃO FAZ NADA. O manifesto promete «Mostrar o meu código» em
     `?acao=codigo` e não há uma linha em toda a app que leia `acao`. Quem
     fizer a pressão longa no ícone do Android abre a carteira de sempre.

   · O BALCÃO QUE, COM SESSÃO ABERTA, NÃO REGISTA O SERVICE WORKER. O
     `arrancar()` do balcao.js faz `await entrar(); return;` — e o `return`
     salta por cima do registo, que está no fim da função. O tablet do café
     está SEMPRE com sessão aberta, e é o aparelho que mais precisa de abrir
     sem rede. O controlo no fim do módulo prova que sem sessão o mesmo
     balcão regista à primeira.

   É o único módulo que corre com o service worker ligado (`comServiceWorker`);
   nos outros o corredor desliga-o de propósito, senão serviria versões
   guardadas a meio da bateria.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '16 · PWA: service worker, manifesto e offline';
export const comServiceWorker = true;
export const desculpar = [/favicon/];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   Espreitar o service worker
   ========================================================================= */

/**
 * Espera que haja um service worker ACTIVO para esta página.
 *
 * O tecto de tempo é o ponto: `navigator.serviceWorker.ready` é uma promessa
 * que nunca rejeita. Sem a corrida contra o relógio, um registo que nunca
 * chegasse a activar não reprovava nada — o módulo ficava pendurado até o
 * corredor desistir, e a razão morria com ele.
 */
async function swPronto(palco, tecto = 20000) {
  return palco.js(`
    if (!('serviceWorker' in navigator)) return { erro: 'este browser não tem navigator.serviceWorker' };
    const pronto = navigator.serviceWorker.ready.then((r) => ({
      ambito: r.scope,
      guiao: r.active ? r.active.scriptURL : null,
      estado: r.active ? r.active.state : null,
    }));
    const tarde = new Promise((ok) => setTimeout(
      () => ok({ erro: 'passaram ${tecto} ms e nenhum service worker ficou activo' }), ${tecto}));
    return Promise.race([pronto, tarde]);`);
}

/** Quem manda mesmo nesta página agora, ou `null` enquanto ninguém mandar. */
async function esperarControlador(palco, tecto = 10000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const quem = await palco.js(
      'return navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null');
    if (quem) return quem;
    if (Date.now() > limite) return null;
    await dormir(150);
  }
}

/** Todos os registos desta origem, pela ordem do âmbito. */
const registos = (palco) => palco.js(`
  const rs = await navigator.serviceWorker.getRegistrations();
  return rs.map((r) => ({
    ambito: new URL(r.scope).pathname,
    guiao: (r.active || r.waiting || r.installing || {}).scriptURL || null,
  })).sort((a, b) => a.ambito.localeCompare(b.ambito));`);

/** Qual o registo que apanharia uma página neste endereço. `null` = nenhum. */
const quemMandaEm = (palco, caminho) => palco.js(`
  const r = await navigator.serviceWorker.getRegistration(${JSON.stringify(caminho)});
  return r ? new URL(r.scope).pathname : null;`);

/* =========================================================================
   Cortar a rede a sério

   O `palco.semRede()` fala com a SESSÃO DA PÁGINA — e o service worker é
   outro alvo do protocolo, com a sua própria ligação à rede. Sem isto, a
   página dá-se por desligada, o service worker vai à rede na mesma, e o
   teste do offline passa por uma razão que não é a que se queria: a app
   abria porque a rede ainda lá estava.

   Por isso liga-se também a cada service worker vivo. Estar ligado ao
   protocolo tem um efeito lateral útil — o browser deixa de o adormecer por
   inactividade, e o corte não se perde a meio.
   ========================================================================= */

const sessoesSW = new Map();

async function cortarRede(palco, sim) {
  await palco.semRede(sim);

  const { targetInfos = [] } = await palco.enviar('Target.getTargets', {}).catch(() => ({}));
  for (const alvo of targetInfos) {
    if (alvo.type !== 'service_worker') continue;
    if (!sessoesSW.has(alvo.targetId)) {
      const r = await palco.enviar('Target.attachToTarget',
        { targetId: alvo.targetId, flatten: true }).catch(() => null);
      if (!r) continue;
      sessoesSW.set(alvo.targetId, r.sessionId);
      await palco.enviar('Network.enable', {}, r.sessionId).catch(() => {});
    }
  }
  for (const sessao of sessoesSW.values()) {
    await palco.enviar('Network.emulateNetworkConditions', {
      offline: sim, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }, sessao).catch(() => {});
  }
  const quantos = sessoesSW.size;

  /* Devolver a rede é devolver tudo: enquanto estivermos ligados ao
     protocolo, o browser não adormece os service workers, e o que se estaria
     a medir a seguir era um browser que não existe em telemóvel nenhum. */
  if (!sim) {
    for (const sessao of sessoesSW.values()) {
      await palco.enviar('Target.detachFromTarget', { sessionId: sessao }).catch(() => {});
    }
    sessoesSW.clear();
  }
  return quantos;
}

/** Despejo do que está guardado em cada cache, por caminho. */
const verCaches = (palco) => palco.js(`
  const saida = {};
  for (const nome of (await caches.keys()).sort()) {
    const c = await caches.open(nome);
    saida[nome] = (await c.keys()).map((p) => {
      const u = new URL(p.url); return u.pathname + u.search;
    }).sort();
  }
  return saida;`);

/**
 * O casco e o nome da cache, lidos do próprio `sw.js`.
 *
 * Não se escreve a lista à mão: ela é gerada pelo `gerar.mjs` e muda a cada
 * versão. O que interessa provar é outra coisa — que tudo o que o service
 * worker DIZ que guarda está mesmo guardado.
 */
const lerGuiao = (palco, caminho) => palco.js(`
  const r = await fetch(${JSON.stringify(caminho)}, { cache: 'no-store' });
  const t = await r.text();
  const casco = t.match(/const CASCO = (\\[[\\s\\S]*?\\]);/);
  const cache = t.match(/const CACHE = '([^']+)'/);
  return {
    estado: r.status, tipo: r.headers.get('content-type'),
    casco: casco ? JSON.parse(casco[1]) : null,
    cache: cache ? cache[1] : null,
  };`);

/* =========================================================================
   O manifesto e os ícones
   ========================================================================= */

const lerManifesto = (palco) => palco.js(`
  const l = document.querySelector('link[rel="manifest"]');
  if (!l) return { erro: 'a página não declara <link rel="manifest">' };
  const r = await fetch(l.href, { cache: 'no-store' });
  const cru = await r.text();
  let dados = null, mau = null;
  try { dados = JSON.parse(cru); } catch (e) { mau = e.message; }
  const meta = (n) => { const m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : null; };
  const liga = (rel) => { const a = document.querySelector('link[rel="' + rel + '"]'); return a ? a.getAttribute('href') : null; };
  return {
    href: new URL(l.href).pathname, estado: r.status,
    tipo: r.headers.get('content-type'), mau, dados,
    appleIcone: liga('apple-touch-icon'),
    appleTitulo: meta('apple-mobile-web-app-title'),
    corTema: meta('theme-color'),
  };`);

/**
 * Descarrega um ícone e mede-o de verdade.
 *
 * Além do tamanho e da impressão digital, mede-se o ANEL DE FORA — os três
 * por cento que a máscara circular do Android corta a um ícone `maskable`.
 * Um ícone maskable feito com a arte do ícone normal fica com o desenho
 * cortado nos cantos, e isso não se vê em nenhum sítio senão no telemóvel de
 * quem instalou.
 */
const analisarIcone = (palco, caminho) => palco.js(`
  const r = await fetch(${JSON.stringify(caminho)}, { cache: 'no-store' });
  if (!r.ok) return { erro: 'respondeu ' + r.status };
  const cru = await r.arrayBuffer();
  const resumo = [...new Uint8Array(await crypto.subtle.digest('SHA-256', cru))]
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const tipo = r.headers.get('content-type');
  let bm = null;
  try { bm = await createImageBitmap(new Blob([cru], { type: tipo || 'image/png' })); }
  catch (e) { return { resumo, tipo, bytes: cru.byteLength, erro: 'não é imagem: ' + e.message }; }

  const l = bm.width, a = bm.height;
  const lona = new OffscreenCanvas(l, a);
  const g = lona.getContext('2d', { willReadFrequently: true });
  g.drawImage(bm, 0, 0);
  const d = g.getImageData(0, 0, l, a).data;
  const px = (x, y) => { const i = (Math.round(y) * l + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };

  const m = Math.max(1, Math.round(l * 0.03));
  const passo = Math.max(1, Math.round(l / 48));
  const anel = [];
  for (let i = m; i < l - m; i += passo) {
    anel.push(px(i, m), px(i, a - 1 - m), px(m, i), px(l - 1 - m, i));
  }
  const canal = (k) => anel.map((p) => p[k]);
  const espalha = Math.max(...[0, 1, 2].map((k) => Math.max(...canal(k)) - Math.min(...canal(k))));
  const medio = [0, 1, 2].map((k) => Math.round(canal(k).reduce((x, y) => x + y, 0) / anel.length));

  /* Quanto do miolo — o disco que a máscara deixa passar — é desenho e não
     fundo. Não serve espreitar só o píxel do meio: num logótipo em quatro
     cantos, o meio é fundo, e um ícone bom passava por quadrado liso. */
  const raio = l * 0.3;
  let miolo = 0, pintados = 0;
  for (let y = a / 2 - raio; y <= a / 2 + raio; y += Math.max(1, l / 64)) {
    for (let x = l / 2 - raio; x <= l / 2 + raio; x += Math.max(1, l / 64)) {
      if ((x - l / 2) ** 2 + (y - a / 2) ** 2 > raio * raio) continue;
      const p = px(x, y);
      miolo++;
      if (Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - medio[k]))) > 40) pintados++;
    }
  }
  return {
    resumo, tipo, bytes: cru.byteLength, largura: l, altura: a,
    anelEspalha: Math.round(espalha), anelMedio: medio,
    fraccaoDesenho: miolo ? Math.round((pintados / miolo) * 100) : 0,
    alfaCantos: [px(0, 0), px(l - 1, 0), px(0, a - 1), px(l - 1, a - 1)].map((c) => c[3]),
    alfaMinimoAnel: Math.min(...anel.map((p) => p[3])),
  };`);

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* =======================================================================
     A app do cliente instala-se
     ======================================================================= */

  await palco.ir('/app/?demo=1');
  const BASE = await palco.js("return (window.CARIMBO_CONFIG || {}).base || ''");
  const VERSAO = await palco.js("return (window.CARIMBO_CONFIG || {}).versao || null");
  await passarBoasVindas(palco);
  await palco.esperar('#barra', 10000);

  const swApp = await swPronto(palco, 20000);
  certo(!swApp.erro, 'app: o service worker instala-se e fica activo',
    String(swApp.erro || ''));
  certo(swApp.ambito === `${palco.servidor}${BASE}/app/`,
    `app: o âmbito do service worker é ${BASE}/app/`, String(swApp.ambito));
  certo(String(swApp.guiao).endsWith(`${BASE}/app/sw.js`),
    'app: quem manda é o sw.js da app', String(swApp.guiao));
  certo(swApp.estado === 'activated',
    'app: o service worker chega a activado, não fica preso em «installing»',
    String(swApp.estado));

  /* O `skipWaiting()` com o `clients.claim()` existe para isto: quem abre a
     app pela primeira vez fica coberto já, e não só na visita seguinte. Sem
     isto a primeira instalação de um telemóvel novo não tem cache nenhuma se
     a rede cair a seguir. */
  const dono = await esperarControlador(palco, 10000);
  certo(!!dono && String(dono).endsWith(`${BASE}/app/sw.js`),
    'app: a PRIMEIRA visita já fica controlada pelo service worker',
    String(dono));

  /* --- o casco está mesmo guardado --------------------------------------- */

  const guiaoApp = await lerGuiao(palco, `${BASE}/app/sw.js`);
  certo(guiaoApp.estado === 200 && /javascript/.test(String(guiaoApp.tipo)),
    'app: o sw.js é servido como JavaScript',
    `${guiaoApp.estado} ${guiaoApp.tipo}`);
  certo(Array.isArray(guiaoApp.casco) && guiaoApp.casco.length > 0,
    'app: o sw.js declara uma lista de casco', JSON.stringify(guiaoApp.casco));
  certo(guiaoApp.cache === `carimbo-app-${VERSAO}`,
    'app: a cache tem o nome da versão publicada',
    `${guiaoApp.cache} (versão ${VERSAO})`);

  const cachesDepois = await verCaches(palco);
  const guardadoApp = cachesDepois[guiaoApp.cache] || [];
  /* O `install` faz `Promise.allSettled` com um `r.ok &&` à frente: um
     endereço errado é deitado fora sem um ruído. Só isto o apanha. */
  const faltam = (guiaoApp.casco || []).filter((u) => !guardadoApp.includes(u));
  certo(faltam.length === 0,
    `app: os ${(guiaoApp.casco || []).length} ficheiros do casco ficaram todos guardados`,
    `faltam ${faltam.length}: ${faltam.join(' · ')}`);

  await palco.captura('16-app-instalada');

  /* =======================================================================
     O manifesto da app
     ======================================================================= */

  const manApp = await lerManifesto(palco);
  certo(!manApp.erro && manApp.estado === 200,
    'app: o manifesto é alcançável', `${manApp.erro || ''} ${manApp.estado}`);
  certo(/application\/manifest\+json/.test(String(manApp.tipo)),
    'app: o manifesto é servido como application/manifest+json', String(manApp.tipo));
  certo(!manApp.mau, 'app: o manifesto é JSON válido', String(manApp.mau));

  const mApp = manApp.dados || {};
  certo(typeof mApp.name === 'string' && mApp.name.length > 0,
    'app: o manifesto tem nome', String(mApp.name));
  certo(typeof mApp.short_name === 'string' && mApp.short_name.length > 0
    && mApp.short_name.length <= 12,
    'app: e um nome curto que cabe debaixo do ícone (até 12 caracteres)',
    `«${mApp.short_name}» (${String(mApp.short_name).length})`);
  certo(mApp.display === 'standalone',
    'app: abre em standalone, sem barra de endereço', String(mApp.display));
  certo(typeof mApp.start_url === 'string' && mApp.start_url.startsWith(`${BASE}/app/`),
    'app: o start_url aponta para dentro da app', String(mApp.start_url));
  certo(typeof mApp.scope === 'string' && mApp.scope === `${BASE}/app/`,
    'app: o âmbito do manifesto é o mesmo do service worker', String(mApp.scope));
  certo(/^#[0-9a-fA-F]{6}$/.test(String(mApp.background_color))
    && /^#[0-9a-fA-F]{6}$/.test(String(mApp.theme_color)),
    'app: tem cor de fundo e cor de tema, para o ecrã de arranque não piscar',
    `${mApp.background_color} / ${mApp.theme_color}`);

  /* O endereço por onde a app instalada abre TEM de ser o que o service
     worker guardou — de outra forma, o primeiro arranque sem rede depois de
     instalada dá numa página em branco. */
  certo(guardadoApp.includes(String(mApp.start_url)),
    'app: o start_url é exactamente um dos endereços que ficaram em cache',
    `${mApp.start_url} — na cache está ${guardadoApp.join(' · ')}`);

  const iconesApp = Array.isArray(mApp.icons) ? mApp.icons : [];
  certo(iconesApp.length >= 2, 'app: o manifesto declara ícones',
    `${iconesApp.length} ícones`);
  certo(iconesApp.some((i) => i.sizes === '192x192') && iconesApp.some((i) => i.sizes === '512x512'),
    'app: declara os dois tamanhos que o Android pede (192 e 512)',
    iconesApp.map((i) => i.sizes).join(' · '));

  const maskApp = iconesApp.filter((i) => String(i.purpose || '').split(/\s+/).includes('maskable'));
  certo(maskApp.length >= 1,
    'app: declara um ícone maskable — sem ele o Android corta o ícone aos cantos',
    iconesApp.map((i) => `${i.sizes}:${i.purpose || 'any'}`).join(' · '));

  /* =======================================================================
     Os ícones da app, medidos
     ======================================================================= */

  const medidosApp = {};
  for (const i of iconesApp) medidosApp[i.src] = await analisarIcone(palco, i.src);

  for (const i of iconesApp) {
    const m = medidosApp[i.src];
    const [l, a] = String(i.sizes).split('x').map(Number);
    certo(!m.erro, `app: o ícone ${i.src.split('/').pop()} descarrega`, String(m.erro));
    certo(!m.erro && m.largura === l && m.altura === a,
      `app: o ícone ${i.src.split('/').pop()} tem mesmo ${i.sizes}`,
      m.erro ? String(m.erro) : `${m.largura}x${m.altura}`);
    certo(!m.erro && String(m.tipo).startsWith('image/'),
      `app: o ícone ${i.src.split('/').pop()} é servido como imagem`, String(m.tipo));
  }

  const mascaraApp = maskApp[0] ? medidosApp[maskApp[0].src] : null;
  const chaoApp = iconesApp.find((i) => i.sizes === '512x512'
    && !String(i.purpose || '').includes('maskable'));
  certo(!!mascaraApp && !!chaoApp && mascaraApp.resumo !== medidosApp[chaoApp.src].resumo,
    'app: o ícone maskable é arte própria, e não o ícone normal outra vez',
    mascaraApp && chaoApp ? `${mascaraApp.resumo} vs ${medidosApp[chaoApp.src].resumo}` : 'não medi');
  /* Um canto transparente num ícone maskable é um buraco no ecrã inicial: a
     máscara do Android pinta o que estiver por baixo. */
  certo(!!mascaraApp && !mascaraApp.erro && mascaraApp.alfaMinimoAnel === 255,
    'app: o ícone maskable é opaco até à borda, sem buracos nos cantos',
    mascaraApp ? `alfa mínimo do anel ${mascaraApp.alfaMinimoAnel}, cantos ${JSON.stringify(mascaraApp.alfaCantos)}` : '');
  /* E a zona que a máscara corta tem de ser fundo, não desenho. */
  certo(!!mascaraApp && !mascaraApp.erro && mascaraApp.anelEspalha <= 24,
    'app: o desenho do maskable não chega à zona que a máscara corta',
    mascaraApp ? `variação do anel de fora: ${mascaraApp.anelEspalha} (médio ${JSON.stringify(mascaraApp.anelMedio)})` : '');
  /* ...e ainda assim tem alguma coisa lá dentro: um quadrado de cor lisa
     também passaria as duas de cima. */
  certo(!!mascaraApp && !mascaraApp.erro && mascaraApp.fraccaoDesenho >= 10,
    'app: e há mesmo um desenho dentro do disco que a máscara deixa passar',
    mascaraApp ? `${mascaraApp.fraccaoDesenho}% do miolo é desenho` : '');

  /* =======================================================================
     O balcão instala-se, e não pisa a app
     ======================================================================= */

  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 12000);

  const swBalcao = await swPronto(palco, 20000);
  certo(!swBalcao.erro, 'balcão: o service worker instala-se e fica activo',
    String(swBalcao.erro || ''));
  certo(swBalcao.ambito === `${palco.servidor}${BASE}/balcao/`,
    `balcão: o âmbito do service worker é ${BASE}/balcao/`, String(swBalcao.ambito));
  certo(String(swBalcao.guiao).endsWith(`${BASE}/balcao/sw.js`),
    'balcão: quem manda é o sw.js do balcão', String(swBalcao.guiao));

  const donoBalcao = await esperarControlador(palco, 10000);
  certo(!!donoBalcao && String(donoBalcao).endsWith(`${BASE}/balcao/sw.js`),
    'balcão: a página do balcão é servida pelo service worker do balcão, não pelo da app',
    String(donoBalcao));

  const guiaoBalcao = await lerGuiao(palco, `${BASE}/balcao/sw.js`);
  certo(guiaoBalcao.cache === `carimbo-balcao-${VERSAO}`,
    'balcão: a cache tem o nome da versão publicada', String(guiaoBalcao.cache));

  const cachesDois = await verCaches(palco);
  const guardadoBalcao = cachesDois[guiaoBalcao.cache] || [];
  const faltamB = (guiaoBalcao.casco || []).filter((u) => !guardadoBalcao.includes(u));
  certo(faltamB.length === 0,
    `balcão: os ${(guiaoBalcao.casco || []).length} ficheiros do casco ficaram todos guardados`,
    `faltam ${faltamB.length}: ${faltamB.join(' · ')}`);

  /* --- as duas caches não se misturam ------------------------------------ */

  certo(!guardadoApp.some((u) => u.startsWith(`${BASE}/balcao/`)),
    'âmbitos: a cache da app não guarda nada do balcão',
    guardadoApp.filter((u) => u.startsWith(`${BASE}/balcao/`)).join(' · '));
  certo(!guardadoBalcao.some((u) => u.startsWith(`${BASE}/app/`)),
    'âmbitos: a cache do balcão não guarda nada da app',
    guardadoBalcao.filter((u) => u.startsWith(`${BASE}/app/`)).join(' · '));

  const manBalcao = await lerManifesto(palco);
  certo(!manBalcao.erro && manBalcao.estado === 200,
    'balcão: o manifesto é alcançável', `${manBalcao.erro || ''} ${manBalcao.estado}`);
  certo(/application\/manifest\+json/.test(String(manBalcao.tipo)),
    'balcão: o manifesto é servido como application/manifest+json', String(manBalcao.tipo));

  const mBal = manBalcao.dados || {};
  certo(typeof mBal.name === 'string' && mBal.name.length > 0,
    'balcão: o manifesto tem nome', String(mBal.name));
  certo(typeof mBal.short_name === 'string' && mBal.short_name.length > 0
    && mBal.short_name.length <= 12,
    'balcão: e um nome curto que cabe debaixo do ícone',
    `«${mBal.short_name}» (${String(mBal.short_name).length})`);
  certo(mBal.display === 'standalone',
    'balcão: abre em standalone', String(mBal.display));
  certo(mBal.start_url === `${BASE}/balcao/` && mBal.scope === `${BASE}/balcao/`,
    'balcão: o start_url e o âmbito ficam dentro do balcão',
    `${mBal.start_url} / ${mBal.scope}`);
  certo(guardadoBalcao.includes(String(mBal.start_url)),
    'balcão: o start_url é um dos endereços que ficaram em cache',
    `${mBal.start_url} — na cache está ${guardadoBalcao.join(' · ')}`);

  const iconesBal = Array.isArray(mBal.icons) ? mBal.icons : [];
  certo(iconesBal.some((i) => i.sizes === '192x192') && iconesBal.some((i) => i.sizes === '512x512'),
    'balcão: declara os dois tamanhos que o Android pede',
    iconesBal.map((i) => i.sizes).join(' · '));
  const maskBal = iconesBal.filter((i) => String(i.purpose || '').split(/\s+/).includes('maskable'));
  certo(maskBal.length >= 1,
    'balcão: também declara um ícone maskable',
    iconesBal.map((i) => `${i.sizes}:${i.purpose || 'any'}`).join(' · '));

  const medidosBal = {};
  for (const i of iconesBal) medidosBal[i.src] = await analisarIcone(palco, i.src);
  for (const i of iconesBal) {
    const m = medidosBal[i.src];
    const [l, a] = String(i.sizes).split('x').map(Number);
    certo(!m.erro && m.largura === l && m.altura === a,
      `balcão: o ícone ${i.src.split('/').pop()} tem mesmo ${i.sizes}`,
      m.erro ? String(m.erro) : `${m.largura}x${m.altura}`);
  }
  const mascaraBal = maskBal[0] ? medidosBal[maskBal[0].src] : null;
  certo(!!mascaraBal && !mascaraBal.erro && mascaraBal.alfaMinimoAnel === 255,
    'balcão: o ícone maskable é opaco até à borda',
    mascaraBal ? `alfa mínimo do anel ${mascaraBal.alfaMinimoAnel}` : '');
  certo(!!mascaraBal && !mascaraBal.erro && mascaraBal.anelEspalha <= 24,
    'balcão: o desenho do maskable não chega à zona que a máscara corta',
    mascaraBal ? `variação do anel ${mascaraBal.anelEspalha}` : '');
  certo(!!mascaraBal && !mascaraBal.erro && mascaraBal.fraccaoDesenho >= 10,
    'balcão: e há mesmo um desenho dentro do disco que a máscara deixa passar',
    mascaraBal ? `${mascaraBal.fraccaoDesenho}% do miolo é desenho` : '');

  /* =======================================================================
     Dois ícones, dois quadrados diferentes

     Quem instala as duas — e é o dono do café, que tem a app do cliente para
     experimentar e o balcão para trabalhar — não pode ficar com dois ícones
     iguais no ecrã inicial. Compara-se o conteúdo, não o endereço: dois
     endereços diferentes podem servir o mesmo desenho.
     ======================================================================= */

  certo(manApp.appleIcone !== manBalcao.appleIcone,
    'ecrã inicial: as duas apps não apontam ao mesmo apple-touch-icon',
    `${manApp.appleIcone} vs ${manBalcao.appleIcone}`);

  const appleApp = await analisarIcone(palco, String(manApp.appleIcone));
  const appleBal = await analisarIcone(palco, String(manBalcao.appleIcone));
  certo(!appleApp.erro && !appleBal.erro,
    'ecrã inicial: os dois apple-touch-icon descarregam',
    `${appleApp.erro || 'ok'} / ${appleBal.erro || 'ok'}`);
  certo(appleApp.resumo !== appleBal.resumo,
    'ecrã inicial: e o desenho dos dois é mesmo diferente',
    `${appleApp.resumo} vs ${appleBal.resumo}`);
  /* O iOS pede 180×180; abaixo disso o ícone é esticado e fica esborratado. */
  certo(appleApp.largura >= 180 && appleApp.altura >= 180
    && appleBal.largura >= 180 && appleBal.altura >= 180,
    'ecrã inicial: os dois apple-touch-icon têm pelo menos 180×180',
    `app ${appleApp.largura}x${appleApp.altura}, balcão ${appleBal.largura}x${appleBal.altura}`);

  /* O nome por baixo do ícone também tem de os separar. */
  certo(manApp.appleTitulo !== manBalcao.appleTitulo
    && !!manApp.appleTitulo && !!manBalcao.appleTitulo,
    'ecrã inicial: o nome por baixo do ícone distingue as duas apps',
    `${manApp.appleTitulo} vs ${manBalcao.appleTitulo}`);
  certo(mApp.name !== mBal.name && mApp.short_name !== mBal.short_name,
    'ecrã inicial: e os nomes do manifesto também',
    `${mApp.short_name} vs ${mBal.short_name}`);

  /* Nenhum dos ícones do manifesto pode ser partilhado: no Android é dali que
     sai o quadrado do ecrã inicial. */
  const resumosApp = iconesApp.map((i) => medidosApp[i.src].resumo);
  const resumosBal = iconesBal.map((i) => medidosBal[i.src].resumo);
  const repetidos = resumosApp.filter((r) => resumosBal.includes(r));
  certo(repetidos.length === 0,
    'ecrã inicial: as duas apps não partilham nenhum ícone do manifesto',
    `${repetidos.length} repetidos — app ${resumosApp.join(',')} / balcão ${resumosBal.join(',')}`);

  /* =======================================================================
     Os dois âmbitos não se pisam
     ======================================================================= */

  await palco.ir('/');

  const inventario = await registos(palco);
  certo(inventario.length === 2,
    'âmbitos: há exactamente dois service workers registados nesta origem',
    JSON.stringify(inventario));
  certo(inventario.map((r) => r.ambito).join(' | ') === `${BASE}/app/ | ${BASE}/balcao/`,
    'âmbitos: um para a app, outro para o balcão, e nada mais',
    inventario.map((r) => r.ambito).join(' | '));

  certo(await quemMandaEm(palco, `${BASE}/app/`) === `${BASE}/app/`,
    'âmbitos: quem abre a app apanha o service worker da app',
    String(await quemMandaEm(palco, `${BASE}/app/`)));
  certo(await quemMandaEm(palco, `${BASE}/balcao/`) === `${BASE}/balcao/`,
    'âmbitos: quem abre o balcão apanha o service worker do balcão',
    String(await quemMandaEm(palco, `${BASE}/balcao/`)));

  /* O site de apresentação não pode ser servido de cache nenhuma: é ele que
     tem de mudar quando se muda um preço ou uma política. */
  certo(await quemMandaEm(palco, `${BASE}/`) === null,
    'âmbitos: a página inicial do site não é apanhada por service worker nenhum',
    String(await quemMandaEm(palco, `${BASE}/`)));
  certo(await quemMandaEm(palco, `${BASE}/privacidade/`) === null,
    'âmbitos: nem as páginas legais',
    String(await quemMandaEm(palco, `${BASE}/privacidade/`)));
  certo(await palco.js('return navigator.serviceWorker.controller === null'),
    'âmbitos: o site aberto agora não tem service worker a mandar nele',
    String(await palco.js(
      'return navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null')));

  /* =======================================================================
     Sem rede

     Primeiro prova-se que a rede está mesmo cortada — do lado do service
     worker, que é quem vai buscar as coisas. Se o corte não lá chegasse,
     tudo o que se segue passaria por razões erradas.
     ======================================================================= */

  await palco.ir('/app/');
  await palco.esperar('#barra', 10000);
  await esperarControlador(palco, 10000);

  const cortados = await cortarRede(palco, true);

  certo(await palco.js('return navigator.onLine === false'),
    'sem rede: o browser dá-se por desligado',
    String(await palco.js('return navigator.onLine')));
  certo(cortados >= 2,
    'sem rede: o corte foi aplicado aos dois service workers, e não só à página',
    `${cortados} service workers ligados ao protocolo`);

  /* Um endereço da mesma origem que não está no casco: o service worker
     tenta a rede, não consegue, e devolve 504. Se responder 200, o corte não
     chegou ao service worker e o resto deste bloco não valeria nada. */
  const sonda = await palco.js(`
    try {
      const r = await fetch(${JSON.stringify(`${BASE}/robots.txt`)}, { cache: 'no-store' });
      return { estado: r.status };
    } catch (e) { return { erro: String(e.message) }; }`);
  certo(sonda.estado === 504 || !!sonda.erro,
    'sem rede: o corte chega ao service worker (um pedido novo não vai à rede)',
    JSON.stringify(sonda));

  await palco.recarregar();

  certo(await palco.visivel('#aplicacao'),
    'sem rede: a app volta a abrir depois de recarregar');
  certo(await palco.ver('#barra'),
    'sem rede: com a barra de separadores desenhada — o JavaScript veio da cache');
  certo(await palco.contar('.barra-item') === 5,
    'sem rede: e com os cinco separadores todos',
    `${await palco.contar('.barra-item')} separadores`);
  certo(await palco.contar('#principal .pilha > .cartao') > 0,
    'sem rede: os cartões continuam lá',
    `${await palco.contar('#principal .pilha > .cartao')} cartões`);

  /* Uma app sem CSS abre na mesma e é ilegível. O fundo do corpo é a prova
     mais barata de que a folha de estilos veio da cache. */
  const fundoOffline = await palco.estilo('body', 'background-color');
  certo(String(fundoOffline).replace(/\s/g, '') !== 'rgba(0,0,0,0)'
    && String(fundoOffline).replace(/\s/g, '') !== 'rgb(255,255,255)',
    'sem rede: os estilos também vieram da cache', String(fundoOffline));

  certo(!(await palco.textoTodo()).includes('Sem ligação'),
    'sem rede: e não aparece nenhum ecrã de erro por cima',
    (await palco.textoTodo()).slice(0, 90));
  await palco.captura('16-app-sem-rede');

  /* Recarregar é uma coisa; abrir de novo pelo atalho do ecrã inicial é
     outra — é uma navegação nova, para o start_url. */
  await cortarRede(palco, true);
  await palco.ir(mApp.start_url.slice(BASE.length), { esperarPor: '#barra', tecto: 12000 });
  certo(await palco.contar('.barra-item') === 5,
    'sem rede: abrir pelo atalho do ecrã inicial (start_url) também funciona',
    `${await palco.contar('.barra-item')} separadores`);

  /* Um endereço que nunca esteve em cache — o que acontece a quem abre a app
     por uma ligação que alguém lhe mandou, já sem rede. O `sw.js` promete
     cair para a raiz da app; sem isso, dava a página de «Sem ligação». */
  await cortarRede(palco, true);
  await palco.ir('/app/?veio-de=um-link', { esperarPor: '#barra', tecto: 12000 });
  certo(await palco.contar('.barra-item') === 5,
    'sem rede: um endereço que nunca esteve em cache cai na raiz da app, e a app abre',
    `${await palco.contar('.barra-item')} separadores`);

  /* --- e o balcão também -------------------------------------------------- */

  await cortarRede(palco, true);
  await palco.ir('/balcao/', { esperarPor: '#entrada-acoes .btn-cheio', tecto: 12000 });
  certo(await palco.visivel('#entrada-acoes .btn-cheio'),
    'sem rede: o balcão também abre — é o ecrã que o café precisa quando o Wi-Fi cai');

  await cortarRede(palco, false);

  /* =======================================================================
     A segunda visita não serve uma versão velha

     O HTML é a única coisa cujo endereço não muda de versão para versão. Se
     for servido da cache com rede, quem instalou a app fica preso à versão
     que instalou — para sempre, porque numa app instalada não há barra de
     endereço nem recarregar à força.

     Prova-se ao contrário: envenena-se a cache com uma página falsa e
     exige-se que a rede ganhe.
     ======================================================================= */

  await palco.ir('/app/');
  await palco.esperar('#barra', 10000);
  await esperarControlador(palco, 10000);

  const MARCA = 'PAGINA-DE-JANEIRO';
  await palco.js(`
    const c = await caches.open(${JSON.stringify(guiaoApp.cache)});
    await c.put(${JSON.stringify(`${BASE}/app/`)}, new Response(
      '<!doctype html><html lang="pt-PT"><head><title>${MARCA}</title></head><body><p>${MARCA}</p></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    return true`);

  const envenenada = await palco.js(`
    const c = await caches.open(${JSON.stringify(guiaoApp.cache)});
    const r = await c.match(${JSON.stringify(`${BASE}/app/`)});
    return r ? (await r.text()).includes(${JSON.stringify(MARCA)}) : false`);
  certo(envenenada === true,
    'versão velha: a cache ficou mesmo com a página falsa lá dentro (o teste é válido)',
    String(envenenada));

  await palco.recarregar();
  const tituloDepois = await palco.js('return document.title');
  certo(!String(tituloDepois).includes(MARCA),
    'versão velha: com rede, a página nova ganha à que estava em cache',
    String(tituloDepois));
  certo(await palco.ver('#barra'),
    'versão velha: e o que se abre é a app a sério, não a página falsa',
    String(tituloDepois));

  /* E a cache tem de se curar sozinha: a navegação que foi à rede guarda o
     que trouxe. Sem isto, a próxima abertura sem rede dava a página falsa. */
  const curada = await palco.js(`
    const c = await caches.open(${JSON.stringify(guiaoApp.cache)});
    const r = await c.match(${JSON.stringify(`${BASE}/app/`)});
    if (!r) return 'a entrada desapareceu da cache';
    const t = await r.text();
    return t.includes(${JSON.stringify(MARCA)}) ? 'ainda é a falsa' : 'curada';`);
  certo(curada === 'curada',
    'versão velha: a navegação com rede volta a guardar a página boa na cache',
    String(curada));

  /* =======================================================================
     As caches velhas saem do caminho

     Cada versão abre uma cache nova. Se as antigas ficassem, o telemóvel de
     quem usa a app há um ano guardava um ano de versões — e um dia o browser
     despejava tudo de uma vez, incluindo a versão actual.
     ======================================================================= */

  const CACHE_VELHA = 'carimbo-app-0000000000';
  await palco.js(`
    const c = await caches.open(${JSON.stringify(CACHE_VELHA)});
    await c.put(${JSON.stringify(`${BASE}/app/`)}, new Response('velha'));
    return true`);

  /* Um `activate` novo só corre quando um service worker novo assume. Sem
     mudar o ficheiro, a forma honesta de o provocar é desfazer o registo e
     deixar a app registá-lo outra vez, como faria num telemóvel a que o
     browser tivesse limpo os registos. */
  await palco.js(`
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      if (r.scope.endsWith(${JSON.stringify(`${BASE}/app/`)})) await r.unregister();
    }
    return true`);
  await palco.recarregar();
  await palco.esperar('#barra', 10000);

  const swOutraVez = await swPronto(palco, 20000);
  certo(!swOutraVez.erro,
    'registo perdido: a app volta a registar o service worker sozinha',
    String(swOutraVez.erro || ''));
  await esperarControlador(palco, 10000);

  const cachesFinais = await verCaches(palco);
  const nomes = Object.keys(cachesFinais);
  certo(!nomes.includes(CACHE_VELHA),
    'caches velhas: a cache de uma versão antiga é apagada quando a nova assume',
    nomes.join(' · '));
  certo(nomes.includes(guiaoApp.cache),
    'caches velhas: e a da versão actual fica', nomes.join(' · '));
  /* O `activate` da app apaga tudo o que comece por `carimbo-app-`. Se um dia
     apagasse por engano tudo o que há, o balcão perdia a sua cópia offline
     de cada vez que alguém abrisse a app do cliente no mesmo telemóvel. */
  certo(nomes.includes(guiaoBalcao.cache),
    'caches velhas: e a app não leva a cache do balcão à frente',
    nomes.join(' · '));
  certo(nomes.filter((n) => n.startsWith('carimbo-app-')).length === 1,
    'caches velhas: fica uma só cache da app',
    nomes.filter((n) => n.startsWith('carimbo-app-')).join(' · '));

  /* =======================================================================
     O atalho que o manifesto promete

     No Android, uma pressão longa no ícone abre a lista de `shortcuts` do
     manifesto. Um atalho que abra o mesmo ecrã de sempre é uma promessa por
     cumprir — e é uma das poucas coisas do manifesto que se pode conduzir.
     ======================================================================= */

  const atalhos = Array.isArray(mApp.shortcuts) ? mApp.shortcuts : [];
  for (const a of atalhos) {
    const alvo = String(a.url || '');
    certo(alvo.startsWith(`${BASE}/app/`),
      `atalho «${a.name}»: aponta para dentro da app`, alvo);

    await palco.ir(alvo.slice(BASE.length), { esperarPor: '#barra', tecto: 12000 });
    /* Dá-se tempo: o ecrã do código podia abrir depois do arranque. Amostra-se
       durante três segundos em vez de julgar num instante. */
    let abriu = false;
    for (let i = 0; i < 20 && !abriu; i++) {
      abriu = await palco.visivel('#folha-codigo');
      if (!abriu) await dormir(150);
    }
    certo(abriu === true,
      `atalho «${a.name}»: abre mesmo o ecrã que promete, e não a carteira de sempre`,
      `${alvo} → ficou em «${await palco.texto('#topo-titulo')}»`
      + `, sem #folha-codigo em ${await palco.contar('#folha-codigo')} elementos`);
  }

  /* =======================================================================
     O balcão que já tem sessão aberta

     O balcão é um tablet ao pé da caixa que nunca se desliga e nunca sai da
     conta — é o aparelho desta app que mais precisa de abrir sem rede, e o
     único que passa a vida com sessão iniciada. Se o registo do service
     worker se perder (o browser despeja o armazenamento, alguém limpa os
     dados do site, o sistema recupera espaço), ele tem de voltar sozinho na
     abertura seguinte. Prova-se a desfazer o registo com a sessão aberta,
     que é o estado em que aquele tablet está sempre.
     ======================================================================= */

  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 12000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#botao-manual', 14000);
  certo(await palco.js("return localStorage.getItem('carimbo-demo:balcao-entrou') !== null"),
    'balcão com sessão: o operador ficou mesmo dentro do balcão',
    String(await palco.js("return localStorage.getItem('carimbo-demo:balcao-entrou')")));

  await palco.js(`
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      if (r.scope.endsWith(${JSON.stringify(`${BASE}/balcao/`)})) await r.unregister();
    }
    return true`);
  certo((await registos(palco)).every((r) => r.ambito !== `${BASE}/balcao/`),
    'balcão com sessão: o registo foi mesmo desfeito (o teste é válido)',
    JSON.stringify(await registos(palco)));

  await palco.recarregar();
  await palco.esperar('#botao-manual', 14000);
  const swOutraVezBalcao = await swPronto(palco, 10000);
  certo(!swOutraVezBalcao.erro,
    'balcão com sessão: ao reabrir, o balcão volta a registar o service worker',
    String(swOutraVezBalcao.erro || ''));
  certo((await registos(palco)).some((r) => r.ambito === `${BASE}/balcao/`),
    'balcão com sessão: e o balcão volta a estar preparado para abrir sem rede',
    JSON.stringify(await registos(palco)));

  /* O controlo, para a falha de cima apontar à causa e não ao sintoma: o
     mesmo balcão, o mesmo armazenamento, o mesmo recarregar — só que sem
     sessão aberta. Se este passar e o de cima falhar, o que separa os dois é
     ter entrado, e não o service worker estar avariado. */
  await palco.js("localStorage.removeItem('carimbo-demo:balcao-entrou'); return true");
  await palco.recarregar();
  await palco.esperar('#entrada-acoes .btn-cheio', 12000);
  const swSemSessao = await swPronto(palco, 12000);
  certo(!swSemSessao.erro,
    'controlo: sem sessão aberta, o mesmo balcão regista o service worker à primeira',
    String(swSemSessao.erro || ''));
}
