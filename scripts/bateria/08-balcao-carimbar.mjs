/* =========================================================================
   Bateria · 08 — Balcão: carimbar, entregar o prémio e anular

   O ecrã onde o produto se cumpre ou não se cumpre. Tudo o resto — a
   carteira, os prémios, o perfil — é consequência do que acontece aqui, com
   um cliente à espera do outro lado do balcão.

   A câmara não existe num Chrome sem interface, e por isso o caminho que
   este módulo conduz é a ENTRADA MANUAL. Não é um atalho de teste: é o
   recurso a sério para o telemóvel do balcão que não tem câmara, para a
   permissão recusada, e para o código que não lê à terceira tentativa com a
   fila a crescer. Se este caminho não funcionar, o balcão não funciona.

   Três defeitos acabados de fechar, que são o que este módulo existe para
   não deixar voltar:

   · O PRÉMIO QUE FICOU POR ENTREGAR. O botão de entregar só existia no
     painel do carimbo que tinha dado o prémio. Quem dissesse «levo noutro
     dia» perdia-o para sempre: não havia mais nenhum caminho na app inteira
     para o levantar. Agora tem de reaparecer na visita SEGUINTE.

   · O «ENGANEI-ME — ANULAR» QUE NUNCA FUNCIONOU. Ia buscar o movimento a uma
     rota de cliente com a sessão do operador. Em demonstração passava; em
     produção respondia 401 e o botão era um enfeite.

   · ANULAR UM PRÉMIO JÁ ENTREGUE. O brinde saiu pela porta e o cartão voltava
     a estar quase cheio: o café perdia duas vezes. Tem de ser recusado, com
     uma mensagem que se perceba.

   As contas não se escrevem à mão: leem-se do próprio programa da
   demonstração (`carimbo-demo:demo`) e comparam-se com o que está no ecrã.
   O balcão da demonstração é sempre o Café Torrado — 10 carimbos, um café
   por conta da casa, uma hora de arrefecimento.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '08 · Balcão: carimbar, entregar e anular';
export const desculpar = [/favicon/];

const CHAVE = 'carimbo-demo:demo';
const PROGRAMA = 'p-torrado';

/* O alfabeto dos números de cartão, tal como o núcleo o define: sem as
   letras e algarismos que se confundem uns com os outros a ler em voz alta
   por cima de um balcão. */
const ALFABETO = '234679ACDEFGHJKLMNPQRTUVWXYZ';

const MANUAL = '#botao-manual';
const BOTAO_PAINEL = '#painel .painel-folha .btn-cheio';
const ACOES = '#resultado .resultado-acoes button';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   O estado da demonstração, por baixo do ecrã

   Os dois motores — o demo e o Worker — guardam a mesma coisa. Ler o
   armazenamento é a única forma de separar «o ecrã diz que carimbou» de
   «carimbou»: um painel bonito por cima de uma gravação que não aconteceu é
   precisamente o defeito que ninguém vê ao balcão.
   ========================================================================= */

const estadoDemo = (palco) => palco.js(
  `const cru = localStorage.getItem('${CHAVE}'); return cru ? JSON.parse(cru) : null`);

/** O cartão do Café Torrado tal como está guardado, com prémios e movimentos. */
async function lerCartao(palco) {
  return palco.js(`
    const e = JSON.parse(localStorage.getItem('${CHAVE}') || 'null');
    if (!e) return null;
    const c = e.cartoes.find((x) => x.programaId === '${PROGRAMA}');
    if (!c) return null;
    return {
      carimbos: c.carimbos, totalCarimbos: c.totalCarimbos,
      premiosGanhos: c.premiosGanhos, ultimoEm: c.ultimoEm,
      premios: e.premios.filter((p) => p.cartaoId === c.id).map((p) => ({
        descricao: p.descricao, resgatadoEm: p.resgatadoEm,
        resgatadoPor: p.resgatadoPor || null })),
      movimentos: e.movimentos.filter((m) => m.cartaoId === c.id).map((m) => ({
        tipo: m.tipo, em: m.em, quantidade: m.quantidade,
        manual: m.manual === true, operador: m.operador || null, nota: m.nota || null }))
        .sort((a, b) => String(b.em).localeCompare(String(a.em))),
    };`);
}

const quantos = (cartao, tipo) =>
  (cartao ? cartao.movimentos : []).filter((m) => m.tipo === tipo).length;

/**
 * Põe o cartão num estado escolhido.
 *
 * Não é falsificar o ecrã: é semear a situação que se quer ver, do lado dos
 * dados, e depois conduzir a app pelos botões como uma pessoa faria. Os
 * casos que interessam — cartão à beira de encher, prémio de um ciclo
 * anterior já entregue — não estão na semente e levariam vinte visitas a
 * construir uma a uma.
 */
async function prepararCartao(palco, { carimbos, dias = 3, premios = [] }) {
  await palco.js(`
    const e = JSON.parse(localStorage.getItem('${CHAVE}'));
    const c = e.cartoes.find((x) => x.programaId === '${PROGRAMA}');
    const atras = (d) => new Date(Date.now() - d * 86400000).toISOString();
    c.carimbos = ${Number(carimbos)};
    c.ultimoEm = atras(${Number(dias)});
    e.premios = e.premios.filter((p) => p.cartaoId !== c.id);
    for (const p of ${JSON.stringify(premios)}) {
      e.premios.push({
        id: 'premio-' + Math.random().toString(16).slice(2), cartaoId: c.id,
        descricao: p.descricao, ganhoEm: atras(${Number(dias)} + 1),
        resgatadoEm: p.entregue ? atras(${Number(dias)}) : null });
    }
    c.premiosGanhos = ${JSON.stringify(premios)}.length;
    localStorage.setItem('${CHAVE}', JSON.stringify(e));
    return true`);
}

/**
 * Envelhece o carimbo mais recente do cartão.
 *
 * Anular só vale dois minutos — passado isso o cliente já foi embora e
 * anular passaria a ser uma forma de tirar carimbos a quem não está a ver.
 * Esperar dois minutos aqui era pagar dois minutos por cada corrida da
 * bateria; envelhece-se o movimento, que é a mesma coisa vista do lado do
 * relógio.
 */
