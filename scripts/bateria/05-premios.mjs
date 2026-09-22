/* =========================================================================
   Bateria · 05 — Prémios: ganhar, ver e resgatar

   O ecrã de Prémios é o que justifica a app: é onde a pessoa vê o que
   ganhou. Aqui conduz-se o ciclo inteiro — um cartão a meio, um cartão que
   se completa, o prémio que aparece, as instruções para o levantar, a
   entrega ao balcão, e o ecrã de quando não há prémio nenhum.

   COMO SE PREPARA O ESTADO
   Não se depende do que a semente deixou. Depois de a app arrancar (e de
   já existirem cliente, segredo no cofre e estado de demonstração), mexe-se
   directamente no motor da demonstração — `_fonte/js/api.js`, a partir de
   «Condutor de demonstração» — de duas maneiras:

   · o estado vive em `localStorage['carimbo-demo:demo']` (o espaço das
     chaves é «carimbo-demo:» quando MODO === 'demo'), e lê-se e grava-se
     tal e qual como o motor faz;
   · para GANHAR e para ENTREGAR um prémio não se escreve o resultado à
     mão: importa-se o próprio módulo `/js/api.js` dentro da página e
     chamam-se `api.carimbar()` e `api.resgatar()` — as mesmas funções que
     o balcão chama. Assim o prémio nasce das regras a sério (o objectivo
     do programa, o arrefecimento, o movimento no histórico) e não de um
     objecto inventado por este teste.

   O `carimbar` usa o código manual `M1.<público>`, que é o que o balcão
   escreve à mão quando a câmara não lê — não precisa de assinatura.

   Como o `estado.cartoes` da app só é lido no arranque, depois de mexer no
   motor recarrega-se a página, salvo quando o que se quer testar é
   precisamente o que a app mostra sem recarregar (fase 4).
   ========================================================================= */

import { abrirOCartaoTodo, entrarNaApp } from './01-arranque.mjs';

export const nome = '05 · Prémios: ganhar, ver e resgatar';

/* O prémio que este teste inventa para o programa do Café Torrado. Nunca
   aparece no código da app nem na semente: se o ecrã o mostrar, é porque o
   texto veio mesmo do programa e não está escrito à mão em lado nenhum. */
const PREMIO_INVENTADO = 'Bica e pastel de nata por conta da casa';

/* --- ferramentas ---------------------------------------------------------- */

/** Entra na app e espera pela carteira desenhada. */
async function abrirACarteira(palco) {
  await palco.ir('/app/?demo=1');
  /* O gesto de entrar vive num sítio só: o passeio deixou de dar acesso a
     nada e no fim abre a porta, porque a conta é obrigatória. Uma cópia local
     do gesto antigo continuava a clicar num botão que agora abre um painel — e
     o clique seguinte batia no painel. */
  await entrarNaApp(palco);
  await palco.esperar('#barra .barra-item');
  await palco.esperar('.pilha .cartao');
}

/* O separador chama-se «Carteira» mas o ecrã intitula-se «Os meus cartões»:
   é pelo título que se sabe que a pintura acabou. */
const TITULOS = { Carteira: 'Os meus cartões', Descobrir: 'Descobrir',
                  Prémios: 'Prémios', Perfil: 'Perfil' };

