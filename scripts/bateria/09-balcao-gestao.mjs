/* =========================================================================
   Bateria · 09 — Balcão: Hoje, Clientes e O cartão

   O separador de carimbar é o que se usa mil vezes por dia; estes três são
   os que se usam uma vez por mês — e é por isso que ninguém repara quando
   avariam. Um número errado no «Hoje» leva o dono do café a decidir mal; um
   objectivo mal gravado em «O cartão» muda o cartão de toda a gente.

   Cinco coisas que este módulo persegue de propósito:

   · OS NÚMEROS CONTRA OS DADOS. O «Hoje» tem quatro caixas com um número
     cada. Não chega ver que lá está um algarismo: semeia-se uma demonstração
     com uma resposta conhecida — cinco cartões, dois carimbos hoje, um
     prémio por levantar — e conferem-se os quatro. Um rótulo trocado com
     outro passa por qualquer teste que só procure «não é NaN».

   · O QUE NÃO É DESTE NEGÓCIO. Semeia-se também um cartão de outro
     comerciante, com carimbo de hoje e prémio por levantar. Se o resumo o
     contar, os números do dono do café passam a incluir os do vizinho.

   · A PRÉ-VISUALIZAÇÃO PROMETE «É ASSIM QUE OS CLIENTES O VÊEM». Isso é uma
     afirmação verificável: a app do cliente tem a sua própria regra para o
     número de colunas da grelha (app.js, `GRELHA`), e o desenho do balcão
     tem outra. Escreve-se aqui a regra do cliente, de raiz, e comparam-se.

   · O QUE O FORMULÁRIO TEM DE RECUSAR. Objectivo 0, 1, 99, vazio, letras.
     Não basta ver o aviso: prova-se que NADA saiu — o nome do negócio é
     mudado ao mesmo tempo, e se ele chegar ao armazenamento é porque o
     primeiro dos dois pedidos partiu antes da validação.

   · TROCAR DE SEPARADOR NO PIOR MOMENTO. O balcão abre no ecrã de carimbar,
     e esse ecrã fica à espera da câmara. Tocar noutro separador nesses
     segundos é o gesto mais natural do mundo — e é o que se prova no fim,
     com o `getUserMedia` travado por este teste até ele mandar.

   Corre em modo de demonstração, onde os dados vivem no localStorage e as
   regras são as mesmas do Worker.
   ========================================================================= */

export const nome = '09 · Balcão: Hoje, Clientes e O cartão';
export const desculpar = [/favicon/];

const SEPARADOR = {
  carimbar: '#barra .barra-item:nth-child(1)',
  hoje: '#barra .barra-item:nth-child(2)',
  clientes: '#barra .barra-item:nth-child(3)',
  programa: '#barra .barra-item:nth-child(4)',
};
const MARCADOR = {
  carimbar: '#principal .visor',
  hoje: '#principal .numeros',
  clientes: '#principal .lista, #principal .vazio',
  programa: '#previa',
};

const GUARDAR = '#principal .btn-cheio';
const CARTAZ = '#principal .btn-suave';

/* =========================================================================
   Ajudas
   ========================================================================= */

const dormir = (palco, ms) =>
  palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);

/* --- avisos ---------------------------------------------------------------
   O `avisar()` do núcleo deita fora o aviso anterior antes de pôr o novo, e
   os dois são iguais por fora. Marca-se o que já lá está para se saber que
   apareceu um NOVO — senão um formulário que não responde parece responder,
   porque sobrou o aviso da tentativa anterior.
   ------------------------------------------------------------------------- */

const marcarAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.dataset.visto = 'sim'; return true");

async function avisoNovo(palco, tecto = 8000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const t = await palco.texto('.aviso:not([data-visto])');
    if (t) return t;
    if (Date.now() > limite) return null;
    await dormir(palco, 120);
  }
}

/* Um aviso vive 4,2 segundos por cima da parte de baixo do ecrã. Depois de
   lido tira-se do caminho: enquanto lá estiver, o palco recusa-se a carregar
   no que ele tapa — tal como o dedo de uma pessoa não lhe chegaria. Que ele
   tapa ou não o botão é medido à parte, como afirmação própria. */
const limparAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.remove(); return true");

/** Quem está mesmo no ponto onde o dedo cairia. */
const quemTapa = (palco, seletor) => palco.js(`
  const alvo = document.querySelector(${JSON.stringify(seletor)});
  if (!alvo) return 'não existe';
  const r = alvo.getBoundingClientRect();
  const em = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (!em) return 'fora do ecrã';
  if (em === alvo || alvo.contains(em) || em.contains(alvo)) return null;
  return em.tagName.toLowerCase() + (typeof em.className === 'string' && em.className
    ? '.' + em.className.trim().split(/\\s+/).join('.') : '');`);

const desactivado = (palco, seletor) => palco.js(
  `const n = document.querySelector(${JSON.stringify(seletor)});
   return n ? !!n.disabled : null`);

/* O `focado()` do palco devolve etiqueta e classe, e os campos deste
   formulário não têm nem uma nem outra — distinguem-se pelo `id`. */
const focadoId = (palco) => palco.js(
  `const a = document.activeElement;
   return a && a !== document.body ? (a.id || a.tagName.toLowerCase()) : null`);

/** Põe o elemento à vista, como faz o dedo de quem rola a página até ele. */
const rolarAte = (palco, seletor) => palco.js(
  `document.querySelector(${JSON.stringify(seletor)})
     ?.scrollIntoView({ block: 'center', behavior: 'instant' });
   await new Promise((r) => requestAnimationFrame(r));
   return true`);

/* --- o estado da demonstração --------------------------------------------- */

/** O negócio do balcão, tal como está gravado. */
const negocioGravado = (palco) => palco.js(
  `const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
   const n = e.negocios.find((x) => x.id === 'n-torrado');
   return { nome: n.nome, cor: n.cor, slug: n.slug, programa: n.programas[0] }`);

/* --- a câmara -------------------------------------------------------------
   O ecrã de carimbar fica à espera do `getUserMedia` antes de acabar de se
   desenhar. Sair dele a meio dessa espera rebenta o `ecraCarimbar` — está
   provado no fim deste módulo, e é por isso que em todo o resto se espera
   que a câmara desista antes de tocar noutro separador.
   ------------------------------------------------------------------------- */

async function esperarCamara(palco, tecto = 15000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const t = await palco.texto('#visor-estado');
    if (t !== null && !/A ligar a câmara/.test(t)) return t;
    if (Date.now() > limite) throw new Error(`a câmara ficou a ligar mais de ${tecto} ms`);
    await dormir(palco, 150);
  }
}

/** Entra no balcão em demonstração e espera que o ecrã de carimbar assente. */
async function entrarNoBalcao(palco) {
  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 10000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);
  await esperarCamara(palco);
}

