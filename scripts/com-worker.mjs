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
const PORTA_APPLE = 8797;

/** Garante que há segredos locais. Nunca vão para o repositório. */
export function garantirSegredos() {
  const ficheiro = join(WORKER, '.dev.vars');
  /* ACRESCENTA O QUE FALTAR, em vez de desistir se o ficheiro existe.

     Estava `if (existsSync(ficheiro)) return`, e isso era uma armadilha: numa
     máquina que já tivesse `.dev.vars` — ou seja, a de quem trabalha neste
     projecto todos os dias — uma chave NOVA nunca lá chegava. Os testes
     passavam no CI, que parte de uma máquina limpa, e falhavam em casa. */
  if (existsSync(ficheiro)) {
    let actual = readFileSync(ficheiro, 'utf8');

    /* E REPARA O QUE CADUCOU, que é o passo que faltava a este raciocínio.

       Acrescentar o que falta resolve uma chave NOVA; não resolve uma chave
       que envelheceu no sítio. O certificado da Apple tem data de validade, e
       um `.dev.vars` de duas semanas atrás tem lá um certificado morto — a
       rota do passe recusa-se a assinar com ele, devolve JSON, e a bateria
       rebenta no `unzip` a acusar seja o que for que tenha sido mexido por
       último. Perguntar a validade custa uma chamada ao openssl e poupa a
       tarde a quem for procurar o defeito no sítio errado. */
    if (caducou(actual)) {
      const novos = Object.fromEntries(certificadoParaVars());
      actual = actual.replace(/^(APPLE_CERTIFICADO|APPLE_CHAVE)=.*$/gm,
        (_, chave) => `${chave}=${novos[chave]}`);
      writeFileSync(ficheiro, actual);
      console.log('  (o certificado de mentira da Apple tinha caducado — foi emitido outro)');
    }

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
    /* A Google de ENTRAR, que é outra casa: o ecrã de consentimento vive em
       `accounts.google.com` e a troca do código em `oauth2.googleapis.com`.
       Aqui apontam as duas para o mesmo servidor de mentira. O identificador e
       o segredo do cliente são de mentira e não abrem nada — o que os torna
       úteis é existirem, porque é a presença dos dois que liga a rota. */
    ['GOOGLE_CONTAS_BASE', `http://localhost:${PORTA_GOOGLE}`],
    ['GOOGLE_ENTRAR_ID', 'de-mentira.apps.googleusercontent.com'],
    ['GOOGLE_ENTRAR_SEGREDO', 'GOCSPX-de-mentira'],
    /* As notificações. A chave é gerada aqui, na hora, e não vale nada fora
       desta máquina — o que interessa é existirem as duas metades da MESMA
       chave, porque é isso que a bateria verifica do outro lado. */
    ...chavesDePushDeMentira(),
    ['APPLE_CONTAS_BASE', `http://localhost:${PORTA_APPLE}`],
    ['APPLE_ENTRAR_SERVICO', 'pt.carimbodigital.dementira'],
    ['APPLE_ENTRAR_KID', 'KIDDEMENTIR'],
    ['APPLE_ENTRAR_CHAVE', chaveP8DeMentira()],
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
/**
 * Uma `.p8` de mentira para o «entrar com a Apple».
 *
 * É uma chave P-256 a sério, em PKCS#8, gerada aqui: o que se prova com ela é
 * que o Worker sabe montar e assinar o JWT do segredo de cliente. Que a APPLE
 * a aceitaria é outra pergunta, e essa nenhum teste responde.
 */
function chaveP8DeMentira() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).trim().replace(/\n/g, '\\n');
}

/** Um par VAPID de mentira, gerado a cada arranque. */
function chavesDePushDeMentira() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publica = publicKey.export({ type: 'spki', format: 'der' });
  /* Os últimos 65 bytes de um SPKI de P-256 são o ponto sem compressão, que é
     o formato em que a chave pública VAPID viaja. */
  return [
    ['PUSH_CHAVE', jwk.d],
    ['PUSH_PUBLICA', Buffer.from(publica.subarray(publica.length - 65)).toString('base64url')],
  ];
}

