/* =========================================================================
   Carimbo Digital — aplicação do cliente
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes,
  pintarCartao, haQuanto, dataCurta, horas, manterEcraAceso, seguro,
  prenderFoco, colunas,
} from '../js/nucleo.js';
import { api, MODO, DEMO_FORCADO, gerarCodigo, JANELA, guardarSegredo, temSegredo,
         esquecerSegredo, guardarDesvio } from '../js/api.js';
import { qrParaSVG } from '../js/qr.js';

const estado = {
  cliente: null,
  cartoes: [],
  ecra: 'carteira',
  cartaoAberto: null,
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
      html: cheio
        ? icone(p.selo, { tipo: 'cheio', tamanho: 24 })
        : icone(p.selo, { tipo: 'cheio', tamanho: 24 }),
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
  return trilho;
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

/** O cartão como aparece na lista. */
function cartaoCompacto(cartao) {
  const p = cartao.programa;
  const prox = proximoPremio(cartao);
  const pronto = cartao.porResgatar > 0;

  const no = el('button', {
    class: 'cartao', type: 'button',
    'aria-label': `${cartao.negocio.nome}. ${prox.rotulo}: ${prox.texto}.`,
    aoClick: () => abrirCartao(cartao.id),
  },
    el('div', { class: 'cartao-corpo' },
      el('div', { class: 'cartao-topo' },
        el('div', { class: 'cartao-marca' },
          el('div', { class: 'cartao-nome', texto: cartao.negocio.nome }),
          el('div', { class: 'cartao-tipo', texto: p.nome })),
        el('div', { class: 'cartao-id' },
          el('span', { texto: 'cartão' }),
          el('b', { texto: estado.cliente.publico }))),
      pronto
        ? painelPronto(cartao)
        : p.tipo === 'pontos'
          ? el('div', {},
              el('div', { class: 'pontos-valor' },
                el('b', { texto: String(cartao.pontos) }),
                el('span', { texto: 'pt' })),
              trilhoPontos(cartao))
          : grelhaCarimbos(cartao),
      pronto ? null : el('div', { class: 'cartao-rodape' },
        el('div', {},
          el('div', { class: 'cartao-rotulo', texto: prox.rotulo }),
          el('div', { class: 'cartao-premio', texto: prox.texto })))));

  pintarCartao(no, cartao.negocio.cor);
  return no;
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

  if (!estado.cartoes.length) {
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('carteira', { tamanho: 96 }) }),
      el('h3', { texto: 'Ainda não tens cartões' }),
      el('p', { texto: 'Mostra o teu código na próxima vez que fores ao café ou ao '
        + 'barbeiro. O cartão aparece aqui sozinho, logo ao primeiro carimbo.' }),
      el('button', {
        class: 'btn btn-cheio', aoClick: () => irPara('descobrir'),
        html: icone('bussola', { tamanho: 18 }) + '<span>Ver quem tem cartão</span>',
      })));
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

  const lista = el('div', { class: 'pilha' });
  for (const c of estado.cartoes) lista.append(cartaoCompacto(c));
  principal.append(lista);

  principal.append(el('button', {
    class: 'linha adicionar', aoClick: () => irPara('descobrir'),
  },
    el('span', { class: 'linha-icone', html: icone('mais', { tamanho: 20 }) }),
    el('span', { class: 'linha-texto' },
      el('b', { texto: 'Juntar outro cartão' }),
      el('span', { texto: 'Ver os sítios que já usam o Carimbo Digital' })),
    el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));
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

  principal.append(el('button', {
    class: 'btn btn-fantasma btn-bloco', style: 'margin-top:24px',
    texto: 'Deixar de usar este cartão',
    aoClick: () => avisar('Numa versão futura poderás arquivar cartões.', 'neutro'),
  }));
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

/* =========================================================================
   Ecrã: descobrir
   ========================================================================= */