async function envelhecerUltimoCarimbo(palco, minutos) {
  await palco.js(`
    const e = JSON.parse(localStorage.getItem('${CHAVE}'));
    const c = e.cartoes.find((x) => x.programaId === '${PROGRAMA}');
    const meus = e.movimentos
      .filter((m) => m.cartaoId === c.id && m.tipo === 'carimbo')
      .sort((a, b) => String(a.em).localeCompare(String(b.em)));
    meus[meus.length - 1].em = new Date(Date.now() - ${Number(minutos)} * 60000).toISOString();
    localStorage.setItem('${CHAVE}', JSON.stringify(e));
    return true`);
}

/** Recua o relógio do arrefecimento, sem tocar em mais nada. */
async function recuarRelogio(palco, dias = 3) {
  await palco.js(`
    const e = JSON.parse(localStorage.getItem('${CHAVE}'));
    const c = e.cartoes.find((x) => x.programaId === '${PROGRAMA}');
    c.ultimoEm = new Date(Date.now() - ${Number(dias)} * 86400000).toISOString();
    localStorage.setItem('${CHAVE}', JSON.stringify(e));
    return true`);
}

/* =========================================================================
   Ler o painel de resultado

   Num despejo só, e de propósito: o painel fecha-se sozinho passados seis
   segundos («ao balcão ninguém carrega em ok»). Uma dúzia de perguntas
   seguidas à página tinha uma hipótese real de apanhar o painel a meio da
   saída e acusar de vazio o que estava certo. Tira-se uma fotografia, e
   afirma-se sobre a fotografia.
   ========================================================================= */

async function lerResultado(palco) {
  return palco.js(`
    const r = document.querySelector('#resultado');
    if (!r) return null;
    const g = r.querySelector('.carimbos');
    const cartao = r.querySelector('.resultado-cartao');
    return {
      papel: r.getAttribute('role'),
      modal: r.getAttribute('aria-modal'),
      titulo: r.querySelector('.resultado-titulo')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      sub: r.querySelector('.resultado-sub')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      nome: r.querySelector('.cartao-nome')?.textContent.trim() ?? null,
      numero: r.querySelector('.cartao-id b')?.textContent.trim() ?? null,
      casas: g ? g.querySelectorAll('.carimbo').length : null,
      cheias: g ? g.querySelectorAll('.carimbo[data-estado="cheio"]').length : null,
      novas: g ? g.querySelectorAll('.carimbo[data-novo="sim"]').length : null,
      marcaPremio: !!r.querySelector('.resultado-marca-premio'),
      marcaMau: !!r.querySelector('.resultado-marca-mau'),
      cor: cartao ? cartao.style.getPropertyValue('--m').trim() : null,
      fundo: cartao ? getComputedStyle(cartao).backgroundColor : null,
      botoes: [...r.querySelectorAll('.resultado-acoes button')]
        .map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
    };`);
}

/** O selector de um botão do resultado, pelo que lá está escrito. */
async function botao(palco, pedaco) {
  const i = await palco.js(`
    const bs = [...document.querySelectorAll(${JSON.stringify(ACOES)})];
    return bs.findIndex((b) => b.textContent.includes(${JSON.stringify(pedaco)}))`);
  return i >= 0 ? `${ACOES}:nth-of-type(${i + 1})` : null;
}

const desativado = (palco, seletor) => palco.js(
  `const n = document.querySelector(${JSON.stringify(seletor)});
   return n ? !!n.disabled : null`);

/** Quem tem o foco, e se está dentro de um dado sítio. */
const focoDentro = (palco, seletor) => palco.js(`
  const alvo = document.querySelector(${JSON.stringify(seletor)});
  const a = document.activeElement;
  return {
    dentro: !!(alvo && a && alvo.contains(a)),
    quem: a ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')
      + (typeof a.className === 'string' && a.className ? '.' + a.className.trim().split(/\\s+/).join('.') : '')
      : null };`);

/* =========================================================================
   Avisos

   O `avisar()` deita fora o anterior e põe o novo com o mesmo aspecto. Para
   saber que apareceu um aviso NOVO marca-se o que já lá estava.
   ========================================================================= */

const marcarAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.dataset.visto = 'sim'; return true");

async function avisoNovo(palco, tecto = 6000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const t = await palco.texto('.aviso:not([data-visto])');
    if (t) return t;
    if (Date.now() > limite) return null;
    await dormir(100);
  }
}

const limparAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.remove(); return true");

/** Quem está mesmo debaixo de um ponto do ecrã. */
async function quemEstaEm(palco, x, y) {
  return palco.js(`
    const n = document.elementFromPoint(${x}, ${y});
    if (!n) return null;
    const b = n.closest('button');
    return {
      etiqueta: n.tagName.toLowerCase(),
      classe: typeof n.className === 'string' ? n.className : '',
      botao: b ? b.textContent.replace(/\\s+/g, ' ').trim() : null };`);
}

/* =========================================================================
   Conduzir o carimbo
   ========================================================================= */

/* O `carimbar()` do balcão fecha-se a si próprio durante 900 ms depois de
   cada tentativa. Respeita-se — não é um defeito escondido, é a guarda a
   funcionar, e duas pessoas ao balcão não se atropelam em menos de um
   segundo. O que a guarda não pode consentir é o mesmo dedo duas vezes, e
   isso mede-se à parte, mais abaixo. */
let ultimaTentativa = 0;
async function esperarGuarda() {
  const falta = 950 - (Date.now() - ultimaTentativa);
  if (falta > 0) await dormir(falta);
}

/** Abre a entrada manual, escreve o número e carrega em «Carimbar». */
async function carimbarNumero(palco, numero, { tecto = 9000 } = {}) {
  await esperarGuarda();
  await palco.clicar(MANUAL);
  await palco.esperar('#campo-numero', 5000);
  await palco.escrever('#campo-numero', numero);
  await palco.clicar(BOTAO_PAINEL);
  ultimaTentativa = Date.now();
  await palco.esperar('#resultado', tecto);
  await dormir(120);
}

/** Fecha o painel de resultado pelo botão que lá estiver escrito. */
async function fecharPeloBotao(palco, pedaco) {
  const alvo = await botao(palco, pedaco);
  if (!alvo) throw new Error(`não há botão «${pedaco}» no painel de resultado`);
  await palco.clicar(alvo);
  await palco.sumir('#resultado', 4000);
}

