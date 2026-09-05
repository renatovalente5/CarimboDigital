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

export const nome = '05 · Prémios: ganhar, ver e resgatar';

/* O prémio que este teste inventa para o programa do Café Torrado. Nunca
   aparece no código da app nem na semente: se o ecrã o mostrar, é porque o
   texto veio mesmo do programa e não está escrito à mão em lado nenhum. */
const PREMIO_INVENTADO = 'Bica e pastel de nata por conta da casa';

/* --- ferramentas ---------------------------------------------------------- */

/** Passa as boas-vindas e espera pela carteira desenhada. */
async function entrarNaApp(palco) {
  await palco.ir('/app/?demo=1');
  for (let i = 0; i < 8 && (await palco.visivel('#boas-vindas')); i++) {
    await palco.clicar('#bv-seguinte');
  }
  await palco.esperar('#barra');
  await palco.esperar('.pilha .cartao');
}

/* O separador chama-se «Carteira» mas o ecrã intitula-se «Os meus cartões»:
   é pelo título que se sabe que a pintura acabou. */
const TITULOS = { Carteira: 'Os meus cartões', Descobrir: 'Descobrir',
                  Prémios: 'Prémios', Perfil: 'Perfil' };

/** Vai para um separador da barra pelo nome e espera pelo título do ecrã. */
async function irPara(palco, rotulo) {
  const indice = ['Carteira', 'Descobrir', 'Código', 'Prémios', 'Perfil'].indexOf(rotulo) + 1;
  await palco.clicar(`.barra-item:nth-child(${indice})`);
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
  return palco.js(`return [...document.querySelectorAll('#principal .linha-premio')].map((n) => ({
    descricao: n.querySelector('.linha-texto b').textContent.trim(),
    detalhe: n.querySelector('.linha-texto span').textContent.replace(/\\s+/g, ' ').trim(),
    etiqueta: (n.querySelector('.etiqueta') || {}).textContent || null,
  }))`);
}

/* --- o módulo ------------------------------------------------------------- */

