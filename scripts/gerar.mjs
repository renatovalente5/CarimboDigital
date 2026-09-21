#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — gerador do site

   Node puro, sem dependências. É de propósito: isto tem de continuar a
   publicar daqui a três anos sem ninguém correr um `npm install`.

   O que faz:
     · lê _fonte/config.json e calcula a versão (para partir a cache)
     · copia os estilos e o JavaScript
     · preenche os moldes das duas apps e das páginas do site
     · escreve o manifesto, o service worker, os ícones e o sitemap
   ========================================================================= */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, statSync,
         readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const FONTE = join(RAIZ, '_fonte');
const SAIDA = join(RAIZ, '_site');

const config = JSON.parse(readFileSync(join(FONTE, 'config.json'), 'utf8'));

/* O CRACHÁ DA APPLE EXISTE? É a construção que responde, e não a app.
   A arte do «Add to Apple Wallet» é da Apple e só se descarrega depois de
   aceitar os termos de uso da marca — não é coisa que se desenhe nem se
   substitua por um botão de texto. Enquanto o ficheiro não estiver cá, a app
   não pode mostrar botão nenhum da Apple: mostraria uma imagem partida.
   Largar o SVG nesta pasta é tudo o que falta para o botão aparecer. */
const CRACHA_APPLE = 'apple-wallet-pt.svg';
const TEM_CRACHA_APPLE = existsSync(join(FONTE, 'imagens', CRACHA_APPLE));

/* O prefixo dos caminhos sai do CNAME: com domínio próprio o site fica na
   raiz; sem ele, fica em /<nome-do-repositório>/. Derivar em vez de escrever
   à mão evita o clássico site publicado com todas as ligações partidas. */
const CNAME = join(RAIZ, 'CNAME');
const BASE = existsSync(CNAME) ? '' : '/CarimboDigital';

/* A versão é o resumo do conteúdo de tudo o que o browser guarda em cache.
   Muda quando o código muda, e só então. */
function versao() {
  const h = createHash('sha256');
  for (const pasta of ['estilos', 'js', 'app', 'balcao', 'dados']) {
    const p = join(FONTE, pasta);
    if (!existsSync(p)) continue;
    for (const f of listar(p).sort()) h.update(readFileSync(f));
  }
  h.update(JSON.stringify(config));
  return h.digest('hex').slice(0, 10);
}

function listar(pasta) {
  const saida = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    /* «É pasta» decide-se pelo statSync, e não por não ter ponto no nome —
       um `.well-known` ou um `icones` sem extensão enganam a heurística e a
       subárvore desaparece em silêncio. */
    if (statSync(caminho).isDirectory()) saida.push(...listar(caminho));
    else saida.push(caminho);
  }
  return saida;
}

/* Um clone raso tem git a funcionar e um histórico de um commit só. O
   `git log -1 -- ficheiro` responde com gosto: o tal commit único, para
   TODOS os ficheiros, com a data em que o CI o foi buscar. É pior do que
   não ter data nenhuma, porque parece uma data.

   Foi o que aconteceu: o `actions/checkout` clona raso por omissão, e a
   primeira publicação saiu com as quatro páginas a dizerem que tinham sido
   alteradas no mesmo segundo — o segundo da construção. O workflow passou a
   pedir o histórico todo (`fetch-depth: 0`), e esta pergunta fica aqui para
   o dia em que alguém lho voltar a tirar. */
const RASO = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'],
      { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
  } catch {
    return false;
  }
})();

/**
 * A data do último commit que tocou num ficheiro, em ISO.
 *
 * Sem git — um clone sem histórico, um zip — devolve null, e o sitemap sai
 * sem `lastmod`. Não ter a data é melhor do que inventá-la: a data de hoje
 * em todas as páginas diz ao motor que o site inteiro muda todos os dias, e
 * ele deixa de olhar para o campo.
 */
function ultimaAlteracao(ficheiro) {
  if (RASO) return null;
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cI', '--', ficheiro],
      { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return d || null;
  } catch {
    return null;
  }
}

const VERSAO = versao();