async function ecraDescobrir(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Descobrir' }));
  principal.append(el('p', { class: 'subtexto', texto:
    'Sítios que já usam o Carimbo Digital. Junta o cartão agora ou espera pelo primeiro carimbo.' }));

  const negocios = await api.descobrir();

  /* A carteira e os prémios explicam-se quando estão vazios; este ecrã
     ficava com um título e nada por baixo. E é o estado em que a app está
     para toda a gente que a abra numa terra onde ainda não há nenhum café
     inscrito — que, no princípio, é toda a gente. */
  if (!negocios.length) {
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('bussola', { tamanho: 96 }) }),
      el('h3', { texto: 'Ainda não há nada por aqui' }),
      el('p', { texto: 'Assim que um café, um barbeiro ou um cabeleireiro aderir, '
        + 'aparece nesta lista. Até lá, mostra o teu código no balcão: o cartão '
        + 'nasce no primeiro carimbo.' })));
    return;
  }

  const meus = new Set(estado.cartoes.map((c) => c.programa.id));
  const lista = el('div', { class: 'pilha' });

  for (const n of negocios) {
    for (const p of n.programas) {
      const tenho = meus.has(p.id);
      const cartao = el('div', { class: 'cartao cartao-descobrir' },
        el('div', { class: 'cartao-corpo' },
          el('div', { class: 'cartao-topo' },
            el('div', { class: 'cartao-marca' },
              el('div', { class: 'cartao-nome', texto: n.nome }),
              el('div', { class: 'cartao-tipo', texto: `${n.categoria} · ${n.localidade}` })),
            el('div', { class: 'cartao-selo-tipo', html: icone(p.selo, { tipo: 'cheio', tamanho: 22 }) })),
          el('div', { class: 'cartao-rodape' },
            el('div', {},
              el('div', { class: 'cartao-rotulo', texto: p.tipo === 'pontos'
                ? 'Programa de pontos' : `${p.objetivo} carimbos` }),
              el('div', { class: 'cartao-premio', texto: p.premio })),
            el('button', {
              class: 'cartao-selo', type: 'button',
              'aria-label': tenho ? `Já tens o cartão de ${n.nome}` : `Juntar o cartão de ${n.nome}`,
              html: tenho ? icone('visto', { tamanho: 13 }) + '<span>Já tens</span>'
                          : icone('mais', { tamanho: 13 }) + '<span>Juntar</span>',
              aoClick: async (ev) => {
                const botao = ev.currentTarget;
                ev.stopPropagation();
                if (tenho) { irPara('carteira'); return; }
                /* Sem este try, um erro aqui — programa desactivado, rede
                   em baixo, sessão expirada — matava a promessa em silêncio:
                   o botão continuava a dizer «Juntar», nada acontecia, e a
                   única pista era uma excepção na consola que ninguém abre. */
                botao.disabled = true;
                try {
                  await api.aderir(estado.cliente.id, p.id);
                  estado.cartoes = await api.cartoes(estado.cliente.id);
                } catch (e) {
                  botao.disabled = false;
                  avisar(e.message || 'Não deu para juntar este cartão.', 'mau');
                  return;
                }
                vibrar(14);
                avisar(`Cartão de ${n.nome} adicionado.`, 'bom');
                irPara('carteira');
              },
            }))));
      pintarCartao(cartao, n.cor);
      lista.append(cartao);
    }
  }
  principal.append(lista);

  principal.append(el('div', { class: 'folha caixa-texto', style: 'margin-top:24px' },
    el('p', { html: '<b>Tens um negócio?</b> O Carimbo Digital é gratuito para quem carimba. '
      + `Cria o teu cartão em <a href="${base()}/balcao/" class="ligacao">carimbodigital.pt/balcao</a>.` })));
}

/* =========================================================================
   Ecrã: prémios
   ========================================================================= */

