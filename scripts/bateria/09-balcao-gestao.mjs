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


  /* --- Clientes: entregar um prémio SEM carimbar -------------------------
     A lista dizia «prémio» ao lado do número do cartão e não fazia nada — era
     uma etiqueta e não um botão, e a API mandava só uma CONTAGEM, sem o id
     que permite entregar. O único caminho para o painel de entrega era
     carimbar outra vez, e o arrefecimento fecha essa porta durante uma hora.
     Quem fechasse o cartão e dissesse «levo noutro dia» ficava sem café até
     voltar noutro dia E ganhar um carimbo que não pediu.

     Isto conduz-se a sério: põe-se um cliente com um prémio por levantar,
     abre-se a lista, toca-se na linha e entrega-se.
     -------------------------------------------------------------------- */
  {
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const p = n.programas[0];
      const agora = new Date().toISOString();
      e.clientes.push({ id: 'cli-premio', publico: 'PREMI0', criadoEm: agora });
      e.cartoes.push({ id: 'car-premio', clienteId: 'cli-premio', programaId: p.id,
        negocioId: n.id, carimbos: 0, pontos: 0, totalCarimbos: p.objetivo,
        premiosGanhos: 1, aderiuEm: agora, ultimoEm: agora });
      e.premios.push({ id: 'pr-1', cartaoId: 'car-premio', descricao: p.premio,
        ganhoEm: agora, resgatadoEm: null });
      /* E um sem prémio nenhum, para a linha parada ter com que ser comparada. */
      e.clientes.push({ id: 'cli-sem', publico: 'SEMPR3', criadoEm: agora });
      e.cartoes.push({ id: 'car-sem', clienteId: 'cli-sem', programaId: p.id,
        negocioId: n.id, carimbos: 2, pontos: 0, totalCarimbos: 2,
        premiosGanhos: 0, aderiuEm: agora, ultimoEm: agora });
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);

    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'clientes');
    await palco.esperar('#principal .lista .linha', 8000);

    const linhas = await palco.js(`
      return [...document.querySelectorAll('#principal .lista > .linha')].map((l) => ({
        publico: l.querySelector('.linha-texto b')?.textContent.trim() ?? null,
        etiqueta: l.querySelector('.etiqueta')?.textContent.trim() ?? null,
        botao: l.tagName === 'BUTTON',
        nome: l.getAttribute('aria-label'),
      }));`);

    const comPremio = linhas.find((l) => l.publico === 'PREMI0');
    const semPremio = linhas.find((l) => l.publico === 'SEMPR3');

    certo(comPremio && comPremio.etiqueta === 'prémio',
      'Clientes: quem tem prémio por levantar aparece marcado',
      JSON.stringify(comPremio));
    certo(comPremio && comPremio.botao === true,
      'Clientes: e essa linha é um BOTÃO — era só uma etiqueta, e não havia como entregar',
      JSON.stringify(comPremio));
    certo(comPremio && /entregar o pr[ée]mio/i.test(String(comPremio.nome)),
      'Clientes: quem ouve o ecrã ouve o que a linha faz',
      String(comPremio && comPremio.nome));
    certo(semPremio && semPremio.botao === false,
      'Clientes: e quem não tem prémio continua a ser uma linha parada, não um botão morto',
      JSON.stringify(semPremio));

    /* Toca-se e entrega-se. O `esperar` NÃO pode atirar: um `esperar` que
       rebenta mata o módulo, e com ele as dezenas de afirmações que vêm a
       seguir — uma coisa partida tem de dar UMA falha, não um apagão. */
    await palco.js(`
      const l = [...document.querySelectorAll('#principal .lista > .linha')]
        .find((x) => x.querySelector('.linha-texto b')?.textContent.trim() === 'PREMI0');
      if (l) l.click();
      return true;`);
    const abriu = await palco.esperar('#painel', 8000).then(() => true, () => false);
    certo(abriu, 'Clientes: tocar na linha abre um painel');

    const painel = !abriu ? null : await palco.js(`
      const f = document.querySelector('#painel .painel-folha');
      if (!f) return null;
      return {
        titulo: f.querySelector('h2')?.textContent.trim() ?? null,
        texto: f.innerText.replace(/\\s+/g, ' ').trim(),
        botoes: [...f.querySelectorAll('button')].map((b) => b.textContent.trim()),
      };`);
    certo(painel && /PREMI0/.test(String(painel.titulo)),
      'Clientes: tocar na linha abre o painel do cartão certo',
      JSON.stringify(painel && painel.titulo));
    certo(painel && painel.botoes.some((b) => /^Entreguei:/.test(b)),
      'Clientes: com o botão de entregar lá dentro',
      JSON.stringify(painel && painel.botoes));
    certo(painel && /não carimba/i.test(painel.texto),
      'Clientes: e a dizer que isto NÃO carimba — senão o dono pensa que está a dar um carimbo',
      String(painel && painel.texto).slice(0, 120));

    await palco.js(`
      const b = [...document.querySelectorAll('#painel button')]
        .find((x) => /^Entreguei:/.test(x.textContent.trim()));
      if (b) b.click();
      return true;`);
    await palco.esperar('#principal .lista .linha', 8000).then(() => {}, () => {});
    await new Promise((r) => setTimeout(r, 1200));

    const guardado = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const pr = e.premios.find((x) => x.id === 'pr-1');
      return { resgatado: Boolean(pr && pr.resgatadoEm), por: pr && pr.resgatadoPor };`);
    certo(guardado && guardado.resgatado === true,
      'Clientes: entregar pelo painel marca mesmo o prémio como levantado',
      JSON.stringify(guardado));

    const depois = await palco.js(`
      return [...document.querySelectorAll('#principal .lista > .linha')].map((l) => ({
        publico: l.querySelector('.linha-texto b')?.textContent.trim() ?? null,
        etiqueta: l.querySelector('.etiqueta')?.textContent.trim() ?? null,
        botao: l.tagName === 'BUTTON',
      }));`);
    const agora = depois.find((l) => l.publico === 'PREMI0');
    certo(agora && !agora.etiqueta && agora.botao === false,
      'Clientes: e a linha volta a ser uma linha — o prémio já saiu pela porta',
      JSON.stringify(agora));

    /* O cartão NÃO foi carimbado: entregar um prémio não é uma visita. */
    const cartao = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const c = e.cartoes.find((x) => x.id === 'car-premio');
      return { carimbos: c.carimbos, total: c.totalCarimbos };`);
    certo(cartao && cartao.carimbos === 0 && cartao.total === 10,
      'Clientes: e entregar não carimbou nada — o cartão ficou como estava',
      JSON.stringify(cartao));

    /* Levanta-se a mesa: a demonstração sobrevive entre módulos. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      e.clientes = e.clientes.filter((x) => !['cli-premio','cli-sem'].includes(x.id));
      e.cartoes = e.cartoes.filter((x) => !['car-premio','car-sem'].includes(x.id));
      e.premios = e.premios.filter((x) => x.id !== 'pr-1');
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
  }

  /* --- O cartão ---------------------------------------------------------- */

  await irAo(palco, 'programa');

  certo(await palco.texto('#topo-titulo') === 'O cartão',
    'O cartão: o topo muda', String(await palco.texto('#topo-titulo')));
  certo(await palco.visivel('#previa'),
    'O cartão: a pré-visualização está à vista');

  /* --- o logótipo -------------------------------------------------------
     Existe porque a classe de fidelização da Google EXIGE um logótipo por
     programa: sem ele não há cartão na Wallet nenhum. E como quem o carrega é
     o dono do café, ao balcão, tem de ser um gesto e não um comando.

     Conduz-se a sério: põe-se um PNG no campo de ficheiro por `DataTransfer`,
     que é o que o browser faz quando alguém escolhe um ficheiro, e espera-se
     que a pré-visualização passe a ter uma imagem. Sem isto, o caminho todo —
     ler, cortar ao centro, reduzir a 512 px, gravar — ficava por percorrer.
     -------------------------------------------------------------------- */
  /* --- a cor ------------------------------------------------------------
     A paleta tinha doze cores fixas e mais nada. Um negócio cuja cor de marca
     não fosse uma das doze abria este ecrã com NADA seleccionado — e o gesto
     natural é carregar numa, o que substituía a cor medida por uma parecida,
     sem aviso e sem forma de a recompor. Aconteceu a sério: o cartão de uma
     barbearia de laranja foi parar a um verde.
     --------------------------------------------------------------------- */
  {
    /* Põe-se uma cor que de certeza não está na paleta e recarrega-se. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#EE9125';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    /* Recarrega-se para o balcão reler o negócio do armazenamento. Com sessão
       guardada ele entra directo, sem passar pelo ecrã de entrada — esperar
       por esse ecrã aqui era esperar por uma coisa que não vem. */
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');

    const activa = await palco.js(
      `const b = document.querySelector('.paleta-cor[data-ativo="sim"]');
       return b ? b.dataset.cor : null;`);
    certo(String(activa).toUpperCase() === '#EE9125',
      'uma cor que não é das sugeridas aparece na paleta, e escolhida',
      String(activa));
    certo(await palco.ver('#f-cor'),
      'e há um selector de cor a sério, para se pôr a cor exacta da marca');
    certo((await palco.valor('#f-cor')).toLowerCase() === '#ee9125',
      'que abre já na cor que o negócio tem', String(await palco.valor('#f-cor')));
  }

  certo(await palco.ver('#logo-previa'), 'O cartão: há sítio para o logótipo');
  const botaoLogo = (await palco.textos('.logo-accoes .btn'))[0];
  certo(/escolher|trocar/i.test(String(botaoLogo)),
    'O cartão: e um botão para escolher a imagem', String(botaoLogo));
  certo(!(await palco.visivel('#f-logotipo')),
    'o campo de ficheiro verdadeiro não se vê — quem se vê é o botão');

  {
    const antes = await palco.contar('#logo-previa img');
    await palco.js(`
      /* Um PNG de 8×8 COM DESENHO LÁ DENTRO — um quadrado escuro sobre
         branco. Era um de 1×1 de uma cor só, e isso deixou de ser um
         logótipo: uma imagem de uma cor única passa a ser recusada, porque é
         exactamente o que sai de uma exportação com a camada errada
         escondida. Uma fixture que o produto recusa não prova nada. */
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKElEQVR4nGP8////fwY8gAmfJAiwwBiioqIoEq9fvybOBMoVMFLsCwAh1wsJwaXYzgAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const f = new File([bytes], 'marca.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await palco.esperar('#logo-previa img', 8000);
    certo(antes === 0 && (await palco.contar('#logo-previa img')) === 1,
      'escolher um ficheiro põe a imagem na pré-visualização',
      `antes ${antes}, depois ${await palco.contar('#logo-previa img')}`);

    /* E foi mesmo reduzido aqui, no browser: o que ficou guardado tem de ser
       um PNG de 512 px, e não o ficheiro original. É essa redução que evita
       mandar quatro megapixéis pelo ar de quem está com dados móveis. */
    const guardado = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      if (!n || !n.logotipo) return null;
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      return { comeca: n.logotipo.slice(0, 22), largura: img.width, altura: img.height };`);
    certo(guardado && guardado.comeca.startsWith('data:image/png'),
      'e o que ficou guardado é um PNG', JSON.stringify(guardado));
    certo(guardado && guardado.largura === 512 && guardado.altura === 512,
      'reduzido a 512 px, e quadrado — que é o que a Google quer',
      JSON.stringify(guardado));
  }

  {
    /* O FUNDO ESCOLHE-SE A OLHAR PARA O LOGÓTIPO. Um logótipo BRANCO sobre
       transparente — que é o caso do da barbearia, feito para fundos escuros —
       desaparece por completo no círculo branco em que a Google o desenha. E
       um escuro desaparecia se o fundo fosse a cor da marca, se ela também for
       escura. Mede-se a luminosidade e escolhe-se o que contrasta. */
    const corDeFundo = async (rgbaDoLogotipo) => palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 8; tela.height = 8;
      const c = tela.getContext('2d');
      c.fillStyle = 'rgba(${rgbaDoLogotipo})';
      c.fillRect(2, 2, 4, 4);          /* o desenho, com margem transparente */
      const png = tela.toDataURL('image/png');
      const bin = atob(png.split(',')[1]);
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'l.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      t2.getContext('2d').drawImage(img, 0, 0);
      /* O canto, que é onde estava a transparência. */
      const p = t2.getContext('2d').getImageData(2, 2, 1, 1).data;
      return [p[0], p[1], p[2], p[3]];`);

    const claro = await corDeFundo('255,255,255,1');
    certo(Array.isArray(claro) && claro[3] === 255 && !(claro[0] > 240 && claro[1] > 240 && claro[2] > 240),
      'um logótipo CLARO não fica sobre branco — senão desaparecia no círculo da Google',
      JSON.stringify(claro));

    const escuro = await corDeFundo('20,20,20,1');
    certo(Array.isArray(escuro) && escuro[0] > 240 && escuro[1] > 240 && escuro[2] > 240,
      'e um logótipo ESCURO assenta em branco', JSON.stringify(escuro));
  }


  {
    /* --- o fundo MEDE-SE, não se assume -------------------------------
       O ramo escuro escolhia branco, que contrasta sempre. O ramo claro
       escolhia a cor da marca sem lhe perguntar nada — e há um selector de
       cor livre no ecrã ao lado. Uma pastelaria em creme com um logótipo
       branco ficava com branco sobre creme: invisível.
       ---------------------------------------------------------------- */
    const comMarca = async (cor, rgbaDoLogotipo) => palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = ${JSON.stringify(cor)};
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      /* O ecrã lê a cor do estado em memória; recarregar seria perder o
         ficheiro. Escreve-se nos dois sítios. */
      const tela = document.createElement('canvas');
      tela.width = 16; tela.height = 16;
      const c = tela.getContext('2d');
      c.fillStyle = 'rgba(${rgbaDoLogotipo})';
      c.fillRect(4, 4, 8, 8);
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'l.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1100));
      const e2 = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n2 = e2.negocios.find((x) => x.id === 'n-torrado') || e2.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n2.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      t2.getContext('2d').drawImage(img, 0, 0);
      const p = t2.getContext('2d').getImageData(2, 2, 1, 1).data;
      return [p[0], p[1], p[2]];`);

    /* Marca ESCURA + logótipo claro: a cor da marca serve, e usa-se. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#2B1810';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');
    const escura = await comMarca('#2B1810', '255,255,255,1');
    /* A COR EXACTA DA MARCA, e não «uma cor escura». A afirmação pedia os
       três canais abaixo de 80 — e o preto de recurso (#17161C) também passa
       nisso. Media «é escuro», não «é a marca», que é justamente o ramo em
       prova. */
    certo(escura && escura[0] === 0x2B && escura[1] === 0x18 && escura[2] === 0x10,
      'logótipo claro + marca escura: usa-se a COR DA MARCA (#2B1810), que contrasta',
      JSON.stringify(escura));
    certo(!(escura && escura[0] === 0x17 && escura[1] === 0x16 && escura[2] === 0x1C),
      'e não o preto de recurso — que também é escuro e não provaria nada',
      JSON.stringify(escura));

    /* Marca CLARA + logótipo claro: a cor da marca NÃO serve. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#F2E8DC';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');
    const clara = await comMarca('#F2E8DC', '255,255,255,1');
    const luz = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
    const razao = clara
      ? (1.05) / (0.2126 * luz(clara[0]) + 0.7152 * luz(clara[1]) + 0.0722 * luz(clara[2]) + 0.05)
      : 0;
    certo(clara && razao >= 3,
      'logótipo claro + marca CLARA: a marca é recusada e o fundo passa a contrastar',
      `${JSON.stringify(clara)} → ${razao.toFixed(2)}:1`);

    /* Repõe-se a cor que o resto do módulo espera. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#EE9125';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');
  }


  {
    /* --- a cor cozida deixa de condizer -------------------------------
       O fundo do logótipo é pintado no momento do envio e fica dentro dos
       bytes do PNG. Mudar a cor do cartão depois não o refaz — e não há como
       o refazer, o ficheiro original não fica guardado. O cartão ficava com a
       cor nova à volta e um quadrado da cor velha no meio, e não havia nada
       no ecrã que explicasse porquê.
       ---------------------------------------------------------------- */
    /* Um logótipo com fundo PRÓPRIO não regista cor nenhuma: o fundo é de
       quem o desenhou e não envelhece com a marca.

       E envia-se um AQUI, em vez de contar com o que o bloco de cima deixou —
       o que lá estava era transparente, e a afirmação passava por uma razão
       diferente da que anuncia. Pior: o fundo próprio é DE PROPÓSITO igual à
       cor do cartão, que é o caso em que a decisão «é da marca?» se enganava
       se fosse tomada por comparação de cores em vez de pelo ramo. */
    const opaco = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const cor = n.cor;
      const tela = document.createElement('canvas');
      tela.width = 32; tela.height = 32;
      const c = tela.getContext('2d');
      c.fillStyle = cor; c.fillRect(0, 0, 32, 32);          /* a moldura do ficheiro */
      c.fillStyle = '#FFFFFF'; c.fillRect(10, 10, 12, 12);  /* a marca */
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'proprio.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const e2 = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n2 = e2.negocios.find((x) => x.id === 'n-torrado') || e2.negocios[0];
      return { fundo: n2.logotipo_fundo || null, cor: n2.cor };`);
    certo(opaco && opaco.fundo === null,
      'um logótipo com fundo PRÓPRIO não regista cor cozida — mesmo quando esse fundo é a cor do cartão',
      JSON.stringify(opaco));
    certo(!(await palco.ver('.aviso-demo')) || !(await palco.texto('.aviso-demo')).includes('cor antiga'),
      'e por isso não há aviso nenhum');

    /* Agora um TRANSPARENTE com uma marca que a cor do cartão aguenta.
       O laranja #EE9125 contra branco dá 2,4:1 — abaixo dos 3:1 que a WCAG
       pede a um elemento gráfico — e por isso é recusado; com o castanho
       escuro do café passa, e é a cor da marca que fica cozida. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#2B1810';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');
    await palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 16; tela.height = 16;
      const c = tela.getContext('2d');
      c.fillStyle = 'rgba(255,255,255,1)';
      c.fillRect(4, 4, 8, 8);
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'transparente.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return true;`);

    const gravado = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      return { fundo: n.logotipo_fundo || null, cor: n.cor };`);
    certo(gravado && gravado.fundo
       && gravado.fundo.toUpperCase() === String(gravado.cor).toUpperCase(),
      'um logótipo transparente com fundo da marca regista a cor que lhe ficou por trás',
      JSON.stringify(gravado));

    /* Muda-se a cor do cartão sem mexer na imagem. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#0B7285';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');

    const aviso = await palco.js(`
      const a = [...document.querySelectorAll('.aviso-demo')]
        .find((x) => /cor antiga/i.test(x.textContent));
      return a ? a.textContent.replace(/\\s+/g, ' ').trim() : null;`);
    certo(aviso,
      'mudar a cor do cartão avisa que o logótipo ficou com a cor antiga por trás',
      String(aviso));
    certo(aviso && /carrega a imagem outra vez/i.test(aviso),
      'e diz o que fazer — refazer a imagem não dá, o original não fica guardado',
      String(aviso));
    certo(aviso && aviso.includes(gravado.fundo) && aviso.includes('#0B7285'),
      'e nomeia as duas cores, para não ser um aviso vago',
      String(aviso));

    /* Repõe-se, e a nova gravação apaga o aviso. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      n.cor = '#EE9125';
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.recarregar();
    await palco.esperar('#barra .barra-item', 12000);
    await esperarCamara(palco);
    await irAo(palco, 'programa');
  }


  {
    /* --- um logótipo de traço fino NÃO é uma imagem vazia --------------
       A recusa de «imagem vazia» e a aparagem estavam a responder com
       limiares diferentes: a aparagem dizia «nada abaixo de 8», a contagem do
       desenho dizia «nada abaixo de 32». Entre os dois cabia um logótipo
       inteiro — num ficheiro de 2048 px com traços de 1 px, cada célula da
       grelha de medição fica com alfa ≈ 16. A aparagem encontrava a caixa
       certa e a contagem dizia que não havia desenho nenhum: o dono não
       conseguia gravar, e sem logótipo não há Wallet.

       Agora mede-se o que foi MESMO desenhado, no tamanho final.
       ---------------------------------------------------------------- */
    const traco = await palco.js(`
      const L = 2048;
      const tela = document.createElement('canvas');
      tela.width = L; tela.height = L;
      const c = tela.getContext('2d');
      /* Um contorno de um píxel — o «monoline» de que estão cheios os
         logótipos desenhados em vector. */
      c.strokeStyle = '#101010'; c.lineWidth = 1;
      for (let i = 0; i < 12; i += 1) {
        c.beginPath();
        c.moveTo(L * 0.2, L * 0.3 + i * 30);
        c.lineTo(L * 0.8, L * 0.3 + i * 30);
        c.stroke();
      }
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'traco.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1500));

      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      const cc = t2.getContext('2d');
      cc.drawImage(img, 0, 0);
      const d = cc.getImageData(0, 0, img.width, img.height).data;
      /* O fundo é o canto; conta-se o que difere dele. */
      const fundo = [d[0], d[1], d[2]];
      let diferentes = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (Math.abs(d[k] - fundo[0]) > 20 || Math.abs(d[k+1] - fundo[1]) > 20
            || Math.abs(d[k+2] - fundo[2]) > 20) diferentes += 1;
      }
      return { aviso: document.body.innerText.includes('vazia'),
               lado: img.width, diferentes, fundo };`);

    certo(traco && traco.aviso === false,
      'um logótipo de traço fino não é recusado como «imagem vazia»',
      JSON.stringify(traco));
    certo(traco && traco.diferentes > 500,
      'e o que fica guardado tem mesmo desenho lá dentro',
      JSON.stringify(traco && { diferentes: traco.diferentes, lado: traco.lado }));
  }

  {
    /* --- um halo suave não encolhe a marca -----------------------------
       A aparagem trata como moldura tudo o que esteja abaixo de alfa 32.
       Baixar esse limiar para 8 «por coerência» com o do RGB deixava de
       aparar halos e sombras: a caixa crescia até onde o halo chegasse, e
       como a escala é pela DIAGONAL da caixa, o desenho era encolhido pelo
       halo em vez de pelo logótipo.
       ---------------------------------------------------------------- */
    const halo = await palco.js(`
      const L = 512;
      const tela = document.createElement('canvas');
      tela.width = L; tela.height = L;
      const c = tela.getContext('2d');
      /* Um halo muito ténue por quase toda a tela... */
      c.fillStyle = 'rgba(0,0,0,0.05)';
      c.fillRect(L * 0.05, L * 0.05, L * 0.9, L * 0.9);
      /* ...e a marca a sério, pequena e opaca, no meio. */
      c.fillStyle = '#101010';
      c.fillRect(L * 0.35, L * 0.35, L * 0.3, L * 0.3);
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'halo.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1500));

      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      const cc = t2.getContext('2d');
      cc.drawImage(img, 0, 0);
      const d = cc.getImageData(0, 0, img.width, img.height).data;
      /* Mede-se a largura da MARCA na linha do meio: o que é bem escuro. */
      const meio = (img.height / 2 | 0);
      let esq = img.width; let dir = 0;
      for (let x = 0; x < img.width; x += 1) {
        const k = (meio * img.width + x) * 4;
        if (d[k] < 90 && d[k+1] < 90 && d[k+2] < 90) { if (x < esq) esq = x; if (x > dir) dir = x; }
      }
      return { lado: img.width, marca: dir >= esq ? dir - esq + 1 : 0 };`);

    certo(halo && halo.marca > halo.lado * 0.25,
      'um halo ténue à volta não encolhe a marca — a aparagem apara-o',
      JSON.stringify(halo));
  }

  {
    /* --- uma imagem vazia não é um logótipo ---------------------------
       Um PNG que ficou todo transparente na exportação passava inteiro: o
       fundo ficava branco e guardava-se um quadrado branco. O dono lia
       «Logótipo guardado», o botão da Wallet aparecia, e os clientes ficavam
       com um círculo vazio no cartão.
       ---------------------------------------------------------------- */
    const antes = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      return n.logotipo || null;`);

    const resposta = await palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 64; tela.height = 64;           /* tudo transparente */
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'vazio.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return document.body.innerText;`);

    certo(/vazia/i.test(resposta),
      'uma imagem sem nada visível é recusada, e diz-se porquê',
      String(resposta).slice(0, 160));

    /* E UMA OPACA DE UMA COR SÓ TAMBÉM. A guarda antiga perguntava «há píxeis
       opacos?», o que num JPEG é sempre verdade — era código morto para
       metade dos formatos que a rota aceita. Uma folha digitalizada em branco,
       ou uma exportação com a camada errada escondida, passava e ficava
       guardada como um quadrado de cor. */
    const opacaSo = await palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 64; tela.height = 64;
      const c = tela.getContext('2d');
      c.fillStyle = '#FFFFFF'; c.fillRect(0, 0, 64, 64);
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'branco.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return document.body.innerText;`);
    certo(/vazia|só uma cor/i.test(opacaSo),
      'e uma imagem OPACA de uma cor só também — um JPEG nunca tem transparência',
      String(opacaSo).slice(0, 160));

    const depois = await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      return n.logotipo || null;`);
    /* O DATA URL INTEIRO, e não os primeiros 40 caracteres. Os 22 primeiros
       são `data:image/png;base64,` e os 18 seguintes codificam a assinatura
       do PNG e o início do IHDR — iguais em QUALQUER png de 512×512. Comparar
       40 caracteres era comparar duas constantes: a afirmação dava certo
       mesmo com o logótipo substituído por um quadrado branco. */
    certo(depois === antes,
      'e o logótipo que lá estava não é substituído — byte a byte, o data URL inteiro',
      `${String(antes).length} caracteres → ${String(depois).length}`);
  }

  {
    /* O LOGÓTIPO TEM DE CABER INTEIRO — e isto era um defeito a sério.

       O balcão cortava um QUADRADO AO CENTRO. Quase toda a gente tem por
       logótipo o nome escrito, que é uma imagem larga e baixa: «TITI
       BARBERSHOP» cortado ao centro fica «I BARBER». E o dono não via nada de
       errado no balcão — via no telemóvel de um cliente, semanas depois.

       Conduz-se com uma imagem larga que tem marcas nas DUAS pontas: se
       alguma delas não chegar ao outro lado, foi cortada.

       E não basta caber no quadrado. A Google desenha isto dentro de um
       CÍRCULO; o que fica nos cantos do quadrado desaparece na mesma. Por
       isso mede-se também a distância ao centro do pixel desenhado mais
       afastado — tem de ficar dentro do raio. */
    const pontas = await palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 240; tela.height = 40;
      const c = tela.getContext('2d');
      c.fillStyle = '#FF0000'; c.fillRect(0, 0, 20, 40);      /* ponta esquerda */
      c.fillStyle = '#0000FF'; c.fillRect(220, 0, 20, 40);    /* ponta direita */
      c.fillStyle = '#404040'; c.fillRect(20, 16, 200, 8);    /* o meio */
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'largo.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      t2.getContext('2d').drawImage(img, 0, 0);
      const d = t2.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      const meio = img.width / 2;
      let vermelhos = 0; let azuis = 0; let maisLonge = 0;
      const fundo = [d[0], d[1], d[2]];
      for (let y = 0; y < img.height; y += 1) {
        for (let x = 0; x < img.width; x += 1) {
          const i = (y * img.width + x) * 4;
          const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
          if (r > 200 && g < 70 && b < 70) vermelhos += 1;
          if (b > 200 && r < 70 && g < 70) azuis += 1;
          const igualAoFundo = Math.abs(r - fundo[0]) < 12
            && Math.abs(g - fundo[1]) < 12 && Math.abs(b - fundo[2]) < 12;
          if (!igualAoFundo) {
            const dist = Math.hypot(x + 0.5 - meio, y + 0.5 - meio);
            if (dist > maisLonge) maisLonge = dist;
          }
        }
      }
      return { lado: img.width, vermelhos, azuis, maisLonge: Math.round(maisLonge) };`);

    certo(pontas && pontas.vermelhos > 0 && pontas.azuis > 0,
      'um logótipo largo mantém as DUAS pontas — não se corta um quadrado ao centro',
      JSON.stringify(pontas));
    certo(pontas && pontas.maisLonge <= pontas.lado / 2,
      'e o desenho fica todo dentro do círculo em que a Google o encaixa',
      JSON.stringify(pontas));
  }

  {
    /* QUEM JÁ TRAZ FUNDO PRÓPRIO FICA COM ELE. Um ficheiro opaco já foi
       desenhado por alguém que escolheu o fundo em que aquilo se lê — pôr-lhe
       branco à volta punha uma moldura que ninguém pediu. E a margem que ele
       traz apara-se, senão o desenho encolhe dentro do círculo sem precisar. */
    const proprio = await palco.js(`
      const tela = document.createElement('canvas');
      tela.width = 64; tela.height = 64;
      const c = tela.getContext('2d');
      c.fillStyle = '#008000'; c.fillRect(0, 0, 64, 64);     /* o fundo dele */
      c.fillStyle = '#FFFFFF'; c.fillRect(24, 24, 16, 16);   /* a marca */
      const png = tela.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(png.split(',')[1]), (ch) => ch.charCodeAt(0));
      const f = new File([bytes], 'opaco.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const campo = document.querySelector('#f-logotipo');
      campo.files = dt.files;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = n.logotipo; });
      const t2 = document.createElement('canvas');
      t2.width = img.width; t2.height = img.height;
      const cc = t2.getContext('2d');
      cc.drawImage(img, 0, 0);
      const canto = cc.getImageData(2, 2, 1, 1).data;
      const centro = cc.getImageData(img.width / 2, img.height / 2, 1, 1).data;
      /* Quanto do lado é que a marca ocupa depois de aparada a moldura. */
      const d = cc.getImageData(0, 0, img.width, img.height).data;
      let esq = img.width; let dir = 0;
      for (let x = 0; x < img.width; x += 1) {
        const i = ((img.height / 2 | 0) * img.width + x) * 4;
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) { if (x < esq) esq = x; if (x > dir) dir = x; }
      }
      return { canto: [canto[0], canto[1], canto[2], canto[3]],
               centro: [centro[0], centro[1], centro[2]],
               marca: dir - esq + 1, lado: img.width };`);

    certo(proprio && proprio.canto[1] > 100 && proprio.canto[0] < 60 && proprio.canto[2] < 60,
      'um logótipo que já traz fundo próprio fica com esse fundo, e não com branco',
      JSON.stringify(proprio && proprio.canto));
    certo(proprio && proprio.marca > proprio.lado * 0.4,
      'e a margem que o ficheiro trazia é aparada — senão a marca encolhia sem precisar',
      JSON.stringify(proprio));
  }

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
  /* O 8/10 está a dois e o 9/10 está a UM. O servidor conta os dois
     (`BETWEEN 1 AND 2`), e era isso que o texto tinha de dizer — dizia «a
     dois», e quem estivesse a um ouvia do balcão que lhe faltavam dois. O
     próprio nome deste teste já dizia «8/10 e 9/10»: a regra estava certa
     na cabeça de quem o escreveu e errada no ecrã. */
  certo(conselhos[0] === '2 cliente(s) a um ou dois carimbos do prémio',
    'Hoje: conta os clientes a um ou dois carimbos do prémio (8/10 e 9/10)',
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
  /* Doze sugestões MAIS a cor que o negócio já tem, quando ela não é uma
     delas. É esse décimo-terceiro lugar que impede a cor de marca de se
     perder: sem ele, a paleta abria sem nada escolhido e o primeiro toque
     substituía-a. */
  certo(cores.length === 12 || cores.length === 13,
    'O cartão: a paleta oferece as doze sugestões, mais a cor actual se for outra',
    String(cores.length));

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
  certo(conselhosDepois[0] === '1 cliente(s) a um ou dois carimbos do prémio',
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

  const cfg = await palco.js('return window.CARIMBO_CONFIG || null');
  certo(cfg && typeof cfg.base === 'string',
    'cartaz: a app sabe qual é o prefixo do sítio', JSON.stringify(cfg));
  const base = cfg ? cfg.base : null;
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