/* Os prazos de conservação lidos do Worker, que é quem os cumpre.

   Estavam escritos à mão na política de privacidade e já tinham fugido: a
   página prometia 20 minutos e o código apagava aos 15. Ninguém repara —
   e é um prazo de conservação numa página legal, não uma gralha de rodapé.
   Se algum destes nomes desaparecer do Worker, a construção morre aqui em
   vez de publicar uma página com {{...}} à vista. */
function prazosDoWorker() {
  const fonte = readFileSync(join(RAIZ, 'worker', 'src', 'index.js'), 'utf8');
  const ler = (nome) => {
    const m = fonte.match(new RegExp(`const ${nome} = (\\d+);`));
    if (!m) {
      console.error(`\n✗ ${nome} deixou de existir em worker/src/index.js.`);
      console.error('  Os prazos da política de privacidade saem de lá.\n');
      process.exit(1);
    }
    return m[1];
  };
  return {
    ENTRADA_MINUTOS: ler('ENTRADA_MINUTOS'),
    SESSAO_DIAS: ler('SESSAO_DIAS'),
    USADOS_HORAS: ler('USADOS_HORAS'),
    INACTIVA_MESES: ler('INACTIVA_MESES'),
    AVISO_DIAS: ler('AVISO_DIAS'),
    LIGACAO_MINUTOS: ler('LIGACAO_MINUTOS'),
  };
}
const PRAZOS = prazosDoWorker();

/* =========================================================================
   Duas funções pequenas que impedem defeitos silenciosos

   Nenhuma delas resolve um problema de hoje. As duas resolvem o problema da
   próxima página que se escrever — e vão escrever-se nove.
   ========================================================================= */

/* O QUE VAI PARA DENTRO DE UM ATRIBUTO TEM DE SER ESCAPADO.
 
   O título e o resumo de cada página entram em `<title>` e em quatro
   atributos `content="..."`, crus. Um título com «&» produz HTML inválido; um
   resumo com aspas — e um resumo em português apanha aspas com facilidade —
   FECHA O ATRIBUTO A MEIO, e a meta description sai truncada sem um erro em
   lado nenhum. É esse o texto que a Google mostra por baixo do resultado. */
const escapar = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* `naoIndexar: nao` PUNHA NOINDEX.
 
   Os valores do cabeçalho de cada página ficam como TEXTO, e testava-se a
   verdade do texto — e em JavaScript toda a cadeia não vazia é verdadeira.
   `naoIndexar: nao`, `naoIndexar: 0` e `semSitemap: falso` faziam exactamente
   o contrário do que lá está escrito, e não se via a ler o ficheiro: o
   ficheiro diz «não».
 
   Um valor que não se reconheça mata a construção. Adivinhar aqui é escolher
   entre publicar o que não se queria e esconder o que se queria publicar. */
const sim = (valor, onde) => {
  if (valor === undefined || valor === '') return false;
  const v = String(valor).trim().toLowerCase();
  if (['sim', 'true', '1'].includes(v)) return true;
  if (['nao', 'não', 'false', '0'].includes(v)) return false;
  console.error(`✗ ${onde}: «${valor}» não é sim nem não.`);
  process.exit(1);
};

