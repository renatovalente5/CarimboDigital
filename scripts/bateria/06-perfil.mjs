/* =========================================================================
   Bateria · 06 — Perfil: conta, email, exportar e apagar

   O perfil é onde a app faz as promessas mais caras: «os cartões voltam
   todos», «tudo o que temos sobre ti, num ficheiro», «imediato e sem volta».
   Nenhuma delas se verifica a olhar para o ecrã — só carregando nos botões.

   Quatro coisas que este módulo persegue de propósito:

   · O BOTÃO MORTO. Quem desactiva um botão antes de esperar tem de o
     reactivar quando a coisa corre mal — e quem lê `ev.currentTarget` depois
     de um `await` recebe `null`, rebenta dentro do catch e deixa o
     formulário mudo para sempre. Prova-se com um MutationObserver no
     atributo `disabled`: regista a ida e a volta mesmo quando as duas
     acontecem no mesmo instante, que é o que acontece na demonstração.

   · O AVISO QUE POUSA EM CIMA DO BOTÃO. Uma mensagem de erro que tapa
     exactamente o botão que a pessoa tem de voltar a carregar é pior do que
     não haver mensagem nenhuma.

   · O ARMAZENAMENTO DEPOIS DE APAGAR. «Sem volta» quer dizer que nada fica
     para trás — nem o email, que é o único dado pessoal que esta app chega a
     pedir. Por isso procura-se o email em TODAS as chaves, e não só nas que
     a app se lembrou de apagar.

   · O TEMA ANTES DA PRIMEIRA PINTURA. Guardar a escolha não chega: se ela só
     entrar depois de a página já ter pintado, quem escolheu o escuro leva
     com um clarão branco em cada abertura.

   Corre em modo de demonstração, onde o código do email é sempre 000000.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '06 · Perfil: conta, email, exportar e apagar';

const PERFIL = '.barra-item:nth-child(5)';
const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';
const LINHA_EXPORTAR = '#principal section:nth-of-type(2) .lista .linha:first-child';
const LINHA_APAGAR = '#principal .linha-perigo';
const CONFIRMAR = '#painel .btn-cheio';
const EMAIL = 'teste@exemplo.pt';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   Espiar o atributo `disabled`

   Não serve ler `botao.disabled` depois do clique: na demonstração o pedido
   resolve-se no mesmo instante e a ida e a volta ficam ambas invisíveis. O
   observador guarda a transição — `oldValue === null` é o momento em que o
   atributo nasceu (desactivou), `''` é o momento em que morreu (reactivou).
   ========================================================================= */

async function espiarBotao(palco, seletor) {
  await palco.js(`
    const n = document.querySelector(${JSON.stringify(seletor)});
    if (!n) throw new Error('não há botão ${seletor} para espiar');
    window.__desactivacoes = [];
    if (window.__espia) window.__espia.disconnect();
    window.__espia = new MutationObserver((registos) => {
      for (const r of registos) window.__desactivacoes.push(r.oldValue === null);
    });
    window.__espia.observe(n, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    return true`);
}

const idasEVoltas = (palco) => palco.js('return window.__desactivacoes || []');

const desactivado = (palco, seletor) => palco.js(
  `const n = document.querySelector(${JSON.stringify(seletor)});
   return n ? !!n.disabled : null`);

/** Quem está mesmo no ponto onde o dedo cairia. `null` = ninguém pelo meio. */
const quemTapa = (palco, seletor) => palco.js(`
  const alvo = document.querySelector(${JSON.stringify(seletor)});
  if (!alvo) return 'não existe';
  const r = alvo.getBoundingClientRect();
  const em = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (!em || em === alvo || alvo.contains(em) || em.contains(alvo)) return null;
  return em.tagName.toLowerCase() + (typeof em.className === 'string' && em.className
    ? '.' + em.className.trim().split(/\\s+/).join('.') : '');`);

/**
 * Espera que o aviso saia da frente.
 *
 * Não é um contorno do defeito de baixo — é o preço dele: enquanto o aviso
 * lá estiver, o palco recusa-se a carregar no botão que ele tapa, tal como o
 * dedo de uma pessoa não lhe chegaria. A afirmação que denuncia isto fica
 * onde está.
 */
const esperarAvisoSair = (palco) => palco.sumir('.aviso', 9000);