/** Fecha o painel pelo primeiro botão inofensivo que tiver, se estiver aberto. */
async function arrumarResultado(palco) {
  if (!(await palco.ver('#resultado'))) return null;
  for (const pedaco of ['Seguinte', 'noutro dia', 'Tentar outra vez']) {
    const alvo = await botao(palco, pedaco);
    if (!alvo) continue;
    await palco.clicar(alvo);
    await palco.sumir('#resultado', 4000);
    return pedaco;
  }
  throw new Error('o painel de resultado não tem por onde se feche sem estragar nada');
}

/**
 * Dois toques no mesmo sítio, como um polegar impaciente.
 *
 * `atraso = 0` manda os quatro eventos em fila, colados; um número manda o
 * segundo toque passado esse tempo, que é o intervalo de um toque duplo de
 * uma pessoa a sério. Devolve o ponto onde o dedo bateu.
 */
async function doisToques(palco, numero, { atraso = 0 } = {}) {
  await esperarGuarda();
  await palco.clicar(MANUAL);
  await palco.esperar('#campo-numero', 5000);
  await palco.escrever('#campo-numero', numero);

  const caixa = await palco.medir(BOTAO_PAINEL);
  if (!caixa) throw new Error('o botão de carimbar do painel não tem tamanho');
  const x = Math.round(caixa.centroX), y = Math.round(caixa.centroY);
  const bater = (tipo) => palco.enviar('Input.dispatchMouseEvent',
    { type: tipo, x, y, button: 'left', clickCount: 1 }, palco.sessao);

  if (atraso === 0) {
    await Promise.all([bater('mousePressed'), bater('mouseReleased'),
                       bater('mousePressed'), bater('mouseReleased')]);
  } else {
    await Promise.all([bater('mousePressed'), bater('mouseReleased')]);
    await dormir(atraso);
    await Promise.all([bater('mousePressed'), bater('mouseReleased')]);
  }
  ultimaTentativa = Date.now();
  /* Não se espera pelo `#resultado`: se o segundo toque apanhar o «anular», o
     painel fecha-se sozinho e esperar por ele penduraria o módulo em vez de
     mostrar o que se passou. */
  await dormir(900);
  return { x, y, caixa };
}

/**
 * Espera que a câmara desista.
 *
 * Num Chrome sem interface não há câmara nenhuma, e o `getUserMedia` demora
 * uns instantes a dizê-lo. Enquanto não disser, o `ecraCarimbar` ainda está
 * a correr e o foco vai-lhe parar às mãos — se se abrisse a entrada manual
 * antes disso, o cursor saía do campo sozinho e o teste culpava o painel.
 * Que a câmara desiste depressa já é medido no módulo 07; aqui só se espera.
 */