const SUBSTITUICOES = {
  '{{BASE}}': BASE,
  /* O mesmo prefixo, mas como literal de JavaScript. Escrever `'{{BASE}}'` à
     mão dentro de um script dava a cadeia vazia com domínio próprio — que
     funciona — e partia-se em silêncio no dia em que o prefixo voltasse a ser
     `/CarimboDigital`. Sai do JSON.stringify, e é sempre uma cadeia válida. */
  '{{BASE_JSON}}': JSON.stringify(BASE),
  '{{VERSAO}}': VERSAO,
  /* Escapados pela mesma razão que o título e o resumo: os três vão parar a
     atributos, e o nome e a descrição vêm de um ficheiro de configuração que
     alguém há-de editar um dia. */
  '{{NOME}}': escapar(config.nome),
  '{{DOMINIO}}': config.dominio,
  '{{DESCRICAO}}': escapar(config.descricao),
  '{{CONTACTO}}': config.contacto,
  '{{COR}}': config.cor,
  '{{ANO}}': String(new Date().getFullYear()),
  '{{PRAZO_CODIGO_EMAIL}}': PRAZOS.ENTRADA_MINUTOS,
  '{{PRAZO_SESSAO}}': PRAZOS.SESSAO_DIAS,
  '{{PRAZO_CODIGO_USADO}}': PRAZOS.USADOS_HORAS,
  '{{PRAZO_INACTIVA}}': PRAZOS.INACTIVA_MESES,
  '{{PRAZO_AVISO}}': PRAZOS.AVISO_DIAS,
  '{{PRAZO_LIGACAO}}': PRAZOS.LIGACAO_MINUTOS,
  '{{CONFIG}}': JSON.stringify({
    base: BASE, api: config.api || '', versao: VERSAO,
    /* A app lê isto para decidir se desenha o botão da Apple. Ver acima. */
    crachaApple: TEM_CRACHA_APPLE,
  }),
  /* Dados da entidade. Enquanto não estiverem preenchidos aparecem como
     marcador visível — nunca como texto plausível mas falso, que é o pior
     dos dois mundos numa página legal. */
  '{{ENT_NOME}}': config.entidade?.nome || 'POR PREENCHER',
  /* Uma pessoa singular não tem forma jurídica. Em vez de escrever
     «POR PREENCHER» numa página legal — ou pior, inventar uma — a marca
     desaparece: o texto lê-se bem com ela e sem ela. */
  '{{ENT_FORMA}}': config.entidade?.forma
    ? ` (${config.entidade.forma})` : '',
  '{{ENT_NIF}}': config.entidade?.nif || 'POR PREENCHER',
  '{{ENT_MORADA}}': config.entidade?.morada || 'POR PREENCHER',
  '{{ENT_EMAIL}}': config.entidade?.email || config.contacto,
  '{{ENT_DADOS}}': config.entidade?.responsavel_dados || config.entidade?.nome || 'POR PREENCHER',
  '{{AVISO_RASCUNHO}}': config.producao ? '' :
    '<div class="caixa-aviso"><p><strong>Rascunho.</strong> Este texto está '
    + 'escrito mas ainda não tem os dados da entidade responsável. Antes de '
    + 'publicar o serviço a sério é preciso preencher <code>entidade</code> em '
    + '<code>_fonte/config.json</code> e pôr <code>producao: true</code>.</p></div>',
};

function preencher(texto) {
  let saida = texto;
  for (const [chave, valor] of Object.entries(SUBSTITUICOES)) {
    saida = saida.split(chave).join(valor);
  }
  return saida;
}

function escrever(destino, conteudo) {
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo);
}

/* --- limpar e recomeçar -------------------------------------------------- */
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });

/* Um `import` de módulo não passa pelo ?v= do <script> que o carregou: o
   browser (e o service worker) vão buscar `../js/nucleo.js` tal e qual, e
   ficam com a versão antiga colada durante dias. Por isso carimba-se a
   versão em todos os caminhos relativos de import, à saída. */
function versionarImports(texto) {
  return texto.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.js)\2/g,
    (_, antes, aspas, caminho) => `${antes}${aspas}${caminho}?v=${VERSAO}${aspas}`);
}

/* --- estilos e JavaScript ------------------------------------------------ */
cpSync(join(FONTE, 'estilos'), join(SAIDA, 'estilos'), { recursive: true });
for (const ficheiro of listar(join(FONTE, 'js'))) {
  const destino = join(SAIDA, 'js', relative(join(FONTE, 'js'), ficheiro));
  escrever(destino, versionarImports(preencher(readFileSync(ficheiro, 'utf8'))));
}

/* --- as duas aplicações -------------------------------------------------- */
for (const app of ['app', 'balcao']) {
  const origem = join(FONTE, app);
  if (!existsSync(origem)) continue;
  for (const ficheiro of listar(origem)) {
    const rel = relative(origem, ficheiro);
    const destino = join(SAIDA, app, rel);
    if (['.html', '.js', '.css', '.webmanifest', '.json', '.svg'].includes(extname(ficheiro))) {
      const texto = preencher(readFileSync(ficheiro, 'utf8'));
      escrever(destino, extname(ficheiro) === '.js' ? versionarImports(texto) : texto);
    } else {
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(ficheiro, destino);
    }
  }
}

