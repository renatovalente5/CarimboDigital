/* =========================================================================
   Sinete — aplicação do cliente
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes,
  pintarCartao, haQuanto, dataCurta, horas, manterEcraAceso, seguro,
} from '../js/nucleo.js';
import { api, MODO, gerarCodigo, JANELA, guardarSegredo, temSegredo,
         esquecerSegredo, guardarDesvio } from '../js/api.js';
import { qrParaSVG } from '../js/qr.js';

const estado = {
  cliente: null,
  cartoes: [],
  ecra: 'carteira',
  cartaoAberto: null,
};

/* =========================================================================
   Grelha dos carimbos
   O número de colunas escolhe-se para as linhas ficarem cheias — um cartão
   de dez com uma linha de cinco e outra de cinco parece um cartão de papel;
   com uma linha de seis e outra de quatro parece um erro.
   ========================================================================= */

const GRELHA = { 1:1, 2:2, 3:3, 4:4, 5:5, 6:3, 7:4, 8:4, 9:3, 10:5, 11:4,
                 12:4, 13:5, 14:5, 15:5, 16:4, 18:6, 20:5, 24:6, 25:5, 30:6 };
const colunas = (n) => GRELHA[n] || (n <= 12 ? 4 : 5);

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
  const faltam = p.objetivo - cartao.carimbos;
  return {
    rotulo: faltam === 1 ? 'falta 1 carimbo' : `faltam ${faltam} carimbos`,
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

function ecraCarteira(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Os meus cartões' }));

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

  const prontos = estado.cartoes.filter((c) => c.porResgatar);
  if (prontos.length) {
    principal.append(el('div', {
      class: 'faixa-premio',
      html: icone('presente', { tamanho: 20 })
        + `<span><b>${prontos.length === 1 ? 'Tens um prémio à espera'
            : `Tens ${prontos.length} prémios à espera`}.</b> `
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
      el('span', { texto: 'Ver os sítios que já usam o Sinete' })),
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
    'Sítios que já usam o Sinete. Junta o cartão agora ou espera pelo primeiro carimbo.' }));

  const negocios = await api.descobrir();
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
                ev.stopPropagation();
                if (tenho) { irPara('carteira'); return; }
                await api.aderir(estado.cliente.id, p.id);
                estado.cartoes = await api.cartoes(estado.cliente.id);
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
    el('p', { html: '<b>Tens um negócio?</b> O Sinete é gratuito para quem carimba. '
      + `Cria o teu cartão em <a href="${base()}/balcao/" class="ligacao">sinete.pt/balcao</a>.` })));
}

/* =========================================================================
   Ecrã: prémios
   ========================================================================= */

