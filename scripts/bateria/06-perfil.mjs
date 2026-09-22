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

import { entrarNaApp } from './01-arranque.mjs';

export const nome = '06 · Perfil: conta, email, exportar e apagar';

const PERFIL = '.barra-item[data-ecra="perfil"]';
const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';
/* Pelo nome e não pela posição. Esta constante dizia «a primeira linha da
   segunda secção», e no dia em que as «Definições» entraram entre a «Conta» e
   «Os meus dados» passou a apontar para o «Aspecto» — sem falhar nada, porque
   a primeira linha da segunda secção existe sempre, seja ela qual for. Um
   selector posicional não se queixa quando o que está à volta muda de sítio. */
const LINHA_EXPORTAR = '#linha-exportar';
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
  /* ENTRA-SE PELA GOOGLE, e não pelo email. Este módulo prova o caminho de
     JUNTAR um email a uma conta — e quem entrasse por email já cá chegava com
     um, por isso o painel mostrava «Como entras nesta conta» em vez do campo.
     A conta que interessa a este módulo é a que ainda não tem morada. */
  await entrarNaApp(palco, { porta: 'google' });
  await palco.esperar('#barra .barra-item');
  await palco.clicar(PERFIL);
  await palco.esperar('#principal .identidade-numero');

  const titulo = await palco.texto('#topo-titulo');
  certo(titulo === 'Perfil', 'perfil: o topo diz «Perfil»', String(titulo));

  const numero = await palco.texto('#principal .identidade-numero');
  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(numero || ''),
    'perfil: o número de cartão são seis caracteres do alfabeto sem ambiguidades',
    String(numero));

  certo(await palco.visivel(LINHA_CONTA), 'perfil: a linha «Guardar a conta» está à vista');

  /* A ORIGEM. Quem instala a app nunca mais vê o rodapé do site, e este é o
     ecrã onde se vai ver quem está do outro lado — a linha é a única coisa
     que o diz aqui dentro. Sem afirmação, desaparecia num refazer do perfil e
     ninguém dava por isso; e o site tem uma guarda para a mesma frase no
     auditor, que não alcança um rodapé pintado por JavaScript.

     A segunda metade é tão importante como a primeira: a frase tem de ser
     TEXTO. Um `<img>` ou um `<svg>` aqui seria um crachá, e exibir uma marca
     de certificação sem autorização é enganoso em qualquer circunstância
     (DL 57/2008, art. 8.º, b). */
  const rodapeApp = await palco.js(`
    const p = document.querySelector('.rodape-app');
    if (!p) return null;
    return { texto: p.textContent.replace(/\\s+/g, ' ').trim(),
             imagens: p.querySelectorAll('img, svg, picture').length }`);
  certo(Boolean(rodapeApp) && /Carimbo Digital, marca portuguesa/.test(rodapeApp.texto),
    'perfil: o rodapé da app diz que marca é esta',
    rodapeApp ? rodapeApp.texto : 'não há rodapé');
  /* EM MINÚSCULAS E COM VÍRGULA, e a guarda tem de exigir as duas coisas. Em
     caixa de título e separado por um ponto médio, «Marca Portuguesa» lê-se
     como o nome de um esquema a que se pertence — e o artigo 22.º do
     DL 57/2008 deixa as autoridades exigir prova da «exactidão material». Como
     descrição, o que há a provar é quem presta e onde reside. Como nome, o que
     pediriam era o esquema, e esse não existe. */
  certo(Boolean(rodapeApp) && !/Marca Portuguesa/.test(rodapeApp.texto),
    'perfil: a origem está escrita como descrição, e não como nome de um selo',
    rodapeApp ? rodapeApp.texto : 'não há rodapé');
  certo(Boolean(rodapeApp) && rodapeApp.imagens === 0,
    'perfil: a origem é texto, e não um emblema',
    rodapeApp ? `${rodapeApp.imagens} imagens` : 'não há rodapé');
  /* E AGORA A LINHA DE EXPORTAR CAIU TAMBÉM, pela mesma razão e pela segunda
     vez: o perfil voltou a crescer, agora com as «Definições». A afirmação
     que interessa não é «está à vista» — é quanto se tem de deslizar para lá
     chegar, porque é isso que decide se alguém chega. O artigo 20.º do RGPD
     não exige um botão na dobra, mas um botão a três ecrãs de distância é um
     botão que ninguém carrega. Um ecrã de deslize é o tecto. */
  const dobra = await palco.js('return innerHeight');
  const alcance = await palco.medir(LINHA_EXPORTAR);
  certo(Boolean(alcance) && alcance.y < dobra * 2,
    'perfil: chega-se a «Descarregar os meus dados» com um deslize, não com três',
    alcance ? `y=${Math.round(alcance.y)} dobra=${dobra}` : 'não medida');
  /* A LINHA DE APAGAR CAIU ABAIXO DA DOBRA, e isto afirmava que estava «à
     vista». Caiu porque o perfil cresceu — os avisos entraram — e não porque
     alguém a escondesse. Para a mais destrutiva de todas as acções, estar em
     último e obrigar a um deslize é o sítio certo: o que se prova é que se
     CHEGA lá, e que fica depois das que não fazem mal a ninguém. */
  const yApagar = await palco.medir(LINHA_APAGAR);
  const yExportar = await palco.medir(LINHA_EXPORTAR);
  certo(Boolean(yApagar) && Boolean(yExportar) && yApagar.y > yExportar.y,
    'perfil: a linha de apagar fica em último, depois das que não têm volta atrás',
    yApagar && yExportar ? `apagar=${Math.round(yApagar.y)} exportar=${Math.round(yExportar.y)}` : 'não medida');
  await palco.js(`document.querySelector('#principal .linha-perigo')
    .scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 350)); return true`);
  certo(await palco.visivel(LINHA_APAGAR),
    'perfil: e chega-se a ela com um deslize — não está presa fora do ecrã');
  await palco.captura('06-perfil');
  await palco.js(`window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250)); return true`);

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

  /* --- COLAR A LINHA DO EMAIL -------------------------------------------- */
  /* Isto esteve PARTIDO e ninguém desconfiaria: o `maxlength="6"` corta a
     colagem ANTES de qualquer limpeza nossa. Colar «Código: 314 159» — que é o
     gesto natural de quem tem o email aberto ao lado — deixava no campo a
     palavra `Código` e zero algarismos, e a app respondia «O código tem seis
     algarismos», que é verdade e não ajuda nada.

     Mede-se com uma colagem A SÉRIO (`insertText`), e não escrevendo o valor à
     mão: escrever à mão nunca passaria pelo `maxlength`, e o teste passava
     enquanto o defeito continuava lá. */
  certo(await palco.js(`
    return document.querySelector('#campo-codigo').getAttribute('maxlength') === null`),
    'colar o código: o maxlength sai do campo — é ele que corta a colagem antes de a limpar');

  /* --- NÃO SE LÊ A ÁREA DE TRANSFERÊNCIA ---------------------------------
     Esteve cá dentro um dia, para o campo se preencher sozinho a quem já
     tivesse copiado o código. No iPhone, `navigator.clipboard.readText()` faz
     aparecer um botão «Paste» do sistema que fica PARADO por cima do ecrã à
     espera de um toque — e quem não perceber o que aquilo é não chega sequer
     ao campo do código. Relatado de um iPhone a sério, com estas palavras:
     «bloqueia o ecrã e não passa para a parte de inserir o código».

     Deixou de ser preciso, que é o que torna a remoção fácil: com a palavra
     «código» encostada aos algarismos no email, o teclado do telemóvel já
     oferece o código. Uma conveniência que atravessa o caminho de quem a não
     quer é pior do que não existir.

     Esta afirmação existe para ninguém a repor sem pensar — eu incluído. */
  const espiou = await palco.js(`
    let chamou = false;
    const real = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { chamou = true; return '314159'; },
      writeText: async () => {},
    } });
    /* Fecha o painel e volta a abrir, que é quando a leitura acontecia.

       OS DOIS SELECTORES ANTIGOS NÃO EXISTIAM: eram .painel-fecho e
       #painel-fundo, e o painel tem .painel-veu e .painel-pega. Aquela linha
       não fechava nada há muito tempo, e o #campo-codigo que se lia a seguir
       era o do painel que nunca chegou a ser substituído. A afirmação passava
       por acidente, que é o pior modo de uma afirmação passar.
       (Sem crases: isto vive dentro de um template literal, e uma crase aqui
       fecha-o. Mesma armadilha, segunda vez no mesmo dia.)

       E a linha reabre-se pelo SELECTOR e não pelo texto: o texto daquela
       linha tem agora quatro grafias, conforme as portas ligadas. */
    document.querySelector('#painel .painel-veu')?.click();
    await new Promise((r) => setTimeout(r, 300));
    if (document.querySelector('#painel')) throw new Error('o painel não fechou');
    document.querySelector('#principal section:first-of-type .lista .linha:first-child')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const e = document.querySelector('#campo-email');
    if (e) { e.value = ${JSON.stringify('teste@exemplo.pt')}; e.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('#botao-enviar')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const valor = document.querySelector('#campo-codigo')?.value ?? null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: real });
    return { chamou, valor };`);
  certo(espiou.chamou === false,
    'NÃO se lê a área de transferência — no iPhone abre um «Paste» que fica parado por cima do ecrã',
    JSON.stringify(espiou));
  certo(espiou.valor === '',
    'e o campo fica vazio à espera do teclado, em vez de se preencher por conta própria',
    JSON.stringify(espiou.valor));

  for (const [nome, texto, esperado] of [
    ['a linha inteira do email', 'Código: 314 159', '314159'],
    ['com espaço a meio', '31 41 59', '314159'],
    ['com hífen', '314-159', '314159'],
    ['uma frase à volta', 'O teu código é 271828, vale 15 minutos', '271828'],
  ]) {
    const ficou = await palco.js(`
      const c = document.querySelector('#campo-codigo');
      c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true }));
      c.focus();
      document.execCommand('insertText', false, ${JSON.stringify(texto)});
      return c.value;`);
    certo(ficou === esperado,
      `colar ${nome}: fica ${esperado} no campo`, `ficou «${ficou}»`);

    /* CHEGAR AOS SEIS ALGARISMOS CONFIRMA SOZINHO — é para isso que serve — e
       isso fecha ou muda o painel. Cada caso tem de voltar a pô-lo de pé,
       senão o que se mede a seguir é o estado deixado pelo caso anterior. E o
       resto deste módulo continua daqui, a contar com o painel aberto. */
    await esperarAvisoSair(palco).catch(() => {});
    if (!(await palco.ver('#campo-codigo'))) {
      await palco.clicar(LINHA_CONTA);
      await palco.esperar('#campo-email', 4000);
      await palco.preencher('#campo-email', EMAIL);
      await palco.clicar('#botao-enviar');
      await palco.esperar('#campo-codigo', 4000);
    }
  }

  /* E PROVA-SE QUE O AUTO-CONFIRMAR DISPARA MESMO. Sem isto, tudo o que está
     acima passava na mesma se ele nunca acontecesse — o ciclo só mede o que
     FICA no campo, e o campo fica igual quer o botão seja tocado quer não.

     Mede-se pelo efeito que só o envio produz: 314159 é um código errado na
     demonstração, e um código errado põe um aviso no ecrã. Se ninguém tiver
     confirmado, não há aviso nenhum. */
  await palco.js(`
    const c = document.querySelector('#campo-codigo');
    c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true }));
    c.focus(); document.execCommand('insertText', false, '314159');
    return true;`);
  const avisoSozinho = await palco.texto('.aviso').catch(() => null);
  certo(!!avisoSozinho,
    'seis algarismos confirmam SOZINHOS — ninguém tocou no botão e a app já respondeu',
    `aviso: ${JSON.stringify(avisoSozinho)}`);
  await esperarAvisoSair(palco).catch(() => {});
  if (!(await palco.ver('#campo-codigo'))) {
    await palco.clicar(LINHA_CONTA);
    await palco.esperar('#campo-email', 4000);
    await palco.preencher('#campo-email', EMAIL);
    await palco.clicar('#botao-enviar');
    await palco.esperar('#campo-codigo', 4000);
  }

  /* --- «não recebi»: na demonstração não há email nenhum a sair ---------- */
  await palco.clicar('#painel .btn-fantasma');
  const reenvio = await palco.texto('.aviso');
  certo(!!reenvio && !/Enviámos/i.test(reenvio),
    'reenviar na demonstração: a app não pode dizer que enviou o que não enviou',
    String(reenvio));
  await esperarAvisoSair(palco);

  /* --- código certo ------------------------------------------------------ */
  /* JÁ NÃO SE CARREGA EM CONFIRMAR, e é essa a mudança: o sexto algarismo
     confirma sozinho. Esta linha tinha um `clicar(CONFIRMAR)` a seguir, e foi
     ele que rebentou o módulo quando o auto-confirmar entrou — o painel já
     tinha fechado e o botão não existia. Deixá-lo lá «por segurança» seria
     esconder a funcionalidade nova atrás de um gesto que ninguém faz. */
  await palco.escrever('#campo-codigo', '000000');
  await palco.sumir('#painel', 4000);

  certo(await palco.texto('.aviso-bom') === 'Conta guardada. Os cartões já não se perdem.',
    'código certo: a app confirma', String(await palco.texto('.aviso-bom')));
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes(EMAIL),
    'código certo: o perfil passa a mostrar o email guardado',
    String(await palco.texto(LINHA_CONTA)));

  /* --- e aguenta-se depois de recarregar --------------------------------- */
  await palco.recarregar();
  await palco.esperar('#barra .barra-item');
  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes(EMAIL),
    'depois de recarregar: o email continua guardado',
    String(await palco.texto(LINHA_CONTA)));

  /* =======================================================================
     Tema — agora em Perfil › Definições › Aspecto

     Havia um botão no cabeçalho que ciclava claro → escuro → sistema. Três
     estados atrás de um ícone que só sabia desenhar dois, e sem nome nenhum:
     quem não via o ecrã nunca soube que existia um «automático». Passou a ser
     um radiogroup com os três estados escritos, e estas afirmações percorrem
     o caminho que a pessoa percorre — abrir o perfil, abrir o painel, tocar.
     ======================================================================= */

  /* O sistema fica em claro de propósito: é o caso em que a escolha da pessoa
     discorda do telemóvel, e o único em que o clarão da abertura se vê. */
  await palco.tema('light');

  const temaGuardado = () => palco.js("return localStorage.getItem('carimbo-demo:tema')");
  const temaNoHtml = () => palco.js('return document.documentElement.dataset.tema || null');

  certo(await temaNoHtml() === null,
    'tema: à partida segue o sistema, sem marca no html', String(await temaNoHtml()));

  await palco.clicar(PERFIL);
  await palco.esperar('#linha-aspecto');
  certo((await palco.texto('#estado-aspecto')).trim() === 'Automático',
    'aspecto: a linha do perfil diz em que estado está, sem ser preciso abrir',
    String(await palco.texto('#estado-aspecto')));

  await palco.clicar('#linha-aspecto');
  await palco.esperar('[data-tema-opcao]');

  const opcoes = () => palco.js(`
    return [...document.querySelectorAll('[data-tema-opcao]')].map((b) => ({
      chave: b.dataset.temaOpcao,
      nome: b.querySelector('b').textContent.trim(),
      marcado: b.getAttribute('aria-checked'),
      papel: b.getAttribute('role'),
    }))`);

  const trio = await opcoes();
  certo(trio.length === 3 && trio.map((o) => o.chave).join(',') === 'claro,escuro,sistema',
    'aspecto: os três estados têm nome escrito, e o automático vai em último',
    trio.map((o) => o.nome).join(' · '));
  /* A falha que o botão tinha e que ninguém via: com três estados e um ícone
     de dois, havia sempre um estado sem representação. Aqui a exclusividade é
     uma afirmação — exactamente um marcado, nunca zero e nunca dois. */
  certo(trio.filter((o) => o.marcado === 'true').length === 1,
    'aspecto: há sempre um e um só estado marcado',
    trio.map((o) => `${o.nome}=${o.marcado}`).join(' '));
  certo(trio.find((o) => o.chave === 'sistema').marcado === 'true',
    'aspecto: e à nascença o marcado é o automático',
    trio.map((o) => `${o.nome}=${o.marcado}`).join(' '));
  certo(trio.every((o) => o.papel === 'radio'),
    'aspecto: cada opção anuncia-se como escolha exclusiva e não como botão solto',
    trio.map((o) => o.papel).join(','));

  await palco.clicar('[data-tema-opcao="claro"]');
  certo(await temaNoHtml() === 'claro',
    'aspecto: escolher o claro fixa-o no html', String(await temaNoHtml()));
  /* Sem botão de guardar: a confirmação é o próprio resultado. Se a marca não
     saltasse no mesmo toque, o painel ficava a mostrar o estado anterior. */
  certo((await opcoes()).filter((o) => o.marcado === 'true').map((o) => o.chave).join() === 'claro',
    'aspecto: a marca salta no mesmo toque, sem botão de guardar',
    JSON.stringify(await opcoes()));

  await palco.clicar('[data-tema-opcao="escuro"]');
  certo(await temaNoHtml() === 'escuro',
    'aspecto: e escolher o escuro troca', String(await temaNoHtml()));
  certo(await temaGuardado() === '"escuro"',
    'aspecto: a escolha fica guardada', String(await temaGuardado()));

  const fundoEscuro = await palco.estilo('body', 'background-color');
  certo(fundoEscuro.replace(/\s/g, '') === 'rgb(14,13,18)',
    'aspecto: o fundo escurece mesmo', String(fundoEscuro));

  /* O painel fecha, e a linha por trás tem de contar a mesma história. Um
     ecrã que mostra o estado errado é pior do que um que não o mostra. */
  await palco.tecla('Escape');
  await palco.sumir('#painel');
  certo((await palco.texto('#estado-aspecto')).trim() === 'Escuro',
    'aspecto: fechado o painel, a linha do perfil já diz «Escuro»',
    String(await palco.texto('#estado-aspecto')));

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
  await palco.esperar('#barra .barra-item');
  certo(await temaNoHtml() === 'escuro',
    'aspecto: a escolha aguenta-se depois de recarregar', String(await temaNoHtml()));

  const pintura = await palco.js('return window.__pintura');
  certo(!!pintura && pintura.tema !== null && pintura.frame !== null
    && pintura.tema <= pintura.frame,
    'aspecto: o escuro entra antes da primeira pintura, sem clarão branco',
    JSON.stringify(pintura));

  /* Devolver ao automático fecha o ciclo — e prova que se pode SAIR de uma
     escolha fixa, que é o que o ícone de dois estados nunca deixou dizer. */
  await palco.clicar(PERFIL);
  await palco.esperar('#linha-aspecto');
  await palco.clicar('#linha-aspecto');
  await palco.esperar('[data-tema-opcao]');
  await palco.clicar('[data-tema-opcao="sistema"]');
  certo(await temaNoHtml() === null,
    'aspecto: o automático devolve a escolha ao telemóvel e tira a marca do html',
    String(await temaNoHtml()));
  await palco.tecla('Escape');
  await palco.sumir('#painel');

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
                       'carimbo-demo:visto-bv', 'carimbo-demo:desvio',
                       /* Estas três entraram depois, e as três tinham
                          sobrevivido ao apagamento: a lista de CARTÕES leva os
                          nomes dos cafés e os carimbos de cada um, as
                          IDENTIDADES levam a morada, e o BILHETE é uma entrada
                          por concluir. Nenhuma delas estava nesta lista porque
                          nenhuma existia quando ela foi escrita. */
                       'carimbo-demo:cartoes', 'carimbo-demo:identidades',
                       'carimbo-demo:entrada-google']) {
    certo(!(chave in caixa), `apagar: «${chave}» desapareceu do armazenamento`,
      String(caixa[chave]).slice(0, 60));
  }

  /* E A REGRA GERAL, para não ser preciso lembrar-se de acrescentar à lista
     acima de cada vez que nasce uma chave: depois de apagar, a app é um
     telemóvel novo.

     Três excepções, e as três são o que são: o TEMA é uma preferência do
     aparelho e não um dado da conta — quem apaga a conta não pediu para o ecrã
     voltar a branco; o `modo-demo` é o interruptor da demonstração; e o
     `carimbo-demo:demo` é o SERVIDOR da demonstração, o lugar onde uma
     demonstração sem rede guarda o que o D1 guardaria — o que lá está por
     dentro é coberto pelas duas afirmações a seguir. */
  const restosDaConta = chaves.filter((k) => k.startsWith('carimbo')
    && !k.endsWith(':tema') && k !== 'carimbo:modo-demo' && k !== 'carimbo-demo:demo');
  certo(restosDaConta.length === 0,
    'apagar: não sobra chave nenhuma da conta no armazenamento do telemóvel',
    restosDaConta.join(', '));

  /* E o servidor da demonstração também não guarda a conta apagada. É o que a
     app promete em remoto e o que o Worker cumpre — a demonstração não pode
     ensinar outra coisa. */
  const dentroDaDemo = String(caixa['carimbo-demo:demo'] || '');
  certo(!dentroDaDemo.includes(EMAIL),
    'apagar: o servidor da demonstração também deixou de ter a morada');

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
