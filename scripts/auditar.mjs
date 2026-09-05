#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — auditoria do que se vai publicar

   Corre depois de gerar e antes de publicar. Se falhar, não se publica: fica
   no ar a versão anterior, que é sempre melhor do que uma versão nova
   partida.

   Não conta ficheiros — segue ligações. Contar ficheiros diz que há vinte
   páginas; seguir ligações diz que três delas apontam para o vazio.
   ========================================================================= */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  let mortas = 0, total = 0;
  for (const pagina of paginas) {
    const texto = readFileSync(pagina, 'utf8');
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
  bem('com domínio próprio — não é preciso prefixo');
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
    if (!/<html lang="pt-PT">/.test(texto)) { falhar(`${nome}: falta lang="pt-PT"`); mal++; }
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
  ];
  let achados = 0;
  for (const f of ficheiros) {
    if (!['.html', '.js', '.json', '.css', '.txt'].includes(extname(f))) continue;
    const texto = readFileSync(f, 'utf8');
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
  const robots = readFileSync(join(SAIDA, 'robots.txt'), 'utf8');
  if (!robots.includes('Disallow: /app/')) { falhar('robots.txt não exclui /app/'); mal++; }
  if (!mal) bem('as duas aplicações estão fora dos motores de busca');
}

/* --- 11. contraste da paleta -------------------------------------------
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
  if (!mal) bem(`${contados} pares de cores medidos, todos passam`);
}

/* --- resumo ------------------------------------------------------------- */
console.log(`\n${erros ? '✗' : '✓'} ${erros} erros, ${avisos} avisos.\n`);
process.exit(erros ? 1 : 0);
