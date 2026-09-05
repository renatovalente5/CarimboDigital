/* =========================================================================
   Carimbo Digital — camada de dados

   Dois condutores por trás da mesma interface:

   · «remoto»  fala com o Worker da Cloudflare, que é onde os dados vivem a
               sério (ver worker/src/index.js).
   · «demo»    faz tudo dentro do browser, no localStorage, com as mesmas
               regras — arrefecimento, prémios, movimentos, tudo.

   O demo não é uma maqueta: é uma implementação completa das regras. Serve
   para o site publicado ser experimentável de imediato, sem servidor nenhum,
   e para desenvolver sem rede. Passa-se para o remoto pondo o endereço em
   `_fonte/config.json` — mais nada muda no resto da app.
   ========================================================================= */

import { identificador, ler, guardar, guardarChave, lerChave, apagarChave,
         definirEspaco } from './nucleo.js';

const CONFIG = globalThis.CARIMBO_CONFIG || {};

/* O modo de demonstração pode ser ligado por `?demo=1` e desligado por
   `?demo=0`. Serve para mostrar o produto a um dono de café no próprio
   telemóvel, sem conta e sem convite — e para o site continuar a poder ser
   experimentado depois de o servidor entrar ao serviço.
   As chaves ficam noutro espaço, por isso entrar na demonstração não toca na
   conta a sério e sair dela devolve-a como estava. */
function pedidoDeDemo() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.has('demo')) {
      const liga = p.get('demo') !== '0';
      localStorage.setItem('carimbo:modo-demo', liga ? '1' : '0');
      /* Limpa-se o endereço, senão fica colado no histórico e no ecrã
         principal do telemóvel. */
      history.replaceState(null, '', location.pathname + location.hash);
      return liga;
    }
    return localStorage.getItem('carimbo:modo-demo') === '1';
  } catch { return false; }
}

export const DEMO_FORCADO = Boolean(CONFIG.api) && pedidoDeDemo();
export const MODO = CONFIG.api && !DEMO_FORCADO ? 'remoto' : 'demo';

definirEspaco(MODO === 'demo' ? 'carimbo-demo:' : 'carimbo:');

/* O segredo do aparelho vive no cofre (IndexedDB), que não passa pelo espaço
   das chaves — por isso separa-se pelo nome. */
const CHAVE_SEGREDO = MODO === 'demo' ? 'segredo-demo' : 'segredo';

/* Onde fica o testemunho da sessão. Cada aplicação tem a sua chave: um dono
   de café que também junte carimbos abre as duas no mesmo telemóvel, e com
   uma chave só a segunda que entrasse apagava a sessão da primeira. */
let CHAVE_SESSAO = 'sessao';

export function definirChaveSessao(nome) { CHAVE_SESSAO = nome; }

/* =========================================================================
   Utilidades comuns
   ========================================================================= */

function agora() { return new Date().toISOString(); }