export async function correr(palco, certo) {
  await entrarNaApp(palco);

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

  await irPara(palco, 'Prémios');
  await palco.captura('05-premios-um-por-levantar');

  certo((await palco.texto('#topo-titulo')) === 'Prémios',
    'o topo diz «Prémios»', String(await palco.texto('#topo-titulo')));

  const lista1 = await premiosPorLevantar(palco);
  certo(lista1.length === 1,
    'um prémio por resgatar dá uma linha no ecrã',
    `${lista1.length} linhas: ${JSON.stringify(lista1)}`);
  certo(lista1[0] && lista1[0].descricao === 'Taça de três bolas',
    'a linha mostra o prémio do cartão cheio',
    lista1[0] && lista1[0].descricao);
  certo(lista1[0] && lista1[0].detalhe.startsWith('Gelataria Luar ·'),
    'a linha diz de que negócio é e há quanto tempo foi ganho',
    lista1[0] && lista1[0].detalhe);
  certo(lista1[0] && lista1[0].etiqueta.trim() === 'pronto',
    'a linha tem a etiqueta «pronto»', lista1[0] && lista1[0].etiqueta);

  /* Um cartão a meio não é um prémio: o Café Torrado (7 de 10) não pode
     aparecer aqui, nem o texto do prémio que ainda não ganhou. */
  const textoPremios = await palco.texto('#principal');
  certo(!textoPremios.includes('Café Torrado'),
    'o cartão a meio não aparece no ecrã dos prémios',
    textoPremios.slice(0, 200));
  certo(!textoPremios.includes('Um café por conta da casa'),
    'o prémio que ainda não foi ganho não aparece no ecrã dos prémios');

  certo((await palco.contar('#principal .vazio')) === 0,
    'com prémios à espera não se mostra o ecrã de vazio',
    `${await palco.contar('#principal .vazio')} blocos de vazio`);

  /* --- e na carteira, o painel de «pronto» (painelPronto) --------------- */

  await irPara(palco, 'Carteira');
  certo((await palco.contar('.pilha .cartao .pronto')) === 1,
    'na carteira só um cartão mostra o painel de pronto a levantar',
    String(await palco.contar('.pilha .cartao .pronto')));
  certo((await palco.texto('.pilha .cartao .pronto b')) === 'Taça de três bolas',
    'o painel de pronto diz qual é o prémio',
    String(await palco.texto('.pilha .cartao .pronto b')));

  /* O cartão a meio mostra a grelha de carimbos, não o painel. */
  const rotulos = await palco.js(`return [...document.querySelectorAll('.pilha .cartao')]
    .map((n) => n.getAttribute('aria-label'))`);
  const doTorrado = rotulos.find((r) => r.startsWith('Café Torrado'));
  certo(doTorrado === 'Café Torrado. faltam 3 carimbos: Um café por conta da casa.',
    'o cartão a meio anuncia-se como «faltam 3 carimbos», não como pronto',
    String(doTorrado));

  /* =======================================================================
     Fase 2 — abrir o prémio: as instruções para o levantar
     ======================================================================= */

  await irPara(palco, 'Prémios');
  certo(await palco.visivel('#principal > button.btn-cheio'),
    'há um botão para levantar o prémio');
  certo((await palco.texto('#principal > button.btn-cheio')) === 'Mostrar o código para levantar',
    'o botão diz o que faz',
    String(await palco.texto('#principal > button.btn-cheio')));

  await palco.clicar('#principal > button.btn-cheio');
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
  await irPara(palco, 'Prémios');
  await palco.captura('05-premios-dois-por-levantar');

  const lista2 = await premiosPorLevantar(palco);
  certo(lista2.length === 2,
    'os dois prémios por levantar aparecem',
    `${lista2.length}: ${JSON.stringify(lista2)}`);
  certo(lista2.some((l) => l.descricao === PREMIO_INVENTADO),
    'o prémio acabado de ganhar aparece com o texto do programa',
    JSON.stringify(lista2.map((l) => l.descricao)));
  const novo = lista2.find((l) => l.descricao === PREMIO_INVENTADO);
  certo(novo && novo.detalhe === 'Café Torrado · ganho agora mesmo',
    'a linha do prémio novo diz o negócio e que foi ganho agora',
    novo && novo.detalhe);

  /* O painel de pronto do cartão que recomeçou. */
  await irPara(palco, 'Carteira');
  const painel = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .find((c) => (c.getAttribute('aria-label') || '').startsWith('Café Torrado'));
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

  await irPara(palco, 'Prémios');
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

  const seccoes = await palco.textos('#principal .seccao-titulo');
  certo(seccoes.includes('Já levantados'),
    'o prémio entregue aparece na secção «Já levantados»',
    JSON.stringify(seccoes));

  /* =======================================================================
     Fase 5 — depois de recarregar, o ecrã conta a mesma história
     ======================================================================= */

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Prémios');

  const lista4 = await premiosPorLevantar(palco);
  certo(lista4.length === 1 && lista4[0].descricao === 'Taça de três bolas',
    'sobra o prémio que não foi entregue',
    JSON.stringify(lista4.map((l) => l.descricao)));

  const levantados = await palco.js(`
    const t = [...document.querySelectorAll('#principal .seccao')]
      .find((s) => s.querySelector('.seccao-titulo').textContent.trim() === 'Já levantados');
    if (!t) return null;
    return [...t.querySelectorAll('.linha')].map((n) => ({
      titulo: n.querySelector('.linha-texto b').textContent.trim(),
      onde: n.querySelector('.linha-texto span').textContent.trim(),
      quando: n.querySelector('.linha-fim').textContent.trim(),
    }));`);
  certo(levantados && levantados.length === 1
    && levantados[0].titulo === PREMIO_INVENTADO
    && levantados[0].onde === 'Café Torrado',
    'o histórico diz que prémio foi levantado e onde',
    JSON.stringify(levantados));

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
  await irPara(palco, 'Prémios');
  await palco.captura('05-premios-tres-do-mesmo-cartao');

  const lista5 = await premiosPorLevantar(palco);
  certo(lista5.length === 3,
    'os três prémios do mesmo cartão aparecem um a um',
    `${lista5.length}: ${JSON.stringify(lista5.map((l) => l.descricao))}`);
  certo(lista5.filter((l) => l.descricao === PREMIO_COM_HTML).length === 2,
    'o nome do prémio aparece tal e qual, sem o HTML ser interpretado',
    JSON.stringify(lista5.map((l) => l.descricao)));
  certo((await palco.contar('#principal .linha-premio i')) === 0,
    'nenhuma etiqueta nasceu do nome do prémio',
    String(await palco.contar('#principal .linha-premio i')));

  await irPara(palco, 'Carteira');
  await palco.captura('05-carteira-tres-premios-num-cartao');
  const plural = await palco.js(`
    const n = [...document.querySelectorAll('.pilha .cartao')]
      .find((c) => (c.getAttribute('aria-label') || '').startsWith('Gelataria Luar'));
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
  await irPara(palco, 'Prémios');
  await palco.captura('05-premios-tudo-levantado');

  certo((await premiosPorLevantar(palco)).length === 0,
    'com tudo entregue não sobra nenhuma linha de prémio pronto',
    JSON.stringify(await premiosPorLevantar(palco)));
  certo(await palco.visivel('#principal .vazio'),
    'com tudo entregue aparece o ecrã de vazio');
  certo(!(await palco.ver('#principal > button.btn-cheio')),
    'sem prémios por levantar não se oferece o botão de levantar');
  certo((await palco.contar('#principal .seccao .linha')) === 4,
    'o histórico guarda os quatro prémios levantados',
    String(await palco.contar('#principal .seccao .linha')));

  /* =======================================================================
     Fase 8 — o ecrã de quem nunca ganhou nada

     Tira-se do estado tudo o que é prémio: os prémios e os movimentos que
     falam deles. É o que a pessoa vê no dia em que instala a app.
     ======================================================================= */

  await noMotor(palco, `async ({ estado, gravar }) => {
    const e = estado();
    e.premios = [];
    e.movimentos = e.movimentos.filter((m) => m.tipo !== 'resgate' && m.tipo !== 'premio');
    for (const c of e.cartoes) c.premiosGanhos = 0;
    gravar(e);
    return true;
  }`);

  await palco.recarregar();
  await palco.esperar('.pilha .cartao');
  await irPara(palco, 'Prémios');
  await palco.captura('05-premios-vazio');

  certo((await premiosPorLevantar(palco)).length === 0,
    'sem prémios não há linhas nenhumas',
    JSON.stringify(await premiosPorLevantar(palco)));
  certo(await palco.visivel('#principal .vazio'),
    'sem prémios aparece o ecrã de vazio');
  certo((await palco.texto('#principal .vazio h3')) === 'Ainda não há prémios',
    'o vazio explica-se com um título',
    String(await palco.texto('#principal .vazio h3')));
  certo((await palco.texto('#principal .vazio p')).includes('Assim que completares um cartão'),
    'o vazio diz como se ganha um prémio',
    String(await palco.texto('#principal .vazio p')));
  certo((await palco.contar('#principal .vazio-desenho svg')) === 1,
    'o vazio tem o desenho do presente, não um buraco',
    String(await palco.contar('#principal .vazio-desenho svg')));
  certo((await palco.contar('#principal .seccao')) === 0,
    'quem nunca ganhou nada não vê secção de histórico nenhuma',
    String(await palco.contar('#principal .seccao')));
}
