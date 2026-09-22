/* =========================================================================
   Carimbo Digital — aplicação do cliente
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes, prepararCampoDeCodigo,
  guardarNoSeparador, lerDoSeparador, foiRecarregamento,
  pintarCartao, haQuanto, dataCurta, horas, manterEcraAceso, seguro,
  prenderFoco, colunas, carteiraProvavel, eSafari,
} from '../js/nucleo.js';
import { api, MODO, DEMO_FORCADO, CRACHA_APPLE, gerarCodigo, JANELA, guardarSegredo,
         temSegredo, esquecerSegredo, guardarDesvio } from '../js/api.js';
import { qrParaSVG } from '../js/qr.js';
/* O MAPA SAIU DA APP DO CLIENTE com o ecrã «Descobrir». Ele NÃO era do
   Descobrir — vive em `js/mapa.js` e o balcão importa-o para o painel «Onde
   fica», por isso continua publicado e continua no casco que o balcão guarda
   para abrir sem rede. O que mudou é que a app do cliente deixou de o
   carregar: são 100 KB de fronteiras de concelhos que ela já não desenha. */

const estado = {
  cliente: null,
  cartoes: [],
  /* AS FORMAS DE ENTRAR NESTA CONTA — email, Google. A app decidia tudo por
     `cliente.email`, e isso deixou de chegar no dia em que houve uma segunda
     porta: quem entra pela Google tem o `email` a NULL, de propósito. Vem do
     `/v1/cliente/eu` e fica também em `localStorage`, porque o ecrã da sessão
     terminada precisa dela quando já não há sessão para a ir buscar. */
  identidades: [],
  ecra: 'carteira',
  cartaoAberto: null,
  /* QUAL DOS CARTÕES DO BARALHO ESTÁ ABERTO — um, ou nenhum. Vive no estado e
     não no DOM porque a carteira repinta-se por tudo e por nada (um carimbo
     novo, um prémio levantado, uma volta ao separador), e um cartão que se
     fecha sozinho a cada repintura é a app a desfazer o que a pessoa fez. */
  cartaoExpandido: null,
  /* Sobe a cada pintura. Serve para uma pintura lenta saber que já não é a
     que está no ecrã e desistir em silêncio, em vez de assentar por cima da
     seguinte. */
  geracao: 0,
};


/* =========================================================================
   Peças do cartão
   ========================================================================= */

function grelhaCarimbos(cartao, { novos = 0 } = {}) {
  const p = cartao.programa;
  const total = p.objetivo;
  const cheios = cartao.carimbos;
  const cols = colunas(total);
  const grelha = el('div', {
    class: 'carimbos',
    estilo: { '--colunas': String(cols) },
    role: 'img',
    'aria-label': `${cheios} de ${total} carimbos`,
  });
  grelha.dataset.denso = total > 12 ? 'sim' : 'nao';
  for (let i = 0; i < total; i++) {
    const cheio = i < cheios;
    /* Cada carimbo cheio ganha uma inclinação pequena e estável — depende do
       índice, não do acaso, para não dançar a cada desenho. */
    const inclina = cheio ? ((i * 37) % 9) - 4 : 0;
    const peca = el('div', {
      class: 'carimbo',
      estilo: { '--inclina': `${inclina}deg` },
      /* O MESMO DESENHO NOS DOIS ESTADOS, e é de propósito: o que distingue
         um carimbo dado de uma casa vazia é o `data-estado` e o que o CSS faz
         com ele — disco cheio contra aro tracejado. Estava escrito como um
         ternário com os dois ramos iguais, o que fazia parecer que um deles
         estava por acabar. */
      html: icone(p.selo, { tipo: 'cheio', tamanho: 24 }),
    });
    peca.dataset.estado = cheio ? 'cheio' : 'vazio';
    if (novos && i >= cheios - novos && i < cheios) peca.dataset.novo = 'sim';
    grelha.append(peca);
  }
  return grelha;
}

/**
 * O painel que substitui a grelha quando há um prémio à espera.
 *
 * Mostrar uma grelha vazia com o rótulo «pronto a levantar» — que é o que
 * acontece quando os carimbos voltam a zero — é a pior das duas coisas: não
 * celebra nada e ainda parece que se perdeu o progresso. Aqui o cartão pára
 * tudo e diz o que interessa; a grelha do ciclo seguinte volta a aparecer
 * assim que o prémio for entregue.
 */
function painelPronto(cartao) {
  const p = cartao.programa;
  const premio = cartao.premios[0];
  const painel = el('div', { class: 'pronto' },
    el('span', { class: 'pronto-icone', html: icone('presente', { tamanho: 22 }) }),
    el('span', { class: 'pronto-texto' },
      el('b', { texto: premio ? premio.descricao : p.premio }),
      el('span', { texto: cartao.porResgatar > 1
        ? `${cartao.porResgatar} prémios à espera` : 'Mostra o código no balcão' })));

  const caixa = el('div', {}, painel);

  /* LEVANTAR O PRÉMIO, a um toque e sem abrir o cartão.

     O prémio já aparecia aqui — o que faltava era o gesto. O cliente mostrava
     o MESMO código de sempre, que só sabe dizer quem ele é, e do outro lado a
     câmara do balcão só sabia carimbar: ou levava um carimbo que não pediu, ou
     batia no arrefecimento e ficava tudo parado.

     Agora o código muda de prefixo — `R1.` em vez de `C1.` — e o balcão, ao
     apontar a mesma câmara, abre o painel de entrega em vez do de carimbo. A
     escolha é de quem tem tempo: o cliente, na fila, com o cartão à frente.

     A tira está FORA do cartão que expande, de propósito: com fila à espera,
     levantar um prémio não pode custar dois toques. */
  if (cartao.porResgatar) {
    caixa.append(el('button', {
      class: 'btn btn-cheio btn-bloco levantar', style: 'margin-top:12px',
      html: icone('presente', { tamanho: 18 })
        + `<span>${cartao.porResgatar === 1 ? 'Levantar prémio'
            : `Levantar ${cartao.porResgatar} prémios`}</span>`,
      aoClick: (ev) => {
        /* O cartão inteiro é tocável e leva ao ecrã dele: sem isto, tocar no
           botão fazia as duas coisas. */
        ev.stopPropagation();
        abrirCodigo({ resgate: true, premio: premio || null });
      },
    }));
  }

  /* Já começou o cartão seguinte? Diz-se, mas em voz baixa. */
  if (p.tipo !== 'pontos' && cartao.carimbos > 0) {
    const pontos = el('span', { class: 'recomeco-pontos' });
    for (let i = 0; i < p.objetivo; i++) {
      const pt = el('span', { class: 'recomeco-ponto' });
      pt.dataset.cheio = i < cartao.carimbos ? 'sim' : 'nao';
      pontos.append(pt);
    }
    caixa.append(el('div', { class: 'recomeco' },
      pontos,
      el('span', { texto: `e já levas ${cartao.carimbos} do cartão seguinte` })));
  }
  return caixa;
}

function trilhoPontos(cartao) {
  const p = cartao.programa;
  const marcos = (p.marcos || []).slice().sort((a, b) => a.pontos - b.pontos);
  const maximo = marcos.length ? marcos[marcos.length - 1].pontos : p.objetivo;
  const fracao = Math.min(1, cartao.pontos / maximo);

  const trilho = el('div', { class: 'trilho' },
    el('div', { class: 'trilho-cheio', estilo: { width: `${fracao * 100}%` } }));

  for (const m of marcos) {
    const atingido = cartao.pontos >= m.pontos;
    const no = el('div', {
      class: 'marco',
      estilo: { left: `${(m.pontos / maximo) * 100}%` },
      title: `${m.pontos} pontos — ${m.premio}`,
    },
      el('span', { class: 'marco-valor', texto: String(m.pontos) }),
      el('div', {
        class: 'marco-ponto',
        html: atingido ? icone('presente', { tipo: 'traco', tamanho: 16 }) : '',
      }));
    no.dataset.atingido = atingido ? 'sim' : 'nao';
    no.dataset.premio = atingido ? 'sim' : 'nao';
    /* A ponta marca-se aqui e não com `:first-of-type` no CSS. O
       `:first-of-type` conta os irmãos DO MESMO TIPO, e o primeiro div
       dentro do trilho é a barra de progresso — por isso a regra que
       encostava o primeiro número nunca apanhava marco nenhum, e o número
       saía do cartão sem ninguém perceber porquê. */
    if (m === marcos[0]) no.dataset.ponta = 'primeiro';
    if (m === marcos[marcos.length - 1]) no.dataset.ponta = 'ultimo';
    trilho.append(no);
  }
  /* A faixa é uma caixa À VOLTA do trilho e não o próprio trilho: o trilho tem
     os marcos posicionados em absoluto contra ele, e pôr-lhe preenchimento por
     baixo movia todos os números. */
  return el('div', { class: 'trilho-faixa' }, trilho);
}

function proximoPremio(cartao) {
  const p = cartao.programa;
  if (cartao.porResgatar) return { rotulo: 'Pronto a levantar', texto: cartao.premios[0].descricao };
  if (p.tipo === 'pontos') {
    const marcos = (p.marcos || []).slice().sort((a, b) => a.pontos - b.pontos);
    const seguinte = marcos.find((m) => m.pontos > cartao.pontos);
    return seguinte
      ? { rotulo: `faltam ${seguinte.pontos - cartao.pontos} pontos`, texto: seguinte.premio }
      : { rotulo: 'Prémio seguinte', texto: p.premio };
  }
  /* Nunca abaixo de zero. O dono do café pode baixar «carimbos até ao
     prémio» a meio — de dez para seis, digamos — e quem já tivesse oito
     passava a ler «faltam -2 carimbos». Um número negativo num cartão de
     fidelidade não quer dizer nada a ninguém. */
  const faltam = Math.max(0, p.objetivo - cartao.carimbos);
  return {
    rotulo: faltam === 0 ? 'pronto a carimbar'
      : faltam === 1 ? 'falta 1 carimbo' : `faltam ${faltam} carimbos`,
    texto: p.premio,
  };
}

/* =========================================================================
   O BARALHO DA CARTEIRA

   Os cartões ficam empilhados como na carteira do telemóvel: cada um tapa o
   fundo do anterior e vê-se só a faixa de cima. Toca-se num e ele abre; toca-
   se noutro e o primeiro fecha. NUNCA HÁ DOIS ABERTOS, e essa é a regra que
   dita a forma do código — o estado é `qual está aberto`, um valor só, e não
   uma bandeira por cartão que se pode esquecer de limpar.

   PORQUÊ UM `<article>` E NÃO UM `<button>`. O cartão inteiro era um botão que
   levava ao ecrã do cartão, e lá dentro havia OUTRO botão, o de levantar o
   prémio. Um botão dentro de um botão não é HTML válido: o que um leitor de
   ecrã anuncia depende do leitor, e o clique no de dentro sobe ao de fora. Com
   a faixa a ser o botão e o resto a ser um painel a seguir, os dois passam a
   ser irmãos — e o `aria-expanded` passa a poder dizer a verdade.

   O QUE FICA SEMPRE À VISTA. A faixa, e — quando há prémio — a tira de o
   levantar. Com fila atrás, levantar um prémio não pode custar dois toques: é
   por isso que ela vive FORA do painel que abre e fecha.
   ========================================================================= */

/**
 * A MARCA DO CAFÉ NUM CARTÃO — o logótipo dele, ou a inicial.
 *
 * É o que distingue dois cartões escuros um do outro. Medido: a cor da
 * Barbearia Navalha está a ΔE 9,2 da cor por omissão — dois negócios que não
 * escolham cor nenhuma ficam com o MESMO cartão, e no maço lêem-se como duas
 * bandas seguidas. O nome resolve para quem lê; um desenho resolve para quem
 * passa os olhos, que é o que se faz a uma carteira.
 *
 * QUANDO NÃO HÁ LOGÓTIPO não se deixa um buraco: fica a inicial do nome num
 * disco, que é o que as carteiras de fidelidade fazem e nunca falha. E a
 * inicial é a primeira LETRA, não o primeiro caractere — «O Cantinho» dá «O»,
 * mas «...» ou um emoji dariam um quadrado preto.
 */
function marcaDoNegocio(negocio) {
  const letra = (String(negocio.nome || '').match(/\p{L}/u) || ['?'])[0].toUpperCase();
  /* A INICIAL ESTÁ SEMPRE LÁ, E A IMAGEM VEM POR CIMA.

     Escrito ao contrário — imagem OU inicial — um logótipo que não carregue
     deixa o ícone de imagem partida do browser no meio do cartão, que é pior
     do que não ter logótipo nenhum. Testado com um PNG inválido: cinco
     quadrados partidos e nenhuma inicial, porque o código já tinha decidido.
     Assim a imagem é o que TAPA a inicial, e se não chegar não tapa nada. */
  const marca = el('span', { class: 'cartao-logo cartao-monograma',
    'aria-hidden': 'true', texto: letra });

  const endereco = negocio.logotipo
    || (negocio.temLogotipo && api.base()
      ? `${api.base()}/v1/negocio/${encodeURIComponent(negocio.slug)}/logotipo`
        + (negocio.logotipoEm ? `?v=${String(negocio.logotipoEm).replace(/\D/g, '')}` : '')
      : null);
  if (!endereco) return marca;

  marca.append(el('img', {
    class: 'cartao-logo-imagem', src: endereco, alt: '', loading: 'lazy', decoding: 'async',
    /* Some-se em vez de se remover: um `remove()` a meio de uma pintura mexe
       no que já está no ecrã, e esconder é o que o browser sabe fazer sem
       segunda passagem. */
    aoError: (ev) => { ev.currentTarget.hidden = true; },
  }));
  return marca;
}

/**
 * O PROGRESSO DITO EM NÚMEROS, para o cartão fechado.
 *
 * Ele já existia — no `aria-label` da faixa. Quem ouve a app sabia que ia em
 * sete de dez; quem a vê tinha de abrir o cartão para saber. Era a informação
 * que se vai lá buscar, escondida atrás de um toque.
 */
function contagemDoCartao(cartao) {
  const p = cartao.programa;
  if (cartao.porResgatar > 0) return null;      /* a tira do prémio já o diz */
  if (p.tipo === 'pontos') return `${cartao.pontos} pt`;
  return `${cartao.carimbos}/${p.objetivo}`;
}

/** O cartão como aparece no baralho da carteira. */
function cartaoDoBaralho(cartao) {
  const p = cartao.programa;
  const prox = proximoPremio(cartao);
  const pronto = cartao.porResgatar > 0;
  const aberto = estado.cartaoExpandido === cartao.id;
  const idPainel = `cartao-painel-${cartao.id}`;
  const contagem = contagemDoCartao(cartao);

  /* O `aria-label` da faixa diz o que a faixa NÃO mostra — em que ponto vai o
     cartão — para quem a ouve decidir se vale a pena abrir. Sem isto, o
     anúncio era só o nome do café e a pessoa tinha de abrir todos. */
  const faixa = el('button', {
    class: 'cartao-aba', type: 'button',
    'aria-expanded': aberto ? 'true' : 'false',
    'aria-controls': idPainel,
    'aria-label': `${cartao.negocio.nome}, ${p.nome}. ${prox.rotulo}: ${prox.texto}.`,
    aoClick: () => alternarCartao(cartao.id),
  },
    marcaDoNegocio(cartao.negocio),
    el('span', { class: 'cartao-marca' },
      el('span', { class: 'cartao-nome', texto: cartao.negocio.nome }),
      el('span', { class: 'cartao-tipo', texto: p.nome })),
    contagem ? el('span', { class: 'cartao-contagem', 'aria-hidden': 'true', texto: contagem }) : null,
    el('span', { class: 'cartao-seta', html: icone('seta', { tamanho: 20 }) }));

  /* O painel é `hidden` de verdade, e não uma altura a zero. Uma altura a zero
     deixa lá dentro botões que o teclado continua a alcançar e o leitor de ecrã
     continua a ler: a pessoa tabula para dentro de um cartão fechado e fica a
     conduzir qualquer coisa que não vê. */
  /* COM PRÉMIO À ESPERA NÃO HÁ GRELHA, e não é descuido: o ciclo já recomeçou,
     por isso a grelha mostrava as casas do ciclo NOVO — quase todas vazias — a
     dois centímetros da tira que diz que se ganhou. Lê-se como se os carimbos
     tivessem desaparecido. O que a pessoa tem de ver é o prémio, e ele está na
     tira, sempre à vista. */
  const painel = el('div', {
    class: 'cartao-painel', id: idPainel, hidden: !aberto,
  },
    pronto ? null
      : p.tipo === 'pontos'
        ? el('div', {},
            el('div', { class: 'pontos-valor' },
              el('b', { texto: String(cartao.pontos) }),
              el('span', { texto: 'pt' })),
            trilhoPontos(cartao))
        : grelhaCarimbos(cartao),
    /* O NÚMERO DO CARTÃO DESCEU DA FAIXA PARA AQUI. Na faixa ele era o mesmo em
       todos os cartões — é o código da PESSOA, não do cartão — e um número
       repetido cinco vezes num maço não informa ninguém; o que fazia era comer
       noventa píxeis ao nome do café, que num ecrã de 320 acabava cortado. */
    el('div', { class: 'cartao-rodape' },
      pronto ? null : el('div', {},
        el('div', { class: 'cartao-rotulo', texto: prox.rotulo }),
        el('div', { class: 'cartao-premio', texto: prox.texto })),
      el('div', { class: 'cartao-id' },
        el('span', { texto: 'cartão' }),
        el('b', { texto: estado.cliente.publico }))),
    el('button', {
      class: 'btn btn-cartao btn-bloco', type: 'button',
      texto: 'Ver o cartão todo',
      aoClick: () => abrirCartao(cartao.id),
    }));

  const no = el('article', { class: 'cartao', 'data-aberto': aberto ? 'sim' : 'nao' },
    el('h3', { class: 'cartao-titulo' }, faixa),
    pronto ? el('div', { class: 'cartao-tira' }, painelPronto(cartao)) : null,
    painel);

  pintarCartao(no, cartao.negocio.cor);
  return no;
}

/**
 * Abre um cartão do baralho, e fecha o que estivesse aberto.
 *
 * MEXE-SE NO DOM E NÃO SE REPINTA O ECRÃ. Repintar era mais simples de
 * escrever, mas apaga e recria os nós: o foco cai no `body`, a rolagem salta
 * para o cimo, e a transição de abertura nunca chega a acontecer porque o
 * elemento que devia animar nasce já aberto. Aqui o botão em que a pessoa
 * tocou continua a ser o mesmo elemento, e continua com o foco.
 */
function alternarCartao(id) {
  estado.cartaoExpandido = estado.cartaoExpandido === id ? null : id;

  let aberto = null;
  for (const no of document.querySelectorAll('#principal .cartao[data-aberto]')) {
    const faixa = no.querySelector('.cartao-aba');
    const painel = no.querySelector('.cartao-painel');
    if (!faixa || !painel) continue;
    /* O ciclo passa por TODOS e não só pelos dois que mudam. É de propósito:
       assim não há estado por onde fugir — o que está aberto é sempre o que o
       `estado.cartaoExpandido` diz, e um cartão que tivesse ficado aberto por
       engano fecha-se na primeira vez que se toque em qualquer um. */
    const este = painel.id === `cartao-painel-${estado.cartaoExpandido}`;
    no.dataset.aberto = este ? 'sim' : 'nao';
    faixa.setAttribute('aria-expanded', este ? 'true' : 'false');
    painel.hidden = !este;
    if (este) aberto = no;
  }

  /* TRAZER O QUE SE ABRIU PARA O ECRÃ. Um cartão no fim do maço abre-se quase
     todo por baixo do bordo, e quem lhe tocou fica a olhar para a faixa sem
     perceber que aconteceu alguma coisa. O `nearest` não mexe em nada quando o
     cartão já cabe — é isso que o torna seguro de chamar sempre. O afastamento
     à barra e ao cabeçalho vem do `scroll-margin` no CSS, e não de contas
     aqui. */
  if (aberto) {
    aberto.scrollIntoView({
      block: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant' : 'smooth',
    });
  }
}

/* =========================================================================
   Ecrã: a carteira
   ========================================================================= */

/**
 * Vai buscar os cartões outra vez, antes de desenhar.
 *
 * `estado.cartoes` era preenchido uma única vez, no arranque. O balcão
 * carimbava, o cliente voltava à carteira, e continuava a ver o número de
 * antes — até fechar a app e abrir de novo. Num cartão de fidelidade isso é
 * o pior que pode acontecer: a pessoa fica convencida de que o carimbo não
 * foi dado, e quem leva com a discussão é quem está ao balcão.
 *
 * O mesmo estado velho fazia um prémio já entregue continuar a aparecer
 * como «pronto a levantar» ao lado da linha que diz que já foi levantado.
 *
 * Sem rede, fica-se com o que se tem e diz-se que pode estar desactualizado
 * — é melhor do que um ecrã vazio ou um erro por cima dos cartões.
 */
async function recarregarCartoes() {
  try {
    estado.cartoes = await api.cartoes(estado.cliente.id);
    return null;
  } catch (erro) {
    if (!erro.rede) throw erro;
    /* Devolve-se o aviso em vez de o colar já: quem chama é que sabe onde
       ele fica bem. Colado aqui, ficava o primeiro filho do `#principal` —
       ou seja, por cima do título do ecrã. */
    return el('p', { class: 'miudo',
      texto: 'Sem ligação — isto pode não estar actualizado.' });
  }
}

