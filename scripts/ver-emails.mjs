#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — ver os emails

   Constrói cada email com o mesmo código que o Worker usa, escreve-o num
   ficheiro e tira-lhe uma fotografia em claro e em escuro. Depois monta uma
   folha de contacto com todos, para se ver de relance se algum ficou torto.

   O que isto NÃO consegue dizer, e é importante ter presente: um Chrome
   renderiza HTML como um browser, e nenhum cliente de email o faz. O Outlook
   para Windows desenha com o motor do Word, o Gmail corta o que está no
   cabeçalho, e vários invertem as cores por conta própria. Isto apanha erros
   de conteúdo, de hierarquia e de contraste — não substitui abrir o email
   num telemóvel a sério.

   Uso:  node scripts/ver-emails.mjs
   ========================================================================= */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirChrome, novoSeparador, encontrarChrome, esperar } from './chrome.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_dev', 'emails');

/* --- os emails a ver ----------------------------------------------------- */

const { emailCodigoCliente, emailCodigoBalcao } = await import('../worker/src/emails.js');

const CASOS = [
  { nome: 'cliente', email: emailCodigoCliente({ codigo: '318204', minutos: 15 }) },
  { nome: 'balcao', email: emailCodigoBalcao({ codigo: '705193', minutos: 15, negocio: 'Café Torrado' }) },
];

/* --- escrever os ficheiros ----------------------------------------------- */

rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(DESTINO, { recursive: true });

for (const caso of CASOS) {
  writeFileSync(join(DESTINO, `${caso.nome}.html`), caso.email.html);
  writeFileSync(join(DESTINO, `${caso.nome}.txt`),
    `Assunto: ${caso.email.assunto}\n\n${caso.email.texto}\n`);
  console.log(`  ${caso.nome}.html  ·  «${caso.email.assunto}»`);
}

/* --- e fotografá-los ----------------------------------------------------- */

if (!encontrarChrome()) {
  console.log('\nSem Chrome — ficam os HTML e os textos em _dev/emails/.');
  process.exit(0);
}

const { enviar, fechar } = await abrirChrome();
const { targetId, sessionId } = await novoSeparador(enviar);

/* Os clientes de email põem o email dentro de um painel com a sua própria
   cor de fundo. Simula-se isso, senão um email de fundo branco parece bem
   em cima de branco e depois flutua num painel escuro. */
const PAINEIS = [
  { nome: 'claro', fundo: '#F1F0EC', esquema: 'light' },
  { nome: 'escuro', fundo: '#1C1B21', esquema: 'dark' },
];

for (const caso of CASOS) {
  for (const painel of PAINEIS) {
    await enviar('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: painel.esquema }],
    }, sessionId).catch(() => {});
    await enviar('Emulation.setDeviceMetricsOverride', {
      width: 700, height: 1400, deviceScaleFactor: 2, mobile: false,
    }, sessionId);

    const moldura = `<!doctype html><meta charset="utf-8">`
      + `<style>html,body{margin:0;background:${painel.fundo}}`
      + `.painel{padding:28px 12px}</style>`
      + `<div class="painel">${caso.email.html}</div>`;
    const ficheiro = join(DESTINO, `${caso.nome}-${painel.nome}.html`);
    writeFileSync(ficheiro, moldura);

    await enviar('Page.navigate', { url: 'file://' + ficheiro }, sessionId);
    await esperar(900);

    /* Corta-se a captura à altura real do email, para não sobrar painel. */
    const medida = await enviar('Runtime.evaluate', {
      expression: 'document.querySelector(".painel").getBoundingClientRect().height',
      returnByValue: true,
    }, sessionId).catch(() => null);
    const altura = Math.min(2400, Math.ceil(medida?.result?.value || 1400) + 40);
    await enviar('Emulation.setDeviceMetricsOverride', {
      width: 700, height: altura, deviceScaleFactor: 2, mobile: false,
    }, sessionId);
    await esperar(250);

    const { data } = await enviar('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(DESTINO, `${caso.nome}-${painel.nome}.png`), Buffer.from(data, 'base64'));
    console.log(`  ${caso.nome}-${painel.nome}.png  700x${altura}`);
  }
}

/* Uma versão estreita, que é como a maior parte das pessoas vai ler. */
for (const caso of CASOS) {
  await enviar('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sessionId).catch(() => {});
  await enviar('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 1400, deviceScaleFactor: 2, mobile: true,
  }, sessionId);
  const ficheiro = join(DESTINO, `${caso.nome}-claro.html`);
  await enviar('Page.navigate', { url: 'file://' + ficheiro }, sessionId);
  await esperar(900);
  const medida = await enviar('Runtime.evaluate', {
    expression: 'document.querySelector(".painel").getBoundingClientRect().height',
    returnByValue: true,
  }, sessionId).catch(() => null);
  const altura = Math.min(2400, Math.ceil(medida?.result?.value || 1400) + 40);
  await enviar('Emulation.setDeviceMetricsOverride', {
    width: 390, height: altura, deviceScaleFactor: 2, mobile: true,
  }, sessionId);
  await esperar(250);
  const { data } = await enviar('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(DESTINO, `${caso.nome}-telemovel.png`), Buffer.from(data, 'base64'));
  console.log(`  ${caso.nome}-telemovel.png  390x${altura}`);
}

await enviar('Target.closeTarget', { targetId }).catch(() => {});
fechar();

console.log(`\n${CASOS.length} emails em _dev/emails/ (HTML, texto e fotografias).`);
console.log('Lembrete: isto é um browser. O Outlook desenha com o motor do Word e');
console.log('vários clientes invertem as cores — ver num telemóvel a sério continua');
console.log('a ser a única prova que conta.\n');