function id() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function deBase64url(texto) {
  const s = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/**
 * Guarda o segredo do dispositivo como CryptoKey não-extraível.
 *
 * `extractable: false` é o ponto todo: a partir daqui o browser assina com a
 * chave mas recusa-se a devolvê-la. Nem um script injectado na página nem o
 * dono do telemóvel pela consola conseguem tirá-la de lá para a passar a
 * outro aparelho. O base64 que veio do servidor é descartado a seguir.
 */
export async function guardarSegredo(segredoBase64) {
  const chave = await crypto.subtle.importKey(
    'raw', deBase64url(segredoBase64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return guardarChave(CHAVE_SEGREDO, chave);
}

export async function temSegredo() {
  return Boolean(await lerChave(CHAVE_SEGREDO));
}

export async function esquecerSegredo() {
  await apagarChave(CHAVE_SEGREDO);
}

async function assinar(mensagem) {
  const chave = await lerChave(CHAVE_SEGREDO);
  if (!chave) throw new Error('Falta o segredo deste aparelho.');
  const bytes = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(mensagem));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * O código que vai dentro do QR.
 *
 *   C1.<público>.<janela>.<assinatura>
 *
 * `janela` é o tempo dividido em fatias de 15 segundos, e a assinatura é um
 * HMAC do par (público, janela) com o segredo do dispositivo. Quem tirar uma
 * fotografia ao ecrã fica com um código que morre em quinze segundos, e o
 * servidor recusa a mesma janela duas vezes. O segredo nunca sai do
 * telemóvel — o servidor volta a derivá-lo a partir da chave-mestra.
 *
 * Repare-se que isto é calculado sem rede: o cartão aparece e o código roda
 * mesmo dentro de uma cave sem sinal. Quem precisa de ligação é o balcão.
 */
export const JANELA = 15;

/**
 * O desvio do relógio.
 *
 * A janela do código é o tempo dividido em fatias de 15 segundos, e um
 * telemóvel com o relógio a um minuto de distância gera códigos que o
 * servidor recusa como expirados — sem que ninguém perceba porquê. Por isso
 * guarda-se a diferença entre o relógio do servidor e o nosso, e conta-se o
 * tempo por ela.
 */
export function guardarDesvio(horaDoServidor) {
  const servidor = new Date(horaDoServidor).getTime();
  if (!Number.isFinite(servidor)) return;
  guardar('desvio', servidor - Date.now());
}

function tempo() {
  return Date.now() + (ler('desvio', 0) || 0);
}

export async function gerarCodigo(publico) {
  const janela = Math.floor(tempo() / 1000 / JANELA);
  const assinatura = (await assinar(`${publico}.${janela}`)).slice(0, 16);
  return {
    texto: `C1.${publico}.${janela}.${assinatura}`,
    janela,
    expiraEm: (janela + 1) * JANELA * 1000 - (ler('desvio', 0) || 0),
  };
}

/* =========================================================================
   Condutor remoto
   ========================================================================= */

function criarRemoto(base) {
  async function pedir(caminho, { metodo = 'GET', corpo, sessao } = {}) {
    const cabecalhos = { 'content-type': 'application/json' };
    const t = sessao ?? ler(CHAVE_SESSAO);
    if (t) cabecalhos.authorization = `Bearer ${t}`;
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta não-JSON */ }
    if (!r.ok) {
      const erro = new Error((dados && dados.erro) || `Erro ${r.status}`);
      erro.estado = r.status;
      erro.codigo = dados && dados.codigo;
      throw erro;
    }
    return dados;
  }
  return { pedir };
}

/* =========================================================================
   Condutor de demonstração
   ========================================================================= */

const SEMENTE = {
  negocios: [
    {
      id: 'n-torrado', slug: 'cafe-torrado', nome: 'Café Torrado',
      categoria: 'Café', cor: '#3B2417', localidade: 'Ovar',
      morada: 'Rua Dr. Oliveira Salazar 12', telefone: '234 000 000',
      programas: [{
        id: 'p-torrado', nome: 'Cartão do café', tipo: 'carimbos', selo: 'chavena',
        objetivo: 10, premio: 'Um café por conta da casa', arrefecimento: 3600,
        regras: 'Um carimbo por visita. Válido em todas as bebidas quentes.',
      }],
    },
    {
      id: 'n-navalha', slug: 'barbearia-navalha', nome: 'Barbearia Navalha',
      categoria: 'Barbearia', cor: '#12232E', localidade: 'Aveiro',
      morada: 'Praça do Peixe 4', telefone: '234 000 001',
      programas: [{
        id: 'p-navalha', nome: 'Corte a corte', tipo: 'carimbos', selo: 'navalha',
        objetivo: 8, premio: 'Corte + barba grátis', arrefecimento: 43200,
        regras: 'Um carimbo por serviço pago. Não acumula com outras promoções.',
      }],
    },
    {
      id: 'n-camelia', slug: 'salao-camelia', nome: 'Salão Camélia',
      categoria: 'Cabeleireiro', cor: '#B0446A', localidade: 'Ovar',
      morada: 'Avenida do Bom Reitor 88', telefone: '234 000 002',
      programas: [{
        id: 'p-camelia', nome: 'Clube Camélia', tipo: 'pontos', selo: 'flor',
        objetivo: 600, premio: 'Tratamento de hidratação',
        arrefecimento: 1800,
        marcos: [
          { pontos: 200, premio: 'Champô de oferta' },
          { pontos: 400, premio: 'Brushing grátis' },
          { pontos: 600, premio: 'Tratamento de hidratação' },
          { pontos: 1000, premio: 'Corte + cor com 50%' },
        ],
        regras: '1 ponto por cada euro gasto. Pontos válidos 12 meses.',
      }],
    },
    {
      id: 'n-forno', slug: 'padaria-do-forno', nome: 'Padaria do Forno',
      categoria: 'Padaria', cor: '#C9821F', localidade: 'Esmoriz',
      morada: 'Rua 21 n.º 3', telefone: '234 000 003',
      programas: [{
        id: 'p-forno', nome: 'Pão nosso', tipo: 'carimbos', selo: 'bolo',
        objetivo: 12, premio: 'Bolo-rei ou pão de ló', arrefecimento: 3600,
        regras: 'Um carimbo por compra acima de 3 €.',
      }],
    },
    {
      id: 'n-patas', slug: 'patas-felizes', nome: 'Patas Felizes',
      categoria: 'Banhos e tosquias', cor: '#1E7A6B', localidade: 'Santa Maria da Feira',
      morada: 'Rua das Laranjeiras 51', telefone: '256 000 004',
      programas: [{
        id: 'p-patas', nome: 'Cartão do cão', tipo: 'carimbos', selo: 'pata',
        objetivo: 6, premio: 'Banho e tosquia grátis', arrefecimento: 86400,
        regras: 'Um carimbo por banho completo.',
      }],
    },
    {
      id: 'n-gelato', slug: 'gelataria-luar', nome: 'Gelataria Luar',
      categoria: 'Gelataria', cor: '#5AAEE0', localidade: 'Espinho',
      morada: 'Marginal 2', telefone: '227 000 005',
      programas: [{
        id: 'p-gelato', nome: 'Bola a bola', tipo: 'carimbos', selo: 'gelado',
        objetivo: 9, premio: 'Taça de três bolas', arrefecimento: 1800,
        regras: 'Um carimbo por cada gelado.',
      }],
    },
  ],
};

function criarDemo() {
  const CHAVE = 'demo';

  function estado() {
    let e = ler(CHAVE);
    if (!e) {
      e = {
        negocios: SEMENTE.negocios.map((n) => ({
          ...n,
          criadoEm: agora(),
          programas: n.programas.map((p) => ({
            ...p, negocioId: n.id, ativo: 1, criadoEm: agora(),
            marcos: p.marcos || null,
          })),
        })),
        clientes: [], cartoes: [], movimentos: [], premios: [], usados: {},
        operadores: [{ id: 'o-demo', negocioId: 'n-torrado', nome: 'Balcão', papel: 'dono' }],
      };
      guardar(CHAVE, e);
    }
    return e;
  }

  function gravar(e) { guardar(CHAVE, e); }

  function programa(e, programaId) {
    for (const n of e.negocios) {
      const p = (n.programas || []).find((x) => x.id === programaId);
      if (p) return { negocio: n, programa: p };
    }
    return null;
  }

  function comporCartao(e, c) {
    const achado = programa(e, c.programaId);
    if (!achado) return null;
    const { negocio, programa: p } = achado;
    const premios = e.premios.filter((x) => x.cartaoId === c.id && !x.resgatadoEm);
    return {
      ...c,
      negocio: {
        id: negocio.id, nome: negocio.nome, slug: negocio.slug, cor: negocio.cor,
        categoria: negocio.categoria, localidade: negocio.localidade,
        morada: negocio.morada, telefone: negocio.telefone,
      },
      programa: p,
      porResgatar: premios.length,
      premios,
    };
  }

  const api = {
    async registarCliente() {
      const e = estado();
      const segredo = (() => {
        const b = new Uint8Array(32); crypto.getRandomValues(b);
        return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      })();
      let publico;
      do { publico = identificador(6); } while (e.clientes.some((c) => c.publico === publico));
      const cliente = { id: id(), publico, criadoEm: agora(), nome: null, email: null };
      e.clientes.push(cliente);
      gravar(e);
      return { cliente, segredo, sessao: 'demo:' + cliente.id, horaDoServidor: agora() };
    },

    async cartoes(clienteId) {
      const e = estado();
      return e.cartoes
        .filter((c) => c.clienteId === clienteId)
        .map((c) => comporCartao(e, c))
        .filter(Boolean)
        .sort((a, b) => (b.porResgatar - a.porResgatar)
          || (new Date(b.ultimoEm || b.aderiuEm) - new Date(a.ultimoEm || a.aderiuEm)));
    },

    async cartao(clienteId, cartaoId) {
      const e = estado();
      const c = e.cartoes.find((x) => x.id === cartaoId && x.clienteId === clienteId);
      if (!c) throw new Error('Cartão não encontrado');
      return {
        ...comporCartao(e, c),
        movimentos: e.movimentos
          .filter((m) => m.cartaoId === c.id)
          .sort((a, b) => new Date(b.em) - new Date(a.em))
          .slice(0, 60),
      };
    },

    async descobrir() {
      const e = estado();
      return e.negocios.map((n) => ({
        id: n.id, slug: n.slug, nome: n.nome, cor: n.cor, categoria: n.categoria,
        localidade: n.localidade, morada: n.morada, telefone: n.telefone,
        programas: n.programas.map((p) => ({
          id: p.id, nome: p.nome, tipo: p.tipo, selo: p.selo,
          objetivo: p.objetivo, premio: p.premio, regras: p.regras,
          marcos: p.marcos || null,
        })),
      }));
    },

    async aderir(clienteId, programaId) {
      const e = estado();
      const achado = programa(e, programaId);
      if (!achado) throw new Error('Programa não encontrado');
      const jaTem = e.cartoes.find((c) => c.clienteId === clienteId && c.programaId === programaId);
      if (jaTem) return comporCartao(e, jaTem);
      const cartao = {
        id: id(), clienteId, programaId, negocioId: achado.negocio.id,
        carimbos: 0, pontos: 0, totalCarimbos: 0, premiosGanhos: 0,
        aderiuEm: agora(), ultimoEm: null,
      };
      e.cartoes.push(cartao);
      e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'adesao', quantidade: 0, em: agora() });
      gravar(e);
      return comporCartao(e, cartao);
    },

    /* O coração: um carimbo. As mesmas regras que o servidor aplica. */
    async carimbar({ codigo, programaId, quantidade = 1, operador = 'Balcão', manual = false }) {
      const e = estado();
      const partes = String(codigo || '').split('.');

      /* Duas formas de identificar o cliente:
         · C1.<público>.<janela>.<assinatura> — o código do ecrã, assinado e
           com quinze segundos de vida.
         · M1.<público> — o número escrito à mão, para quando a câmara não
           colabora. Não é assinado, e por isso fica marcado como manual: o
           dono do negócio consegue vê-lo no histórico. O arrefecimento e o
           resto das regras aplicam-se na mesma. */
      let publico, janela = null;
      if (partes[0] === 'M1' && partes.length === 2) {
        publico = partes[1].toUpperCase();
        manual = true;
      } else if (partes[0] === 'C1' && partes.length === 4) {
        publico = partes[1];
        janela = Number(partes[2]);
      } else {
        const err = new Error('Este código não é de um cartão Carimbo Digital.');
        err.codigo = 'formato'; throw err;
      }

      const cliente = e.clientes.find((c) => c.publico === publico);
      if (!cliente) {
        const err = new Error('Cartão desconhecido.'); err.codigo = 'sem-cliente'; throw err;
      }

      let chaveUso = null;
      if (janela !== null) {
        const atual = Math.floor(Date.now() / 1000 / JANELA);
        if (Math.abs(atual - janela) > 2) {
          const err = new Error('Código expirado. Peça para atualizar o ecrã.');
          err.codigo = 'expirado'; throw err;
        }
        chaveUso = `${publico}:${janela}`;
        if (e.usados[chaveUso]) {
          const err = new Error('Este código já foi usado.'); err.codigo = 'repetido'; throw err;
        }
      }

      const achado = programa(e, programaId);
      if (!achado) throw new Error('Programa não encontrado');
      const p = achado.programa;

      let cartao = e.cartoes.find((c) => c.clienteId === cliente.id && c.programaId === programaId);
      let novo = false;
      if (!cartao) {
        cartao = {
          id: id(), clienteId: cliente.id, programaId, negocioId: achado.negocio.id,
          carimbos: 0, pontos: 0, totalCarimbos: 0, premiosGanhos: 0,
          aderiuEm: agora(), ultimoEm: null,
        };
        e.cartoes.push(cartao);
        e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'adesao', quantidade: 0, em: agora() });
        novo = true;
      }

      /* Arrefecimento: impede que se carimbe dez vezes seguidas ao balcão. */
      if (cartao.ultimoEm && p.arrefecimento) {
        const passou = (Date.now() - new Date(cartao.ultimoEm).getTime()) / 1000;
        if (passou < p.arrefecimento) {
          const faltam = Math.ceil((p.arrefecimento - passou) / 60);
          const err = new Error(`Já foi carimbado há pouco. Volte a tentar daqui a ${faltam} min.`);
          err.codigo = 'arrefecimento'; err.faltam = faltam; throw err;
        }
      }

      if (chaveUso) e.usados[chaveUso] = agora();
      cartao.ultimoEm = agora();

      const ganhos = [];
      if (p.tipo === 'pontos') {
        const antes = cartao.pontos;
        cartao.pontos += quantidade;
        for (const m of (p.marcos || [])) {
          if (antes < m.pontos && cartao.pontos >= m.pontos) {
            const premio = { id: id(), cartaoId: cartao.id, descricao: m.premio, ganhoEm: agora(), resgatadoEm: null };
            e.premios.push(premio); ganhos.push(premio); cartao.premiosGanhos++;
          }
        }
      } else {
        cartao.carimbos += quantidade;
        cartao.totalCarimbos += quantidade;
        while (cartao.carimbos >= p.objetivo) {
          cartao.carimbos -= p.objetivo;
          const premio = { id: id(), cartaoId: cartao.id, descricao: p.premio, ganhoEm: agora(), resgatadoEm: null };
          e.premios.push(premio); ganhos.push(premio); cartao.premiosGanhos++;
        }
      }

      e.movimentos.push({
        id: id(), cartaoId: cartao.id, tipo: p.tipo === 'pontos' ? 'pontos' : 'carimbo',
        quantidade, operador, manual: manual || undefined, em: agora(),
      });
      for (const g of ganhos) {
        e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'premio', quantidade: 0, nota: g.descricao, em: agora() });
      }
      gravar(e);

      return {
        cartao: comporCartao(e, cartao),
        cliente: { publico: cliente.publico, nome: cliente.nome },
        ganhos, novo, quantidade, manual,
      };
    },

    async resgatar({ premioId, operador = 'Balcão' }) {
      const e = estado();
      const premio = e.premios.find((p) => p.id === premioId);
      if (!premio) throw new Error('Prémio não encontrado');
      if (premio.resgatadoEm) { const err = new Error('Este prémio já foi entregue.'); err.codigo = 'ja-resgatado'; throw err; }
      premio.resgatadoEm = agora();
      premio.resgatadoPor = operador;
      e.movimentos.push({ id: id(), cartaoId: premio.cartaoId, tipo: 'resgate', quantidade: 0, nota: premio.descricao, operador, em: agora() });
      gravar(e);
      const cartao = e.cartoes.find((c) => c.id === premio.cartaoId);
      return { premio, cartao: comporCartao(e, cartao) };
    },

    async anular({ movimentoId }) {
      const e = estado();
      const m = e.movimentos.find((x) => x.id === movimentoId);
      if (!m) throw new Error('Movimento não encontrado');
      if ((Date.now() - new Date(m.em).getTime()) > 120000) {
        const err = new Error('Já passaram mais de 2 minutos — não dá para anular.');
        err.codigo = 'tarde'; throw err;
      }
      const cartao = e.cartoes.find((c) => c.id === m.cartaoId);
      const p = programa(e, cartao.programaId).programa;
      if (m.tipo === 'pontos') cartao.pontos = Math.max(0, cartao.pontos - m.quantidade);
      else if (m.tipo === 'carimbo') {
        cartao.carimbos -= m.quantidade;
        cartao.totalCarimbos = Math.max(0, cartao.totalCarimbos - m.quantidade);
        if (cartao.carimbos < 0) {
          /* Anulou-se o carimbo que completou o cartão: desfaz-se o prémio. */
          const ultimo = e.premios.filter((x) => x.cartaoId === cartao.id && !x.resgatadoEm).pop();
          if (ultimo) { e.premios = e.premios.filter((x) => x !== ultimo); cartao.premiosGanhos--; }
          cartao.carimbos += p.objetivo;
        }
      }
      e.movimentos = e.movimentos.filter((x) => x.id !== movimentoId);
      e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'anulado', quantidade: 0, nota: 'Movimento anulado', em: agora() });
      gravar(e);
      return { cartao: comporCartao(e, cartao) };
    },

    async fundar(dados) {
      /* Na demonstração não há convite nenhum a validar: cria-se o negócio
         e pronto. Serve para o ecrã ser o mesmo nos dois modos. */
      const e = estado();
      const negocioId = id();
      const slug = String(dados.nome || 'negocio').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'negocio';
      const negocio = {
        id: negocioId, slug, nome: dados.nome, categoria: dados.categoria || null,
        cor: dados.cor || '#17161C', localidade: dados.localidade || null,
        criadoEm: agora(),
        programas: [{
          id: id(), negocioId, nome: dados.programa || 'Cartão de cliente',
          tipo: 'carimbos', selo: dados.selo || 'carimbo',
          objetivo: Math.max(2, Math.min(30, Number(dados.objetivo) || 10)),
          premio: dados.premio || 'Um brinde por conta da casa',
          regras: dados.regras || 'Um carimbo por visita.',
          arrefecimento: 3600, ativo: 1, criadoEm: agora(),
        }],
      };
      e.negocios.push(negocio);
      const operador = { id: id(), negocioId, nome: dados.operador || 'Balcão', papel: 'dono' };
      e.operadores.push(operador);
      gravar(e);
      return { negocio: { id: negocioId, slug, nome: dados.nome }, sessao: 'demo:' + operador.id, operadorId: operador.id };
    },

    async negocioDoOperador(operadorId) {
      const e = estado();
      const o = e.operadores.find((x) => x.id === operadorId) || e.operadores[0];
      const n = e.negocios.find((x) => x.id === o.negocioId);
      return { operador: o, negocio: n };
    },

    async resumo(negocioId) {
      const e = estado();
      const cartoes = e.cartoes.filter((c) => c.negocioId === negocioId);
      const ids = new Set(cartoes.map((c) => c.id));
      const movimentos = e.movimentos.filter((m) => ids.has(m.cartaoId));
      const desde = (dias) => Date.now() - dias * 86400000;
      const carimbos = movimentos.filter((m) => m.tipo === 'carimbo' || m.tipo === 'pontos');
      const premios = e.premios.filter((p) => ids.has(p.cartaoId));
      return {
        clientes: cartoes.length,
        novos30: cartoes.filter((c) => new Date(c.aderiuEm).getTime() > desde(30)).length,
        carimbosHoje: carimbos.filter((m) => new Date(m.em).toDateString() === new Date().toDateString()).length,
        carimbos30: carimbos.filter((m) => new Date(m.em).getTime() > desde(30)).length,
        premiosGanhos: premios.length,
        premiosResgatados: premios.filter((p) => p.resgatadoEm).length,
        porResgatar: premios.filter((p) => !p.resgatadoEm).length,
        /* Os dois números que mudam decisões: quem está quase lá e quem se
           está a afastar. Um serve para convidar, o outro para recuperar. */
        quaseLa: cartoes.filter((c) => {
          const p = programa(e, c.programaId).programa;
          if (p.tipo === 'pontos') return false;
          return p.objetivo - c.carimbos <= 2 && p.objetivo - c.carimbos > 0;
        }).length,
        aFugir: cartoes.filter((c) => c.ultimoEm && new Date(c.ultimoEm).getTime() < desde(60)).length,
      };
    },

    async clientesDoNegocio(negocioId) {
      const e = estado();
      return e.cartoes
        .filter((c) => c.negocioId === negocioId)
        .map((c) => {
          const cliente = e.clientes.find((x) => x.id === c.clienteId);
          const p = programa(e, c.programaId).programa;
          return {
            publico: cliente ? cliente.publico : '??????',
            nome: cliente && cliente.nome,
            carimbos: c.carimbos, pontos: c.pontos, objetivo: p.objetivo, tipo: p.tipo,
            ultimoEm: c.ultimoEm, aderiuEm: c.aderiuEm,
            porResgatar: e.premios.filter((x) => x.cartaoId === c.id && !x.resgatadoEm).length,
          };
        })
        .sort((a, b) => new Date(b.ultimoEm || b.aderiuEm) - new Date(a.ultimoEm || a.aderiuEm));
    },

    async guardarPrograma(negocioId, dados) {
      const e = estado();
      const n = e.negocios.find((x) => x.id === negocioId);
      if (!n) throw new Error('Negócio não encontrado');
      const existente = n.programas.find((p) => p.id === dados.id);
      if (existente) Object.assign(existente, dados);
      else n.programas.push({ ...dados, id: dados.id || id(), negocioId, ativo: 1, criadoEm: agora() });
      gravar(e);
      return n.programas;
    },

    async guardarNegocio(negocioId, dados) {
      const e = estado();
      const n = e.negocios.find((x) => x.id === negocioId);
      Object.assign(n, dados);
      gravar(e);
      return n;
    },

    async apagarTudo(clienteId) {
      const e = estado();
      const meus = e.cartoes.filter((c) => c.clienteId === clienteId).map((c) => c.id);
      e.cartoes = e.cartoes.filter((c) => c.clienteId !== clienteId);
      e.movimentos = e.movimentos.filter((m) => !meus.includes(m.cartaoId));
      e.premios = e.premios.filter((p) => !meus.includes(p.cartaoId));
      e.clientes = e.clientes.filter((c) => c.id !== clienteId);
      gravar(e);
      return { apagado: true };
    },

    async exportar(clienteId) {
      const e = estado();
      const cliente = e.clientes.find((c) => c.id === clienteId);
      const cartoes = e.cartoes.filter((c) => c.clienteId === clienteId);
      const ids = cartoes.map((c) => c.id);
      return {
        geradoEm: agora(),
        cliente,
        cartoes: cartoes.map((c) => comporCartao(e, c)),
        movimentos: e.movimentos.filter((m) => ids.includes(m.cartaoId)),
        premios: e.premios.filter((p) => ids.includes(p.cartaoId)),
      };
    },

    /* Enche o demo com um histórico plausível, para não se ver um site vazio. */
    async semear(clienteId) {
      const e = estado();
      const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
      const receitas = [
        { programaId: 'p-torrado', carimbos: 7, visitas: 7, ultimo: 2 },
        { programaId: 'p-navalha', carimbos: 6, visitas: 6, ultimo: 11 },
        { programaId: 'p-camelia', pontos: 430, visitas: 5, ultimo: 6 },
        { programaId: 'p-forno', carimbos: 3, visitas: 3, ultimo: 23 },
      ];
      for (const r of receitas) {
        if (e.cartoes.some((c) => c.clienteId === clienteId && c.programaId === r.programaId)) continue;
        const achado = programa(e, r.programaId);
        const cartao = {
          id: id(), clienteId, programaId: r.programaId, negocioId: achado.negocio.id,
          carimbos: r.carimbos || 0, pontos: r.pontos || 0,
          totalCarimbos: r.carimbos || 0, premiosGanhos: 0,
          aderiuEm: dias(r.ultimo + r.visitas * 7), ultimoEm: dias(r.ultimo),
        };
        e.cartoes.push(cartao);
        e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'adesao', quantidade: 0, em: cartao.aderiuEm });
        for (let i = r.visitas - 1; i >= 0; i--) {
          e.movimentos.push({
            id: id(), cartaoId: cartao.id,
            tipo: achado.programa.tipo === 'pontos' ? 'pontos' : 'carimbo',
            quantidade: achado.programa.tipo === 'pontos' ? Math.round(r.pontos / r.visitas) : 1,
            operador: 'Balcão', em: dias(r.ultimo + i * 7),
          });
        }
      }
      /* Um cartão já completo, para se ver o estado «pronto a levantar». */
      const gelo = e.cartoes.find((c) => c.clienteId === clienteId && c.programaId === 'p-gelato');
      if (!gelo) {
        const achado = programa(e, 'p-gelato');
        const cartao = {
          id: id(), clienteId, programaId: 'p-gelato', negocioId: achado.negocio.id,
          carimbos: 0, pontos: 0, totalCarimbos: 9, premiosGanhos: 1,
          aderiuEm: dias(40), ultimoEm: dias(1),
        };
        e.cartoes.push(cartao);
        e.premios.push({ id: id(), cartaoId: cartao.id, descricao: achado.programa.premio, ganhoEm: dias(1), resgatadoEm: null });
        e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'adesao', quantidade: 0, em: dias(40) });
        for (let i = 8; i >= 0; i--) {
          e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'carimbo', quantidade: 1, operador: 'Balcão', em: dias(1 + i * 4) });
        }
        e.movimentos.push({ id: id(), cartaoId: cartao.id, tipo: 'premio', quantidade: 0, nota: achado.programa.premio, em: dias(1) });
      }
      gravar(e);
    },

    async guardarEmail(email) {
      const e = estado();
      /* Na demonstração não há email nenhum a sair daqui — mas o fluxo é o
         mesmo, para se poder experimentar o ecrã todo. */
      e.codigoDemo = '000000';
      e.emailDemo = email;
      gravar(e);
      return { enviado: false, demo: true };
    },

    async confirmarEmail(email, codigo) {
      const e = estado();
      if (codigo !== (e.codigoDemo || '000000')) {
        const err = new Error('Na demonstração o código é 000000.');
        err.codigo = 'codigo-invalido'; throw err;
      }
      const cliente = e.clientes.find((c) => c.email === null || c.email === undefined) || e.clientes[0];
      if (cliente) { cliente.email = email; gravar(e); }
      return { ok: true };
    },

    async limpar() {
      guardar(CHAVE, null);
      try { localStorage.removeItem('carimbo:demo'); } catch { /* nada */ }
    },
  };
  return api;
}

