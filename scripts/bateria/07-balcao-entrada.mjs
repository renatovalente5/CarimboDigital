/* =========================================================================
   Bateria · 07 — Balcão: entrar e fundar um negócio

   A primeira coisa que um dono de café vê. São três portas — entrar com o
   email de quem já tem negócio, fundar um negócio com um convite, ou só
   espreitar — e nenhuma delas tem uma segunda hipótese: se falhar aqui, a
   pessoa fecha o separador e não volta.

   Duas notas sobre como isto corre:

   · As três portas só existem em modo REMOTO. Com `?demo=1` o `desenharEntrada`
     do balcao.js troca-as por um único «Experimentar agora», por isso a
     entrada a sério tem de ser vista sem o parâmetro da demonstração.

   · E sem o parâmetro há um Worker a sério do outro lado. Corta-se a rede
     antes de tocar em «Enviar o código» ou «Criar»: nada deste teste pode
     criar negócios na base de dados de produção. O que se quer ver aqui é o
     que o CLIENTE valida antes de enviar seja o que for — e o que ele mostra
     à pessoa quando o envio não corre bem.
   ========================================================================= */

export const nome = '07 · Balcão: entrar e fundar um negócio';
export const desculpar = [/favicon/];

/* As três portas não têm id: distinguem-se pela classe do botão, que é o que
   o desenharEntrada lhes põe. */
const ENTRAR = '#entrada-acoes .btn-cheio';
const CONVITE = '#entrada-acoes .btn-contorno';
const ESPREITAR = '#entrada-acoes .btn-fantasma';
const BOTAO_PAINEL = '.painel-folha .btn-cheio';

/* ---------------------------------------------------------------------------
   Avisos

   O `avisar()` do núcleo deita fora o aviso anterior antes de pôr o novo, e o
   novo tem o mesmo aspecto do velho. Para se saber que apareceu um aviso NOVO
   marca-se o que já lá estava antes de carregar no botão, e espera-se por um
   por marcar.
   --------------------------------------------------------------------------- */

async function dormir(palco, ms) {
  await palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);
}

async function marcarAvisos(palco) {
  await palco.js(
    "for (const n of document.querySelectorAll('.aviso')) n.dataset.visto = 'sim'; return true");
}

/** O texto do primeiro aviso por marcar, ou `null` se não aparecer nenhum. */
async function avisoNovo(palco, tecto = 8000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const t = await palco.texto('.aviso:not([data-visto])');
    if (t) return t;
    if (Date.now() > limite) return null;
    await dormir(palco, 120);
  }
}

/* Um aviso vive 4,2 segundos e fica por cima da parte de baixo do ecrã, que é
   onde estão os botões. Depois de o ler tira-se do caminho, senão o clique
   seguinte bate nele em vez de bater no botão — e a bateria recusa-se a
   carregar em elementos tapados, e bem. Que ele tapa ou não o botão é medido
   uma vez, à parte, como afirmação própria. */
async function limparAvisos(palco) {
  await palco.js("for (const n of document.querySelectorAll('.aviso')) n.remove(); return true");
}

/** Quem está mesmo por cima do centro de um elemento. */
async function quemTapa(palco, seletor) {
  return palco.js(`const b = document.querySelector(${JSON.stringify(seletor)});
    if (!b) return 'não existe';
    const r = b.getBoundingClientRect();
    const em = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!em) return 'fora do ecrã';
    if (em === b || b.contains(em) || em.contains(b)) return 'o próprio';
    return em.className || em.tagName.toLowerCase();`);
}

async function desativado(palco, seletor) {
  return palco.js(`const n = document.querySelector(${JSON.stringify(seletor)});
    return n ? n.disabled : null`);
}