/* =========================================================================
   Dados estruturados

   Diz aos motores de busca o que isto é, em vez de os deixar adivinhar pelo
   texto. Duas coisas, e só duas, porque são as que correspondem à verdade:

   · uma Organization, que é quem responde pelo serviço — e é a mesma
     identidade que está nas páginas legais, tirada do mesmo config, para não
     haver duas versões da mesma pessoa;
   · uma WebApplication, porque é o que o produto é: uma app que corre no
     browser, de graça, em português.

   Não se inventa o que não se tem. Sem avaliações não há `aggregateRating` —
   um rating inventado é o género de coisa que faz um site perder os
   resultados enriquecidos todos de uma vez, e com razão.
   ========================================================================= */

function dadosEstruturados(rota) {
  const sitio = `https://${config.dominio}`;
  const entidade = config.entidade || {};
  /* As duas grafias saem do próprio domínio, e não de uma cadeia escrita à
     mão: `carimbodigital.pt` dá «carimbodigital» e «carimbodigital.pt». */
  const grafias = [config.dominio.split('.')[0], config.dominio];

  const organizacao = {
    '@type': 'Organization',
    '@id': `${sitio}/#entidade`,
    name: config.nome,
    /* A GRAFIA JUNTA, DECLARADA. Quem escreve «carimbodigital» na barra de
       pesquisa recebe hoje «A apresentar resultados para carimbo digital» — o
       Google autocorrige, porque ainda não registou a palavra colada como
       nome próprio em Portugal; a única sugestão que dá é o domínio .com.br de
       uma empresa brasileira homónima. O `alternateName` é o campo desenhado
       exactamente para isto. Não desliga o autocorrector sozinho, mas é a
       declaração mais directa e mais barata de que isto se escreve assim. */
    alternateName: grafias,
    /* Com barra final, igual ao canónico. Dois endereços para a mesma coisa
       são duas coisas, para quem lê isto como máquina. */
    url: `${sitio}/`,
    email: entidade.email || config.contacto,
    logo: `${sitio}/icones/512.png`,
    description: config.descricao,
    areaServed: { '@type': 'Country', name: 'Portugal' },
    /* Sem NIF e sem morada, de propósito. A lei obriga a identificação a
       constar do site, e ela consta — nas páginas legais, em texto, que é
       onde alguém a vai procurar. Pô-la também aqui era entregá-la em
       formato de máquina a quem raspa sítios, e isto é a casa e o número de
       contribuinte de um particular, não de uma empresa. */
  };

  /* Só na página inicial: repetir a ficha do produto em todas as páginas não
     acrescenta nada e dilui qual delas é a página do produto. */
  /* O NÓ DO SÍTIO, e só na página inicial.
 
     É o tipo que a documentação da Google manda usar para o nome de um site, e
     ela ignora-o fora da raiz do domínio. Não existia: o grafo tinha a
     organização e a aplicação, e nenhuma das duas diz «este sítio chama-se
     assim». É por aqui que o nome da marca aparece por cima do resultado, em
     vez do domínio nu. */
  const sitioWeb = rota === '' ? [{
    '@type': 'WebSite',
    '@id': `${sitio}/#site`,
    name: config.nome,
    alternateName: grafias,
    url: `${sitio}/`,
    inLanguage: 'pt-PT',
    publisher: { '@id': `${sitio}/#entidade` },
  }] : [];

  const aplicacao = rota === '' ? [{
    '@type': 'WebApplication',
    '@id': `${sitio}/#app`,
    name: config.nome,
    /* A RAIZ, E NÃO `/app/`. Dizia-se aqui «a entidade principal deste sítio
       vive em /app/» e, na página seguinte, «não indexes /app/». As duas
       coisas não podem ser verdade ao mesmo tempo. */
    url: `${sitio}/`,
    description: config.descricao,
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web',
    inLanguage: 'pt-PT',
    publisher: { '@id': `${sitio}/#entidade` },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  }] : [];

  return { '@context': 'https://schema.org',
           '@graph': [organizacao, ...sitioWeb, ...aplicacao] };
}

/* --- páginas do site ----------------------------------------------------- */
const parcial = (nome) => preencher(readFileSync(join(FONTE, 'parciais', nome), 'utf8'));
const MOLDE = readFileSync(join(FONTE, 'parciais', 'molde.html'), 'utf8');

const paginas = existsSync(join(FONTE, 'paginas')) ? listar(join(FONTE, 'paginas')) : [];
const rotas = [];