async function ecraPremios(principal) {
  /* Sem rede não se deita fora o que já se sabe: os prémios vêm de
     `estado.cartoes`, que ainda está em memória. Mostrá-los com um aviso é
     melhor do que um «Não deu para carregar» por cima de um prémio que a
     pessoa tem mesmo para levantar — e é justamente ao balcão, sem rede,
     que ela precisa de o ver. */
  const semRede = await recarregarCartoes();
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Prémios' }));
  if (semRede) principal.append(semRede);

  const porLevantar = [];
  for (const c of estado.cartoes) {
    for (const p of c.premios) porLevantar.push({ cartao: c, premio: p });
  }

  if (!porLevantar.length) {
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('presente', { tamanho: 96 }) }),
      el('h3', { texto: 'Ainda não há prémios' }),
      el('p', { texto: 'Assim que completares um cartão, o prémio aparece aqui — e '
        + 'é só mostrar o código no balcão.' })));
  } else {
    const lista = el('div', { class: 'lista' });
    for (const { cartao, premio } of porLevantar) {
      const linha = el('div', { class: 'linha linha-premio' },
        el('span', { class: 'linha-icone linha-icone-marca', html: icone('presente', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: premio.descricao }),
          el('span', { texto: `${cartao.negocio.nome} · ganho ${haQuanto(premio.ganhoEm)}` })),
        el('span', { class: 'etiqueta etiqueta-bom', texto: 'pronto' }));
      linha.style.setProperty('--m', cartao.negocio.cor);
      lista.append(linha);
    }
    principal.append(lista);
    principal.append(el('button', {
      class: 'btn btn-cheio btn-grande btn-bloco', style: 'margin-top:20px',
      html: icone('qr', { tamanho: 20 }) + '<span>Mostrar o código para levantar</span>',
      aoClick: () => abrirCodigo(),
    }));
  }

  /* Histórico de prémios já levantados.

     Sem rede, o histórico não vem — mas os prémios POR levantar estão todos
     em memória, e são o que interessa neste ecrã. Deixar o erro subir daqui
     deitava fora a lista inteira e punha «Não deu para carregar» por cima de
     um prémio que a pessoa tem mesmo para receber, ao balcão, sem rede. */
  const antigos = [];
  try {
    for (const c of estado.cartoes) {
      const detalhe = await api.cartao(estado.cliente.id, c.id);
      for (const m of detalhe.movimentos.filter((x) => x.tipo === 'resgate')) {
        antigos.push({ nome: c.negocio.nome, m });
      }
    }
  } catch (erro) {
    if (!erro.rede) throw erro;
  }
  if (antigos.length) {
    const lista = el('div', { class: 'lista' });
    antigos.sort((a, b) => new Date(b.m.em) - new Date(a.m.em));
    for (const a of antigos.slice(0, 20)) {
      lista.append(el('div', { class: 'linha' },
        el('span', { class: 'linha-icone', html: icone('visto', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: a.m.nota || 'Prémio' }),
          el('span', { texto: a.nome })),
        el('span', { class: 'linha-fim', texto: haQuanto(a.m.em) })));
    }
    principal.append(el('section', { class: 'seccao' },
      el('h2', { class: 'seccao-titulo', texto: 'Já levantados' }), lista));
  }
}

/* =========================================================================
   Ecrã: perfil
   ========================================================================= */

function ecraPerfil(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Perfil' }));

  principal.append(el('div', { class: 'folha cartao-identidade' },
    el('div', {},
      el('div', { class: 'cartao-rotulo', texto: 'O meu número de cartão' }),
      el('div', { class: 'identidade-numero selecionavel', texto: estado.cliente.publico })),
    el('p', { class: 'miudo', texto: 'É este número que identifica todos os teus cartões. '
      + 'Se a câmara do balcão não ler o código, podem escrevê-lo à mão.' })));

  const conta = el('div', { class: 'lista' },
    el('button', { class: 'linha', aoClick: guardarConta },
      el('span', { class: 'linha-icone', html: icone('cadeado', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Guardar a conta' }),
        el('span', { texto: estado.cliente.email || 'Para não perderes os cartões se mudares de telemóvel' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })),
    el('button', { class: 'linha', aoClick: () => avisar('Em breve: adicionar à Wallet do telemóvel.', 'neutro') },
      el('span', { class: 'linha-icone', html: icone('carteira', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Adicionar à Wallet' }),
        el('span', { texto: 'Apple Wallet e Google Wallet — a caminho' })),
      el('span', { class: 'etiqueta', texto: 'em breve' })));
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Conta' }), conta));

  /* Dados — o que a lei exige que seja fácil de fazer, e que quase nenhuma
     app faz fácil: ver o que têm sobre nós, e apagar. */
  const dados = el('div', { class: 'lista' },
    el('button', { class: 'linha', aoClick: exportarDados },
      el('span', { class: 'linha-icone', html: icone('descarregar', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'Descarregar os meus dados' }),
        el('span', { texto: 'Tudo o que o Carimbo Digital tem sobre ti, num ficheiro' })),
      el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })),
    el('a', { class: 'linha', href: `${base()}/privacidade/` },
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
    `Carimbo Digital · <a class="ligacao" href="${base()}/termos/">Termos</a> · `
    + `<a class="ligacao" href="${base()}/privacidade/">Privacidade</a>`
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
          location.reload();
        },
      })));
  }
}

