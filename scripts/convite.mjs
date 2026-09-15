#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — os convites

   Quem pode abrir um balcão novo. Era um segredo do Worker igual para toda a
   gente, com usos infinitos, sem validade e sem forma de revogar um sem partir
   os outros — e que nem o dono do produto conseguia ler de volta, porque o
   Cloudflare não devolve segredos. Passou a ser uma linha numa tabela.

   PORQUE É UM COMANDO E NÃO UM ECRÃ. Um ecrã de administração obriga a
   inventar um papel novo, uma rota nova, uma maneira de provar que aquele
   email é o do dono do produto, e a proteger essa rota para sempre. O
   `wrangler` já está autenticado contra a conta Cloudflare — que é o único
   cadeado deste sistema que mais ninguém consegue abrir. Zero código de
   autenticação escrito é zero código de autenticação com defeitos.

   O CÓDIGO EM CLARO NUNCA ENTRA NA BASE. Guarda-se o resumo SHA-256, como nas
   sessões: uma cópia da base de dados não dá um convite a ninguém. Em troca,
   um código perdido não se recupera — gera-se outro e revoga-se o primeiro.

   COMO SE USA NO MUNDO REAL. O comando precisa de um terminal com o wrangler
   autenticado, e tu vais estar de telemóvel na mão dentro de um café. Não é
   um problema: sais de casa com um LOTE já feito — `--lote 3` — guardas as
   três ligações numa nota, e gastas a seguinte.

   Uso:
     node scripts/convite.mjs criar --para "Barbearia Tó"
     node scripts/convite.mjs criar --para "Feira" --lote 5 --dias 30
     node scripts/convite.mjs criar --para "Zé" --email ze@cafe.pt
     node scripts/convite.mjs listar
     node scripts/convite.mjs revogar 3f9a1c22

   Junta `--local` a qualquer um para trabalhar na base de desenvolvimento.
   ========================================================================= */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const WORKER = join(AQUI, '..', 'worker');

/* O mesmo alfabeto do `publicoNovo` do Worker: sem 0/O, 1/I/L, 5/S, 8/B.
   Estes códigos são lidos em voz alta dentro de um café com música, e
   escritos por alguém sem óculos. */
const ALFABETO = '234679ACDEFGHJKLMNPQRTUVWXYZ';

const resumo = (t) => createHash('sha256').update(t).digest('hex');

function codigoNovo(n = 8) {
  /* Sorteio sem viés: rejeita os bytes que não cabem num número inteiro de
     voltas ao alfabeto. Com 28 letras e 256 valores, os últimos 4 valores
     dariam quatro letras uma vez a mais do que as outras. */
  const tecto = Math.floor(256 / ALFABETO.length) * ALFABETO.length;
  const saida = [];
  while (saida.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b >= tecto) continue;
      saida.push(ALFABETO[b % ALFABETO.length]);
      if (saida.length === n) break;
    }
  }
  return saida.join('');
}

/** `K3WM7RPD` → `K3WM-7RPD`. O hífen é só para os olhos; o Worker ignora-o. */
const comHifen = (c) => c.replace(/(.{4})(?=.)/g, '$1-');

/* --- falar com o D1 -------------------------------------------------------
   Pelo `--file=` e não pelo `--command`: o `--command` não tem parâmetros
   ligados, e um nome com apóstrofo («Café d'Aqui») partia o SQL ou pior. O
   ficheiro temporário é escrito, corrido e apagado.
   ------------------------------------------------------------------------- */

const ARGS = process.argv.slice(2);
const LOCAL = ARGS.includes('--local');

function correr(args) {
  const saida = execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
    LOCAL ? '--local' : '--remote', '--config', './wrangler.toml', '--json', ...args],
    { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const i = saida.indexOf('[');
  if (i < 0) throw new Error(`o wrangler não devolveu resultado:\n${saida.slice(0, 400)}`);
  return JSON.parse(saida.slice(i));
}

/** Escrever. Vai por ficheiro, que aguenta várias instruções e textos longos. */
function sql(instrucao) {
  const pasta = mkdtempSync(join(tmpdir(), 'carimbo-'));
  const ficheiro = join(pasta, 'q.sql');
  writeFileSync(ficheiro, instrucao);
  try { return correr([`--file=${ficheiro}`]); }
  finally { try { unlinkSync(ficheiro); } catch { /* o sistema limpa a pasta */ } }
}

/**
 * Ler. Vai por `--command`, e a diferença não é de estilo.
 *
 * Com `--remote --file=`, o wrangler devolve um RESUMO — «Total queries
 * executed», «Rows read» — em vez das linhas. Com `--command` devolve os
 * dados. E localmente devolve dados nos dois casos, o que faz disto o pior
 * género de diferença: o `listar` corria bem em desenvolvimento e rebentava
 * contra a produção, com um `Cannot read properties of undefined`.
 *
 * O `--command` não tem parâmetros ligados, por isso tudo o que aqui entrar
 * tem de passar pelo `texto()`.
 */
const ler = (instrucao) => correr(['--command', instrucao]);

const linhas = (r) => (r[r.length - 1] && r[r.length - 1].results) || [];

/** Aspas de SQL, à mão, porque o `--file` não tem parâmetros ligados. */
const texto = (v) => (v === null || v === undefined || v === '')
  ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

/* --- ler as opções --------------------------------------------------------- */

function opcao(nome, omissao = null) {
  const i = ARGS.indexOf(`--${nome}`);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : omissao;
}