for (const ficheiro of paginas) {
  const cru = readFileSync(ficheiro, 'utf8');
  const meta = {};
  let corpo = cru;
  /* `\r?\n`, E NÃO `\n`. Um ficheiro gravado com fins de linha do Windows não
     casava — e não dava erro nenhum: o bloco `---` caía no corpo como TEXTO
     VISÍVEL, e a página ficava com o título de recurso, que passava
     folgadamente em todas as guardas. Publicava-se uma página com o cabeçalho
     à vista e com o título de outra. */
  const cabecalho = cru.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (cabecalho) {
    for (const linha of cabecalho[1].split(/\r?\n/)) {
      const i = linha.indexOf(':');
      if (i > 0) meta[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
    }
    corpo = cru.slice(cabecalho[0].length);
  }
  const nome = relative(join(FONTE, 'paginas'), ficheiro).replace(/\.html$/, '');

  /* SEM RECURSO SILENCIOSO. `meta.titulo || config.nome` significava que dez
     páginas sem cabeçalho ficavam com o mesmo título e a mesma descrição — e
     títulos iguais são a receita para a Google escolher uma e ignorar as
     outras. Com quatro páginas nunca aconteceu; com vinte, acontece à
     primeira distracção. Morre aqui, com o nome do ficheiro. */
  for (const campo of ['titulo', 'resumo']) {
    if (!meta[campo] || !String(meta[campo]).trim()) {
      console.error(`✗ ${relative(FONTE, ficheiro)}: falta «${campo}» no cabeçalho.`);
      process.exit(1);
    }
  }
  meta.naoIndexar = sim(meta.naoIndexar, `${relative(FONTE, ficheiro)}: naoIndexar`);
  meta.semSitemap = sim(meta.semSitemap, `${relative(FONTE, ficheiro)}: semSitemap`);
  const rota = nome === 'inicio' ? '' : `/${nome}`;
  const destino = nome === 'inicio' ? join(SAIDA, 'index.html') : join(SAIDA, nome, 'index.html');

  const html = preencher(MOLDE)
    .split('{{CABECALHO}}').join(parcial('cabecalho.html'))
    .split('{{RODAPE}}').join(parcial('rodape.html'))
    .split('{{TITULO}}').join(escapar(meta.titulo))
    .split('{{RESUMO}}').join(escapar(meta.resumo))
    /* Uma página que não quer ser indexada também não tem canónico: o da
       404 apontava para /404/, um endereço que responde 404. Dizer aos
       motores «a versão oficial desta página é aquela» quando aquela não
       existe é pior do que não dizer nada. */
    .split('{{CANONICO_TAG}}').join(meta.naoIndexar
      ? '' : `<link rel="canonical" href="https://${config.dominio}${rota}/">`)
    .split('{{CANONICO}}').join(`https://${config.dominio}${rota}/`)
    /* NAS PÁGINAS INDEXÁVEIS TAMBÉM SE DIZ ALGUMA COISA, e não é nada.
 
       `max-image-preview:large` autoriza a Google a mostrar a imagem social
       em grande ao lado do resultado — a `og:image` de 1200×630 já existe —,
       e `max-snippet:-1` tira o limite ao excerto. Não melhora a posição:
       faz o resultado ocupar mais altura do que o do concorrente ao lado,
       que numa pesquisa pelo nome da marca é o que se quer. */
    .split('{{ROBOTS}}').join(meta.naoIndexar
      ? '\n<meta name="robots" content="noindex">'
      : '\n<meta name="robots" content="index, follow, max-snippet:-1,'
        + ' max-image-preview:large, max-video-preview:-1">')
    /* Uma página que não quer ser indexada também não precisa de se
       descrever a quem não a vai indexar. */
    .split('{{DADOS_ESTRUTURADOS}}').join(meta.naoIndexar ? ''
      : `<script type="application/ld+json">\n${
        JSON.stringify(dadosEstruturados(rota), null, 2)}\n</script>`)
    .split('{{CLASSE}}').join(meta.classe || '')
    .split('{{CORPO}}').join(preencher(corpo));

  escrever(destino, html);
  /* Uma página pode existir e não querer ser anunciada — a 404 é o caso.
     Anunciá-la no sitemap dizia aos motores «esta página é conteúdo», e o
     canónico dela dizia-lhes que era a página inicial. */
  if (!meta.semSitemap) {
    rotas.push({
      rota: `${rota}/`,
      prioridade: meta.prioridade || (rota ? '0.6' : '1.0'),
      /* A data da última alteração da FONTE desta página, tirada do git. É o
         único campo do sitemap que o Google diz usar — o `priority` e o
         `changefreq` são ignorados há anos. E tem de ser honesta: um
         `lastmod` que muda a cada construção, sem o conteúdo mudar, ensina o
         motor a não acreditar nele. */
      alterada: ultimaAlteracao(ficheiro),
    });
  }
}

/* --- manifesto ----------------------------------------------------------- */
escrever(join(SAIDA, 'app', 'manifest.webmanifest'), JSON.stringify({
  name: 'Carimbo Digital', short_name: 'Carimbo',
  description: config.descricao,
  start_url: `${BASE}/app/`, scope: `${BASE}/app/`,
  display: 'standalone', display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait',
  background_color: '#FBFAF7', theme_color: '#FBFAF7',
  lang: 'pt-PT', dir: 'ltr',
  categories: ['lifestyle', 'shopping', 'utilities'],
  icons: [
    { src: `${BASE}/icones/192.png`, sizes: '192x192', type: 'image/png' },
    { src: `${BASE}/icones/512.png`, sizes: '512x512', type: 'image/png' },
    { src: `${BASE}/icones/mascara.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [{
    name: 'Mostrar o meu código', short_name: 'Código',
    url: `${BASE}/app/?acao=codigo`,
    icons: [{ src: `${BASE}/icones/192.png`, sizes: '192x192' }],
  }],
}, null, 2));

escrever(join(SAIDA, 'balcao', 'manifest.webmanifest'), JSON.stringify({
  name: 'Carimbo Digital Balcão', short_name: 'Balcão',
  description: 'Carimba os cartões dos teus clientes.',
  start_url: `${BASE}/balcao/`, scope: `${BASE}/balcao/`,
  display: 'standalone', orientation: 'portrait',
  background_color: '#0E0D12', theme_color: '#0E0D12',
  lang: 'pt-PT',
  icons: [
    { src: `${BASE}/icones/balcao-192.png`, sizes: '192x192', type: 'image/png' },
    { src: `${BASE}/icones/balcao-512.png`, sizes: '512x512', type: 'image/png' },
    { src: `${BASE}/icones/balcao-mascara.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));

/* --- service workers ----------------------------------------------------- */
/* Um por aplicação, e cada um com o âmbito da sua pasta.

   Um único service worker em /sw.js apanharia o âmbito do site inteiro — e
   o site de apresentação passava a ser servido da cache, com a página da app
   a aparecer no lugar da página inicial quando a rede tossisse. As páginas
   normais não ganham nada em ser guardadas; as apps é que têm de abrir sem
   rede.

   Três estratégias dentro de cada um:
   · navegações (o HTML)  -> rede primeiro. Sem isto uma versão nova nunca
                             chega: o HTML é a única coisa cujo endereço não
                             muda, e servi-lo da cache prende o utilizador a
                             uma versão antiga para sempre.
   · ficheiros com ?v=    -> cache primeiro, e nem se vai à rede confirmar.
                             O endereço já muda a cada versão.
   · o resto              -> cache primeiro com atualização em segundo plano.

   Os pedidos à API nunca são guardados: um cartão em cache é um cartão com o
   número de carimbos errado, e isso vê-se ao balcão. */
for (const app of ['app', 'balcao']) {
  const ficheiro = app === 'app' ? 'app.js' : 'balcao.js';
  const casco = [
    `${BASE}/${app}/`,
    `${BASE}/${app}/${ficheiro}?v=${VERSAO}`,
    `${BASE}/estilos/nucleo.css?v=${VERSAO}`,
    `${BASE}/estilos/app.css?v=${VERSAO}`,
    ...(app === 'balcao' ? [`${BASE}/estilos/balcao.css?v=${VERSAO}`] : []),
    `${BASE}/js/nucleo.js?v=${VERSAO}`,
    `${BASE}/js/api.js?v=${VERSAO}`,
    /* O MAPA SAIU DAS DUAS APPS.

       Ele existia para dois ecrãs: o «Descobrir» do cliente e o «Onde fica»
       do balcão. O primeiro saiu com os separadores; o segundo saiu com a
       recolha da morada exacta, que deixou de ter finalidade quando deixou de
       haver onde a mostrar.

       Com eles saem `js/mapa.js` e os 100 KB de fronteiras dos concelhos — do
       casco das duas apps e do repositório. O trabalho está no git; o que não
       podia ficar era código publicado que nenhum ecrã chama, e 100 KB no
       telemóvel de cada pessoa para desenhar uma coisa que já não existe. */
    ...(app === 'app'
      ? [`${BASE}/js/qr.js?v=${VERSAO}`,
         /* Os crachás das carteiras. Vão no casco para estarem lá à primeira
            e sem rede: as imagens são da Google e da Apple, não se podem
            substituir por texto, e se faltassem o botão ficava um buraco.
            O da Apple só entra se existir — senão o `install` do service
            worker falhava inteiro num 404 e a app ficava sem casco nenhum. */
         `${BASE}/icones/google-wallet-pt.svg`,
         ...(TEM_CRACHA_APPLE ? [`${BASE}/icones/${CRACHA_APPLE}`] : [])]
      : [`${BASE}/js/qr-leitor.js?v=${VERSAO}`]),
  ];

  escrever(join(SAIDA, app, 'sw.js'), `/* Carimbo Digital ${app} — service worker (versão ${VERSAO}) */
const CACHE = 'carimbo-${app}-${VERSAO}';
const CASCO = ${JSON.stringify(casco, null, 2)};

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' força ir à rede: o GitHub Pages serve tudo com
    // max-age=600, e sem isto o casco novo era guardado a partir da cache
    // velha do browser — instalando uma versão nova com ficheiros antigos.
    await Promise.allSettled(CASCO.map((u) =>
      fetch(new Request(u, { cache: 'reload' })).then((r) => r.ok && c.put(u, r))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const nome of await caches.keys()) {
      if (nome.startsWith('carimbo-${app}-') && nome !== CACHE) await caches.delete(nome);
    }
    await self.clients.claim();
  })());
});

${app === 'app' ? `
/* --- as notificações ---------------------------------------------------- */
/* O texto vem CIFRADO no corpo do push, e não se vai buscar a lado nenhum: um
   service worker não tem acesso ao localStorage, que é onde vive a sessão, e
   sem sessão não havia nada para ir buscar. Ver worker/src/push.js. */
self.addEventListener('push', (ev) => {
  let dados = {};
  try { dados = ev.data ? ev.data.json() : {}; } catch { dados = {}; }
  const titulo = dados.titulo || 'Carimbo Digital';
  ev.waitUntil(self.registration.showNotification(titulo, {
    body: dados.corpo || '',
    icon: '${BASE}/icones/192.png',
    badge: '${BASE}/icones/192.png',
    /* Uma etiqueta só: dois prémios seguidos não empilham dois avisos iguais
       no ecrã bloqueado de quem está a sair do café. */
    tag: 'carimbo-premio',
    renotify: true,
    data: { abrir: '${BASE}/app/' },
  }));
});

/* Tocar na notificação traz a app que JÁ ESTÁ ABERTA, se estiver — abrir uma
   segunda janela por cima da primeira é a forma mais rápida de alguém perder
   o sítio onde estava. */
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const destino = (ev.notification.data && ev.notification.data.abrir) || '${BASE}/app/';
  ev.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const j of janelas) {
      if (j.url.includes('${BASE}/app/') && 'focus' in j) return j.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(destino);
    return null;
  })());
});
` : ''}
self.addEventListener('fetch', (ev) => {
  const pedido = ev.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);
  if (url.origin !== location.origin) return;          // a API vai sempre à rede

  if (pedido.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        const r = await fetch(pedido);
        if (r.ok) (await caches.open(CACHE)).put(pedido, r.clone());
        return r;
      } catch {
        const c = await caches.open(CACHE);
        return (await c.match(pedido)) || (await c.match('${BASE}/${app}/'))
            || new Response('Sem ligação.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(pedido);
    if (guardado) {
      if (!url.search.includes('v=')) {
        fetch(pedido).then((r) => { if (r.ok) cache.put(pedido, r.clone()); }).catch(() => {});
      }
      return guardado;
    }
    try {
      const r = await fetch(pedido);
      if (r.ok) cache.put(pedido, r.clone());
      return r;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
`);
}

