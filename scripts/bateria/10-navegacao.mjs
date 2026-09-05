/* =========================================================================
   Bateria · 10 — Navegação, painéis e o botão de voltar

   Estas duas apps não têm endereços: os cinco ecrãs do cliente e os quatro
   do balcão são o mesmo `#principal` esvaziado e pintado de novo. Isso torna
   a navegação invisível a qualquer teste que olhe para o URL — e é
   exactamente onde moram os defeitos que a pessoa vê: um ecrã que fica com
   metade do anterior por baixo, um ecrã que abre a meio, um separador que se
   diz activo sem o ser, um painel que não fecha.

   E o botão de voltar, que é novo. Numa PWA instalada no Android o «voltar»
   é o botão do sistema — antes do tratador de `popstate` ele FECHAVA A APP,
   painel aberto e tudo. O modelo escolhido é o mais simples que funciona:
   cada ecrã é uma entrada no histórico, cada coisa que se abre por cima é
   outra, e voltar desfaz a última.

   O que isso obriga a provar, e é o que este módulo persegue:

   · VOLTAR FECHA O QUE ESTÁ POR CIMA E FICA ONDE ESTAVA. Um voltar que
     fechasse o painel E mudasse de ecrã ao mesmo tempo seria pior do que não
     fazer nada: a pessoa perdia o sítio onde estava sem ter pedido.

   · FECHAR PELO BOTÃO NÃO PODE DEIXAR ENTRADA FANTASMA. Quem fecha um painel
     pelo botão tem de comer a entrada que a abertura empurrou. Se não a
     comer, o «voltar» seguinte não faz nada visível — e a pessoa carrega
     outra vez, e outra, até sair da app sem perceber porquê. Uma entrada a
     mais não se vê no ecrã, mas vê-se no `history.length`.

   · A MARCA DO HISTÓRICO TEM DE DESCREVER O QUE SE VÊ. A app carimba cada
     entrada (`history.state.carimbo`) com aquilo que a empurrou. Estar numa
     entrada que diz «painel» sem painel nenhum no ecrã é a definição de
     entrada fantasma, e é assim que ela se apanha.

   · UM ECRÃ NÃO PODE PINTAR POR CIMA DO OUTRO. `irPara` esvazia o
     `#principal` e depois espera pelos dados. Quem sair do ecrã durante essa
     espera deixa lá um desenho a caminho que já não tem onde assentar.

   Corre em modo de demonstração, que não toca na rede.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '10 · Navegação, painéis e o botão de voltar';
export const desculpar = [/favicon/];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* Os separadores não têm id — são `.barra-item`, pela ordem em que a barra
   os desenha. */
const SEP = (n) => `.barra-item:nth-child(${n})`;
const CODIGO = SEP(3);

/* Cada ecrã do cliente com uma prova que só ele tem. Não chega o título: um
   ecrã pintado por cima do outro traz o título certo e o corpo errado. */
const ECRAS_CLIENTE = [
  { pos: 1, chave: 'carteira',  topo: 'Carimbo Digital', h1: 'Os meus cartões' },
  { pos: 2, chave: 'descobrir', topo: 'Descobrir',       h1: 'Descobrir' },
  { pos: 4, chave: 'premios',   topo: 'Prémios',         h1: 'Prémios' },
  { pos: 5, chave: 'perfil',    topo: 'Perfil',          h1: 'Perfil' },
];

const ECRAS_BALCAO = [
  { pos: 2, topo: 'Hoje',     titulo: 'Hoje',         prova: '#principal .numeros' },
  { pos: 3, topo: 'Clientes', titulo: 'Clientes',     prova: '#principal .lista' },
  { pos: 4, topo: 'O cartão', titulo: 'O meu cartão', prova: '#principal #previa' },
  { pos: 1, topo: 'Carimbar', titulo: null,           prova: '#principal .visor' },
];

const LINHA_APAGAR = '#principal .linha-perigo';
const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';

/* =========================================================================
   Retrato do ecrã

   Uma leitura só, para as afirmações compararem todas o mesmo instante. As
   quatro contagens do meio são a parte que interessa: são exclusivas de cada
   ecrã, e quem vir duas ao mesmo tempo está a ver dois ecrãs sobrepostos.
   ========================================================================= */