/* --- os verbos ------------------------------------------------------------- */

function criar() {
  const para = opcao('para');
  if (!para) {
    console.error('\n✗ Falta o --para: para quem é este convite.');
    console.error('  node scripts/convite.mjs criar --para "Barbearia Tó"\n');
    process.exit(1);
  }
  const email = opcao('email');
  const usos = Math.max(1, Math.min(999, Number(opcao('usos', '1')) || 1));
  const dias = Number(opcao('dias', '90'));
  const lote = Math.max(1, Math.min(50, Number(opcao('lote', '1')) || 1));
  const expira = Number.isFinite(dias) && dias > 0
    ? new Date(Date.now() + dias * 86400000).toISOString() : null;

  const feitos = [];
  const valores = [];
  for (let i = 0; i < lote; i++) {
    const codigo = codigoNovo();
    const r = resumo(codigo);
    feitos.push({ codigo, ref: r.slice(0, 8) });
    valores.push(`(${texto(r)}, ${texto(lote > 1 ? `${para} (${i + 1}/${lote})` : para)}, `
      + `${texto(email)}, ${usos}, 0, ${texto(new Date().toISOString())}, ${texto(expira)})`);
  }
  sql(`INSERT INTO convites (resumo, etiqueta, email, usos_max, usos, criado_em, expira_em)\n`
    + `VALUES\n  ${valores.join(',\n  ')};`);

  console.log(`\n${lote > 1 ? `${lote} convites` : 'Convite'} para ${para}`);
  console.log('─'.repeat(52));
  for (const f of feitos) {
    console.log(`\n  ${comHifen(f.codigo)}`);
    console.log(`  https://carimbodigital.pt/balcao/#c=${f.codigo}`);
    console.log(`  ref ${f.ref} · ${usos} uso${usos > 1 ? 's' : ''}`
      + (expira ? ` · até ${expira.slice(0, 10)}` : ' · sem prazo')
      + (email ? ` · só para ${email}` : ''));
  }
  console.log(`\n${'─'.repeat(52)}`);
  console.log('O código não volta a aparecer — aqui só fica o resumo dele.');
  console.log('Perdeste-o? Revoga pela ref e gera outro.\n');
}

function listar() {
  const r = linhas(ler(
    `SELECT c.resumo, c.etiqueta, c.email, c.usos, c.usos_max, c.expira_em, c.revogado_em,
            (SELECT GROUP_CONCAT(n.nome, ', ') FROM negocios n WHERE n.convite = c.resumo) AS nasceu
       FROM convites c ORDER BY c.criado_em DESC LIMIT 60;`));
  if (!r.length) { console.log('\nNão há convites nenhuns.\n'); return; }
  const agora = new Date().toISOString();
  console.log(`\n${r.length} convite${r.length > 1 ? 's' : ''}\n${'─'.repeat(72)}`);
  for (const c of r) {
    const estado = c.revogado_em ? 'anulado'
      : (c.expira_em && c.expira_em <= agora) ? 'caducado'
      : (c.usos >= c.usos_max) ? 'gasto' : 'serve';
    console.log(`  ${c.resumo.slice(0, 8)}  ${String(estado).padEnd(9)} `
      + `${String(`${c.usos}/${c.usos_max}`).padEnd(7)} ${c.etiqueta || '—'}`);
    if (c.nasceu) console.log(`            └─ nasceu daqui: ${c.nasceu}`);
    if (c.email) console.log(`            └─ preso a ${c.email}`);
  }
  console.log();
}

function revogar() {
  const ref = ARGS[1];
  if (!ref || ref.startsWith('--')) {
    console.error('\n✗ Falta a ref: node scripts/convite.mjs revogar 3f9a1c22\n');
    process.exit(1);
  }
  const alvo = linhas(ler(`SELECT resumo, etiqueta, revogado_em FROM convites
    WHERE resumo LIKE ${texto(`${ref}%`)} LIMIT 2;`));
  if (!alvo.length) { console.error(`\n✗ Não há convite nenhum que comece por ${ref}.\n`); process.exit(1); }
  if (alvo.length > 1) { console.error(`\n✗ ${ref} casa com mais do que um. Escreve mais caracteres.\n`); process.exit(1); }
  if (alvo[0].revogado_em) { console.log(`\nJá estava anulado: ${alvo[0].etiqueta || ref}\n`); return; }
  sql(`UPDATE convites SET revogado_em = ${texto(new Date().toISOString())}
       WHERE resumo = ${texto(alvo[0].resumo)};`);
  console.log(`\n✓ Anulado: ${alvo[0].etiqueta || ref}`);
  console.log('  Quem o tiver na mão deixa de conseguir fundar seja o que for.\n');
}

/* --- entrada --------------------------------------------------------------- */

const VERBOS = { criar, listar, revogar };
const verbo = ARGS[0];
if (!verbo || !VERBOS[verbo]) {
  console.log(`
Convites do Carimbo Digital

  criar --para "Nome"        um convite de um uso, válido 90 dias
        --lote 3             três de uma vez, para levar de casa
        --usos 10            um código que serve dez vezes
        --dias 30            outro prazo (--dias 0 = sem prazo)
        --email x@y.pt       preso a uma morada
  listar                     todos, com o estado e o que nasceu de cada um
  revogar <ref>              anula um pela ref (os 8 primeiros caracteres)

  --local                    trabalha na base de desenvolvimento
`);
  process.exit(verbo ? 1 : 0);
}
VERBOS[verbo]();