/* --- dados ---------------------------------------------------------------
   Hoje é só o mapa de Portugal: as fronteiras dos 308 concelhos, já
   projectadas. Vai para o site como qualquer outro ficheiro — e é por isso que
   o mapa funciona sem rede e não contacta servidor nenhum.

   `cpSync` da pasta INTEIRA e sem filtro: recusar uma pasta num filtro deita
   fora a subárvore toda em silêncio, e já custou caro nesta casa. */
if (existsSync(join(FONTE, 'dados'))) {
  cpSync(join(FONTE, 'dados'), join(SAIDA, 'dados'), { recursive: true });
}

/* --- ícones -------------------------------------------------------------- */
if (existsSync(join(FONTE, 'imagens'))) {
  cpSync(join(FONTE, 'imagens'), join(SAIDA, 'icones'), { recursive: true });
  /* O favicon tem de estar na raiz: é lá que os browsers e os leitores de
     feeds o vão procurar quando o <link> não chega. */
  cpSync(join(FONTE, 'imagens', 'favicon.svg'), join(SAIDA, 'favicon.svg'));
}

/* --- ficheiros de raiz --------------------------------------------------- */
if (existsSync(CNAME)) cpSync(CNAME, join(SAIDA, 'CNAME'));

/* SEM `Disallow`, e é de propósito.
 
   As duas aplicações têm `<meta name="robots" content="noindex">`, que é a
   forma correcta de dizer «não indexes isto». O `Disallow` do robots.txt diz
   outra coisa: «não LEIAS isto». As duas juntas anulam-se — a documentação da
   Google é literal: «Para que a regra noindex seja eficaz, a página não pode
   estar bloqueada por um ficheiro robots.txt… o rastreador nunca verá a regra
   noindex, e a página pode ainda aparecer nos resultados.»
 
   E aparecia com jeito: `/app/` é o endereço mais ligado do site inteiro —
   botão no cabeçalho das cinco páginas, botão no rodapé, dois no corpo da
   página inicial — e é para lá que aponta o QR do cartaz. Bastava alguém
   partilhar o link no Facebook para o endereço entrar no índice NU, sem
   título e sem descrição, com o clássico «Não existe informação disponível
   para esta página» — a competir com a própria página inicial numa pesquisa
   pelo nome da marca.
 
   Orçamento de rastreio não é argumento: a Google só o discute a partir de
   10 000 endereços, e aqui há cinco páginas. */