async function ecraPremios(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Prémios' }));

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

  /* Histórico de prémios já levantados. */
  const antigos = [];
  for (const c of estado.cartoes) {
    const detalhe = await api.cartao(estado.cliente.id, c.id);
    for (const m of detalhe.movimentos.filter((x) => x.tipo === 'resgate')) {
      antigos.push({ nome: c.negocio.nome, m });
    }
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
        el('span', { texto: 'Tudo o que o Sinete tem sobre ti, num ficheiro' })),
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
    `Sinete · <a class="ligacao" href="${base()}/termos/">Termos</a> · `
    + `<a class="ligacao" href="${base()}/privacidade/">Privacidade</a>`
    + (MODO === 'demo' ? ' · <b>modo de demonstração</b>' : '') }));

  if (MODO === 'demo') {
    principal.append(el('div', { class: 'folha caixa-texto', style: 'margin-top:16px' },
      el('p', { html: '<b>Estás na demonstração.</b> Os dados ficam só neste telemóvel '
        + 'e não há servidor nenhum a receber nada. Serve para experimentar a app inteira.' }),
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
        const v = $('#campo-email').value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
          avisar('Esse email não parece válido.', 'mau'); return;
        }
        ev.currentTarget.disabled = true;
        try {
          await api.guardarEmail(v);
          pedirCodigo(v);
        } catch (e) {
          ev.currentTarget.disabled = false;
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
function pedirCodigo(email) {
  const painel = abrirPainel('Escreve o código');
  painel.append(
    el('p', { class: 'subtexto', html:
      `Enviámos um código de seis algarismos para <b>${seguro(email)}</b>. `
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
        const codigo = $('#campo-codigo').value.replace(/\D/g, '');
        if (codigo.length !== 6) { avisar('O código tem seis algarismos.', 'mau'); return; }
        ev.currentTarget.disabled = true;
        try {
          await api.confirmarEmail(email, codigo);
          estado.cliente = { ...estado.cliente, email };
          guardar('cliente', estado.cliente);
          fecharPainel();
          avisar('Conta guardada. Os cartões já não se perdem.', 'bom');
          irPara('perfil');
        } catch (e) {
          ev.currentTarget.disabled = false;
          avisar(e.message, 'mau');
        }
      },
    }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
      texto: 'Não recebi — enviar outra vez',
      aoClick: async () => { await api.guardarEmail(email); avisar('Enviámos outro.', 'bom'); } }));
  const campo = $('#campo-codigo');
  campo.addEventListener('input', () => { campo.value = campo.value.replace(/\D/g, ''); });
  setTimeout(() => campo.focus(), 120);
}

async function exportarDados() {
  const dados = await api.exportar(estado.cliente.id);
  const texto = JSON.stringify(dados, null, 2);
  const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'sinete-os-meus-dados.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  avisar('Ficheiro descarregado.', 'bom');
}

function apagarConta() {
  const painel = abrirPainel('Apagar a conta');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Apaga a conta, os cartões, os carimbos e o '
      + 'histórico. Não há forma de recuperar.' }),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', style: 'margin-top:8px',
      texto: 'Apagar tudo, definitivamente',
      aoClick: async () => {
        await api.apagarTudo(estado.cliente.id);
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

async function abrirCodigo() {
  if ($('#folha-codigo')) return;

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

function fecharCodigo() {
  clearTimeout(cronometroCodigo);
  document.removeEventListener('visibilitychange', aoVoltar);
  try { travaEcra?.release(); } catch { /* nada */ }
  travaEcra = null;
  $('#folha-codigo')?.remove();
}

/* =========================================================================
   Painel deslizante
   ========================================================================= */

function abrirPainel(titulo) {
  fecharPainel();
  const folha = el('div', { class: 'painel-folha', role: 'dialog', 'aria-modal': 'true',
                            'aria-label': titulo },
    el('div', { class: 'painel-pega' }),
    el('h2', { style: 'margin-bottom:12px', texto: titulo }));
  const painel = el('div', { class: 'painel', id: 'painel' },
    el('div', { class: 'painel-veu', aoClick: fecharPainel }), folha);
  document.body.append(painel);
  document.addEventListener('keydown', escapaPainel);
  return folha;
}
function escapaPainel(ev) { if (ev.key === 'Escape') fecharPainel(); }
function fecharPainel() {
  document.removeEventListener('keydown', escapaPainel);
  $('#painel')?.remove();
}

/* =========================================================================
   Navegação
   ========================================================================= */

const ECRAS = {
  carteira:  { titulo: 'Sinete',    icone: 'carteira', rotulo: 'Carteira',  render: ecraCarteira },
  descobrir: { titulo: 'Descobrir',  icone: 'bussola',  rotulo: 'Descobrir', render: ecraDescobrir },
  codigo:    { titulo: 'Código',     icone: 'qr',       rotulo: 'Código',    centro: true },
  premios:   { titulo: 'Prémios',    icone: 'presente', rotulo: 'Prémios',   render: ecraPremios },
  perfil:    { titulo: 'Perfil',     icone: 'pessoa',   rotulo: 'Perfil',    render: ecraPerfil },
};

function base() {
  return (globalThis.SINETE_CONFIG && globalThis.SINETE_CONFIG.base) || '';
}

async function irPara(nome) {
  if (nome === 'codigo') { abrirCodigo(); return; }
  estado.ecra = nome;
  const principal = $('#principal');
  principal.innerHTML = '';
  const ecra = ECRAS[nome] || { titulo: '', render: ecraCartao };
  $('#topo-titulo').textContent = nome === 'cartao' ? '' : ecra.titulo;
  desenharBarra();
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (nome === 'cartao') {
    principal.append(el('button', {
      class: 'btn btn-fantasma voltar', html: icone('volta', { tamanho: 18 }) + '<span>Carteira</span>',
      aoClick: () => irPara('carteira'),
    }));
    await ecraCartao(principal);
  } else {
    await ecra.render(principal);
  }
  principal.focus({ preventScroll: true });
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

function aplicarTema() {
  const t = ler('tema', 'sistema');
  if (t === 'sistema') delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = t;
  const escuro = t === 'escuro'
    || (t === 'sistema' && matchMedia('(prefers-color-scheme: dark)').matches);
  const b = $('#botao-tema');
  if (b) b.innerHTML = icone(escuro ? 'sol' : 'lua', { tipo: escuro ? 'cheio' : 'traco', tamanho: 20 });
}

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
    caixa.querySelector('#bv-seguinte').textContent =
      passo === PASSOS.length - 1 ? 'Começar' : 'Continuar';
    palco.dataset.passo = String(passo);
  }

  caixa.querySelector('#bv-seguinte').addEventListener('click', async () => {
    if (passo < PASSOS.length - 1) { passo++; pintar(); vibrar(8); return; }
    guardar('visto-bv', true);
    caixa.hidden = true;
    await entrar();
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
  estado.cartoes = await api.cartoes(cliente.id);

  aplicarTema();
  $('#botao-tema').addEventListener('click', () => {
    const ordem = ['sistema', 'claro', 'escuro'];
    const atual = ler('tema', 'sistema');
    guardar('tema', ordem[(ordem.indexOf(atual) + 1) % 3]);
    aplicarTema();
  });

  await irPara('carteira');
}

async function arrancar() {
  /* A sombra por baixo da barra de cima só aparece quando se rola. */
  const topo = $('#topo');
  addEventListener('scroll', () => {
    topo.dataset.rolado = window.scrollY > 4 ? 'sim' : 'nao';
  }, { passive: true });

  if (ler('visto-bv')) await entrar();
  else boasVindas();

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