async function irAo(palco, qual) {
  await palco.clicar(SEPARADOR[qual]);
  await palco.esperar(MARCADOR[qual], 8000);
  if (qual === 'carimbar') await esperarCamara(palco);
}

/* --- leituras de ecrã ------------------------------------------------------ */

/** As quatro caixas do «Hoje», pelo rótulo. */
const lerNumeros = (palco) => palco.js(`
  return [...document.querySelectorAll('#principal .numero')].map((n) => ({
    rotulo: n.querySelector('.numero-rotulo')?.textContent.trim() ?? null,
    valor: n.querySelector('b')?.textContent.trim() ?? null,
  }));`);

/** As linhas do «Clientes». */
const lerClientes = (palco) => palco.js(`
  return [...document.querySelectorAll('#principal .lista > .linha')].map((l) => ({
    publico: l.querySelector('.linha-texto b')?.textContent.trim() ?? null,
    mono: !!l.querySelector('.linha-texto b.mono'),
    detalhe: l.querySelector('.linha-texto span')?.textContent.trim() ?? null,
    etiqueta: l.querySelector('.etiqueta')?.textContent.trim() ?? null,
  }));`);

/** O que a pré-visualização está a desenhar neste momento. */
const lerPrevia = (palco) => palco.js(`
  const p = document.querySelector('#previa');
  if (!p) return null;
  const grelha = p.querySelector('.carimbos');
  const primeiro = p.querySelector('.carimbo svg');
  return {
    nome: p.querySelector('.cartao-nome')?.textContent.trim() ?? null,
    tipo: p.querySelector('.cartao-tipo')?.textContent.trim() ?? null,
    rotulo: p.querySelector('.cartao-rotulo')?.textContent.trim() ?? null,
    premio: p.querySelector('.cartao-premio')?.textContent.trim() ?? null,
    casas: grelha ? grelha.querySelectorAll('.carimbo').length : null,
    cheias: grelha ? grelha.querySelectorAll('.carimbo[data-estado="cheio"]').length : null,
    colunas: grelha ? Number(getComputedStyle(grelha).getPropertyValue('--colunas')) : null,
    colunasPintadas: grelha
      ? getComputedStyle(grelha).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : null,
    selo: primeiro ? primeiro.innerHTML : null,
    m: p.style.getPropertyValue('--m').trim(),
    mTxt: p.style.getPropertyValue('--m-txt').trim(),
  };`);

const lerCampos = (palco) => palco.js(`
  const v = (s) => document.querySelector(s)?.value ?? null;
  return {
    nome: v('#f-nome'), programa: v('#f-programa'), premio: v('#f-premio'),
    objetivo: v('#f-objetivo'), regras: v('#f-regras'),
    corActiva: document.querySelector('.paleta-cor[data-ativo="sim"]')?.getAttribute('aria-label') ?? null,
    seloActivo: document.querySelector('.selo-opcao[data-ativo="sim"]')?.getAttribute('aria-label') ?? null,
  };`);

/* --- a regra das colunas da app do cliente --------------------------------
   Escrita outra vez, de raiz, a partir de _fonte/app/app.js. Se o balcão
   promete «é assim que os clientes o vêem», isto é o «assim».
   ------------------------------------------------------------------------- */

const GRELHA_CLIENTE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 3, 7: 4, 8: 4, 9: 3, 10: 5,
                         11: 4, 12: 4, 13: 5, 14: 5, 15: 5, 16: 4, 18: 6, 20: 5,
                         24: 6, 25: 5, 30: 6 };
const colunasDoCliente = (n) => GRELHA_CLIENTE[n] || (n <= 12 ? 4 : 5);

/* --- contraste, medido de raiz (WCAG 2) ----------------------------------- */

function corParaRGB(css) {
  const t = String(css).trim();
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
             b: parseInt(h.slice(4, 6), 16) };
  }
  const n = t.match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  return { r: +n[0], g: +n[1], b: +n[2] };
}

