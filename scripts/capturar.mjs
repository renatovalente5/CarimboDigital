#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — capturas de ecrã

   Abre o Chrome sem interface, conduz a app até ao ecrã que se quer e tira a
   fotografia. Fala com o Chrome pelo protocolo de depuração (CDP), que é só
   WebSocket e JSON — o Node 22 já traz as duas coisas, por isso continua a
   não haver dependências.

   Um alvo só, navegado de ecrã em ecrã. Criar um alvo por ecrã parece mais
   limpo, mas em modo headless o `Page.captureScreenshot` fotografa a
   superfície composta: com vários alvos abertos saem capturas byte a byte
   iguais entre ecrãs do mesmo tamanho, e parece que as páginas estão erradas.

   Uso:  node scripts/capturar.mjs [endereço-base]
   ========================================================================= */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_dev', 'capturas');
const PERFIL = join(tmpdir(), 'carimbodigital-capturas');
const PORTA = 9333;
const BASE = process.argv[2] || 'http://localhost:4321/CarimboDigital';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('Não encontrei o Chrome.'); process.exit(1); }

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- ligação ao Chrome --------------------------------------------------- */

let seguinte = 1;
function ligar(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pendentes = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pendentes.has(m.id)) {
        const { ok, mal } = pendentes.get(m.id);
        pendentes.delete(m.id);
        m.error ? mal(new Error(m.error.message)) : ok(m.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve((metodo, params = {}, sessionId) => {
      const id = seguinte++;
      return new Promise((ok, mal) => {
        pendentes.set(id, { ok, mal });
        ws.send(JSON.stringify({ id, method: metodo, params, sessionId }));
      });
    });
  });
}

/* --- os ecrãs a fotografar ----------------------------------------------- */

const LIMPAR = `
  localStorage.clear();
  await new Promise(res => { const d = indexedDB.deleteDatabase('carimbo');
    d.onsuccess = d.onerror = d.onblocked = res; });
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
`;

const ABRIR_APP = `
  const b = document.querySelector('#bv-seguinte');
  if (b) { for (let i = 0; i < 3; i++) { b.click(); await new Promise(r=>setTimeout(r,260)); } }
  await new Promise(r=>setTimeout(r,1500));
`;

const ECRAS = [
  { nome: '1-site', url: '/', largura: 1280, altura: 900 },
  { nome: '2-site-telemovel', url: '/', largura: 402, altura: 874 },
  { nome: '3-negocios', url: '/negocios/', largura: 1280, altura: 900 },

  { nome: '4-abertura', url: '/app/', largura: 402, altura: 874, limpar: true },
  { nome: '5-carteira', url: '/app/', largura: 402, altura: 874, limpar: true, guiao: ABRIR_APP },
  {
    nome: '6-codigo', url: '/app/', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[2].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '7-cartao', url: '/app/', largura: 402, altura: 1180,
    guiao: `${ABRIR_APP}
            const c = [...document.querySelectorAll('#principal .cartao')]
                        .find(x => x.textContent.includes('Café Torrado'));
            if (c) { c.click(); await new Promise(r=>setTimeout(r,1100)); }`,
  },
  {
    nome: '8-descobrir', url: '/app/', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[1].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '9-premios', url: '/app/', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[3].click();
            await new Promise(r=>setTimeout(r,900));`,
  },

  { nome: '10-balcao-entrada', url: '/balcao/', largura: 402, altura: 874, limpar: true },
  {
    nome: '11-balcao-carimbado', url: '/balcao/', largura: 402, altura: 874, limpar: true,
    /* O balcão sozinho não tem clientes — quem os cria é a app do cliente.
       Para a captura, cria-se um pela mesma camada de dados. */
    guiao: `const { api } = await import('../js/api.js');
            const r = await api.registarCliente();
            await api.semear(r.cliente.id);
            document.querySelector('#entrar-demo')?.click();
            await new Promise(res=>setTimeout(res,1700));
            document.querySelector('#botao-manual').click();
            await new Promise(res=>setTimeout(res,340));
            document.querySelector('#campo-numero').value = r.cliente.publico;
            document.querySelector('.painel-folha .btn-cheio').click();
            await new Promise(res=>setTimeout(res,1300));`,
  },
  {
    nome: '12-balcao-hoje', url: '/balcao/', largura: 402, altura: 1000,
    guiao: `document.querySelector('#entrar-demo')?.click();
            await new Promise(res=>setTimeout(res,1500));
            document.querySelectorAll('.barra-item')[1].click();
            await new Promise(res=>setTimeout(res,900));`,
  },
  {
    nome: '13-balcao-cartao', url: '/balcao/', largura: 402, altura: 1240,
    guiao: `document.querySelector('#entrar-demo')?.click();
            await new Promise(res=>setTimeout(res,1500));
            document.querySelectorAll('.barra-item')[3].click();
            await new Promise(res=>setTimeout(res,900));`,
  },
];

/* --- a correr ------------------------------------------------------------ */

rmSync(PERFIL, { recursive: true, force: true });
/* A pasta é limpa de propósito: se um ecrã for renomeado, o ficheiro antigo
   fica lá e passa a parecer uma captura desta volta. */
rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(DESTINO, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
  `--remote-debugging-port=${PORTA}`, `--user-data-dir=${PERFIL}`,
  'about:blank',
], { stdio: 'ignore' });

let navegador = null;
for (let i = 0; i < 40 && !navegador; i++) {
  await esperar(400);
  try {
    navegador = await (await fetch(`http://127.0.0.1:${PORTA}/json/version`)).json();
  } catch { /* ainda a arrancar */ }
}
if (!navegador) { chrome.kill(); console.error('O Chrome não arrancou.'); process.exit(1); }