async function ecraCarteira(principal) {
  const semRede = await recarregarCartoes();
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Os meus cartões' }));
  if (semRede) principal.append(semRede);

  /* A CARTEIRA VAZIA PASSA A SER O ECRÃ DE ENTRADA.

     Enquanto havia «Descobrir», este ecrã podia dar-se ao luxo de ser um beco
     com um botão para outro sítio. Agora é a primeira coisa que vê metade de
     quem instala a app — e tem de explicar sozinho como é que os cartões
     nascem, sem mandar ninguém a lado nenhum.

     A ACÇÃO PRINCIPAL É MOSTRAR O CÓDIGO, e não «procurar um café». Das duas
     portas que sobram, esta é a que nunca falha: o balcão lê o código e o
     cartão nasce ao primeiro carimbo, sem a pessoa ter de aderir a nada. A do
     cartaz depende de haver cartaz na parede. */
  if (!estado.cartoes.length) {
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('carteira', { tamanho: 96 }) }),
      el('h3', { texto: 'Ainda não tens cartões' }),
      el('p', { texto: 'Mostra o teu código na próxima vez que fores ao café ou ao '
        + 'barbeiro. O cartão aparece aqui sozinho, logo ao primeiro carimbo.' }),
      el('button', {
        class: 'btn btn-cheio', aoClick: () => abrirCodigo(),
        html: icone('qr', { tamanho: 18 }) + '<span>Mostrar o meu código</span>',
      }),
      el('p', { class: 'miudo', style: 'margin-top:14px', texto:
        'Se houver um cartaz com um código no balcão, aponta-lhe a câmara do '
        + 'telemóvel — o cartão fica aqui logo.' })));
    return;
  }

  /* Contam-se prémios, não cartões. Três prémios no mesmo cartão davam uma
     faixa a dizer «Tens um prémio à espera» com o cartão logo por baixo a
     dizer «3 prémios à espera» — a app a contradizer-se a dois centímetros
     de distância. */
  const quantos = estado.cartoes.reduce((n, c) => n + (c.porResgatar || 0), 0);
  if (quantos) {
    principal.append(el('div', {
      class: 'faixa-premio',
      html: icone('presente', { tamanho: 20 })
        + `<span><b>${quantos === 1 ? 'Tens um prémio à espera'
            : `Tens ${quantos} prémios à espera`}.</b> `
        + `Mostra o código no balcão para levantar.</span>`,
    }));
  }

  /* O CARTÃO ABERTO PODE JÁ NÃO EXISTIR: largou-se o cartão noutro ecrã, ou o
     café desapareceu da conta. Sem esta linha ficava um identificador a
     apontar a nada, e o baralho abria-se todo fechado sem razão aparente. */
  if (!estado.cartoes.some((c) => c.id === estado.cartaoExpandido)) {
    estado.cartaoExpandido = null;
  }

  const lista = el('div', { class: 'pilha pilha-baralho' });
  for (const c of estado.cartoes) lista.append(cartaoDoBaralho(c));

  /* O «juntar outro» vai DENTRO da pilha, e não a seguir a ela. Estava como
     irmão: a pilha é que tem o `gap`, por isso ele ficava colado ao último
     cartão, sem um milímetro de folga — e com um cartão só na carteira o
     efeito era um bloco castanho com uma aba tracejada agarrada em baixo.
     Aqui dentro, apanha o mesmo espaço que separa os cartões uns dos
     outros, e a carteira lê-se como uma lista só. */
  /* «JUNTAR OUTRO» DEIXOU DE SER UM BOTÃO, porque deixou de haver para onde
     levar. Era uma linha tocável que abria o «Descobrir»; passou a ser uma
     placa que diz como é que um cartão novo aparece. Uma linha com seta que
     não vai a lado nenhum é pior do que placa nenhuma: quem lhe toca conclui
     que a app está avariada. */
  lista.append(el('div', { class: 'linha adicionar adicionar-placa' },
    el('span', { class: 'linha-icone', html: icone('qr', { tamanho: 20 }) }),
    el('span', { class: 'linha-texto' },
      el('b', { texto: 'Juntar outro cartão' }),
      el('span', { texto: 'Aponta a câmara ao cartaz do sítio, ou mostra o teu '
        + 'código ao balcão' }))));

  principal.append(lista);
}

/* =========================================================================
   Ecrã: um cartão
   ========================================================================= */

async function abrirCartao(cartaoId) {
  estado.cartaoAberto = cartaoId;
  irPara('cartao');
}

async function ecraCartao(principal) {
  const cheio = await api.cartao(estado.cliente.id, estado.cartaoAberto);
  const p = cheio.programa;

  principal.append(el('div', { class: 'pilha' }, cartaoGrande(cheio)));

  principal.append(el('button', {
    class: 'btn btn-cheio btn-grande btn-bloco', style: 'margin-top:20px',
    html: icone('qr', { tamanho: 20 }) + '<span>Mostrar o meu código</span>',
    aoClick: () => abrirCodigo(),
  }));

  /* Um botão por cartão, e no ecrã do cartão: cada cartão é um passe seu, com
     o seu saldo e o seu código de barras. No perfil não cabia — teria de
     perguntar primeiro qual deles.

     E UM BOTÃO SÓ, quando se sabe qual. Estavam os dois empilhados, e para
     quem tem um iPhone o da Google é ruído — e ruído que ocupa 55 píxeis de
     altura no meio do ecrã do cartão. Quando NÃO se sabe, ficam os dois: ver
     o comentário do `carteiraProvavel`. */
  const carteiras = cheio.carteiras || {};
  const podeGoogle = Boolean(carteiras.google);
  const podeApple = Boolean(carteiras.apple && CRACHA_APPLE);
  const qual = carteiraProvavel();
  /* A escolha só corta um botão se o OUTRO existir. Num telemóvel Android com
     um café que só tem a Apple ligada, esconder a Apple deixava a pessoa sem
     nada — e sem perceber porquê. */
  const mostraGoogle = podeGoogle && !(qual === 'apple' && podeApple);
  const mostraApple = podeApple && !(qual === 'google' && podeGoogle);

  if (mostraApple) {
    principal.append(botaoWallet(cheio, 'apple'));
    /* A SAÍDA DE EMERGÊNCIA. Um passe da Apple só se guarda a partir do
       Safari: no Chrome, no Firefox ou dentro do browser do Instagram, o
       ficheiro descarrega e não acontece nada. A pessoa não tem como adivinhar
       que o problema é o browser — e se escondemos o botão da Google por
       termos concluído que ela é da Apple, ficou sem alternativa nenhuma. */
    if (!eSafari()) {
      principal.append(el('p', { class: 'miudo', style: 'margin-top:8px', texto:
        'Se não abrir, abre esta página no Safari — é de lá que o iPhone '
        + 'guarda cartões na carteira.' }));
    } else if (cheio.naApple && !cheio.appleAutomatico) {
      /* O PASSE VELHO. Quem guardou o cartão antes de isto existir tem no
         telemóvel um ficheiro sem endereço de serviço lá dentro, e nada do
         que se faça no servidor lhe toca: fica congelado para sempre.

         Dizer a essa pessoa «actualiza-se sozinho» era mentir-lhe exactamente
         onde ela vai verificar. Uma vez, e nunca mais. */
      principal.append(el('p', { class: 'miudo', style: 'margin-top:8px', texto:
        'O cartão que tens na carteira é de antes das actualizações '
        + 'automáticas. Guarda-o outra vez — uma vez só — e a partir daí '
        + 'acerta-se sozinho.' }));
    }
  }
  if (mostraGoogle) principal.append(botaoWallet(cheio, 'google'));

  /* E QUANDO NÃO HÁ BOTÃO NENHUM, dizer porquê.

     Antes não se acrescentava nada, e «nada» não se distingue de «esta app
     não faz isso». Uma pessoa com dois cartões, um com botão e outro sem, não
     conclui «falta o logótipo daquele café»: conclui que a app está avariada.
     E o perfil promete a carteira a toda a gente.

     Sem botão e sem acção: quem tem de carregar o logótipo é o dono, e é no
     balcão que ele é avisado. Aqui a frase só existe para a pessoa parar de
     procurar. */
  if (!mostraGoogle && !mostraApple && carteiras.motivo === 'sem-logotipo') {
    principal.append(el('p', { class: 'miudo', style: 'margin-top:12px', texto:
      'Este sítio ainda não pôs o logótipo, e sem ele o cartão não vai para a '
      + 'carteira do telemóvel. O código aqui em cima funciona na mesma.' }));
  }

  /* TRAZ UM AMIGO. Só aparece se o café tiver ligado alguma coisa — um botão
     que promete carimbos num sítio que não os dá é uma promessa que ninguém
     fez. E é o café que paga, por isso é ele que decide. */
  if (p.amigo && (p.amigo.convidador || p.amigo.convidado)) {
    principal.append(el('button', {
      class: 'btn btn-suave btn-bloco', style: 'margin-top:12px', id: 'traz-amigo',
      html: icone('pessoas', { tamanho: 18 }) + '<span>Traz um amigo</span>',
      aoClick: () => painelDoAmigo(cheio),
    }));
  }

  /* COMO ESTE CAFÉ TE TRATA. O balcão pode escrever uma alcunha no cartão para
     saber quem és quando lá chegas — nunca te é pedido nada, é ele que a
     escreve. Uma nota sobre uma pessoa que ela não pode ler é o contrário do
     que este produto diz ser, por isso mostra-se, com o nome de quem a
     escreveu. O artigo 15.º do RGPD não é opcional.

     HAVIA AQUI UM BOTÃO PARA A APAGAR, e saiu. Não por descuido: quem responde
     pelos dados é o CAFÉ — está na privacidade e no artigo 28.º, ele é o
     responsável pelo tratamento e nós somos o subcontratante. O cliente a
     apagar um registo do café, sem ele saber, era a app a decidir por quem
     decide: o dono escrevia «a Joana da manhã», aquilo desaparecia da lista
     dele, e ninguém lhe dizia porquê.

     O direito de se opor (art. 21.º) não desapareceu — mudou de porta, e as
     duas portas dizem-se aqui: pedir ao café, ou largar o cartão, que leva o
     nome com ele e não toca nos outros. Um direito que obrigasse a apagar a
     conta inteira é que seria o prejuízo que o art. 7.º/4 proíbe. */
  if (cheio.alcunha) {
    principal.append(el('section', { class: 'seccao' },
      el('h2', { class: 'seccao-titulo', texto: 'Como te tratam aqui' }),
      el('div', { class: 'folha caixa-texto' },
        el('p', { html: `<b>${seguro(cheio.alcunha)}</b>` }),
        el('p', { class: 'miudo', style: 'margin-top:6px', texto:
          `É assim que ${cheio.negocio.nome} te chama na lista de clientes, para `
          + 'saber quem és quando cá chegas. Não te foi pedido nada — foi o '
          + 'balcão que escreveu, e é dele.' }),
        el('p', { class: 'miudo', style: 'margin-top:6px', texto:
          'Se não quiseres este nome, pede-lhes que o mudem ou o tirem. E se '
          + 'preferires, podes deixar este cartão aqui em baixo: o nome vai com '
          + 'ele, e os teus outros cartões ficam.' }))));
  }

  if (cheio.porResgatar) {
    const caixa = el('section', { class: 'seccao' },
      el('h2', { class: 'seccao-titulo', texto: cheio.porResgatar === 1 ? 'Prémio a levantar' : 'Prémios a levantar' }));
    for (const premio of cheio.premios) {
      caixa.append(el('div', { class: 'linha linha-premio' },
        el('span', { class: 'linha-icone', html: icone('presente', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: premio.descricao }),
          el('span', { texto: `ganho ${haQuanto(premio.ganhoEm)}` })),
        el('span', { class: 'etiqueta etiqueta-bom', texto: 'pronto' })));
    }
    principal.append(caixa);
  }

  /* Como funciona — a letra pequena, que num cartão de papel está atrás. */
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Como funciona' }),
    el('div', { class: 'folha caixa-texto' },
      el('p', { texto: p.tipo === 'pontos'
        ? `Ganhas pontos em cada visita. Ao chegares a cada marco, o prémio fica disponível.`
        : `Cada visita vale um carimbo. Ao fim de ${p.objetivo}, ganhas: ${p.premio}.` }),
      p.regras ? el('p', { class: 'miudo', texto: p.regras }) : null,
      p.arrefecimento ? el('p', { class: 'miudo', texto:
        `Só é possível um carimbo a cada ${p.arrefecimento >= 86400
          ? `${Math.round(p.arrefecimento / 86400)} dia(s)`
          : p.arrefecimento >= 3600 ? `${Math.round(p.arrefecimento / 3600)} hora(s)`
          : `${Math.round(p.arrefecimento / 60)} minutos`}.` }) : null)));

  /* Onde fica */
  const n = cheio.negocio;
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: n.nome }),
    el('div', { class: 'lista' },
      n.morada ? el('div', { class: 'linha' },
        el('span', { class: 'linha-icone', html: icone('mapa', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: n.morada }),
          el('span', { texto: n.localidade || '' }))) : null,
      n.telefone ? el('a', { class: 'linha', href: `tel:${n.telefone.replace(/\s/g, '')}` },
        el('span', { class: 'linha-icone', html: icone('telefone', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: n.telefone }),
          el('span', { texto: 'Chamada para a rede fixa nacional' }))) : null)));

  /* Histórico */
  if (cheio.movimentos.length) {
    const lista = el('div', { class: 'lista' });
    for (const m of cheio.movimentos.slice(0, 12)) lista.append(linhaMovimento(m, p));
    principal.append(el('section', { class: 'seccao' },
      el('h2', { class: 'seccao-titulo', texto: 'Histórico' }), lista));
  }

  /* ESTE BOTÃO EXISTIA E NÃO FAZIA NADA: dizia «numa versão futura poderás
     arquivar cartões» e ficava por ali. Agora faz — e faz porque tinha de
     passar a fazer. Enquanto a lista do balcão era uma coluna de códigos sem
     dono, sair de um café era uma comodidade; com a alcunha lá dentro, é o
     direito de oposição do artigo 21.º, e a única forma de o exercer era
     apagar a conta inteira e perder os carimbos de todos os outros cafés. */
  principal.append(el('button', {
    class: 'btn btn-fantasma btn-bloco', style: 'margin-top:24px',
    texto: 'Deixar de usar este cartão',
    aoClick: () => largarCartao(cheio),
  }));
}

/**
 * Sair de UM café.
 *
 * Pergunta, e diz o que se perde antes — não tem volta, e o que se perde não é
 * só o cartão: é o histórico daquelas visitas, que o café também deixa de ver.
 * É o preço certo, porque os dados eram da pessoa; mas não é o que alguém
 * adivinha ao ler «deixar de usar».
 */
function largarCartao(cartao) {
  const painel = abrirPainel('Deixar este cartão');
  painel.append(
    el('p', { class: 'subtexto', texto:
      `Sais do cartão de ${cartao.negocio.nome}. Os teus outros cartões ficam como estão.` }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        `<b>Perdes ${cartao.carimbos || cartao.pontos || 0} carimbo(s) neste café</b>, e o `
        + 'histórico das tuas visitas aqui. Não há forma de os trazer de volta.<br>'
        + 'O café deixa de te ver na lista de clientes dele — que é normalmente '
        + 'a razão para se fazer isto.' })),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', texto: 'Deixar este cartão',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          await api.largarCartao(cartao.id);
          estado.cartoes = await api.cartoes(estado.cliente.id);
          fecharPainel();
          avisar('Saíste desse cartão.', 'bom');
          irPara('carteira');
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para sair.', 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: fecharPainel }));
}

/* =========================================================================
   O botão da Carteira do Google

   A imagem é a que a Google distribui, byte a byte, e vai num `<img>` e não
   inline de propósito: inline, uma regra de CSS desta casa — um `svg { fill:
   currentColor }` qualquer — repintava-a, e as normas de marca dela proíbem
   mexer na cor, no tipo de letra, no raio e no espaçamento.

   É a versão CONDENSADA, e isso mediu-se. A coluna da app são 480 px com 20
   de margem de cada lado, o que dá 335 úteis num telemóvel pequeno. O botão
   largo tem 372×50: encolhido para caber ficava com 45 de altura, e o mínimo
   que a Google exige são 48. O condensado tem 240×55 — cabe em qualquer ecrã
   com a altura acima do mínimo, e é ele que ela manda usar quando o espaço é
   pouco.
   ========================================================================= */
function botaoWallet(cartao, carteira = 'google') {
  /* UM BOTÃO, DUAS CARTEIRAS. O que muda entre elas é o crachá, o texto e a
     chamada — o resto (o `aria-disabled` em vez do `disabled`, a navegação na
     mesma janela, o `pageshow` do regresso) é o mesmo, e foi tudo aprendido a
     doer com a Google. Duplicar a função era duplicar essas quatro lições e
     deixá-las afastar-se em silêncio.

     As medidas do crachá da Apple são as mesmas do da Google por opção: os
     dois ficam empilhados e alinhados, e a folga do CSS já serve os dois. */
  const daApple = carteira === 'apple';
  /* «ACTUALIZAR» E NÃO «ADICIONAR», a quem já lá tem o passe.

     O passe da Apple é um retrato: não temos servidor de web service, por
     isso ele mostra os carimbos do dia em que foi guardado e mais nenhum. A
     única forma de o pôr em dia é voltar a guardá-lo — a Apple substitui o
     passe com o mesmo número de série.

     Um botão que diz «Adicionar» a quem já adicionou é um botão em que
     ninguém toca, e o passe fica desactualizado para sempre sem que nada no
     ecrã sugira que há alguma coisa a fazer. A Google não precisa disto: essa
     actualiza-se por PATCH, e a faixa desenhada vai no mesmo pedido. */
  const jaNaApple = daApple && Boolean(cartao.naApple);
  const rotulo = daApple
    ? (jaNaApple ? 'Actualizar na Apple Wallet' : 'Adicionar à Apple Wallet')
    : 'Adicionar a Carteira do Google';
  const botao = el('button', {
    class: 'btn-wallet', type: 'button', 'aria-label': rotulo,
    'data-carteira': carteira,
  }, el('img', {
    src: `${base()}/icones/${daApple ? 'apple-wallet-pt' : 'google-wallet-pt'}.svg`,
    /* As medidas da arte de cada um, para o espaço ficar reservado antes de a
       imagem chegar — senão o ecrã salta debaixo do dedo de quem já ia a
       carregar. Não são iguais: ver o comentário no `app.css`. */
    alt: rotulo, width: daApple ? 187 : 240, height: 55,
  }));

  botao.addEventListener('click', async () => {
    /* `aria-disabled` e não `disabled`: desactivar um botão enquanto ele tem
       o foco atira o foco para o corpo da página, e quem navega por teclado
       ou leitor de ecrã perde o sítio onde estava.

       O VALOR É `true`, e durante muito tempo foi «sim» — que não é um valor
       de ARIA e que nenhuma das duas coisas que dependem dele reconhecia: nem
       o leitor de ecrã, que nunca o anunciou desactivado, nem a regra
       `.btn[aria-disabled="true"]` do `nucleo.css`, que é quem lhe tira os
       cliques. Oito botões desta casa ficavam com ar de desactivados e
       continuavam a aceitar o segundo toque. */
    if (botao.getAttribute('aria-disabled') === 'true') return;
    botao.setAttribute('aria-disabled', 'true');
    botao.classList.add('a-carregar');
    let aCaminhoDaCarteira = false;
    try {
      const r = daApple ? await api.walletApple(cartao.id) : await api.walletGoogle(cartao.id);
      if (r && r.ligacao) {
        /* Abre-se na mesma janela. Numa app instalada no ecrã inicial, um
           `_blank` sai para o browser e a pessoa perde a app; e o que vem a
           seguir é a página da Google, que devolve o telemóvel à carteira.

           O BOTÃO FICA DESACTIVADO ATÉ A PÁGINA SAIR, e é por isso que este
           caminho não passa pelo `finally`. Atribuir `location.href` só
           AGENDA a navegação: a página continua viva e a pintar até o novo
           documento chegar. Com o `finally` a correr — e ele corre sempre,
           mesmo depois de um `return` — o botão voltava ao normal enquanto se
           esperava, e numa rede de café isso é um segundo a olhar para um
           botão que parece não ter feito nada. O gesto natural é tocar outra
           vez, e a segunda vez cria outro objecto na Google. */
        aCaminhoDaCarteira = true;
        location.href = r.ligacao;
        return;
      }
      avisar(r && r.demo
        ? 'Isto é uma demonstração: o passe a sério é assinado pelo servidor.'
        : 'Não deu para preparar o passe. Tenta daqui a pouco.', 'neutro');
    } catch (erro) {
      avisar(erro && erro.codigo === 'sem-logotipo'
        ? `Este sítio ainda não pôs o logótipo, e ${daApple ? 'a Apple Wallet' : 'a Carteira do Google'} exige um.`
        : (erro && erro.message) || 'Não deu para preparar o passe.', 'mau');
    } finally {
      /* Só se reactiva se a página NÃO estiver de saída — ver o comentário no
         ramo de sucesso. Quem trata do REGRESSO é o `pageshow` lá em baixo:
         sem ele, quem carregasse em «voltar» na página da Google encontrava o
         botão esbatido e morto, e num telemóvel isso lê-se como avaria. */
      if (!aCaminhoDaCarteira) {
        botao.removeAttribute('aria-disabled');
        botao.classList.remove('a-carregar');
      }
    }
  });

  /* O REGRESSO. A ida para a Google deixa o botão desactivado de propósito —
     a página ainda está viva enquanto a navegação acontece. Mas quem carrega
     em «voltar» traz o documento de volta da cache do browser com o botão
     exactamente como ficou: esbatido, com `aria-disabled`, e morto. Numa app
     instalada no ecrã inicial é pior ainda, porque o `location.href` para um
     domínio de fora abre o Safari e a app NEM CHEGA a sair — a pessoa volta a
     ela pelo alternador e encontra um botão que não responde.

     O `pageshow` dispara nos dois casos, com `persisted` verdadeiro quando
     vem da cache; e dispara também no arranque normal, onde não faz mal
     nenhum. */
  addEventListener('pageshow', () => {
    botao.removeAttribute('aria-disabled');
    botao.classList.remove('a-carregar');
  });

  /* A NOTA NÃO É A MESMA PARA AS DUAS, e escrevê-la igual era mentir no ecrã.
     Na Google o objecto vive lá fora e nós actualizamo-lo quando um carimbo
     entra — «actualizam-se sozinhos» é verdade à letra. Na Apple o `.pkpass`
     é um ficheiro que sai daqui e fica no telemóvel: não tem serviço web do
     nosso lado, por isso mostra o saldo do dia em que foi guardado e mais
     nada. O que o endireita é voltar a juntá-lo — o par «Pass Type ID +
     número de série» é o mesmo, e a Apple substitui o anterior em vez de
     empilhar um segundo. Diz-se isso, que é pouca coisa a ler e evita uma
     pessoa a olhar para um cartão parado sem perceber porquê. */
  return el('div', { class: 'wallet-caixa' },
    botao,
    el('p', { class: 'miudo wallet-nota', texto: daApple
      ? 'Fica na carteira do iPhone com os carimbos de agora. Quando tiveres '
        + 'mais, junta-o outra vez para o actualizar.'
      : 'Fica na carteira do telemóvel, e os carimbos actualizam-se sozinhos.' }));
}