async function retrato(palco) {
  return palco.js(`
    const q = (s) => document.querySelectorAll(s).length;
    const barra = [...document.querySelectorAll('.barra-item')];
    return {
      topo: document.querySelector('#topo-titulo')?.textContent.trim() ?? null,
      titulos: [...document.querySelectorAll('#principal h1.titulo-grande')]
        .map((n) => n.textContent.trim()),
      rotulos: barra.map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
      marcados: barra
        .map((b, i) => (b.getAttribute('aria-current') === 'page' ? i + 1 : 0))
        .filter(Boolean),
      carteira:  q('#principal .linha.adicionar'),
      descobrir: q('#principal .cartao-descobrir'),
      premios:   q('#principal .linha-premio'),
      perfil:    q('#principal .identidade-numero'),
      painel: Boolean(document.querySelector('#painel')),
      folha: Boolean(document.querySelector('#folha-codigo')),
      nos: document.querySelectorAll('*').length,
      corpo: document.body.children.length,
      comprimento: history.length,
      marca: (history.state && history.state.carimbo) || null,
      onde: location.pathname + location.search,
    };`);
}

/** Só as contagens exclusivas, em texto, para o detalhe de uma falha. */
const quaisEcras = (r) => ['carteira', 'descobrir', 'premios', 'perfil']
  .filter((k) => r[k] > 0).join('+') || 'nenhum';

/* =========================================================================
   O botão de voltar

   `history.back()` é assíncrono e o tratador da app ainda faz trabalho
   `async` depois de acordar. Um tempo fixo dá falsos negativos nas máquinas
   lentas do CI; por isso espera-se pelo `popstate`, contado por um ouvinte
   nosso — que corre depois do da app —, e só depois se lê o ecrã.
   ========================================================================= */

async function armarContador(palco) {
  await palco.js(`
    if (!window.__voltasArmado) {
      window.__voltasArmado = true;
      window.__voltas = 0;
      addEventListener('popstate', () => { window.__voltas++; });
    }
    return true`);
}

/**
 * Carrega em voltar uma vez e espera pelo efeito.
 *
 * Devolve `{ voltas, saiu }`. O `saiu` é o caso que não se pode confundir
 * com «não aconteceu nada»: ninguém tratou o gesto e o browser levou o
 * separador para fora do documento — que numa app instalada é a app a
 * fechar-se na cara da pessoa.
 */
async function voltar(palco, tecto = 5000) {
  const antes = await palco.js('return { v: window.__voltas || 0, onde: location.href }');
  await palco.js('history.back(); return true');
  const limite = Date.now() + tecto;
  for (;;) {
    const agora = await palco.js(
      'return { v: window.__voltas || 0, onde: location.href, armado: !!window.__voltasArmado }');
    if (agora.onde !== antes.onde || !agora.armado) return { voltas: 0, saiu: true };
    if (agora.v > antes.v) { await dormir(300); return { voltas: agora.v - antes.v, saiu: false }; }
    if (Date.now() > limite) return { voltas: 0, saiu: false };
    await dormir(80);
  }
}

/* =========================================================================
   Clicar fora de um painel

   `palco.clicar('.painel-veu')` aponta ao centro do véu, que é onde a folha
   do painel costuma estar. Aqui aponta-se ao alto do ecrã, que é onde cai o
   polegar de quem quer «carregar fora», e confirma-se com `elementFromPoint`
   que é mesmo o véu que lá está antes de carregar. Se não for, devolve quem
   é — e a afirmação reprova em vez de fingir um clique.
   ========================================================================= */

async function clicarNoVeu(palco) {
  const alvo = await palco.js(`
    const veu = document.querySelector('.painel-veu');
    if (!veu) return { quem: 'não há véu' };
    const r = veu.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + 48);
    const em = document.elementFromPoint(x, y);
    return { x, y, quem: em ? em.className || em.tagName.toLowerCase() : 'ninguém' };`);
  if (!String(alvo.quem).includes('painel-veu')) return alvo;
  for (const tipo of ['mousePressed', 'mouseReleased']) {
    await palco.enviar('Input.dispatchMouseEvent', {
      type: tipo, x: alvo.x, y: alvo.y, button: 'left', clickCount: 1,
    }, palco.sessao);
  }
  await dormir(200);
  return alvo;
}

/* =========================================================================
   Chegar ao topo de um ecrã novo

   Mede onde a página fica depois de se mudar de separador vindo de um ecrã
   rolado. Não se lê num instante: amostra-se durante meio segundo e devolve-
   -se o valor em que assentou, porque o que interessa é onde a pessoa fica —
   não o que aconteceu num fotograma pelo meio.
   ========================================================================= */

