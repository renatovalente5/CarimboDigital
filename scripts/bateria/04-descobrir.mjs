/* =========================================================================
   Bateria · 04 — Descobrir negócios e aderir

   O caminho pelo qual a carteira cresce. Tudo o resto na app depende de
   haver lá um cartão, e um cartão entra por aqui (ou pelo primeiro carimbo
   ao balcão, que é o módulo do balcão).

   Corre em modo de demonstração, onde a semente é conhecida: seis negócios,
   seis programas, e quatro cartões semeados mais o da gelataria já pronto a
   levantar — cinco na carteira. Sobra exactamente um programa por aderir,
   o da Patas Felizes, e é esse que se junta com o rato.
   ========================================================================= */

export const nome = '04 · Descobrir e aderir';

/* A semente do demo (_fonte/js/api.js). Se mudar, este módulo tem de mudar
   com ela — é de propósito: é a lista que a pessoa vê. */
const NEGOCIOS = ['Café Torrado', 'Barbearia Navalha', 'Salão Camélia',
                  'Padaria do Forno', 'Patas Felizes', 'Gelataria Luar'];
const SEMEADOS = 5;                 /* cartões que a demonstração já traz */
const POR_ADERIR = 'Patas Felizes'; /* o único negócio sem cartão */

const DESCOBRIR = '#barra .barra-item:nth-child(2)';
const CARTEIRA = '#barra .barra-item:nth-child(1)';
const NA_CARTEIRA = '#principal > .pilha > button.cartao';

/** Passa as boas-vindas, que aparecem sempre à primeira abertura. */
async function passarBoasVindas(palco) {
  for (let i = 0; i < 8; i++) {
    if (!(await palco.visivel('#boas-vindas'))) return;
    await palco.clicar('#bv-seguinte');
  }
  throw new Error('as boas-vindas não acabaram em 8 passos');
}