const enviar = await ligar(navegador.webSocketDebuggerUrl);

const { targetId } = await enviar('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await enviar('Target.attachToTarget', { targetId, flatten: true });
await enviar('Page.enable', {}, sessionId);
await enviar('Runtime.enable', {}, sessionId);

/** Espera que a página acabe de carregar, ou desiste ao fim de `tecto`. */
async function esperarCarregada(tecto = 6000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const r = await enviar('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    }, sessionId).catch(() => null);
    if (r?.result?.value === 'complete') return true;
    if (Date.now() > limite) return false;
    await esperar(150);
  }
}

let maus = 0;
for (const ecra of ECRAS) {
  await enviar('Emulation.setDeviceMetricsOverride', {
    width: ecra.largura, height: ecra.altura,
    deviceScaleFactor: 2, mobile: ecra.largura < 700,
  }, sessionId);

  /* Limpa-se ANTES de navegar para a página que interessa: limpar depois
     obriga a um `location.reload()`, e a partir daí não se sabe em que
     estado a página está quando se dispara. */
  if (ecra.limpar) {
    await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
    await esperarCarregada();
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${LIMPAR} })()`, awaitPromise: true,
    }, sessionId).catch(() => {});
  }

  await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
  await esperarCarregada();
  await esperar(1100);

  if (ecra.guiao) {
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${ecra.guiao} })()`, awaitPromise: true,
    }, sessionId).catch((e) => console.warn(`  (guião de ${ecra.nome}: ${e.message})`));
    await esperar(450);
  }

  /* Confirma-se onde é que se está antes de disparar. Uma captura da página
     errada é pior do que nenhuma — parece que o produto está avariado. */
  const onde = await enviar('Runtime.evaluate', {
    expression: 'location.pathname', returnByValue: true,
  }, sessionId).catch(() => null);
  const caminho = onde?.result?.value || '';
  const esperado = new URL(BASE + ecra.url).pathname;
  const certo = caminho === esperado;
  if (!certo) maus++;

  const { data } = await enviar('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(DESTINO, `${ecra.nome}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${certo ? ' ' : '✗'} ${ecra.nome}.png  ${ecra.largura}x${ecra.altura}`
    + (certo ? '' : `  (está em ${caminho}, esperava ${esperado})`));
}

await enviar('Target.closeTarget', { targetId }).catch(() => {});
chrome.kill();
/* O Chrome ainda está a fechar ficheiros quando chegamos aqui; apagar o
   perfil à força rebenta com ENOTEMPTY e não vale a pena. */
try { rmSync(PERFIL, { recursive: true, force: true }); } catch { /* fica */ }

console.log(`\n${ECRAS.length - maus}/${ECRAS.length} capturas na página certa, em _dev/capturas/.`);
process.exit(maus ? 1 : 0);