async function mudarDeEcraRolado(palco, separador, prova) {
  await palco.rolar(600);
  const antes = await palco.js('return Math.round(window.scrollY)');
  /* Um clique de rato a sério. A barra é `position: fixed`, por isso o
     `scrollIntoView` que o palco faz antes de carregar não mexe na página —
     o que se medir a seguir é da app, não do teste. */
  await palco.clicar(separador);
  await palco.esperar(prova, 8000);
  const amostras = [];
  for (let i = 0; i < 5; i++) {
    amostras.push(await palco.js('return Math.round(window.scrollY)'));
    await dormir(120);
  }
  const medida = await palco.js(`
    const h1 = document.querySelector('#principal h1.titulo-grande');
    const topo = document.querySelector('#topo');
    return {
      titulo: h1 ? Math.round(h1.getBoundingClientRect().top) : null,
      barraDeCima: topo ? Math.round(topo.getBoundingClientRect().bottom) : null,
      /* A app acende a linha por baixo da barra de cima quando a página está
         rolada. Se ela acende num ecrã acabado de abrir, é a própria app a
         concordar que não está no topo. */
      rolado: topo ? topo.dataset.rolado : null };`);
  return { antes, amostras, assentou: amostras[amostras.length - 1], ...medida };
}

/* =========================================================================
   Entrar no balcão, venha ele de onde vier
   ========================================================================= */