function cartaoGrande(cartao) {
  const p = cartao.programa;
  const prox = proximoPremio(cartao);
  const no = el('div', { class: 'cartao cartao-grande' },
    el('div', { class: 'cartao-corpo' },
      el('div', { class: 'cartao-topo' },
        el('div', { class: 'cartao-marca' },
          el('div', { class: 'cartao-nome', texto: cartao.negocio.nome }),
          el('div', { class: 'cartao-tipo', texto: p.nome })),
        el('div', { class: 'cartao-id' },
          el('span', { texto: 'cartão' }),
          el('b', { texto: estado.cliente.publico }))),
      cartao.porResgatar
        ? painelPronto(cartao)
        : p.tipo === 'pontos'
          ? el('div', {},
              el('div', { class: 'pontos-valor' },
                el('b', { texto: String(cartao.pontos) }),
                el('span', { texto: 'pt' })),
              trilhoPontos(cartao))
          : grelhaCarimbos(cartao),
      cartao.porResgatar ? null : el('div', { class: 'cartao-rodape' },
        el('div', {},
          el('div', { class: 'cartao-rotulo', texto: prox.rotulo }),
          el('div', { class: 'cartao-premio', texto: prox.texto })))));
  pintarCartao(no, cartao.negocio.cor);
  return no;
}

function linhaMovimento(m, programa) {
  const mapa = {
    carimbo: { ic: programa.selo, tipo: 'cheio', t: 'Carimbo' },
    pontos: { ic: 'raio', tipo: 'traco', t: `+${m.quantidade} pontos` },
    premio: { ic: 'presente', tipo: 'traco', t: 'Prémio ganho' },
    resgate: { ic: 'visto', tipo: 'traco', t: 'Prémio levantado' },
    adesao: { ic: 'cartoes', tipo: 'traco', t: 'Cartão criado' },
    anulado: { ic: 'menos', tipo: 'traco', t: 'Movimento anulado' },
  };
  const d = mapa[m.tipo] || mapa.carimbo;
  return el('div', { class: 'linha' },
    el('span', { class: 'linha-icone', html: icone(d.ic, { tipo: d.tipo, tamanho: 20 }) }),
    el('span', { class: 'linha-texto' },
      el('b', { texto: m.nota || d.t }),
      el('span', { texto: `${dataCurta(m.em)} · ${horas(m.em)}` })),
    el('span', { class: 'linha-fim', texto: haQuanto(m.em) }));
}



/**
 * O convite para um amigo.
 *
 * O QUE SE PARTILHA É UM ENDEREÇO, e não um código para escrever à mão: quem o
 * abre cai na app com o cartão já a ser junto. Um código de seis letras dito
 * ao telefone obriga a pessoa a escrevê-lo, e cada passo a mais é gente que
 * desiste pelo caminho.
 *
 * E DIZ-SE QUANDO É QUE ISTO PAGA. «Assim que ele for carimbado pela primeira
 * vez» não é letra pequena: é a diferença entre um convite que parece não ter
 * funcionado e um convite que está à espera de alguém ir ao café.
 */
async function painelDoAmigo(cartao) {
  const painel = abrirPainel('Traz um amigo');
  painel.append(el('p', { class: 'subtexto', texto: 'A ver…' }));

  let convite;
  try {
    convite = await api.meuConvite(cartao.programa.id);
  } catch (e) {
    painel.innerHTML = '';
    painel.append(
      el('h2', { style: 'margin-bottom:12px', texto: 'Traz um amigo' }),
      el('p', { class: 'aviso-mau', texto: e.message || 'Não deu para preparar o convite.' }),
      el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Fechar',
        aoClick: fecharPainel }));
    return;
  }
  if (!painel.isConnected) return;

  const endereco = `${location.origin}${base()}/app/?n=${encodeURIComponent(convite.slug)}`
    + `&a=${encodeURIComponent(convite.codigo)}`;
  const nome = cartao.negocio.nome;
  const carimbo = (n) => (n === 1 ? '1 carimbo' : `${n} carimbos`);

  painel.innerHTML = '';
  painel.append(el('h2', { style: 'margin-bottom:12px', texto: 'Traz um amigo' }));
  painel.append(el('p', { class: 'subtexto', texto: convite.convidador && convite.convidado
    ? `Manda este link a alguém. Quando ele for carimbado pela primeira vez em `
      + `${nome}, ele ganha ${carimbo(convite.convidado)} `
      /* «e tu também» quando são iguais, que é o caso normal: «ele ganha 1
         carimbo e tu ganhas 1 carimbo» é a mesma coisa dita duas vezes. */
      + (convite.convidador === convite.convidado
        ? 'e tu também.'
        : `e tu ganhas ${carimbo(convite.convidador)}.`)
    : convite.convidado
      ? `Manda este link a alguém. Quando ele for carimbado pela primeira vez em `
        + `${nome}, começa com ${carimbo(convite.convidado)}.`
      : `Manda este link a alguém. Quando ele for carimbado pela primeira vez em `
        + `${nome}, ganhas ${carimbo(convite.convidador)}.` }));

  /* O ENDEREÇO À VISTA, e não só dentro de um botão de partilha. Nem toda a
     gente tem o menu do sistema, e quem quiser mandá-lo por onde quiser tem de
     o poder ler e copiar. */
  painel.append(el('div', { class: 'folha caixa-texto', style: 'margin-bottom:12px' },
    el('p', { class: 'convite-endereco', id: 'convite-endereco', texto: endereco })));

  painel.append(el('button', {
    class: 'btn btn-cheio btn-bloco btn-grande', id: 'partilhar-convite',
    html: icone('partilhar', { tamanho: 18 }) + '<span>Partilhar o link</span>',
    aoClick: async (ev) => {
      const texto = `Junta-te a mim no cartão de ${nome}.`;
      /* O MENU DO SISTEMA PRIMEIRO, se existir: é onde estão o WhatsApp e as
         mensagens, que é por onde isto vai mesmo. E o `share` ATIRA quando a
         pessoa fecha o menu — isso não é um erro nem se avisa ninguém dele. */
      try {
        if (navigator.share) {
          await navigator.share({ title: nome, text: texto, url: endereco });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
      try {
        await navigator.clipboard.writeText(endereco);
        avisar('Link copiado. Cola-o onde quiseres.', 'bom');
      } catch {
        /* Sem menu e sem área de transferência — um browser antigo, ou uma
           permissão negada. O endereço está no ecrã: selecciona-se. */
        const alvo = $('#convite-endereco');
        if (alvo) {
          const intervalo = document.createRange();
          intervalo.selectNodeContents(alvo);
          const seleccao = getSelection();
          seleccao.removeAllRanges();
          seleccao.addRange(intervalo);
          avisar('Copia o link que está seleccionado.', 'neutro');
        }
      }
      ev.currentTarget.blur();
    },
  }));

  /* QUANTOS JÁ VIERAM, e quantos estão a caminho. Sem isto, quem convidou três
     pessoas e ainda não viu carimbo nenhum pensa que aquilo não funciona. */
  const linhas = [];
  if (convite.premiados) {
    linhas.push(convite.premiados === 1
      ? 'Já trouxeste 1 pessoa.'
      : `Já trouxeste ${convite.premiados} pessoas.`);
  }
  if (convite.aCaminho) {
    linhas.push(convite.aCaminho === 1
      ? '1 pessoa juntou o cartão e ainda não foi carimbada.'
      : `${convite.aCaminho} pessoas juntaram o cartão e ainda não foram carimbadas.`);
  }
  if (convite.convidador && convite.premiados >= convite.max) {
    linhas.push(`Este café premeia até ${convite.max} convites por pessoa, e já `
      + 'chegaste lá. Os teus amigos continuam a ganhar o deles.');
  }
  if (linhas.length) {
    painel.append(el('p', { class: 'miudo', style: 'margin-top:12px',
      texto: linhas.join(' ') }));
  }

  painel.append(el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
    texto: 'Fechar', aoClick: fecharPainel }));
}


/* =========================================================================
   Definições

   O TEMA SAIU DO CABEÇALHO, e foi o dono a pedi-lo. Estava num botão de lua
   ao lado do título, fora de qualquer menu — e um controlo solto no cabeçalho
   é o sítio onde ninguém procura uma preferência.

   E estava partido de duas maneiras, as duas medidas:

   · O CICLO TEM TRÊS ESTADOS E O ÍCONE TINHA DOIS. O ouvinte percorria
     «sistema → claro → escuro», e o desenho saía de `escuro ? sol : lua`. Com
     o telemóvel em claro, «sistema» e «claro» dão o mesmo fundo, o mesmo
     desenho e o mesmo rótulo: um toque em cada três não mudava um pixel. Quem
     lá tocasse concluía que o botão estava avariado.
   · O RÓTULO NOMEAVA DOIS ESTADOS — «Mudar entre claro e escuro» — para um
     controlo de três. Quem não vê o ecrã nunca soube que havia um «automático».

   Aqui os três estados têm nome escrito e um deles está sempre marcado. É o
   que o macOS faz («Clara · Escura · Automática»), o que o Android faz, e o
   que a app que o dono nomeou faz. E «Automático» vai em ÚLTIMO, que é onde
   os três o põem.
   ========================================================================= */

const TEMAS = [
  { chave: 'claro', nome: 'Claro', icone: 'brilho' },
  { chave: 'escuro', nome: 'Escuro', icone: 'lua' },
  /* Em último, e é o valor de nascença: uma app que não foi instruída ao
     contrário deve seguir o telemóvel. */
  { chave: 'sistema', nome: 'Automático', icone: 'engrenagem' },
];

