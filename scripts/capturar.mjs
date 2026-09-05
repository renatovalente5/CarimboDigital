#!/usr/bin/env node
/* =========================================================================
   Sinete — capturas de ecrã

   Abre o Chrome sem interface, conduz a app até ao ecrã que se quer e tira a
   fotografia. Fala com o Chrome pelo protocolo de depuração (CDP), que é só
   WebSocket e JSON — o Node 22 já traz as duas coisas, por isso continua a
   não haver dependências.

   Uso:  node scripts/capturar.mjs [endereço-base]
         (por omissão, o servidor local)
   ========================================================================= */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_dev', 'capturas');
const PERFIL = join(tmpdir(), 'sinete-capturas');
const PORTA = 9333;
const BASE = process.argv[2] || 'http://localhost:4321/Sinete';

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
    ws.onopen = () => resolve({
      ws,
      enviar(metodo, params = {}, sessionId) {
        const id = seguinte++;
        return new Promise((ok, mal) => {
          pendentes.set(id, { ok, mal });
          ws.send(JSON.stringify({ id, method: metodo, params, sessionId }));
        });
      },
    });
  });
}

/* --- os ecrãs a fotografar ----------------------------------------------- */

const ECRAS = [
  { nome: '1-site', url: '/', largura: 1280, altura: 900, espera: 1200 },
  { nome: '2-site-telemovel', url: '/', largura: 402, altura: 874, espera: 1200 },
  { nome: '3-negocios', url: '/negocios/', largura: 1280, altura: 900, espera: 1200 },
  {
    nome: '4-abertura', url: '/app/', largura: 402, altura: 874, espera: 1600,
    limpar: true,
  },
  {
    nome: '5-carteira', url: '/app/', largura: 402, altura: 874, espera: 1600,
    limpar: true,
    guiao: `const b = document.querySelector('#bv-seguinte');
            for (let i = 0; i < 3; i++) { b.click(); await new Promise(r=>setTimeout(r,260)); }
            await new Promise(r=>setTimeout(r,1500));`,
  },
  {
    nome: '6-codigo', url: '/app/', largura: 402, altura: 874, espera: 1600,
    guiao: `document.querySelectorAll('.barra-item')[2].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '7-cartao', url: '/app/', largura: 402, altura: 1180, espera: 1600,
    guiao: `const c = [...document.querySelectorAll('#principal .cartao')]
                       .find(x => x.textContent.includes('Café Torrado'));
            c.click(); await new Promise(r=>setTimeout(r,1100));`,
  },
  {
    nome: '8-descobrir', url: '/app/', largura: 402, altura: 874, espera: 1600,
    guiao: `document.querySelectorAll('.barra-item')[1].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '9-balcao-entrada', url: '/balcao/', largura: 402, altura: 874, espera: 1500,
    limpar: true,
  },
  {
    nome: '10-balcao-carimbado', url: '/balcao/', largura: 402, altura: 874, espera: 1600,
    guiao: `/* O balcão sozinho não tem clientes — quem os cria é a app do
               cliente. Para a captura, cria-se um pela mesma camada de dados. */
            const { api } = await import('../js/api.js');
            const r = await api.registarCliente();
            await api.semear(r.cliente.id);
            document.querySelector('#entrar-demo')?.click();
            await new Promise(res=>setTimeout(res,1600));
            const publico = r.cliente.publico;
            if (publico) {
              document.querySelector('#botao-manual').click();
              await new Promise(res=>setTimeout(res,320));
              document.querySelector('#campo-numero').value = publico;
              document.querySelector('.painel-folha .btn-cheio').click();
              await new Promise(res=>setTimeout(res,1200));
            }`,
  },
  {
    nome: '11-balcao-cartao', url: '/balcao/', largura: 402, altura: 1180, espera: 1600,
    guiao: `document.querySelectorAll('.barra-item')[3].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
];

/* --- a correr ------------------------------------------------------------ */

rmSync(PERFIL, { recursive: true, force: true });
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
    const r = await fetch(`http://127.0.0.1:${PORTA}/json/version`);
    navegador = await r.json();
  } catch { /* ainda a arrancar */ }
}
if (!navegador) { chrome.kill(); console.error('O Chrome não arrancou.'); process.exit(1); }

const { enviar } = await ligar(navegador.webSocketDebuggerUrl);

for (const ecra of ECRAS) {
  const { targetId } = await enviar('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await enviar('Target.attachToTarget', { targetId, flatten: true });

  await enviar('Page.enable', {}, sessionId);
  await enviar('Runtime.enable', {}, sessionId);
  await enviar('Emulation.setDeviceMetricsOverride', {
    width: ecra.largura, height: ecra.altura,
    deviceScaleFactor: 2, mobile: ecra.largura < 700,
  }, sessionId);

  await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
  await esperar(ecra.espera);

  if (ecra.limpar) {
    await enviar('Runtime.evaluate', {
      expression: `(async () => {
        localStorage.clear();
        await new Promise(res => { const d = indexedDB.deleteDatabase('sinete');
          d.onsuccess = d.onerror = d.onblocked = res; });
        location.reload();
      })()`,
      awaitPromise: true,
    }, sessionId).catch(() => {});
    await esperar(ecra.espera);
  }

  if (ecra.guiao) {
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${ecra.guiao} })()`,
      awaitPromise: true,
    }, sessionId).catch((e) => console.warn(`  (guião de ${ecra.nome}: ${e.message})`));
    await esperar(400);
  }

  const { data } = await enviar('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(DESTINO, `${ecra.nome}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${ecra.nome}.png  ${ecra.largura}x${ecra.altura}`);

  await enviar('Target.closeTarget', { targetId });
}

chrome.kill();
/* O Chrome ainda está a fechar ficheiros quando chegamos aqui; apagar o
   perfil à força rebenta com ENOTEMPTY e não vale a pena — é uma pasta
   temporária que o sistema limpa sozinho. */
try { rmSync(PERFIL, { recursive: true, force: true }); } catch { /* fica */ }
console.log(`\n${ECRAS.length} capturas em _dev/capturas/.`);
process.exit(0);