/** A cor com que o cartão da pré-visualização ficou mesmo pintado. */
async function corDoCartao(palco, seletor) {
  return palco.js(`const n = document.querySelector(${JSON.stringify(seletor)});
    return n ? { fundo: n.style.getPropertyValue('--m').trim(),
                 tinta: n.style.getPropertyValue('--m-txt').trim() } : null`);
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* --- as três portas --------------------------------------------------- */

  await palco.ir('/balcao/');
  await palco.esperar('#entrada-acoes button');

  certo(await palco.visivel('#entrada'), 'a entrada aparece a quem não tem sessão');
  certo(!(await palco.visivel('#aplicacao')), 'e a aplicação fica escondida por trás dela');

  const portas = await palco.textos('#entrada-acoes button');
  certo(portas.length === 3, 'a entrada tem três portas', `tem ${portas.length}: ${portas.join(' | ')}`);
  certo(portas.join('|') === 'Entrar|Tenho um convite|Só quero ver como funciona',
    'as três portas são entrar, convite e espreitar', portas.join('|'));

  const nota = await palco.textoTodo();
  certo(nota.includes('Sem instalar nada'),
    'a entrada diz o que não é preciso para experimentar', nota.slice(0, 120));

  await palco.captura('07-entrada-tres-portas');

  /* Daqui para a frente há botões que falam com o Worker de produção. Nada
     deste teste pode lá chegar. */
  await palco.semRede(true);

  /* --- porta 1: entrar por email ---------------------------------------- */

  await palco.clicar(ENTRAR);
  certo(await palco.visivel('#painel'), 'entrar por email: o painel abre');
  certo((await palco.texto('.painel-folha h2')) === 'Entrar no balcão',
    'entrar por email: o painel diz ao que vem', String(await palco.texto('.painel-folha h2')));
  certo(await palco.ver('#e-email'), 'entrar por email: há campo para o email');

  /* Ao balcão escreve-se com um polegar: o cursor tem de já lá estar. */
  const foco = await palco.focado();
  certo(foco && foco.etiqueta === 'input',
    'entrar por email: o foco cai sozinho no campo', JSON.stringify(foco));

  await palco.escrever('#e-email', 'isto-nao-e-um-email');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoEmail = await avisoNovo(palco);
  certo(avisoEmail === 'Esse email não parece válido.',
    'email mal escrito: a recusa aparece no ecrã, não só na consola', String(avisoEmail));
  certo(await palco.visivel('.aviso:not([data-visto])'),
    'e o aviso está mesmo à vista da pessoa');
  certo(await palco.visivel('#painel'),
    'o painel fica aberto para se corrigir o email');
  certo((await desativado(palco, BOTAO_PAINEL)) === false,
    'e o botão não fica morto depois de uma recusa',
    String(await desativado(palco, BOTAO_PAINEL)));

  /* O aviso nasce colado ao fundo do ecrã, que é onde vive o botão principal
     do painel. Se o tapar, a pessoa lê o erro e não consegue tentar de novo. */
  const tapa = await quemTapa(palco, BOTAO_PAINEL);
  certo(tapa === 'o próprio', 'o aviso de erro não tapa o botão do painel', String(tapa));
  await limparAvisos(palco);

  /* Email bem escrito, mas sem rede: o erro do pedido tem de chegar ao ecrã. */
  await palco.escrever('#e-email', 'dono@cafedabateria.pt');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoRede = await avisoNovo(palco, 12000);
  certo(avisoRede !== null,
    'sem rede: o pedido que falha diz alguma coisa no ecrã', String(avisoRede));
  certo(avisoRede !== null && !/^Failed to fetch$|^Load failed$|^NetworkError/i.test(avisoRede),
    'sem rede: e diz-lho em português, não a mensagem crua do browser',
    `o que apareceu foi «${avisoRede}»`);
  certo((await desativado(palco, BOTAO_PAINEL)) === false,
    'sem rede: dá para tentar outra vez sem fechar o painel',
    String(await desativado(palco, BOTAO_PAINEL)));
  await limparAvisos(palco);

  await palco.tecla('Escape');
  certo(!(await palco.ver('#painel')), 'a tecla Escape fecha o painel de entrada');

  /* --- porta 2: tenho um convite ---------------------------------------- */

  await palco.clicar(CONVITE);
  certo(await palco.visivel('#painel'), 'convite: o painel de fundar abre');
  certo((await palco.texto('.painel-folha h2')) === 'Criar o meu cartão',
    'convite: o painel chama-se «Criar o meu cartão»', String(await palco.texto('.painel-folha h2')));

  const campos = ['#f-convite', '#f-negocio', '#f-localidade', '#f-email', '#f-premio', '#f-objetivo'];
  const emFalta = [];
  for (const c of campos) if (!(await palco.ver(c))) emFalta.push(c);
  certo(emFalta.length === 0, 'convite: o formulário tem os seis campos', emFalta.join(', '));

  const focoConvite = await palco.focado();
  certo(focoConvite && focoConvite.etiqueta === 'input',
    'convite: o foco cai sozinho no primeiro campo', JSON.stringify(focoConvite));

  await palco.captura('07-fundar-formulario');

  /* Tudo vazio. */
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoVazio = await avisoNovo(palco);
  certo(avisoVazio !== null && /nome/i.test(avisoVazio),
    'formulário vazio: recusa e diz que falta o nome', String(avisoVazio));
  await limparAvisos(palco);

  /* Um caracter não é um nome — o Worker exige dois, o cliente também deve. */
  await palco.escrever('#f-negocio', 'A');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoCurto = await avisoNovo(palco);
  certo(avisoCurto !== null && /nome/i.test(avisoCurto),
    'nome com um caracter: recusa antes de gastar o convite', String(avisoCurto));
  await limparAvisos(palco);

  /* Nome bom, email mau. */
  await palco.escrever('#f-negocio', 'Café da Bateria');
  await palco.escrever('#f-email', 'dono-arroba-cafe');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoEmailFundar = await avisoNovo(palco);
  certo(avisoEmailFundar === 'Esse email não parece válido.',
    'email mal escrito no fundar: recusa e explica', String(avisoEmailFundar));
  await limparAvisos(palco);

  /* Não há campo de cor nenhum neste formulário — o negócio nasce com a cor
     por omissão e escolhe-se depois em «O cartão». Portanto não há aqui cor
     inválida para escrever; regista-se para a afirmação não se perder. */
  const camposCor = await palco.js(
    "return document.querySelectorAll('.painel-folha input[type=color], .painel-folha .paleta').length");
  certo(camposCor === 0,
    'fundar não pede cor — não há cor inválida possível nesta porta', String(camposCor));

  /* --- o objectivo de carimbos, que é onde isto dói -------------------- */

  /* Uma escuta por cima do fetch. Não muda nada: regista o que sai e deixa o
     pedido seguir (e falhar, que a rede está cortada). É a única forma de ver
     o que o formulário deixou passar para o Worker. */
  await palco.js(`if (!window.__espiaBateria) {
      window.__espiaBateria = [];
      const original = window.fetch;
      window.fetch = function (...a) {
        try { window.__espiaBateria.push({ url: String(a[0]), corpo: (a[1] && a[1].body) || null }); }
        catch { /* nada */ }
        return original.apply(this, a);
      };
    }
    return true`);

  await palco.escrever('#f-email', 'dono@cafedabateria.pt');

  const limites = await palco.js(`const n = document.querySelector('#f-objetivo');
    return { min: n.min, max: n.max, tipo: n.type };`);
  certo(limites.min === '2' && limites.max === '30' && limites.tipo === 'number',
    'o campo do objectivo declara os limites 2..30', JSON.stringify(limites));

  await palco.preencher('#f-objetivo', '99');
  const excede = await palco.js(
    "const n = document.querySelector('#f-objetivo'); return n.validity.rangeOverflow");
  certo(excede === true, 'o browser já sabe que 99 está fora dos limites', String(excede));

  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoAlto = await avisoNovo(palco, 12000);
  certo(avisoAlto !== null && /carimbo|30|limite|entre/i.test(avisoAlto),
    'objectivo 99: o formulário recusa e diz porquê, em vez de deixar passar',
    `o que apareceu foi «${avisoAlto}»`);

  const saiu99 = await palco.js(`const p = (window.__espiaBateria || [])
      .filter((x) => x.url.includes('/v1/balcao/fundar')).pop();
    if (!p || !p.corpo) return null;
    try { return JSON.parse(p.corpo).objetivo; } catch { return 'corpo ilegível'; }`);
  certo(saiu99 === null || (typeof saiu99 === 'number' && saiu99 >= 2 && saiu99 <= 30),
    'objectivo 99: o cliente não deixa sair para o Worker um valor fora de 2..30',
    `o pedido levou objetivo=${JSON.stringify(saiu99)}`);
  await limparAvisos(palco);

  /* E do lado de baixo: um carimbo até ao prémio também não existe. */
  await palco.preencher('#f-objetivo', '1');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoBaixo = await avisoNovo(palco, 12000);
  certo(avisoBaixo !== null && /carimbo|2|limite|entre/i.test(avisoBaixo),
    'objectivo 1: o formulário recusa e diz porquê',
    `o que apareceu foi «${avisoBaixo}»`);

  const saiu1 = await palco.js(`const p = (window.__espiaBateria || [])
      .filter((x) => x.url.includes('/v1/balcao/fundar')).pop();
    if (!p || !p.corpo) return null;
    try { return JSON.parse(p.corpo).objetivo; } catch { return 'corpo ilegível'; }`);
  certo(saiu1 === null || (typeof saiu1 === 'number' && saiu1 >= 2 && saiu1 <= 30),
    'objectivo 1: o cliente não deixa sair para o Worker um valor abaixo de 2',
    `o pedido levou objetivo=${JSON.stringify(saiu1)}`);
  await limparAvisos(palco);

  /* --- porta 3: só quero ver como funciona ------------------------------ */

  /* Entrada limpa: o painel aberto tapava as portas, e a demonstração não
     precisa de rede nenhuma para nada. */
  await palco.semRede(false);
  await palco.ir('/balcao/');
  await palco.esperar(ESPREITAR);

  await palco.clicar(ESPREITAR);
  await palco.pronta();
  await palco.esperar('#entrada-acoes button');

  const emDemo = await palco.js("return localStorage.getItem('carimbo:modo-demo')");
  certo(emDemo === '1', 'espreitar: fica em modo de demonstração', String(emDemo));

  const endereco = await palco.js('return location.search');
  certo(endereco === '',
    'espreitar: o «?demo=1» é limpo do endereço para não colar ao histórico', String(endereco));

  const portasDemo = await palco.textos('#entrada-acoes button');
  certo(portasDemo[0] === 'Experimentar agora',
    'espreitar: a entrada passa a oferecer a demonstração', portasDemo.join(' | '));
  certo(portasDemo.includes('Sair da demonstração'),
    'espreitar: e a porta de saída da demonstração', portasDemo.join(' | '));

  const textoDemo = await palco.textoTodo();
  certo(textoDemo.includes('não há servidor nenhum a receber nada'),
    'espreitar: diz que os dados não saem do telemóvel', textoDemo.slice(0, 160));

  /* --- chegar ao balcão a funcionar ------------------------------------- */

  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);

  certo(!(await palco.visivel('#entrada')), 'entrou: a entrada sai da frente');
  certo(await palco.visivel('#aplicacao'), 'entrou: a aplicação aparece');
  certo((await palco.texto('#topo-titulo')) === 'Carimbar',
    'entrou: abre no ecrã de carimbar', String(await palco.texto('#topo-titulo')));

  const separadores = await palco.textos('.barra-item');
  certo(separadores.join('|') === 'Carimbar|Hoje|Clientes|O cartão',
    'entrou: a barra do balcão tem os quatro separadores', separadores.join('|'));

  certo((await palco.js("return localStorage.getItem('carimbo-demo:balcao-entrou')")) === 'true',
    'entrou: fica registado, para a próxima abrir logo dentro');

  /* Não há câmara num Chrome sem interface — é o mesmo caminho de quem recusa
     a permissão no telemóvel. Interessa que o visor não fique preso no «A
     ligar a câmara…» e que sobre a entrada manual. O `getUserMedia` demora a
     desistir, por isso espera-se por ele em vez de se ler à primeira. */
  let visor = null;
  const comecou = Date.now();
  while (Date.now() - comecou < 15000) {
    visor = await palco.texto('#visor-estado');
    if (visor && !/A ligar a câmara/.test(visor)) break;
    await dormir(palco, 200);
  }
  const demorou = Math.round((Date.now() - comecou) / 100) / 10;
  certo(visor !== null && !/A ligar a câmara/.test(visor),
    'sem câmara: o visor deixa de dizer que está a ligar e explica o que fazer',
    `passados ${demorou} s ainda dizia «${visor}»`);
  certo(demorou < 6,
    'sem câmara: e desiste depressa — ao balcão há fila',
    `levou ${demorou} s a dizer «${visor}»`);
  certo(await palco.visivel('#botao-manual'),
    'sem câmara: sobra o botão de escrever o número do cartão');

  await palco.captura('07-balcao-a-funcionar');

  /* --- a pré-visualização do cartão ------------------------------------- */

  await palco.clicar('#botao-negocio');
  await palco.esperar('#previa');
  certo((await palco.texto('#topo-titulo')) === 'O cartão',
    'a engrenagem leva ao editor do cartão', String(await palco.texto('#topo-titulo')));

  const nomeAntes = await palco.texto('#previa .cartao-nome');
  await palco.escrever('#f-nome', 'Café da Bateria');
  const nomeDepois = await palco.texto('#previa .cartao-nome');
  certo(nomeDepois === 'Café da Bateria',
    'a pré-visualização segue o nome enquanto se escreve',
    `antes «${nomeAntes}», depois «${nomeDepois}»`);

  await palco.escrever('#f-premio', 'Uma bica por conta da casa');
  certo((await palco.texto('#previa .cartao-premio')) === 'Uma bica por conta da casa',
    'a pré-visualização segue o prémio enquanto se escreve',
    String(await palco.texto('#previa .cartao-premio')));

  const carimbosAntes = await palco.contar('#previa .carimbo');
  await palco.preencher('#f-objetivo', '4');
  const carimbosDepois = await palco.contar('#previa .carimbo');
  certo(carimbosDepois === 4,
    'a pré-visualização passa a desenhar 4 carimbos',
    `antes ${carimbosAntes}, depois ${carimbosDepois}`);

  /* Aqui o objectivo é travado — o desenharPrevia limita a 2..30. É o mesmo
     limite que o formulário de fundar não aplica. */
  await palco.preencher('#f-objetivo', '99');
  const carimbos99 = await palco.contar('#previa .carimbo');
  certo(carimbos99 === 30,
    'no editor do cartão o objectivo é travado nos 30', `desenhou ${carimbos99}`);

  await palco.captura('07-previa-do-cartao');

  /* --- a cor -------------------------------------------------------------- */

  const quantasCores = await palco.contar('.paleta-cor');
  certo(quantasCores === 12, 'a paleta oferece doze cores fechadas', String(quantasCores));

  const corAntes = await corDoCartao(palco, '#previa');
  await palco.clicar('.paleta-cor:nth-child(4)');
  const corDepois = await corDoCartao(palco, '#previa');
  certo(corDepois && /^#[0-9a-f]{6}$/i.test(corDepois.fundo) && corDepois.fundo !== corAntes.fundo,
    'escolher uma cor repinta o cartão',
    `antes ${JSON.stringify(corAntes)}, depois ${JSON.stringify(corDepois)}`);

  /* Cor inválida: não se escreve à mão em lado nenhum, mas pode vir assim dos
     dados. O cartão tem de continuar pintado e legível. */
  await palco.js(`const chave = 'carimbo-demo:demo';
    const e = JSON.parse(localStorage.getItem(chave));
    const n = e.negocios.find((x) => x.id === 'n-torrado') || e.negocios[0];
    n.cor = 'azul-bebé';
    localStorage.setItem(chave, JSON.stringify(e));
    return true`);
  await palco.recarregar();
  await palco.esperar('#barra .barra-item', 10000);
  await palco.clicar('#botao-negocio');
  await palco.esperar('#previa');

  const corMa = await corDoCartao(palco, '#previa');
  certo(corMa && /^#[0-9a-f]{6}$/i.test(corMa.fundo),
    'cor inválida nos dados: o cartão cai numa cor válida em vez de ficar por pintar',
    JSON.stringify(corMa));
  certo(corMa && /^#[0-9a-f]{6}$/i.test(corMa.tinta),
    'cor inválida nos dados: e a tinta continua a ser escolhida', JSON.stringify(corMa));
}