function painelDoTema() {
  const painel = abrirPainel('Aspecto');
  const escolhido = ler('tema', 'sistema');

  /* `radiogroup` e não uma lista de botões: são opções EXCLUSIVAS, e é isso
     que faz um leitor de ecrã anunciar «2 de 3» em vez de ler três botões
     soltos sem relação nenhuma. */
  const grupo = el('div', { class: 'escolhas', role: 'radiogroup', 'aria-label': 'Aspecto' });

  /* O QUE UM `radiogroup` PROMETE, E QUE NÃO ACONTECE SOZINHO.

     Declarar o papel não escreve comportamento nenhum — é a mesma lição do
     `aria-modal`, que prometia quatro coisas e não fazia uma. Um grupo de
     rádios promete duas: UMA paragem de tabulação para o grupo inteiro (e não
     uma por opção), e as setas a andar entre as opções. Sem isto, quem navega
     por teclado gastava três Tabs onde devia gastar um, e as setas — que é o
     que um leitor de ecrã lhe manda usar depois de anunciar «2 de 3» — não
     faziam nada.

     Um `<input type="radio">` de verdade trazia isto de borla, mas não se
     desenha como uma linha da lista e obrigava a um rótulo à volta. Quinze
     linhas aqui custam menos do que uma folha de estilo a lutar com o browser. */
  const escolher = (chave) => {
    guardar('tema', chave);
    aplicarTema();
    const eco = $('#estado-aspecto');
    const nome = (TEMAS.find((x) => x.chave === chave) || {}).nome;
    if (eco && nome) eco.textContent = nome;
    for (const b of grupo.querySelectorAll('[data-tema-opcao]')) {
      const eEsta = b.dataset.temaOpcao === chave;
      b.setAttribute('aria-checked', eEsta ? 'true' : 'false');
      /* O tabindex anda com a marca: a próxima vez que o Tab entrar no grupo
         aterra na opção escolhida, e não na primeira da lista. */
      b.tabIndex = eEsta ? 0 : -1;
    }
  };

  grupo.addEventListener('keydown', (ev) => {
    const passo = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (!passo) return;
    ev.preventDefault();
    const botoes = [...grupo.querySelectorAll('[data-tema-opcao]')];
    const onde = botoes.indexOf(document.activeElement);
    /* Dá a volta nas duas pontas, como manda o padrão: da última à primeira e
       ao contrário. Um grupo de três em que a seta pára na ponta obriga a
       adivinhar quantas vezes se carregou. */
    const alvo = botoes[(onde + passo + botoes.length) % botoes.length];
    if (!alvo) return;
    /* A seta ESCOLHE, e não só move. É o que um rádio faz, e é o que torna
       isto útil: com o painel aberto, a pessoa percorre os três e vê o ecrã
       mudar por trás. */
    escolher(alvo.dataset.temaOpcao);
    alvo.focus();
  });

  for (const tema of TEMAS) {
    grupo.append(el('button', {
      class: 'linha escolha', type: 'button', role: 'radio',
      'aria-checked': tema.chave === escolhido ? 'true' : 'false',
      tabindex: tema.chave === escolhido ? '0' : '-1',
      'data-tema-opcao': tema.chave,
      aoClick: () => {
        escolher(tema.chave);
        /* Sem botão de guardar: aplica-se ao toque, e o ecrã por trás do
           painel muda à vista. A confirmação é o próprio resultado. E a linha
           do perfil, por trás, passa a dizer o nome novo — senão fechar o
           painel deixava lá o anterior, e um ecrã que mostra o estado errado é
           pior do que um que não o mostra. */
      },
    },
      el('span', { class: 'linha-icone', html: icone(tema.icone, { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' }, el('b', { texto: tema.nome })),
      el('span', { class: 'linha-fim escolha-visto', html: icone('visto', { tamanho: 18 }) })));
  }

  painel.append(grupo, el('p', { class: 'miudo', style: 'margin-top:12px', texto:
    'Em «Automático», a app segue o que o telemóvel estiver a fazer — e muda '
    + 'com ele, sem ser preciso voltar aqui.' }));
  return painel;
}

/* =========================================================================
   Ecrã: perfil
   ========================================================================= */

async function ecraPerfil(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Perfil' }));

  /* AS FORMAS DE ENTRAR DECIDEM METADE DESTE ECRÃ, e antes ninguém as pedia:
     tudo ramificava em `cliente.email`, que fica a NULL para quem entrou pela
     Google. O perfil dizia «Guardar a conta» a quem tinha acabado de a
     guardar, e escondia o «terminar sessão nos outros aparelhos» a quem tinha
     por onde voltar. Pergunta-se aqui, uma vez, quando este ecrã se abre.

     Se falhar, fica a lista da última vez — é melhor do que um ecrã que se
     recusa a abrir, e é a mesma decisão que os cartões em cache. */
  await carregarIdentidades();
  const identidades = estado.identidades || [];
  const comEmail = temIdentidade('email', identidades);
  const comGoogle = temIdentidade('google', identidades);
  /* A APPLE FALTAVA AQUI, e o painel das identidades já a conhecia há muito.
     Quem entrasse só pela Apple via este ecrã dizer-lhe «Guardar a conta» —
     quando a conta estava guardada — e ficava sem a linha de terminar sessão
     nos outros aparelhos, que é a única defesa de quem perdeu o telemóvel.
     Duas portas escritas à mão num sítio e três noutro: a lista tem de vir do
     mesmo sítio, e vem. */
  const comApple = temIdentidade('apple', identidades);
  const morada = moradaDaConta(identidades);
  const temPorta = comEmail || comGoogle || comApple;

  principal.append(el('div', { class: 'folha cartao-identidade' },
    el('div', {},
      el('div', { class: 'cartao-rotulo', texto: 'O meu número de cartão' }),
      el('div', { class: 'identidade-numero selecionavel', texto: estado.cliente.publico })),
    el('p', { class: 'miudo', texto: 'É este número que identifica todos os teus cartões. '
      + 'Se a câmara do balcão não ler o código, podem escrevê-lo à mão.' })));

  /* Como é que esta conta está guardada, em uma linha — e é a ÚNICA linha do
     perfil sobre isto. Ligar, desligar, ver com que morada se entrou: está
     tudo do outro lado do toque, no painel. Estavam aqui três linhas para a
     mesma pergunta, e nenhuma delas respondia à que se faz primeiro — «com que
     conta é que eu entrei?».

     E antes dizia sempre «Guardar a conta» a quem não tivesse email —
     incluindo a quem tivesse entrado pela Google, que é exactamente ter a
     conta guardada. */
  const comoEstaGuardada = () => {
    /* Os nomes das portas saem de uma lista e não de um encadeado de `if`:
       com três provedores um encadeado escrito à mão tem sete casos, e foi a
       falta de um deles que deixou quem entrou pela Apple sem conta. */
    const portas = [comGoogle && 'Google', comApple && 'Apple'].filter(Boolean);
    if (!portas.length && !comEmail) {
      return { titulo: 'Guardar a conta', sub: 'Para não perderes os cartões se mudares de telemóvel' };
    }
    if (!portas.length) return { titulo: 'A tua morada de email', sub: morada };
    const nomes = portas.join(' e ');
    return {
      titulo: 'A conta está guardada',
      sub: morada ? `${nomes} · ${morada}` : `Entras com a ${nomes}`,
    };
  };
  const guardada = comoEstaGuardada();

  const conta = el('div', { class: 'lista' },
    el('button', { class: 'linha', aoClick: guardarConta },
      el('span', { class: 'linha-icone', html: icone('cadeado', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: guardada.titulo }),
        el('span', { texto: guardada.sub })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));

  /* A CONTA QUE FICOU POR JUNTAR. O painel da recuperação diz «podes juntar
     mais tarde no perfil», e uma frase dessas obriga — sem esta linha era mais
     uma promessa que a app não cumpre, e dessas já se corrigiram demasiadas
     aqui. Só aparece a quem tem mesmo uma conta à espera. */
  if (ler('sessao-por-juntar')) {
    conta.prepend(el('button', { class: 'linha', aoClick: () => {
      juntarContas({ sessaoAntiga: ler('sessao-por-juntar'), quantos: 0 });
    } },
      el('span', { class: 'linha-icone', html: icone('cartoes', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Juntar os cartões da conta antiga' }),
        el('span', { texto: 'Ficaram numa conta separada quando recuperaste esta' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));
  }

  /* EXPULSAR OS OUTROS APARELHOS. A rota existe desde a fase 0 e não tinha
     quem a chamasse — e uma rota sem quem a chame é metade de um protocolo.
     Não se mostra a quem não tem por onde voltar a entrar: sem forma de entrar
     guardada, expulsar os outros aparelhos é expulsar-se a si próprio da conta
     para sempre, e o botão não avisa disso nenhuma.

     A PERGUNTA É «TENS PORTA?» e não «tens email». Era `cliente.email`, e com
     isso quem entrasse pela Google — que tem por onde voltar — ficava sem o
     botão de segurança, pela razão que a própria guarda escreve. */
  /* Aparece TAMBÉM na demonstração — ela existe para «experimentar a app
     inteira», e esconder-lhe uma funcionalidade fá-la mentir sobre o que a app
     é. O esboço do lado da API trata do resto. */
  if (temPorta) {
    conta.append(el('button', { class: 'linha', aoClick: sairDosOutros },
      el('span', { class: 'linha-icone', html: icone('cadeado', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Terminar sessão nos outros aparelhos' }),
        el('span', { texto: 'Se perdeste um telemóvel com a app aberta' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));
  }

  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Conta' }), conta,
    /* UMA PLACA, E NÃO UMA LINHA. Isto era um botão que prometia «em breve» e
       não fazia nada; virou `.linha`, e uma `.linha` no meio de uma lista de
       linhas tocáveis é um botão à vista — mesmo altura, mesmo ícone, mesma
       seta ausente que ninguém repara que falta. Quem lhe toca não recebe
       resposta nenhuma e conclui que a app está avariada.

       A Carteira do telemóvel existe, e o botão dela está em CADA cartão —
       que é onde tem de estar, porque o passe é de um cartão e não da conta.
       Aqui fica só a placa que diz onde é, com ar de placa.

       DIZIA «A Apple Wallet ainda não», E DEIXOU DE SER VERDADE no dia em que
       o certificado da Apple entrou no Worker. Ligar uma coisa do lado do
       servidor tornou falsa uma frase que estava certa na véspera, e ninguém
       teria ido ler o perfil por causa disso. Agora a frase não nomeia
       carteira nenhuma: o cartão sabe quais é que estão prontas. */
    el('div', { class: 'folha caixa-texto', style: 'margin-top:12px' },
      el('p', { class: 'miudo', html:
        '<b>Carteira do telemóvel.</b> Abre um cartão e junta-o à carteira a '
        + 'partir de lá — o passe é de cada cartão, não da conta.' }))));

  /* =======================================================================
     Definições — o que é PREFERÊNCIA, e não identidade.

     A «Conta» fica em primeiro e não esta, e não é convenção cega: escolher
     mal o aspecto custa um deslize de dedo; não dar pela linha «Guardar a
     conta» custa TODOS os cartões, sem volta e sem aviso. A secção que se
     paga mais caro por não se ver fica onde se vê primeiro.
     ======================================================================= */
  const nomeDoTema = (TEMAS.find((x) => x.chave === ler('tema', 'sistema')) || TEMAS[2]).nome;
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Definições' }),
    el('div', { class: 'lista' },
      el('button', { class: 'linha', id: 'linha-aspecto', aoClick: painelDoTema },
        el('span', { class: 'linha-icone', html: icone('lua', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: 'Aspecto' }),
          el('span', { id: 'estado-aspecto', texto: nomeDoTema })),
        el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })),

      /* AVISAR-ME. Estava na «Conta», e não é conta nenhuma: é uma
         preferência deste aparelho — a mesma pessoa pode querer avisos no
         telemóvel e não os querer no tablet. Só aparece onde pode funcionar:
         o servidor tem de ter chave, o browser tem de saber de notificações,
         e num iPhone isto só existe dentro de uma app posta no ecrã
         principal. Um interruptor que não liga nada é pior do que
         interruptor nenhum. */
      el('button', { class: 'linha', id: 'linha-avisos', aoClick: avisosDoPremio },
        el('span', { class: 'linha-icone', html: icone('sino', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: 'Avisar-me quando ganhar um prémio' }),
          el('span', { id: 'estado-avisos', texto: 'A ver…' })),
        el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })))));

  /* A linha dos avisos nasce a dizer «A ver…» e acerta-se quando as três
     perguntas tiverem resposta — se o servidor tem chave, se o browser sabe
     disto, e se já há subscrição neste aparelho. Se alguma falhar, a linha
     desaparece: não se deixa lá um interruptor que não liga nada. */
  arrumarLinhaDeAvisos().catch(() => {});

  /* Dados — o que a lei exige que seja fácil de fazer, e que quase nenhuma
     app faz fácil: ver o que têm sobre nós, e apagar. */
  const dados = el('div', { class: 'lista' },
    el('button', { class: 'linha', id: 'linha-exportar', aoClick: exportarDados },
      el('span', { class: 'linha-icone', html: icone('descarregar', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Descarregar os meus dados' }),
        el('span', { texto: 'Tudo o que o Carimbo Digital tem sobre ti, num ficheiro' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })),
    /* FORA DO ÂMBITO DA PWA, e por isso abre-se numa janela à parte. O
       manifesto declara `scope: "/app/"` e `/privacidade/` está fora dele:
       numa app posta no ecrã principal, um link para fora do âmbito leva a
       pessoa para o Safari e deixa a app para trás. Com `_blank` fica uma
       folha por cima, com um «Concluído» que a devolve ao sítio onde estava.
       O `noopener` vai junto porque `_blank` sem ele dá à página nova acesso
       ao `window.opener`. */
    el('a', { class: 'linha', href: `${base()}/privacidade/`,
              target: '_blank', rel: 'noopener' },
      el('span', { class: 'linha-icone', html: icone('info', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Política de privacidade' }),
        el('span', { texto: 'O que guardamos e porquê' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })),
    el('button', { class: 'linha linha-perigo', aoClick: apagarConta },
      el('span', { class: 'linha-icone', html: icone('caixote', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Apagar a conta e os cartões' }),
        el('span', { texto: 'Imediato e sem volta' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Os meus dados' }), dados));

  principal.append(el('p', { class: 'rodape-app', html:
    'Carimbo Digital · '
    + `<a class="ligacao" href="${base()}/termos/" target="_blank" rel="noopener">Termos</a> · `
    + `<a class="ligacao" href="${base()}/privacidade/" target="_blank" rel="noopener">Privacidade</a>`
    + (MODO === 'demo' ? ' · <b>modo de demonstração</b>' : '') }));

  if (MODO === 'demo') {
    principal.append(el('div', { class: 'folha caixa-texto', style: 'margin-top:16px' },
      el('p', { html: '<b>Estás na demonstração.</b> Os dados ficam só neste telemóvel '
        + 'e não há servidor nenhum a receber nada. Serve para experimentar a app inteira.' }),
      DEMO_FORCADO ? el('button', {
        class: 'btn btn-cheio btn-pequeno', style: 'margin-top:12px;margin-right:8px',
        texto: 'Sair da demonstração',
        aoClick: () => { location.href = '?demo=0'; },
      }) : null,
      el('button', {
        class: 'btn btn-suave btn-pequeno', style: 'margin-top:12px',
        texto: 'Recomeçar a demonstração',
        aoClick: async () => {
          await api.limpar();
          await esquecerSegredo();
          apagar('cliente'); apagar('sessao'); apagar('desvio'); apagar('visto-bv');
          apagar('sessao-por-juntar'); apagar('identidades'); apagar(CHAVE_ENTRADA);
          location.reload();
        },
      })));
  }
}

/**
 * Expulsar os outros aparelhos.
 *
 * Pede confirmação porque tem um preço que não se adivinha: o passe que está
 * na Carteira do telemóvel também morre — nos outros E neste. É o preço de o
 * código do passe não levar assinatura nenhuma; quem ficar com ele na mão
 * carimba, e a única forma de o fechar é deitá-lo fora. Diz-se antes, para
 * não ser uma surpresa ao balcão.
 */
function sairDosOutros() {
  const painel = abrirPainel('Terminar sessão nos outros aparelhos');
  painel.append(
    el('p', { class: 'subtexto', texto:
      'Todos os outros telemóveis e computadores onde esta conta esteja aberta '
      + 'deixam de lá entrar. Este continua.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        '<b>O código do teu cartão muda.</b> O antigo deixa de carimbar — é '
        + 'isso que fecha a porta a quem tenha ficado com o telemóvel.<br>'
        + '<b>Os cartões que tenhas na Carteira do telemóvel também deixam de '
        + 'valer</b>, incluindo neste. Voltas a juntá-los quando quiseres, a '
        + 'partir de cada cartão.<br>'
        + '<b>E os outros aparelhos deixam de receber avisos de prémio.</b> '
        + 'Um telemóvel perdido deixava de entrar na conta e continuava a '
        + 'mostrar no ecrã bloqueado o nome do café e o prémio que ganhaste.' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Terminar nos outros',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.disabled = true;
        try {
          /* O endereço de push DESTE aparelho vai no pedido: é o único que
             fica. O servidor não o consegue adivinhar — uma subscrição não
             traz sessão — e sem ele caem todas, incluindo a deste telemóvel.
             Se não houver subscrição nenhuma aqui, não vai nada e o servidor
             apaga tudo, que é o mesmo resultado. */
          const minha = await subscricaoDeste().catch(() => null);
          const r = await api.sairDosOutros(minha ? minha.endpoint : '');
          /* O SEGREDO NOVO GUARDA-SE, e é o passo que não se pode falhar: sem
             ele este aparelho fica com o segredo da versão anterior e o seu
             próprio código deixa de carimbar — a pessoa expulsava-se a si
             própria com o botão que existe para não o fazer. */
          if (r && r.segredo) await guardarSegredo(r.segredo);
          estado.cartoes = await api.cartoes(estado.cliente.id);
          fecharPainel();
          /* Se os avisos deste aparelho também caíram — porque não havia
             subscrição para poupar — diz-se, e a linha do perfil acerta-se.
             Um interruptor que ficou ligado no ecrã e desligado no servidor é
             a app a mentir sobre uma coisa que a pessoa não vai verificar. */
          if (r && r.avisosMantidos === false) arrumarLinhaDeAvisos().catch(() => {});
          avisar(r && r.passesRevogados
            ? 'Feito. Os cartões que tinhas na Carteira precisam de ser juntos outra vez.'
            : 'Feito. Os outros aparelhos deixaram de ter acesso.', 'bom');
          irPara('perfil');
        } catch (e) {
          botao.disabled = false;
          avisar(e.message, 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: fecharPainel }));
}

/**
 * Juntar os cartões deste telemóvel à conta em que se acabou de entrar.
 *
 * Aparece no único momento em que faz sentido: a pessoa escreveu o código, a
 * morada já era de outra conta, e a conta que estava neste telemóvel tinha
 * cartões. Sem isto, esses cartões ficavam para trás em silêncio — no gesto
 * que lhe prometia exactamente o contrário.
 *
 * PERGUNTA-SE, não se faz sozinho. Juntar não tem volta: dois cartões do mesmo
 * café passam a um, e o ciclo fica pelo maior. É pouco provável que alguém
 * prefira o contrário, mas «pouco provável» não é razão para decidir pela
 * pessoa numa coisa irreversível.
 */
function juntarContas({ sessaoAntiga, quantos }) {
  const painel = abrirPainel('Juntar os cartões');
  /* Quem chega pelo perfil já não sabe quantos eram — a contagem era da conta
     que já lá não está. Dizer «tinhas 0 cartões» seria pior do que não contar. */
  const introducao = quantos > 0
    ? `Tinhas ${quantos === 1 ? 'um cartão' : `${quantos} cartões`} neste telemóvel, `
      + 'numa conta separada. Queres juntá-los aos que acabaste de recuperar?'
    : 'Ficaram cartões numa conta separada quando recuperaste esta. '
      + 'Queres juntá-los todos?';

  const seguir = async (ev) => {
    const botao = ev.currentTarget;
    botao.disabled = true;
    try {
      await api.fundir(sessaoAntiga);
      /* A sessão guardada morre aqui. Deixá-la ficar punha a linha «juntar os
         cartões da conta antiga» a aparecer para sempre no perfil, a oferecer
         uma fusão que já foi feita — e o servidor responderia «essa conta já
         foi fundida», que não quer dizer nada a quem está a ler. */
      apagar('sessao-por-juntar');
      estado.cartoes = await api.cartoes(estado.cliente.id);
      fecharPainel();
      avisar(`Ficaste com ${estado.cartoes.length} cartões numa conta só.`, 'bom');
      irPara('carteira');
    } catch (e) {
      botao.disabled = false;
      /* O prémio por levantar trava a fusão, e isso diz-se com as palavras do
         servidor em vez de um erro genérico: a pessoa tem uma coisa concreta
         para fazer a seguir. */
      avisar(e.message, 'mau');
    }
  };

  painel.append(
    el('p', { class: 'subtexto', texto: introducao }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        '<b>Se juntares:</b> ficas com tudo numa conta só. Se tiveres dois '
        + 'cartões do mesmo café, ficam um — com os carimbos do que estava '
        + 'mais adiantado, e o histórico dos dois.<br>'
        /* «Podes juntar mais tarde no perfil» só se diz a quem NÃO está no
           perfil. Quem chegou aqui pela linha do perfil já lá está, e mandá-lo
           para onde está é o género de frase que faz uma pessoa duvidar se
           carregou no sítio certo. */
        + '<b>Não tem volta.</b>'
        + (quantos > 0 ? ' Se preferires, podes juntar mais tarde no perfil.' : '') })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Juntar os cartões', aoClick: seguir }),
    el('button', {
      class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: quantos > 0 ? 'Agora não' : 'Cancelar',
      aoClick: () => {
        /* A sessão antiga fica guardada, senão «mais tarde» era mentira: sem
           ela não há como provar que aquela conta também é desta pessoa. */
        guardar('sessao-por-juntar', sessaoAntiga);
        fecharPainel();
        avisar(`Cartões recuperados: ${estado.cartoes.length}.`, 'bom');
        irPara('carteira');
      } }));
}

/* =========================================================================
   Avisar quando o cartão fica cheio

   UM AVISO SÓ, e é o que faz este interruptor ser aceitável: o carimbo que
   fecha o cartão. É dado no aparelho do BALCÃO, com a pessoa já a guardar o
   telemóvel — deste lado não há nada que o diga, a não ser que a app esteja
   aberta. «Há dois meses que não apareces» seria publicidade, e a página de
   privacidade promete em letra grande que não a enviamos.

   TRÊS CONDIÇÕES, e todas têm de ser verdade para a linha existir:
   · o servidor tem a chave (`/v1/portas`);
   · o browser sabe de notificações e de service workers;
   · e — o que apanha toda a gente — num iPhone isto só existe dentro de uma
     app posta no ECRÃ PRINCIPAL. No Safari normal não há `PushManager`, e a
     linha some-se em vez de prometer.
   ========================================================================= */

/** A chave pública VAPID chega em base64url; o browser quer bytes. */
function bytesDaChave(base64url) {
  const s = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const cru = atob(s);
  return Uint8Array.from(cru, (c) => c.charCodeAt(0));
}

const paraBase64url = (buffer) => {
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** O browser sabe fazer isto? (Num iPhone, só dentro da app instalada.) */
const browserSabeAvisar = () => typeof Notification !== 'undefined'
  && 'serviceWorker' in navigator && 'PushManager' in window;

/** A subscrição que este aparelho já tem, se tiver. */
async function subscricaoDeste() {
  if (!browserSabeAvisar()) return null;
  try {
    const registo = await navigator.serviceWorker.getRegistration(`${base()}/app/`);
    return registo ? await registo.pushManager.getSubscription() : null;
  } catch { return null; }
}

/**
 * Acerta a linha do perfil — ou tira-a, quando não há nada que ela possa
 * fazer.
 */
async function arrumarLinhaDeAvisos() {
  const linha = $('#linha-avisos');
  if (!linha) return;
  const portas = await portasAbertas();
  if (!portas.push || !browserSabeAvisar()) {
    /* Sem chave no servidor ou sem browser que saiba, a linha sai do ecrã.
       Deixá-la a dizer «não dá aqui» era ocupar espaço com uma desculpa. */
    linha.remove();
    return;
  }
  const alvo = $('#estado-avisos');
  if (!alvo) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    /* O «não» do sistema é definitivo do nosso lado: uma vez recusado, o
       browser nunca mais nos deixa perguntar. Diz-se onde se desfaz. */
    alvo.textContent = 'Bloqueadas nas definições do telemóvel';
    return;
  }
  alvo.textContent = (await subscricaoDeste())
    ? 'Ligadas neste telemóvel'
    : 'Desligadas — um toque para ligar';
}

/**
 * O painel do interruptor.
 *
 * PERGUNTA-SE SEMPRE, e nunca se liga por baixo. A folha de permissão é
 * desenhada pelo sistema e só aparece a partir de um toque — por isso o
 * `requestPermission` vive dentro do clique, e não num arranque qualquer.
 */
async function avisosDoPremio() {
  const painel = abrirPainel('Avisar-me quando ganhar um prémio');
  const ligadas = Boolean(await subscricaoDeste());
  const bloqueadas = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  painel.append(
    el('p', { class: 'subtexto', texto:
      'O carimbo que fecha o cartão é dado no aparelho do balcão, muitas vezes '
      + 'com o telemóvel já guardado. Este aviso é para não te escapar.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        '<b>Só isto, e mais nada.</b> Não enviamos publicidade nem lembretes '
        + 'para voltares a um café. O que vai na mensagem é o nome do sítio e o '
        + 'que ganhaste, cifrado de nós até ao teu telemóvel — quem a '
        + 'transporta não a consegue ler.' })));

  if (bloqueadas) {
    painel.append(el('p', { class: 'miudo', texto:
      'Este telemóvel tem as notificações do Carimbo Digital bloqueadas, e a '
      + 'partir daqui não há como voltar a pedir. Podes desbloqueá-las nas '
      + 'definições do browser, na secção deste site.' }));
    painel.append(el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
      texto: 'Fechar', aoClick: fecharPainel }));
    return;
  }

  painel.append(el('button', {
    class: ligadas ? 'btn btn-perigo btn-bloco btn-grande' : 'btn btn-cheio btn-bloco btn-grande',
    texto: ligadas ? 'Desligar neste telemóvel' : 'Ligar os avisos',
    aoClick: async (ev) => {
      const botao = ev.currentTarget;
      if (botao.getAttribute('aria-disabled') === 'true') return;
      botao.setAttribute('aria-disabled', 'true');
      try {
        if (ligadas) await desligarAvisos(); else await ligarAvisos();
      } catch (e) {
        botao.removeAttribute('aria-disabled');
        avisar(e.message || 'Não deu para mudar os avisos.', 'mau');
        return;
      }
      fecharPainel();
      await irPara('perfil');
    },
  }));
  painel.append(el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
    texto: 'Agora não', aoClick: fecharPainel }));
}

async function ligarAvisos() {
  const portas = await portasAbertas();
  if (!portas.push) throw new Error('Os avisos não estão ligados no servidor.');

  /* NA DEMONSTRAÇÃO NÃO SE SUBSCREVE NADA. Uma subscrição verdadeira a apontar
     para um servidor que nunca lhe vai mandar nada é lixo no telemóvel de
     quem só queria ver como é. */
  if (MODO === 'demo') {
    avisar('Nesta demonstração não sai aviso nenhum — no telemóvel, avisamos-te '
      + 'quando ganhares um prémio.', 'neutro');
    return;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    /* Não é um erro: é uma resposta. Quem diz que não fica exactamente onde
       estava, e sem uma mensagem vermelha a dizer-lhe que correu mal. */
    avisar('Ficam desligadas. Podes ligá-las quando quiseres.', 'neutro');
    return;
  }

  const registo = await navigator.serviceWorker.ready;
  const sub = await registo.pushManager.subscribe({
    /* Obrigatório, e é uma promessa: tudo o que chegar mostra-se. Um push
       silencioso é o que faz os browsers desligarem a permissão sozinhos. */
    userVisibleOnly: true,
    applicationServerKey: bytesDaChave(portas.push),
  });
  await api.subscreverPush({
    endereco: sub.endpoint,
    p256dh: paraBase64url(sub.getKey('p256dh')),
    auth: paraBase64url(sub.getKey('auth')),
  });
  avisar('Ligadas. Avisamos-te quando o cartão ficar cheio.', 'bom');
}

async function desligarAvisos() {
  if (MODO === 'demo') { avisar('Ficam desligadas.', 'neutro'); return; }
  const sub = await subscricaoDeste();
  /* PRIMEIRO O SERVIDOR, e só depois o browser. Ao contrário, um `unsubscribe`
     bem sucedido seguido de uma rede que cai deixava a linha na base de dados
     sem ninguém do outro lado — e nós a mandar avisos para uma parede até três
     falhas os apagarem. */
  if (sub) {
    try { await api.desligarPush(sub.endpoint); } catch { /* o browser manda */ }
    await sub.unsubscribe();
  }
  avisar('Desligadas neste telemóvel.', 'bom');
}

/* =========================================================================
   Entrar com a Google

   O caminho é: pedir a ida, guardar o BILHETE aqui, navegar para a Google, e
   voltar a `/app/` com um código na barra de endereço. O bilhete é o que prova,
   à volta, que quem conclui é quem começou — sem ele, quem me mandasse o
   endereço da ida levava a minha conta inteira.

   NAVEGA-SE, não se abre janela. O manifesto declara `scope: "/app/"`, e num
   iPhone com a app no ecrã principal é a navegação para dentro do âmbito que
   devolve o controlo à app instalada. Uma janela nova ficava no browser de
   dentro, que é outro armazenamento, e o bilhete não estava lá.
   ========================================================================= */

/* Onde fica o bilhete entre a ida e a volta. Tem de sobreviver a sair da
   página, por isso não pode ser uma variável. */
/* Onde fica o bilhete entre a ida e a volta. O nome deixou de ter a porta lá
   dentro quando ficaram duas: a chave antiga (`entrada-google`) desaparece com
   a actualização, e quem estiver a meio de uma ida nesse segundo repete — é um
   toque, e é o preço de não carregar um nome errado para sempre. */
const CHAVE_ENTRADA = 'entrada';
/* Uma ida vale dez minutos do lado do servidor; aqui dá-se folga para o
   relógio do telemóvel estar torto e para a pessoa demorar a escolher a conta. */
const ENTRADA_VALE = 15 * 60 * 1000;

/* A marca da Google, como ela a publica. Não se redesenha nem se troca por
   texto: é a condição de uso do botão, e um «G» desenhado por nós seria uma
   marca falsificada. Vai inteira no ficheiro — nunca carregada de lá, que a
   página de privacidade promete não carregar nada de terceiros. */
const MARCA_GOOGLE = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">'
  + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
  + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
  + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
  + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/* Que portas é que o servidor tem abertas. Pergunta-se uma vez por arranque e
   guarda-se aqui: um botão que só falha ao ser tocado é pior do que um botão
   que não está lá, e adivinhar era exactamente isso. Na dúvida — servidor
   velho, sem rede — responde-se que não há porta nenhuma nova. */
let PORTAS = null;
async function portasAbertas() {
  if (PORTAS) return PORTAS;
  try {
    PORTAS = await api.portas();
  } catch {
    PORTAS = { email: true, google: false, apple: false };
  }
  return PORTAS;
}

/**
 * As formas de entrar nesta conta.
 *
 * A app decidia tudo por `estado.cliente.email`, e isso deixa de servir no dia
 * em que há uma segunda porta: quem entrar pela Google tem o `email` a NULL —
 * é o próprio Worker que o deixa assim, porque a morada que a Google mostra é
 * pista e não pode decidir de quem é a conta. Com a pergunta errada, o perfil
 * dizia «Guardar a conta» a quem tinha acabado de a guardar, e escondia o
 * «terminar sessão nos outros aparelhos» a quem tinha por onde voltar.
 *
 * FICA EM CACHE porque há um ecrã que precisa dela quando já não há sessão
 * para a ir buscar: o da sessão terminada.
 */
async function carregarIdentidades() {
  try {
    const r = await api.eu();
    /* «NÃO VEIO» NÃO É «NÃO HÁ». Um corpo vazio, um Worker mais velho, um
       intermediário que corta a resposta — nada disso é uma conta sem portas,
       e escrever `[]` por cima da cache boa tem um preço concreto: é dela que
       o ecrã da sessão terminada tira os botões, e sem ela quem só entra pela
       Google fica com «entra com o email» (não tem) e «começar de novo»
       (deita os cartões fora). Só se escreve quando veio mesmo uma lista. */
    if (r && Array.isArray(r.identidades)) {
      estado.identidades = r.identidades;
      guardar('identidades', estado.identidades);
    } else if (!estado.identidades || !estado.identidades.length) {
      estado.identidades = ler('identidades', []) || [];
    }
  } catch {
    estado.identidades = ler('identidades', []) || [];
  }
  return estado.identidades;
}

const temIdentidade = (provedor, lista = estado.identidades) =>
  (lista || []).some((i) => i.provedor === provedor);

/** A morada por onde se entra, se houver uma. A do email manda. */
function moradaDaConta(lista = estado.identidades) {
  const l = lista || [];
  const email = l.find((i) => i.provedor === 'email');
  if (email) return email.email;
  const outra = l.find((i) => i.email && !i.relay);
  return outra ? outra.email : null;
}

/** O botão, com as palavras que a Google deixa usar e a marca dela intacta. */
/* A maçã da Apple, como ela a publica para este botão. Como a da Google: não
   se redesenha, não se troca por texto, e vai inteira no ficheiro — a página
   de privacidade promete não carregar nada de terceiros. Herda a cor do texto
   (`currentColor`), que é o que a Apple manda para o botão preto e para o
   branco. */
const MARCA_APPLE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" '
  + 'focusable="false" fill="currentColor">'
  + '<path d="M16.07 12.79c.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.61-1.7-3.18-1.72-1.35-.14-2.64.8-3.33.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.52zM13.9 5.9c.61-.74 1.02-1.77.91-2.8-.88.04-1.94.59-2.57 1.32-.56.65-1.05 1.7-.92 2.7.98.08 1.98-.5 2.58-1.22z"/></svg>';

/**
 * O botão de uma porta, com a marca de quem é.
 *
 * As palavras são as que cada um deixa usar: «Continuar com a Google» e
 * «Continuar com a Apple». A marca vai à esquerda do texto nos dois, que é o
 * que as duas pedem.
 */
function botaoDaPorta(provedor, aoClick) {
  const apple = provedor === 'apple';
  return el('button', {
    class: `btn btn-bloco btn-grande ${apple ? 'btn-apple' : 'btn-google'}`,
    'data-porta': provedor, aoClick,
    html: `${apple ? MARCA_APPLE : MARCA_GOOGLE}`
      + `<span>Continuar com a ${apple ? 'Apple' : 'Google'}</span>`,
  });
}

/* O nome antigo fica: é chamado do ecrã da sessão terminada e de mais dois
   sítios, e renomear por renomear é convidar um esquecimento. */
const botaoGoogle = (aoClick) => botaoDaPorta('google', aoClick);

/**
 * A ida.
 *
 * O botão é desactivado à entrada e NÃO se volta a activar no caminho feliz:
 * a página está prestes a sair de si própria, e um botão que volta a ficar
 * vivo durante esse meio segundo dá duas idas e dois bilhetes, dos quais só um
 * sobrevive.
 */
async function iniciarGoogle(ev) {
  /* Antes do `await`. Depois de um, o `currentTarget` vale null — foi um
     defeito desta casa e não se repete. */
  const botao = ev.currentTarget;
  const provedor = botao.getAttribute('data-porta') || 'google';
  const nome = provedor === 'apple' ? 'Apple' : 'Google';
  botao.setAttribute('aria-disabled', 'true');
  try {
    const r = await api.comecarEntrada(provedor);
    /* Na demonstração não se sai do site: não há provedor nenhum do outro
       lado, e mandar alguém a uma conta verdadeira para ver uma coisa que não
       é verdadeira seria pior do que não mostrar o botão. */
    if (r.demo || !r.url) {
      const feito = await api.estadoEntrada(r.bilhete, provedor);
      await assentarEntradaPorPorta(feito, { demo: true, provedor });
      return;
    }
    /* O PROVEDOR VAI COM O BILHETE. À volta, quem pergunta «de que porta é
       isto?» é o servidor, pela ligação — mas a app precisa de saber o que
       dizer quando corre mal, e um «não deu para entrar com a Google» a quem
       carregou na Apple é uma mensagem que não ajuda ninguém. */
    guardar(CHAVE_ENTRADA, { bilhete: r.bilhete, provedor, em: Date.now() });
    location.assign(r.url);
  } catch (e) {
    botao.removeAttribute('aria-disabled');
    avisar(e.message || `Não deu para falar com a ${nome}.`, 'mau');
  }
}

/**
 * Assentar o que veio da entrada — na demonstração, onde tudo acontece sem
 * sair da página. O caminho a sério passa pelo `voltarDaPorta`, no arranque.
 */
async function assentarEntradaPorPorta(r, { demo = false, provedor = 'google' } = {}) {
  const marca = provedor === 'apple' ? 'Apple' : 'Google';
  if (!r || r.situacao !== 'pronta') {
    avisar(`Não deu para entrar com a ${marca}. Tenta outra vez.`, 'mau');
    return;
  }
  if (r.segredo) await guardarSegredo(r.segredo);
  if (r.sessao) guardar('sessao', r.sessao);
  if (r.horaDoServidor) guardarDesvio(r.horaDoServidor);
  if (r.cliente) {
    estado.cliente = r.cliente;
    guardar('cliente', r.cliente);
  }
  await carregarIdentidades();
  fecharPainel();
  avisar(demo
    ? `Nesta demonstração não há ${marca} a sério — mas o caminho é este.`
    : 'Conta guardada. Os cartões já não se perdem.', 'bom');
  await irPara('perfil');
}

/**
 * A volta, no arranque da app.
 *
 * Corre ANTES de tudo o resto e devolve o que o arranque tem de fazer a
 * seguir. É de propósito que corre antes do `entrar()`: sem isso, a app
 * registava uma conta anónima nova por baixo e a entrada aterrava nela.
 */
async function voltarDaPorta() {
  const p = new URLSearchParams(location.search);
  const codigo = p.get('code');
  const estadoDaPorta = p.get('state');
  const recusa = p.get('error');
  if (!codigo && !estadoDaPorta && !recusa) return null;

  /* O endereço limpa-se JÁ. Um código de autorização não fica no histórico do
     telemóvel nem é partilhado por engano, e recarregar a página não volta a
     tentar uma coisa que só serve uma vez. É a mesma manha do `seguirConvite`. */
  const limpo = new URL(location.href);
  for (const k of ['code', 'state', 'error', 'scope', 'authuser', 'prompt', 'hd']) {
    limpo.searchParams.delete(k);
  }
  history.replaceState(null, '', limpo.pathname + limpo.search + limpo.hash);

  const guardado = ler(CHAVE_ENTRADA, null);
  apagar(CHAVE_ENTRADA);

  /* SEM BILHETE NÃO SE CONCLUI, e isto não é zelo: o bilhete é o que prova que
     quem está aqui é quem começou. Sem ele, ou a volta aterrou noutro
     armazenamento — um iPhone antigo que abriu a ligação no Safari em vez de
     dentro da app — ou alguém mandou este endereço a esta pessoa. Nos dois
     casos a resposta é a mesma: não se conclui nada. */
  if (!guardado || !guardado.bilhete || Date.now() - (guardado.em || 0) > ENTRADA_VALE) {
    ecraOutraJanela();
    return { falhou: true };
  }

  /* DE QUE PORTA É ESTA VOLTA. O bilhete trá-la consigo desde a ida, e é dele
     que saem os nomes nas mensagens: dizer «a Google não confirmou» a quem
     carregou no botão da Apple é pedir à pessoa que desconfie de nós. */
  const provedor = guardado.provedor === 'apple' ? 'apple' : 'google';
  const marca = provedor === 'apple' ? 'Apple' : 'Google';

  const clienteLocal = ler('cliente', null);
  const sessaoAntiga = ler('sessao', null);
  const cartoesDaqui = (ler('cartoes', []) || []).length;

  try {
    const feito = await api.concluirEntrada(estadoDaPorta, codigo, guardado.bilhete, recusa);
    if (feito && feito.ok === false) {
      ecraEntradaFalhou(feito.codigo === 'porta-recusou'
        ? `Não chegaste a autorizar a entrada na ${marca}. Não ficou nada guardado.`
        : `A ${marca} não confirmou a entrada.`);
      return { falhou: true };
    }
    const r = await api.estadoEntrada(guardado.bilhete, provedor);
    if (!r || r.situacao !== 'pronta') {
      ecraEntradaFalhou(r && r.situacao === 'erro'
        ? `A ${marca} não confirmou a entrada. Tenta outra vez.`
        : 'Esta entrada já não vale. Tenta outra vez.');
      return { falhou: true };
    }

    if (r.segredo) await guardarSegredo(r.segredo);
    if (r.sessao) guardar('sessao', r.sessao);
    if (r.horaDoServidor) guardarDesvio(r.horaDoServidor);
    if (r.cliente) {
      estado.cliente = r.cliente;
      guardar('cliente', r.cliente);
    }
    /* Quem tinha visto as boas-vindas continua a tê-las vistas; quem chegou
       aqui sem elas entrou de outra forma e não tem que as ver agora. */
    guardar('visto-bv', 1);

    /* OS CARTÕES DESTE TELEMÓVEL NÃO FICAM PARA TRÁS. É a mesma regra do
       caminho do email: guarda-se a sessão antiga ANTES de a substituir,
       porque é ela a prova de que aquela conta também é desta pessoa. */
    const trocou = Boolean(r.cliente && clienteLocal && r.cliente.id !== clienteLocal.id);
    return {
      entrou: true,
      juntar: trocou && cartoesDaqui > 0 && sessaoAntiga
        ? { sessaoAntiga, quantos: cartoesDaqui } : null,
      pista: r.pista || null,
      recuperada: Boolean(r.recuperada),
    };
  } catch (e) {
    ecraEntradaFalhou(e.rede
      ? 'Ficaste sem rede a meio da entrada. Tenta outra vez.'
      : (e.message || 'Não deu para concluir a entrada.'));
    return { falhou: true };
  }
}

/**
 * O que se faz DEPOIS de a app estar pintada, quando se entrou pela Google.
 *
 * Corre no fim do arranque e não no meio dele: juntar contas abre um painel, e
 * um painel sobre uma app por pintar não tem para onde voltar.
 */
async function terminarEntradaPorPorta(volta) {
  await carregarIdentidades();
  if (volta.juntar) { juntarContas(volta.juntar); return; }
  if (volta.pista === 'mesma-morada') { avisoDeMesmaMorada(); return; }
  avisar(volta.recuperada
    ? `Cartões recuperados: ${estado.cartoes.length}.`
    : 'Conta guardada. Os cartões já não se perdem.', 'bom');
}

/**
 * «Entrei com a Google e a carteira está vazia.»
 *
 * É o caso mais confuso desta fase, e é o comportamento CERTO: a morada de
 * email nunca decide de quem é uma conta — é pista, não chave, e tratá-la como
 * chave é o pré-registo que o modelo inteiro existe para impedir. Quem já
 * tinha conta pelo email e entra pela Google com a mesma morada cai numa conta
 * nova e vazia, e sem uma palavra lê isso como «perdi os cartões».
 *
 * Diz-se, e oferece-se o caminho: entrar também pelo email, que é a prova do
 * outro lado, e juntar as duas.
 */
function avisoDeMesmaMorada() {
  const painel = abrirPainel('Já há uma conta com essa morada');
  painel.append(
    el('p', { class: 'subtexto', texto:
      'Entraste com a Google e esta conta está vazia — os teus cartões estão '
      + 'noutra, a que já tinhas associado a mesma morada de email.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        'Não juntámos as duas sozinhos de propósito: uma morada igual não prova '
        + 'que a conta é a mesma pessoa. Para as juntar, entra também com o '
        + '<b>email</b> — aí ficam provadas as duas e os cartões vêm todos.' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Entrar com o email',
      aoClick: () => { recuperarConta(); } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Agora não',
      aoClick: fecharPainel }));
}

/** A volta aterrou onde não estava quem começou. Diz-se, e não se conclui. */
function ecraOutraJanela() {
  ecraEntradaFalhou('Esta janela não é a mesma onde começaste a entrar. '
    + 'Por segurança, não concluímos nada. Volta à app do Carimbo Digital e '
    + 'tenta outra vez a partir de lá.');
}

/** Um ecrã inteiro para uma entrada que não deu, com caminho para a frente. */
function ecraEntradaFalhou(mensagem) {
  $('#aplicacao').hidden = false;
  $('#topo-titulo').textContent = '';
  $('#barra').innerHTML = '';
  const principal = $('#principal');
  if (!principal) return;
  principal.innerHTML = '';
  principal.append(el('div', { class: 'vazio' },
    el('div', { class: 'vazio-desenho', html: icone('cadeado', { tamanho: 96 }) }),
    el('h3', { texto: 'A entrada não ficou feita' }),
    el('p', { texto: mensagem }),
    el('button', {
      class: 'btn btn-cheio btn-grande', texto: 'Voltar à app',
      aoClick: () => { location.assign(`${base()}/app/`); },
    })));
}

/**
 * Desligar uma porta — a da Google ou a da Apple.
 *
 * A MESMA OBRIGAÇÃO QUE O EMAIL. Entrar por elas é consentimento, e o artigo
 * 7.º/3 diz que retirar tem de ser tão fácil como dar. Dar é um toque.
 *
 * E diz-se o que se perde ANTES — e o que se perde depende de sobrar ou não
 * outra porta, por isso a frase muda.
 */
async function desligarPorta(provedor, { voltar = false } = {}) {
  const nome = provedor === 'apple' ? 'Apple' : 'Google';
  /* O AVISO SAI DE UM RETRATO FRESCO. Ele diz «continuas a poder entrar com o
     teu email» ou «esta é a tua única forma de entrar», e a diferença entre os
     dois é a diferença entre um gesto sem preço e um gesto que deixa alguém de
     fora. Se a lista for a que o perfil leu há minutos, quem tiver tirado o
     email noutro aparelho leva a frase suave no momento exacto em que está a
     desligar a última porta. O aviso existe para não haver enganos. */
  await carregarIdentidades();
  /* «Sobra outra» e não «tem email»: com três portas, desligar a Google a quem
     tem a Apple não deixa ninguém de fora. A pergunta é quantas ficam. */
  const sobraOutra = (estado.identidades || []).some((i) => i.provedor !== provedor);
  /* Quem chega aqui vem do painel da conta, e é para lá que volta — tenha
     desligado ou tenha desistido. Mandá-lo para o perfil a meio de um gesto
     que ele começou noutro sítio é fazê-lo perder o lugar. */
  /* E SÓ VOLTA SE AINDA FOR ESTE O PAINEL ABERTO. O pedido pode demorar, e
     quem o fechar a meio não quer vê-lo ressuscitar por cima do perfil. */
  const daquiVolta = () => {
    if (!$('#painel')) return;
    if (voltar) guardarConta(); else fecharPainel();
  };
  const painel = abrirPainel(`Desligar a conta ${nome}`);
  painel.append(
    el('p', { class: 'subtexto', texto:
      `Deixa de ser possível entrar nesta conta com a ${nome}.` }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html: sobraOutra
        ? '<b>Os cartões e os carimbos ficam todos</b>, e continuas a poder '
          + `entrar pelas outras formas que tens. Podes voltar a ligar a ${nome} `
          + 'quando quiseres.'
        : '<b>Os cartões e os carimbos ficam todos.</b> O que perdes é a forma '
          + 'de os recuperar noutro telemóvel: esta é a tua única forma de '
          + 'entrar, e sem ela, se perderes este aparelho, perdes os cartões.<br>'
          + 'Podes voltar a ligá-la — ou deixar um email — quando quiseres.' })),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', texto: `Desligar a ${nome}`,
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          const r = await api.desligarPorta(provedor);
          if (r && Array.isArray(r.identidades)) {
            estado.identidades = r.identidades;
            guardar('identidades', estado.identidades);
          } else {
            await carregarIdentidades();
          }
          avisar(`Conta ${nome} desligada. Os cartões ficaram.`, 'bom');
          /* O perfil por baixo repinta-se ANTES de o painel voltar: a linha da
             conta muda de texto, e deixá-la com o texto velho por trás de um
             painel aberto é uma mentira à espera de ser vista. */
          await irPara('perfil');
          daquiVolta();
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para desligar.', 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: daquiVolta }));
}

/**
 * O mesmo painel, dito ao contrário.
 *
 * Guardar e recuperar são o mesmo caminho — escrever a morada e confirmar o
 * código — mas quem chega por aqui já tem conta e quer os cartões de volta.
 * Chamar-lhe «Guardar a conta» fá-la-ia pensar que está a criar outra.
 */
function recuperarConta() {
  return guardarConta({ recuperar: true });
}

/** A morada por onde uma porta entra — a que o provedor mostrou. */
const moradaDaPorta = (provedor, lista = estado.identidades) =>
  ((lista || []).find((i) => i.provedor === provedor) || {}).email || null;

/**
 * Uma porta JÁ LIGADA, com a morada por onde ela entra e o botão de a tirar.
 *
 * Não é um botão, e é de propósito: o que se toca é o que está ao lado. A
 * classe `.linha` já só dá o efeito de pressão a `button.linha` e `a.linha`,
 * por isso uma `div` com ela não promete um toque que não existe.
 */
function linhaDaPorta({ marca, nome, morada, accao, aoClick }) {
  /* O BOTÃO TEM DE DIZER O QUÊ. Escrito, lê-se «Desligar» ao lado de «Google»
     e a proximidade chega; num leitor de ecrã a proximidade não existe — o
     rotor de botões dá «Desligar, Tirar» e não se sabe qual é qual. Com a
     porta da Apple a caminho, «Desligar» apareceria duas vezes.
     O que se vê continua a ser o verbo; o nome acessível é que é inteiro. */
  const rotulo = morada ? `${accao} — ${nome}, ${morada}` : `${accao} — ${nome}`;
  return el('div', { class: 'linha linha-porta', role: 'listitem' },
    el('span', { class: 'linha-icone', html: marca }),
    el('span', { class: 'linha-texto' },
      el('b', { texto: nome }),
      /* A MORADA DIZ-SE, e é o que a pessoa vem aqui ver: «com que conta é que
         eu entrei?». Quando o provedor não a confirmou não há nada para
         mostrar, e diz-se isso em vez de um espaço em branco. */
      el('span', { texto: morada || 'ligada a esta conta' })),
    el('button', {
      class: 'btn btn-fantasma btn-pequeno', texto: accao,
      'aria-label': rotulo, aoClick,
    }));
}

/**
 * Guardar a conta — e, quando já está guardada, ver e mexer em como está.
 *
 * ESTAVA REPARTIDO POR TRÊS LINHAS DO PERFIL: uma para guardar a conta, outra
 * para desligar a Google, outra para tirar o email. Três sítios para a mesma
 * pergunta, e nenhum deles respondia à que a pessoa faz primeiro — «com que
 * conta é que eu entrei?». Agora é um sítio só: mostra as portas que estão
 * ligadas, com a morada de cada uma, e oferece as que faltam.
 *
 * O MODO «RECUPERAR» NÃO GERE NADA, só oferece. Chega-se a ele de um telemóvel
 * novo, ou de uma sessão que já morreu — e em nenhum dos dois casos há sessão
 * para desligar seja o que for. Um botão de desligar ali era prometer uma coisa
 * que ia dar 401.
 */
async function guardarConta({ recuperar = false } = {}) {
  /* DUAS PERGUNTAS DIFERENTES, e confundi-las custava caro.
     «O que é que esta conta TEM» decide o que se oferece, e sai da lista —
     da cache, quando não há sessão para a ir buscar. «Posso MEXER nisto»
     decide se há botões de desligar, e isso sim depende de haver sessão.

     Estavam as duas coladas: no modo `recuperar` a lista era esvaziada, e com
     ela desaparecia o que decide a OFERTA. Resultado: a quem chegava do ecrã
     da sessão terminada com uma conta só de email, o painel oferecia a Google
     — e tocar-lhe não dava 401 nenhum, porque a ida à Google é rota aberta e
     a sessão é opcional: NASCIA UMA CONTA NOVA, vazia, e a antiga ficava do
     outro lado. É a forma mais cara de alguém perder os cartões no gesto que
     lhos ia devolver. */
  const lista = (estado.identidades && estado.identidades.length)
    ? estado.identidades : (ler('identidades', []) || []);
  const comEmail = temIdentidade('email', lista);
  const comGoogle = temIdentidade('google', lista);
  const comApple = temIdentidade('apple', lista);
  const conhecidas = comEmail || comGoogle || comApple;
  const podeMexer = !recuperar;
  const ligadas = conhecidas && podeMexer;

  const painel = abrirPainel(ligadas
    ? 'Como entras nesta conta'
    : (recuperar ? 'Recuperar os cartões' : 'Guardar a conta'));

  /* No modo recuperar, quando já se sabe por onde esta conta entra, diz-se —
     em vez de oferecer as duas como se fosse um telemóvel novo. */
  const quantas = [comEmail, comGoogle, comApple].filter(Boolean).length;
  const soUma = recuperar && quantas === 1;

  /* O TEXTO NASCE VAZIO E ENCHE-SE DEPOIS, e é de propósito. Ele nomeia as
     portas — «com a Google, com a Apple, ou com um email» — e quem sabe quais
     estão abertas é o servidor, que ainda não respondeu aqui. Escrito à mão,
     este parágrafo dizia «duas formas» e nomeava só a Google: ficou a mentir
     no dia em que entrou a terceira, e voltaria a mentir se uma delas caísse.
     Um parágrafo em branco durante um instante não promete nada a ninguém. */
  const intro = el('p', { class: 'subtexto' });
  painel.append(intro);

  /* E na demonstração diz-se JÁ, antes de qualquer botão: não há conta
     nenhuma noutro telemóvel para ir buscar. O caminho mostra-se todo, mas
     ninguém sai daqui a pensar que recuperou alguma coisa. */
  if (MODO === 'demo' && recuperar) {
    painel.append(el('p', { class: 'miudo', texto:
      'Nesta demonstração não há conta noutro telemóvel para ir buscar — cada '
      + 'telemóvel tem a sua. O caminho é este, e é o que vais ver a sério.' }));
  }

  /* --- o que já está ligado ---------------------------------------------- */
  if (ligadas) {
    /* Um título por cima, a par do «Juntar outra forma de entrar» que está em
       baixo: sem ele, a lista aparece sem se apresentar. E `role="list"`,
       porque uma `div` nunca se anuncia como «lista, 2 itens». */
    painel.append(el('h3', { class: 'seccao-titulo', style: 'margin-top:4px',
      texto: 'Ligadas a esta conta' }));
    /* `caixa` e não `lista`: `lista` já é a das identidades, três linhas acima,
       e uma `const` com o mesmo nome tapa-a aqui dentro sem um aviso. */
    const caixa = el('div', { class: 'lista', role: 'list' });
    if (comGoogle) {
      caixa.append(linhaDaPorta({
        marca: MARCA_GOOGLE, nome: 'Google',
        morada: moradaDaPorta('google', lista),
        accao: 'Desligar',
        aoClick: () => desligarPorta('google', { voltar: true }),
      }));
    }
    if (comApple) {
      caixa.append(linhaDaPorta({
        marca: MARCA_APPLE, nome: 'Apple',
        /* DA APPLE NÃO VEM MORADA, e é de propósito: ela só a manda se a volta
           for por POST, e a nossa aterra no GitHub Pages. A linha diz o que
           sabe — «ligada a esta conta» — em vez de deixar um branco. */
        morada: moradaDaPorta('apple', lista),
        accao: 'Desligar',
        aoClick: () => desligarPorta('apple', { voltar: true }),
      }));
    }
    if (comEmail) {
      caixa.append(linhaDaPorta({
        marca: icone('carta', { tamanho: 20 }), nome: 'Email',
        morada: moradaDaPorta('email', lista),
        accao: 'Tirar',
        aoClick: () => tirarEmail({ voltar: true }),
      }));
    }
    painel.append(caixa);
  }

  /* --- o que falta ------------------------------------------------------- */
  /* ESPERA-SE PELA RESPOSTA ANTES DE PINTAR. A porta da Google pode não
     existir — Worker por configurar, ou o `/v1/portas` a falhar, que responde
     «não» por omissão. O título nascia sempre e o botão só chegava depois:
     a quem já tinha email e não tinha Google, o painel acabava num
     «Juntar outra forma de entrar» com NADA por baixo. Um cabeçalho que
     promete uma coisa que não vem é pior do que não haver cabeçalho. */
  const portas = await portasAbertas();
  if (!painel.isConnected) return;

  /* Em modo de recuperação oferece-se o que a conta TEM; a gerir, o que lhe
     FALTA. Num telemóvel novo não se sabe nada dela, e oferecem-se todas. */
  const oferecer = (tem, existe = true) => existe
    && (recuperar ? (conhecidas ? tem : true) : !tem);
  const oferecerGoogle = oferecer(comGoogle, portas.google);
  const oferecerApple = oferecer(comApple, portas.apple);
  const oferecerEmail = oferecer(comEmail);

  /* --- e agora sim, o texto de cima ------------------------------------- */
  /* Nomeia SÓ o que vai mesmo aparecer por baixo. «com a Google, com a Apple,
     ou com um email» — a última com «ou», que é como se diz uma lista em
     português e não «Google, Apple, email». */
  const nomes = [
    oferecerGoogle && 'com a Google',
    oferecerApple && 'com a Apple',
    oferecerEmail && 'com um email',
  ].filter(Boolean);
  const emProsa = nomes.length > 1
    ? `${nomes.slice(0, -1).join(', ')} ou ${nomes[nomes.length - 1]}`
    : (nomes[0] || '');
  /* Sem nada para nomear não se escreve meia frase — «Chega uma forma: .» era
     o que saía daqui. Quem fala é a mensagem de baixo, e esta cala-se. */
  intro.textContent = !nomes.length && !ligadas ? '' : ligadas
    ? 'É por aqui que voltas a esta conta se mudares de telemóvel. Chega uma '
      + 'forma; com duas, não ficas de fora se perderes uma delas.'
    : (soUma
      ? (comEmail
        ? 'Esta conta entra por email. Escreve a morada que já usaste e os '
          + 'cartões voltam para este telemóvel.'
        : `Esta conta entra pela ${comApple ? 'Apple' : 'Google'}. Toca no botão `
          + 'e os cartões voltam para este telemóvel.')
      : (recuperar
        ? `Entra ${emProsa} — o mesmo que já usaste — e os cartões voltam para `
          + 'este telemóvel.'
        : `Chega uma forma: ${emProsa}. Se mudares de telemóvel, entras outra `
          + 'vez e os cartões voltam todos.'));

  if (!oferecerGoogle && !oferecerApple && !oferecerEmail) {
    painel.append(el('p', { class: 'miudo', style: 'margin-top:16px', texto: ligadas
      ? 'Tens tudo o que há. Podes tirar uma quando quiseres — os cartões ficam.'
      : 'Não há por onde entrar neste momento. Tenta outra vez daqui a pouco.' }));
    return;
  }

  const oferta = el('div', {});
  painel.append(oferta);
  if (ligadas) {
    oferta.append(el('h3', { class: 'seccao-titulo', style: 'margin-top:20px',
      texto: 'Juntar outra forma de entrar' }));
  }

  for (const [provedor, mostrar] of [['google', oferecerGoogle], ['apple', oferecerApple]]) {
    if (mostrar) oferta.append(botaoDaPorta(provedor, iniciarGoogle));
  }
  if (oferecerGoogle || oferecerApple) {
    oferta.append(el('p', { class: 'miudo', style: 'margin-top:8px', texto:
      'Quem escolheres fica a saber que usas o Carimbo Digital. Não lhes '
      + 'pedimos o teu nome nem a tua fotografia.' }));
    /* O «ou» só faz sentido quando há mesmo mais uma escolha em baixo. */
    if (oferecerEmail) {
      oferta.append(
        el('div', { class: 'ou', role: 'separator' }, el('span', { texto: 'ou' })));
    }
  }

  if (!oferecerEmail) return;

  oferta.append(
    el('label', { class: 'campo' },
      el('span', { texto: 'Email' }),
      el('input', { type: 'email', inputmode: 'email', autocomplete: 'email',
                    placeholder: 'o.teu@email.pt', id: 'campo-email' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', id: 'botao-enviar',
      texto: 'Enviar o código',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        const v = $('#campo-email').value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
          avisar('Esse email não parece válido.', 'mau'); return;
        }
        botao.disabled = true;
        try {
          const r = await api.guardarEmail(v);
          /* Se o email não saiu, não se manda ninguém esperar por um código
             que nunca vai chegar — é a forma mais rápida de alguém achar que
             a app está avariada. */
          if (r && r.enviado === false && !r.demo) {
            botao.disabled = false;
            avisar('Não foi possível enviar o email agora. Tenta daqui a pouco.', 'mau');
            return;
          }
          pedirCodigo(v, r && r.demo);
        } catch (e) {
          botao.disabled = false;
          avisar(e.message, 'mau');
        }
      },
    }),
    el('p', { class: 'miudo', style: 'margin-top:12px', texto:
      'Usamos o email só para isto. Não enviamos publicidade.' }));
}

/**
 * O segundo passo: escrever o código.
 *
 * É um código para escrever, e não uma ligação para clicar, porque dentro de
 * uma app instalada no iOS uma ligação de email abre no Safari — que é outro
 * armazenamento — e a pessoa fica com sessão iniciada no sítio errado.
 */
function pedirCodigo(email, demo = false) {
  const painel = abrirPainel('Escreve o código');
  painel.append(
    el('p', { class: 'subtexto', html: demo
      ? `Nesta demonstração não sai email nenhum — o código é <b>000000</b>.`
      : `Enviámos um código de seis algarismos para <b>${seguro(email)}</b>. `
        + 'Vale 15 minutos.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Código' }),
      el('input', {
        id: 'campo-codigo', type: 'text', inputmode: 'numeric',
        autocomplete: 'one-time-code', maxlength: '6',
        placeholder: '000000', class: 'campo-codigo',
      })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Confirmar',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        /* O email mostra o código em dois grupos de três: quem o copiar de
           lá traz o espaço no meio, e a app dizia-lhe que o código tem seis
           algarismos — que era o que ele tinha. Tira-se tudo o que não for
           algarismo antes de contar. */
        const codigo = $('#campo-codigo').value.replace(/\D/g, '');
        if (codigo.length !== 6) { avisar('O código tem seis algarismos.', 'mau'); return; }
        botao.disabled = true;
        try {
          const r = await api.confirmarEmail(email, codigo);

          /* Aqui estava o defeito mais caro do produto: esta resposta era
             deitada fora. Traz o cliente, o segredo do aparelho e uma
             sessão — é com isto que um telemóvel novo se levanta como sendo
             o antigo. Sem a guardar, a app colava o email à conta vazia
             local, dizia «os cartões já não se perdem», e a carteira ficava
             na mesma. Estava prometido nas boas-vindas, no perfil e no
             próprio email que sai daqui. */
          const trocou = r && r.cliente && r.cliente.id !== estado.cliente?.id;

          /* OS CARTÕES DESTE TELEMÓVEL NÃO SE DEITAM FORA, e era o que
             acontecia. Quando a morada já pertencia a outra conta, a app
             trocava de conta e dizia «Cartões recuperados: N» — e os cartões
             que estavam AQUI, na conta local, ficavam para trás sem que uma
             única palavra o dissesse. Quem tivesse andado a juntar carimbos
             neste telemóvel antes de guardar a conta perdia-os no gesto que
             lhe prometia o contrário.

             Guarda-se a sessão antiga ANTES de a substituir: é ela a prova de
             que esta conta também é desta pessoa, e sem ela não há por onde
             juntar as duas depois. */
          const sessaoAntiga = ler('sessao');
          const cartoesDaqui = trocou ? (estado.cartoes || []).length : 0;

          if (r && r.cliente) {
            if (r.segredo) await guardarSegredo(r.segredo);
            if (r.sessao) guardar('sessao', r.sessao);
            if (r.horaDoServidor) guardarDesvio(r.horaDoServidor);
            estado.cliente = r.cliente;
            guardar('cliente', r.cliente);
            estado.cartoes = await api.cartoes(r.cliente.id);
            /* A lista de portas mudou — acabou de nascer uma. Sem isto, o
               perfil continuava a dizer «Guardar a conta». */
            await carregarIdentidades();
          } else {
            estado.cliente = { ...estado.cliente, email };
            guardar('cliente', estado.cliente);
          }

          if (trocou && cartoesDaqui > 0 && sessaoAntiga) {
            juntarContas({ sessaoAntiga, quantos: cartoesDaqui });
            return;
          }

          fecharPainel();
          if (RECARREGAR_DEPOIS) { location.reload(); return; }
          avisar(trocou
            ? `Cartões recuperados: ${estado.cartoes.length}.`
            : 'Conta guardada. Os cartões já não se perdem.', 'bom');
          irPara(trocou ? 'carteira' : 'perfil');
        } catch (e) {
          botao.disabled = false;
          avisar(e.message, 'mau');
        }
      },
    }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
      texto: 'Não recebi — enviar outra vez',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.disabled = true;
        let r;
        try {
          r = await api.guardarEmail(email);
        } catch (e) {
          botao.disabled = false;
          avisar(e.message || 'Não deu para pedir outro código.', 'mau');
          return;
        }
        botao.disabled = false;
        /* Três respostas, porque há três situações e dizer «Enviámos outro»
           às três é mentir a duas delas. Na demonstração não sai email
           nenhum — dizer que saiu manda a pessoa esperar por uma coisa que
           nunca chega, e a demonstração é justamente onde ela está a
           aprender como o produto funciona. */
        if (r && r.demo) {
          avisar('Nesta demonstração não sai email. O código é 000000.', 'neutro');
        } else if (r && r.enviado === false) {
          avisar('Continua sem dar. Tenta daqui a pouco.', 'mau');
        } else {
          avisar('Enviámos outro.', 'bom');
        }
      } }));
  const campo = $('#campo-codigo');
  /* Limpa a colagem, aceita a sugestão do teclado, e confirma sozinho quando
     os seis algarismos lá estiverem — ver `prepararCampoDeCodigo`. O botão é
     procurado na altura e não agora: o painel ainda está a ser montado. */
  prepararCampoDeCodigo(campo, () => painel.querySelector('.btn-cheio')?.click());
  setTimeout(() => campo.focus(), 120);
}

async function exportarDados() {
  /* Anunciar «Ficheiro descarregado» sem saber se foi é pior do que não
     dizer nada: a pessoa vai procurar às transferências um ficheiro que
     não existe, e conclui que o telemóvel é que está estranho. */
  try {
    const dados = await api.exportar(estado.cliente.id);
    const texto = JSON.stringify(dados, null, 2);
    const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
    const a = el('a', { href: url, download: 'carimbo-digital-os-meus-dados.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    avisar('Ficheiro descarregado.', 'bom');
  } catch (e) {
    avisar(e.message || 'Não deu para preparar o ficheiro.', 'mau');
  }
}

function apagarConta() {
  const painel = abrirPainel('Apagar a conta');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Apaga a conta, os cartões, os carimbos e o '
      + 'histórico. Não há forma de recuperar.' }),
    /* O que NÃO desaparece, dito antes e não depois. Um passe na Carteira do
       iPhone não tem serviço web do nosso lado: fica no telemóvel com o saldo
       velho e deixa de carimbar, e nós não temos por onde lhe tocar. Quem
       apaga a conta merece saber o que fica para trás. */
    el('p', { class: 'miudo', style: 'margin-bottom:8px', texto:
      'Se guardaste cartões na Carteira do iPhone, apaga-os também lá — esses '
      + 'ficam no telemóvel e nós não conseguimos tirá-los.' }),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', style: 'margin-top:8px',
      texto: 'Apagar tudo, definitivamente',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.disabled = true;
        botao.textContent = 'A apagar…';
        try {
          await api.apagarTudo(estado.cliente.id);
        } catch (e) {
          /* Não se limpa nada se o servidor não confirmou. Apagar em local
             o que continua a existir em remoto deixa a pessoa sem forma de
             lá voltar, e com os dados na mesma — o pior dos dois mundos. */
          botao.disabled = false;
          botao.textContent = 'Apagar tudo, definitivamente';
          avisar(e.message || 'Não deu para apagar. Tenta outra vez.', 'mau');
          return;
        }
        await esquecerSegredo();
        /* TODAS AS CHAVES, e não as que nos lembrarmos. «Não há forma de
           recuperar» é uma promessa sobre o que fica no telemóvel tanto como
           sobre o que fica no servidor.

           Duas destas faltavam, e as duas foram encontradas depois de o texto
           já estar escrito: a lista de IDENTIDADES tem lá dentro a morada de
           email — o único dado pessoal que esta app chega a guardar — e foi a
           bateria que a apanhou; e a lista de CARTÕES tem os nomes dos cafés e
           os carimbos de cada um, e sobreviveu ao apagamento até se olhar para
           o armazenamento a seguir a carregar no botão. O teste perguntava
           pelo email, e só pelo email, por isso só o email estava coberto. */
        for (const chave of ['cliente', 'sessao', 'cartoes', 'desvio', 'visto-bv',
                             'sessao-por-juntar', 'identidades', CHAVE_ENTRADA]) {
          apagar(chave);
        }
        location.reload();
      },
    }),
    el('button', { class: 'btn btn-fantasma btn-bloco', texto: 'Afinal não', aoClick: fecharPainel }));
}

/* =========================================================================
   O código
   O ecrã mais importante da app: é o que se mostra ao balcão. Fundo branco
   sempre, o mais brilhante possível, o código grande e o número por baixo
   para quando a câmara não colabora.
   ========================================================================= */

let cronometroCodigo = null;
let travaEcra = null;

/* A volta completa do anel do tempo, em unidades do `viewBox`: 2π × 19.
   Vive aqui porque é usada em DOIS sítios — no `stroke-dasharray` que desenha
   o anel e no `pintar()` que o roda — e dois números iguais escritos à mão em
   sítios diferentes afastam-se ao primeiro que mudar. Quando isso acontece o
   anel deixa de fechar a volta, e não há erro nenhum: fica só errado. */
const VOLTA_DO_ANEL = (2 * Math.PI * 19).toFixed(2);

let soltarCodigo = null;

async function abrirCodigo({ resgate = false, premio = null } = {}) {
  if ($('#folha-codigo')) return;
  empurrarHistorico('codigo');

  const folha = el('div', { id: 'folha-codigo', class: 'codigo-folha', role: 'dialog',
                            'aria-modal': 'true',
                            'aria-label': resgate ? 'Levantar prémio' : 'O meu código' },
    /* O FECHAR E O TEMPO SÃO A MESMA PEÇA, e eram duas.

       Havia um «X» num círculo cinzento à esquerda e o anel do tempo à
       direita — duas rodas do mesmo tamanho nos dois cantos, a disputar o
       olho, num ecrã que tem uma coisa só para mostrar. O anel passa a ser o
       botão, com o «X» no meio: o contorno conta o tempo, o centro fecha.

       O alvo continua a ter 44 px e o `aria-label` continua a dizer «Fechar»
       — quem não vê o anel não perde nada, e quem o vê ganha o canto
       esquerdo de volta para o título. O «Fechar» grande lá em baixo também
       não saiu: fechar nunca depende de descobrir que a roda é um botão. */
    el('div', { class: 'codigo-topo' },
      el('div', { style: 'flex:1' },
        el('div', { style: 'font-weight:700;font-size:1rem' , texto: 'Mostra ao balcão' }),
        el('div', { style: 'font-size:.8125rem;color:#5B5966', texto: 'O código muda a cada 15 segundos' })),
      /* O anel vai por innerHTML: document.createElement('svg') devolve um
         HTMLUnknownElement — um SVG só nasce por createElementNS ou a partir
         de HTML analisado. Nasce sem nada e nunca se vê.

         O raio é 19 e não 13: o círculo cresceu para caber o «X» lá dentro
         sem o encostar ao traço. A circunferência (2π × 19 = 119,38) está no
         `stroke-dasharray` E no cálculo do `pintar()` — se um mudar sem o
         outro, o anel deixa de fechar a volta e ninguém dá por isso. */
      el('button', { class: 'codigo-fechar', 'aria-label': 'Fechar',
                     aoClick: fecharCodigo, html:
        '<svg class="codigo-anel" viewBox="0 0 44 44" aria-hidden="true">'
        + '<circle class="fundo" cx="22" cy="22" r="19"/>'
        + '<circle class="frente" cx="22" cy="22" r="19" '
        + `stroke-dasharray="${VOLTA_DO_ANEL}" stroke-dashoffset="0"/></svg>`
        + `<span class="codigo-fechar-x">${icone('fechar', { tamanho: 18 })}</span>` })),
    el('div', { class: 'codigo-meio' },
      el('div', { class: 'codigo-qr', id: 'codigo-qr' }),
      el('div', { class: 'codigo-id selecionavel', texto: estado.cliente.publico }),
      el('p', { class: 'codigo-dica', texto: 'Se a câmara não ler, o balcão pode escrever este número.' })),
    el('div', { style: 'padding-bottom:8px' },
      el('button', { class: 'btn btn-suave btn-bloco', texto: 'Fechar', aoClick: fecharCodigo })));

  const anel = folha.querySelector('.codigo-anel');

  document.body.append(folha);
  /* A folha do código é o ecrã que mais tempo fica aberto — e era o único
     que não ouvia o Escape de todo. */
  soltarCodigo = prenderFoco(folha, { aoEscapar: () => fecharCodigo() });
  travaEcra = await manterEcraAceso();

  async function pintar() {
    /* `gerarCodigo` assina com HMAC, e isso é mesmo assíncrono. Quem fechar
       a folha durante essa espera deixa este código a escrever num
       `#codigo-qr` que já não existe — «Cannot set properties of null», uma
       excepção por apanhar que ninguém vê e que só aparece em máquinas
       lentas, onde a janela é maior. O `clearTimeout` do fechar não a
       apanha: o ciclo já estava dentro do await.

       Guarda-se o nó ANTES de esperar e confirma-se que ainda está no
       documento depois. É o mesmo padrão do `ev.currentTarget` e do arranque
       da câmara — em três sítios diferentes, a mesma armadilha. */
    const destino = $('#codigo-qr');
    const { texto, expiraEm } = await gerarCodigo(estado.cliente.publico, { resgate });
    if (!destino.isConnected) return expiraEm;
    destino.innerHTML = qrParaSVG(texto, { nivel: 'Q', margem: 2 });
    const restante = Math.max(0, expiraEm - Date.now()) / 1000;
    const arco = anel.querySelector('.frente');
    if (!arco) return expiraEm;
    arco.style.transition = 'none';
    arco.style.strokeDashoffset = String(VOLTA_DO_ANEL * (1 - restante / JANELA));
    requestAnimationFrame(() => {
      arco.style.transition = `stroke-dashoffset ${restante}s linear`;
      arco.style.strokeDashoffset = String(VOLTA_DO_ANEL);
    });
    return expiraEm;
  }

  async function ciclo() {
    const expiraEm = await pintar();
    /* E não se marca a volta seguinte se a folha já fechou, senão fica um
       relógio a rodar por cima de um ecrã que não existe. */
    if (!folha.isConnected) return;
    cronometroCodigo = setTimeout(ciclo, Math.max(300, expiraEm - Date.now() + 60));
  }
  ciclo();

  /* Ao voltar ao separador, o código pode estar velho: refaz-se já. */
  document.addEventListener('visibilitychange', aoVoltar);
}

function aoVoltar() {
  if (document.visibilityState === 'visible' && $('#folha-codigo')) {
    clearTimeout(cronometroCodigo);
    fecharCodigo();
    abrirCodigo();
  }
}

function fecharCodigo({ historico = true } = {}) {
  const havia = Boolean($('#folha-codigo'));
  if (soltarCodigo) { soltarCodigo(); soltarCodigo = null; }
  clearTimeout(cronometroCodigo);
  cronometroCodigo = null;
  document.removeEventListener('visibilitychange', aoVoltar);
  try { travaEcra?.release(); } catch { /* nada */ }
  travaEcra = null;
  $('#folha-codigo')?.remove();
  if (havia && historico) recuar();
}

/* =========================================================================
   Painel deslizante
   ========================================================================= */

let soltarPainel = null;

function abrirPainel(titulo) {
  /* Se já estava um painel aberto, a entrada dele serve para este: o que a
     pessoa vê continua a ser um painel, e um «voltar» tem de o fechar. A
     empurrar outra vez ficavam duas entradas para um painel só, e o
     primeiro «voltar» não fazia nada visível. */
  const jaHavia = Boolean($('#painel'));
  fecharPainel({ historico: false });
  if (!jaHavia) empurrarHistorico('painel');
  const folha = el('div', { class: 'painel-folha', role: 'dialog', 'aria-modal': 'true',
                            'aria-label': titulo },
    el('div', { class: 'painel-pega' }),
    el('h2', { style: 'margin-bottom:12px', texto: titulo }));
  const painel = el('div', { class: 'painel', id: 'painel' },
    el('div', { class: 'painel-veu', aoClick: fecharPainel }), folha);
  document.body.append(painel);
  /* O Escape passa a ser tratado pelo prenderFoco, junto com a prisão do
     Tab e a devolução do foco — as quatro coisas que um `aria-modal="true"`
     promete e que nenhuma acontecia. */
  soltarPainel = prenderFoco(folha, { aoEscapar: () => fecharPainel() });
  return folha;
}
function fecharPainel({ historico = true } = {}) {
  const havia = Boolean($('#painel'));
  if (soltarPainel) { soltarPainel(); soltarPainel = null; }
  $('#painel')?.remove();
  /* Fechar pelo botão ou pela tecla também tem de comer a entrada que a
     abertura empurrou, senão fica um passo fantasma no histórico e o
     primeiro «voltar» a seguir não faz nada visível. */
  if (havia && historico) recuar();
}

/* =========================================================================
   Navegação
   ========================================================================= */

/* O ecrã do último F5, guardado por separador. O nome leva o `-app` porque a
   app e o balcão partilham a origem: sem isso, quem tem as duas abertas no
   mesmo telemóvel via o ecrã de uma a mandar na outra. */
const CHAVE_ECRA = 'ecra-app';

/* TRÊS SEPARADORES, E NÃO CINCO.

   Saíram o «Descobrir» e os «Prémios», e as razões são diferentes.

   O DESCOBRIR era uma montra: uma lista de sítios que já usam isto, com mapa.
   Um cartão passa a ganhar-se de uma maneira só — apontando a câmara ao
   cartaz que está no estabelecimento — e essa é a que corresponde à vida: a
   pessoa está lá, com o café à frente. Procurar cafés numa app para depois lá
   ir era o produto a fingir que era um directório.

   OS PRÉMIOS eram uma segunda casa para uma coisa que já vivia no cartão. De
   seis coisas que aquele ecrã mostrava, cinco estavam também na carteira ou no
   cartão; a única que se perde é a lista dos prémios já levantados, cruzada
   entre sítios. É pouco, e ganha-se um pedido ao servidor por cartão em cada
   visita à app.

   A BARRA NASCE DAQUI e o CSS não assume posição nenhuma (`.barra-item` é
   `flex: 1`), por isso tirar duas entradas chega para a barra. O que NÃO chega
   é o resto: o `irPara` cai num ramo de omissão que pinta o ecrã do cartão, e
   por isso qualquer chamada a um ecrã que já não existe falharia em silêncio,
   com o topo em branco. Elas foram todas atrás — ver o estado vazio da
   carteira, aqui em cima. */
const ECRAS = {
  carteira:  { titulo: 'Carimbo Digital', icone: 'carteira', rotulo: 'Carteira', render: ecraCarteira },
  codigo:    { titulo: 'Código',          icone: 'qr',       rotulo: 'Código' },
  perfil:    { titulo: 'Perfil',          icone: 'pessoa',   rotulo: 'Perfil',   render: ecraPerfil },
};

function base() {
  return (globalThis.CARIMBO_CONFIG && globalThis.CARIMBO_CONFIG.base) || '';
}

/* =========================================================================
   O botão de voltar

   Numa PWA instalada no Android o gesto de voltar é o botão do sistema, e
   sem isto ele FECHAVA A APP — mesmo com um painel aberto por cima. A pessoa
   abria o código, carregava em voltar para o fechar, e ficava no ecrã
   principal do telemóvel.

   O modelo é o mais simples que funciona: cada ecrã é uma entrada no
   histórico, e cada coisa que se abre por cima (painel, folha do código) é
   outra. Voltar desfaz a última — fecha o que está aberto, ou recua um ecrã.
   ========================================================================= */

/* O browser guarda a posição da página em cada entrada do histórico e
   repõe-na sozinho — `scrollRestoration` vale «auto» por omissão. Com uma
   app de um só documento isso trabalha contra nós: mandava-se a página ao
   topo e o browser fazia-a descer outra vez uns pixéis, para onde ela
   estava no ecrã anterior. Quem manda aqui somos nós. */
try { history.scrollRestoration = 'manual'; } catch { /* nem sempre existe */ }

function empurrarHistorico(marca) {
  try { history.pushState({ carimbo: marca }, ''); } catch { /* sem histórico */ }
}

/* Fechar um painel pelo botão também recua no histórico, para não deixar
   uma entrada fantasma. Mas esse recuo dispara `popstate` — e o painel já
   foi removido, por isso o tratador não o vê e navegaria de ecrã por cima.
   Conta-se quantos recuos são nossos, e ignoram-se. */
let recuosNossos = 0;

addEventListener('popstate', () => {
  if (recuosNossos > 0) { recuosNossos--; return; }
  /* Primeiro o que está por cima. Só quando não há nada aberto é que se
     recua de ecrã — de outra forma, voltar com um painel aberto saltava o
     painel e o ecrã de uma vez. */
  if ($('#folha-codigo')) { fecharCodigo({ historico: false }); return; }
  if ($('#painel')) { fecharPainel({ historico: false }); return; }
  if (estado.ecra && estado.ecra !== 'carteira') irPara('carteira', { historico: false });
});

/** Desfaz a entrada que uma abertura tinha empurrado. */
function recuar() {
  recuosNossos++;
  try { history.back(); } catch { recuosNossos--; }
}

async function irPara(nome, { historico = true } = {}) {
  if (nome === 'codigo') { abrirCodigo(); return; }
  if (historico && estado.ecra && estado.ecra !== nome) empurrarHistorico(`ecra:${nome}`);
  estado.ecra = nome;
  /* Onde a pessoa está, guardado no SEPARADOR. Um F5 deixava-a sempre na
     carteira, mesmo que estivesse nos prémios há dois segundos — e num
     telemóvel, onde recarregar é um gesto que se faz sem querer, isso é
     perder o sítio de cada vez. Não vai ao `localStorage`: abrir a app daqui
     a três semanas deve abrir na carteira, e não onde ela ficou. */
  guardarNoSeparador(CHAVE_ECRA, nome);

  /* Cada pintura recebe um `<main>` NOVO, que substitui o anterior.

     Antes desenhava-se tudo no mesmo elemento: dois toques seguidos na barra
     punham as duas pinturas a escrever no mesmo sítio, e ficavam os dois
     ecrãs empilhados — «Prémios» no topo com o Descobrir por dentro.

     O elemento novo entra no documento já com o id, e o velho sai na mesma
     linha: nunca há dois. Uma pintura atrasada continua a escrever no seu,
     que já não está em lado nenhum — e o que ela faz não se vê.

     Tinha começado por embrulhar isto numa caixa `.ecra` por dentro do
     `#principal`. Funcionava e partia tudo o que fosse `#principal > algo`:
     um filho directo deixa de o ser quando se lhe põe um pai. */
  /* O `#principal` está no HTML e existe quase sempre — mas não sempre: o
     apanhador de erros do arranque substitui o `body` inteiro por uma
     mensagem, e a partir daí não há `#principal` nenhum. Um `popstate` que
     chegue depois disso não pode rebentar por cima do erro que já aconteceu. */
  const velho = $('#principal');
  if (!velho) return;
  const principal = el('main', { id: 'principal', class: 'coluna', tabindex: '-1' });
  velho.replaceWith(principal);
  window.scrollTo({ top: 0, behavior: 'instant' });

  const ecra = ECRAS[nome] || { titulo: '', render: ecraCartao };
  $('#topo-titulo').textContent = nome === 'cartao' ? '' : ecra.titulo;
  desenharBarra();

  /* Cada pintura leva um número. Pintar espera por dados, e quem trocar de
     separador durante essa espera fica com o desenho atrasado a assentar no
     ecrã seguinte — dois toques seguidos davam «Prémios» no topo com a
     carteira por dentro. Se o número mudou, o que se estava a desenhar já
     não interessa a ninguém. */
  const geracao = ++estado.geracao;

  /* Pintar um ecrã pode falhar — a rede cai a meio, o servidor responde
     mal. Sem isto, a promessa morria em silêncio, o `principal` ficava
     vazio, e a pessoa via um ecrã em branco sem uma palavra e sem forma de
     tentar outra vez. Um erro tem de se ver. */
  try {
    if (nome === 'cartao') {
      principal.append(el('button', {
        class: 'btn btn-fantasma voltar', html: icone('volta', { tamanho: 18 }) + '<span>Carteira</span>',
        aoClick: () => irPara('carteira'),
      }));
      await ecraCartao(principal);
    } else {
      await ecra.render(principal);
    }
  } catch (erro) {
    if (geracao !== estado.geracao) return;
    principal.innerHTML = '';
    principal.append(ecraFalhou(nome, erro));
  }
  if (geracao !== estado.geracao) return;
  /* Ao topo outra vez, agora que o conteúdo existe: a primeira volta corre
     com a coluna vazia e a página desce sozinha quando ela enche. */
  window.scrollTo({ top: 0, behavior: 'instant' });
  /* MAS NÃO SE ROUBA O FOCO A UM PAINEL ABERTO. Isto repinta-se por baixo de
     um modal — desligar uma porta da conta repinta o perfil e volta ao painel
     — e um `focus()` no `<main>` atira o foco para fora de um diálogo que
     promete `aria-modal="true"`, para um ecrã tapado pelo véu. Quem vê não dá
     por nada; quem ouve fica no sítio errado. */
  if (!$('#painel')) principal.focus({ preventScroll: true });
}

/**
 * O que fica no lugar de um ecrã que não deu para pintar.
 *
 * Nem sempre é falta de rede: pode ser o servidor a responder mal, ou uma
 * resposta com uma forma inesperada. Por isso não diz «estás offline» —
 * diz o que aconteceu e dá um botão para tentar outra vez, que é o que a
 * pessoa ia fazer de qualquer maneira.
 */
function ecraFalhou(nome, erro) {
  return el('div', { class: 'vazio' },
    el('div', { class: 'vazio-desenho', html: icone('ligacao', { tamanho: 64 }) }),
    el('h2', { texto: 'Não deu para carregar' }),
    el('p', { class: 'subtexto',
      texto: 'Verifica a ligação e tenta outra vez. Os teus cartões estão guardados.' }),
    el('button', {
      class: 'btn btn-cheio', texto: 'Tentar outra vez',
      aoClick: () => irPara(nome),
    }),
    el('p', { class: 'miudo', style: 'margin-top:12px', texto: erro?.message || '' }));
}

function desenharBarra() {
  const barra = $('#barra');
  barra.innerHTML = '';
  for (const [nome, e] of Object.entries(ECRAS)) {
    const atual = nome === estado.ecra;
    const botao = el('button', {
      class: 'barra-item', type: 'button',
      'aria-current': atual ? 'page' : null,
      /* O NOME DO ECRÃ NO PRÓPRIO BOTÃO. Não é para o produto — é para quem o
         mede. A bateria apontava aos separadores por POSIÇÃO
         (`.barra-item:nth-child(5)` era o Perfil), e no dia em que dois
         separadores saíram, oito módulos rebentaram de uma vez por causa de um
         número. Falharam alto, que foi a sorte; uma afirmação que indexe por
         posição tanto pode rebentar como passar a medir o separador do lado, em
         silêncio. Com o nome escrito, a posição deixa de ser assunto. */
      'data-ecra': nome,
      aoClick: () => irPara(nome),
    },
      /* O ÍCONE VAI NUM `<span>` SEU e não solto no botão, porque a pastilha do
         separador activo é um `::before` POSICIONADO — e um elemento
         posicionado pinta por cima do conteúdo em linha que vem antes dele.
         Sem esta caixa, a pastilha tapava o ícone que devia estar a destacar. */
      el('span', { class: 'barra-icone', html: icone(e.icone, { tamanho: 24 }) }),
      /* O NOME DEIXOU DE SE VER, MAS NÃO DEIXOU DE EXISTIR.

         A barra passou a ser só ícones. Um botão que não tem texto nenhum lá
         dentro não tem nome acessível: um leitor de ecrã anuncia «botão» três
         vezes e a pessoa fica a adivinhar. O texto continua cá, escondido aos
         olhos e não à árvore de acessibilidade — que é a diferença entre esta
         classe e um `display: none`, que esconderia aos dois.

         Vai em texto a sério e não num `aria-label` de propósito: um nome que
         é conteúdo do botão é o mesmo nome que a bateria lê, e é o que
         sobrevive a alguém mudar a palavra num sítio só. */
      el('span', { class: 'so-leitor', texto: e.rotulo }));
    barra.append(botao);
  }
}

/* =========================================================================
   Tema
   ========================================================================= */

const SISTEMA_ESCURO = matchMedia('(prefers-color-scheme: dark)');

/**
 * Aplica o tema — e não só às nossas cores.
 *
 * Escolher «escuro» num telemóvel em claro trocava as cores da app e mais
 * nada: a `color-scheme` ficava em `light dark`, por isso as superfícies que
 * o browser pinta sozinho — campos nativos, barras de deslocamento, o menu
 * de um `<select>` — continuavam brancas no meio de um ecrã preto. E a faixa
 * do sistema no topo do telemóvel (theme-color) seguia o telemóvel e não a
 * escolha, com as duas metas presas a `prefers-color-scheme`.
 */
function aplicarTema() {
  const t = ler('tema', 'sistema');
  if (t === 'sistema') delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = t;

  const escuro = t === 'escuro' || (t === 'sistema' && SISTEMA_ESCURO.matches);

  document.documentElement.style.colorScheme = t === 'sistema'
    ? 'light dark' : (escuro ? 'dark' : 'light');

  /* À CABEÇA DO `<head>`, E NÃO NO FIM. O comentário que aqui estava dizia que
     uma meta sem `media` ganha às outras — e é ao contrário. A norma manda
     percorrer as metas `theme-color` POR ORDEM DE ÁRVORE e usar a PRIMEIRA
     cuja `media` case com o ambiente. As duas do `index.html` estão presas a
     `prefers-color-scheme` e vêm antes; uma delas casa sempre, e esta,
     acrescentada no fim, nunca era alcançada.

     Consequência: com uma escolha que CONTRARIE o telemóvel — escuro escolhido
     num telemóvel claro — o ecrã ficava escuro e a faixa do sistema ficava
     clara. Exactamente nos dois casos em que esta função existe para mandar. */
  let faixa = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!faixa) {
    faixa = document.createElement('meta');
    faixa.setAttribute('name', 'theme-color');
  }
  faixa.setAttribute('content', escuro ? '#0E0D12' : '#FBFAF7');
  if (document.head.firstChild !== faixa) document.head.prepend(faixa);
}

/* Com o tema em «sistema», mudar o telemóvel de claro para escuro trocava as
   cores na hora — e o ícone do botão ficava preso no estado anterior, porque
   ninguém voltava a chamar isto. */
SISTEMA_ESCURO.addEventListener('change', () => {
  if (ler('tema', 'sistema') === 'sistema') aplicarTema();
});

/* =========================================================================
   Primeira abertura
   ========================================================================= */

const PASSOS = [
  { t: 'Os cartões de sempre.<br>Sem o papel.',
    c: 'Aquele cartão do café que está sempre em casa quando é preciso — agora está aqui, e nunca se perde.' },
  { t: 'Um código.<br>Todos os cartões.',
    c: 'Não é um código por sítio. É um só, teu. O balcão aponta a câmara e o carimbo aparece.' },
  { t: 'Sem conta,<br>sem dados a mais.',
    c: 'Não pedimos nome, telefone nem morada. Começas a usar já — e podes apagar tudo quando quiseres.' },
];

function boasVindas() {
  let passo = 0;
  const caixa = $('#boas-vindas');
  caixa.hidden = false;

  const palco = caixa.querySelector('.bv-cartoes');
  const amostras = [
    { nome: 'Café Torrado', tipo: 'Cartão do café', cor: '#3B2417', selo: 'chavena',
      feitos: 7, total: 10, rotulo: 'faltam 3 carimbos', premio: 'Um café por conta da casa' },
    { nome: 'Barbearia Navalha', tipo: 'Corte a corte', cor: '#12232E', selo: 'navalha',
      feitos: 6, total: 8, rotulo: 'faltam 2 carimbos', premio: 'Corte + barba grátis' },
    { nome: 'Gelataria Luar', tipo: 'Bola a bola', cor: '#5AAEE0', selo: 'gelado',
      feitos: 9, total: 9, rotulo: 'Pronto a levantar', premio: 'Taça de três bolas' },
  ];
  amostras.forEach((a, i) => {
    const c = el('div', { class: 'cartao bv-cartao', estilo: { '--i': String(i) } },
      el('div', { class: 'cartao-corpo' },
        el('div', { class: 'cartao-topo' },
          el('div', { class: 'cartao-marca' },
            el('div', { class: 'cartao-nome', texto: a.nome }),
            el('div', { class: 'cartao-tipo', texto: a.tipo })),
          el('div', { class: 'cartao-id' },
            el('span', { texto: 'cartão' }),
            el('b', { texto: 'EA4BFM' }))),
        /* Cinco colunas em todos, mesmo quando o cartão é de oito ou de nove:
           assim os três ficam com duas linhas e exactamente a mesma altura, e
           o baralho não fica com um cartão a espreitar mais do que os outros. */
        el('div', {
          class: 'carimbos', estilo: { '--colunas': '5' },
          html: Array.from({ length: a.total }, (_, k) =>
            `<div class="carimbo" data-estado="${k < a.feitos ? 'cheio' : 'vazio'}" `
            + `style="--inclina:${((k * 37) % 9) - 4}deg">`
            + icone(a.selo, { tipo: 'cheio', tamanho: 24 }) + '</div>').join(''),
        }),
        el('div', { class: 'cartao-rodape' },
          el('div', {},
            el('div', { class: 'cartao-rotulo', texto: a.rotulo }),
            el('div', { class: 'cartao-premio', texto: a.premio })))));
    pintarCartao(c, a.cor);
    palco.append(c);
  });

  const pontos = caixa.querySelector('.bv-pontos');
  PASSOS.forEach((_, i) => pontos.append(el('span', { class: 'bv-ponto', 'data-ativo': i === 0 ? 'sim' : 'nao' })));

  function pintar() {
    caixa.querySelector('#bv-titulo').innerHTML = PASSOS[passo].t;
    caixa.querySelector('#bv-corpo').textContent = PASSOS[passo].c;
    caixa.querySelectorAll('.bv-ponto').forEach((p, i) => { p.dataset.ativo = i === passo ? 'sim' : 'nao'; });
    const anuncio = caixa.querySelector('#bv-passo');
    if (anuncio) anuncio.textContent = `Passo ${passo + 1} de ${PASSOS.length}`;
    caixa.querySelector('#bv-seguinte').textContent =
      passo === PASSOS.length - 1 ? 'Começar' : 'Continuar';
    palco.dataset.passo = String(passo);
  }

  caixa.querySelector('#bv-seguinte').addEventListener('click', async () => {
    if (passo < PASSOS.length - 1) { passo++; pintar(); vibrar(8); return; }
    guardar('visto-bv', true);
    caixa.hidden = true;
    try {
      await entrar();
      /* Também aqui, e não só para quem já conhece a app: quem chega pelo
         cartaz de um café é, por definição, quem nunca a abriu. O convite
         ficava a ser lido apenas no ramo de quem já tinha visto as
         boas-vindas — ou seja, nunca para o público a que o cartaz se
         dirige. */
      await seguirConvite();
    } catch (e) { console.error(e); ecraSemLigacao(e); }
  });

  /* «Já tenho conta noutro telemóvel» dava um aviso e mais nada — e o aviso
     mandava a pessoa fazer no telemóvel antigo uma coisa que ela pode já ter
     feito. Agora que a recuperação funciona de verdade, o botão abre-a — e
     abre as duas portas de uma vez, porque é o mesmo painel: entrar com a
     Google, ou escrever a morada e o código que chega ao email. */
  /* NA DEMONSTRAÇÃO TAMBÉM SE ABRE. Aqui dava um aviso e ficava tudo como
     estava — e este é, de todos, o ecrã que mais falta faz ver antes de se
     precisar dele: é o que aparece a quem mudou de telemóvel. Um beco na
     demonstração é ensinar que a app não tem por onde voltar. O painel abre,
     e é ele que diz, por escrito, que aqui não há nada a sério do outro lado. */
  caixa.querySelector('#bv-saltar').addEventListener('click', async () => {
    guardar('visto-bv', true);
    caixa.hidden = true;
    try { await entrar(); }
    catch (e) { console.error(e); ecraSemLigacao(e); return; }
    recuperarConta();
  });
  pintar();
}

/* =========================================================================
   Arranque
   ========================================================================= */

/**
 * O ecrã de quando não há ligação.
 *
 * Antes disto, se a API não respondesse a app ficava simplesmente em branco:
 * o registo falhava dentro de um clique, a promessa morria sozinha e não
 * aparecia nada. Um ecrã em branco é o pior erro possível — ninguém sabe se
 * é a rede, o telemóvel ou a app.
 */
function ecraSemLigacao(erro) {
  $('#boas-vindas').hidden = true;
  $('#aplicacao').hidden = false;
  $('#topo-titulo').textContent = '';
  $('#barra').innerHTML = '';
  const principal = $('#principal');
  principal.innerHTML = '';

  /* O que a pessoa veio fazer é mostrar o código ao balcão — e para isso não
     precisa de nós. O código é gerado aqui, com o segredo que está no cofre
     do telemóvel. Este ecrã dizia «os teus cartões estão a salvo» e depois
     não dava caminho nenhum para lá chegar: um beco com uma frase simpática.
     Se houver conta e segredo, o botão do código aparece primeiro. */
  const podeMostrar = Boolean(estado.cliente?.publico || ler('cliente')?.publico);
  if (podeMostrar && !estado.cliente) estado.cliente = ler('cliente');

  principal.append(el('div', { class: 'vazio' },
    el('div', { class: 'vazio-desenho', html: icone('alerta', { tamanho: 96 }) }),
    el('h3', { texto: 'Sem ligação ao servidor' }),
    el('p', { texto: podeMostrar
      ? 'Podes mostrar o teu código na mesma — ele é feito no telemóvel e não '
        + 'precisa de Internet. O balcão carimba e o cartão actualiza-se quando '
        + 'a ligação voltar.'
      : 'Os teus cartões estão a salvo — é só a ligação que falta. '
        + 'Verifica a rede e tenta outra vez.' }),
    podeMostrar ? el('button', {
      class: 'btn btn-cheio btn-grande',
      html: icone('qr', { tamanho: 18 }) + '<span>Mostrar o meu código</span>',
      aoClick: () => abrirCodigo(),
    }) : null,
    el('button', {
      class: podeMostrar ? 'btn btn-contorno' : 'btn btn-cheio',
      style: podeMostrar ? 'margin-top:8px' : '',
      texto: 'Tentar outra vez',
      aoClick: () => location.reload(),
    }),
    el('p', { class: 'miudo', style: 'margin-top:8px', texto: erro?.message || '' })));
}

/**
 * A sessão acabou neste telemóvel.
 *
 * ISTO ERA UM BECO SEM SAÍDA, e o ecrã mentia no caminho. Uma sessão que já não
 * vale dava «Sem ligação ao servidor» — e a ligação estava óptima. A pessoa
 * carregava em «Tentar outra vez», a app recarregava, e como a conta e o
 * segredo continuavam guardados o arranque nunca voltava a registar-se: 401,
 * mesmo ecrã, para sempre. A única saída era limpar os dados do site, que
 * ninguém sabe fazer nem tem razão para adivinhar.
 *
 * O `api.js` já deitava fora o testemunho morto, com um comentário a dizer que
 * isso «devolve a app ao princípio, onde ela sabe registar-se de novo». Não
 * devolvia: o `entrar()` só se volta a registar quando FALTA a conta ou o
 * segredo, e aqui os dois estão lá. Meia correcção com um comentário inteiro.
 *
 * Passou a haver isto, que se tornou muito mais provável desde que existe o
 * «terminar sessão nos outros aparelhos»: é exactamente o que essa
 * funcionalidade faz aos outros telemóveis, e mandá-los para um ecrã que diz
 * «verifica a Internet» seria pôr a app a mentir por desenho.
 *
 * NÃO SE REGISTA UMA CONTA NOVA POR BAIXO. Era o atalho fácil e apagava a
 * pessoa: ficava com um número de cartão diferente e a carteira vazia, sem
 * nada que dissesse que os cartões antigos continuam a existir do outro lado.
 */
function ecraSessaoTerminada(cliente) {
  $('#topo-titulo').textContent = '';
  $('#barra').innerHTML = '';
  const principal = $('#principal');
  principal.innerHTML = '';

  /* AS IDENTIDADES VÊM DA CACHE, e é a única fonte possível: a sessão morreu,
     e perguntá-las ao servidor daria outro 401. É por isso que elas ficam
     guardadas em `localStorage` sempre que são lidas. */
  const identidades = ler('identidades', []) || [];
  const comEmail = temIdentidade('email', identidades) || Boolean(cliente?.email);
  const comGoogle = temIdentidade('google', identidades);
  const comApple = temIdentidade('apple', identidades);
  const porque = 'Pode ter sido por já ter passado muito tempo, ou porque terminaste a '
    + 'sessão a partir de outro aparelho. ';

  principal.append(el('div', { class: 'vazio' },
    el('div', { class: 'vazio-desenho', html: icone('cadeado', { tamanho: 96 }) }),
    el('h3', { texto: 'A sessão terminou neste telemóvel' }),
    el('p', { texto: comEmail || comGoogle || comApple
      ? `${porque}Entra outra vez e os cartões voltam.`
      : `${porque}Se guardaste a conta com um email, com a Google ou com a `
        + 'Apple, entra e os cartões voltam.' }),
    /* Os botões das portas só aparecem a quem entrou por elas — e quando
       existem, são eles os principais, porque são o caminho que aquela pessoa
       conhece. */
    comGoogle ? botaoDaPorta('google', (ev) => { RECARREGAR_DEPOIS = true; return iniciarGoogle(ev); }) : null,
    comApple ? botaoDaPorta('apple', (ev) => { RECARREGAR_DEPOIS = true; return iniciarGoogle(ev); }) : null,
    el('button', {
      class: comGoogle || comApple ? 'btn btn-contorno' : 'btn btn-cheio btn-grande',
      style: comGoogle || comApple ? 'margin-top:8px' : '',
      texto: 'Entrar com o email',
      aoClick: () => { RECARREGAR_DEPOIS = true; recuperarConta(); },
    }),
    el('button', {
      class: 'btn btn-contorno', style: 'margin-top:8px',
      texto: 'Começar de novo neste telemóvel',
      aoClick: comecarDeNovo,
    }),
    el('p', { class: 'miudo', style: 'margin-top:12px', texto:
      cliente?.publico ? `O número deste cartão era ${cliente.publico}.` : '' })));
}

/**
 * Tirar o email da conta.
 *
 * Diz o que se perde ANTES, e o que se perde é concreto: sem email guardado,
 * mudar de telemóvel passa a perder os cartões. Não é um aviso de rotina — é a
 * única coisa que aquele email fazia.
 */
function tirarEmail({ voltar = false } = {}) {
  /* Como no desligar da Google: volta-se para onde se veio, e só se ainda
     houver painel para onde voltar. */
  const daquiVolta = () => {
    if (!$('#painel')) return;
    if (voltar) guardarConta(); else fecharPainel();
  };
  /* O QUE SE PERDE DEPENDE DE HAVER OUTRA PORTA. Dizer «perdes os cartões» a
     quem tem a Google ligada é assustar por engano — e a frase existe
     justamente para não haver enganos. */
  const comGoogle = temIdentidade('google');
  const morada = moradaDaConta() || estado.cliente.email || '';
  const painel = abrirPainel('Tirar o email');
  painel.append(
    el('p', { class: 'subtexto', html:
      `Deixamos de ter <b>${seguro(morada)}</b> associado a esta conta.` }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html: comGoogle
        ? '<b>Os cartões e os carimbos ficam todos</b>, e continuas a poder '
          + 'entrar com a Google. Podes voltar a pôr um email quando quiseres.'
        : '<b>Os cartões e os carimbos ficam todos.</b> O que perdes é a forma de '
          + 'os recuperar noutro telemóvel: sem email guardado, se perderes este '
          + 'aparelho perdes os cartões.<br>Podes voltar a pôr um email quando '
          + 'quiseres.' })),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', texto: 'Tirar o email',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          await api.tirarEmail();
          estado.cliente = { ...estado.cliente, email: null };
          guardar('cliente', estado.cliente);
          await carregarIdentidades();
          avisar('Email retirado. Os cartões ficaram.', 'bom');
          await irPara('perfil');
          daquiVolta();
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para tirar.', 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: daquiVolta }));
}

/**
 * Recomeçar com um cartão vazio.
 *
 * Um painel e não um `confirm()` do browser: esta casa nunca usou um, e o do
 * browser aparece colado ao topo do ecrã com o nome do domínio por cima — num
 * telemóvel, parece um aviso do sistema e não uma pergunta da app.
 *
 * E diz-se o que se perde ANTES, porque isto não tem volta: quem não tiver
 * guardado a conta com um email fica sem caminho de regresso aos cartões
 * antigos, que continuam a existir do outro lado sem ninguém que lhes chegue.
 */
function comecarDeNovo() {
  const painel = abrirPainel('Começar de novo');
  painel.append(
    el('p', { class: 'subtexto', texto:
      'Este telemóvel passa a ter um cartão novo e vazio, com um número novo.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        '<b>Os cartões antigos não se apagam</b> — ficam onde estão. Mas só '
        + 'voltam a este telemóvel se voltares a entrar na conta deles: com a '
        + 'Google, ou com o email que lhes associaste. Se nunca guardaste a '
        + 'conta de nenhuma das duas formas, não há caminho de volta.' })),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', texto: 'Começar de novo',
      aoClick: async () => {
        apagar('cliente'); apagar('sessao'); apagar('cartoes');
        apagar('desvio'); apagar('sessao-por-juntar');
        apagar('identidades'); apagar(CHAVE_ENTRADA);
        await esquecerSegredo();
        location.reload();
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: fecharPainel }));
}

/* Quando a entrada se faz a partir do ecrã acima, a app não tem barra nem
   separadores montados — o `irPara` do fim da recuperação não teria para onde
   ir. Recarregar devolve uma app inteira e limpa, e custa um piscar de olhos. */
let RECARREGAR_DEPOIS = false;

async function entrar() {
  $('#aplicacao').hidden = false;
  let cliente = ler('cliente');

  /* O segredo vive no cofre (IndexedDB, chave não-extraível). Se o cliente
     está guardado mas o segredo desapareceu — janela privada, dados do site
     limpos — não vale a pena continuar com metade: recomeça-se. */
  if (!cliente || !(await temSegredo())) {
    const r = await api.registarCliente();
    cliente = r.cliente;
    await guardarSegredo(r.segredo);
    guardar('cliente', cliente);
    guardar('sessao', r.sessao);
    if (r.horaDoServidor) guardarDesvio(r.horaDoServidor);
    /* Na demonstração enche-se a carteira, senão vê-se um ecrã vazio e
       ninguém percebe o que a app faz. */
    if (MODO === 'demo') await api.semear(cliente.id);
  }
  estado.cliente = cliente;
  /* Os cartões ficam também em local. Não é cache por gosto: o momento em
     que a app é mais precisa é ao balcão, e o balcão de um café é
     exactamente onde a rede falha. O código QR é gerado no telemóvel, com o
     segredo que está no cofre — não precisa de servidor nenhum. Sem esta
     cópia, a app abria sem rede e não mostrava cartão nenhum, com um ecrã a
     dizer «os teus cartões estão a salvo». */
  try {
    estado.cartoes = await api.cartoes(cliente.id);
    guardar('cartoes', estado.cartoes);
  } catch (erro) {
    /* UM 401 NÃO É FALTA DE REDE, e era tratado como tal.
       Apanha OS DOIS arranques, e é por isso que não é preciso mais nada: no
       primeiro o testemunho morto ainda vai no cabeçalho e é recusado; no
       segundo já não há testemunho nenhum — o `api.js` deitou-o fora — e um
       pedido sem ele leva o mesmo 401.

       TENTEI ANTES PÔR UMA GUARDA À ENTRADA, a olhar para «não há sessão
       guardada», e isso está errado e a bateria apanhou-o: faltar o testemunho
       em local não quer dizer que o servidor o tenha recusado. Uma app aberta
       sem rede, com os cartões em cache, caía nessa guarda e mostrava «a sessão
       terminou» a quem só estava numa cave sem sinal. Quem decide que a sessão
       morreu é o servidor, e só ele. */
    if (erro.estado === 401) { ecraSessaoTerminada(cliente); return; }
    const guardados = ler('cartoes', null);
    if (!erro.rede || !guardados) throw erro;
    estado.cartoes = guardados;
    estado.velho = true;
  }

  /* AS FORMAS DE ENTRAR, à mesma altura dos cartões. Vai em paralelo e não em
     série: é mais um pedido no arranque, e ao balcão o que interessa é o
     cartão aparecer. Falhar não estraga nada — fica a lista da última vez, que
     é o que o ecrã da sessão terminada lê. */
  estado.identidades = ler('identidades', []) || [];
  carregarIdentidades().catch(() => {});

  aplicarTema();
  /* O BOTÃO DO TEMA SAIU DO CABEÇALHO. Era um ciclo de três estados com dois
     ícones e um rótulo que nomeava dois — um toque em cada três não mudava um
     pixel. Agora vive em Perfil › Definições › Aspecto, com os três estados
     escritos e um deles marcado. */

  /* NO ECRÃ ONDE FICOU, e não sempre no primeiro.

     O `codigo` fica de fora de propósito: é uma folha por cima de um ecrã, e
     reabri-la sozinha a cada recarregamento era pôr um código de quinze
     segundos à frente de quem só queria a página. O `render` distingue-os —
     o `codigo` é o único de `ECRAS` que não tem um. */
  const guardado = foiRecarregamento() ? lerDoSeparador(CHAVE_ECRA) : null;
  const inicial = guardado && ECRAS[guardado] && ECRAS[guardado].render
    ? guardado : 'carteira';
  await irPara(inicial, { historico: false });
}

/**
 * O cartaz do balcão, do outro lado.
 *
 * O café imprime um cartaz com um código; o cliente aponta a câmara e o
 * telemóvel abre `/app/?n=<slug>`. Sem isto a app abria e ficava por ali —
 * e o cartaz prometia, com estas palavras, que «o cartão fica logo na
 * carteira deles».
 *
 * Falhar aqui não pode estragar o arranque: quem chegou pelo cartaz e não
 * conseguiu aderir fica na carteira, com um aviso, e junta o cartão à mão
 * pelo Descobrir.
 */
async function seguirConvite() {
  const parametros = new URLSearchParams(location.search);
  const slug = parametros.get('n');
  /* O `a` é o convite de um amigo, quando o link veio de alguém em vez de um
     cartaz. Vai junto ao pedido de adesão — e é lido AQUI, antes de o endereço
     ser limpo, senão perdia-se com ele. */
  const amigo = parametros.get('a');
  if (!slug) return;

  /* Tira-se o parâmetro do endereço já: se a pessoa recarregar a página, ou
     se a app for reaberta a partir do ecrã inicial, não se volta a tentar
     aderir a um negócio que ela pode entretanto ter apagado. */
  const limpo = new URL(location.href);
  limpo.searchParams.delete('n');
  limpo.searchParams.delete('a');
  history.replaceState(null, '', limpo.pathname + limpo.search + limpo.hash);

  try {
    /* UMA ROTA PARA UM NEGÓCIO, e não a lista toda.

       Isto chamava `api.descobrir()` — que puxa até duzentos negócios com uma
       consulta por cada um para os programas — só para encontrar UM pelo
       apelido. Numa invocação com tecto de cinquenta subpedidos, era uma
       bomba a contar: rebentava com «Too many subrequests» muito antes dos
       duzentos negócios, e o que a pessoa via ao apontar a câmara ao cartaz
       era «não deu para juntar o cartão».

       E havia um defeito mais calado: o `/v1/descobrir` filtra
       `demonstracao = 0`. O cartaz de um negócio marcado como demonstração
       NUNCA funcionou — enquanto o balcão promete por escrito ao dono que «o
       cartaz e o endereço próprio continuam a funcionar». Esta rota não
       filtra, e são duas consultas. */
    const n = await api.negocioPorSlug(slug).catch(() => null);
    if (!n || !n.programas?.length) {
      /* A MENSAGEM NÃO MANDA A PESSOA A LADO NENHUM QUE NÃO EXISTA. Dizia
         «Procura-o em Descobrir», e o Descobrir saiu. O que sobra é o caminho
         que nunca falha e que é o mais usado de todos: o balcão lê o código e
         o cartão nasce sozinho ao primeiro carimbo. */
      avisar('Não encontrei esse cartaz. Mostra o teu código ao balcão — o '
        + 'cartão aparece aqui sozinho ao primeiro carimbo.', 'mau');
      return;
    }
    const ja = estado.cartoes.find((c) => c.negocio.slug === slug);
    if (ja) { avisar(`Já tens o cartão de ${n.nome}.`, 'neutro'); return; }

    /* QUAL DOS PROGRAMAS. Um negócio pode ter até doze, e isto apanhava o
       `[0]` às cegas — quem tivesse dois cartões ficava com o que a base
       devolvesse primeiro, sem nunca saber que havia escolha. Com um só, não
       se pergunta nada: perguntar o óbvio ao balcão é um toque desperdiçado. */
    const programa = n.programas.length === 1
      ? n.programas[0]
      : await escolherPrograma(n);
    if (!programa) return;                 /* fechou a folha sem escolher */

    await api.aderir(estado.cliente.id, programa.id, amigo);
    estado.cartoes = await api.cartoes(estado.cliente.id);
    vibrar(14);
    /* QUEM VEIO POR UM AMIGO OUVE O QUE FALTA FAZER. «Cartão adicionado» e
       mais nada deixava a pessoa sem saber que há um carimbo à espera dela —
       e é esse carimbo que faz o convite valer alguma coisa para os dois. */
    const oferta = programa.amigo;
    const paraSi = amigo && oferta ? oferta.convidado : 0;
    avisar(paraSi
      ? `Cartão de ${n.nome} adicionado. Mostra o teu código lá e começas com `
        + `${paraSi === 1 ? 'um carimbo' : `${paraSi} carimbos`}.`
      : `Cartão de ${n.nome} adicionado.`, 'bom');
    await irPara('carteira');
  } catch (e) {
    avisar(e.message || 'Não deu para juntar o cartão. Mostra o teu código ao '
      + 'balcão — o cartão aparece sozinho ao primeiro carimbo.', 'mau');
  }
}

/**
 * Qual dos cartões deste sítio.
 *
 * Só aparece quando há mesmo mais do que um. O cartaz não nomeia programa
 * nenhum — leva só o apelido do negócio — e por isso a escolha tem de ser
 * feita aqui, por quem está a aderir, em vez de decidida em silêncio pela
 * ordem que a base devolver.
 *
 * Devolve `null` se a pessoa fechar sem escolher, e nesse caso não se adere a
 * nada: uma folha que se fecha e mesmo assim junta um cartão é uma folha que
 * mente sobre o que o «fechar» faz.
 */
function escolherPrograma(negocio) {
  return new Promise((resolver) => {
    const painel = abrirPainel(negocio.nome);
    let escolhido = null;
    painel.append(el('p', { class: 'subtexto', texto:
      'Este sítio tem mais do que um cartão. Qual é o teu?' }));
    const lista = el('div', { class: 'lista' });
    for (const p of negocio.programas) {
      lista.append(el('button', { class: 'linha', type: 'button',
        aoClick: () => { escolhido = p; fecharPainel(); } },
        el('span', { class: 'linha-icone', html: icone(p.selo || 'carimbo', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: p.nome }),
          el('span', { texto: p.tipo === 'pontos'
            ? 'Junta pontos em cada visita'
            : `${p.objetivo} carimbos · ${p.premio}` })),
        el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));
    }
    painel.append(lista);
    /* O `fecharPainel` corre para as duas saídas — o toque numa linha e o véu,
       a tecla Escape ou o «voltar» — por isso é aqui que a promessa se cumpre,
       e não dentro do `aoClick`. */
    const antes = soltarPainel;
    soltarPainel = () => { if (antes) antes(); resolver(escolhido); };
  });
}


/**
 * A barra da demonstração.
 *
 * Fixa, no topo, em todos os ecrãs, e não se fecha. Não é um enfeite: é a
 * resposta a um defeito que custou caro — a demonstração colava-se ao
 * telemóvel, contaminava a outra aplicação, e ficava-se com uma app que
 * parecia a certa e um carimbo que não dava. Um aviso discreto num canto do
 * perfil não chegou; este ocupa uma faixa e leva um botão para sair.
 */
function barraDaDemonstracao() {
  if (MODO !== 'demo' || document.querySelector('#barra-demo')) return;
  const barra = el('div', { class: 'barra-demo', id: 'barra-demo' },
    el('span', { class: 'barra-demo-texto' },
      el('b', { texto: 'Demonstração.' }),
      el('span', { texto: ' Nada disto é real — nenhum destes cartões serve num café.' })),
    el('button', {
      class: 'barra-demo-sair', type: 'button', texto: 'Sair',
      /* SAIR É SAIR: apaga-se a bandeira do separador, deitam-se fora os dados
         da demonstração, e recarrega-se em produção. Deixar os dados lá era
         deixar a demonstração à espera da próxima vez. */
      aoClick: () => {
        try {
          sessionStorage.removeItem('carimbo:modo-demo');
          localStorage.removeItem('carimbo:modo-demo');
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith('carimbo-demo:')) localStorage.removeItem(k);
          }
        } catch { /* armazenamento fechado: o recarregar chega */ }
        location.href = `${location.pathname}?demo=0`;
      },
    }));
  /* A SEGUIR À LIGAÇÃO DE SALTAR, e não antes dela.

     `prepend` punha a barra em primeiro no documento, e portanto em primeiro
     na tabulação: quem anda de Tab batia no «Sair» da demonstração antes de
     chegar ao «Saltar para o conteúdo», que é a primeira paragem de todas as
     páginas e a única que quem não vê o ecrã espera encontrar ali. A barra é o
     que está mais acima NO ECRÃ; a ligação de saltar está acima de tudo por
     convenção, e as duas cabem por esta ordem. */
  const saltar = document.querySelector('a.saltar');
  if (saltar) saltar.after(barra); else document.body.prepend(barra);
  document.documentElement.dataset.demo = 'sim';

  /* E A ALTURA MEDE-SE, não se adivinha. O texto quebra em duas linhas num
     ecrã estreito, e o número escrito à mão no CSS tinha de ter uma media
     query a adivinhar onde é que isso acontecia — que é adivinhar duas vezes.
     A barra diz quanto ocupa, e a página desce isso. */
  const medir = () => document.documentElement.style.setProperty(
    '--barra-demo', `${Math.ceil(barra.getBoundingClientRect().height)}px`);
  medir();
  new ResizeObserver(medir).observe(barra);
}