escrever(join(SAIDA, 'robots.txt'),
  `User-agent: *\nAllow: /\n\n`
  + `Sitemap: https://${config.dominio}/sitemap.xml\n`);

escrever(join(SAIDA, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  + rotas.map((r) => `  <url><loc>https://${config.dominio}${r.rota}</loc>`
      + (r.alterada ? `<lastmod>${r.alterada}</lastmod>` : '')
      + `<priority>${r.prioridade}</priority></url>`).join('\n')
  + `\n</urlset>\n`);

/* --- 404 -----------------------------------------------------------------

   Era uma cópia byte a byte do index.html: quem escrevesse um endereço
   errado recebia a página inicial com um cabeçalho 404, sem uma palavra que
   dissesse que se tinha enganado — e com o canónico a apontar para a raiz,
   ou seja, a dizer aos motores de busca que aquilo ERA a página inicial.
   Agora é uma página escrita para isso, gerada a partir de paginas/404.html
   como as outras.
   -------------------------------------------------------------------- */
if (existsSync(join(SAIDA, '404', 'index.html'))) {
  const pagina = readFileSync(join(SAIDA, '404', 'index.html'), 'utf8');
  escrever(join(SAIDA, '404.html'), pagina);
  rmSync(join(SAIDA, '404'), { recursive: true, force: true });
}

console.log(`Carimbo Digital gerado. versão ${VERSAO}, base "${BASE || '/'}", `
  + `${rotas.length} páginas, ${listar(SAIDA).length} ficheiros.`);