/** Vai para um separador da barra pelo nome e espera pelo título do ecrã. */
async function irPara(palco, rotulo) {
  /* POR NOME, e não por posição. Esta função calculava o índice a partir de
     uma lista de cinco rótulos escrita à mão; no dia em que dois separadores
     saíram, ela passou a clicar no separador errado ou em nenhum. */
  const ecra = { Carteira: 'carteira', Código: 'codigo', Perfil: 'perfil' }[rotulo];
  if (!ecra) throw new Error(`o separador «${rotulo}» já não existe nesta app`);
  await palco.clicar(`.barra-item[data-ecra="${ecra}"]`);
  const limite = Date.now() + 6000;
  for (;;) {
    if ((await palco.texto('#principal h1.titulo-grande')) === TITULOS[rotulo]) return;
    if (Date.now() > limite) throw new Error(`o ecrã «${rotulo}» não chegou a aparecer`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** Lê o estado do motor de demonstração, tal como ele o guarda. */
async function estadoDemo(palco) {
  return palco.js(`return JSON.parse(localStorage.getItem('carimbo-demo:demo') || 'null')`);
}

/**
 * Corre código dentro da página com o motor da demonstração à mão.
 * Recebe `{ api, estado, gravar, publico }` — o `api` é o módulo mesmo, o
 * mesmo objecto que a app usa, importado pelo mesmo endereço.
 */
async function noMotor(palco, corpo) {
  return palco.js(`
    const base = (globalThis.CARIMBO_CONFIG && globalThis.CARIMBO_CONFIG.base) || '';
    const { api } = await import(base + '/js/api.js');
    const publico = JSON.parse(localStorage.getItem('carimbo-demo:cliente')).publico;
    const estado = () => JSON.parse(localStorage.getItem('carimbo-demo:demo'));
    const gravar = (e) => localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
    return await (${corpo})({ api, estado, gravar, publico });
  `);
}

/** As linhas de prémio por levantar, como a pessoa as lê. */
async function premiosPorLevantar(palco) {
  /* LÊ-SE DOS CARTÕES, e não de uma lista.

     Havia um ecrã «Prémios» com uma linha por prémio; ele saiu, e o prémio
     passou a viver no cartão onde foi ganho — que é onde a pessoa já estava a
     olhar. Um cartão com três prémios dá UMA entrada aqui, com a conta: é
     assim que o ecrã o diz, e medir de outra maneira era medir uma coisa que
     não existe. */
  return palco.js(`return [...document.querySelectorAll('.pilha .cartao')]
    .filter((c) => c.querySelector('.pronto'))
    .map((c) => ({
      descricao: c.querySelector('.pronto b').textContent.trim(),
      /* O «.pronto» tem DOIS spans: o do ícone, que é vazio, e o do texto. Um
         «querySelector('span')» apanha o primeiro e mede uma cadeia vazia. */
      detalhe: c.querySelector('.pronto-texto span').textContent.replace(/\\s+/g, ' ').trim(),
      negocio: (c.querySelector('.cartao-nome') || {}).textContent || null,
      quantos: /(\\d+) prémios/.test(c.querySelector('.pronto-texto span').textContent)
        ? Number(RegExp.$1) : 1,
    }))`);
}

/* --- o módulo ------------------------------------------------------------- */

export async function correr(palco, certo) {
  await abrirACarteira(palco);

  /* =======================================================================
     Fase 1 — o que a semente deixou: um cartão cheio e quatro a meio
     ======================================================================= */

  const semente = await estadoDemo(palco);
  const porResgatar = semente.premios.filter((p) => !p.resgatadoEm);
  certo(porResgatar.length === 1,
    'estado de partida: há exactamente um prémio por resgatar',
    `${porResgatar.length} prémios: ${porResgatar.map((p) => p.descricao).join(', ')}`);

  /* O cartão a meio: o Café Torrado tem 7 de 10 na semente. Se algum dia a
     semente mudar, é aqui que se vê — e não numa afirmação misteriosa. */
  const torrado = semente.cartoes.find((c) => c.programaId === 'p-torrado');
  certo(torrado && torrado.carimbos > 0 && torrado.carimbos < 10,
    'estado de partida: o cartão do Café Torrado está a meio',
    `carimbos=${torrado && torrado.carimbos}`);

  await irPara(palco, 'Carteira');
  await palco.captura('05-premios-um-por-levantar');

  /* =======================================================================
     O ECRÃ DOS PRÉMIOS SAIU, e o que ele mostrava vive agora onde a pessoa já
     estava a olhar: a faixa no topo da carteira e o painel dentro do cartão.

     Das seis coisas que aquele ecrã tinha, cinco já estavam aqui; a única que
     se perdeu é a lista dos prémios já levantados, cruzada entre sítios. Estas
     afirmações mudaram de sítio, não de pergunta: continuam a perguntar «o
     prémio ganho vê-se?» e «o cartão a meio não se disfarça de prémio?».
     ======================================================================= */

  certo((await palco.texto('#topo-titulo')) === 'Carimbo Digital',
    'a carteira é onde o prémio aparece', String(await palco.texto('#topo-titulo')));

  const faixa = await palco.texto('#principal .faixa-premio');
  certo(/prémio à espera/i.test(String(faixa)),
    'a faixa no topo da carteira anuncia o prémio ganho', String(faixa));
  certo((await palco.contar('#principal .faixa-premio')) === 1,
    'e é uma só — contam-se prémios, não cartões',
    `${await palco.contar('#principal .faixa-premio')} faixas`);

  /* --- e o painel de «pronto» dentro do cartão --------------------------- */

  certo((await palco.contar('.pilha .cartao .pronto')) === 1,
    'na carteira só um cartão mostra o painel de pronto a levantar',
    String(await palco.contar('.pilha .cartao .pronto')));
  certo((await palco.texto('.pilha .cartao .pronto b')) === 'Taça de três bolas',
    'o painel de pronto diz qual é o prémio',
    String(await palco.texto('.pilha .cartao .pronto b')));

  /* O cartão a meio mostra a grelha de carimbos, não o painel. */
  /* O RÓTULO MUDOU DE SÍTIO: era do cartão inteiro, quando o cartão era um
     botão; passou a ser da faixa, que é o botão que abre o maço. E ganhou o
     nome do programa, porque a faixa também o mostra. */
  const rotulos = await palco.js(`return [...document.querySelectorAll('.pilha .cartao-aba')]
    .map((n) => n.getAttribute('aria-label'))`);
  const doTorrado = rotulos.find((r) => r && r.startsWith('Café Torrado'));
  certo(doTorrado === 'Café Torrado, Cartão do café. faltam 3 carimbos: Um café por conta da casa.',
    'o cartão a meio anuncia-se como «faltam 3 carimbos», não como pronto',
    String(doTorrado));

  /* =======================================================================
     Fase 2 — abrir o prémio: as instruções para o levantar
     ======================================================================= */

  /* O BOTÃO ESTÁ NO CARTÃO, e fora do que expande.

     Com fila à espera, levantar um prémio não pode custar dois toques: a tira
     «Levantar prémio» vive no cartão da carteira, sem ser preciso abri-lo. */
  certo(await palco.visivel('.pilha .cartao .levantar'),
    'há um botão para levantar o prémio, no próprio cartão');
  certo(/Levantar prémio/.test(String(await palco.texto('.pilha .cartao .levantar'))),
    'o botão diz o que faz',
    String(await palco.texto('.pilha .cartao .levantar')));

  await palco.clicar('.pilha .cartao .levantar');
  await palco.esperar('#folha-codigo');
  certo(await palco.visivel('#folha-codigo'),
    'carregar no botão abre mesmo a folha do código');
  await palco.captura('05-premios-instrucoes');

  const instrucoes = await palco.texto('#folha-codigo');
  certo(instrucoes.includes('Mostra ao balcão'),
    'as instruções dizem o que fazer com o código', instrucoes.slice(0, 120));
  certo(instrucoes.includes('Se a câmara não ler'),
    'as instruções cobrem o caso de a câmara não ler', instrucoes.slice(0, 200));

  const numero = await palco.texto('#folha-codigo .codigo-id');
  const publico = (await palco.js(`return JSON.parse(localStorage.getItem('carimbo-demo:cliente')).publico`));
  certo(numero === publico,
    'a folha mostra o número do cartão para o balcão escrever à mão',
    `viu «${numero}», esperava «${publico}»`);
  certo((await palco.contar('#codigo-qr svg')) === 1,
    'o código QR foi mesmo desenhado',
    String(await palco.contar('#codigo-qr svg')));

  await palco.clicar('.codigo-fechar');
  await palco.sumir('#folha-codigo');
  certo(!(await palco.ver('#folha-codigo')), 'a folha do código fecha');

  /* =======================================================================
     Fase 3 — ganhar um prémio, com o texto que o programa disser

     Muda-se o prémio do programa do Café Torrado para uma frase que não
     existe em lado nenhum, e completa-se o cartão pelo motor (7 + 5 = 12
     num objectivo de 10: sobra um prémio e ficam 2 carimbos do cartão
     seguinte, que é o que faz aparecer a linha do recomeço).
     ======================================================================= */

  const ganho = await noMotor(palco, `async ({ api, estado, gravar, publico }) => {
    const e = estado();
    for (const n of e.negocios) {
      for (const p of n.programas) if (p.id === 'p-torrado') p.premio = ${JSON.stringify(PREMIO_INVENTADO)};
    }
    gravar(e);
    const r = await api.carimbar({ codigo: 'M1.' + publico, programaId: 'p-torrado', quantidade: 5 });
    return { ganhos: r.ganhos.map((g) => g.descricao), carimbos: r.cartao.carimbos,
             porResgatar: r.cartao.porResgatar };
  }`);
  certo(ganho.ganhos.length === 1 && ganho.ganhos[0] === PREMIO_INVENTADO,
    'o motor dá o prémio com a descrição que está no programa',
    JSON.stringify(ganho));
  certo(ganho.carimbos === 2,
    'sobram 2 carimbos para o cartão seguinte', String(ganho.carimbos));

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Carteira');
  await palco.captura('05-premios-dois-por-levantar');

  const lista2 = await premiosPorLevantar(palco);
  certo(lista2.length === 2,
    'os dois prémios por levantar aparecem',
    `${lista2.length}: ${JSON.stringify(lista2)}`);
  certo(lista2.some((l) => l.descricao === PREMIO_INVENTADO),
    'o prémio acabado de ganhar aparece com o texto do programa',
    JSON.stringify(lista2.map((l) => l.descricao)));
  const novo = lista2.find((l) => l.descricao === PREMIO_INVENTADO);
  certo(novo && novo.negocio === 'Café Torrado',
    'o prémio novo aparece no cartão do negócio onde foi ganho — e não numa lista à parte',
    novo && novo.detalhe);

  /* O painel de pronto do cartão que recomeçou. */
  await irPara(palco, 'Carteira');
  const painel = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .find((c) => (c.querySelector('.cartao-aba')?.getAttribute('aria-label') || '')
        .startsWith('Café Torrado'));
    if (!n) return null;
    const p = n.querySelector('.pronto');
    return {
      temPainel: !!p,
      premio: p ? p.querySelector('b').textContent.trim() : null,
      grelha: !!n.querySelector('.carimbos'),
      recomeco: n.querySelector('.recomeco')
        ? n.querySelector('.recomeco').textContent.replace(/\\s+/g, ' ').trim() : null,
      recomecoCheios: n.querySelectorAll('.recomeco-ponto[data-cheio="sim"]').length,
    };`);
  certo(painel && painel.temPainel && painel.premio === PREMIO_INVENTADO,
    'o cartão completo troca a grelha pelo painel com o prémio',
    JSON.stringify(painel));
  certo(painel && !painel.grelha,
    'o cartão pronto já não mostra a grelha de carimbos (que estaria vazia)',
    JSON.stringify(painel));
  certo(painel && painel.recomeco === 'e já levas 2 do cartão seguinte'
    && painel.recomecoCheios === 2,
    'o painel diz, em voz baixa, quanto já leva do cartão seguinte',
    JSON.stringify(painel));

  /* =======================================================================
     Fase 4 — o balcão entrega o prémio com a app aberta

     É o caso real: a pessoa mostra o código, o balcão resgata, e a app do
     cliente continua aberta na mão dela.
     ======================================================================= */

  const entregue = await noMotor(palco, `async ({ api, estado }) => {
    const p = estado().premios.find((x) => !x.resgatadoEm
      && x.descricao === ${JSON.stringify(PREMIO_INVENTADO)});
    const r = await api.resgatar({ premioId: p.id, operador: 'Balcão' });
    return { resgatadoEm: r.premio.resgatadoEm, porResgatar: r.cartao.porResgatar };
  }`);
  certo(!!entregue.resgatadoEm && entregue.porResgatar === 0,
    'o motor marca o prémio como entregue',
    JSON.stringify(entregue));

  await irPara(palco, 'Carteira');
  await palco.captura('05-premios-depois-de-entregue');

  /* ESTA AFIRMAÇÃO REPROVA, e é para ficar assim.
     `ecraPremios` lê os prémios por levantar de `estado.cartoes`, que só é
     preenchido no arranque da app, mas lê o histórico com `api.cartao()`,
     que vai buscar os dados frescos. Resultado: o mesmo prémio aparece duas
     vezes no mesmo ecrã — em cima com a etiqueta «pronto», em baixo em «Já
     levantados». Ver a fotografia 05-premios-depois-de-entregue.png. */
  const lista3 = await premiosPorLevantar(palco);
  certo(!lista3.some((l) => l.descricao === PREMIO_INVENTADO),
    'um prémio já entregue deixa de aparecer como pronto a levantar',
    `ainda lá está: ${JSON.stringify(lista3.map((l) => l.descricao))}`);

  /* A SECÇÃO «JÁ LEVANTADOS» SAIU com o ecrã dos Prémios. O que sobra — e é o
     que interessa — é o cartão deixar de anunciar um prémio que já foi
     entregue. O histórico daquele café continua dentro do cartão dele. */
  const seccoes = await palco.textos('#principal .seccao-titulo');
  certo(!seccoes.includes('Já levantados'),
    'não há secção «Já levantados» — ela vivia no ecrã que saiu',
    JSON.stringify(seccoes));

  /* =======================================================================
     Fase 5 — depois de recarregar, o ecrã conta a mesma história
     ======================================================================= */

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Carteira');

  const lista4 = await premiosPorLevantar(palco);
  certo(lista4.length === 1 && lista4[0].descricao === 'Taça de três bolas',
    'sobra o prémio que não foi entregue',
    JSON.stringify(lista4.map((l) => l.descricao)));

  /* O HISTÓRICO MUDOU DE CASA. Havia uma secção «Já levantados» no ecrã dos
     Prémios, cruzada entre sítios; ela saiu com o ecrã, e é a única coisa que
     esta mudança deitou fora de verdade. O que fica — e é onde a pessoa vai
     procurar — é o histórico DENTRO do cartão daquele café. */
  const cartaoDoTorrado = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .findIndex((c) => /Café Torrado/.test(
        c.querySelector('.cartao-aba')?.getAttribute('aria-label') || ''));
    return n + 1`);
  await abrirOCartaoTodo(palco, cartaoDoTorrado);
  const levantados = await palco.texto('#principal');
  certo(String(levantados).includes(PREMIO_INVENTADO),
    'o histórico do cartão diz que prémio foi levantado',
    String(levantados).slice(0, 160));
  await palco.clicar('#principal .voltar');
  await palco.esperar('.pilha .cartao', 8000);

  /* =======================================================================
     Fase 6 — dois prémios do mesmo cartão, e um prémio com HTML no nome

     O nome do prémio é escrito pelo comerciante no balcão. Se algum dia
     for pintado com innerHTML em vez de textContent, um `<i>` no nome
     passa a ser uma etiqueta e não uma palavra — e o que entra a seguir
     já não é só um itálico. Aqui prova-se que continua a ser texto.

     De caminho, o cartão da Gelataria passa a ter três prémios à espera:
     é o ramo do plural do painelPronto, que de outra forma nunca corre.
     ======================================================================= */

  const PREMIO_COM_HTML = 'Gelado grátis <i>já</i>';
  const tres = await noMotor(palco, `async ({ api, estado, gravar, publico }) => {
    const e = estado();
    for (const n of e.negocios) {
      for (const p of n.programas) if (p.id === 'p-gelato') p.premio = ${JSON.stringify(PREMIO_COM_HTML)};
    }
    gravar(e);
    /* 18 carimbos num objectivo de 9: dois prémios de uma vez. */
    const r = await api.carimbar({ codigo: 'M1.' + publico, programaId: 'p-gelato', quantidade: 18 });
    return { ganhos: r.ganhos.length, porResgatar: r.cartao.porResgatar };
  }`);
  certo(tres.ganhos === 2 && tres.porResgatar === 3,
    'o cartão da Gelataria fica com três prémios à espera',
    JSON.stringify(tres));

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Carteira');
  await palco.captura('05-premios-tres-do-mesmo-cartao');

  /* TRÊS PRÉMIOS NO MESMO CARTÃO. Não há lista onde os contar um a um — o
     cartão di-lo em palavras e o botão diz quantos são, que é o que a pessoa
     precisa de saber ao balcão. */
  /* O CARTÃO CERTO, e não «o primeiro que tiver painel». Há mais do que um
     cartão pronto nesta altura do módulo, e apanhar o primeiro media o prémio
     errado — que foi exactamente o que aconteceu. */
  const daGelataria = await palco.js(`
    const c = [...document.querySelectorAll('.pilha .cartao')]
      .find((x) => /Gelataria/.test((x.querySelector('.cartao-nome') || {}).textContent || ''));
    if (!c) return { erro: 'sem cartão da Gelataria',
                     nomes: [...document.querySelectorAll('.cartao-nome')].map((n) => n.textContent) };
    if (!c.querySelector('.pronto')) return { erro: 'o cartão não tem painel de pronto',
                                              corpo: c.textContent.slice(0, 120) };
    return { conta: c.querySelector('.pronto-texto span').textContent.trim(),
             nome: c.querySelector('.pronto b').textContent.trim(),
             botao: (c.querySelector('.levantar') || {}).textContent || null,
             etiquetas: c.querySelectorAll('.pronto i').length }`);
  const trioNoCartao = daGelataria && daGelataria.conta;
  certo(/3 prémios/.test(String(trioNoCartao)),
    'o cartão diz quantos prémios estão à espera', String(trioNoCartao));
  certo(/Levantar 3 prémios/.test(String(daGelataria && daGelataria.botao)),
    'e o botão também — quem está ao balcão precisa de saber quantos vai levantar',
    String(daGelataria && daGelataria.botao));

  /* O NOME DO PRÉMIO É ESCRITO PELO COMERCIANTE, e esta é a guarda que impede
     um `<i>` no nome de virar itálico — ou coisa pior.

     ELA MUDOU DE SELECTOR, e é isso que a mantém viva: contava
     `#principal .linha-premio i`, e essa linha saiu com o ecrã dos Prémios.
     Uma guarda que conta zero num selector que já não existe PASSA sempre, e
     deixa de provar o que dizia provar. Agora conta no sítio onde o nome é
     realmente pintado. */
  /* O PAINEL MOSTRA O PRÉMIO MAIS ANTIGO — o primeiro da fila, que neste cartão
     é o da semente e não os dois que este teste acabou de criar. Está certo: é
     esse que a pessoa vai levantar primeiro. O que se prova aqui é outra
     coisa: que o nome com HTML chega ao ecrã como TEXTO. */
  const naGelataria = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .findIndex((c) => /Gelataria/.test((c.querySelector('.cartao-nome') || {}).textContent || ''));
    return n + 1`);
  await abrirOCartaoTodo(palco, naGelataria);
  const noCartao = String(await palco.texto('#principal'));
  certo(noCartao.includes(PREMIO_COM_HTML),
    'o nome do prémio aparece tal e qual, sem o HTML ser interpretado',
    noCartao.slice(0, 200));
  certo((await palco.contar('#principal i')) === 0,
    'e nenhuma etiqueta nasceu dele no ecrã do cartão — é aqui que os três se vêem',
    String(await palco.contar('#principal i')));
  await palco.clicar('#principal .voltar');
  await palco.esperar('.pilha .cartao', 8000);
  certo(daGelataria && daGelataria.etiquetas === 0,
    'nenhuma etiqueta nasceu do nome do prémio',
    String(daGelataria && daGelataria.etiquetas));

  await irPara(palco, 'Carteira');
  await palco.captura('05-carteira-tres-premios-num-cartao');
  const plural = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .find((c) => (c.querySelector('.cartao-aba')?.getAttribute('aria-label') || '')
        .startsWith('Gelataria Luar'));
    const p = n && n.querySelector('.pronto');
    return { premio: p ? p.querySelector('b').textContent.trim() : null,
             linha: p ? p.querySelector('.pronto-texto span').textContent.trim() : null,
             faixa: ((document.querySelector('.faixa-premio') || {}).textContent || '')
               .replace(/\\s+/g, ' ').trim() };`);
  certo(plural.premio === 'Taça de três bolas' && plural.linha === '3 prémios à espera',
    'o painel do cartão conta os prémios em vez de dizer «mostra o código»',
    JSON.stringify(plural));
  /* ESTA AFIRMAÇÃO REPROVA, e é para ficar assim.
     A faixa fala de prémios («Tens um prémio à espera») mas conta cartões:
     `ecraCarteira` filtra `estado.cartoes` por `porResgatar` e usa o
     comprimento dessa lista. Quem tem três prémios no mesmo cartão lê «um
     prémio» com o cartão logo por baixo a dizer «3 prémios à espera». */
  certo(plural.faixa.includes('Tens 3 prémios à espera'),
    'a faixa da carteira conta prémios, não cartões',
    plural.faixa);

  /* =======================================================================
     Fase 7 — entregar tudo: o ecrã de quem já levantou o que tinha
     ======================================================================= */

  const varridos = await noMotor(palco, `async ({ api, estado }) => {
    const porLevantar = estado().premios.filter((p) => !p.resgatadoEm);
    for (const p of porLevantar) await api.resgatar({ premioId: p.id, operador: 'Balcão' });
    return porLevantar.length;
  }`);
  certo(varridos === 3, 'entregaram-se os três que faltavam', String(varridos));

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Carteira');
  await palco.captura('05-premios-tudo-levantado');

  /* =======================================================================
     COM TUDO ENTREGUE, a carteira volta a ser uma carteira.

     O ecrã dos Prémios tinha um vazio próprio («Ainda não há prémios») e um
     histórico dos já levantados. Saiu, e com ele o histórico cruzado entre
     sítios — é a única coisa que esta mudança deitou fora de verdade. O que
     fica é a pergunta que interessa: quando não há nada para levantar, a app
     não pode continuar a dizer que há.
     ======================================================================= */

  certo((await palco.contar('#principal .faixa-premio')) === 0,
    'com tudo entregue a faixa do topo desaparece',
    `${await palco.contar('#principal .faixa-premio')} faixas`);
  certo((await palco.contar('.pilha .cartao .pronto')) === 0,
    'e nenhum cartão continua a dizer que tem prémio pronto',
    `${await palco.contar('.pilha .cartao .pronto')} painéis`);
  certo(!(await palco.ver('.pilha .cartao .levantar')),
    'e o botão de levantar sai com eles — um botão que não tem o que levantar é um engano à espera');
  certo((await palco.contar('.pilha .cartao')) > 0,
    'mas os cartões continuam todos lá, com os carimbos que têm',
    `${await palco.contar('.pilha .cartao')} cartões`);

  /* E O HISTÓRICO DE CADA CARTÃO continua a guardar o que foi levantado — é
     dentro do cartão que ele vive, que é onde a pessoa vai procurar «quando é
     que levantei o meu café». */
  /* O CARTÃO ONDE A ENTREGA ACONTECEU, e não «o primeiro». Foi no Café Torrado
     que este módulo entregou um prémio; abrir o primeiro da lista media um
     cartão onde nunca se entregou nada. */
  const ondeSeEntregou = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .findIndex((c) => /Café Torrado/.test((c.querySelector('.cartao-nome') || {}).textContent || ''));
    return n + 1`);
  await abrirOCartaoTodo(palco, ondeSeEntregou);
  const historico = await palco.texto('#principal');
  certo(String(historico).includes(PREMIO_INVENTADO),
    'e o histórico do cartão continua a dizer o que lá foi levantado',
    String(historico).slice(0, 200));
}