/* =========================================================================
   O que a app usa
   ========================================================================= */

const demo = criarDemo();
const remoto = MODO === 'remoto' ? criarRemoto(CONFIG.api) : null;

/* Enquanto o Worker não estiver no ar, tudo passa pelo demo. Quando estiver,
   troca-se aqui — a app não sabe a diferença. */
export const api = MODO === 'remoto'
  ? {
      registarCliente: () => remoto.pedir('/v1/cliente/registar', { metodo: 'POST' }),
      cartoes: () => remoto.pedir('/v1/cliente/cartoes'),
      cartao: (_, cartaoId) => remoto.pedir(`/v1/cliente/cartoes/${cartaoId}`),
      descobrir: () => remoto.pedir('/v1/descobrir'),
      aderir: (_, programaId) => remoto.pedir('/v1/cliente/aderir', { metodo: 'POST', corpo: { programaId } }),
      carimbar: (dados) => remoto.pedir('/v1/balcao/carimbar', { metodo: 'POST', corpo: dados }),
      resgatar: (dados) => remoto.pedir('/v1/balcao/resgatar', { metodo: 'POST', corpo: dados }),
      anular: (dados) => remoto.pedir('/v1/balcao/anular', { metodo: 'POST', corpo: dados }),
      fundar: (dados) => remoto.pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: dados }),
      entrarBalcao: (email) => remoto.pedir('/v1/balcao/entrar', { metodo: 'POST', corpo: { email } }),
      sessaoBalcao: (email, codigo) =>
        remoto.pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email, codigo } }),
      negocioDoOperador: () => remoto.pedir('/v1/balcao/negocio'),
      resumo: () => remoto.pedir('/v1/balcao/resumo'),
      clientesDoNegocio: () => remoto.pedir('/v1/balcao/clientes'),
      guardarPrograma: (_, dados) => remoto.pedir('/v1/balcao/programas', { metodo: 'POST', corpo: dados }),
      guardarNegocio: (_, dados) => remoto.pedir('/v1/balcao/negocio', { metodo: 'PUT', corpo: dados }),
      guardarEmail: (email) => remoto.pedir('/v1/cliente/email', { metodo: 'POST', corpo: { email } }),
      confirmarEmail: (email, codigo) =>
        remoto.pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email, codigo } }),
      apagarTudo: () => remoto.pedir('/v1/cliente', { metodo: 'DELETE' }),
      exportar: () => remoto.pedir('/v1/cliente/dados'),
      semear: async () => {},
      limpar: async () => {},
    }
  : demo;