/** Os rótulos dos botões de cada cartão da lista: «Juntar» ou «Já tens». */
async function selos(palco) {
  return palco.textos('.cartao-descobrir .cartao-selo');
}

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra');

  const antes = await palco.contar(NA_CARTEIRA);
  certo(antes === SEMEADOS,
    `a carteira começa com os ${SEMEADOS} cartões da demonstração`,
    `tem ${antes}`);

  /* --- a lista ---------------------------------------------------------- */

  await palco.clicar(DESCOBRIR);
  await palco.esperar('.cartao-descobrir');

  certo(await palco.texto('#topo-titulo') === 'Descobrir',
    'o topo passa a dizer «Descobrir»', String(await palco.texto('#topo-titulo')));
  certo(await palco.atributo(DESCOBRIR, 'aria-current') === 'page',
    'o separador Descobrir fica marcado como o actual',
    String(await palco.atributo(DESCOBRIR, 'aria-current')));

  const cartoes = await palco.contar('.cartao-descobrir');
  certo(cartoes === NEGOCIOS.length,
    `a lista traz os ${NEGOCIOS.length} programas da demonstração`, `tem ${cartoes}`);

  const nomes = await palco.textos('.cartao-descobrir .cartao-nome');
  const faltam = NEGOCIOS.filter((n) => !nomes.includes(n));
  certo(faltam.length === 0, 'todos os negócios semeados aparecem na lista',
    `faltam ${faltam.join(', ')}`);

  /* Um cartão sem prémio à vista não convence ninguém a aderir. */
  const premios = await palco.textos('.cartao-descobrir .cartao-premio');
  certo(premios.length === cartoes && premios.every((t) => t.length > 3),
    'cada programa mostra o prémio que dá', premios.join(' | '));

  const rotulos = await palco.textos('.cartao-descobrir .cartao-rotulo');
  certo(rotulos.includes('6 carimbos') && rotulos.includes('Programa de pontos'),
    'o rótulo diz quantos carimbos são, ou que é de pontos', rotulos.join(' | '));

  const texto = await palco.textoTodo();
  certo(!/undefined|NaN|\[object Object\]/.test(texto),
    'nada de «undefined», «NaN» ou «[object Object]» no ecrã');

  /* Pesquisa ou filtro: não existe nenhum. Com seis negócios ainda se lê a
     lista toda de uma vez — esta afirmação é o alarme para quando deixar de
     ser verdade. */
  const campos = await palco.contar('#principal input, #principal select');
  certo(campos > 0 || cartoes <= 12,
    'sem pesquisa nem filtro, mas a lista ainda cabe num ecrã de telemóvel',
    `${campos} campos para ${cartoes} programas`);

  /* --- quem já tenho e quem falta --------------------------------------- */

  const antesSelos = await selos(palco);
  const jaTens = antesSelos.filter((t) => t === 'Já tens').length;
  const juntar = antesSelos.filter((t) => t === 'Juntar').length;
  certo(jaTens === SEMEADOS && juntar === cartoes - SEMEADOS,
    'os cartões que já tenho aparecem como «Já tens» e os outros como «Juntar»',
    `${jaTens} «Já tens», ${juntar} «Juntar»`);

  const alvo = `[aria-label="Juntar o cartão de ${POR_ADERIR}"]`;
  certo(await palco.ver(alvo), `o botão de juntar o ${POR_ADERIR} está lá`);

  /* O botão é o alvo de toque de uma acção principal, num telemóvel. A WCAG
     2.2 (2.5.8, AA) pede 24 px de lado. */
  const caixa = await palco.medir(alvo);
  certo(caixa && caixa.altura >= 24 && caixa.largura >= 24,
    'o botão «Juntar» tem pelo menos 24 px de lado',
    caixa ? `${Math.round(caixa.largura)}×${Math.round(caixa.altura)}` : 'sem tamanho');

  await palco.captura('04-descobrir-lista');

  /* --- aderir ------------------------------------------------------------ */

  await palco.clicar(alvo);

  certo(await palco.visivel('.aviso-bom'), 'um aviso confirma que o cartão entrou');
  certo((await palco.texto('.aviso-bom') || '').includes(POR_ADERIR),
    'o aviso diz de que negócio é o cartão', String(await palco.texto('.aviso-bom')));

  certo(await palco.texto('#principal h1') === 'Os meus cartões',
    'depois de aderir volta-se à carteira',
    String(await palco.texto('#principal h1')));

  const depois = await palco.contar(NA_CARTEIRA);
  certo(depois === antes + 1,
    'a carteira sobe exactamente um cartão', `${antes} → ${depois}`);

  const etiquetas = await palco.js(`return [...document.querySelectorAll(
    ${JSON.stringify(NA_CARTEIRA)})].map(n => n.getAttribute('aria-label'))`);
  const novos = etiquetas.filter((t) => t && t.startsWith(POR_ADERIR));
  certo(novos.length === 1, `o cartão do ${POR_ADERIR} está na carteira`,
    `${novos.length} encontrados em ${etiquetas.length}`);
  certo(novos[0] === `${POR_ADERIR}. faltam 6 carimbos: Banho e tosquia grátis.`,
    'o cartão novo começa a zero, com o objectivo do programa', String(novos[0]));

  /* Um cartão acabado de juntar que só se vê a rolar não parece ter entrado.
     A ordem é: primeiro os que têm prémio, depois os mais recentes. */
  certo(etiquetas[1] && etiquetas[1].startsWith(POR_ADERIR),
    'o cartão novo aparece logo a seguir aos que têm prémio à espera',
    etiquetas.map((t) => String(t).split('.')[0]).join(' | '));

  await palco.captura('04-carteira-depois-de-aderir');

  /* Ficou mesmo guardado, ou só pintado? */
  const guardado = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    return (e.cartoes || []).filter(c => c.programaId === 'p-patas').length;`);
  certo(guardado === 1, 'o cartão novo ficou guardado, não só desenhado',
    `${guardado} no armazenamento`);

  await palco.recarregar();
  await palco.esperar(NA_CARTEIRA);
  const depoisDeRecarregar = await palco.contar(NA_CARTEIRA);
  certo(depoisDeRecarregar === depois,
    'os cartões sobrevivem a recarregar a página', `${depoisDeRecarregar} de ${depois}`);

  /* --- aderir outra vez ao mesmo ---------------------------------------- */

  await palco.clicar(DESCOBRIR);
  await palco.esperar('.cartao-descobrir');

  const selosAgora = await selos(palco);
  certo(selosAgora.filter((t) => t === 'Juntar').length === 0,
    'já não sobra nenhum «Juntar» — todos os programas estão na carteira',
    selosAgora.join(' | '));
  certo(await palco.ver(`[aria-label="Já tens o cartão de ${POR_ADERIR}"]`),
    `o ${POR_ADERIR} passou a «Já tens»`, selosAgora.join(' | '));

  await palco.clicar(`[aria-label="Já tens o cartão de ${POR_ADERIR}"]`);
  certo(await palco.texto('#principal h1') === 'Os meus cartões',
    'carregar em «Já tens» leva à carteira', String(await palco.texto('#principal h1')));

  const repetido = await palco.contar(NA_CARTEIRA);
  certo(repetido === depois,
    'aderir duas vezes ao mesmo programa não duplica o cartão',
    `${depois} → ${repetido}`);

  const duplicados = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    return (e.cartoes || []).filter(c => c.programaId === 'p-patas').length;`);
  certo(duplicados === 1, 'e não deixa dois cartões do mesmo programa no armazenamento',
    `${duplicados} guardados`);

  /* --- quando o programa deixa de existir a meio ------------------------ */

  /* O caminho de erro do botão «Juntar», que é o único sítio onde se vê o
     que ele faz enquanto o pedido corre. Um programa pode desaparecer entre
     o desenho da lista e o toque — o dono desactiva-o — e o servidor
     responde 404 «Programa não encontrado» (worker/src/index.js, POST
     /v1/cliente/aderir). A demonstração atira o mesmo erro, palavra por
     palavra. Se a app não o apanhar, a excepção fica por apanhar e a
     afirmação «nada rebentou por baixo» reprova também: é o mesmo defeito
     visto do outro lado. */
  const QUIOSQUE = 'Quiosque do Parque';
  await palco.js(`
    const chave = 'carimbo-demo:demo';
    const e = JSON.parse(localStorage.getItem(chave));
    e.negocios.push({
      id: 'n-quiosque', slug: 'quiosque-do-parque', nome: ${JSON.stringify(QUIOSQUE)},
      categoria: 'Quiosque', cor: '#2E6F40', localidade: 'Ovar',
      programas: [{
        id: 'p-quiosque', negocioId: 'n-quiosque', nome: 'Cartão do quiosque',
        tipo: 'carimbos', selo: 'chavena', objetivo: 5,
        premio: 'Um sumo natural', arrefecimento: 3600, ativo: 1,
      }],
    });
    localStorage.setItem(chave, JSON.stringify(e));
    return true;`);
  await palco.recarregar();
  await palco.esperar('#barra');
  await palco.clicar(DESCOBRIR);

  const novoAlvo = `[aria-label="Juntar o cartão de ${QUIOSQUE}"]`;
  await palco.esperar(novoAlvo);

  /* Agora o dono desactiva-o, com a lista já desenhada no telemóvel. */
  await palco.js(`
    const chave = 'carimbo-demo:demo';
    const e = JSON.parse(localStorage.getItem(chave));
    e.negocios = e.negocios.filter(n => n.id !== 'n-quiosque');
    localStorage.setItem(chave, JSON.stringify(e));
    return true;`);

  await palco.clicar(novoAlvo);

  certo(await palco.visivel('.aviso'),
    'quando aderir falha, a app diz à pessoa que falhou',
    `avisos no ecrã: ${await palco.contar('.aviso')}`);

  /* A outra metade do estado do botão: falhar não pode deixá-lo desactivado
     para sempre — o defeito que a app já apanhou no painel de guardar a
     conta, onde o `disabled` é reposto no catch. */
  const trancado = await palco.js(`const n = document.querySelector(
    ${JSON.stringify(novoAlvo)}); return n ? n.disabled : null`);
  certo(trancado === false,
    'o botão não fica trancado depois de a adesão falhar', String(trancado));

  const semMudar = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    return (e.cartoes || []).length;`);
  certo(semMudar === depois,
    'uma adesão falhada não deixa cartão nenhum para trás',
    `${semMudar} cartões guardados, esperavam-se ${depois}`);

  await palco.captura('04-aderir-falhado');

  /* --- quando não há negócios nenhuns ----------------------------------- */

  await palco.js(`
    const chave = 'carimbo-demo:demo';
    const e = JSON.parse(localStorage.getItem(chave));
    e.negocios = [];
    localStorage.setItem(chave, JSON.stringify(e));
    return true;`);
  await palco.recarregar();
  await palco.esperar('#barra');

  await palco.clicar(DESCOBRIR);
  await palco.esperar('#principal h1');

  certo(await palco.contar('.cartao-descobrir') === 0,
    'sem negócios não fica nenhum cartão na lista',
    String(await palco.contar('.cartao-descobrir')));

  /* A carteira e os prémios explicam-se quando estão vazios; este ecrã
     deixa a pessoa a olhar para um título e um vazio. */
  certo(await palco.visivel('#principal .vazio'),
    'sem negócios o ecrã explica que não há nada para ver',
    (await palco.texto('#principal') || '').slice(0, 120));

  await palco.captura('04-descobrir-sem-negocios');
}