function razao(a, b) {
  const canal = (v) => { const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luz = ({ r, g, b }) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
  const la = luz(a), lb = luz(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* =========================================================================
   A semente

   Uma demonstração com uma resposta conhecida. Os instantes são calculados
   no relógio da PÁGINA — calculá-los aqui e mandá-los para lá punha as duas
   pontas a discordar por causa do fuso.

   Café Torrado (n-torrado, 10 carimbos) fica com cinco cartões:
     A  8/10, carimbado agora, aderiu há 5 dias   → novo em 30 dias, quase lá
     B  9/10, última visita há 3 dias, prémio já levantado → quase lá
     C  0/10, última visita ontem, prémio POR levantar
     D  2/10, nunca voltou (sem última visita)
     E  4/10, última visita há 90 dias            → a fugir
   E a Barbearia Navalha fica com um cartão carimbado hoje e um prémio por
   levantar, que não pode aparecer em número nenhum deste balcão.
   ========================================================================= */

const SEMENTE = `
  const chave = 'carimbo-demo:demo';
  const e = JSON.parse(localStorage.getItem(chave));
  const agora = Date.now();
  const quando = (dias) => new Date(agora - dias * 86400000).toISOString();

  e.clientes = [
    { id: 'cl-a', publico: 'A2C4E6', criadoEm: quando(5), nome: null, email: null },
    { id: 'cl-b', publico: 'F7H9K2', criadoEm: quando(200), nome: null, email: null },
    { id: 'cl-c', publico: 'L3M4N6', criadoEm: quando(60), nome: null, email: null },
    { id: 'cl-d', publico: 'P7Q9R2', criadoEm: quando(400), nome: null, email: null },
    { id: 'cl-e', publico: 'T4U6V7', criadoEm: quando(300), nome: null, email: null },
    { id: 'cl-f', publico: 'W9X2Y3', criadoEm: quando(10), nome: null, email: null },
  ];

  const cartao = (id, clienteId, programaId, negocioId, carimbos, ultimo, aderiu) => ({
    id, clienteId, programaId, negocioId, carimbos, pontos: 0,
    totalCarimbos: carimbos, premiosGanhos: 0,
    aderiuEm: quando(aderiu), ultimoEm: ultimo === null ? null : quando(ultimo),
  });

  e.cartoes = [
    cartao('ct-a', 'cl-a', 'p-torrado', 'n-torrado', 8, 0, 5),
    cartao('ct-b', 'cl-b', 'p-torrado', 'n-torrado', 9, 3.2, 200),
    cartao('ct-c', 'cl-c', 'p-torrado', 'n-torrado', 0, 1.2, 60),
    cartao('ct-d', 'cl-d', 'p-torrado', 'n-torrado', 2, null, 400),
    cartao('ct-e', 'cl-e', 'p-torrado', 'n-torrado', 4, 90, 300),
    cartao('ct-x', 'cl-f', 'p-navalha', 'n-navalha', 7, 0, 10),
  ];

  const mov = (cartaoId, dias) => ({
    id: 'mv-' + Math.random().toString(16).slice(2), cartaoId,
    tipo: 'carimbo', quantidade: 1, operador: 'Balcão', em: quando(dias),
  });

  e.movimentos = [
    mov('ct-a', 0), mov('ct-a', 0), mov('ct-a', 4), mov('ct-a', 9),
    mov('ct-b', 3.2), mov('ct-c', 1.2), mov('ct-e', 90),
    mov('ct-x', 0),
  ];

  e.premios = [
    { id: 'pr-1', cartaoId: 'ct-c', descricao: 'Um café por conta da casa',
      ganhoEm: quando(1.2), resgatadoEm: null },
    { id: 'pr-2', cartaoId: 'ct-b', descricao: 'Um café por conta da casa',
      ganhoEm: quando(20), resgatadoEm: quando(10) },
    { id: 'pr-3', cartaoId: 'ct-x', descricao: 'Corte + barba grátis',
      ganhoEm: quando(1), resgatadoEm: null },
  ];
  e.usados = {};

  localStorage.setItem(chave, JSON.stringify(e));
  return true;
`;

/* O que o «Hoje» tem de dizer depois da semente acima. */
const ESPERADO = {
  'Carimbos hoje': '2',
  Clientes: '5',
  'Novos (30 dias)': '1',
  'Prémios por levantar': '1',
};

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  await entrarNoBalcao(palco);

  /* =======================================================================
     Os quatro separadores, com o balcão ainda vazio
     ======================================================================= */

  certo(await palco.texto('#topo-titulo') === 'Carimbar',
    'entrada: o balcão abre no ecrã de carimbar', String(await palco.texto('#topo-titulo')));

  const rotulos = await palco.textos('#barra .barra-item');
  certo(rotulos.join('|') === 'Carimbar|Hoje|Clientes|O cartão',
    'barra: os quatro separadores estão lá e por esta ordem', rotulos.join('|'));

  /* Um separador marcado é o único sinal de onde a pessoa está. Dois
     marcados, ou nenhum, e o balcão perde-se dentro da própria app. */
  const marcado = () => palco.js(`
    const b = [...document.querySelectorAll('#barra .barra-item')];
    const marcados = b.filter((n) => n.getAttribute('aria-current') === 'page');
    return { quantos: marcados.length,
             qual: marcados[0] ? marcados[0].textContent.trim() : null };`);

  let m = await marcado();
  certo(m.quantos === 1 && m.qual === 'Carimbar',
    'barra: só o separador aberto está marcado como página actual', JSON.stringify(m));

  /* --- Hoje, sem um único cliente --------------------------------------- */

  await irAo(palco, 'hoje');
  await palco.captura('09-hoje-vazio');

  certo(await palco.texto('#topo-titulo') === 'Hoje'
    && await palco.texto('#principal h1.titulo-grande') === 'Hoje',
    'Hoje: o topo e o título dizem os dois «Hoje»',
    `${await palco.texto('#topo-titulo')} / ${await palco.texto('#principal h1.titulo-grande')}`);

  m = await marcado();
  certo(m.quantos === 1 && m.qual === 'Hoje',
    'Hoje: a marca da barra acompanha', JSON.stringify(m));

  const vazios = await lerNumeros(palco);
  certo(vazios.length === 4, 'Hoje: são quatro caixas de números',
    `são ${vazios.length}`);
  certo(vazios.every((n) => n.valor === '0'),
    'Hoje sem clientes: os quatro números são zero, não vazios nem traços',
    vazios.map((n) => `${n.rotulo}=${n.valor}`).join(' · '));

  /* A conta dos prémios é uma divisão, e uma divisão por zero escreve-se
     «NaN%» no ecrã se ninguém a travar. */
  let texto = await palco.textoTodo();
  certo(!/NaN|undefined|null/.test(texto),
    'Hoje sem clientes: não há NaN, undefined nem null no ecrã',
    (texto.match(/.{0,40}(NaN|undefined|null).{0,40}/) || [''])[0]);
  certo(texto.includes('Ainda não há prémios'),
    'Hoje sem clientes: em vez de uma percentagem impossível, diz que ainda não há prémios',
    texto.slice(0, 200));

  /* --- Clientes, sem ninguém -------------------------------------------- */

  await irAo(palco, 'clientes');
  await palco.captura('09-clientes-vazio');

  certo(await palco.texto('#topo-titulo') === 'Clientes',
    'Clientes: o topo muda', String(await palco.texto('#topo-titulo')));
  certo(await palco.visivel('#principal .vazio'),
    'Clientes sem ninguém: aparece o ecrã vazio, não uma lista de zero linhas');
  certo(await palco.texto('#principal .vazio h3') === 'Ainda ninguém',
    'Clientes sem ninguém: diz «Ainda ninguém»',
    String(await palco.texto('#principal .vazio h3')));
  certo((await palco.texto('#principal .vazio p')).includes('primeiro cartão'),
    'Clientes sem ninguém: e explica o que fazer para deixar de estar vazio',
    String(await palco.texto('#principal .vazio p')));
  certo(await palco.contar('#principal .lista .linha') === 0,
    'Clientes sem ninguém: não sobra nenhuma linha de lista',
    String(await palco.contar('#principal .lista .linha')));

  /* --- O cartão ---------------------------------------------------------- */

  await irAo(palco, 'programa');

  certo(await palco.texto('#topo-titulo') === 'O cartão',
    'O cartão: o topo muda', String(await palco.texto('#topo-titulo')));
  certo(await palco.visivel('#previa'),
    'O cartão: a pré-visualização está à vista');
  /* Esta frase é a promessa que as afirmações da grelha, mais abaixo, vão
     cobrar. Se um dia sair da página, elas deixam de ter em que se apoiar. */
  certo((await palco.texto('#principal .subtexto')).includes('É assim que os clientes o vêem'),
    'O cartão: a página promete que é assim que os clientes o vêem',
    String(await palco.texto('#principal .subtexto')));

  /* Antes de mexer em nada, o formulário tem de trazer o que está gravado —
     um campo em branco convida o dono do café a reescrever o que já lá está. */
  const gravado = await negocioGravado(palco);
  const campos = await lerCampos(palco);
  certo(campos.nome === gravado.nome,
    'O cartão: o campo do nome traz o nome gravado',
    `${campos.nome} ≠ ${gravado.nome}`);
  certo(campos.programa === gravado.programa.nome,
    'O cartão: o campo do nome do cartão traz o que está gravado',
    `${campos.programa} ≠ ${gravado.programa.nome}`);
  certo(campos.premio === gravado.programa.premio,
    'O cartão: o campo do prémio traz o que está gravado',
    `${campos.premio} ≠ ${gravado.programa.premio}`);
  certo(campos.objetivo === String(gravado.programa.objetivo),
    'O cartão: o campo do objectivo traz o que está gravado',
    `${campos.objetivo} ≠ ${gravado.programa.objetivo}`);
  certo(campos.regras === gravado.programa.regras,
    'O cartão: as regras trazem o que está gravado',
    `«${campos.regras}» ≠ «${gravado.programa.regras}»`);
  certo(campos.corActiva === `Cor ${gravado.cor}`,
    'O cartão: a paleta traz a cor do negócio marcada',
    `${campos.corActiva} (gravado ${gravado.cor})`);
  certo(campos.seloActivo === gravado.programa.selo,
    'O cartão: o selo gravado está marcado',
    `${campos.seloActivo} ≠ ${gravado.programa.selo}`);

  /* Voltar ao princípio: os quatro separadores pintam, e o de carimbar
     também sobrevive a uma segunda visita. */
  await irAo(palco, 'carimbar');
  certo(await palco.visivel('#principal .visor') && await palco.visivel('#botao-manual'),
    'voltar a carimbar: o visor e a entrada manual estão outra vez lá');
  m = await marcado();
  certo(m.quantos === 1 && m.qual === 'Carimbar',
    'voltar a carimbar: a marca da barra volta com ele', JSON.stringify(m));

  /* =======================================================================
     Hoje, com uma demonstração de resposta conhecida
     ======================================================================= */

  await palco.js(SEMENTE);
  await irAo(palco, 'hoje');
  await palco.captura('09-hoje');

  const numeros = await lerNumeros(palco);
  const porRotulo = Object.fromEntries(numeros.map((n) => [n.rotulo, n.valor]));

  certo(numeros.every((n) => /^\d+$/.test(String(n.valor))),
    'Hoje: os quatro valores são números inteiros',
    numeros.map((n) => `${n.rotulo}=${n.valor}`).join(' · '));

  for (const [rotulo, valor] of Object.entries(ESPERADO)) {
    certo(porRotulo[rotulo] === valor,
      `Hoje: «${rotulo}» diz ${valor}`,
      `diz ${porRotulo[rotulo]} — as quatro caixas são ${numeros.map((n) => `${n.rotulo}=${n.valor}`).join(' · ')}`);
  }

  /* A Barbearia Navalha tem um cartão carimbado hoje e um prémio por
     levantar. Nenhum dos dois é deste balcão. */
  certo(porRotulo['Carimbos hoje'] === '2' && porRotulo['Prémios por levantar'] === '1',
    'Hoje: o resumo conta só este negócio — o carimbo e o prémio do vizinho ficam de fora',
    `carimbos=${porRotulo['Carimbos hoje']}, por levantar=${porRotulo['Prémios por levantar']}`);

  texto = await palco.textoTodo();
  certo(!/NaN|undefined|null/.test(texto),
    'Hoje: com dados a sério continua sem NaN, undefined nem null',
    (texto.match(/.{0,40}(NaN|undefined|null).{0,40}/) || [''])[0]);

  /* Os dois números que mudam decisões. */
  const conselhos = await palco.textos('#principal .seccao:nth-of-type(1) .linha b');
  certo(conselhos[0] === '2 cliente(s) a dois carimbos do prémio',
    'Hoje: conta os clientes a dois carimbos do prémio (8/10 e 9/10)',
    String(conselhos[0]));
  certo(conselhos[1] === '1 cliente(s) sem aparecer há 2 meses',
    'Hoje: e o que não aparece há dois meses', String(conselhos[1]));

  const premios = await palco.textos('#principal .seccao:nth-of-type(2) .linha .linha-texto b');
  certo(premios[0] === '2 ganhos, 1 levantados',
    'Hoje: os prémios ganhos e levantados deste negócio', String(premios[0]));
  const proporcao = await palco.texto('#principal .seccao:nth-of-type(2) .linha .linha-texto span');
  certo(proporcao === '50% levantados',
    'Hoje: e a proporção entre os dois', String(proporcao));

  /* =======================================================================
     Clientes, com gente
     ======================================================================= */

  await irAo(palco, 'clientes');
  await palco.captura('09-clientes');

  const lista = await lerClientes(palco);
  certo(lista.length === 5,
    'Clientes: as cinco linhas dos cinco cartões deste negócio (e nenhuma do vizinho)',
    `desenhou ${lista.length}: ${lista.map((c) => c.publico).join(', ')}`);
  certo(!lista.some((c) => c.publico === 'W9X2Y3'),
    'Clientes: o cliente do outro negócio não aparece aqui',
    lista.map((c) => c.publico).join(', '));

  certo(lista.map((c) => c.publico).join(',') === 'A2C4E6,L3M4N6,F7H9K2,T4U6V7,P7Q9R2',
    'Clientes: a lista vem da visita mais recente para a mais antiga',
    lista.map((c) => `${c.publico}(${c.detalhe})`).join(' · '));

  certo(lista.every((c) => c.mono),
    'Clientes: o número do cartão é escrito em letra de largura fixa, para se ler ao balcão',
    lista.map((c) => `${c.publico}=${c.mono}`).join(' · '));

  const porNumero = Object.fromEntries(lista.map((c) => [c.publico, c]));
  certo(porNumero.A2C4E6 && porNumero.A2C4E6.detalhe === '8/10 · última visita agora mesmo',
    'Clientes: cada linha diz os carimbos e a última visita',
    porNumero.A2C4E6 ? String(porNumero.A2C4E6.detalhe) : 'não está lá');
  certo(porNumero.L3M4N6 && porNumero.L3M4N6.detalhe === '0/10 · última visita ontem',
    'Clientes: quem acabou de levar o cartão a zeros aparece com 0/10',
    porNumero.L3M4N6 ? String(porNumero.L3M4N6.detalhe) : 'não está lá');
  certo(porNumero.T4U6V7 && porNumero.T4U6V7.detalhe === '4/10 · última visita há 3 meses',
    'Clientes: e quem não vem há muito tempo diz há quanto',
    porNumero.T4U6V7 ? String(porNumero.T4U6V7.detalhe) : 'não está lá');

  /* Um cartão sem visita nenhuma não pode escrever «última visita Invalid
     Date» — nem deixar a frase pendurada. */
  certo(porNumero.P7Q9R2 && porNumero.P7Q9R2.detalhe === '2/10 · última visita —',
    'Clientes: quem aderiu e nunca voltou mostra um traço, não uma data impossível',
    porNumero.P7Q9R2 ? String(porNumero.P7Q9R2.detalhe) : 'não está lá');

  certo(porNumero.L3M4N6 && porNumero.L3M4N6.etiqueta === 'prémio',
    'Clientes: quem tem prémio por levantar traz a etiqueta que o diz ao balcão',
    porNumero.L3M4N6 ? String(porNumero.L3M4N6.etiqueta) : 'não está lá');
  certo(lista.filter((c) => c.etiqueta === 'prémio').length === 1,
    'Clientes: e só esse',
    lista.map((c) => `${c.publico}=${c.etiqueta}`).join(' · '));

  certo((await palco.texto('#principal .subtexto')).includes('Não guardamos nomes nem telefones'),
    'Clientes: a lista diz o que o balcão NÃO guarda sobre quem lá vai',
    String(await palco.texto('#principal .subtexto')));

  /* =======================================================================
     O cartão: a pré-visualização acompanha o que se escreve
     ======================================================================= */

  await irAo(palco, 'programa');
  await palco.captura('09-o-cartao');

  const antes = await lerPrevia(palco);
  certo(antes.nome === gravado.nome && antes.tipo === gravado.programa.nome
    && antes.premio === gravado.programa.premio,
    'pré-visualização: começa pelo cartão que está gravado', JSON.stringify(antes));
  certo(antes.casas === gravado.programa.objetivo,
    'pré-visualização: com as casas do objectivo gravado',
    `${antes.casas} casas para um objectivo de ${gravado.programa.objetivo}`);

  await palco.escrever('#f-nome', 'Café da Bateria');
  certo(await palco.texto('#previa .cartao-nome') === 'Café da Bateria',
    'pré-visualização: o nome do negócio acompanha o que se escreve',
    String(await palco.texto('#previa .cartao-nome')));

  await palco.escrever('#f-programa', 'Cartão da casa');
  certo(await palco.texto('#previa .cartao-tipo') === 'Cartão da casa',
    'pré-visualização: o nome do cartão acompanha',
    String(await palco.texto('#previa .cartao-tipo')));

  await palco.escrever('#f-premio', 'Uma bica por conta da casa');
  certo(await palco.texto('#previa .cartao-premio') === 'Uma bica por conta da casa',
    'pré-visualização: o prémio acompanha',
    String(await palco.texto('#previa .cartao-premio')));

  /* --- o objectivo e a grelha ------------------------------------------- */

  /* «É assim que os clientes o vêem» é uma promessa que se mede: a app do
     cliente escolhe as colunas para as linhas ficarem cheias, e o cartaz que
     o balcão mostra ao dono do café tem de desenhar a mesma grelha. */
  for (const objetivo of [4, 6, 8, 9, 10, 12]) {
    await palco.preencher('#f-objetivo', String(objetivo));
    const p = await lerPrevia(palco);
    const esperadas = colunasDoCliente(objetivo);

    certo(p.casas === objetivo,
      `objectivo ${objetivo}: a pré-visualização desenha ${objetivo} casas`,
      `desenhou ${p.casas}`);
    certo(p.colunas === esperadas,
      `objectivo ${objetivo}: em ${esperadas} colunas, como na app do cliente`,
      `o balcão desenhou ${p.colunas}`);
    certo(p.colunas > 0 && objetivo % p.colunas === 0,
      `objectivo ${objetivo}: as linhas da grelha ficam cheias`,
      `${objetivo} em ${p.colunas} colunas deixa ${objetivo % p.colunas} na última linha`);
    certo(p.colunasPintadas === p.colunas,
      `objectivo ${objetivo}: o CSS pinta mesmo as ${p.colunas} colunas`,
      `pintou ${p.colunasPintadas}`);
  }

  /* O rodapé do cartão é uma frase em português, e o cliente lê a mesma
     conta escrita à mão na app dele: «falta 1 carimbo», no singular. */
  await palco.preencher('#f-objetivo', '4');
  let previa = await lerPrevia(palco);
  certo(previa.rotulo === 'falta 1 carimbo',
    'objectivo 4: o rodapé da pré-visualização fica no singular, como na app do cliente',
    String(previa.rotulo));

  /* Dois carimbos é o mínimo que o formulário aceita — e portanto um cartão
     que existe mesmo. A pré-visualização não pode mostrá-lo já completo. */
  await palco.preencher('#f-objetivo', '2');
  previa = await lerPrevia(palco);
  certo(previa.cheias < previa.casas,
    'objectivo 2: a pré-visualização mostra um cartão a meio, não um já cheio',
    `${previa.cheias} de ${previa.casas} carimbadas`);
  certo(previa.rotulo !== 'faltam 0 carimbos',
    'objectivo 2: e o rodapé não diz que faltam zero carimbos',
    String(previa.rotulo));

  /* O topo: acima de 30 o desenho trava, e é o que o formulário também
     recusa mais à frente. */
  await palco.preencher('#f-objetivo', '99');
  previa = await lerPrevia(palco);
  certo(previa.casas === 30,
    'objectivo 99: o desenho trava nos 30 em vez de encher a página',
    `desenhou ${previa.casas}`);

  /* --- a cor -------------------------------------------------------------- */

  await palco.preencher('#f-objetivo', '10');
  const corAntes = (await lerPrevia(palco)).m;
  const cores = await palco.js(
    "return [...document.querySelectorAll('.paleta-cor')].map((b) => b.getAttribute('aria-label'))");
  certo(cores.length === 12, 'O cartão: a paleta oferece doze cores', String(cores.length));

  const escolhida = cores.find((c) => c.toLowerCase() !== `cor ${gravado.cor}`.toLowerCase());
  await palco.clicar(`.paleta-cor[aria-label="${escolhida}"]`);
  const corDepois = await lerPrevia(palco);
  certo(corDepois.m !== corAntes && /^#[0-9a-f]{6}$/i.test(corDepois.m),
    'cor: escolher uma cor repinta a pré-visualização',
    `antes ${corAntes}, depois ${corDepois.m}`);
  certo(/^#[0-9a-f]{6}$/i.test(corDepois.mTxt)
    && razao(corParaRGB(corDepois.m), corParaRGB(corDepois.mTxt)) >= 4.5,
    'cor: a tinta do cartão continua a ler-se por cima da cor escolhida',
    `${corDepois.m} sobre ${corDepois.mTxt} = ${razao(corParaRGB(corDepois.m), corParaRGB(corDepois.mTxt)).toFixed(2)}:1`);

  const activa = await palco.js(
    "return document.querySelector('.paleta-cor[data-ativo=\"sim\"]')?.getAttribute('aria-label') ?? null");
  certo(activa === escolhida,
    'cor: e só a cor escolhida fica marcada', `marcada ${activa}, escolhida ${escolhida}`);

  /* --- o selo -------------------------------------------------------------- */

  const selos = await palco.js(
    "return [...document.querySelectorAll('.selo-opcao')].map((b) => b.getAttribute('aria-label'))");
  certo(selos.length >= 12, 'O cartão: há uma boa mão-cheia de selos por onde escolher',
    String(selos.length));

  const seloNovo = selos.find((s) => s !== gravado.programa.selo);
  await palco.clicar(`.selo-opcao[aria-label="${seloNovo}"]`);
  const desenhoBotao = await palco.js(
    `return document.querySelector('.selo-opcao[aria-label=${JSON.stringify(seloNovo)}] svg').innerHTML`);
  const desenhoPrevia = (await lerPrevia(palco)).selo;
  certo(desenhoPrevia === desenhoBotao,
    `selo: escolher «${seloNovo}» põe esse desenho dentro dos carimbos da pré-visualização`,
    `o carimbo desenhou ${String(desenhoPrevia).slice(0, 50)}…`);

  const seloActivo = await palco.js(
    "return document.querySelector('.selo-opcao[data-ativo=\"sim\"]')?.getAttribute('aria-label') ?? null");
  certo(seloActivo === seloNovo,
    'selo: e só o selo escolhido fica marcado', `marcado ${seloActivo}`);

  /* =======================================================================
     O que o formulário tem de recusar

     A prova de que a recusa acontece ANTES de sair para o servidor não é o
     aviso: é o nome do negócio, mudado ao mesmo tempo. São dois pedidos, e o
     do nome é o primeiro — se ele passar, o negócio fica com metade da
     gravação feita e o objectivo por gravar.
     ======================================================================= */

  const nomeIsco = 'NOME QUE NÃO PODE SER GRAVADO';
  await palco.preencher('#f-nome', nomeIsco);

  certo(await palco.contar(GUARDAR) === 1,
    'O cartão: há um e um só botão de gravar', String(await palco.contar(GUARDAR)));

  const maus = [
    ['0', 'zero'],
    ['1', 'um'],
    ['99', 'noventa e nove'],
    ['31', 'trinta e um'],
    ['', 'vazio'],
    ['abc', 'letras'],
  ];

  for (const [valor, porque] of maus) {
    await palco.preencher('#f-objetivo', valor);
    const noCampo = await palco.valor('#f-objetivo');

    await marcarAvisos(palco);
    await palco.clicar(GUARDAR);

    const aviso = await avisoNovo(palco);
    certo(aviso !== null && /carimbo/i.test(aviso) && /2|30|entre/.test(aviso),
      `objectivo ${porque}: recusa com uma mensagem que diz quais são os limites`,
      `escrito «${valor}», o campo ficou com «${noCampo}», e o aviso foi «${aviso}»`);

    const depois = await negocioGravado(palco);
    certo(depois.nome !== nomeIsco,
      `objectivo ${porque}: nada saiu para o servidor — nem o nome, que ia no primeiro pedido`,
      `o negócio ficou gravado como «${depois.nome}»`);
    certo(depois.programa.objetivo === gravado.programa.objetivo,
      `objectivo ${porque}: e o objectivo gravado não se mexeu`,
      `ficou ${depois.programa.objetivo}`);

    certo(await desactivado(palco, GUARDAR) === false,
      `objectivo ${porque}: o botão de gravar continua a responder`, 'ficou morto');
    certo(await palco.visivel('#f-objetivo'),
      `objectivo ${porque}: o formulário fica aberto para se corrigir`);

    /* Levar o cursor ao campo errado poupa uma procura a quem tem fila. */
    const foco = await focadoId(palco);
    certo(foco === 'f-objetivo',
      `objectivo ${porque}: o cursor vai parar ao campo que está mal`, String(foco));

    await limparAvisos(palco);
  }

  /* Um aviso que pousa em cima do botão que a pessoa tem de voltar a
     carregar é pior do que não haver aviso nenhum. */
  await palco.preencher('#f-objetivo', '99');
  await palco.clicar(GUARDAR);
  /* O `focus()` da recusa rola a página até ao campo e leva o botão para fora
     do ecrã — como levaria a de qualquer pessoa. Volta-se a ele antes de
     medir, que é o que ela faria para tentar outra vez. */
  await rolarAte(palco, GUARDAR);
  await palco.captura('09-objectivo-recusado');
  const tapa = await quemTapa(palco, GUARDAR);
  certo(tapa === null,
    'objectivo recusado: o aviso não fica em cima do botão de gravar', String(tapa));
  await limparAvisos(palco);

  /* =======================================================================
     Gravar a sério, e o valor aguentar-se
     ======================================================================= */

  const NOVO = {
    nome: 'Café da Bateria', programa: 'Cartão da casa',
    premio: 'Uma bica por conta da casa', objetivo: '6',
    regras: 'Um carimbo por bica. Não acumula com o desconto de estudante.',
  };

  await palco.preencher('#f-nome', NOVO.nome);
  await palco.preencher('#f-programa', NOVO.programa);
  await palco.preencher('#f-premio', NOVO.premio);
  await palco.preencher('#f-objetivo', NOVO.objetivo);
  await palco.preencher('#f-regras', NOVO.regras);

  await marcarAvisos(palco);
  await palco.clicar(GUARDAR);
  const confirmacao = await avisoNovo(palco);
  certo(confirmacao === 'Guardado. Os clientes vão ver já a mudança.',
    'gravar: a app confirma que ficou gravado', String(confirmacao));
  await limparAvisos(palco);

  const apos = await negocioGravado(palco);
  certo(apos.nome === NOVO.nome && apos.programa.nome === NOVO.programa
    && apos.programa.premio === NOVO.premio && apos.programa.objetivo === 6
    && apos.programa.regras === NOVO.regras,
    'gravar: os cinco campos chegaram todos ao armazenamento', JSON.stringify(apos));
  certo(String(apos.cor).toLowerCase() === escolhida.replace(/^Cor /, '').toLowerCase(),
    'gravar: e a cor escolhida também',
    `gravou ${apos.cor}, escolheu ${escolhida}`);
  certo(apos.programa.selo === seloNovo,
    'gravar: e o selo escolhido', `gravou ${apos.programa.selo}, escolheu ${seloNovo}`);

  /* Um programa gravado não pode perder o que não estava no formulário — o
     arrefecimento é o que impede dez carimbos seguidos ao mesmo cliente. */
  certo(apos.programa.id === gravado.programa.id
    && apos.programa.arrefecimento === gravado.programa.arrefecimento
    && apos.programa.tipo === 'carimbos',
    'gravar: guardar o formulário não deita fora o que ele não mostra (id, tipo, arrefecimento)',
    JSON.stringify(apos.programa));

  /* --- sair do separador e voltar ---------------------------------------- */

  await irAo(palco, 'hoje');
  await irAo(palco, 'programa');

  const voltou = await lerCampos(palco);
  certo(voltou.nome === NOVO.nome && voltou.programa === NOVO.programa
    && voltou.premio === NOVO.premio && voltou.objetivo === NOVO.objetivo
    && voltou.regras === NOVO.regras,
    'voltar: os campos trazem outra vez o que se gravou', JSON.stringify(voltou));
  certo(voltou.corActiva === escolhida && voltou.seloActivo === seloNovo,
    'voltar: a cor e o selo gravados continuam marcados',
    `${voltou.corActiva} / ${voltou.seloActivo}`);

  const previaVolta = await lerPrevia(palco);
  certo(previaVolta.casas === 6 && previaVolta.nome === NOVO.nome,
    'voltar: e a pré-visualização é desenhada com os valores novos',
    JSON.stringify({ casas: previaVolta.casas, nome: previaVolta.nome }));

  /* O «Hoje» também tem de reflectir o cartão novo: com seis carimbos, quem
     tinha 8 e 9 num cartão de dez já passou o objectivo, e quem tem 4 passa a
     estar a dois do prémio. */
  await irAo(palco, 'hoje');
  const conselhosDepois = await palco.textos('#principal .seccao:nth-of-type(1) .linha b');
  certo(conselhosDepois[0] === '1 cliente(s) a dois carimbos do prémio',
    'gravar: o «Hoje» recalcula com o objectivo novo (só o cartão de 4/6 está a dois)',
    String(conselhosDepois[0]));

  /* --- e depois de fechar a app ------------------------------------------ */

  await palco.recarregar();
  await palco.esperar('#barra .barra-item', 12000);
  await esperarCamara(palco);
  await irAo(palco, 'programa');

  const depoisDeRecarregar = await lerCampos(palco);
  certo(depoisDeRecarregar.nome === NOVO.nome
    && depoisDeRecarregar.objetivo === NOVO.objetivo
    && depoisDeRecarregar.regras === NOVO.regras,
    'depois de fechar e abrir a app: o cartão continua como se gravou',
    JSON.stringify(depoisDeRecarregar));
  certo(await palco.texto('#topo-titulo') === 'O cartão',
    'depois de recarregar: os separadores continuam a levar aos ecrãs certos',
    String(await palco.texto('#topo-titulo')));

  /* O editor do cartão é a página mais comprida do balcão, e quem chega ao
     fim dela fica lá em baixo. Mudar de separador tem de pôr a pessoa no
     cimo do ecrã novo — senão o «Clientes» abre a meio da lista e parece que
     faltam linhas por cima. */
  await palco.rolar(1200);
  const rolado = await palco.js('return Math.round(window.scrollY)');
  await irAo(palco, 'clientes');
  const noCimo = await palco.js('return Math.round(window.scrollY)');
  certo(rolado > 100 && noCimo === 0,
    'mudar de separador: o ecrã novo abre no cimo, não a meio',
    `saiu de ${rolado} px de rolagem e ficou em ${noCimo}`);
  await irAo(palco, 'programa');

  /* =======================================================================
     O cartaz

     O botão abre uma janela. Em vez de a perseguir, escuta-se o `window.open`
     — que é o que o balcão manda fazer ao browser — e depois vai-se ao mesmo
     endereço a pé.
     ======================================================================= */

  await palco.js(`
    window.__aberturas = [];
    window.open = (u, alvo) => {
      window.__aberturas.push({ url: String(u), alvo: String(alvo) });
      return { closed: false, focus() {}, close() {} };
    };
    return true`);

  certo(await palco.ver(CARTAZ), 'cartaz: o editor do cartão tem o botão de imprimir o cartaz');
  await rolarAte(palco, CARTAZ);
  certo(await palco.visivel(CARTAZ),
    'cartaz: o botão está à vista de quem rola até ao fim do editor');
  await palco.clicar(CARTAZ);

  const aberturas = await palco.js('return window.__aberturas || []');
  certo(aberturas.length === 1,
    'cartaz: carregar no botão manda mesmo abrir uma página',
    `abriu ${aberturas.length} janelas`);

  const base = await palco.js('return (window.CARIMBO_CONFIG || {}).base || ""');
  const aberto = aberturas[0] ? aberturas[0].url : '';
  certo(aberto.startsWith(`${base}/balcao/cartaz.html?`),
    'cartaz: o endereço é o do cartaz, com o prefixo do sítio',
    String(aberto));

  const q = new URLSearchParams(aberto.split('?')[1] || '');
  certo(q.get('n') === NOVO.nome && q.get('p') === NOVO.premio,
    'cartaz: leva o nome e o prémio que estão gravados',
    `n=${q.get('n')} · p=${q.get('p')}`);
  certo(String(q.get('c')).toLowerCase() === String(apos.cor).toLowerCase(),
    'cartaz: e a cor do negócio', `c=${q.get('c')}, gravado ${apos.cor}`);
  certo(q.get('s') === gravado.slug,
    'cartaz: e o endereço curto do negócio, que é o que leva o cliente ao cartão certo',
    `s=${q.get('s')}, esperava ${gravado.slug}`);

  /* --- a página do cartaz ------------------------------------------------- */

  await palco.ir(aberto.slice(base.length), { esperarPor: '#folha' });

  certo(await palco.texto('#negocio') === NOVO.nome,
    'cartaz: a folha traz o nome do negócio', String(await palco.texto('#negocio')));
  certo(await palco.texto('#premio') === NOVO.premio,
    'cartaz: e o prémio', String(await palco.texto('#premio')));
  certo((await palco.js('return document.title')).includes(NOVO.nome),
    'cartaz: até o título da página, que é o nome do ficheiro quando se imprime para PDF',
    String(await palco.js('return document.title')));

  certo(await palco.contar('#quadro svg') === 1,
    'cartaz: há um código desenhado no quadro branco',
    `${await palco.contar('#quadro svg')} svg · ${String(await palco.texto('#quadro')).slice(0, 60)}`);

  /* Mede-se o DESENHO e não a caixa do `<svg>`: um QR esticado não lê, e é o
     desenho que a câmara vê. */
  const desenho = await palco.medir('#quadro svg path');
  certo(desenho && Math.abs(desenho.largura - desenho.altura) < 2,
    'cartaz: o código sai quadrado no ecrã estreito de quem o mandou imprimir',
    JSON.stringify(desenho));
  certo(desenho && desenho.largura > 120,
    'cartaz: e com tamanho que se aponte, não uma miniatura',
    desenho ? `${Math.round(desenho.largura)} px de lado` : 'não medi');

  /* Não chega ver um `<svg>`: prova-se que aquilo é mesmo um QR e que diz o
     que devia dizer. Reconstrói-se a matriz do desenho, transforma-se numa
     imagem em tons de cinzento e passa-se pelo leitor da própria app — o
     mesmo que corre no telemóvel do balcão. */
  const leitura = await palco.js(`
    const svg = document.querySelector('#quadro svg');
    if (!svg) return { erro: 'não há svg' };
    const caminho = svg.querySelector('path');
    const d = caminho ? caminho.getAttribute('d') || '' : '';
    const lado = Number((svg.getAttribute('viewBox') || '').split(/\\s+/)[2]) || 0;
    if (!lado) return { erro: 'svg sem viewBox' };

    const escala = 5;
    const px = lado * escala;
    const cinza = new Uint8Array(px * px).fill(255);
    let modulos = 0;
    for (const m of d.matchAll(/M(\\d+) (\\d+)h1v1h-1z/g)) {
      modulos++;
      const c = Number(m[1]) * escala, l = Number(m[2]) * escala;
      for (let y = 0; y < escala; y++) {
        for (let x = 0; x < escala; x++) cinza[(l + y) * px + c + x] = 0;
      }
    }
    const { lerQR } = await import('../js/qr-leitor.js');
    return { lado, modulos, texto: lerQR(cinza, px, px) };`);

  certo(leitura.modulos > 100,
    'cartaz: o código tem módulos escuros a sério, não é um quadrado vazio',
    JSON.stringify(leitura));
  certo(leitura.texto === `https://carimbodigital.pt/app/?n=${gravado.slug}`,
    'cartaz: o código lê-se, e leva ao cartão deste negócio',
    `leu «${leitura.texto}»`);

  /* A cor do cartaz é a do negócio, e a tinta é calculada — é o que impede
     um cartaz amarelo com letras brancas na parede de um café. */
  const folha = await palco.js(`
    const f = document.getElementById('folha');
    const e = getComputedStyle(f);
    const ler = (s) => { const n = document.querySelector(s); if (!n) return null;
      const c = getComputedStyle(n);
      return { cor: c.color, px: parseFloat(c.fontSize), peso: Number(c.fontWeight) || 400,
               opacidade: Number(c.opacity) }; };
    return { fundo: e.backgroundColor, tinta: e.color,
             negocio: ler('#negocio'), premio: ler('#premio') };`);

  const fundo = corParaRGB(folha.fundo);
  const pedida = corParaRGB(apos.cor);
  certo(fundo && pedida,
    'cartaz: a folha está pintada com uma cor legível',
    `fundo=${folha.fundo}, cor do negócio=${apos.cor}`);

  for (const [onde, t] of [['nome do negócio', folha.negocio], ['prémio', folha.premio]]) {
    const r = t && fundo ? razao(corParaRGB(t.cor), fundo) : 0;
    const minimo = t && (t.px >= 24 || (t.px >= 18.66 && t.peso >= 700)) ? 3 : 4.5;
    certo(t && t.opacidade > 0.99 && r >= minimo,
      `cartaz: o ${onde} lê-se por cima da cor do negócio`,
      `${r.toFixed(2)}:1 (pede ${minimo}) · ${JSON.stringify(t)} sobre ${folha.fundo}`);
  }

  certo(await palco.visivel('#imprimir'),
    'cartaz: e há um botão para imprimir');
  await palco.captura('09-cartaz');

  /* O cartaz vai para uma folha A4. Num ecrã com largura para ela, o quadro
     do código tem de ficar com o tamanho que o CSS lhe promete — 74 mm de
     lado, que é o que se cola ao pé da caixa e se lê do outro lado do balcão. */
  await palco.tamanho(900, 1200);
  await palco.recarregar();
  await palco.esperar('#quadro svg', 8000);
  const emA4 = await palco.medir('#quadro svg');
  certo(emA4 && Math.abs(emA4.largura - emA4.altura) < 2 && emA4.largura > 250,
    'cartaz numa folha larga: o quadro do código fica quadrado e com os 74 mm do CSS',
    JSON.stringify(emA4));
  await palco.captura('09-cartaz-a4');
  await palco.tamanho(390, 844);

  /* =======================================================================
     Mudar de separador enquanto a câmara ainda está a ligar

     O balcão abre no ecrã de carimbar, e esse ecrã fica à espera da câmara —
     no telemóvel, à espera de a pessoa responder à pergunta da permissão, o
     que demora o tempo que demorar. Tocar em «Hoje» nesses segundos é o
     gesto mais natural do mundo, e tem de dar em «Hoje».

     Para o ver de forma repetível trava-se aqui o `getUserMedia`: devolve uma
     promessa que só se resolve quando este teste mandar. A app não sabe a
     diferença entre isto e um telemóvel lento.
     ======================================================================= */

  await palco.enviar('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        if (!navigator.mediaDevices) {
          Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
        }
        window.__camara = { pedidos: 0 };
        navigator.mediaDevices.getUserMedia = () => {
          window.__camara.pedidos++;
          return new Promise((ok, mal) => { window.__camara.ok = ok; window.__camara.mal = mal; });
        };
        window.__estoiros = [];
        addEventListener('unhandledrejection', (ev) => {
          window.__estoiros.push('promessa: ' + ((ev.reason && ev.reason.message) || ev.reason));
        });
        addEventListener('error', (ev) => { window.__estoiros.push('erro: ' + ev.message); });
      })();`,
  }, palco.sessao);

  await palco.ir('/balcao/', { esperarPor: '#barra .barra-item', tecto: 12000 });

  const travada = await palco.js('return (window.__camara || {}).pedidos || 0');
  certo(travada === 1,
    'câmara travada: o balcão abriu e pediu a câmara, que fica à espera de resposta',
    `pedidos=${travada}`);
  certo(await palco.texto('#visor-estado') === 'A ligar a câmara…',
    'câmara travada: o visor diz que está a ligar',
    String(await palco.texto('#visor-estado')));

  /* O gesto: tocar em «Hoje» enquanto a câmara não responde. */
  await palco.clicar(SEPARADOR.hoje);
  await palco.esperar(MARCADOR.hoje, 8000);
  certo(await palco.texto('#topo-titulo') === 'Hoje',
    'câmara a ligar: tocar em «Hoje» leva a «Hoje»',
    String(await palco.texto('#topo-titulo')));

  /* E agora o telemóvel responde — tarde, como responde um telemóvel lento. */
  await palco.js(`
    window.__camara.mal(new DOMException('Permission denied', 'NotAllowedError'));
    await new Promise((r) => setTimeout(r, 600));
    return true`);
  await palco.captura('09-camara-tardia');

  const estoiros = await palco.js('return window.__estoiros || []');
  certo(estoiros.length === 0,
    'câmara a responder tarde: a resposta que chega a um ecrã já fechado não rebenta nada',
    estoiros.join(' · '));

  certo(!(await palco.visivel('#entrada')),
    'câmara a responder tarde: o balcão não é atirado de volta ao ecrã de entrada',
    `#entrada visível`);
  certo(await palco.visivel('#barra .barra-item'),
    'câmara a responder tarde: a barra dos separadores continua lá');
  certo(await palco.texto('#topo-titulo') === 'Hoje'
    && await palco.ver('#principal .numeros'),
    'câmara a responder tarde: o ecrã «Hoje» que a pessoa abriu continua no ecrã',
    `topo=${await palco.texto('#topo-titulo')}, números=${await palco.contar('#principal .numero')}`);
  certo(await palco.js("return localStorage.getItem('carimbo-demo:balcao-entrou')") === 'true',
    'câmara a responder tarde: e a sessão do balcão não se perde',
    String(await palco.js("return localStorage.getItem('carimbo-demo:balcao-entrou')")));
}