async function entrarNoBalcao(palco) {
  await palco.ir('/balcao/?demo=1');
  if (await palco.visivel('#entrada-acoes .btn-cheio')) {
    await palco.clicar('#entrada-acoes .btn-cheio');
  }
  await palco.esperar('#barra .barra-item', 12000);
  await armarContador(palco);
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* =======================================================================
     Cliente — os cinco separadores
     ======================================================================= */

  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item', 10000);
  await armarContador(palco);

  const inicio = await retrato(palco);
  certo(inicio.rotulos.join('|') === 'Carteira|Descobrir|Código|Prémios|Perfil',
    'barra: os cinco separadores do cliente, pela ordem', inicio.rotulos.join('|'));
  certo(inicio.marcados.join(',') === '1',
    'barra: à abertura só a Carteira está marcada como o ecrã actual',
    `marcados: ${inicio.marcados.join(',') || 'nenhum'}`);

  /* Três voltas ao circuito. Uma passagem só provava que cada ecrã pinta; são
     as seguintes que apanham o que ficou para trás da primeira. */
  const nosPorVolta = [];
  for (let volta = 1; volta <= 3; volta++) {
    for (const e of ECRAS_CLIENTE) {
      await palco.clicar(SEP(e.pos));
      await palco.esperar('#principal h1.titulo-grande', 8000);
      const r = await retrato(palco);

      certo(r.topo === e.topo,
        `volta ${volta} · ${e.chave}: o topo diz «${e.topo}»`, String(r.topo));
      certo(r.titulos.length === 1 && r.titulos[0] === e.h1,
        `volta ${volta} · ${e.chave}: um título só, «${e.h1}»`, r.titulos.join(' + '));
      certo(r[e.chave] > 0 && quaisEcras(r) === e.chave,
        `volta ${volta} · ${e.chave}: pinta o seu conteúdo e nada do ecrã anterior`,
        `no ecrã: ${quaisEcras(r)}`);
      certo(r.marcados.join(',') === String(e.pos),
        `volta ${volta} · ${e.chave}: o separador ${e.pos} é o único com aria-current`,
        `marcados: ${r.marcados.join(',') || 'nenhum'}`);
      certo(!r.painel && !r.folha,
        `volta ${volta} · ${e.chave}: sem painéis pendurados por cima`,
        `painel=${r.painel} folha=${r.folha}`);
    }
    nosPorVolta.push((await retrato(palco)).nos);
  }
  await palco.captura('10-cliente-perfil');

  /* O ecrã mudou por baixo de quem usa leitor: o foco tem de ir para o
     conteúdo novo, senão a leitura continua no ecrã que já não existe. */
  const foco = await palco.focado();
  certo(!!foco && foco.etiqueta === 'main',
    'navegar: o foco passa para o conteúdo do ecrã novo', JSON.stringify(foco));

  /* Carregar no separador em que já se está não é navegar: se empurrasse
     histórico, cinco toques distraídos davam cinco toques em voltar para
     sair de um sítio de onde nunca se saiu. */
  const antesRepetido = await retrato(palco);
  for (let i = 0; i < 4; i++) { await palco.clicar(SEP(5)); await dormir(100); }
  const depoisRepetido = await retrato(palco);
  certo(depoisRepetido.comprimento === antesRepetido.comprimento,
    'navegar: tocar cinco vezes no separador onde já se está não empurra histórico',
    `${antesRepetido.comprimento} → ${depoisRepetido.comprimento}`);
  certo(depoisRepetido.perfil > 0 && quaisEcras(depoisRepetido) === 'perfil',
    'navegar: e o ecrã repetido continua inteiro e sozinho',
    `no ecrã: ${quaisEcras(depoisRepetido)}`);

  /* =======================================================================
     Um ecrã novo começa no princípio
     ======================================================================= */

  /* O `irPara` manda a página ao topo de propósito — mas fá-lo com o
     `#principal` já vazio, antes de o conteúdo novo existir. Quem chega a um
     ecrã a meio dele não percebe que chegou: falta-lhe o título, que é a
     única coisa que diz onde está. */
  await palco.clicar(SEP(2));
  await palco.esperar('#principal .cartao-descobrir', 8000);
  const rolagem = await mudarDeEcraRolado(palco, SEP(5), '#principal .identidade-numero');
  await palco.captura('10-ecra-novo-a-meio');

  certo(rolagem.assentou <= 2,
    'mudar de separador com o ecrã anterior rolado: o ecrã novo começa no topo',
    `vinha de ${rolagem.antes}px e assentou em ${rolagem.assentou}px `
    + `(amostras: ${rolagem.amostras.join(', ')}; a barra de cima diz `
    + `rolado=${rolagem.rolado})`);
  certo(rolagem.titulo !== null && rolagem.titulo >= rolagem.barraDeCima - 1,
    'mudar de separador com o ecrã anterior rolado: o título não fica por baixo da barra de cima',
    `título a ${rolagem.titulo}px, barra de cima acaba a ${rolagem.barraDeCima}px`);

  /* =======================================================================
     O cartão aberto — um ecrã que não está na barra
     ======================================================================= */

  await palco.clicar(SEP(1));
  await palco.esperar('#principal .pilha > .cartao', 8000);
  await palco.clicar('#principal .pilha > .cartao:nth-of-type(2)');
  await palco.esperar('#principal .cartao-grande', 8000);

  const noCartao = await retrato(palco);
  certo(noCartao.marcados.length === 0,
    'cartão aberto: nenhum separador da barra se diz o ecrã actual, porque nenhum é',
    `marcados: ${noCartao.marcados.join(',')}`);
  certo(noCartao.marca === 'ecra:cartao',
    'cartão aberto: o histórico ganha a entrada do cartão', String(noCartao.marca));

  const vCartao = await voltar(palco);
  const depoisCartao = await retrato(palco);
  certo(!vCartao.saiu && depoisCartao.carteira > 0 && quaisEcras(depoisCartao) === 'carteira',
    'cartão aberto: voltar fecha o cartão e devolve a carteira',
    `saiu=${vCartao.saiu}, no ecrã: ${quaisEcras(depoisCartao)}`);

  /* =======================================================================
     O painel: botão, Escape e clique fora
     ======================================================================= */

  await palco.clicar(SEP(5));
  await palco.esperar(LINHA_APAGAR, 8000);

  /* --- pelo botão -------------------------------------------------------- */
  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-fantasma');
  certo(await palco.visivel('#painel .painel-folha'),
    'painel: abre e a folha está mesmo à vista');
  certo(await palco.texto('#painel .painel-folha h2') === 'Apagar a conta',
    'painel: com o título de quem o abriu',
    String(await palco.texto('#painel .painel-folha h2')));
  await palco.captura('10-painel');

  /* O foco e a tabulação dentro do painel são assunto do módulo 11, que os
     persegue a sério. Aqui interessa outra coisa: que ele abra, feche e não
     deixe rasto no histórico. */
  await palco.clicar('#painel .btn-fantasma');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'painel: o botão «Afinal não» fecha-o');
  certo(await palco.visivel(LINHA_APAGAR), 'painel: e o perfil fica por baixo, inteiro');

  /* --- pela tecla Escape ------------------------------------------------- */
  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-fantasma');
  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'painel: a tecla Escape fecha-o');

  /* Fechado o painel, o ouvinte da tecla tem de sair com ele: um Escape a
     seguir não pode rebentar nada nem mexer no que está no ecrã. */
  await palco.tecla('Escape');
  const depoisDoEscape = await retrato(palco);
  certo(depoisDoEscape.perfil > 0 && !depoisDoEscape.painel,
    'painel: um Escape com o painel já fechado não faz mal a ninguém',
    `no ecrã: ${quaisEcras(depoisDoEscape)}, painel=${depoisDoEscape.painel}`);

  /* --- por um clique fora ------------------------------------------------ */
  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-fantasma');
  const alvo = await clicarNoVeu(palco);
  certo(String(alvo.quem).includes('painel-veu'),
    'painel: o alto do ecrã é véu — há mesmo onde carregar fora', JSON.stringify(alvo));
  await palco.sumir('#painel', 3000).catch(() => {});
  certo(!(await palco.ver('#painel')), 'painel: um clique fora, no véu, fecha-o');

  /* =======================================================================
     O botão de voltar
     ======================================================================= */

  /* --- voltar com um painel aberto --------------------------------------- */
  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-fantasma');
  const comPainel = await retrato(palco);
  certo(comPainel.marca === 'painel',
    'voltar: abrir um painel deixa a sua marca no histórico, para haver o que desfazer',
    String(comPainel.marca));

  const v1 = await voltar(palco);
  const depoisPainel = await retrato(palco);
  certo(!v1.saiu, 'voltar com painel aberto: a app trata o gesto e não sai do documento',
    `location=${depoisPainel.onde}`);
  certo(!depoisPainel.painel, 'voltar com painel aberto: o painel fecha-se');
  certo(depoisPainel.topo === 'Perfil' && depoisPainel.perfil > 0,
    'voltar com painel aberto: fica-se no mesmo ecrã, o perfil',
    `topo=${depoisPainel.topo}, no ecrã: ${quaisEcras(depoisPainel)}`);
  certo(depoisPainel.marca === 'ecra:perfil',
    'voltar com painel aberto: o histórico fica na entrada do ecrã que se vê',
    String(depoisPainel.marca));

  /* --- voltar com a folha do código aberta ------------------------------- */
  await palco.clicar(CODIGO);
  await palco.esperar('#folha-codigo', 8000);
  const comFolha = await retrato(palco);
  certo(comFolha.folha, 'código: a folha abre por cima do ecrã');
  certo(comFolha.marca === 'codigo',
    'código: abrir a folha deixa a sua marca no histórico', String(comFolha.marca));
  await palco.captura('10-folha-codigo');

  const v2 = await voltar(palco);
  const depoisFolha = await retrato(palco);
  certo(!v2.saiu, 'voltar com a folha do código aberta: a app trata o gesto',
    `location=${depoisFolha.onde}`);
  certo(!depoisFolha.folha, 'voltar com a folha do código aberta: a folha fecha-se');
  certo(depoisFolha.topo === 'Perfil' && depoisFolha.perfil > 0,
    'voltar com a folha do código aberta: o ecrã por baixo continua o mesmo',
    `topo=${depoisFolha.topo}, no ecrã: ${quaisEcras(depoisFolha)}`);
  certo(depoisFolha.marca === 'ecra:perfil',
    'voltar com a folha do código aberta: o histórico volta à entrada do ecrã',
    String(depoisFolha.marca));

  /* --- fechar pelo botão não deixa entrada fantasma ---------------------- */

  /* Abre-se e fecha-se três vezes pelo botão. Se cada fecho deixasse a sua
     entrada para trás, o `history.length` subia três — e os três «voltar»
     seguintes não fariam nada visível. */
  const antesDosTres = await retrato(palco);
  for (let i = 1; i <= 3; i++) {
    await palco.clicar(LINHA_APAGAR);
    await palco.esperar('#painel .btn-fantasma');
    await palco.clicar('#painel .btn-fantasma');
    await palco.sumir('#painel', 3000);
    await dormir(250);
  }
  const depoisDosTres = await retrato(palco);
  certo(depoisDosTres.comprimento === antesDosTres.comprimento,
    'três painéis abertos e fechados pelo botão: o histórico não cresceu',
    `${antesDosTres.comprimento} → ${depoisDosTres.comprimento}`);
  certo(depoisDosTres.marca === 'ecra:perfil',
    'três painéis abertos e fechados pelo botão: a entrada actual é a do ecrã',
    String(depoisDosTres.marca));

  /* E agora o que interessa: um toque em voltar, uma coisa só — a esperada. */
  const v3 = await voltar(palco);
  const depoisDeUmVoltar = await retrato(palco);
  certo(!v3.saiu, 'voltar depois dos três painéis: a app trata o gesto',
    `location=${depoisDeUmVoltar.onde}`);
  certo(v3.voltas === 1,
    'voltar depois dos três painéis: um toque, um passo de histórico',
    `${v3.voltas} passos`);
  certo(depoisDeUmVoltar.topo === 'Carimbo Digital' && depoisDeUmVoltar.carteira > 0,
    'voltar depois dos três painéis: leva à carteira, que é o que se espera',
    `topo=${depoisDeUmVoltar.topo}, no ecrã: ${quaisEcras(depoisDeUmVoltar)}`);
  certo(!depoisDeUmVoltar.painel && !depoisDeUmVoltar.folha,
    'voltar depois dos três painéis: e não abriu nem deixou nada por cima');

  /* --- voltar num ecrã que não é a carteira ------------------------------ */
  await palco.clicar(SEP(2));
  await palco.esperar('#principal .cartao-descobrir', 8000);
  await palco.clicar(SEP(4));
  await palco.esperar('#principal h1.titulo-grande', 8000);

  const v4 = await voltar(palco);
  const daPremios = await retrato(palco);
  certo(!v4.saiu && daPremios.topo === 'Carimbo Digital' && daPremios.carteira > 0,
    'voltar nos prémios: leva à carteira',
    `topo=${daPremios.topo}, no ecrã: ${quaisEcras(daPremios)}`);
  certo(daPremios.marcados.join(',') === '1',
    'voltar nos prémios: a barra passa a marcar a Carteira',
    `marcados: ${daPremios.marcados.join(',') || 'nenhum'}`);

  /* --- voltar na carteira ------------------------------------------------ */

  /* Ficou uma entrada por gastar (a do «descobrir»), por isso este voltar é
     tratado dentro do documento — que é o caso a testar: a carteira é o fim
     da linha da app, e o gesto não pode deixá-la partida. */
  const v5 = await voltar(palco);
  const naCarteira = await retrato(palco);
  certo(!v5.saiu, 'voltar na carteira: continua-se dentro da app',
    `location=${naCarteira.onde}`);
  certo(naCarteira.carteira > 0 && quaisEcras(naCarteira) === 'carteira',
    'voltar na carteira: a carteira continua pintada, e sozinha',
    `no ecrã: ${quaisEcras(naCarteira)}`);
  certo(naCarteira.rotulos.length === 5 && naCarteira.marcados.join(',') === '1',
    'voltar na carteira: a barra fica inteira e com a Carteira marcada',
    `${naCarteira.rotulos.length} separadores, marcados: ${naCarteira.marcados.join(',')}`);

  /* E continua a navegar-se depois disto — é a prova de que nada partiu. */
  await palco.clicar(SEP(5));
  await palco.esperar('#principal .identidade-numero', 8000);
  certo(await palco.texto('#topo-titulo') === 'Perfil',
    'voltar na carteira: a navegação continua a funcionar depois',
    String(await palco.texto('#topo-titulo')));

  /* --- um painel aberto a partir de outro -------------------------------- */

  /* Guardar a conta abre o painel do email e, por cima dele, o do código. O
     segundo `abrirPainel` deita fora o primeiro com `{historico: false}` —
     isto é, sem lhe comer a entrada. É a mesma entrada fantasma que o
     `fecharPainel` tem o cuidado de evitar, pela porta do lado. */
  const antesDoEncadeado = await retrato(palco);
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#campo-email');
  await palco.preencher('#campo-email', 'teste@exemplo.pt');
  await palco.clicar('#botao-enviar');
  await palco.esperar('#campo-codigo', 4000);
  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  const depoisDoEncadeado = await retrato(palco);

  certo(depoisDoEncadeado.marca === 'ecra:perfil',
    'painel dentro de painel: fechado tudo, a entrada actual volta a ser a do ecrã',
    `marca=${depoisDoEncadeado.marca}, e no ecrã não há painel nenhum`);
  /* `history.length` não desce: um `back()` deixa a entrada seguinte lá, à
     espera de um `forward()`. O que se mede é quantas entradas o episódio
     inteiro criou — dois painéis encadeados têm de valer UMA, e não duas.
     Quem prova que o histórico voltou ao sítio é a afirmação de cima, a da
     marca. */
  certo(depoisDoEncadeado.comprimento - antesDoEncadeado.comprimento <= 1,
    'painel dentro de painel: dois painéis encadeados valem uma entrada, não duas',
    `${antesDoEncadeado.comprimento} → ${depoisDoEncadeado.comprimento}`);

  /* =======================================================================
     Sair de um ecrã enquanto ele ainda está a chegar
     ======================================================================= */

  /* `irPara` esvazia o `#principal`, pinta o que sabe e espera pelos dados.
     Quem carregar noutro separador durante essa espera fica com o desenho
     atrasado a assentar no ecrã seguinte — sem nada que o impeça, porque não
     há guarda nenhuma a dizer «este ecrã já não é o actual».

     Na demonstração os dados vêm no mesmo instante, por isso os dois toques
     têm de cair no mesmo fotograma para se ver o que se passa. Com o Worker
     do outro lado a janela é o pedido inteiro: dois toques normais, com a
     rede do costume, chegam lá. */
  await palco.clicar(SEP(1));
  await palco.esperar('#principal .linha.adicionar', 8000);
  await palco.js(`
    const b = [...document.querySelectorAll('.barra-item')];
    b[1].click(); b[3].click();
    await new Promise((r) => setTimeout(r, 700));
    return true`);
  const misturado = await retrato(palco);
  await palco.captura('10-dois-ecras-misturados');
  certo(quaisEcras(misturado) === 'premios',
    'dois separadores seguidos: fica o último, e só o conteúdo dele',
    `topo=${misturado.topo}, título=${misturado.titulos.join('+')}, `
    + `no ecrã: ${quaisEcras(misturado)}`);

  /* =======================================================================
     Fugas — vinte navegações
     ======================================================================= */

  /* Cada `irPara` esvazia o `#principal` e pinta de novo. Se alguma coisa
     ficar agarrada — um véu, um aviso, um cartão do ecrã anterior — o número
     de nós sobe e não volta a descer. Compara-se sempre a carteira com a
     carteira: ecrãs diferentes têm tamanhos diferentes, e a pergunta é sobre
     a tendência, não sobre um valor. */
  const medidas = [];
  for (let i = 0; i < 10; i++) {
    await palco.clicar(SEP(2));
    await palco.esperar('#principal .cartao-descobrir', 8000);
    await palco.clicar(SEP(1));
    await palco.esperar('#principal .linha.adicionar', 8000);
    const r = await retrato(palco);
    medidas.push({ nos: r.nos, corpo: r.corpo });
  }
  const nos = medidas.map((m) => m.nos);
  certo(nos[nos.length - 1] <= nos[0] + 4,
    'vinte navegações: o número de nós da carteira não cresce', nos.join(' → '));
  certo(!(nos.every((n, i) => i === 0 || n >= nos[i - 1]) && nos[nos.length - 1] > nos[0]),
    'vinte navegações: e não há uma subida sistemática, volta após volta', nos.join(' → '));
  certo(medidas.every((m) => m.corpo === medidas[0].corpo),
    'vinte navegações: nada se acumula à solta no fim do body',
    medidas.map((m) => m.corpo).join(' → '));
  certo(nosPorVolta.every((n) => Math.abs(n - nosPorVolta[0]) <= 4),
    'três voltas ao circuito: o perfil pesa sempre o mesmo', nosPorVolta.join(' → '));

  /* =======================================================================
     Balcão — os quatro separadores
     ======================================================================= */

  await entrarNoBalcao(palco);

  const balcao = await retrato(palco);
  certo(balcao.rotulos.join('|') === 'Carimbar|Hoje|Clientes|O cartão',
    'balcão: os quatro separadores, pela ordem', balcao.rotulos.join('|'));
  certo(balcao.marcados.join(',') === '1',
    'balcão: abre no Carimbar, e é esse o marcado',
    `marcados: ${balcao.marcados.join(',') || 'nenhum'}`);

  for (let volta = 1; volta <= 2; volta++) {
    for (const e of ECRAS_BALCAO) {
      await palco.clicar(SEP(e.pos));
      await palco.esperar(e.prova, 12000);
      const r = await retrato(palco);
      certo(r.topo === e.topo,
        `balcão · volta ${volta} · ${e.topo}: o topo diz o nome do ecrã`, String(r.topo));
      certo(e.titulo === null
        ? r.titulos.length === 0
        : r.titulos.length === 1 && r.titulos[0] === e.titulo,
        `balcão · volta ${volta} · ${e.topo}: um título só, e é o seu`,
        r.titulos.join(' + ') || 'sem título');
      certo(r.marcados.join(',') === String(e.pos),
        `balcão · volta ${volta} · ${e.topo}: o separador ${e.pos} é o único com aria-current`,
        `marcados: ${r.marcados.join(',') || 'nenhum'}`);
      /* O visor é a câmara. Ficar um a trabalhar num ecrã de números é a
         lanterna do telemóvel acesa em cima do balcão, a gastar bateria. */
      const visores = await palco.contar('#principal .visor');
      certo(visores === (e.pos === 1 ? 1 : 0),
        `balcão · volta ${volta} · ${e.topo}: o visor da câmara só existe no Carimbar`,
        `visores: ${visores}`);
    }
  }
  await palco.captura('10-balcao');

  /* O balcão tem os ecrãs mais compridos das duas apps — o editor do cartão
     não cabe num telemóvel. Vale a mesma regra: chegar a um ecrã é chegar ao
     princípio dele. */
  await palco.clicar(SEP(4));
  await palco.esperar('#principal #previa', 12000);
  const rolagemBalcao = await mudarDeEcraRolado(palco, SEP(2), '#principal .numeros');
  certo(rolagemBalcao.assentou <= 2,
    'balcão: mudar de separador com o ecrã anterior rolado começa no topo',
    `vinha de ${rolagemBalcao.antes}px e assentou em ${rolagemBalcao.assentou}px `
    + `(amostras: ${rolagemBalcao.amostras.join(', ')})`);

  /* --- o painel do balcão ------------------------------------------------ */

  await palco.clicar(SEP(1));
  await palco.esperar('#botao-manual', 12000);

  await palco.clicar('#botao-manual');
  await palco.esperar('#painel .painel-folha');
  certo(await palco.texto('#painel .painel-folha h2') === 'Número do cartão',
    'balcão: o painel do número do cartão abre',
    String(await palco.texto('#painel .painel-folha h2')));

  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'balcão: a tecla Escape fecha o painel');

  await palco.clicar('#botao-manual');
  await palco.esperar('#painel .painel-folha');
  const alvoBalcao = await clicarNoVeu(palco);
  certo(String(alvoBalcao.quem).includes('painel-veu'),
    'balcão: há véu onde carregar fora do painel', JSON.stringify(alvoBalcao));
  await palco.sumir('#painel', 3000).catch(() => {});
  certo(!(await palco.ver('#painel')), 'balcão: um clique fora fecha o painel');

  /* --- e o botão de voltar, do lado de quem carimba ---------------------- */

  /* Ao balcão há fila e o telemóvel está apoiado no balcão: o gesto de voltar
     é o do sistema, e é o mesmo gesto que do lado do cliente. Com o painel do
     número aberto, tem de fechar o painel — não levar a app embora a meio de
     um atendimento, com o número do cliente escrito a meio. */
  await palco.clicar('#botao-manual');
  await palco.esperar('#painel .painel-folha');
  const balcaoComPainel = await retrato(palco);
  certo(balcaoComPainel.marca === 'painel',
    'balcão: abrir o painel deixa marca no histórico, para o voltar ter o que desfazer',
    `marca=${balcaoComPainel.marca}, history.length=${balcaoComPainel.comprimento}`);

  const v6 = await voltar(palco);
  certo(!v6.saiu,
    'balcão: voltar com o painel aberto não leva a app embora',
    'o separador saiu do /balcao/ — na app instalada é a app a fechar-se');

  if (!v6.saiu) {
    const balcaoDepois = await retrato(palco);
    certo(!balcaoDepois.painel, 'balcão: voltar fecha o painel do número');
    certo(balcaoDepois.topo === 'Carimbar',
      'balcão: e fica-se no ecrã de carimbar', String(balcaoDepois.topo));
  } else {
    await entrarNoBalcao(palco);
  }

  /* =======================================================================
     Balcão — sair do Carimbar enquanto a câmara arranca
     ======================================================================= */

  /* Este é o mesmo defeito do «dois separadores seguidos», mas do lado onde
     dói mais. O `ecraCarimbar` espera pela câmara e, quando ela responde,
     escreve no `#visor-estado` — que já não existe se entretanto se mudou de
     ecrã. Rebenta, e o `irPara` do balcão não tem rede por baixo.

     Aqui a câmara é recusada em cerca de 100 ms, por isso o toque tem de ser
     dado no instante em que a barra nasce; num telemóvel a sério a janela é
     a autorização da câmara, que fica à espera de uma resposta humana. Quem
     abre o balcão e vai ver o «Hoje» enquanto o telemóvel pergunta pela
     câmara está dentro dela.

     O guião entra antes de tudo o resto na página: é a única forma de
     carregar no separador no instante certo. */
  const guiao = await palco.enviar('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const obs = new MutationObserver(() => {
        const b = document.querySelectorAll('.barra-item');
        if (b.length >= 2) { obs.disconnect(); window.__cedo = true; b[1].click(); }
      });
      obs.observe(document, { childList: true, subtree: true });`,
  }, palco.sessao);
  await palco.recarregar();
  await dormir(2500);
  const arranque = await palco.js(`
    const entrada = document.querySelector('#entrada');
    return { cedo: Boolean(window.__cedo),
             entradaAberta: Boolean(entrada) && !entrada.hidden,
             entrou: localStorage.getItem('carimbo-demo:balcao-entrou'),
             topo: document.querySelector('#topo-titulo')?.textContent.trim() ?? null };`);
  await palco.enviar('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: guiao.identifier }, palco.sessao);
  await palco.captura('10-balcao-expulso');

  certo(arranque.cedo, 'balcão: o toque no separador chegou a acontecer',
    JSON.stringify(arranque));
  certo(!arranque.entradaAberta,
    'balcão: sair do Carimbar enquanto a câmara arranca não expulsa para o ecrã de entrada',
    `topo=${arranque.topo}, mas o ecrã de entrada voltou a aparecer por cima`);
  certo(arranque.entrou === 'true',
    'balcão: e não apaga a marca de quem já entrou — em produção isso é ter de entrar outra vez pelo email',
    `carimbo-demo:balcao-entrou = ${arranque.entrou}`);

  /* Deixa-se o balcão a funcionar, para quem vier a seguir. */
  await entrarNoBalcao(palco);
}
