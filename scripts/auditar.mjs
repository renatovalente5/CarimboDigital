#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — auditoria do que se vai publicar

   Corre depois de gerar e antes de publicar. Se falhar, não se publica: fica
   no ar a versão anterior, que é sempre melhor do que uma versão nova
   partida.

   Não conta ficheiros — segue ligações. Contar ficheiros diz que há vinte
   páginas; seguir ligações diz que três delas apontam para o vazio.
   ========================================================================= */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const SAIDA = join(RAIZ, '_site');
const config = JSON.parse(readFileSync(join(RAIZ, '_fonte', 'config.json'), 'utf8'));
const BASE = existsSync(join(RAIZ, 'CNAME')) ? '' : '/CarimboDigital';

let erros = 0, avisos = 0;
const falhar = (m) => { console.error(`  ✗ ${m}`); erros++; };
const avisar = (m) => { console.warn(`  ! ${m}`); avisos++; };
const bem = (m) => console.log(`  ✓ ${m}`);

function listar(pasta) {
  const saida = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...listar(caminho));
    else saida.push(caminho);
  }
  return saida;
}

if (!existsSync(SAIDA)) {
  console.error('Não há _site/. Corre primeiro `node scripts/gerar.mjs`.');
  process.exit(1);
}

const ficheiros = listar(SAIDA);
const paginas = ficheiros.filter((f) => f.endsWith('.html'));
const relativos = new Set(ficheiros.map((f) => '/' + f.slice(SAIDA.length + 1)));

console.log(`\nAuditoria de ${paginas.length} páginas e ${ficheiros.length} ficheiros.\n`);

/* --- 1. marcadores por preencher ---------------------------------------- */
console.log('Marcadores');
{
  let sujos = 0;
  for (const f of ficheiros) {
    if (!['.html', '.css', '.js', '.json', '.webmanifest', '.xml', '.txt'].includes(extname(f))) continue;
    const texto = readFileSync(f, 'utf8');
    const m = texto.match(/\{\{[A-Z_]+\}\}/g);
    if (m) { falhar(`${f.slice(SAIDA.length + 1)}: ${[...new Set(m)].join(', ')}`); sujos++; }
  }
  if (!sujos) bem('nenhum {{MARCADOR}} ficou por substituir');
}

/* --- 2. ligações internas ----------------------------------------------- */
/* O que interessa não é quantas páginas existem, é se as ligações levam a
   algum lado. Um sítio com trinta páginas e cinco ligações mortas está pior
   do que um com dez e nenhuma. */
