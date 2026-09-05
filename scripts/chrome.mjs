/* =========================================================================
   Carimbo Digital — falar com o Chrome

   O protocolo de depuração do Chrome é WebSocket e JSON, e o Node 22 traz as
   duas coisas — por isso não é preciso instalar nada para conduzir um
   browser. Isto é a canalização, partilhada por quem tira capturas do site e
   por quem vê os emails.

   Três coisas que doeram até estarem aqui:

   · Uma porta fixa faz o segundo arranque encontrar o Chrome do primeiro
     ainda vivo, ligar-se a ELE, e ficar à espera de um alvo que já não
     existe. A porta é sorteada.
   · Um Chrome deixado a correr fica pendurado para sempre. Fecha-se sempre,
     mesmo quando o script rebenta a meio.
   · Sem tecto de tempo, qualquer passo que não responda pendura tudo. Há
     tecto.
   ========================================================================= */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const CAMINHOS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function encontrarChrome() {
  return CAMINHOS.find(existsSync) || null;
}

/**
 * Levanta um Chrome sem interface e devolve `{ enviar, fechar, alvo }`.
 * `enviar(metodo, params, sessionId)` fala o protocolo; `fechar()` desliga
 * tudo — e é chamado sozinho se o processo terminar por outra via.
 */
export async function abrirChrome({ tecto = 30000 } = {}) {
  const chrome = encontrarChrome();
  if (!chrome) throw new Error('Não encontrei o Chrome.');

  /* Porta sorteada no intervalo alto, para não colidir com outra corrida
     que tenha ficado viva. */
  const porta = 9400 + Math.floor(Math.random() * 400);
  const perfil = mkdtempSync(join(tmpdir(), 'carimbodigital-chrome-'));

  const processo = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
    `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let fechado = false;
  const fechar = () => {
    if (fechado) return;
    fechado = true;
    try { processo.kill(); } catch { /* já morreu */ }
    try { rmSync(perfil, { recursive: true, force: true }); } catch { /* fica */ }
  };
  /* Mesmo que o script rebente ou seja interrompido. */
  process.once('exit', fechar);
  process.once('SIGINT', () => { fechar(); process.exit(130); });

  let versao = null;
  const limite = Date.now() + tecto;
  while (!versao && Date.now() < limite) {
    await esperar(300);
    try { versao = await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json(); }
    catch { /* ainda a arrancar */ }
  }
  if (!versao) { fechar(); throw new Error('O Chrome não arrancou a tempo.'); }

  const enviar = await ligar(versao.webSocketDebuggerUrl, tecto);
  return { enviar, fechar, porta };
}

function ligar(url, tecto) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pendentes = new Map();
    let seguinte = 1;

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id && pendentes.get(m.id);
      if (!p) return;
      pendentes.delete(m.id);
      clearTimeout(p.relogio);
      m.error ? p.mal(new Error(m.error.message)) : p.ok(m.result);
    };
    ws.onerror = () => reject(new Error('Não deu para falar com o Chrome.'));
    ws.onclose = () => {
      for (const p of pendentes.values()) { clearTimeout(p.relogio); p.mal(new Error('Ligação fechada.')); }
      pendentes.clear();
    };
    ws.onopen = () => resolve((metodo, params = {}, sessionId) => {
      const id = seguinte++;
      return new Promise((ok, mal) => {
        /* Sem isto, um método que não responda pendura o script inteiro. */
        const relogio = setTimeout(() => {
          pendentes.delete(id);
          mal(new Error(`${metodo} não respondeu em ${tecto} ms`));
        }, tecto);
        pendentes.set(id, { ok, mal, relogio });
        ws.send(JSON.stringify({ id, method: metodo, params, sessionId }));
      });
    });
  });
}

/** Abre um separador e devolve `{ targetId, sessionId }` já com Page e Runtime ligados. */
export async function novoSeparador(enviar) {
  const { targetId } = await enviar('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await enviar('Target.attachToTarget', { targetId, flatten: true });
  await enviar('Page.enable', {}, sessionId);
  await enviar('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

/** Espera que a página acabe de carregar, ou desiste. */
export async function esperarCarregada(enviar, sessionId, tecto = 8000) {
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
