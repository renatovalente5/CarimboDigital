#!/usr/bin/env node
/* =========================================================================
   Sinete — auditoria do que se vai publicar

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
const BASE = existsSync(join(RAIZ, 'CNAME')) ? '' : '/Sinete';

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
/* Sem domínio próprio o site vive em /Sinete/. Uma ligação que comece por
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
  }
  if (!mal) bem('manifestos, ícones e service workers no sítio');
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
  const emFalta = [];
  for (const [chave, valor] of Object.entries(config.entidade || {})) {
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

/* --- resumo ------------------------------------------------------------- */
console.log(`\n${erros ? '✗' : '✓'} ${erros} erros, ${avisos} avisos.\n`);
process.exit(erros ? 1 : 0);