console.log('\nLigações');
{
  /* COMENTÁRIOS E SCRIPTS FORA, antes de procurar ligações.

     Esta busca é um `matchAll` sobre o ficheiro inteiro, e apanhava duas
     coisas que não são ligações: um destino escrito dentro de um comentário —
     um comentário que EXPLIQUE uma ligação passa a reprovar a publicação — e
     um destino montado dentro de um `<script>`, que não é um endereço, é
     código. As duas aconteceram no mesmo dia.

     Deitar fora um destino comentado é o que se quer: um endereço dentro de um
     comentário não leva ninguém a lado nenhum, e portanto não pode estar
     morto. */
  const semComentariosNemScripts = (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  let mortas = 0, total = 0;
  for (const pagina of paginas) {
    const texto = semComentariosNemScripts(readFileSync(pagina, 'utf8'));
    const daPagina = '/' + dirname(pagina.slice(SAIDA.length + 1));
    for (const m of texto.matchAll(/(?:href|src)="([^"]+)"/g)) {
      let alvo = m[1];
      if (/^(https?:|mailto:|tel:|data:|#|javascript:)/.test(alvo)) continue;
      total++;
      alvo = alvo.split('#')[0].split('?')[0];
      if (!alvo) continue;
      let caminho = alvo.startsWith('/')
        ? alvo
        : resolve(daPagina === '/.' ? '/' : daPagina, alvo);
      if (BASE && caminho.startsWith(BASE)) caminho = caminho.slice(BASE.length) || '/';
      const candidatos = [caminho, caminho.replace(/\/$/, '') + '/index.html',
                          caminho + '/index.html'];
      if (!candidatos.some((c) => relativos.has(c))) {
        falhar(`${pagina.slice(SAIDA.length + 1)} → ${m[1]}`);
        mortas++;
      }
    }
  }
  if (!mortas) bem(`${total} ligações internas, todas resolvem`);
}

/* --- 3. o prefixo dos caminhos ------------------------------------------ */
/* Sem domínio próprio o site vive em /CarimboDigital/. Uma ligação que comece por
   "/estilos/" funciona em casa e parte no GitHub Pages — e só se dá por isso
   depois de publicar. */
console.log('\nPrefixo');
if (BASE) {
  let nus = 0;
  for (const pagina of paginas) {
    const texto = readFileSync(pagina, 'utf8');
    for (const m of texto.matchAll(/(?:href|src)="(\/(?!\/)[^"]*)"/g)) {
      if (!m[1].startsWith(BASE + '/') && m[1] !== BASE) {
        falhar(`${pagina.slice(SAIDA.length + 1)}: ${m[1]} não leva o prefixo ${BASE}`);
        nus++;
      }
    }
  }
  if (!nus) bem(`todos os caminhos absolutos começam por ${BASE}`);
} else {
  /* Com domínio próprio a pergunta inverte-se, e tem de continuar a haver
     uma. Este ramo limitava-se a imprimir um ✓ — uma verificação que passa a
     ser sempre verdadeira é pior do que não existir, porque ocupa o lugar de
     uma que verificaria. O que se procura agora é o contrário: um caminho
     que ainda leve o prefixo antigo dá 404 no domínio novo. */
  let velhos = 0;
  for (const ficheiro of ficheiros) {
    if (!['.html', '.js', '.json', '.css', '.webmanifest', '.xml', '.txt'].includes(extname(ficheiro))) continue;
    const texto = readFileSync(ficheiro, 'utf8');
    for (const m of texto.matchAll(/["'(]\/CarimboDigital\//g)) {
      falhar(`${ficheiro.slice(SAIDA.length + 1)}: ainda leva o prefixo /CarimboDigital/`);
      velhos++;
      break;
    }
  }
  if (!velhos) bem('com domínio próprio, e nenhum caminho ficou com o prefixo antigo');
}

/* --- 4. cabeça das páginas ---------------------------------------------- */
console.log('\nCabeçalhos');
{
  let mal = 0;
  for (const pagina of paginas) {
    if (pagina.endsWith('404.html')) continue;
    const texto = readFileSync(pagina, 'utf8');
    const nome = pagina.slice(SAIDA.length + 1);
    if (!/<title>[^<]{8,}<\/title>/.test(texto)) { falhar(`${nome}: título em falta ou curto de mais`); mal++; }
    if (!/<meta name="description" content="[^"]{40,}"/.test(texto)
        && !texto.includes('name="robots" content="noindex"')) {
      falhar(`${nome}: descrição em falta ou curta de mais`); mal++;
    }
    /* Procura-se o atributo, não a linha inteira: uma página com outro
       atributo no `<html>` — o cartaz declara `data-tema` — continua a estar
       em português, e a guarda dizia que não. */
    if (!/<html[^>]*\blang="pt-PT"/.test(texto)) { falhar(`${nome}: falta lang="pt-PT"`); mal++; }
  }
  if (!mal) bem('título, descrição e idioma em todas as páginas');
}

/* --- 5. ícones e manifesto ---------------------------------------------- */
console.log('\nManifestos');
{
  let mal = 0;
  for (const app of ['app', 'balcao']) {
    const caminho = join(SAIDA, app, 'manifest.webmanifest');
    if (!existsSync(caminho)) { falhar(`${app}: manifesto em falta`); mal++; continue; }
    const m = JSON.parse(readFileSync(caminho, 'utf8'));
    for (const ic of m.icons || []) {
      let p = ic.src;
      if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
      if (!relativos.has(p)) { falhar(`${app}: o ícone ${ic.src} não existe`); mal++; }
    }
    if (!m.start_url?.startsWith(BASE + '/' + app)) {
      falhar(`${app}: start_url fora do âmbito (${m.start_url})`); mal++;
    }
    if (!existsSync(join(SAIDA, app, 'sw.js'))) { falhar(`${app}: service worker em falta`); mal++; }

    /* Existirem não chega: têm de ser os três tamanhos certos. O balcão foi
       publicado sem `maskable` e o Android recorta o quadrado de canto
       redondo dentro de um círculo — sai um ícone pequeno com moldura
       branca, e ninguém repara enquanto não instalar. */
    const tem = (f) => (m.icons || []).some(f);
    if (!tem((i) => i.sizes === '192x192')) { falhar(`${app}: falta o ícone de 192`); mal++; }
    if (!tem((i) => i.sizes === '512x512' && !/maskable/.test(i.purpose || ''))) {
      falhar(`${app}: falta o ícone de 512`); mal++;
    }
    if (!tem((i) => /maskable/.test(i.purpose || ''))) {
      falhar(`${app}: falta o ícone maskable, que é o que o Android usa`); mal++;
    }
  }

  /* As duas apps instalam-se no mesmo telemóvel: quem tem um café também
     junta carimbos noutros sítios. Se partilharem ícone, ficam dois quadrados
     iguais no ecrã inicial e a pessoa abre a errada. */
  const iconesIOS = ['app', 'balcao'].map((app) => {
    const html = readFileSync(join(SAIDA, app, 'index.html'), 'utf8');
    return (html.match(/rel="apple-touch-icon" href="([^"]+)"/) || [])[1];
  });
  if (iconesIOS[0] && iconesIOS[0] === iconesIOS[1]) {
    falhar('as duas apps partilham o ícone do iOS — no ecrã inicial ficam iguais');
    mal++;
  }

  if (!mal) bem('manifestos, ícones e service workers no sítio, e as duas apps distinguem-se');
}

/* --- 6. o casco do service worker existe mesmo -------------------------- */
console.log('\nService workers');
{
  let mal = 0;
  for (const app of ['app', 'balcao']) {
    const sw = readFileSync(join(SAIDA, app, 'sw.js'), 'utf8');
    for (const m of sw.matchAll(/"(\/[^"]+)"/g)) {
      let p = m[1].split('?')[0];
      if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
      const candidatos = [p, p.replace(/\/$/, '') + '/index.html'];
      if (!candidatos.some((c) => relativos.has(c))) {
        falhar(`${app}/sw.js quer guardar ${m[1]}, que não existe`); mal++;
      }
    }
  }
  if (!mal) bem('o casco guardado offline aponta só para ficheiros que existem');
}

/* --- 7. dados legais ---------------------------------------------------- */
/* Sem isto já aconteceu: o backoffice apagou a morada, o CI publicou na
   mesma, e o site ficou meses sem os dados que a lei obriga. */
console.log('\nDados legais');
{
  /* A `forma` jurídica é opcional de propósito: uma pessoa singular não tem
     nenhuma, e exigi-la só levava a que alguém inventasse uma. As chaves que
     começam por `_` são comentários no JSON, não campos. */
  const OPCIONAIS = new Set(['forma']);
  const emFalta = [];
  for (const [chave, valor] of Object.entries(config.entidade || {})) {
    if (chave.startsWith('_') || OPCIONAIS.has(chave)) continue;
    if (!String(valor || '').trim()) emFalta.push(chave);
  }
  const paginasLegais = paginas.filter((p) => /privacidade|termos/.test(p));
  if (!paginasLegais.length) falhar('não há páginas de privacidade nem de termos');

  if (config.producao) {
    if (emFalta.length) falhar(`producao: true mas falta a entidade: ${emFalta.join(', ')}`);
    for (const p of paginasLegais) {
      if (readFileSync(p, 'utf8').includes('POR PREENCHER')) {
        falhar(`${p.slice(SAIDA.length + 1)}: ainda tem POR PREENCHER`);
      }
    }
    if (!emFalta.length) bem('entidade responsável preenchida');
  } else if (emFalta.length) {
    avisar(`entidade por preencher (${emFalta.join(', ')}) — obrigatório antes de `
      + 'pôr producao: true no config.json');
  }
}

/* --- 8. segredos ---------------------------------------------------------*/
/* O repositório é público. Uma chave que escape aqui escapa para sempre. */
console.log('\nSegredos');
{
  const suspeitos = [
    [/re_[A-Za-z0-9_]{20,}/, 'chave da Resend'],
    [/sk_live_[A-Za-z0-9]{20,}/, 'chave secreta de pagamentos'],
    [/AIza[0-9A-Za-z_-]{30,}/, 'chave da Google'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'chave privada'],
    /* A CHAVE SEM CABEÇALHOS. Foi exactamente por aqui que ela escapou uma vez:
       um PEM achatado — base64 puro, sem BEGIN/END — é a forma que cabe numa
       variável de ambiente, e uma busca que só conhece cabeçalhos não vê nada.

       Os padrões abaixo foram MEDIDOS, não adivinhados: escrevi-os à mão duas
       vezes com o `AgEA` que parecia óbvio e não apanhavam nada, porque o
       base64 desalinha o `02 01 00` conforme o comprimento que vem antes. O
       que é estável é a cabeça inteira de cada formato, e é isso que aqui
       está — conferido contra as quatro chaves desta casa e contra chaves
       PKCS#1 e EC geradas de propósito, e conferido ao contrário contra os
       certificados, que não podem dar positivo. */
    [/IBADANBgkqhkiG9w0BAQ[A-Za-z0-9+/]{10,}/, 'chave privada RSA (PKCS#8) em base64, sem cabeçalhos'],
    [/MII[A-Za-z0-9+/]{1,3}AIBAAKCA[A-Za-z0-9+/]{20,}/, 'chave privada RSA (PKCS#1) em base64, sem cabeçalhos'],
    [/MHcCAQEEI[A-Za-z0-9+/]{20,}/, 'chave privada EC em base64, sem cabeçalhos'],
  ];
  let achados = 0;
  /* TODOS OS FICHEIROS DE TEXTO, e não cinco extensões escolhidas a dedo. Um
     `.svg`, um `.webmanifest`, um `.xml` ou um `.map` levam texto na mesma, e
     a lista antiga deixava-os passar sem ninguém os olhar. O que se salta são
     os binários, que é onde uma busca por texto não faria sentido. */
  const BINARIOS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.ico', '.woff', '.woff2', '.pdf', '.zip'];
  for (const f of ficheiros) {
    if (BINARIOS.includes(extname(f).toLowerCase())) continue;
    let texto;
    try { texto = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [padrao, nome] of suspeitos) {
      if (padrao.test(texto)) { falhar(`${f.slice(SAIDA.length + 1)}: parece ter uma ${nome}`); achados++; }
    }
  }
  if (!achados) bem('nada que se pareça com um segredo no que vai para o ar');
}

/* --- 9. sitemap --------------------------------------------------------- */
console.log('\nSitemap');
{
  const mapa = readFileSync(join(SAIDA, 'sitemap.xml'), 'utf8');
  const rotas = [...mapa.matchAll(/<loc>https:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1]);
  let mal = 0;
  for (const r of rotas) {
    const p = (r === '/' ? '/index.html' : r.replace(/\/$/, '') + '/index.html');
    if (!relativos.has(p)) { falhar(`o sitemap anuncia ${r}, que não existe`); mal++; }
  }
  const publicas = paginas.filter((p) => !/\/(app|balcao)\//.test(p) && !p.endsWith('404.html'));
  if (rotas.length !== publicas.length) {
    avisar(`o sitemap tem ${rotas.length} rotas e há ${publicas.length} páginas públicas`);
  }
  if (!mal) bem(`${rotas.length} rotas no sitemap, todas existem`);
}

/* --- 10. as apps não são indexáveis ------------------------------------- */
console.log('\nIndexação');
{
  let mal = 0;
  for (const app of ['app', 'balcao']) {
    const html = readFileSync(join(SAIDA, app, 'index.html'), 'utf8');
    if (!html.includes('name="robots" content="noindex"')) {
      falhar(`${app}: devia ter noindex — é uma aplicação, não uma página`); mal++;
    }
  }
  /* O CARTAZ TAMBÉM. É uma página de impressão, com o QR de um negócio lá
     dentro; indexá-la é pôr o cartaz de um café a competir com o site. */
  const cartaz = readFileSync(join(SAIDA, 'balcao', 'cartaz.html'), 'utf8');
  if (!cartaz.includes('name="robots" content="noindex"')) {
    falhar('balcao/cartaz.html: devia ter noindex — é uma folha de impressão'); mal++;
  }

  /* E A GUARDA INVERTEU-SE. Ela EXIGIA `Disallow: /app/`, e estava a tornar
     obrigatória uma contradição: uma página proibida de ser lida nunca chega
     a mostrar o `noindex` que lá tem, e pode entrar no índice nua, sem título
     — que é pior do que não aparecer. Ver o comentário no `gerar.mjs`.
 
     Fica aqui a reprovar o regresso, porque a intenção de voltar a pôr um
     `Disallow` é boa e é o que qualquer pessoa faria a olhar para isto. */
  const robots = readFileSync(join(SAIDA, 'robots.txt'), 'utf8');
  for (const caminho of ['/app/', '/balcao/']) {
    if (robots.includes(`Disallow: ${caminho}`)) {
      falhar(`robots.txt proíbe ${caminho} — e isso IMPEDE o Google de ler o `
        + `noindex que lá está. Quem não pode ser lido não pode ser excluído: `
        + `o endereço entra no índice sem título nem descrição. O noindex faz `
        + `o trabalho todo sozinho.`);
      mal++;
    }
  }
  if (!mal) bem('as duas aplicações e o cartaz estão fora dos motores de busca, pelo noindex');
}

/* --- 11. o domínio ------------------------------------------------------

   O prefixo dos caminhos sai da existência de um ficheiro CNAME na raiz do
   repositório. É um mecanismo bom e tem um ponto cego: se o CNAME existir
   em disco mas não chegar ao que se publica, o site sai construído para a
   raiz e o GitHub desliga o domínio próprio — ou, ao contrário, fica
   construído com prefixo e servido na raiz. Nos dois casos o site está no
   ar e partido, e nada reprova.

   Aqui liga-se o ficheiro ao que o config diz, e o config ao que o Worker
   aceita: três sítios que têm de concordar sobre o mesmo nome.
   ---------------------------------------------------------------------- */
console.log('\nDomínio');
{
  const cname = join(RAIZ, 'CNAME');
  let mal = 0;
  if (existsSync(cname)) {
    const dito = readFileSync(cname, 'utf8').trim();
    if (dito !== config.dominio) {
      falhar(`o CNAME diz «${dito}» e o config diz «${config.dominio}»`); mal++;
    }
    if (!existsSync(join(SAIDA, 'CNAME'))) {
      falhar('o CNAME não foi para o _site — o GitHub desliga o domínio próprio'); mal++;
    } else if (readFileSync(join(SAIDA, 'CNAME'), 'utf8').trim() !== dito) {
      falhar('o CNAME do _site não é o mesmo da raiz'); mal++;
    }

    /* A app fala com o Worker de outra origem, por isso o Worker tem de a
       conhecer pelo nome. Nada ligava as duas coisas: o domínio podia mudar
       e a lista ficar para trás, e o sintoma seria «Sem ligação ao servidor»
       — que manda toda a gente procurar a rede em vez da causa. */
    const toml = readFileSync(join(RAIZ, 'worker', 'wrangler.toml'), 'utf8');
    const linha = (toml.match(/^ORIGENS\s*=\s*"([^"]*)"/m) || [])[1] || '';
    const origens = linha.split(',').map((x) => x.trim());
    for (const esperada of [`https://${dito}`, `https://www.${dito}`]) {
      if (!origens.includes(esperada)) {
        falhar(`o Worker não aceita a origem ${esperada} (ver worker/wrangler.toml)`); mal++;
      }
    }
  }
  if (!mal) {
    bem(existsSync(cname)
      ? `domínio ${config.dominio}: CNAME, config e origens do Worker de acordo`
      : 'sem domínio próprio — o site vive debaixo do prefixo');
  }
}

/* --- 12. o JavaScript que se publica ao menos analisa ------------------
   Um erro de sintaxe num módulo não parte a construção: o gerador copia
   ficheiros, não os lê. Parte a aplicação no browser, em silêncio, e
   descobre-se quando alguém a abre. Custa milissegundos verificar aqui.
   ---------------------------------------------------------------------- */
console.log('\nJavaScript');
{
  const modulos = ficheiros.filter((f) => extname(f) === '.js');
  let mal = 0;
  for (const f of modulos) {
    /* `import` com caminho relativo não resolve fora do sítio; o que se
       quer saber é só se o ficheiro ANALISA. Comentam-se os imports e
       verifica-se o resto. */
    const fonte = readFileSync(f, 'utf8');
    const tmp = join(tmpdir(), `carimbo-sintaxe-${basename(f)}.mjs`);
    writeFileSync(tmp, fonte);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (erro) {
      const razao = String(erro.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' · ');
      falhar(`${f.slice(SAIDA.length + 1)}: não analisa — ${razao}`);
      mal++;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (!mal) bem(`${modulos.length} módulos de JavaScript analisam`);
}

/* --- 13. dados estruturados --------------------------------------------
   Um JSON-LD com um erro de sintaxe é ignorado em silêncio pelo motor de
   busca: não há aviso, não há erro, simplesmente não conta. E um que
   publique dados pessoais a mais não se desfaz — fica em caches que não
   controlamos.
   ---------------------------------------------------------------------- */
console.log('\nDados estruturados');
{
  let mal = 0, achados = 0;
  for (const pagina of paginas) {
    const html = readFileSync(pagina, 'utf8');
    const nome = pagina.slice(SAIDA.length + 1);
    const bloco = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!bloco) {
      if (!/name="robots" content="noindex"/.test(html)) {
        falhar(`${nome}: sem dados estruturados`); mal++;
      }
      continue;
    }
    achados++;
    let dados;
    try { dados = JSON.parse(bloco[1]); }
    catch (e) { falhar(`${nome}: o JSON-LD não analisa — ${e.message}`); mal++; continue; }
    if (dados['@context'] !== 'https://schema.org') {
      falhar(`${nome}: o @context do JSON-LD não é o do schema.org`); mal++;
    }
    /* O NIF e a morada de casa ficam nas páginas legais, em texto. Aqui
       seriam dados de um particular entregues em formato de máquina. */
    const cru = JSON.stringify(dados);
    if (config.entidade?.nif && cru.includes(config.entidade.nif)) {
      falhar(`${nome}: o NIF está nos dados estruturados`); mal++;
    }
    if (config.entidade?.morada && cru.includes(config.entidade.morada)) {
      falhar(`${nome}: a morada está nos dados estruturados`); mal++;
    }
  }
  if (!mal) bem(`${achados} páginas com dados estruturados, todas analisam`);
}

/* --- 14. contraste da paleta -------------------------------------------
   Isto está aqui porque a paleta original tinha oito pares que não passavam
   e nenhum deles se via a olho: a legenda cinzenta parecia «cinzenta o
   suficiente». Passar o olho não mede nada — 3,0 e 4,6 são
   indistinguíveis à vista e um deles é ilegal. O que se mede, mede-se
   sempre; e o que se mede sempre não volta a partir-se sem ninguém notar.
   ---------------------------------------------------------------------- */
console.log('\nContraste');
{
  const css = readFileSync(join(RAIZ, '_fonte', 'estilos', 'nucleo.css'), 'utf8');

  /* Lê as variáveis de um bloco de tema. O modo claro é o `:root {` do
     princípio; o escuro é o bloco da escolha explícita, que repete o do
     `prefers-color-scheme` — se algum dia se separarem, a auditoria só vê
     um e é preciso vir aqui. */
  const bloco = (de, ate) => {
    const i = css.indexOf(de);
    const corpo = css.slice(i, css.indexOf(ate, i));
    const vars = {};
    for (const m of corpo.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) vars[m[1]] = m[2];
    return vars;
  };
  const escuroAuto = bloco(':root:not([data-tema="claro"])', '\n  }');
  const escuroEscolhido = bloco(':root[data-tema="escuro"]', '\n}');
  const TEMAS = {
    claro: bloco(':root {', '@media (prefers-color-scheme: dark)'),
    escuro: escuroEscolhido,
  };

  /* O modo escuro está escrito duas vezes — uma para quem o pede ao sistema,
     outra para quem o escolhe no botão — e as duas têm de dizer o mesmo. Se
     se separarem, metade das pessoas fica com a paleta velha e a auditoria
     acima só olha para uma delas. */
  for (const chave of new Set([...Object.keys(escuroAuto), ...Object.keys(escuroEscolhido)])) {
    if (escuroAuto[chave] !== escuroEscolhido[chave]) {
      falhar(`escuro: --${chave} é ${escuroAuto[chave] || 'nada'} para o sistema`
        + ` e ${escuroEscolhido[chave] || 'nada'} para quem o escolhe`);
    }
  }

  const luz = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const razao = (a, b) => {
    const [x, y] = [luz(a), luz(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /* Texto pequeno pede 4,5. Contornos de controlo e ícones pedem 3. */
  const PAPEIS = ['papel', 'papel-2', 'papel-3'];
  const PARES = [
    ...['tinta', 'tinta-2', 'tinta-3', 'marca', 'bom', 'atencao', 'mau']
      .flatMap((t) => PAPEIS.map((f) => [t, f, 4.5])),
    ['bom', 'bom-fundo', 4.5],
    ['atencao', 'atencao-fundo', 4.5],
    ['mau', 'mau-fundo', 4.5],
    ['marca', 'marca-fundo', 4.5],
    ['tinta', 'marca-fundo', 4.5],
    ['marca-texto', 'marca', 4.5],
    /* O contorno do campo é o que identifica o campo: 1.4.11, 3:1. */
    ...PAPEIS.filter((f) => f !== 'papel-3').map((f) => ['linha-campo', f, 3]),
  ];

  let mal = 0;
  let contados = 0;
  for (const [tema, v] of Object.entries(TEMAS)) {
    for (const [frente, fundo, minimo] of PARES) {
      if (!v[frente] || !v[fundo]) {
        falhar(`${tema}: --${frente} ou --${fundo} não é uma cor sólida no CSS`);
        mal++; continue;
      }
      const r = razao(v[frente], v[fundo]);
      contados++;
      if (r < minimo) {
        falhar(`${tema}: --${frente} sobre --${fundo} dá ${r.toFixed(2)}`
          + `, precisa de ${minimo}`);
        mal++;
      }
    }
  }
  /* As páginas do site pintam cartões de exemplo com a cor e a tinta
     escritas à mão no HTML — o site não corre JavaScript, por isso não pode
     chamar o marcaSegura(). Uma delas já estava errada: branco sobre um azul
     claro, a 3,56:1, na página inicial. Mede-se cada par. */
  let manuais = 0;
  for (const f of paginas) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/--m:\s*(#[0-9A-Fa-f]{6})\s*;\s*--m-txt:\s*(#[0-9A-Fa-f]{6})/g)) {
      manuais++;
      const r = razao(m[2], m[1]);
      if (r < 4.5) {
        falhar(`${f.slice(SAIDA.length + 1)}: a tinta ${m[2]} sobre ${m[1]} dá ${r.toFixed(2)}`);
        mal++;
      }
    }
  }

  if (!mal) bem(`${contados} pares de cores medidos e ${manuais} escritos à mão, todos passam`);
}

/* =========================================================================
   Cada `api.alguma coisa()` existe mesmo

   Renomeei o `concluirGoogle` para `concluirEntrada` quando a Apple entrou, e
   duas chamadas ficaram para tras com o nome velho. O JavaScript nao se queixa
   de chamar uma coisa que nao existe — atira quando la chega, e o `catch` que
   estava a volta transformava isso numa frase educada: «Nao deu para concluir
   a entrada.» O caminho da volta do OAuth ficou morto e com ar de vivo.

   Nao e analise a serio: e um grep dos dois lados a bater um no outro. Mas
   apanha exactamente esta classe de erro, que e a que nao da sinal nenhum.
   ========================================================================= */
{
  console.log('\nAs chamadas a API existem');
  const api = readFileSync(join(RAIZ, '_fonte', 'js', 'api.js'), 'utf8');
  const quemChama = [
    ['app/app.js', join(RAIZ, '_fonte', 'app', 'app.js')],
    ['balcao/balcao.js', join(RAIZ, '_fonte', 'balcao', 'balcao.js')],
  ].filter(([, f]) => existsSync(f));

  /* Um nome conta como definido se aparecer como chave de objecto (`nome:`) ou
     como metodo (`nome(`) — que sao as duas formas que o api.js usa, uma para
     o remoto e outra para a demonstracao. */
  const definido = (nome) =>
    new RegExp(`(^|[^A-Za-z0-9_$.])(async\\s+)?${nome}\\s*[:(]`, 'm').test(api);

  let chamadas = 0, mal = 0;
  for (const [nome, ficheiro] of quemChama) {
    const texto = readFileSync(ficheiro, 'utf8');
    const vistos = new Set();
    for (const m of texto.matchAll(/\bapi\.([A-Za-z0-9_$]+)\s*\(/g)) vistos.add(m[1]);
    for (const chamado of vistos) {
      chamadas++;
      if (!definido(chamado)) { falhar(`${nome}: chama api.${chamado}(), que nao existe no api.js`); mal++; }
    }
  }
  if (!mal) bem(`${chamadas} chamadas a API, todas com quem as atenda`);
}

/* =========================================================================
   O balcao sabe explicar tudo o que o carimbar recusa

   O carimbar devolve um `codigo` por cada maneira de correr mal, e o balcao
   tem uma tabela que o transforma numa frase que se le em voz alta ao
   cliente. O que nao estiver na tabela cai num «Nao deu» generico com a
   mensagem crua por baixo.

   Foi o que aconteceu ao `demonstracao`: durante meses, um codigo de
   demonstracao apresentava-se ao balcao como «este codigo e de outra coisa
   qualquer» — uma frase que manda procurar o defeito na camara, no leitor e
   no cartao, quando o que estava errado era a app do outro lado.

   Le-se o corpo das DUAS implementacoes do carimbar — a do Worker e o espelho
   da demonstracao — porque as regras sao as mesmas e os codigos tambem tem de
   ser. Um codigo que so exista de um dos lados ja e, por si, um defeito.
   ========================================================================= */
{
  console.log('\nO balcão explica tudo o que recusa');

  /* O corpo de uma funcao, do cabecalho ate a chaveta que fecha na coluna que
     a abriu. Chega para isto: os dois carimbar sao funcoes de topo do seu
     nivel, e o que se procura sao literais. */
  const corpoDe = (texto, cabecalho, fecho) => {
    const i = texto.indexOf(cabecalho);
    if (i < 0) return null;
    const j = texto.indexOf(fecho, i);
    return j < 0 ? null : texto.slice(i, j);
  };

  const worker = readFileSync(join(RAIZ, 'worker', 'src', 'index.js'), 'utf8');
  const api = readFileSync(join(RAIZ, '_fonte', 'js', 'api.js'), 'utf8');
  const balcao = readFileSync(join(RAIZ, '_fonte', 'balcao', 'balcao.js'), 'utf8');

  const noWorker = corpoDe(worker, 'async function carimbar(env, pedido, operador) {', '\n}\n');
  const naDemo = corpoDe(api, 'async carimbar({', '\n    },\n');
  const tabela = corpoDe(balcao, 'function mostrarErro(e) {', '\n  };');

  if (!noWorker || !naDemo || !tabela) {
    falhar('não encontrei um dos três sítios (carimbar do Worker, carimbar da demonstração, tabela do balcão) — '
      + 'algum deles mudou de forma, e esta guarda deixou de estar a olhar para o que julga');
  } else {
    const codigos = new Set([
      ...[...noWorker.matchAll(/codigo: '([a-z0-9-]+)'/g)].map((m) => m[1]),
      ...[...naDemo.matchAll(/err\.codigo = '([a-z0-9-]+)'/g)].map((m) => m[1]),
    ]);
    /* A tabela escreve as chaves das duas maneiras que o JavaScript permite:
       `arrefecimento:` e `'sem-cartao':`. */
    const explicados = new Set([
      ...[...tabela.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map((m) => m[1]),
      ...[...tabela.matchAll(/^\s*([a-z][a-z0-9]*):/gm)].map((m) => m[1]),
    ]);
    const orfaos = [...codigos].filter((c) => !explicados.has(c)).sort();
    if (orfaos.length) {
      falhar('o balcão não tem frase para: ' + orfaos.join(', ')
        + ' — cai no «Não deu» genérico, e quem está ao balcão fica sem saber o que fazer');
    } else {
      bem(`${codigos.size} maneiras de o carimbar recusar, todas com uma frase escrita para o balcão`);
    }
  }
}

/* =========================================================================
   Uma ligação para fora do âmbito da PWA abre-se à parte

   As duas apps declaram `scope` no manifesto — `/app/` e `/balcao/` — e as
   páginas legais vivem na raiz, fora dos dois. Numa app posta no ecrã
   principal, tocar num link para fora do âmbito leva a pessoa para o browser
   e deixa a app para trás: no balcão, isso é o turno interrompido a meio de
   um carimbo. Com `target="_blank"` fica uma folha por cima, com um botão que
   a devolve ao sítio onde estava.

   Isto esteve a faltar em três ligações ao mesmo tempo, e não havia nada que
   o dissesse: a página abria, a pessoa lia, e o que se perdia — voltar — só
   se nota num telemóvel com a app instalada, que é onde ninguém testa.

   A guarda lê o `scope` de cada manifesto A SÉRIO em vez de o assumir: se um
   dia o âmbito crescer e abraçar as páginas legais, ela deixa de pedir o
   `_blank` sozinha, em vez de ficar a exigir uma coisa que passou a estorvar.
   ========================================================================= */
/**
 * Todas as âncoras de um ficheiro, nas duas formas que esta casa usa: escritas
 * em HTML (`<a href=…>`) e construídas em JavaScript (`el('a', { href: … })`).
 *
 * A segunda forma obriga a contar chavetas em vez de a apanhar com uma
 * expressão regular: os valores levam literais com `${base()}` lá dentro, e um
 * `[^}]*` parava na primeira chaveta do interpolador. Contar chavetas — com o
 * `${` a contar como abertura — é curto e não tem casos especiais.
 */
function ancoras(texto) {
  const fora = [...texto.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  for (const m of texto.matchAll(/el\(\s*'a'\s*,\s*\{/g)) {
    let i = m.index + m[0].length - 1, fundo = 0;
    for (; i < texto.length; i++) {
      const c = texto[i];
      if (c === '{') fundo++;
      else if (c === '}' && --fundo === 0) break;
    }
    fora.push(texto.slice(m.index, i + 1));
  }
  return fora;
}

{
  console.log('\nAs ligações que saem da app abrem-se à parte');

  let vistas = 0;
  const falhas = [];
  for (const manifesto of ficheiros.filter((f) => f.endsWith('.webmanifest'))) {
    let ambito;
    try { ambito = JSON.parse(readFileSync(manifesto, 'utf8')).scope; } catch { continue; }
    if (!ambito) continue;
    /* As páginas e o JavaScript daquela app — é onde as ligações nascem. */
    const pasta = dirname(manifesto);
    for (const f of ficheiros.filter((x) => x.startsWith(pasta + '/')
                                         && (x.endsWith('.html') || x.endsWith('.js')))) {
      const texto = readFileSync(f, 'utf8');
      /* Só `<a href>` com um caminho absoluto da nossa casa. Endereços de
         outro domínio são assunto da guarda seguinte, e os relativos ficam
         sempre dentro da pasta da app. */
      /* A ETIQUETA INTEIRA, e não até ao `href`. A primeira versão desta
         guarda parava no valor do href — e o `target` vem quase sempre DEPOIS
         dele, por isso a guarda acusava de falta de `_blank` exactamente as
         ligações que o tinham. Acusou três, e as três estavam certas: uma
         guarda que dá falsos positivos ensina a ignorá-la. */
      /* AS DUAS FORMAS DE ESCREVER UMA ÂNCORA NESTA CASA, e não só uma.

         A primeira versão media `<a href=...>` em texto e dava «5 ligações
         medidas». As apps constroem quase tudo com `el('a', { href: … })`, que
         não tem `<a` nenhum no código — e entre as que escapavam estava
         justamente a que eu tinha acabado de corrigir. Uma guarda que mede
         onde o defeito não está dá um verde que não quer dizer nada. */
      for (const etiqueta of ancoras(texto)) {
        const href = etiqueta.match(/href[:=]\s*(?:"|'|`)([^"'`>]+)/);
        if (!href) continue;
        let destino = href[1];
        /* O código das apps escreve as ligações com `${base()}` à frente. O
           que interessa é o caminho que sobra depois disso. */
        destino = destino.replace(/^\$\{base\(\)\}/, '').replace(/^\$\{[^}]*\}/, '');
        if (!destino.startsWith('/')) continue;
        vistas++;
        if (destino.startsWith(ambito)) continue;          /* dentro: fica */
        /* `target="_blank"` no HTML e `target: '_blank'` no JavaScript. Escrevi
           o `[:=]` no href e esqueci-o aqui — e a guarda acusou de falta de
           `_blank` uma ligação que o tinha, pela segunda vez no mesmo bloco.
           Duas sintaxes, uma pergunta: quem lê as duas tem de as ler em TODOS
           os sítios onde pergunta, e não só no primeiro. */
        if (/target[:=]\s*(?:"|'|`)?_blank/.test(etiqueta)) continue;
        falhas.push(`${f.slice(SAIDA.length + 1)} → ${destino} (âmbito ${ambito})`);
      }
    }
  }
  if (!vistas) {
    avisar('não encontrei ligações nenhumas para medir — a guarda pode ter deixado de ver o que devia');
  } else if (falhas.length) {
    for (const f of falhas) {
      falhar(`${f} sai do âmbito da PWA sem target="_blank" — leva a pessoa para fora da app`);
    }
  } else {
    bem(`${vistas} ligações medidas, e as que saem do âmbito da PWA abrem-se à parte`);
  }
}

/* =========================================================================
   Nada é carregado de fora

   A pagina de privacidade promete, a letra: «nao carrega tipos de letra,
   MAPAS ou scripts de terceiros. Por isso nao veras aqui nenhum aviso de
   cookies a pedir-te autorizacao — nao ha nada para autorizar.»

   Isso e uma afirmacao verificavel, e ate aqui nada a verificava. Um
   `<script src>` de um CDN, um tipo de letra do Google, um `url()` numa folha
   de estilos ou — o caso que esta guarda nasceu a pensar — os mosaicos de um
   servidor de mapas, e a frase passa a ser falsa sem ninguem dar por isso.

   O QUE CONTA E O QUE O BROWSER VAI BUSCAR SOZINHO: `script src`, `link href`,
   `img src`, `iframe src`, `url()` e `@import`. Um `<a href>` para fora NAO
   conta — e uma ligacao que so e seguida se alguem lhe tocar, e o site tem-nas
   de proposito (o Livro de Reclamacoes, o Mapa das reclamacoes, o «Como
   chegar» de cada estabelecimento).
   ========================================================================= */
{
  console.log('\nNada é carregado de fora');

  /* Atributos que o browser resolve por sua conta, com a etiqueta a que
     pertencem — para a mensagem dizer o que e que estava a carregar o quê. */
  /* UMA ATITUDE, E NAO UMA LISTA DE ETIQUETAS.

     A primeira versao desta guarda enumerava `script src`, `link href`, `img
     src` e pouco mais, com as aspas obrigatorias. Uma revisao adversarial
     mostrou quinze maneiras de a contornar sem esforço nenhum: um `srcset`, um
     `poster`, um `<use href>` dentro de um SVG, um `<image href>`, um
     `xlink:href`, um `<object data>`, um `image-set()`, um atributo sem aspas,
     um `fetch()` escrito em JavaScript.

     Uma guarda que enumera formas de errar perde sempre para quem inventa a
     decima sexta. Agora a pergunta e ao contrario: **em qualquer ficheiro que
     vai publicado, ha algum endereco de outro dominio?** Um `<a href>` e a
     unica excepcao, porque e uma ligacao que so e seguida se alguem lhe tocar
     — e o site tem-nas de proposito (o Livro de Reclamacoes, o «Como chegar»).

     Assim, um endereco de terceiro novo tem de ser DECLARADO aqui para passar,
     em vez de descoberto. */
  const LIGACAO = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  /* Os enderecos que podem aparecer num ficheiro publicado sem serem um
     carregamento. Cada linha e uma decisao, e esta aqui para se poder discutir
     — que e o contrario de uma excepcao escondida numa expressao regular. */
  const PERMITIDOS = [
    /* Namespaces de XML. Nao sao carregados: sao identificadores. */
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/1999/xhtml',
    /* Vocabulario de dados estruturados, lido por motores de busca. */
    'https://schema.org',
    'http://schema.org',
    /* A NOSSA PROPRIA API. E outro dominio, mas nao e um terceiro: e o Worker
       deste produto, e a app fala com ele o tempo todo. Esta na seccao 5 da
       politica de privacidade, com a Cloudflare nomeada. Sai da configuracao e
       nao escrito a mao — escrito a mao, esta guarda deixava de servir no dia
       em que o endereco mudasse. */
    config.api,
    /* O «Como chegar». Sao os dois LIGACOES, dentro de um `<a href>` montado
       em JavaScript — por isso a limpeza dos `<a>` la em cima nao lhes chega.
       Nada e pedido a nenhum deles enquanto ninguem lhes tocar, e ambos estao
       escritos na seccao 4 da politica de privacidade, com nome. */
    'https://maps.apple.com/',
    'https://www.openstreetmap.org/',
  ].filter(Boolean);

  /* O NOSSO PROPRIO DOMINIO NAO E UM TERCEIRO. As paginas trazem o endereco
     absoluto em alguns sitios — e a mesma origem, e nao ha nada a declarar
     numa politica de privacidade sobre uma pagina ir buscar-se a si propria.
     O dominio sai da configuracao, e nao escrito a mao: escrito a mao, esta
     guarda deixava de servir no dia em que ele mudasse. */
  const nosso = new Set([config.dominio, `www.${config.dominio}`].filter(Boolean));

  /* O `data:` e o `blob:` nao saem do browser; o `#` e a propria pagina. */
  const deFora = (endereco) => {
    const e = endereco.trim();
    if (!e || e.startsWith('data:') || e.startsWith('blob:') || e.startsWith('#')) return null;
    let host = null;
    if (/^https?:\/\//i.test(e)) host = new URL(e).host;
    else if (e.startsWith('//')) host = e.slice(2).split('/')[0];
    else return null;                  /* relativo: e nosso */
    return nosso.has(host) ? null : host;
  };

  let olhados = 0, achados = 0, ligacoes = 0;
  for (const ficheiro of listar(SAIDA)) {
    if (!/\.(html|css|js|webmanifest|svg|json)$/i.test(ficheiro)) continue;
    olhados++;
    let texto = readFileSync(ficheiro, 'utf8');

    /* Tiram-se primeiro os `<a href>`, que sao ligacoes e nao carregamentos.
       Substituem-se por espacos para as posicoes nao mudarem. */
    texto = texto.replace(LIGACAO, (todo, aspas, apostrofe, nu) => {
      const endereco = aspas ?? apostrofe ?? nu ?? '';
      if (deFora(endereco)) ligacoes++;
      return ' '.repeat(todo.length);
    });

    /* E agora TODOS os enderecos que sobram. */
    for (const m of texto.matchAll(/(?:https?:)?\/\/[A-Za-z0-9._-]+\.[A-Za-z]{2,}[^\s"'`)<>\\]*/g)) {
      const endereco = m[0];
      const host = deFora(endereco);
      if (!host) continue;
      if (PERMITIDOS.some((bom) => endereco.startsWith(bom))) continue;
      /* A linha, para quem tiver de a ir ver. */
      const linha = texto.slice(0, m.index).split('\n').length;
      falhar(`${ficheiro.slice(SAIDA.length + 1)}:${linha}: endereço de ${host} `
        + `num ficheiro publicado — ${endereco.slice(0, 70)}`);
      achados++;
    }
  }

  /* E a guarda tem de se poder provar a si própria: se um dia ela deixar de
     olhar para ficheiro nenhum, este numero cai para zero e o «✓» continuava
     a aparecer, a dizer que esta tudo bem sobre uma verificacao que nao
     correu. E o erro de uma guarda que inverte e desaparece. */
  if (olhados < 10) {
    falhar(`a guarda do «nada de fora» só olhou para ${olhados} ficheiros — `
      + 'alguma coisa está errada nela, não no site');
  } else if (!achados) {
    bem(`${olhados} ficheiros publicados, nenhum carrega nada de fora `
      + `(${ligacoes} ligações para fora, que só são seguidas se alguém lhes tocar)`);
  }
}

/* --- resumo ------------------------------------------------------------- */
console.log(`\n${erros ? '✗' : '✓'} ${erros} erros, ${avisos} avisos.\n`);
process.exit(erros ? 1 : 0);
