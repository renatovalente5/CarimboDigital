/* =========================================================================
   Bateria · 14 — Sem rede e com a API avariada

   Os outros módulos provam o que a app faz quando tudo corre bem. Este prova
   o contrário: o que ela mostra quando a ligação cai, quando o servidor
   responde mal, ou quando não responde de todo.

   Quatro coisas que se perseguem aqui, e porquê:

   · O ECRÃ EM BRANCO. É o pior erro possível numa app: ninguém sabe se é a
     rede, o telemóvel ou o programa. Uma promessa que morre dentro de um
     clique não deixa rasto nenhum — o `principal` fica vazio, a pessoa
     recarrega, e volta ao mesmo. Por isso cada ecrã que não consegue pintar
     tem de dizer que não conseguiu, e dar um caminho para a frente.

   · O BOTÃO MORTO. Quem desactiva um botão antes de esperar tem de o
     reactivar quando a coisa corre mal. Sem rede, TODAS as respostas correm
     mal — é o caminho mais fácil de encontrar um botão que fica preso.

   · A MENSAGEM CRUA. O `fetch` falha em inglês: «Failed to fetch», «signal
     timed out», «NetworkError». Dizer isso a quem está do outro lado do
     balcão é o mesmo que não dizer nada. Isto acabou de ser corrigido em
     `_fonte/js/api.js`; aqui confirma-se que a correcção chega ao ecrã, e
     não só ao `throw`.

   · A DEMONSTRAÇÃO NÃO PRECISA DE REDE. `?demo=1` é uma implementação
     completa das regras dentro do localStorage. Se alguma coisa lá falhar
     sem rede, é defeito — e o defeito é caro, porque a demonstração é o que
     se mostra ao dono do café, muitas vezes com o Wi-Fi dele.

   NOTA SOBRE O SERVIDOR A SÉRIO
   O `_fonte/config.json` aponta para um Worker que está mesmo no ar. Um
   teste não pode tocar num serviço de produção, por isso a primeira coisa
   que este módulo faz é bloquear esse endereço ao nível da rede. A partir
   daí, o modo remoto só pode falhar — que é exactamente o que se quer
   medir.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '14 · Sem rede e com a API avariada';

/* A app regista de propósito os erros que trata («console.error(e)» antes de
   pintar o ecrã de sem-ligação). São handlers a fazer o seu trabalho, não
   promessas a morrer — e sem esta lista o módulo reprovava por os provocar.
   As âncoras no princípio são de propósito: um erro apanhado chega como
   «Error: …», e uma promessa que morre sozinha como «Uncaught (in promise)…».
   Só o primeiro é que se desculpa — o segundo é o que viemos procurar. */
export const desculpar = [
  /favicon/,
  /^Error: Sem ligação ao servidor\. Verifica a Internet\./,
  /^Error: O servidor está a demorar\./,
];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* O que NUNCA pode aparecer no ecrã de uma pessoa. */
const CRU = [
  /failed to fetch/i,
  /networkerror/i,
  /signal timed out/i,
  /aborterror/i,
  /typeerror/i,
  /err_/i,
  /net::/i,
  /\[object Object\]/,
  /undefined/,
];

/** Qual destas mensagens cruas está no texto? `null` = nenhuma, que é o bom. */
function mensagemCrua(texto) {
  const t = String(texto || '');
  const achada = CRU.find((r) => r.test(t));
  return achada ? String(achada) : null;
}

/* =========================================================================
   Ajudas
   ========================================================================= */

/** Navega com a rede ligada — a página tem de chegar antes de a cortarmos. */
async function irComRede(palco, caminho, opcoes) {
  await palco.semRede(false);
  await palco.ir(caminho, opcoes);
}

/**
 * Conta os pedidos que a página tenta fazer.
 *
 * Cortar a rede prova que a app aguenta sem ela; contar prova uma coisa
 * mais forte, e é a promessa da demonstração: não chega sequer a pedir.
 */
async function espiarPedidos(palco) {
  await palco.js(`
    window.__pedidos = [];
    if (!window.__fetchOriginal) {
      window.__fetchOriginal = window.fetch.bind(window);
      window.fetch = (...a) => {
        window.__pedidos.push(String(a[0] && a[0].url ? a[0].url : a[0]));
        return window.__fetchOriginal(...a);
      };
    }
    return true`);
}

const pedidosVistos = (palco) => palco.js('return window.__pedidos || []');

/** O estado da demonstração, tal como está guardado. */
const dadosDemo = (palco) => palco.js(
  `const c = localStorage.getItem('carimbo-demo:demo'); return c ? JSON.parse(c) : null`);

/** O número público do cliente da demonstração. */
const publicoDemo = (palco) => palco.js(
  `const c = localStorage.getItem('carimbo-demo:cliente');
   return c ? JSON.parse(c).publico : null`);

/** Os cartões desenhados na carteira, em bruto. */
const lerCarteira = (palco) => palco.js(`
  return [...document.querySelectorAll('#principal .pilha > .cartao')].map((n) => {
    const g = n.querySelector('.carimbos');
    return {
      nome: n.querySelector('.cartao-nome')?.textContent.trim() ?? null,
      rotulo: n.querySelector('.cartao-rotulo')?.textContent.trim() ?? null,
      casas: g ? g.querySelectorAll('.carimbo').length : null,
      cheias: g ? g.querySelectorAll('.carimbo[data-estado="cheio"]').length : null,
    };
  })`);

