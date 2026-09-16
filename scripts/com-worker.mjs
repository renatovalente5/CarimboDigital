#!/usr/bin/env node
/* =========================================================================
   Levanta um wrangler dev, corre o que lhe passarem, e mata-o a seguir.

   Existe porque um Worker deixado a correr entre comandos não sobrevive ao
   ambiente onde isto se desenvolve — e porque um teste que depende de
   alguém se ter lembrado de levantar o servidor é um teste que falha por
   razões que não são dele.

   Uso:  node scripts/com-worker.mjs worker/testes.mjs
         node scripts/com-worker.mjs worker/testes.mjs --limpo
           (deita a base fora primeiro — é o que o CI faz, e o
            único jeito de apanhar erros de ordem no esquema)
   ========================================================================= */

import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const WORKER = join(RAIZ, 'worker');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* A porta da Google de mentira. Fora da gama do wrangler, para não haver
   encontrões quando os dois arrancam ao mesmo tempo. */
const PORTA_GOOGLE = 8799;

/** Garante que há segredos locais. Nunca vão para o repositório. */
export function garantirSegredos() {
  const ficheiro = join(WORKER, '.dev.vars');
  /* ACRESCENTA O QUE FALTAR, em vez de desistir se o ficheiro existe.

     Estava `if (existsSync(ficheiro)) return`, e isso era uma armadilha: numa
     máquina que já tivesse `.dev.vars` — ou seja, a de quem trabalha neste
     projecto todos os dias — uma chave NOVA nunca lá chegava. Os testes
     passavam no CI, que parte de uma máquina limpa, e falhavam em casa. */
  if (existsSync(ficheiro)) {
    const actual = readFileSync(ficheiro, 'utf8');
    const faltam = paresDeDesenvolvimento()
      .filter(([k]) => !new RegExp(`^${k}=`, 'm').test(actual));
    if (faltam.length) {
      writeFileSync(ficheiro, `${actual.trimEnd()}\n${faltam.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    }
    return;
  }
  /* O `CODIGO_FUNDADOR` saiu daqui: quem pode fundar deixou de ser um segredo
     do Worker e passou a ser uma linha da tabela `convites`. Os convites de
     teste vêm do `semear.sql`, e a bateria repõe-nos ela própria — um convite
     de um uso é gasto pela primeira corrida e o `INSERT OR IGNORE` do semear
     não o repunha. */
  writeFileSync(ficheiro, `${paresDeDesenvolvimento().map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

/**
 * O que um `.dev.vars` de desenvolvimento precisa de ter.
 *
 * As variáveis da Google apontam para o servidor de mentira
 * (`scripts/google-de-mentira.mjs`) e a chave é gerada aqui, na hora: é uma
 * chave RSA a sério, para a assinatura ser a sério, mas não serve para nada
 * fora desta máquina. Nunca vai para o repositório — o `.dev.vars` está no
 * `.gitignore`.
 *
 * A chave num ficheiro de variáveis não pode ter mudanças de linha, e um PEM
 * tem-nas. Escreve-se com `\n` literais, como a Google faz no JSON da conta
 * de serviço — e o `wallet.js` deita fora os brancos todos ao importar, por
 * isso funciona nos dois formatos.
 */
function paresDeDesenvolvimento() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
  const apple = certificadoDeMentira();
  return [
    ['CHAVE_MESTRA', randomBytes(32).toString('base64url')],
    ['ORIGENS', ''],
    ['DOMINIO', 'localhost'],
    ['GOOGLE_EMISSOR', '3388000000012345678'],
    ['GOOGLE_EMAIL', 'carimbo@de-mentira.iam.gserviceaccount.com'],
    ['GOOGLE_CHAVE', pem.replace(/\n/g, '\\n')],
    ['GOOGLE_API_BASE', `http://localhost:${PORTA_GOOGLE}`],
    ['GOOGLE_OAUTH_BASE', `http://localhost:${PORTA_GOOGLE}`],
    ['APPLE_PASS_TIPO', 'pass.pt.carimbodigital.dementira'],
    ['APPLE_EQUIPA', 'DEMENTIRA1'],
    ['APPLE_CERTIFICADO', apple.certificado],
    ['APPLE_CHAVE', apple.chave],
  ];
}

/**
 * Um certificado auto-assinado para as rotas do passe da Apple.
 *
 * A Apple não empresta certificados de teste: o dela custa a inscrição de
 * programador e sai com o Pass Type ID lá dentro. Mas para provar o WORKER —
 * que o bilhete é assinado, que expira, que só serve para o cartão certo, e
 * que sai de lá um ZIP com uma assinatura que verifica — qualquer certificado
 * serve. O que ESTE não prova é o que só um iPhone prova: que a Apple aceita
 * a cadeia dela. Isso fica dito, e não fingido.
 *
 * As mudanças de linha vão como `\n` literais porque um ficheiro de variáveis
 * de ambiente não as aguarda — o `doPEM` desfaz isso do outro lado.
 */
function certificadoDeMentira() {
  const pasta = mkdtempSync(join(tmpdir(), 'carimbo-apple-'));
  try {
    const k = join(pasta, 'k.pem');
    const c = join(pasta, 'c.pem');
    const k8 = join(pasta, 'k8.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', k,
      '-out', c, '-days', '2', '-nodes',
      '-subj', '/C=PT/O=Carimbo Digital/CN=Pass Type ID: de mentira'],
    { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', k, '-out', k8],
      { stdio: 'ignore' });
    const achatar = (f) => readFileSync(f, 'utf8').trim().replace(/\n/g, '\\n');
    return { certificado: achatar(c), chave: achatar(k8) };
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

/**
 * Corre um ficheiro SQL contra a base local, de uma vez só.
 *
 * Serve para o `esquema.sql` e para o `semear.sql`, que são todos
 * `IF NOT EXISTS` / `INSERT OR IGNORE` e por isso não se importam de correr
 * sempre — e que DEVEM ser atómicos: um esquema meio aplicado é pior do que
 * nenhum.
 */
function correrSQL(ficheiro) {
  try {
    execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
      '--config', './wrangler.toml', '--local', `--file=${ficheiro}`],
    { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (erro) {
    /* ISTO ENGOLIA TUDO, e o comentário que cá estava dizia que «o arranque a
       seguir dirá porquê com mais clareza». Não dizia: o que aparecia era «no
       such table: negocios», que parece um defeito do Worker e é a montagem
       da base a ter falhado em silêncio. Duas publicações seguidas morreram
       assim, e do registo do CI não se tirava a razão de nenhuma. */
    const dito = `${erro.stdout || ''}${erro.stderr || ''}`;
    throw new Error(`Não deu para aplicar ${ficheiro} à base local:\n${dito.slice(-1200)}\n`
      + 'Se for a base local a estar num estado impossível, deita-a fora:\n'
      + `  node scripts/com-worker.mjs ${process.argv[2] || 'worker/testes.mjs'} --limpo`);
  }
}

/**
 * Tira os comentários `--` de um SQL, sem tocar no que está dentro de aspas.
 *
 * Filtrar só as linhas que COMEÇAM por `--` não chegava: os ficheiros têm
 * comentários no fim de linhas de código, e um deles a levar um `;` partia a
 * instrução a meio — silenciosamente, que é o pior modo de partir. Percorre-se
 * caractere a caractere porque um `--` dentro de um literal não é comentário
 * nenhum.
 */
function semComentarios(sql) {
  let saida = '';
  let emTexto = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (emTexto) {
      saida += c;
      /* Dois apóstrofos seguidos são um apóstrofo escapado, não o fim. */
      if (c === "'" && sql[i + 1] === "'") { saida += sql[i + 1]; i += 1; }
      else if (c === "'") emTexto = false;
      continue;
    }
    if (c === "'") { emTexto = true; saida += c; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      saida += '\n';
      continue;
    }
    saida += c;
  }
  return saida;
}

/**
 * Corre uma MIGRAÇÃO, instrução a instrução.
 *
 * E é instrução a instrução por uma razão que custou um índice: o D1 corre um
 * `--file` numa TRANSACÇÃO só. Numa base acabada de nascer, o `esquema.sql` já
 * criou a coluna `convite`, por isso o `ALTER TABLE` da migração 002 dá
 * «duplicate column name» — e o que se perdia não era só essa linha, era o
 * ficheiro inteiro. O `CREATE INDEX ix_negocios_convite` que vinha a seguir
 * nunca chegou a existir na base local nem na do CI, enquanto existia na
 * produção. A base contra a qual se testa deixou de ter o formato da base a
 * sério, em silêncio, e o perdão do erro dizia que estava tudo bem.
 *
 * Cortar por `;` no fim da linha chega para estes ficheiros — são DDL, não
 * têm literais com ponto e vírgula lá dentro. Se um dia tiverem, isto tem de
 * passar a um analisador a sério, e é melhor que rebente aqui do que aplique
 * metade.
 */
function correrMigracao(ficheiro) {
  const caminho = join(WORKER, ficheiro);
  const bruto = readFileSync(caminho, 'utf8');
  const limpo = semComentarios(bruto);
  /* Um `;` dentro de um literal partia a instrução a meio. Não há nenhum
     hoje — isto é DDL — mas se um dia houver, é melhor rebentar aqui com uma
     frase do que aplicar metade de uma migração. */
  if (/'[^']*;[^']*'/.test(limpo)) {
    throw new Error(`A migração ${ficheiro} tem um ';' dentro de um literal — `
      + 'o corte por instrução deixou de servir e é preciso um analisador a sério.');
  }
  const instrucoes = limpo.split(';').map((x) => x.trim()).filter(Boolean);

  for (const instrucao of instrucoes) {
    try {
      execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
        '--config', './wrangler.toml', '--local', '--command', instrucao],
      { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (erro) {
      const dito = `${erro.stdout || ''}${erro.stderr || ''}`;
      /* O ÚNICO erro que se perdoa, e agora só perdoa a instrução que o deu:
         um `ALTER TABLE ADD COLUMN` numa base que já tem a coluna. Numa base
         nova é o esquema que a criou; numa velha é a migração já aplicada.
         Nos dois casos é sinal de bom. */
      if (/duplicate column name/i.test(dito)) continue;
      throw new Error(`A migração ${ficheiro} parou em:\n  ${instrucao.slice(0, 160)}\n${dito.slice(-800)}`);
    }
  }
}

/**
 * Confere que a base local ficou com TUDO o que o esquema e as migrações
 * mandam — tabelas e índices.
 *
 * Existe porque a montagem falhou duas vezes em silêncio, de maneiras
 * diferentes: uma transacção desfeita por um `ALTER` repetido, e um ficheiro
 * inteiro perdido por uma instrução fora de ordem. As duas deixaram a base a
 * parecer boa. Aqui lê-se o que os ficheiros PROMETEM e pergunta-se à base se
 * está lá — que é a única forma de a promessa não ser a única prova.
 */
function conferirBase() {
  const nomes = { tabelas: new Set(), indices: new Set() };
  const ficheiros = ['esquema.sql', ...listarMigracoes()];
  for (const f of ficheiros) {
    /* SEM COMENTÁRIOS. Um comentário que mencione «CREATE TABLE» — a explicar
       o que a migração faz, por exemplo — punha esta conferência a exigir uma
       tabela que nunca ninguém quis criar, e a falhar por isso. */
    const texto = semComentarios(readFileSync(join(WORKER, f), 'utf8'));
    for (const m of texto.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) nomes.tabelas.add(m[1]);
    for (const m of texto.matchAll(/CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)?\s+(\w+)/gi)) nomes.indices.add(m[1]);
  }
  const saida = execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
    '--config', './wrangler.toml', '--local', '--json', '--command',
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"],
  { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const linhas = saida.split('\n');
  const i = linhas.findIndex((l) => l.trimStart().startsWith('['));
  const existe = new Set(JSON.parse(linhas.slice(i).join('\n'))[0].results.map((r) => r.name));

  const faltam = [...nomes.tabelas, ...nomes.indices].filter((n) => !existe.has(n));
  if (faltam.length) {
    throw new Error('A base local ficou incompleta — falta o que os ficheiros prometem:\n  '
      + faltam.join(', ')
      + '\nIsto quer dizer que alguma instrução foi desfeita em silêncio.');
  }
}

const listarMigracoes = () => {
  const pasta = join(WORKER, 'migracoes');
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta).filter((n) => n.endsWith('.sql')).sort()
    .map((n) => `migracoes/${n}`);
};

function prepararBase({ limpo = false } = {}) {
  /* DEITAR A BASE FORA, para provar o que o CI prova e a máquina de quem
     desenvolve nunca provava.

     A base local sobrevive entre corridas, e por isso o esquema era sempre
     aplicado a uma base que JÁ tinha as tabelas todas — onde a ordem das
     instruções não importa nada. Numa base vazia importava: os índices do
     passe estavam onze linhas acima do `CREATE TABLE cartoes`, o ficheiro
     inteiro morria, e como o D1 corre o `--file` numa transacção só não
     ficava lá tabela nenhuma. Duas publicações seguidas morreram assim.

     Não é o comportamento por omissão de propósito: correr sempre de vazio
     deixava por provar o outro caminho, que é o das MIGRAÇÕES sobre uma base
     que já existe — e é esse o caminho da produção. Provam-se os dois. */
  if (limpo) rmSync(join(WORKER, '.wrangler'), { recursive: true, force: true });
  correrSQL('esquema.sql');
  /* A semente é `INSERT OR IGNORE`, por isso corre sempre sem estragar nada.
     Não estava aqui, e os testes locais passavam só porque a base guardava os
     restos de corridas anteriores — numa máquina limpa, o programa `p1` que
     metade deles carimba não existia. */
  correrSQL('semear.sql');
  for (const f of listarMigracoes()) correrMigracao(f);
  conferirBase();
}

export async function comWorker(tarefa, { porta = 8787, tecto = 90000, limpo = false } = {}) {
  garantirSegredos();
  prepararBase({ limpo });
  /* O `--test-scheduled` abre um `GET /__scheduled` que dispara o cron à mão.
     Sem ele, a limpeza diária — que apaga contas — só se provava esperando
     por ela, e uma regra que apaga dados de pessoas é a última que se quer
     deixar por provar. A rota só existe no `wrangler dev`, nunca em produção. */
  /* A Google de mentira levanta-se ao lado do Worker e morre com ele. Sem
     ela, todo o caminho do passe ficava por provar: criar a classe, criar o
     objecto, actualizar o saldo, e — o que mais interessa — o que acontece
     quando ela responde mal. */
  const google = spawn(process.execPath, [join(AQUI, 'google-de-mentira.mjs'), String(PORTA_GOOGLE)], {
    stdio: 'ignore', detached: true, env: { ...process.env, CALADO: 'sim' },
  });

  const processo = spawn('npx', ['--yes', 'wrangler', 'dev', '--local', '--test-scheduled', '--port', String(porta)], {
    cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let registo = '';
  processo.stdout.on('data', (d) => { registo += d; });
  processo.stderr.on('data', (d) => { registo += d; });

  const matar = () => {
    try { process.kill(-processo.pid, 'SIGKILL'); } catch { /* já morreu */ }
    try { processo.kill('SIGKILL'); } catch { /* idem */ }
    /* A Google de mentira morre com o Worker. Deixá-la viva prendia a porta
       8799 e a corrida seguinte arrancava contra um servidor velho, com o que
       a anterior lá deixou — que é o género de teste que passa hoje e falha
       amanhã sem ninguém perceber porquê. */
    try { process.kill(-google.pid, 'SIGKILL'); } catch { /* já morreu */ }
    try { google.kill('SIGKILL'); } catch { /* idem */ }
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
  const argumentos = process.argv.slice(2);
  const limpo = argumentos.includes('--limpo');
  const alvo = join(RAIZ, argumentos.find((a) => !a.startsWith('--')));
  const codigo = await comWorker(async (API) => {
    const filho = spawn(process.execPath, [alvo, API], { stdio: 'inherit', cwd: RAIZ });
    return new Promise((r) => filho.on('exit', r));
  }, { limpo });
  process.exit(codigo || 0);
}