async function guardarConta() {
  const painel = abrirPainel('Guardar a conta');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Deixa um email e enviamos um código de seis '
      + 'algarismos. Se mudares de telemóvel, escreves o código e os cartões voltam todos.' }),
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
          if (r && r.cliente) {
            if (r.segredo) await guardarSegredo(r.segredo);
            if (r.sessao) guardar('sessao', r.sessao);
            if (r.horaDoServidor) guardarDesvio(r.horaDoServidor);
            estado.cliente = r.cliente;
            guardar('cliente', r.cliente);
            estado.cartoes = await api.cartoes(r.cliente.id);
          } else {
            estado.cliente = { ...estado.cliente, email };
            guardar('cliente', estado.cliente);
          }

          fecharPainel();
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
  campo.addEventListener('input', () => { campo.value = campo.value.replace(/\D/g, ''); });
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
        apagar('cliente'); apagar('sessao'); apagar('desvio'); apagar('visto-bv');
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

let soltarCodigo = null;

async function abrirCodigo() {
  if ($('#folha-codigo')) return;
  empurrarHistorico('codigo');

  const folha = el('div', { id: 'folha-codigo', class: 'codigo-folha', role: 'dialog',
                            'aria-modal': 'true', 'aria-label': 'O meu código' },
    el('div', { class: 'codigo-topo' },
      el('button', { class: 'codigo-fechar', 'aria-label': 'Fechar',
                     html: icone('fechar', { tamanho: 20 }), aoClick: fecharCodigo }),
      el('div', { style: 'flex:1' },
        el('div', { style: 'font-weight:700;font-size:1rem' , texto: 'Mostra ao balcão' }),
        el('div', { style: 'font-size:.8125rem;color:#5B5966', texto: 'O código muda a cada 15 segundos' })),
      /* O anel vai por innerHTML: document.createElement('svg') devolve um
         HTMLUnknownElement — um SVG só nasce por createElementNS ou a partir
         de HTML analisado. Nasce sem nada e nunca se vê. */
      el('div', { class: 'codigo-anel-caixa', html:
        '<svg class="codigo-anel" viewBox="0 0 32 32" aria-hidden="true">'
        + '<circle class="fundo" cx="16" cy="16" r="13"/>'
        + '<circle class="frente" cx="16" cy="16" r="13" '
        + 'stroke-dasharray="81.7" stroke-dashoffset="0"/></svg>' })),
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
    const { texto, expiraEm } = await gerarCodigo(estado.cliente.publico);
    $('#codigo-qr').innerHTML = qrParaSVG(texto, { nivel: 'Q', margem: 2 });
    const restante = Math.max(0, expiraEm - Date.now()) / 1000;
    const arco = anel.querySelector('.frente');
    arco.style.transition = 'none';
    arco.style.strokeDashoffset = String(81.7 * (1 - restante / JANELA));
    requestAnimationFrame(() => {
      arco.style.transition = `stroke-dashoffset ${restante}s linear`;
      arco.style.strokeDashoffset = '81.7';
    });
    return expiraEm;
  }

  async function ciclo() {
    const expiraEm = await pintar();
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

const ECRAS = {
  carteira:  { titulo: 'Carimbo Digital',    icone: 'carteira', rotulo: 'Carteira',  render: ecraCarteira },
  descobrir: { titulo: 'Descobrir',  icone: 'bussola',  rotulo: 'Descobrir', render: ecraDescobrir },
  codigo:    { titulo: 'Código',     icone: 'qr',       rotulo: 'Código',    centro: true },
  premios:   { titulo: 'Prémios',    icone: 'presente', rotulo: 'Prémios',   render: ecraPremios },
  perfil:    { titulo: 'Perfil',     icone: 'pessoa',   rotulo: 'Perfil',    render: ecraPerfil },
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
  const velho = $('#principal');
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
  principal.focus({ preventScroll: true });
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
      class: e.centro ? 'barra-item barra-centro' : 'barra-item',
      'aria-current': atual ? 'page' : null,
      aoClick: () => irPara(nome),
    },
      el('span', { class: e.centro ? 'barra-bolha' : '', html: icone(e.icone, { tamanho: e.centro ? 26 : 24 }) }),
      el('span', { texto: e.rotulo }));
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

  /* Uma meta só, sem `media`, escrita à mão. As duas com `media` não podem
     ser sobrepostas por JavaScript — a que casa com o sistema ganha sempre. */
  let faixa = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!faixa) {
    faixa = document.createElement('meta');
    faixa.setAttribute('name', 'theme-color');
    document.head.append(faixa);
  }
  faixa.setAttribute('content', escuro ? '#0E0D12' : '#FBFAF7');

  const b = $('#botao-tema');
  if (b) b.innerHTML = icone(escuro ? 'sol' : 'lua', { tipo: escuro ? 'cheio' : 'traco', tamanho: 20 });
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
    try { await entrar(); }
    catch (e) { console.error(e); ecraSemLigacao(e); }
  });
  caixa.querySelector('#bv-saltar').addEventListener('click', () => {
    avisar(MODO === 'demo'
      ? 'Na demonstração cada telemóvel tem a sua conta.'
      : 'Abre no telemóvel antigo o Perfil › Guardar a conta.', 'neutro');
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
    const guardados = ler('cartoes', null);
    if (!erro.rede || !guardados) throw erro;
    estado.cartoes = guardados;
    estado.velho = true;
  }

  aplicarTema();
  $('#botao-tema').addEventListener('click', () => {
    const ordem = ['sistema', 'claro', 'escuro'];
    const atual = ler('tema', 'sistema');
    guardar('tema', ordem[(ordem.indexOf(atual) + 1) % 3]);
    aplicarTema();
  });

  await irPara('carteira');
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
  const slug = new URLSearchParams(location.search).get('n');
  if (!slug) return;

  /* Tira-se o parâmetro do endereço já: se a pessoa recarregar a página, ou
     se a app for reaberta a partir do ecrã inicial, não se volta a tentar
     aderir a um negócio que ela pode entretanto ter apagado. */
  const limpo = new URL(location.href);
  limpo.searchParams.delete('n');
  history.replaceState(null, '', limpo.pathname + limpo.search + limpo.hash);

  try {
    const negocios = await api.descobrir();
    const n = negocios.find((x) => x.slug === slug);
    if (!n || !n.programas?.length) {
      avisar('Não encontrei esse negócio. Procura-o em Descobrir.', 'mau');
      return;
    }
    const ja = estado.cartoes.find((c) => c.negocio.slug === slug);
    if (ja) { avisar(`Já tens o cartão de ${n.nome}.`, 'neutro'); return; }

    await api.aderir(estado.cliente.id, n.programas[0].id);
    estado.cartoes = await api.cartoes(estado.cliente.id);
    vibrar(14);
    avisar(`Cartão de ${n.nome} adicionado.`, 'bom');
    await irPara('carteira');
  } catch (e) {
    avisar(e.message || 'Não deu para juntar o cartão. Tenta pelo Descobrir.', 'mau');
  }
}

async function arrancar() {
  /* A sombra por baixo da barra de cima só aparece quando se rola. */
  const topo = $('#topo');
  addEventListener('scroll', () => {
    topo.dataset.rolado = window.scrollY > 4 ? 'sim' : 'nao';
  }, { passive: true });

  if (ler('visto-bv')) {
    try { await entrar(); }
    catch (e) { console.error(e); ecraSemLigacao(e); return; }
    await seguirConvite();
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