const BARRA = (n) => `.barra-item:nth-child(${n})`;
const CARTEIRA = BARRA(1), DESCOBRIR = BARRA(2), PREMIOS = BARRA(4);
const BAL_HOJE = BARRA(2), BAL_CLIENTES = BARRA(3), BAL_CARTAO = BARRA(4);

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* Nunca, em circunstância nenhuma, um teste toca no Worker de produção.
     Fica bloqueado à cabeça: se alguma coisa neste módulo escapar às
     salvaguardas seguintes, morre aqui em vez de ir bater à porta de um
     serviço a sério. */
  await palco.enviar('Network.enable', {}, palco.sessao).catch(() => {});
  await palco.enviar('Network.setBlockedURLs', {
    urls: ['*carimbodigital-api*', '*workers.dev*'],
  }, palco.sessao);

  /* =======================================================================
     ACTO 1 — A demonstração, sem rede nenhuma (app do cliente)

     Tudo o que a demonstração faz vive no localStorage. Cortada a rede, a
     app tem de continuar inteira: ver os cartões, abrir um, aderir a outro,
     ver os prémios e gerar o código.
     ======================================================================= */

  await irComRede(palco, '/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#principal .pilha .cartao', 10000);

  await espiarPedidos(palco);
  await palco.semRede(true);

  const publico = await publicoDemo(palco);
  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(publico || ''),
    'demonstração: a conta nasceu sem servidor nenhum', String(publico));

  /* --- a carteira ------------------------------------------------------- */
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha .cartao', 8000);
  const carteira = await lerCarteira(palco);
  certo(carteira.length === 5,
    'sem rede, demonstração: a carteira desenha os cinco cartões semeados',
    `desenhou ${carteira.length}`);
  certo(!(await palco.ver('#principal .vazio')),
    'sem rede, demonstração: a carteira não cai no ecrã de «não deu para carregar»',
    String(await palco.texto('#principal .vazio')));
  const semLigacao = await palco.textoTodo();
  certo(!/Sem ligação/i.test(semLigacao),
    'sem rede, demonstração: nem sequer avisa que está sem ligação — não precisa dela',
    semLigacao.slice(0, 120));

  /* --- abrir um cartão e trocar para outro ------------------------------ */
  const iTorrado = carteira.findIndex((c) => c.nome === 'Café Torrado');
  await palco.clicar(`#principal .pilha > .cartao:nth-of-type(${iTorrado + 1})`);
  await palco.esperar('#principal .cartao-grande', 8000);
  certo(await palco.texto('#principal .cartao-grande .cartao-nome') === 'Café Torrado',
    'sem rede, demonstração: abre o cartão que se escolheu',
    String(await palco.texto('#principal .cartao-grande .cartao-nome')));
  certo(await palco.contar('#principal .seccao .linha') > 0,
    'sem rede, demonstração: e o histórico do cartão vem com ele',
    `${await palco.contar('#principal .seccao .linha')} linhas`);

  await palco.clicar('#principal .voltar');
  await palco.esperar('#principal .pilha .cartao', 8000);
  const iOutro = carteira.findIndex((c) => c.nome === 'Salão Camélia');
  await palco.clicar(`#principal .pilha > .cartao:nth-of-type(${iOutro + 1})`);
  await palco.esperar('#principal .cartao-grande', 8000);
  certo(await palco.texto('#principal .cartao-grande .cartao-nome') === 'Salão Camélia',
    'sem rede, demonstração: mudar de cartão continua a funcionar',
    String(await palco.texto('#principal .cartao-grande .cartao-nome')));

  /* --- aderir ----------------------------------------------------------- */
  await palco.clicar(DESCOBRIR);
  await palco.esperar('#principal .cartao-descobrir', 8000);
  const alvo = await palco.js(`
    const todos = [...document.querySelectorAll('#principal .cartao-descobrir')];
    const i = todos.findIndex((c) => /Juntar/.test(c.querySelector('.cartao-selo')?.textContent || ''));
    return i < 0 ? null : { i: i + 1, nome: todos[i].querySelector('.cartao-nome').textContent.trim() }`);
  certo(!!alvo,
    'sem rede, demonstração: o Descobrir tem um cartão por juntar',
    JSON.stringify(alvo));
  const porJuntar = alvo && alvo.nome;

  await palco.clicar(`#principal .cartao-descobrir:nth-of-type(${alvo?.i ?? 1}) .cartao-selo`);
  await palco.esperar('#principal .pilha > .cartao', 8000);
  await dormir(200);
  const depoisDeAderir = await lerCarteira(palco);
  certo(depoisDeAderir.length === carteira.length + 1,
    `sem rede, demonstração: aderir junta o cartão de ${porJuntar} à carteira`,
    `${carteira.length} → ${depoisDeAderir.length}`);
  certo(depoisDeAderir.some((c) => c.nome === porJuntar),
    'sem rede, demonstração: e é mesmo o cartão em que se carregou',
    depoisDeAderir.map((c) => c.nome).join(' | '));

  /* --- prémios ---------------------------------------------------------- */
  await palco.clicar(PREMIOS);
  await palco.esperar('#principal h1.titulo-grande', 8000);
  certo(await palco.texto('#principal h1.titulo-grande') === 'Prémios',
    'sem rede, demonstração: o ecrã dos prémios pinta',
    String(await palco.texto('#principal h1.titulo-grande')));
  certo(await palco.contar('#principal .linha-premio') === 1,
    'sem rede, demonstração: o prémio da Gelataria continua à espera',
    `${await palco.contar('#principal .linha-premio')} prémios`);
  certo(!(await palco.textoTodo()).includes('Não deu para carregar'),
    'sem rede, demonstração: os prémios não caem no ecrã de erro');

  /* --- o código, que é o que se mostra ao balcão ------------------------ */
  await palco.clicar(BARRA(3));
  await palco.esperar('#folha-codigo', 8000);
  certo(await palco.contar('#codigo-qr svg') === 1,
    'sem rede, demonstração: o QR desenha-se sem servidor — é assinado no telemóvel',
    `${await palco.contar('#codigo-qr svg')} desenhos`);
  certo(await palco.texto('#folha-codigo .codigo-id') === publico,
    'sem rede, demonstração: e mostra o número do cartão por baixo',
    String(await palco.texto('#folha-codigo .codigo-id')));
  await palco.captura('14-demo-sem-rede-codigo');
  await palco.clicar('#folha-codigo .codigo-fechar');
  await palco.sumir('#folha-codigo', 4000);

  /* A prova mais forte de todas: não houve pedido nenhum a fazer. */
  const pedidos = await pedidosVistos(palco);
  certo(pedidos.length === 0,
    'demonstração: a app não chega a pedir nada à rede',
    `${pedidos.length} pedidos: ${pedidos.slice(0, 3).join(', ')}`);

  /* =======================================================================
     ACTO 2 — A demonstração, sem rede, do lado do balcão

     Carimbar é a única acção que não se pode fazer na app do cliente. Aqui
     prova-se que a demonstração inteira — carimbar, ver os números, mudar o
     cartão — corre com o avião ligado.
     ======================================================================= */

  await irComRede(palco, '/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn', 8000);
  await espiarPedidos(palco);
  await palco.semRede(true);

  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);
  certo(await palco.texto('#topo-titulo') === 'Carimbar',
    'sem rede, balcão: a demonstração entra sem pedir nada a ninguém',
    String(await palco.texto('#topo-titulo')));

  /* Sem câmara (e num Chrome sem interface nunca há), o balcão tem de
     oferecer a entrada pelo número — senão fica sem forma de carimbar. */
  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero', 6000);
  await palco.escrever('#campo-numero', publico);
  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('#resultado', 8000);
  await palco.captura('14-balcao-sem-rede-carimbou');

  const resultado = await palco.texto('#resultado .resultado-titulo');
  certo(resultado === 'Carimbado',
    'sem rede, balcão: carimbar funciona — é tudo localStorage',
    String(resultado));
  certo((await palco.texto('#resultado .resultado-sub')) === '8 de 10 · faltam 2',
    'sem rede, balcão: e a conta do cartão avança (7 → 8)',
    String(await palco.texto('#resultado .resultado-sub')));
  await palco.clicar('#resultado .resultado-acoes .btn-cheio');
  await palco.sumir('#resultado', 4000);

  /* --- os números ------------------------------------------------------- */
  await palco.clicar(BAL_HOJE);
  await palco.esperar('#principal .numeros', 8000);
  const hoje = await palco.textos('#principal .numeros .numero b');
  certo(Number(hoje[0]) >= 1,
    'sem rede, balcão: o «Hoje» conta o carimbo que se acabou de dar',
    `carimbos hoje = ${hoje[0]}`);

  await palco.clicar(BAL_CLIENTES);
  await palco.esperar('#principal .lista .linha', 8000);
  certo((await palco.textoTodo()).includes(publico),
    'sem rede, balcão: o cliente aparece na lista pelo número do cartão',
    String(publico));

  /* --- mudar o cartão --------------------------------------------------- */
  await palco.clicar(BAL_CARTAO);
  await palco.esperar('#f-premio', 8000);
  const NOVO_PREMIO = 'Um galão e um pastel';
  await palco.preencher('#f-premio', NOVO_PREMIO);
  await palco.clicar('#principal .seccao .btn-cheio');
  await palco.esperar('#f-premio', 8000);
  await dormir(200);

  certo(await palco.valor('#f-premio') === NOVO_PREMIO,
    'sem rede, balcão: mudar o prémio do cartão grava e volta a aparecer',
    String(await palco.valor('#f-premio')));
  const guardado = await dadosDemo(palco);
  const pTorrado = guardado.negocios.find((n) => n.id === 'n-torrado').programas[0];
  certo(pTorrado.premio === NOVO_PREMIO,
    'sem rede, balcão: e ficou mesmo guardado, não só no ecrã',
    String(pTorrado.premio));

  const pedidosBalcao = await pedidosVistos(palco);
  certo(pedidosBalcao.length === 0,
    'demonstração: também o balcão não pede nada à rede',
    `${pedidosBalcao.length} pedidos: ${pedidosBalcao.slice(0, 3).join(', ')}`);

  /* --- e o cliente vê o carimbo ----------------------------------------- */
  await irComRede(palco, '/app/?demo=1');
  await palco.esperar('#principal .pilha .cartao', 10000);
  await palco.semRede(true);
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha .cartao', 8000);
  const torrado = (await lerCarteira(palco)).find((c) => c.nome === 'Café Torrado');
  certo(torrado && torrado.cheias === 8 && torrado.casas === 10,
    'sem rede, demonstração: o carimbo dado ao balcão chega à carteira do cliente',
    torrado ? `${torrado.cheias} de ${torrado.casas}` : 'o cartão desapareceu');
  certo(torrado && torrado.rotulo === 'faltam 2 carimbos',
    'sem rede, demonstração: e a contagem acompanha',
    torrado ? String(torrado.rotulo) : '');

  /* =======================================================================
     ACTO 3 — A app do cliente em modo remoto, sem rede

     Aqui a rede é obrigatória: sem ela não há conta nenhuma para mostrar. O
     que se exige é que a app DIGA isso, com um botão para tentar de novo, em
     vez de ficar em branco.
     ======================================================================= */

  /* Este acto diz, por palavras suas, «nesta abertura não há conta nenhuma».
     Precisa de duas coisas ao mesmo tempo: armazenamento limpo E servidor
     inalcançável. Cortar a rede não serve, porque também corta a página — e
     o servidor de mentira deste módulo só é montado mais abaixo.

     A saída é apontar a app para uma porta morta antes de os módulos dela
     carregarem. A porta 9 é a de descarte: aceita e não responde nada. */
  await irComRede(palco, '/app/?demo=0');
  await palco.limparArmazenamento();
  const guiaoMorto = await palco.enviar('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.addEventListener('DOMContentLoaded', function () {});
      Object.defineProperty(window, 'CARIMBO_CONFIG', {
        configurable: true,
        get: function () { return window.__CFG; },
        set: function (v) { window.__CFG = Object.assign({}, v, { api: 'http://127.0.0.1:9' }); },
      });`,
  }, palco.sessao);
  await palco.recarregar();
  certo(await palco.js('return !!(window.CARIMBO_CONFIG && window.CARIMBO_CONFIG.api)'),
    'remoto: a app está configurada com um servidor (senão isto não testa nada)');
  certo(await palco.visivel('#boas-vindas'),
    'remoto: as boas-vindas aparecem sem precisar de rede — são texto local');

  await passarBoasVindas(palco);
  await palco.esperarTexto('Sem ligação ao servidor', 20000);
  await palco.captura('14-app-remota-sem-rede');

  certo(!(await palco.visivel('#boas-vindas')),
    'remoto sem rede: as boas-vindas fecham-se — não ficam penduradas no último passo');
  certo(await palco.visivel('#aplicacao'),
    'remoto sem rede: a app aparece, mesmo que só para explicar o que falhou');
  certo(await palco.texto('#principal .vazio h3') === 'Sem ligação ao servidor',
    'remoto sem rede: o ecrã diz que é a ligação que falta',
    String(await palco.texto('#principal .vazio h3')));
  certo((await palco.texto('#principal .vazio p')).includes('Os teus cartões estão a salvo'),
    'remoto sem rede: e tranquiliza quem tem cartões',
    String(await palco.texto('#principal .vazio p')));
  certo(await palco.texto('#principal .vazio .btn') === 'Tentar outra vez',
    'remoto sem rede: há um botão para voltar a tentar',
    String(await palco.texto('#principal .vazio .btn')));
  certo(await palco.visivel('#principal .vazio .btn'),
    'remoto sem rede: e o botão está mesmo à vista');

  const miudo = await palco.texto('#principal .vazio .miudo');
  certo(miudo === 'Sem ligação ao servidor. Verifica a Internet.',
    'remoto sem rede: o detalhe é a mensagem em português, não a do fetch',
    String(miudo));
  certo(mensagemCrua(await palco.textoTodo()) === null,
    'remoto sem rede: não há uma palavra de inglês do fetch no ecrã',
    String(mensagemCrua(await palco.textoTodo())));

  /* Nesta abertura não há conta nenhuma — não há cartão, não há número, não
     há nada por trás de separador nenhum. Uma barra com cinco separadores
     seria uma promessa falsa: carregar em qualquer um deles não fazia nada. */
  certo(await palco.contar('#barra .barra-item') === 0,
    'remoto sem rede, primeira abertura: a barra não fica com separadores vazios',
    `${await palco.contar('#barra .barra-item')} separadores`);

  await palco.enviar('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: guiaoMorto.identifier }, palco.sessao).catch(() => {});

  /* =======================================================================
     ACTO 4 — O balcão em modo remoto, sem rede

     O balcão abre sem rede porque o ecrã de entrada é estático. O momento da
     verdade é o clique: carrega-se em «Enviar o código» com o Wi-Fi em
     baixo, e o botão não pode ficar morto e mudo.
     ======================================================================= */

  await irComRede(palco, '/balcao/?demo=0');
  await palco.esperar('#entrada-acoes .btn', 8000);
  certo(await palco.visivel('#entrada'),
    'remoto, balcão: o ecrã de entrada é estático e abre sem servidor');

  const portas = await palco.textos('#entrada-acoes .btn');
  certo(portas.includes('Entrar') && portas.includes('Tenho um convite'),
    'remoto, balcão: as duas portas de entrada estão lá', portas.join(' | '));

  await palco.semRede(true);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#e-email', 6000);
  await palco.preencher('#e-email', 'balcao@exemplo.pt');

  /* O observador guarda a ida e a volta do `disabled` mesmo quando as duas
     acontecem depressa: sem ele, ler o atributo depois do clique não
     distingue «nunca desactivou» de «desactivou e voltou». */
  await palco.js(`
    const n = document.querySelector('#painel .btn-cheio');
    window.__idas = [];
    if (window.__espia) window.__espia.disconnect();
    window.__espia = new MutationObserver((rs) => {
      for (const r of rs) window.__idas.push(r.oldValue === null);
    });
    window.__espia.observe(n, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    return true`);

  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('.aviso', 8000);
  await palco.captura('14-balcao-remoto-sem-rede');

  const avisoBalcao = await palco.texto('.aviso');
  certo(avisoBalcao === 'Sem ligação ao servidor. Verifica a Internet.',
    'remoto, balcão sem rede: o aviso explica-se em português',
    String(avisoBalcao));
  certo(mensagemCrua(avisoBalcao) === null,
    'remoto, balcão sem rede: sem uma palavra crua do fetch',
    String(mensagemCrua(avisoBalcao)));
  certo(await palco.js("return document.querySelector('#painel .btn-cheio').disabled") === false,
    'remoto, balcão sem rede: o botão volta a responder — dá para tentar outra vez',
    'ficou desactivado para sempre');
  certo(JSON.stringify(await palco.js('return window.__idas')) === '[true,false]',
    'remoto, balcão sem rede: o botão desactiva-se durante o pedido e volta ao fim',
    JSON.stringify(await palco.js('return window.__idas')));
  certo(await palco.ver('#e-email'),
    'remoto, balcão sem rede: o painel fica aberto, com o email escrito');
  certo(await palco.valor('#e-email') === 'balcao@exemplo.pt',
    'remoto, balcão sem rede: e não obriga a escrever o email outra vez',
    String(await palco.valor('#e-email')));

  await palco.semRede(false);

  /* =======================================================================
     ACTO 5 — A API avariada (app do cliente)

     Cortar a rede é só uma das maneiras de o servidor falhar, e a mais
     simpática: falha logo. As outras são piores — responder 500, responder
     lixo, ou aceitar a chamada e nunca dizer nada. Para as provocar é
     preciso um servidor, e o servidor a sério está fora de questão: fica
     um de mentira dentro da própria página.
     ======================================================================= */

  const guiao = await montarServidorFingido(palco);

  await palco.ir('/app/?demo=0');
  await palco.esperar('#principal .pilha .cartao', 10000);

  certo(await palco.js("return document.documentElement.dataset.tema !== undefined || true")
    && await palco.contar('#principal .pilha > .cartao') === 2,
    'API de mentira: a app arranca em modo remoto e desenha os cartões que o servidor deu',
    `${await palco.contar('#principal .pilha > .cartao')} cartões`);

  /* O testemunho da sessão tem de seguir nos pedidos que vêm a seguir ao
     registo — se não seguir, em produção respondem todos 401. */
  const primeiros = await palco.js('return window.__fingir.pedidos');
  certo(primeiros[0] && primeiros[0].caminho.endsWith('/v1/cliente/registar'),
    'API de mentira: o primeiro pedido é o registo do cliente',
    JSON.stringify(primeiros[0] || null));
  certo(primeiros.slice(1).every((p) => p.autorizacao === 'Bearer sessao-de-mentira'),
    'API de mentira: os pedidos seguintes levam o testemunho da sessão',
    JSON.stringify(primeiros.slice(1).map((p) => p.autorizacao)));

  /* --- a rede cai a meio da sessão -------------------------------------- */

  await fingir(palco, 'cair');
  await palco.clicar(DESCOBRIR);
  await palco.esperarTexto('Não deu para carregar', 8000);
  await palco.captura('14-api-caiu-descobrir');

  certo(await palco.texto('#principal .vazio h2') === 'Não deu para carregar',
    'rede a cair a meio: o ecrã que não pintou diz que não pintou',
    String(await palco.texto('#principal .vazio h2')));
  certo(!!(await palco.texto('#principal .vazio .subtexto')),
    'rede a cair a meio: e explica o que fazer',
    String(await palco.texto('#principal .vazio .subtexto')));
  certo(await palco.texto('#principal .vazio .miudo')
    === 'Sem ligação ao servidor. Verifica a Internet.',
    'rede a cair a meio: o detalhe está em português',
    String(await palco.texto('#principal .vazio .miudo')));
  certo(mensagemCrua(await palco.textoTodo()) === null,
    'rede a cair a meio: nada de inglês do fetch no ecrã',
    String(mensagemCrua(await palco.textoTodo())));

  /* O texto do botão não vale nada: o que interessa é que ele FAÇA alguma
     coisa quando a rede volta. É a diferença entre uma saída e um adorno. */
  certo(await palco.visivel('#principal .vazio .btn'),
    'rede a cair a meio: há um botão de tentar outra vez');
  await fingir(palco, 'ok');
  await palco.clicar('#principal .vazio .btn');
  await palco.esperar('#principal .cartao-descobrir', 8000);
  certo(await palco.texto('#principal h1.titulo-grande') === 'Descobrir',
    'rede a cair a meio: «Tentar outra vez» pinta mesmo o ecrã quando a rede volta',
    String(await palco.texto('#principal h1.titulo-grande')));

  /* --- a carteira degrada-se em vez de desaparecer ---------------------- */

  await fingir(palco, 'cair');
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha > .cartao', 8000);
  await palco.captura('14-api-caiu-carteira');

  certo(await palco.contar('#principal .pilha > .cartao') === 2,
    'carteira sem servidor: os cartões que já estavam na memória ficam à vista',
    `${await palco.contar('#principal .pilha > .cartao')} cartões`);
  certo((await palco.textoTodo()).includes('Sem ligação — isto pode não estar actualizado.'),
    'carteira sem servidor: e a app avisa que a conta pode estar velha',
    (await palco.textoTodo()).slice(0, 140));

  /* O aviso é acrescentado ao `principal` ANTES do título, porque quem o
     escreve corre antes de quem desenha o cabeçalho. Uma frase solta por
     cima do «Os meus cartões» lê-se como se fosse o título da página. */
  const ordem = await palco.js(`
    const p = document.querySelector('#principal');
    const aviso = [...p.children].findIndex((n) => /Sem ligação/.test(n.textContent));
    const titulo = [...p.children].findIndex((n) => n.tagName === 'H1');
    return { aviso, titulo }`);
  certo(ordem.aviso > ordem.titulo,
    'carteira sem servidor: o aviso vem depois do título, não por cima dele',
    `aviso na posição ${ordem.aviso}, título na ${ordem.titulo}`);

  /* --- os prémios já ganhos ---------------------------------------------- */

  /* Tudo o que este ecrã precisa para listar prémios já está em memória —
     só o histórico dos já levantados é que exige o servidor. Perder a lista
     inteira por causa do histórico é perdê-la no pior momento possível:
     ao balcão, com o cartão cheio, a tentar levantar. */
  await palco.clicar(PREMIOS);
  await palco.esperar('#principal h1.titulo-grande, #principal .vazio h2', 8000);
  await palco.captura('14-api-caiu-premios');
  certo(await palco.contar('#principal .linha-premio') === 1,
    'prémios sem servidor: o prémio já ganho continua à vista — está todo na memória',
    (await palco.textoTodo()).slice(0, 120));

  /* --- o servidor responde, mas responde mal ---------------------------- */

  await fingir(palco, 'ok');
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha > .cartao', 8000);

  await fingir(palco, 'cinco00');
  await palco.clicar(DESCOBRIR);
  await palco.esperarTexto('Não deu para carregar', 8000);
  const de500 = await palco.texto('#principal .vazio .miudo');
  certo(de500 === 'O servidor teve um problema. Tenta daqui a pouco.',
    'servidor a responder 500: mostra a explicação que o servidor mandou',
    String(de500));
  certo(mensagemCrua(await palco.textoTodo()) === null,
    'servidor a responder 500: sem mensagens cruas no ecrã',
    String(mensagemCrua(await palco.textoTodo())));

  /* Um proxy pelo meio, ou o Cloudflare a devolver a sua própria página de
     erro, responde HTML — e o `JSON.parse` da app não tem por onde pegar. */
  await fingir(palco, 'lixo');
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .vazio h2, #principal .pilha > .cartao', 8000);
  await palco.clicar(DESCOBRIR);
  await palco.esperarTexto('Não deu para carregar', 8000);
  const deLixo = await palco.texto('#principal .vazio .miudo');
  certo(deLixo === 'Erro 502',
    'servidor a responder HTML: a app não engasga no JSON e diz o código do erro',
    String(deLixo));
  certo(!/</.test(String(deLixo)),
    'servidor a responder HTML: e não despeja a página de erro no ecrã',
    String(deLixo).slice(0, 80));

  /* --- a sessão que já não vale ------------------------------------------ */

  /* Um 401 tratado como falha de rede prendia a app: a pessoa recarregava,
     o testemunho morto continuava lá, e dava 401 outra vez para sempre. */
  await fingir(palco, 'quatro01');
  await palco.clicar(DESCOBRIR);
  await palco.esperarTexto('Não deu para carregar', 8000);
  certo(await palco.js("return localStorage.getItem('carimbo:sessao')") === null,
    'sessão expirada: o testemunho morto é deitado fora, senão a app ficava presa',
    String(await palco.js("return localStorage.getItem('carimbo:sessao')")));
  certo(mensagemCrua(await palco.textoTodo()) === null,
    'sessão expirada: a mensagem continua a ser para pessoas',
    String(await palco.texto('#principal .vazio .miudo')));

  /* --- o servidor que aceita a chamada e nunca responde ------------------ */

  /* É o pior caso e o mais comum em Wi-Fi de café: a ligação abre e fica
     ali. Sem tecto, o `fetch` fica pendurado para sempre e o ecrã em branco
     nunca chega a virar mensagem. */
  await fingir(palco, 'ok');
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha > .cartao', 8000);

  await palco.js('window.__fingir.abortos = []; return true');
  await fingir(palco, 'mudo');
  const antes = Date.now();
  await palco.clicar(DESCOBRIR);
  await palco.esperarTexto('Não deu para carregar', 25000);
  const demorou = Date.now() - antes;

  const abortos = await palco.js('return window.__fingir.abortos');
  certo(abortos.length > 0 && abortos[0].razao === 'TimeoutError',
    'servidor mudo: a app desiste sozinha em vez de ficar pendurada',
    JSON.stringify(abortos));
  certo(demorou > 10000 && demorou < 22000,
    'servidor mudo: e desiste ao fim dos 15 segundos prometidos',
    `esperou ${(demorou / 1000).toFixed(1)} s`);
  certo(await palco.texto('#principal .vazio .miudo')
    === 'O servidor está a demorar. Verifica a ligação e tenta outra vez.',
    'servidor mudo: a mensagem distingue «demora» de «sem ligação»',
    String(await palco.texto('#principal .vazio .miudo')));

  /* --- reabrir a app já com conta, e sem servidor ------------------------ */

  /* O caso de todos os dias: a app está instalada, a conta existe, os
     cartões já foram vistos ontem — e hoje o café não tem sinal. É aqui que
     um cartão de fidelidade digital tem de valer o mesmo que um de papel. */
  await fingirDesdeOArranque(palco, 'cair');
  await palco.recarregar();
  await palco.esperar('#barra .barra-item', 15000);
  await palco.captura('14-reabrir-sem-servidor');

  certo(await palco.js("return !!localStorage.getItem('carimbo:cliente')"),
    'reabrir sem servidor: a conta continua guardada no telemóvel');

  const numeroGuardado = await palco.js(
    `const c = localStorage.getItem('carimbo:cliente'); return c ? JSON.parse(c).publico : null`);
  certo(numeroGuardado === 'EA4BFM',
    'reabrir sem servidor: e o número do cartão também', String(numeroGuardado));

  /* O comentário do `gerarCodigo()` promete isto por escrito: «o cartão
     aparece e o código roda mesmo dentro de uma cave sem sinal. Quem precisa
     de ligação é o balcão». O número está no telemóvel, o segredo está no
     cofre, o QR desenha-se sem pedir nada a ninguém.

     Isto já foi um beco: a app abria, dizia «os teus cartões estão a salvo»,
     apagava a barra e não deixava caminho nenhum para o código. Agora a
     carteira abre com o que estava guardado. */
  certo(await palco.contar('#barra .barra-item') === 5,
    'reabrir sem servidor: a barra abre inteira — a app funciona, só não sincroniza',
    `${await palco.contar('#barra .barra-item')} separadores`);

  certo((await palco.textoTodo()).includes('Café da Praça'),
    'reabrir sem servidor: os cartões que já se tinham continuam a ver-se',
    (await palco.textoTodo()).slice(0, 140));

  certo((await palco.textoTodo()).includes('pode não estar actualizado'),
    'reabrir sem servidor: e a app avisa que o que mostra pode estar velho',
    (await palco.textoTodo()).slice(0, 200));

  /* O que a pessoa veio fazer: mostrar o código. Sem rede, e a sério. */
  await palco.clicar('.barra-item.barra-centro');
  await palco.esperar('#folha-codigo', 8000);
  const temQR = await palco.js(`
    const n = document.querySelector('#codigo-qr svg');
    return !!n && n.querySelectorAll('path').length > 0`);
  certo(temQR, 'reabrir sem servidor: e o código desenha-se, sem pedir nada a ninguém');
  certo(await palco.texto('.codigo-id') === 'EA4BFM',
    'reabrir sem servidor: com o número certo por baixo',
    String(await palco.texto('.codigo-id')));
  await palco.clicar('.codigo-fechar');
  await palco.sumir('#folha-codigo');

  await fingirDesdeOArranque(palco, 'ok');

  /* =======================================================================
     ACTO 6 — A API avariada (balcão)

     O balcão é o lado onde uma falha custa mais: há fila, e quem está a
     carimbar não tem como saber se carregou mal ou se a app está partida.
     ======================================================================= */

  await fingir(palco, 'ok');
  await palco.ir('/balcao/?demo=0');
  await palco.esperar('#entrada-acoes .btn', 8000);
  /* Entra-se pela porta dos fundos — o email de entrada é outro assunto, e
     é o módulo 07 que o trata. Aqui interessa o balcão já lá dentro. */
  await palco.js(`
    localStorage.setItem('carimbo:balcao-entrou', 'true');
    localStorage.setItem('carimbo:sessao-balcao', '"sessao-de-mentira"');
    localStorage.setItem('carimbo:operador', '"o-1"');
    return true`);
  await palco.recarregar();
  await palco.esperar('#barra .barra-item', 10000);

  certo(await palco.texto('#topo-titulo') === 'Carimbar',
    'API de mentira, balcão: entra com a sessão guardada',
    String(await palco.texto('#topo-titulo')));

  /* Guarda-se o que morrer sem ninguém a apanhar. Um tratador de clique que
     não espera pela sua própria promessa deixa o erro cair aqui — e o ecrã
     fica como estava, que neste caso é vazio. */
  await palco.js(`
    window.__mortes = [];
    addEventListener('unhandledrejection', (ev) => {
      window.__mortes.push(String(ev.reason && ev.reason.message || ev.reason));
    });
    return true`);

  await fingir(palco, 'cair');
  await palco.clicar(BAL_HOJE);
  await dormir(1200);
  await palco.captura('14-balcao-api-caiu-hoje');

  const corpoHoje = await palco.texto('#principal');
  certo(/Não deu|Sem ligação|Tentar outra vez/.test(String(corpoHoje)),
    'balcão sem servidor: o «Hoje» diz o que se passou em vez de ficar só com o título',
    `#principal = «${String(corpoHoje).slice(0, 80)}» (${String(corpoHoje).length} caracteres)`);

  const mortes = await palco.js('return window.__mortes || []');
  certo(mortes.length === 0,
    'balcão sem servidor: o erro é tratado, não morre dentro do clique',
    `${mortes.length} promessas por apanhar: ${mortes.slice(0, 2).join(' · ')}`);

  /* Não é um azar do «Hoje»: é o `irPara` do balcão que não tem rede de
     segurança nenhuma, e por isso vale para os quatro separadores. */
  await palco.clicar(BAL_CLIENTES);
  await dormir(1200);
  const corpoClientes = await palco.texto('#principal');
  certo(/Não deu|Sem ligação|Tentar outra vez|Ainda ninguém/.test(String(corpoClientes)),
    'balcão sem servidor: e o mesmo no «Clientes» — não é um caso isolado',
    `#principal = «${String(corpoClientes).slice(0, 80)}»`);

  /* --- a sessão que se perde por uma falha de rede ----------------------- */

  /* O arranque do balcão deita fora a marca de «já entrou» quando o `entrar()`
     falha, para não deixar lá uma sessão morta. Mas uma falha de rede não é
     uma sessão morta — e o `api.js` até marca a diferença com `erro.rede`,
     que é o que a app do cliente usa. Sem essa distinção, um segundo sem
     Wi-Fi manda o balcão para o ecrã de entrada, a pedir o email outra vez,
     no meio da fila. */
  await fingirDesdeOArranque(palco, 'cair');
  await palco.recarregar();
  await palco.esperar('#entrada, #barra .barra-item', 10000);
  await dormir(400);
  await palco.captura('14-balcao-perdeu-a-sessao');

  const aindaEntrado = await palco.js(
    "return localStorage.getItem('carimbo:balcao-entrou')");
  const sessaoLa = await palco.js(
    "return localStorage.getItem('carimbo:sessao-balcao')");
  certo(aindaEntrado !== null,
    'balcão sem servidor: uma falha de rede não deita fora a entrada do operador',
    `balcao-entrou=${aindaEntrado}, sessao-balcao=${sessaoLa}`);
  certo(!(await palco.visivel('#entrada'))
    || /liga[çc]|rede|servidor/i.test(await palco.textoTodo()),
    'balcão sem servidor: se voltar à entrada, ao menos diz porquê',
    (await palco.textoTodo()).slice(0, 140));

  await fingirDesdeOArranque(palco, 'ok');
  await palco.enviar('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: guiao }, palco.sessao).catch(() => {});
}

/* =========================================================================
   O servidor de mentira

   Um Worker que responde ao que lhe apetecer, dentro da própria página. É a
   única forma honesta de provocar um 500, um 401 ou um silêncio sem ir bater
   à porta do servidor a sério — e de medir o tecto de 15 segundos do
   `AbortSignal.timeout` com o relógio de quem espera.

   Substitui-se o `fetch` e não a rede porque a rede não chega: um pedido
   entre origens diferentes é precedido de um `OPTIONS` que o browser faz por
   sua conta, e que não passa por nenhum sítio onde um teste possa mandar.
   Os pedidos à própria origem seguem para o `fetch` verdadeiro.
   ========================================================================= */

function agora(dias = 0) {
  return new Date(Date.now() - dias * 86400000).toISOString();
}

async function montarServidorFingido(palco) {
  const programa = (id, negocioId, nome, premio, objetivo, selo) => ({
    id, negocioId, nome, tipo: 'carimbos', selo, objetivo, premio,
    arrefecimento: 3600, regras: 'Um carimbo por visita.', marcos: null, ativo: 1,
  });

  const negocios = [
    { id: 'n-1', slug: 'cafe-da-praca', nome: 'Café da Praça', cor: '#3B2417',
      categoria: 'Café', localidade: 'Ovar', morada: 'Praça da República 4',
      telefone: '234 111 222',
      programas: [programa('p-1', 'n-1', 'Cartão do café', 'Um café por conta da casa', 10, 'chavena')] },
    { id: 'n-2', slug: 'barbearia-do-monte', nome: 'Barbearia do Monte', cor: '#12232E',
      categoria: 'Barbearia', localidade: 'Aveiro', morada: 'Rua Direita 9',
      telefone: '234 111 333',
      programas: [programa('p-2', 'n-2', 'Corte a corte', 'Corte + barba grátis', 8, 'navalha')] },
    { id: 'n-3', slug: 'padaria-nova', nome: 'Padaria Nova', cor: '#C9821F',
      categoria: 'Padaria', localidade: 'Esmoriz', morada: 'Rua 21 n.º 3',
      telefone: '256 111 444',
      programas: [programa('p-3', 'n-3', 'Pão nosso', 'Bolo-rei ou pão de ló', 12, 'bolo')] },
  ];

  const comNegocio = (n) => ({
    id: n.id, nome: n.nome, slug: n.slug, cor: n.cor, categoria: n.categoria,
    localidade: n.localidade, morada: n.morada, telefone: n.telefone,
  });

  const premio = { id: 'x-1', cartaoId: 'k-1', descricao: 'Um café por conta da casa',
                   ganhoEm: agora(1), resgatadoEm: null };

  const cartoes = [
    { id: 'k-1', clienteId: 'c-1', programaId: 'p-1', negocioId: 'n-1',
      carimbos: 0, pontos: 0, totalCarimbos: 10, premiosGanhos: 1,
      aderiuEm: agora(40), ultimoEm: agora(1),
      negocio: comNegocio(negocios[0]), programa: negocios[0].programas[0],
      porResgatar: 1, premios: [premio] },
    { id: 'k-2', clienteId: 'c-1', programaId: 'p-2', negocioId: 'n-2',
      carimbos: 6, pontos: 0, totalCarimbos: 6, premiosGanhos: 0,
      aderiuEm: agora(60), ultimoEm: agora(11),
      negocio: comNegocio(negocios[1]), programa: negocios[1].programas[0],
      porResgatar: 0, premios: [] },
  ];

  const movimentos = [
    { id: 'm-1', cartaoId: 'k-1', tipo: 'carimbo', quantidade: 1, em: agora(1) },
    { id: 'm-2', cartaoId: 'k-1', tipo: 'premio', quantidade: 0,
      nota: 'Um café por conta da casa', em: agora(1) },
    { id: 'm-3', cartaoId: 'k-2', tipo: 'carimbo', quantidade: 1, em: agora(11) },
  ];

  const dados = {
    registo: {
      cliente: { id: 'c-1', publico: 'EA4BFM', criadoEm: agora(40), nome: null, email: null },
      /* 32 bytes em base64url — o que interessa é que a chave HMAC importe. */
      segredo: 'Q2FyaW1ib0RpZ2l0YWxTZWdyZWRvRGVNZW50aXJhMDA',
      sessao: 'sessao-de-mentira',
      horaDoServidor: agora(0),
    },
    cartoes, movimentos,
    negocios: negocios.map((n) => ({
      ...comNegocio(n),
      programas: n.programas.map((p) => ({
        id: p.id, nome: p.nome, tipo: p.tipo, selo: p.selo,
        objetivo: p.objetivo, premio: p.premio, regras: p.regras, marcos: null,
      })),
    })),
    balcao: {
      operador: { id: 'o-1', negocioId: 'n-1', nome: 'Balcão', papel: 'dono' },
      negocio: { ...comNegocio(negocios[0]), programas: negocios[0].programas },
    },
    resumo: { clientes: 2, novos30: 1, carimbosHoje: 3, carimbos30: 12,
              premiosGanhos: 1, premiosResgatados: 0, porResgatar: 1,
              quaseLa: 1, aFugir: 0 },
    clientes: [],
  };

  /* Sem template literals aqui dentro: este texto viaja como fonte para
     dentro da página e um `${` solto seria interpretado do lado errado. */
  const fonte = 'window.__DADOS = ' + JSON.stringify(dados) + ';\n' + `
    /* O modo inicial vem do armazenamento para se poder avariar o servidor
       ANTES de a página abrir — é a única maneira de testar o arranque. */
    window.__fingir = {
      modo: (function () {
        try { return localStorage.getItem('__fingir-modo') || 'ok'; } catch (e) { return 'ok'; }
      })(),
      pedidos: [], abortos: [],
    };
    (function () {
      var original = window.fetch.bind(window);
      function responder(estado, corpo, tipo) {
        return new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
          { status: estado, headers: { 'content-type': tipo || 'application/json' } });
      }
      function encaminhar(caminho, metodo) {
        var D = window.__DADOS;
        if (metodo === 'POST' && /\\/v1\\/cliente\\/registar$/.test(caminho)) return [200, D.registo];
        if (metodo === 'GET' && /\\/v1\\/cliente\\/cartoes$/.test(caminho)) return [200, D.cartoes];
        if (metodo === 'GET' && /\\/v1\\/cliente\\/cartoes\\/[^/]+$/.test(caminho)) {
          var id = caminho.split('/').pop();
          var k = D.cartoes.filter(function (x) { return x.id === id; })[0];
          if (!k) return [404, { erro: 'Cartão não encontrado' }];
          var m = D.movimentos.filter(function (x) { return x.cartaoId === id; });
          return [200, Object.assign({}, k, { movimentos: m })];
        }
        if (metodo === 'GET' && /\\/v1\\/descobrir$/.test(caminho)) return [200, D.negocios];
        if (metodo === 'POST' && /\\/v1\\/cliente\\/aderir$/.test(caminho)) return [200, D.cartoes[1]];
        if (metodo === 'GET' && /\\/v1\\/balcao\\/negocio$/.test(caminho)) return [200, D.balcao];
        if (metodo === 'GET' && /\\/v1\\/balcao\\/resumo$/.test(caminho)) return [200, D.resumo];
        if (metodo === 'GET' && /\\/v1\\/balcao\\/clientes$/.test(caminho)) return [200, D.clientes];
        return [404, { erro: 'O servidor de mentira não conhece ' + caminho }];
      }
      window.fetch = function (recurso, opcoes) {
        opcoes = opcoes || {};
        var url = String(recurso && recurso.url ? recurso.url : recurso);
        if (url.indexOf('http') !== 0 || url.indexOf(location.origin) === 0) {
          return original(recurso, opcoes);
        }
        var f = window.__fingir;
        var caminho = new URL(url).pathname;
        var metodo = opcoes.method || 'GET';
        var cabecalhos = opcoes.headers || {};
        f.pedidos.push({ caminho: caminho, metodo: metodo,
                         autorizacao: cabecalhos.authorization || null });

        /* A queda seca: é isto, palavra por palavra, o que o browser atira
           quando não há rede. Se a app a deixasse passar para o ecrã, era
           isto que a pessoa lia. */
        if (f.modo === 'cair') return Promise.reject(new TypeError('Failed to fetch'));

        /* O silêncio: aceita e nunca responde. Quem desiste é o sinal que a
           app trouxe — e é isso que se quer medir. */
        if (f.modo === 'mudo') {
          var comeco = Date.now();
          return new Promise(function (_, mal) {
            var s = opcoes.signal;
            if (!s) return;
            var aoAbortar = function () {
              f.abortos.push({ esperou: Date.now() - comeco,
                               razao: s.reason && s.reason.name });
              mal(s.reason || new DOMException('Abortado', 'AbortError'));
            };
            if (s.aborted) aoAbortar(); else s.addEventListener('abort', aoAbortar);
          });
        }

        if (f.modo === 'cinco00') {
          return Promise.resolve(responder(500,
            { erro: 'O servidor teve um problema. Tenta daqui a pouco.' }));
        }
        if (f.modo === 'lixo') {
          return Promise.resolve(responder(502,
            '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html'));
        }
        if (f.modo === 'quatro01') {
          return Promise.resolve(responder(401, { erro: 'A sessão expirou. Entra outra vez.' }));
        }

        var r = encaminhar(caminho, metodo);
        return Promise.resolve(responder(r[0], r[1]));
      };
    })();`;

  const { identifier } = await palco.enviar('Page.addScriptToEvaluateOnNewDocument',
    { source: fonte }, palco.sessao);
  return identifier;
}

/** Diz ao servidor de mentira como se há-de portar a partir de agora. */
function fingir(palco, modo) {
  return palco.js(`window.__fingir.modo = ${JSON.stringify(modo)}; return true`);
}

/** O mesmo, mas para o pedido que a página faz mal abre — antes de haver JS. */
function fingirDesdeOArranque(palco, modo) {
  return palco.js(`localStorage.setItem('__fingir-modo', ${JSON.stringify(modo)});
    if (window.__fingir) window.__fingir.modo = ${JSON.stringify(modo)};
    return true`);
}