async function arrancar() {
  barraDaDemonstracao();

  /* A sombra por baixo da barra de cima só aparece quando se rola. */
  const topo = $('#topo');
  addEventListener('scroll', () => {
    topo.dataset.rolado = window.scrollY > 4 ? 'sim' : 'nao';
  }, { passive: true });

  /* A VOLTA DA GOOGLE VEM PRIMEIRO, e antes do `entrar()`. Sem isso, a app
     registava uma conta anónima nova por baixo e a entrada aterrava nela — que
     é a forma mais cara de alguém perder os cartões no gesto que lhos ia
     guardar. Quando falha, o ecrã já está pintado e não há mais nada a fazer. */
  const volta = await voltarDaPorta();
  if (volta && volta.falhou) return;

  if (ler('visto-bv') || (volta && volta.entrou)) {
    try { await entrar(); }
    catch (e) { console.error(e); ecraSemLigacao(e); return; }
    await seguirConvite();
    if (volta && volta.entrou) await terminarEntradaPorPorta(volta);
    /* O manifesto declara um atalho «Mostrar o meu código» que aponta para
       `?acao=codigo` — uma pressão longa no ícone da app, no Android. Ninguém
       lia o parâmetro: o atalho abria a carteira como qualquer outro toque. */
    if (new URLSearchParams(location.search).get('acao') === 'codigo') abrirCodigo();
  } else {
    boasVindas();
  }

  if ('serviceWorker' in navigator) {
    try {
      /* `updateViaCache: 'none'` é obrigatório aqui: o GitHub Pages serve
         tudo com Cache-Control: max-age=600 e não deixa mudar cabeçalhos, e
         sem isto o browser pode servir um service worker de dez minutos
         atrás — que por sua vez serve uma app ainda mais velha. */
      await navigator.serviceWorker.register(`${base()}/app/sw.js`, {
        scope: `${base()}/app/`, updateViaCache: 'none',
      });
    }
    catch { /* sem service worker a app funciona na mesma */ }
  }
}

arrancar().catch((e) => {
  console.error(e);
  document.body.innerHTML = '<div class="coluna" style="padding-block:56px">'
    + '<h1>Alguma coisa correu mal</h1><p style="margin-top:12px;color:var(--tinta-2)">'
    + seguro(e.message) + '</p></div>';
});
