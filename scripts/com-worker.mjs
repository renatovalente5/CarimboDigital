#!/usr/bin/env node
/* =========================================================================
   Levanta um wrangler dev, corre o que lhe passarem, e mata-o a seguir.

   Existe porque um Worker deixado a correr entre comandos não sobrevive ao
   ambiente onde isto se desenvolve — e porque um teste que depende de
   alguém se ter lembrado de levantar o servidor é um teste que falha por
   razões que não são dele.

   Uso:  node scripts/com-worker.mjs worker/testes.mjs
   ========================================================================= */

import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const WORKER = join(RAIZ, 'worker');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Garante que há segredos locais. Nunca vão para o repositório. */
export function garantirSegredos({ fundador = 'TESTE1' } = {}) {
  const ficheiro = join(WORKER, '.dev.vars');
  if (existsSync(ficheiro)) return;
  writeFileSync(ficheiro, [
    `CHAVE_MESTRA=${randomBytes(32).toString('base64url')}`,
    'ORIGENS=',
    `CODIGO_FUNDADOR=${fundador}`,
    '',
  ].join('\n'));
}

/**
 * Aplica o esquema à base local.
 *
 * É tudo `CREATE TABLE IF NOT EXISTS`, por isso correr sempre não custa nada
 * e resolve o caso que já mordeu: uma tabela nova no esquema, a base local a
 * ficar para trás, e a bateria a rebentar com «no such table» — que parece
 * um defeito do código e é só uma migração por aplicar.
 */
function prepararBase() {
  try {
    execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
      '--local', '--file=esquema.sql'], { cwd: WORKER, stdio: 'ignore' });
  } catch {
    /* Se falhar, o arranque a seguir dirá porquê com mais clareza. */
  }
}

export async function comWorker(tarefa, { porta = 8787, tecto = 90000 } = {}) {
  garantirSegredos();
  prepararBase();
  const processo = spawn('npx', ['--yes', 'wrangler', 'dev', '--local', '--port', String(porta)], {
    cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let registo = '';
  processo.stdout.on('data', (d) => { registo += d; });
  processo.stderr.on('data', (d) => { registo += d; });

  const matar = () => {
    try { process.kill(-processo.pid, 'SIGKILL'); } catch { /* já morreu */ }
    try { processo.kill('SIGKILL'); } catch { /* idem */ }
  };
  process.once('exit', matar);
  process.once('SIGINT', () => { matar(); process.exit(130); });

  const API = `http://127.0.0.1:${porta}`;
  const limite = Date.now() + tecto;
  for (;;) {
    try { if ((await fetch(`${API}/v1/saude`)).ok) break; } catch { /* ainda a subir */ }
    if (Date.now() > limite) {
      matar();
      throw new Error(`O Worker não arrancou em ${tecto} ms:\n${registo.slice(-1500)}`);
    }
    await esperar(400);
  }
  try {
    return await tarefa(API);
  } catch (erro) {
    /* Se a tarefa rebentou, o que interessa é o que o Worker disse — um
       ECONNRESET do lado do teste é o sintoma, e a causa está no registo. */
    console.error(`\nO Worker, nos últimos instantes:\n${registo.slice(-2500)}`);
    throw erro;
  } finally {
    matar();
  }
}

/* Correr directamente: `node scripts/com-worker.mjs worker/testes.mjs` */
if (process.argv[1] && process.argv[1].endsWith('com-worker.mjs') && process.argv[2]) {
  const alvo = join(RAIZ, process.argv[2]);
  const codigo = await comWorker(async (API) => {
    const filho = spawn(process.execPath, [alvo, API], { stdio: 'inherit', cwd: RAIZ });
    return new Promise((r) => filho.on('exit', r));
  });
  process.exit(codigo || 0);
}