/** Espera que a app volte a arrancar do zero (as boas-vindas à vista). */
async function esperarRecomeco(palco, tecto = 12000) {
  const limite = Date.now() + tecto;
  for (;;) {
    const vista = await palco.visivel('#boas-vindas').catch(() => false);
    if (vista) return true;
    if (Date.now() > limite) throw new Error(`a app não recomeçou passados ${tecto} ms`);
    await dormir(120);
  }
}

export async function correr(palco, certo) {
  /* --- chegar ao perfil -------------------------------------------------- */
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra');
  await palco.clicar(PERFIL);
  await palco.esperar('#principal .identidade-numero');

  const titulo = await palco.texto('#topo-titulo');
  certo(titulo === 'Perfil', 'perfil: o topo diz «Perfil»', String(titulo));

  const numero = await palco.texto('#principal .identidade-numero');
  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(numero || ''),
    'perfil: o número de cartão são seis caracteres do alfabeto sem ambiguidades',
    String(numero));

  certo(await palco.visivel(LINHA_CONTA), 'perfil: a linha «Guardar a conta» está à vista');
  certo(await palco.visivel(LINHA_EXPORTAR), 'perfil: a linha «Descarregar os meus dados» está à vista');
  certo(await palco.visivel(LINHA_APAGAR), 'perfil: a linha de apagar está à vista');
  await palco.captura('06-perfil');

  /* --- guardar a conta: o que a app tem de recusar ------------------------ */
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#campo-email');
  certo(await palco.visivel('#botao-enviar'),
    'guardar a conta: o painel abre com o botão de enviar à vista');

  const maus = [
    ['', 'vazio'],
    ['   ', 'só espaços'],
    ['abc', 'sem arroba'],
    ['a@b', 'sem ponto no domínio'],
  ];
  for (const [valor, porque] of maus) {
    await palco.preencher('#campo-email', valor);
    await espiarBotao(palco, '#botao-enviar');
    await palco.clicar('#botao-enviar');

    certo(await palco.visivel('.aviso-mau'),
      `email ${porque}: a recusa aparece no ecrã`, `valor=«${valor}»`);
    certo(await palco.texto('.aviso-mau') === 'Esse email não parece válido.',
      `email ${porque}: a mensagem diz o que se passa`,
      String(await palco.texto('.aviso-mau')));
    /* Um email recusado nem sequer chega a ser um pedido: se o botão passasse
       por desactivado, ficaria à espera de uma volta que ninguém dá. */
    certo((await idasEVoltas(palco)).length === 0,
      `email ${porque}: o botão nem chega a ser desactivado`,
      JSON.stringify(await idasEVoltas(palco)));
    certo(await desactivado(palco, '#botao-enviar') === false,
      `email ${porque}: o botão continua a responder`, 'ficou desactivado');
    certo(await palco.ver('#campo-email'),
      `email ${porque}: o painel do email fica aberto para se corrigir`);

    await esperarAvisoSair(palco);
  }

  /* --- e o aviso tem de deixar o botão em paz ---------------------------- */
  await palco.preencher('#campo-email', 'abc');
  await palco.clicar('#botao-enviar');
  await palco.captura('06-aviso-tapa-o-botao');

  const tapa = await quemTapa(palco, '#botao-enviar');
  certo(tapa === null,
    'email recusado: o aviso não fica em cima do botão de enviar', String(tapa));

  const aviso = await palco.medir('.aviso');
  const botao = await palco.medir('#botao-enviar');
  const sobrepoe = aviso && botao
    && aviso.x < botao.x + botao.largura && aviso.x + aviso.largura > botao.x
    && aviso.y < botao.y + botao.altura && aviso.y + aviso.altura > botao.y;
  certo(!sobrepoe, 'email recusado: o aviso e o botão não se pisam',
    `aviso ${JSON.stringify(aviso)} vs botão ${JSON.stringify(botao)}`);
  /* Se o aviso deixasse passar os toques, tapar seria só feio. Não deixa. */
  certo(await palco.estilo('.aviso', 'pointer-events') === 'none',
    'email recusado: o aviso deixa passar os toques para o que está por baixo',
    String(await palco.estilo('.aviso', 'pointer-events')));
  await esperarAvisoSair(palco);

  /* --- guardar a conta: o caminho bom ------------------------------------ */
  await palco.preencher('#campo-email', EMAIL);
  await espiarBotao(palco, '#botao-enviar');
  await palco.clicar('#botao-enviar');
  await palco.esperar('#campo-codigo', 4000);

  certo(JSON.stringify(await idasEVoltas(palco)) === '[true]',
    'enviar o código: o botão desactiva-se enquanto o pedido corre',
    JSON.stringify(await idasEVoltas(palco)));
  certo(!(await palco.ver('#campo-email')),
    'enviar o código: o painel do email dá lugar ao do código');
  certo((await palco.texto('#painel')).includes('000000'),
    'enviar o código: na demonstração o painel diz qual é o código',
    String(await palco.texto('#painel')).slice(0, 100));

  /* O campo recebe o foco sozinho — senão é preciso apontar-lhe o dedo antes
     de escrever seis algarismos que já se têm na mão. */
  await dormir(300);
  const foco = await palco.focado();
  certo(!!foco && String(foco.classe).includes('campo-codigo'),
    'escrever o código: o campo recebe o foco sozinho', JSON.stringify(foco));
  await palco.captura('06-codigo');

  /* --- código curto: recusa sem chegar a pedir --------------------------- */
  await palco.escrever('#campo-codigo', '12');
  await espiarBotao(palco, CONFIRMAR);
  await palco.clicar(CONFIRMAR);
  certo(await palco.texto('.aviso-mau') === 'O código tem seis algarismos.',
    'código curto: a app diz quantos algarismos são precisos',
    String(await palco.texto('.aviso-mau')));
  certo((await idasEVoltas(palco)).length === 0,
    'código curto: o botão nem chega a ser desactivado',
    JSON.stringify(await idasEVoltas(palco)));
  await esperarAvisoSair(palco);

  /* --- código errado: o botão tem de voltar da desactivação -------------- */
  await palco.escrever('#campo-codigo', '123456');
  await espiarBotao(palco, CONFIRMAR);
  await palco.clicar(CONFIRMAR);

  certo(await palco.visivel('.aviso-mau'), 'código errado: a recusa aparece no ecrã');
  certo(await palco.texto('.aviso-mau') === 'Na demonstração o código é 000000.',
    'código errado: a mensagem diz o que se passa',
    String(await palco.texto('.aviso-mau')));
  certo(JSON.stringify(await idasEVoltas(palco)) === '[true,false]',
    'código errado: o botão desactiva-se e volta a ficar activo',
    JSON.stringify(await idasEVoltas(palco)));
  certo(await desactivado(palco, CONFIRMAR) === false,
    'código errado: dá para tentar outra vez', 'o botão ficou morto');
  await esperarAvisoSair(palco);

  /* --- o campo só aceita algarismos -------------------------------------- */
  await palco.escrever('#campo-codigo', 'ab12cd');
  certo(await palco.valor('#campo-codigo') === '12',
    'escrever o código: o campo deita fora o que não é algarismo',
    String(await palco.valor('#campo-codigo')));

  /* --- «não recebi»: na demonstração não há email nenhum a sair ---------- */
  await palco.clicar('#painel .btn-fantasma');
  const reenvio = await palco.texto('.aviso');
  certo(!!reenvio && !/Enviámos/i.test(reenvio),
    'reenviar na demonstração: a app não pode dizer que enviou o que não enviou',
    String(reenvio));
  await esperarAvisoSair(palco);

  /* --- código certo ------------------------------------------------------ */
  await palco.escrever('#campo-codigo', '000000');
  await palco.clicar(CONFIRMAR);
  await palco.sumir('#painel', 4000);

  certo(await palco.texto('.aviso-bom') === 'Conta guardada. Os cartões já não se perdem.',
    'código certo: a app confirma', String(await palco.texto('.aviso-bom')));
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes(EMAIL),
    'código certo: o perfil passa a mostrar o email guardado',
    String(await palco.texto(LINHA_CONTA)));

  /* --- e aguenta-se depois de recarregar --------------------------------- */
  await palco.recarregar();
  await palco.esperar('#barra');
  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes(EMAIL),
    'depois de recarregar: o email continua guardado',
    String(await palco.texto(LINHA_CONTA)));

  /* =======================================================================
     Tema
     ======================================================================= */

  /* O sistema fica em claro de propósito: é o caso em que a escolha da pessoa
     discorda do telemóvel, e o único em que o clarão da abertura se vê. */
  await palco.tema('light');

  const temaGuardado = () => palco.js("return localStorage.getItem('carimbo-demo:tema')");
  const temaNoHtml = () => palco.js('return document.documentElement.dataset.tema || null');

  certo(await temaNoHtml() === null,
    'tema: à partida segue o sistema, sem marca no html', String(await temaNoHtml()));

  await palco.clicar('#botao-tema');
  certo(await temaNoHtml() === 'claro',
    'tema: o primeiro toque fixa o claro', String(await temaNoHtml()));

  await palco.clicar('#botao-tema');
  certo(await temaNoHtml() === 'escuro',
    'tema: o segundo toque fixa o escuro', String(await temaNoHtml()));
  certo(await temaGuardado() === '"escuro"',
    'tema: a escolha fica guardada', String(await temaGuardado()));

  const fundoEscuro = await palco.estilo('body', 'background-color');
  certo(fundoEscuro.replace(/\s/g, '') === 'rgb(14,13,18)',
    'tema: o fundo escurece mesmo', String(fundoEscuro));

  /* Espia a primeira pintura da recarga. O guião entra antes de qualquer
     coisa da página — é a única forma de saber se o tema chegou a tempo, e
     usa o mesmo canal do palco. */
  await palco.enviar('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__pintura = { tema: null, frame: null, fundo: null };
      /* Observa-se o documento e não o <html>: quando isto corre ainda não há
         elemento nenhum, e observar null rebenta. */
      new MutationObserver(() => {
        if (document.documentElement && document.documentElement.dataset.tema
            && window.__pintura.tema === null) {
          window.__pintura.tema = performance.now();
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-tema'] });
      requestAnimationFrame(() => {
        window.__pintura.frame = performance.now();
        window.__pintura.fundo = document.body
          ? getComputedStyle(document.body).backgroundColor : null;
      });`,
  }, palco.sessao);

  await palco.recarregar();
  await palco.esperar('#barra');
  certo(await temaNoHtml() === 'escuro',
    'tema: a escolha aguenta-se depois de recarregar', String(await temaNoHtml()));

  const pintura = await palco.js('return window.__pintura');
  certo(!!pintura && pintura.tema !== null && pintura.frame !== null
    && pintura.tema <= pintura.frame,
    'tema: o escuro entra antes da primeira pintura, sem clarão branco',
    JSON.stringify(pintura));

  /* Terceiro toque: volta ao sistema, e o ciclo fecha. */
  await palco.clicar('#botao-tema');
  certo(await temaNoHtml() === null,
    'tema: o terceiro toque devolve a escolha ao sistema', String(await temaNoHtml()));

  /* =======================================================================
     Exportar os dados
     ======================================================================= */

  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_EXPORTAR);

  /* Não dá para abrir o ficheiro que o browser descarrega — mas dá para
     apanhar o Blob no caminho e ler-lhe o conteúdo. */
  await palco.js(`
    window.__blobs = [];
    window.__descargas = [];
    if (!window.__criarOriginal) {
      window.__criarOriginal = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__blobs.push(b); return window.__criarOriginal(b); };
      window.__cliqueOriginal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        window.__descargas.push(this.getAttribute('download'));
        return window.__cliqueOriginal.apply(this, arguments);
      };
    }
    return true`);

  await palco.clicar(LINHA_EXPORTAR);
  await dormir(400);

  const ficheiro = await palco.js(`
    const b = window.__blobs[0];
    if (!b) return { quantos: window.__blobs.length };
    const cru = await b.text();
    let d = null;
    try { d = JSON.parse(cru); } catch (e) { return { erro: e.message }; }
    return {
      quantos: window.__blobs.length, tipo: b.type, tamanho: b.size,
      cartoes: Array.isArray(d.cartoes) ? d.cartoes.length : -1,
      movimentos: Array.isArray(d.movimentos) ? d.movimentos.length : -1,
      email: d.cliente ? d.cliente.email : null,
      publico: d.cliente ? d.cliente.publico : null,
      temSegredo: /segredo|secret/i.test(cru),
      nomes: window.__descargas,
    }`);

  certo(ficheiro.quantos === 1,
    'exportar: a app pede exactamente um endereço de ficheiro ao browser',
    JSON.stringify(ficheiro));
  certo(ficheiro.tipo === 'application/json' && ficheiro.tamanho > 200,
    'exportar: o ficheiro é JSON e tem conteúdo',
    `${ficheiro.tipo}, ${ficheiro.tamanho} bytes`);
  certo(String(ficheiro.nomes && ficheiro.nomes[0]) === 'carimbo-digital-os-meus-dados.json',
    'exportar: o ficheiro descarrega com um nome que se percebe',
    JSON.stringify(ficheiro.nomes));
  certo(ficheiro.email === EMAIL && ficheiro.publico === numero,
    'exportar: lá dentro está mesmo esta conta',
    `${ficheiro.email} / ${ficheiro.publico} (esperava ${EMAIL} / ${numero})`);
  certo(ficheiro.cartoes === 5 && ficheiro.movimentos > 20,
    'exportar: leva os cartões e o histórico todo',
    `${ficheiro.cartoes} cartões, ${ficheiro.movimentos} movimentos`);
  certo(ficheiro.temSegredo === false,
    'exportar: o segredo do aparelho não sai no ficheiro');
  certo(await palco.texto('.aviso-bom') === 'Ficheiro descarregado.',
    'exportar: a app diz que o ficheiro saiu', String(await palco.texto('.aviso-bom')));
  await esperarAvisoSair(palco);

  /* =======================================================================
     Apagar a conta
     ======================================================================= */

  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-perigo');
  certo((await palco.texto('#painel')).includes('Não há forma de recuperar'),
    'apagar: o painel avisa que não há volta',
    String(await palco.texto('#painel')).slice(0, 100));

  /* «Afinal não» tem de ser mesmo não. */
  await palco.clicar('#painel .btn-fantasma');
  await palco.sumir('#painel', 3000);
  certo(await palco.ver(LINHA_APAGAR),
    'apagar: o «Afinal não» fecha o painel e devolve o perfil');
  certo(await palco.js("return localStorage.getItem('carimbo-demo:cliente') !== null"),
    'apagar: depois do «Afinal não» a conta continua lá');

  /* E a tecla de fuga também fecha. */
  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel');
  await palco.tecla('Escape');
  await palco.sumir('#painel', 3000);
  certo(!(await palco.ver('#painel')), 'apagar: a tecla Escape fecha o painel');

  await palco.clicar(LINHA_APAGAR);
  await palco.esperar('#painel .btn-perigo');
  await palco.captura('06-apagar');
  await palco.clicar('#painel .btn-perigo');
  await esperarRecomeco(palco);

  certo(await palco.visivel('#boas-vindas'),
    'apagar: a app recomeça do princípio, como num telemóvel novo');

  const caixa = await palco.armazenamento();
  const chaves = Object.keys(caixa);
  for (const chave of ['carimbo-demo:cliente', 'carimbo-demo:sessao',
                       'carimbo-demo:visto-bv', 'carimbo-demo:desvio']) {
    certo(!(chave in caixa), `apagar: «${chave}» desapareceu do armazenamento`,
      String(caixa[chave]).slice(0, 60));
  }

  /* O email é o único dado pessoal que esta app chega a pedir: se sobreviver
     numa chave qualquer, «sem volta» não é verdade. */
  const ondeEstaOEmail = chaves.filter((k) => String(caixa[k]).includes(EMAIL));
  certo(ondeEstaOEmail.length === 0,
    'apagar: o email não sobra em chave nenhuma do armazenamento',
    ondeEstaOEmail.join(', '));

  const sobras = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    return { clientes: (e.clientes || []).length, cartoes: (e.cartoes || []).length,
             movimentos: (e.movimentos || []).length, premios: (e.premios || []).length }`);
  certo(sobras.clientes === 0 && sobras.cartoes === 0
    && sobras.movimentos === 0 && sobras.premios === 0,
    'apagar: não sobram clientes, cartões, movimentos nem prémios',
    JSON.stringify(sobras));

  /* O segredo do aparelho vive no cofre de IndexedDB, fora do localStorage —
     é ele que assina os pedidos, e tem de sair com o resto. */
  const segredo = await palco.js(`
    const bd = await new Promise((ok, mal) => {
      const p = indexedDB.open('carimbo', 1);
      p.onsuccess = () => ok(p.result); p.onerror = () => mal(p.error);
    });
    const v = await new Promise((ok) => {
      const t = bd.transaction('chaves', 'readonly').objectStore('chaves').get('segredo-demo');
      t.onsuccess = () => ok(t.result === undefined ? null : 'ainda lá está');
      t.onerror = () => ok(null);
    });
    bd.close();
    return v`);
  certo(segredo === null, 'apagar: o segredo do aparelho sai do cofre', String(segredo));
}
