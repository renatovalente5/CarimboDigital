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

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirChrome, novoSeparador, esperarCarregada, encontrarChrome, esperar } from './chrome.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_dev', 'capturas');
const BASE = process.argv[2] || 'http://localhost:4321/CarimboDigital';



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

if (!encontrarChrome()) { console.error('Não encontrei o Chrome.'); process.exit(1); }

/* A pasta é limpa de propósito: se um ecrã for renomeado, o ficheiro antigo
   fica lá e passa a parecer uma captura desta volta. */
rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(DESTINO, { recursive: true });

const { enviar, fechar } = await abrirChrome();
const { targetId, sessionId } = await novoSeparador(enviar);

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
    await esperarCarregada(enviar, sessionId);
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${LIMPAR} })()`, awaitPromise: true,
    }, sessionId).catch(() => {});
  }

  await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
  await esperarCarregada(enviar, sessionId);
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
fechar();

console.log(`\n${ECRAS.length - maus}/${ECRAS.length} capturas na página certa, em _dev/capturas/.`);
process.exit(maus ? 1 : 0);