/** O par do certificado, na forma em que vai para o `.dev.vars`. */
function certificadoParaVars() {
  const apple = certificadoDeMentira();
  return [['APPLE_CERTIFICADO', apple.certificado], ['APPLE_CHAVE', apple.chave]];
}

/**
 * O certificado que está no `.dev.vars` já passou do prazo?
 *
 * Pergunta-se ao openssl, que é quem sabe. Sem certificado lá dentro a
 * resposta é «não» — o que falta é tratado pelo caminho do que falta, e não
 * por este. E qualquer atrapalhação a ler responde «não» também: um ficheiro
 * ilegível não é um certificado caducado, e deitar fora segredos bons por uma
 * leitura que correu mal é pior do que o problema.
 */
function caducou(conteudo) {
  const linha = (conteudo.match(/^APPLE_CERTIFICADO=(.*)$/m) || [])[1];
  if (!linha) return false;
  const pasta = mkdtempSync(join(tmpdir(), 'carimbo-val-'));
  try {
    const c = join(pasta, 'c.pem');
    writeFileSync(c, linha.replace(/\\n/g, '\n'));
    /* `-checkend 86400`: sai diferente de zero se caducar nas próximas 24
       horas. Um dia de folga é de propósito — um certificado que morre a meio
       de uma corrida longa é o mesmo defeito com outra hora. */
    execFileSync('openssl', ['x509', '-in', c, '-noout', '-checkend', '86400'],
      { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

function certificadoDeMentira() {
  const pasta = mkdtempSync(join(tmpdir(), 'carimbo-apple-'));
  try {
    const k = join(pasta, 'k.pem');
    const c = join(pasta, 'c.pem');
    const k8 = join(pasta, 'k8.pem');
    /* SEM PRAZO — e por dois caminhos, porque nem todo o openssl aceita o
       primeiro.
     *
     * Um X.509 tem sempre campo de validade: não há forma de o deixar em
     * branco. O que há é um valor combinado para dizer «não expira» —
     * `99991231235959Z`, que é o que a RFC 5280 §4.1.2.5 manda pôr no
     * `notAfter` de um certificado sem fim definido. É o que se tenta
     * primeiro.
     *
     * Só que o `-not_after` do `openssl req` não existe em todas as versões:
     * aqui (3.6) existe, no runner do CI não — e a publicação ficou vermelha
     * numa alteração que não lhe tocava. A alternativa é uma contagem de dias
     * tão grande que dá no mesmo século: 2 912 000 dias são os anos que faltam
     * até 9999. Tenta-se o certo, e cai-se no que funciona em todo o lado.
     *
     * Isto estava a DOIS DIAS, e ao terceiro matava a bateria da API inteira —
     * o ficheiro é gerado uma vez e fica em disco até alguém o apagar. */
    const base = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', k,
      '-out', c, '-nodes',
      '-subj', '/C=PT/O=Carimbo Digital/CN=Pass Type ID: de mentira'];
    try {
      execFileSync('openssl', [...base, '-not_after', '99991231235959Z'], { stdio: 'ignore' });
    } catch {
      execFileSync('openssl', [...base, '-days', '2912000'], { stdio: 'ignore' });
    }
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
/* `DB` É O BINDING, E NÃO O NOME DA BASE. Estava aqui o nome à mão, em cinco
   sítios, e no dia em que a base mudou de nome — para nascer com jurisdição
   `eu`, que só se define na criação — os cinco ficavam a apontar para uma base
   que já não é a desta configuração, sem dizer nada. O binding vem do
   `wrangler.toml` e sobrevive a qualquer mudança de nome. */
function correrSQL(ficheiro) {
  try {
    execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'DB',
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
 * Corta um SQL em instruções, a sério.
 *
 * Um `split(';')` chega para DDL simples e parte-se em dois casos que hão-de
 * aparecer: um `;` dentro de um literal, e o corpo de um `CREATE TRIGGER …
 * BEGIN … END`, que em SQLite leva `;` internos que não são fim de instrução.
 * Nenhum dos dois dá erro — dão meia migração aplicada, que é pior.
 *
 * Percorre-se caractere a caractere: dentro de aspas nada conta, e depois de
 * um `BEGIN` os `;` só voltam a contar a seguir ao `END` que lhe corresponde.
 */
function cortarInstrucoes(sql) {
  const fora = [];
  let actual = '';
  let emTexto = false;
  let profundidade = 0;   /* quantos BEGIN … END abertos */
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (emTexto) {
      actual += c;
      if (c === "'" && sql[i + 1] === "'") { actual += sql[i + 1]; i += 1; }
      else if (c === "'") emTexto = false;
      continue;
    }
    if (c === "'") { emTexto = true; actual += c; continue; }

    /* As palavras só contam soltas: um `BEGIN` dentro de `BEGINNING` não é
       um bloco, e um nome de coluna chamado `end_em` também não. */
    const resto = sql.slice(i);
    const palavra = /^(BEGIN|END|CASE)\b/i.exec(resto);
    const antes = i === 0 ? ' ' : sql[i - 1];
    if (palavra && !/[\w$]/.test(antes)) {
      const nome = palavra[1].toUpperCase();
      /* O `CASE … END` também fecha com `END`; conta-se para os dois se
         equilibrarem. */
      if (nome === 'BEGIN' || nome === 'CASE') profundidade += 1;
      else if (profundidade > 0) profundidade -= 1;
      actual += sql.slice(i, i + palavra[1].length);
      i += palavra[1].length - 1;
      continue;
    }

    if (c === ';' && profundidade === 0) {
      if (actual.trim()) fora.push(actual.trim());
      actual = '';
      continue;
    }
    actual += c;
  }
  if (actual.trim()) fora.push(actual.trim());
  return fora;
}

/**
 * Corre uma MIGRAÇÃO.
 *
 * TENTA O FICHEIRO INTEIRO PRIMEIRO, que é uma invocação do wrangler em vez
 * de uma por instrução — e cada invocação custa mais de um segundo de
 * arranque. Só quando o ficheiro falha é que se desce à instrução, que é o
 * caso raro e é o que interessa tratar bem.
 *
 * E é preciso descer, porque o D1 corre um `--file` numa TRANSACÇÃO só: numa
 * base acabada de nascer o `esquema.sql` já criou a coluna `convite`, o
 * `ALTER TABLE` da migração 002 dá «duplicate column name» — e o que se perdia
 * não era essa linha, era o ficheiro inteiro. O `CREATE INDEX` que vinha a
 * seguir nunca chegou a existir na base local nem na do CI, enquanto existia
 * na produção. Instrução a instrução, o perdão perdoa só a instrução que o
 * deu.
 */
function correrMigracao(ficheiro) {
  const caminho = join(WORKER, ficheiro);
  try {
    execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'DB',
      '--config', './wrangler.toml', '--local', `--file=${ficheiro}`],
    { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return;
  } catch { /* o caminho lento trata disto, e diz porquê */ }

  const instrucoes = cortarInstrucoes(semComentarios(readFileSync(caminho, 'utf8')));
  for (const instrucao of instrucoes) {
    try {
      execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'DB',
        '--config', './wrangler.toml', '--local', '--command', instrucao],
      { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (erro) {
      const dito = `${erro.stdout || ''}${erro.stderr || ''}`;
      /* O ÚNICO erro que se perdoa, e só na instrução que o deu: um
         `ALTER TABLE ADD COLUMN` numa base que já tem a coluna. Numa base nova
         é o esquema que a criou; numa velha é a migração já aplicada. Nos dois
         casos é sinal de bom. */
      if (/duplicate column name/i.test(dito)) continue;
      throw new Error(`A migração ${ficheiro} parou em:\n  ${instrucao.slice(0, 160)}\n${dito.slice(-800)}`);
    }
  }
}

/**
 * Confere que a base local ficou com TUDO o que o esquema e as migrações
 * mandam — tabelas, índices e COLUNAS.
 *
 * Existe porque a montagem falhou em silêncio de duas maneiras: uma
 * transacção desfeita por um `ALTER` repetido, e um ficheiro perdido por uma
 * instrução fora de ordem. As duas deixaram a base a parecer boa. Aqui lê-se o
 * que os ficheiros PROMETEM e pergunta-se à base se está lá — que é a única
 * forma de a promessa não ser a única prova.
 *
 * AS COLUNAS SÃO O CASO QUE FALTAVA, e é o mais provável de todos: um
 * `CREATE TABLE IF NOT EXISTS` com uma coluna nova não faz nada numa base que
 * já existe. No CI, que parte do vazio, passa sempre; na máquina de quem
 * desenvolve, que é onde o comportamento por omissão não leva `--limpo`, a
 * coluna nunca chega e o que se vê é um erro do Worker sem relação aparente.
 *
 * E o que foi LARGADO deixa de ser prometido: uma migração antiga que criou
 * um índice é história, e se uma nova o largar a conferência não pode passar
 * a exigi-lo para sempre.
 */
function conferirBase() {
  const tabelas = new Set();
  const indices = new Set();
  const colunas = new Set();   /* «tabela.coluna» */

  for (const f of ['esquema.sql', ...listarMigracoes()]) {
    /* SEM COMENTÁRIOS. Um comentário que mencione «CREATE TABLE» — a explicar
       o que a migração faz, por exemplo — punha esta conferência a exigir uma
       tabela que nunca ninguém quis criar. */
    const texto = semComentarios(readFileSync(join(WORKER, f), 'utf8'));

    for (const m of texto.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\s*\)/gi)) {
      tabelas.add(m[1]);
      /* As colunas são as linhas que começam por um nome; ignora-se o que
         começa por uma palavra-chave de restrição. */
      for (const linha of m[2].split('\n')) {
        const c = /^\s*(\w+)\s+[A-Za-z]/.exec(linha);
        if (c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c[1])) {
          colunas.add(`${m[1]}.${c[1]}`);
        }
      }
    }
    for (const m of texto.matchAll(/CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)?\s+(\w+)/gi)) indices.add(m[1]);
    for (const m of texto.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) colunas.add(`${m[1]}.${m[2]}`);

    /* O que foi largado sai das promessas. */
    for (const m of texto.matchAll(/DROP INDEX(?: IF EXISTS)?\s+(\w+)/gi)) indices.delete(m[1]);
    for (const m of texto.matchAll(/DROP TABLE(?: IF EXISTS)?\s+(\w+)/gi)) {
      tabelas.delete(m[1]);
      for (const c of [...colunas]) if (c.startsWith(`${m[1]}.`)) colunas.delete(c);
    }
    for (const m of texto.matchAll(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)/gi)) colunas.delete(`${m[1]}.${m[2]}`);
  }

  /* Uma consulta só: o `sql` do `sqlite_master` traz o `CREATE TABLE` inteiro,
     e o SQLite reescreve-o a cada `ALTER TABLE ADD COLUMN`. */
  const saida = execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'DB',
    '--config', './wrangler.toml', '--local', '--json', '--command',
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"],
  { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const linhas = saida.split('\n');
  const i = linhas.findIndex((l) => l.trimStart().startsWith('['));
  const naBase = JSON.parse(linhas.slice(i).join('\n'))[0].results;
  const nomes = new Set(naBase.map((r) => r.name));
  const sqlDaTabela = new Map(naBase.filter((r) => r.type === 'table').map((r) => [r.name, r.sql || '']));

  const faltam = [
    ...[...tabelas].filter((n) => !nomes.has(n)).map((n) => `tabela ${n}`),
    ...[...indices].filter((n) => !nomes.has(n)).map((n) => `índice ${n}`),
    ...[...colunas].filter((tc) => {
      const [t, c] = tc.split('.');
      const sql = sqlDaTabela.get(t);
      if (sql === undefined) return false;   /* a tabela em falta já foi acusada */
      return !new RegExp(`(^|[(,\\s\`"])${c}[\\s\`"]`, 'i').test(sql);
    }).map((tc) => `coluna ${tc}`),
  ];

  if (faltam.length) {
    throw new Error('A base local ficou incompleta — falta o que os ficheiros prometem:\n  '
      + faltam.join('\n  ')
      + '\nIsto quer dizer que alguma instrução foi desfeita em silêncio.'
      + '\nSe for uma coluna, é quase de certeza um `CREATE TABLE IF NOT EXISTS`'
      + '\nalterado sem a migração que lhe corresponde.');
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
  /* E a Apple, pela mesma razão: a entrada por lá tem casos maus que só se
     provam pedindo-os — um código gasto, um segredo de cliente mal montado,
     um «Cancelar». */
  const apple = spawn(process.execPath, [join(AQUI, 'apple-de-mentira.mjs'), String(PORTA_APPLE)], {
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
    try { process.kill(-apple.pid, 'SIGKILL'); } catch { /* já morreu */ }
    try { apple.kill('SIGKILL'); } catch { /* idem */ }
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
  let saida;
  try {
    saida = await tarefa(API);
  } catch (erro) {
    /* Se a tarefa rebentou, o que interessa é o que o Worker disse — um
       ECONNRESET do lado do teste é o sintoma, e a causa está no registo. */
    console.error(`\nO Worker, nos últimos instantes:\n${registo.slice(-2500)}`);
    matar();
    throw erro;
  }

  /* =======================================================================
     UM ERRO POR ATENDER NO WORKER REPROVA A CORRIDA

     A app já tinha isto: a bateria de browser afirma «nada rebentou por
     baixo», e foi ela que apanhou o defeito mais caro desta casa. O Worker
     não tinha nada parecido — e o que se perdia é precisamente a classe de
     erro que ninguém vê:

     · dentro de um `ctx.waitUntil()`, que corre DEPOIS de a resposta ter
       saído: o teste vê 200, a pessoa vê 200, e a tarefa morre sozinha;
     · num 500, que chega ao teste como `{"erro":"Erro interno"}` e mais nada
       — de propósito, que um erro interno não se conta a quem bate à porta.
       Do lado de cá isso deixava um `ReferenceError` numa rota e um erro de
       base de dados a lerem-se exactamente igual.

     Encontrou um à primeira corrida: o `espelharClassesDoNegocio` fazia
     `const [primeira] = ps` numa lista que está vazia enquanto ninguém tiver
     posto um cartão daquele negócio na Carteira — ou seja, sempre, no
     princípio. Oito erros por atender, e zero testes a falhar.

     PROCURA-SE «Uncaught», e não «error». As linhas que o próprio código
     escreve com `console.error` são deliberadas — «wallet: não deu para
     actualizar a classe» é um caminho previsto e tratado. O que nunca é
     deliberado é um erro que ninguém apanhou.
     ======================================================================= */
  const semCores = registo.replace(/\u001b\[[0-9;]*m/g, '');
  const rebentou = semCores.split('\n')
    .filter((l) => /Uncaught|UnhandledPromiseRejection/.test(l))
    .map((l) => l.replace(/^\s*[^A-Za-z]*\[ERROR\]\s*/, '').trim());
  matar();

  if (rebentou.length) {
    const unicos = [...new Set(rebentou)];
    console.error(`\n✗ O Worker atirou ${rebentou.length} erro(s) por atender:`);
    for (const l of unicos.slice(0, 8)) console.error(`  · ${l.slice(0, 180)}`);
    /* A PILHA, que é o que falta para os encontrar. O wrangler escreve-a nas
       linhas a seguir, indentadas. */
    const pilha = semCores.split('\n')
      .filter((l) => /^\s+at /.test(l)).slice(0, 6);
    for (const l of pilha) console.error(`    ${l.trim().slice(0, 180)}`);
    console.error('\n  Um erro por atender num `waitUntil` não falha pedido nenhum '
      + 'e não aparece\n  em teste nenhum — é por isso que reprova aqui.\n');
    return 1;
  }
  return saida;
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