async function esperarCamara(palco, tecto = 16000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const t = await palco.texto('#visor-estado');
    if (t && !/A ligar a câmara/.test(t)) return t;
    if (Date.now() > limite) return t;
    await dormir(150);
  }
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  /* --- um cliente para carimbar ----------------------------------------- */

  /* O balcão da demonstração não tem clientes nenhuns até alguém abrir a app
     do lado de lá. Abre-se: é a mesma demonstração, no mesmo armazenamento,
     e é assim que uma pessoa a experimenta — a app numa mão, o balcão na
     outra. */
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#principal .pilha .cartao', 12000);

  const semente = await estadoDemo(palco);
  const cliente = semente.clientes[semente.clientes.length - 1];
  const NUMERO = cliente.publico;
  const negocio = semente.negocios.find((n) => n.id === 'n-torrado');
  const programa = negocio.programas.find((p) => p.id === PROGRAMA);
  const cartaoSemeado = semente.cartoes.find((c) => c.programaId === PROGRAMA);

  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(NUMERO || ''),
    'preparação: o cliente da demonstração tem um número de seis caracteres para se escrever ao balcão',
    String(NUMERO));

  /* --- entrar no balcão -------------------------------------------------- */

  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 10000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar(MANUAL, 14000);
  await esperarCamara(palco);

  certo(await palco.texto('#topo-titulo') === 'Carimbar',
    'balcão: entra directamente no ecrã de carimbar',
    String(await palco.texto('#topo-titulo')));

  /* Quem carimba tem de saber o que está a carimbar antes de carregar: um
     negócio com dois programas dá dois cartões diferentes ao mesmo cliente. */
  certo(await palco.texto('.programa-atual .programa-texto b') === programa.nome,
    `carimbar: o ecrã diz qual é o programa («${programa.nome}»)`,
    String(await palco.texto('.programa-atual .programa-texto b')));
  certo(await palco.texto('.programa-atual .programa-texto span')
    === `${programa.objetivo} carimbos · ${programa.premio}`,
    'carimbar: e diz quantos carimbos são e o que se ganha',
    String(await palco.texto('.programa-atual .programa-texto span')));

  certo(await palco.visivel(MANUAL),
    'carimbar: sem câmara, o botão de escrever o número está à vista');
  await palco.captura('08-ecra-carimbar');

  /* --- a entrada manual --------------------------------------------------- */

  await palco.clicar(MANUAL);
  await palco.esperar('#campo-numero', 5000);

  certo(await palco.visivel('#painel'), 'entrada manual: o painel abre');
  certo(await palco.texto('.painel-folha h2') === 'Número do cartão',
    'entrada manual: o painel diz ao que vem',
    String(await palco.texto('.painel-folha h2')));
  certo((await palco.texto('.painel-folha .subtexto') || '').includes('por baixo do código'),
    'entrada manual: explica onde é que o cliente tem o número',
    String(await palco.texto('.painel-folha .subtexto')));

  /* Ao balcão escreve-se com um polegar e há fila: o cursor tem de já estar
     no campo, senão é mais um toque antes do primeiro caracter. */
  await dormir(300);
  const foco = await palco.focado();
  certo(!!foco && foco.etiqueta === 'input' && String(foco.classe).includes('campo-numero'),
    'entrada manual: o foco cai sozinho no campo', JSON.stringify(foco));
  certo(await palco.atributo('#campo-numero', 'maxlength') === '6',
    'entrada manual: o campo não deixa escrever mais do que seis caracteres',
    String(await palco.atributo('#campo-numero', 'maxlength')));
  certo(await palco.atributo('#campo-numero', 'autocapitalize') === 'characters',
    'entrada manual: o teclado do telemóvel abre em maiúsculas',
    String(await palco.atributo('#campo-numero', 'autocapitalize')));

  /* O alfabeto dos cartões deita fora as letras que se confundem — não há
     nenhum «B», que se leria como «8». O exemplo que o campo mostra tem de
     ser um número possível: se não for, ensina a quem carimba a esperar um
     caracter que nunca lhe vai aparecer no cartão de ninguém. */
  const exemplo = await palco.atributo('#campo-numero', 'placeholder');
  certo(!!exemplo && [...exemplo].every((c) => ALFABETO.includes(c)),
    'entrada manual: o exemplo do campo é um número que pode mesmo existir',
    `«${exemplo}» — o alfabeto dos cartões é «${ALFABETO}»`);
  await palco.captura('08-entrada-manual');

  /* --- campo vazio -------------------------------------------------------- */

  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  const avisoVazio = await avisoNovo(palco);
  certo(avisoVazio === 'O número tem seis caracteres.',
    'campo vazio: a recusa aparece no ecrã e diz quantos caracteres são',
    String(avisoVazio));
  certo(await palco.visivel('#painel'),
    'campo vazio: o painel fica aberto para se escrever o número');
  certo(!(await palco.ver('#resultado')),
    'campo vazio: nada de painel de resultado por cima de um carimbo que não houve');
  await limparAvisos(palco);

  /* --- só espaços --------------------------------------------------------- */

  await palco.escrever('#campo-numero', '      ');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  certo(await avisoNovo(palco) === 'O número tem seis caracteres.',
    'seis espaços: não passam por um número de cartão', String(await palco.texto('.aviso')));
  await limparAvisos(palco);

  /* --- número a meio ------------------------------------------------------ */

  await palco.escrever('#campo-numero', 'ABC');
  await marcarAvisos(palco);
  await palco.clicar(BOTAO_PAINEL);
  certo(await avisoNovo(palco) === 'O número tem seis caracteres.',
    'número a meio: três caracteres não chegam', String(await palco.texto('.aviso')));
  certo(!(await palco.ver('#resultado')),
    'número a meio: não chega a haver pedido nenhum');
  await limparAvisos(palco);

  /* --- letras minúsculas -------------------------------------------------- */

  /* O número é impresso em maiúsculas na app do cliente e o alfabeto não tem
     letras ambíguas. Quem escreve com o polegar escreve como lhe sai. */
  await palco.escrever('#campo-numero', NUMERO.toLowerCase());
  certo(await palco.valor('#campo-numero') === NUMERO,
    'letras minúsculas: o campo passa-as a maiúsculas enquanto se escreve',
    `escrevi «${NUMERO.toLowerCase()}», ficou «${await palco.valor('#campo-numero')}»`);

  await palco.tecla('Escape');
  certo(!(await palco.ver('#painel')), 'entrada manual: a tecla Escape fecha o painel');

  /* --- um cartão que não existe ------------------------------------------ */

  await carimbarNumero(palco, 'ZZZZZZ');
  const erro = await lerResultado(palco);
  await palco.captura('08-cartao-desconhecido');

  certo(erro && erro.titulo === 'Cartão desconhecido',
    'cartão que não existe: o painel diz que o cartão não existe',
    erro ? String(erro.titulo) : 'não apareceu painel nenhum');
  certo(erro && erro.sub === 'Pede ao cliente para abrir a app outra vez.',
    'cartão que não existe: e diz o que fazer a seguir, não o código do erro',
    erro ? String(erro.sub) : '');
  certo(erro && erro.marcaMau && !erro.marcaPremio,
    'cartão que não existe: o painel vem marcado como má notícia',
    JSON.stringify(erro && { mau: erro.marcaMau, premio: erro.marcaPremio }));
  certo(erro && erro.papel === 'alertdialog',
    'cartão que não existe: um leitor de ecrã ouve que é um alerta',
    erro ? String(erro.papel) : '');
  certo(erro && erro.botoes.join('|') === 'Tentar outra vez',
    'cartão que não existe: um botão só, e é para tentar outra vez',
    erro ? erro.botoes.join('|') : '');
  certo(!(await palco.ver('#painel')),
    'cartão que não existe: a entrada manual fecha-se antes do resultado, sem dois painéis empilhados');

  /* A entrada manual fecha-se com o Escape (é o `abrirPainel` que o trata).
     O painel de resultado tapa o ecrã todo e diz-se `role="alertdialog"` —
     quem tem um teclado espera a mesma tecla nos dois. */
  await palco.tecla('Escape');
  certo(!(await palco.ver('#resultado')),
    'cartão que não existe: a tecla Escape fecha o painel, como fecha o da entrada manual',
    'o painel continuou aberto');

  await arrumarResultado(palco);
  certo(!(await palco.ver('#resultado')),
    'cartão que não existe: «Tentar outra vez» fecha o painel');

  /* --- carimbar a sério --------------------------------------------------- */

  const antes = await lerCartao(palco);
  certo(antes && antes.carimbos === cartaoSemeado.carimbos,
    `preparação: o cartão do cliente no Café Torrado está em ${cartaoSemeado.carimbos} carimbos`,
    antes ? String(antes.carimbos) : 'não há cartão');

  await carimbarNumero(palco, NUMERO);
  const carimbado = await lerResultado(palco);
  await palco.captura('08-carimbado');

  const esperados = antes.carimbos + 1;
  certo(carimbado && carimbado.titulo === 'Carimbado',
    'carimbar: o painel confirma o carimbo',
    carimbado ? String(carimbado.titulo) : 'não apareceu painel nenhum');
  certo(carimbado && carimbado.sub
    === `${esperados} de ${programa.objetivo} · faltam ${programa.objetivo - esperados}`,
    `carimbar: a conta bate — «${esperados} de ${programa.objetivo} · faltam ${programa.objetivo - esperados}»`,
    carimbado ? String(carimbado.sub) : '');
  certo(carimbado && carimbado.nome === negocio.nome && carimbado.numero === NUMERO,
    'carimbar: o painel mostra de quem é o cartão que acabou de ser carimbado',
    carimbado ? `${carimbado.nome} / ${carimbado.numero}` : '');
  certo(carimbado && carimbado.casas === programa.objetivo && carimbado.cheias === esperados,
    `carimbar: a grelha desenha ${esperados} de ${programa.objetivo} casas cheias`,
    carimbado ? `${carimbado.cheias} de ${carimbado.casas}` : '');
  certo(carimbado && carimbado.novas === 1,
    'carimbar: e assinala qual é a casa que acabou de assentar',
    carimbado ? `${carimbado.novas} casas marcadas como novas` : '');
  certo(carimbado && carimbado.papel === 'dialog' && carimbado.modal === 'true',
    'carimbar: o painel apresenta-se como diálogo modal',
    carimbado ? `${carimbado.papel} / ${carimbado.modal}` : '');

  /* `aria-modal="true"` diz ao leitor de ecrã para esconder tudo o resto da
     página. Se o foco ficar de fora do painel, quem não vê fica com o cursor
     num sítio que passou a estar escondido: não ouve o resultado do carimbo
     e não encontra os botões. É o preço de prometer diálogo modal e não
     mudar o foco para dentro dele. */
  const focoResultado = await focoDentro(palco, '#resultado');
  certo(focoResultado.dentro,
    'carimbar: o foco entra no painel, senão quem usa leitor de ecrã fica de fora do que se abriu',
    `o foco ficou em ${focoResultado.quem}`);
  certo(carimbado && carimbado.cor.toLowerCase() === negocio.cor.toLowerCase(),
    'carimbar: o cartão do resultado vem pintado com a cor do negócio',
    carimbado ? `${carimbado.cor} ≠ ${negocio.cor}` : '');
  certo(carimbado && carimbado.botoes.length === 2
    && carimbado.botoes[0] === 'Seguinte'
    && /anular/i.test(carimbado.botoes[1]),
    'carimbar: as duas saídas são seguir em frente e anular',
    carimbado ? carimbado.botoes.join(' | ') : '');

  /* O ecrã pode dizer o que quiser: o que fica é o que ficou gravado. */
  const gravado = await lerCartao(palco);
  certo(gravado && gravado.carimbos === esperados,
    'carimbar: o cartão gravado subiu mesmo um carimbo',
    gravado ? `${gravado.carimbos} (esperava ${esperados})` : '');
  certo(quantos(gravado, 'carimbo') === quantos(antes, 'carimbo') + 1,
    'carimbar: ficou um movimento novo no histórico do cliente',
    `${quantos(antes, 'carimbo')} → ${quantos(gravado, 'carimbo')}`);
  /* Um número escrito à mão não é um código assinado: o dono do negócio tem
     de conseguir distingui-los no histórico. */
  certo(gravado && gravado.movimentos[0] && gravado.movimentos[0].manual === true,
    'carimbar: o movimento fica marcado como escrito à mão, e não como lido pela câmara',
    gravado ? JSON.stringify(gravado.movimentos[0]) : '');

  /* --- anular o carimbo que se acabou de dar ----------------------------- */

  /* O «enganei-me no cliente» de qualquer balcão. Este botão esteve morto em
     produção durante toda a vida da app. */
  const anular = await botao(palco, 'anular');
  certo(!!anular, 'anular: o botão existe no painel do carimbo',
    (carimbado ? carimbado.botoes.join(' | ') : ''));

  /* Meio segundo de carência: o painel nasce onde o dedo acabou de estar, e
     esta é a única acção destrutiva do balcão. Um toque duplo anulava o
     carimbo que o primeiro toque tinha dado, em silêncio. O botão nasce
     desactivado e liberta-se sozinho — o teste espera, como uma pessoa
     espera. */
  certo(await palco.js(`return document.querySelector(${JSON.stringify(anular)}).disabled`),
    'anular: nasce desactivado, para um toque duplo não o accionar sem querer');
  await dormir(700);
  certo(!(await palco.js(`return document.querySelector(${JSON.stringify(anular)}).disabled`)),
    'anular: e liberta-se sozinho meio segundo depois');

  await marcarAvisos(palco);
  await dormir(700);
  await palco.clicar(anular);
  const avisoAnular = await avisoNovo(palco);
  certo(avisoAnular === 'Carimbo anulado.',
    'anular: a app confirma que anulou', String(avisoAnular));
  certo(!(await palco.ver('#resultado')),
    'anular: o painel fecha-se, o balcão fica livre para o cliente seguinte');

  const desfeito = await lerCartao(palco);
  certo(desfeito && desfeito.carimbos === antes.carimbos,
    `anular: o cartão voltou aos ${antes.carimbos} carimbos`,
    desfeito ? String(desfeito.carimbos) : '');
  certo(quantos(desfeito, 'carimbo') === quantos(antes, 'carimbo'),
    'anular: o movimento do carimbo saiu do histórico',
    `${quantos(desfeito, 'carimbo')} carimbos no histórico`);
  certo(quantos(desfeito, 'anulado') === 1,
    'anular: e fica um registo de que houve uma anulação, para não ser um buraco',
    `${quantos(desfeito, 'anulado')} anulações`);

  /* O relógio do arrefecimento tem de voltar atrás com o carimbo. Sem isto,
     quem se engana no cliente fica uma hora sem poder carimbar o certo,
     porque o cartão ainda tem a marca de um carimbo que já não existe. */
  const relogio = desfeito && desfeito.ultimoEm
    ? Date.now() - new Date(desfeito.ultimoEm).getTime() : null;
  certo(relogio !== null && relogio > 60000,
    'anular: o relógio do arrefecimento recua para o movimento anterior',
    desfeito ? `o último carimbo do cartão ficou marcado em ${desfeito.ultimoEm}` : '');

  /* E prova-se pelo caminho da pessoa: logo a seguir tem de dar para carimbar. */
  await carimbarNumero(palco, NUMERO);
  const segundo = await lerResultado(palco);
  certo(segundo && segundo.titulo === 'Carimbado',
    'anular: logo a seguir dá para carimbar outra vez, sem esperar uma hora',
    segundo ? `${segundo.titulo} — ${segundo.sub}` : 'não apareceu painel nenhum');
  await fecharPeloBotao(palco, 'Seguinte');

  /* --- o arrefecimento ---------------------------------------------------- */

  /* Agora o cartão acabou mesmo de ser carimbado. A segunda tentativa é o
     cliente que volta ao balcão dois minutos depois com o mesmo cartão. */
  await carimbarNumero(palco, NUMERO);
  const arrefece = await lerResultado(palco);
  await palco.captura('08-arrefecimento');

  certo(arrefece && arrefece.titulo === 'Já foi carimbado há pouco',
    'arrefecimento: carimbar o mesmo cartão logo a seguir é recusado',
    arrefece ? String(arrefece.titulo) : 'não apareceu painel nenhum');
  certo(arrefece && /\d+\s*min/.test(String(arrefece.sub)),
    'arrefecimento: e a mensagem diz daqui a quanto tempo se pode voltar a tentar',
    arrefece ? String(arrefece.sub) : '');
  certo(arrefece && arrefece.marcaMau,
    'arrefecimento: o painel vem marcado como recusa, não como carimbo dado',
    JSON.stringify(arrefece && { mau: arrefece.marcaMau }));
  /* O título resume e o corpo explica. Se o corpo começar por repetir o
     título palavra por palavra, metade da mensagem não diz nada — e é
     mensagem que se lê de relance, com uma pessoa à espera. */
  certo(arrefece && !String(arrefece.sub).startsWith(String(arrefece.titulo)),
    'arrefecimento: o corpo da mensagem acrescenta ao título em vez de o repetir',
    arrefece ? `título «${arrefece.titulo}», corpo «${arrefece.sub}»` : '');

  const naoMexeu = await lerCartao(palco);
  certo(naoMexeu && naoMexeu.carimbos === segundo.cheias,
    'arrefecimento: a recusa não deixou nenhum carimbo por engano',
    naoMexeu ? `${naoMexeu.carimbos} carimbos` : '');
  await fecharPeloBotao(palco, 'Tentar outra vez');

  /* =======================================================================
     Anular fora de tempo

     A janela de anulação é de dois minutos, e a razão é simples: passado
     isso o cliente já saiu do café e anular deixa de ser «enganei-me» para
     passar a ser tirar carimbos a quem não está a ver.
     ======================================================================= */

  await prepararCartao(palco, { carimbos: 3, dias: 3 });
  const antesDeTarde = await lerCartao(palco);
  await carimbarNumero(palco, NUMERO);
  await envelhecerUltimoCarimbo(palco, 5);

  const anularTardio = await botao(palco, 'anular');
  await marcarAvisos(palco);
  await dormir(700);
  await palco.clicar(anularTardio);
  const avisoTarde = await avisoNovo(palco);

  certo(avisoTarde === 'Já passaram mais de 2 minutos — não dá para anular.',
    'anular fora de tempo: passados dois minutos a app recusa e diz porquê',
    String(avisoTarde));
  certo(await palco.ver('#resultado'),
    'anular fora de tempo: o painel fica aberto, o carimbo continua de pé');
  const depoisDeTarde = await lerCartao(palco);
  certo(depoisDeTarde && depoisDeTarde.carimbos === antesDeTarde.carimbos + 1,
    'anular fora de tempo: o carimbo não foi desfeito',
    depoisDeTarde ? `${antesDeTarde.carimbos} → ${depoisDeTarde.carimbos} carimbos` : '');
  certo(quantos(depoisDeTarde, 'anulado') === quantos(antesDeTarde, 'anulado'),
    'anular fora de tempo: e não ficou registada nenhuma anulação',
    `${quantos(antesDeTarde, 'anulado')} → ${quantos(depoisDeTarde, 'anulado')}`);

  await limparAvisos(palco);
  await arrumarResultado(palco);

  /* =======================================================================
     Dois toques depressa no mesmo sítio

     O polegar bate duas vezes porque à primeira parece que não aconteceu
     nada. Duas coisas têm de ser verdade: o segundo toque não pode dar um
     segundo carimbo, e o painel que aparece por baixo do dedo não pode ter
     ali uma acção destrutiva — um «anular» debaixo do segundo toque desfaz
     em silêncio o carimbo que se acabou de dar, com um aviso que ninguém lê.
     ======================================================================= */

  /* Semeia-se o pior caso: o toque completa o cartão, que é quando o painel
     fica mais cheio de botões. */
  await prepararCartao(palco, { carimbos: programa.objetivo - 1, dias: 3 });
  const antesDoDuplo = await lerCartao(palco);

  const dedo = await doisToques(palco, NUMERO, { atraso: 0 });
  await palco.captura('08-dois-toques');

  const debaixoDoDedo = await quemEstaEm(palco, dedo.x, dedo.y);
  const depoisDoDuplo = await lerCartao(palco);

  certo(quantos(depoisDoDuplo, 'carimbo') === quantos(antesDoDuplo, 'carimbo') + 1,
    'dois toques colados: entra um carimbo, não dois',
    `${quantos(antesDoDuplo, 'carimbo')} → ${quantos(depoisDoDuplo, 'carimbo')} carimbos no histórico`);
  certo(quantos(depoisDoDuplo, 'anulado') === quantos(antesDoDuplo, 'anulado'),
    'dois toques colados: e o segundo toque não desfaz o carimbo do primeiro',
    `apanhou ${debaixoDoDedo && debaixoDoDedo.botao ? `«${debaixoDoDedo.botao}»` : 'nada'} por baixo do dedo`);

  /* O painel que aparece é fixo e ocupa o fundo do ecrã — o mesmo fundo onde
     estava o botão em que a pessoa acabou de carregar. Se lhe puser uma acção
     destrutiva debaixo do dedo, o segundo toque de um toque duplo desfaz o
     carimbo que o primeiro deu, com um aviso de dois segundos que ninguém lê
     no meio de uma fila. */
  const anularCaixa = await palco.js(`
    const b = [...document.querySelectorAll(${JSON.stringify(ACOES)})]
      .find((n) => /anular/i.test(n.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, largura: r.width, altura: r.height };`);
  const cobre = anularCaixa && dedo.x >= anularCaixa.x && dedo.x <= anularCaixa.x + anularCaixa.largura
    && dedo.y >= anularCaixa.y && dedo.y <= anularCaixa.y + anularCaixa.altura;
  certo(!cobre,
    'dois toques: o «anular» não nasce em cima do sítio onde estava o botão de carimbar',
    `o dedo bateu em (${dedo.x}, ${dedo.y}) e o «anular» ocupa ${JSON.stringify(anularCaixa)}`);
  certo(!(debaixoDoDedo && debaixoDoDedo.botao && /anular|entreguei/i.test(debaixoDoDedo.botao)),
    'dois toques: passado o instante da animação, quem fica debaixo do dedo não é uma acção destrutiva',
    JSON.stringify(debaixoDoDedo));

  await arrumarResultado(palco);

  /* --- e agora um toque duplo de uma pessoa a sério ---------------------- */

  /* Nada de truques: o segundo toque vem 400 ms depois do primeiro, que é o
     intervalo de um toque duplo humano — e mais do que os 320 ms que o painel
     leva a subir, por isso já não é a animação a apanhar o toque no ar. É o
     dedo a bater duas vezes no mesmo sítio porque à primeira parece que não
     aconteceu nada, que é o que se faz mil vezes por dia num telemóvel. */
  await prepararCartao(palco, { carimbos: 5, dias: 3 });
  const antesDoHumano = await lerCartao(palco);

  const dedo2 = await doisToques(palco, NUMERO, { atraso: 400 });
  await palco.captura('08-toque-duplo-humano');
  const depoisDoHumano = await lerCartao(palco);

  certo(depoisDoHumano && depoisDoHumano.carimbos === antesDoHumano.carimbos + 1,
    'toque duplo: o carimbo que a pessoa deu continua lá',
    depoisDoHumano
      ? `${antesDoHumano.carimbos} → ${depoisDoHumano.carimbos} carimbos`
      : 'não consegui ler o cartão');
  certo(quantos(depoisDoHumano, 'anulado') === quantos(antesDoHumano, 'anulado'),
    'toque duplo: o segundo toque não anula o carimbo às escondidas',
    `${quantos(antesDoHumano, 'anulado')} → ${quantos(depoisDoHumano, 'anulado')} anulações,`
    + ` dedo em (${dedo2.x}, ${dedo2.y})`);

  await arrumarResultado(palco);

  /* =======================================================================
     O prémio que ficou por entregar

     O defeito mais caro do balcão, e o mais silencioso: o botão de entregar
     só existia no painel do carimbo que dava o prémio. Quem dissesse «levo
     noutro dia» ficava sem forma nenhuma de o levantar — nem na app do
     cliente, nem no balcão, nem em lado nenhum.
     ======================================================================= */

  await prepararCartao(palco, { carimbos: programa.objetivo - 1, dias: 3 });
  await carimbarNumero(palco, NUMERO);
  const completo = await lerResultado(palco);
  await palco.captura('08-cartao-completo');

  certo(completo && completo.titulo === 'Cartão completo!',
    'cartão cheio: o painel festeja o cartão completo',
    completo ? String(completo.titulo) : 'não apareceu painel nenhum');
  certo(completo && completo.sub === `Entregar: ${programa.premio}`,
    'cartão cheio: e diz o que há para entregar, pelo nome',
    completo ? String(completo.sub) : '');
  certo(completo && completo.marcaPremio,
    'cartão cheio: o painel vem marcado como prémio, não como mais um carimbo',
    JSON.stringify(completo && { premio: completo.marcaPremio }));
  /* O cartão fica a zeros por dentro no instante em que enche. Mostrá-lo a
     zeros ao cliente que acabou de o completar seria dizer-lhe que perdeu
     tudo. */
  certo(completo && completo.cheias === programa.objetivo,
    'cartão cheio: a grelha mostra-se cheia, e não a zeros como está por dentro',
    completo ? `${completo.cheias} de ${completo.casas}` : '');
  certo(completo && completo.botoes[0] === `Entreguei: ${programa.premio}`,
    'cartão cheio: o primeiro botão é entregar o prémio',
    completo ? completo.botoes.join(' | ') : '');
  certo(completo && completo.botoes.includes('O cliente leva noutro dia'),
    'cartão cheio: e há saída para quem leva noutro dia',
    completo ? completo.botoes.join(' | ') : '');

  /* «Levo noutro dia» — a frase que fazia o prémio desaparecer. */
  await fecharPeloBotao(palco, 'noutro dia');
  const guardado = await lerCartao(palco);
  certo(guardado && guardado.premios.filter((p) => !p.resgatadoEm).length === 1,
    'levar noutro dia: o prémio fica guardado por entregar',
    guardado ? JSON.stringify(guardado.premios) : '');

  /* A visita seguinte. É aqui que o defeito vivia. */
  await recuarRelogio(palco, 3);
  await carimbarNumero(palco, NUMERO);
  const visitaSeguinte = await lerResultado(palco);
  await palco.captura('08-premio-a-espera');

  certo(visitaSeguinte && visitaSeguinte.titulo === 'Tem um prémio à espera',
    'visita seguinte: o prémio por entregar aparece no painel do carimbo seguinte',
    visitaSeguinte ? String(visitaSeguinte.titulo) : 'não apareceu painel nenhum');
  certo(visitaSeguinte && visitaSeguinte.sub === `Entregar: ${programa.premio}`,
    'visita seguinte: e o painel nomeia o prémio que está por entregar',
    visitaSeguinte ? String(visitaSeguinte.sub) : '');
  certo(visitaSeguinte && visitaSeguinte.botoes[0] === `Entreguei: ${programa.premio}`,
    'visita seguinte: com o botão de o entregar, que era o que não existia',
    visitaSeguinte ? visitaSeguinte.botoes.join(' | ') : '');
  certo(visitaSeguinte && visitaSeguinte.marcaPremio,
    'visita seguinte: o painel vem marcado como prémio',
    JSON.stringify(visitaSeguinte && { premio: visitaSeguinte.marcaPremio }));
  /* O carimbo desta visita conta na mesma: o cartão novo já leva um. */
  certo(visitaSeguinte && visitaSeguinte.cheias === 1,
    'visita seguinte: o cartão seguinte já leva o carimbo de hoje',
    visitaSeguinte ? `${visitaSeguinte.cheias} de ${visitaSeguinte.casas}` : '');

  /* --- entregar o prémio -------------------------------------------------- */

  const entregar = await botao(palco, 'Entreguei');
  await marcarAvisos(palco);
  await palco.clicar(entregar);
  const avisoEntrega = await avisoNovo(palco);
  certo(avisoEntrega === 'Prémio entregue.',
    'entregar: a app confirma a entrega', String(avisoEntrega));
  certo(!(await palco.ver('#resultado')),
    'entregar: o painel fecha-se e o balcão fica livre');

  const entregue = await lerCartao(palco);
  certo(entregue && entregue.premios.length === 1 && !!entregue.premios[0].resgatadoEm,
    'entregar: o prémio fica marcado como entregue no registo',
    entregue ? JSON.stringify(entregue.premios) : '');
  certo(entregue && entregue.premios[0] && entregue.premios[0].resgatadoPor === 'Balcão',
    'entregar: e fica registado quem o entregou',
    entregue ? String(entregue.premios[0] && entregue.premios[0].resgatadoPor) : '');
  certo(quantos(entregue, 'resgate') === 1,
    'entregar: com uma linha no histórico do cliente',
    `${quantos(entregue, 'resgate')} resgates`);
  certo(entregue && entregue.premios.filter((p) => !p.resgatadoEm).length === 0,
    'entregar: e não sobra nenhum prémio por levantar neste cartão',
    entregue ? JSON.stringify(entregue.premios) : '');

  /* O outro lado da correcção, que é o que uma correcção destas costuma
     partir: um prémio que reaparecesse em todas as visitas seguintes era um
     café de graça por dia, para sempre. Uma vez entregue, cala-se. */
  await recuarRelogio(palco, 3);
  await carimbarNumero(palco, NUMERO);
  const jaFoi = await lerResultado(palco);
  certo(jaFoi && jaFoi.titulo === 'Carimbado',
    'depois de entregue: a visita seguinte é um carimbo normal, sem prémio a reaparecer',
    jaFoi ? `${jaFoi.titulo} — ${jaFoi.sub}` : 'não apareceu painel nenhum');
  certo(jaFoi && !jaFoi.botoes.some((b) => /Entreguei/.test(b)),
    'depois de entregue: e o botão de entregar não volta a aparecer',
    jaFoi ? jaFoi.botoes.join(' | ') : '');
  await fecharPeloBotao(palco, 'Seguinte');

  /* =======================================================================
     Anular um carimbo cujo prémio já saiu pela porta

     O cliente completou um cartão, levou o brinde, e começou outro. Se ao
     encher o segundo alguém carregar em «anular», o café perde duas vezes: o
     brinde já saiu e o cartão volta a estar quase cheio. Tem de ser
     recusado — e a recusa tem de aparecer, senão o operador fica sem saber
     se anulou ou não.
     ======================================================================= */

  await prepararCartao(palco, {
    carimbos: programa.objetivo - 1, dias: 3,
    premios: [{ descricao: programa.premio, entregue: true }],
  });
  const antesDaRecusa = await lerCartao(palco);

  await carimbarNumero(palco, NUMERO);
  const outraVez = await lerResultado(palco);
  certo(outraVez && outraVez.titulo === 'Cartão completo!',
    'segundo cartão: enche-se como o primeiro',
    outraVez ? String(outraVez.titulo) : 'não apareceu painel nenhum');

  const anularTarde = await botao(palco, 'anular');
  certo(!!anularTarde, 'prémio já entregue: o botão de anular está lá — a recusa é do lado de dentro',
    outraVez ? outraVez.botoes.join(' | ') : '');

  await marcarAvisos(palco);
  await dormir(700);
  await palco.clicar(anularTarde);
  const avisoRecusa = await avisoNovo(palco);
  await palco.captura('08-anular-recusado');

  certo(avisoRecusa === 'Este carimbo deu um prémio que já foi entregue — não dá para anular.',
    'prémio já entregue: anular é recusado com uma frase que explica porquê',
    String(avisoRecusa));
  certo(await palco.visivel('.aviso:not([data-visto])'),
    'prémio já entregue: e a recusa está mesmo à vista de quem está ao balcão');
  certo(await palco.ver('#resultado'),
    'prémio já entregue: o painel fica aberto — o carimbo continua de pé');
  certo(await desativado(palco, anularTarde) === false,
    'prémio já entregue: o botão não fica morto depois da recusa',
    'ficou desactivado para sempre');

  /* A recusa é uma mensagem que aparece por cima de um painel cheio de
     botões. Se pousar em cima deles, o operador lê o erro e não consegue
     fazer mais nada. */
  const avisoCaixa = await palco.medir('.aviso');
  const primeiro = await palco.medir(`${ACOES}:nth-of-type(1)`);
  const pisa = avisoCaixa && primeiro
    && avisoCaixa.x < primeiro.x + primeiro.largura && avisoCaixa.x + avisoCaixa.largura > primeiro.x
    && avisoCaixa.y < primeiro.y + primeiro.altura && avisoCaixa.y + avisoCaixa.altura > primeiro.y;
  certo(!pisa, 'prémio já entregue: a mensagem de recusa não pousa em cima dos botões',
    `aviso ${JSON.stringify(avisoCaixa)} vs botão ${JSON.stringify(primeiro)}`);

  const depoisDaRecusa = await lerCartao(palco);
  certo(depoisDaRecusa && depoisDaRecusa.carimbos === 0,
    'prémio já entregue: o cartão fica como estava, com o carimbo que completou',
    depoisDaRecusa ? String(depoisDaRecusa.carimbos) : '');
  certo(quantos(depoisDaRecusa, 'carimbo') === quantos(antesDaRecusa, 'carimbo') + 1,
    'prémio já entregue: o movimento do carimbo não foi apagado',
    `${quantos(antesDaRecusa, 'carimbo')} → ${quantos(depoisDaRecusa, 'carimbo')}`);
  certo(quantos(depoisDaRecusa, 'anulado') === quantos(antesDaRecusa, 'anulado'),
    'prémio já entregue: e não ficou registada nenhuma anulação',
    `${quantos(depoisDaRecusa, 'anulado')} anulações`);
  certo(depoisDaRecusa && depoisDaRecusa.premios.filter((p) => !p.resgatadoEm).length === 1,
    'prémio já entregue: o prémio novo continua por entregar, à espera do cliente',
    depoisDaRecusa ? JSON.stringify(depoisDaRecusa.premios) : '');

  await limparAvisos(palco);
  await fecharPeloBotao(palco, 'noutro dia');

  /* =======================================================================
     O painel fecha-se sozinho

     «Ao balcão ninguém carrega em ok»: seis segundos depois o painel sai da
     frente sozinho, senão o cliente seguinte fica à espera de que alguém se
     lembre de o fechar. Mede-se por amostras, e não num instante: o que se
     quer provar é que fica tempo de o ler e que acaba por sair.
     ======================================================================= */

  await carimbarNumero(palco, 'ZZZZZZ');
  const nasceu = Date.now();
  await dormir(2500);
  certo(await palco.ver('#resultado'),
    'fecho sozinho: dois segundos e meio depois ainda lá está para se ler',
    `passaram ${Math.round((Date.now() - nasceu) / 100) / 10} s`);

  const limite = Date.now() + 12000;
  let saiu = false;
  while (Date.now() < limite) {
    if (!(await palco.ver('#resultado'))) { saiu = true; break; }
    await dormir(250);
  }
  certo(saiu, 'fecho sozinho: e acaba por sair da frente sem ninguém lhe tocar',
    `ainda lá estava passados ${Math.round((Date.now() - nasceu) / 1000)} s`);
}
