/* =========================================================================
   Carimbo Digital — Worker da Cloudflare

   É o único servidor que este projecto tem. Faz três coisas:
     · guarda os cartões (D1, que é SQLite)
     · verifica os códigos que o balcão lê
     · aplica as regras — arrefecimento, tectos, prémios

   Corre no plano gratuito: 100 000 pedidos por dia, e nada de criptografia
   pesada. Por isso não há palavras-passe nem derivação de chaves lenta em
   lado nenhum — só HMAC-SHA256, que é nativo e custa microssegundos.

   Segredos a pôr com `wrangler secret put`:
     CHAVE_MESTRA        — 32 bytes em base64url; deriva os segredos dos
                           dispositivos. Se mudar, todos os códigos deixam de
                           valer (por isso há `chave_versao` na tabela).
     MAIL_TOKEN          — opcional; o token da API de correio da Hostinger
                           (hPanel › Emails › o domínio › Agentic mail › API,
                           e não o de hpanel.hostinger.com/api, que é de outra
                           API e leva 401). Sem ele não se enviam emails e a
                           app continua a funcionar, só sem recuperação de
                           conta por email. Anda a par do MAIL_CAIXA, que não
                           é segredo e está no wrangler.toml.
   ========================================================================= */

import { emailCodigoCliente, emailCodigoBalcao, emailContaAApagar } from './emails.js';
import {
  assinarRS256, classeDePrograma, objetoDeCartao, ligacaoDeGravacao, actualizacaoDeSaldo,
  actualizacaoDeClasse,
} from './wallet.js';
import {
  construirPasse, passeDeCartao, certificadosDoPEM, emissorESerie, doPEM,
} from './pkpass.js';

const JANELA = 15;                 // segundos de vida de um código
const TOLERANCIA = 2;              // janelas de folga para relógios desencontrados
const SESSAO_DIAS = 180;
const ENTRADA_MINUTOS = 15;
const ENTRADA_TENTATIVAS = 5;
const USADOS_HORAS = 24;           // quanto tempo se guarda um código já gasto
const ENVIOS_HORA = 5;             // códigos por morada, por hora
const ENVIOS_INTERVALO = 45;       // segundos entre dois pedidos para a mesma morada

/* Tectos do que um negócio pode escrever. Não é desconfiança do dono do café:
   é que tudo isto é pintado na lista pública, a toda a gente, e uma conta
   legítima chega para encher o ecrã dos outros — de propósito ou por engano.
   O `descobrir` percorre negócio a negócio e programa a programa, e as
   «linhas lidas» do D1 gratuito acabam aos cinco milhões por dia. */
const PROGRAMAS_MAX = 12;          // cartões diferentes por negócio
const DESCOBRIR_MAX = 200;         // negócios devolvidos na lista pública
const TIPOS = ['carimbos', 'pontos'];

/* Contas paradas. O RGPD (art. 5.º, n.º 1, alínea e) não deixa guardar dados
   pessoais mais tempo do que o preciso, e uma conta que ninguém abre há dois
   anos é exactamente isso — sobretudo quando tem uma morada de email colada.
   Estes dois números são a fonte da verdade: a política de privacidade
   lê-os daqui na construção do site, e se desaparecerem a construção morre. */
const INACTIVA_MESES = 24;         // sem dar sinal este tempo, a conta é apagada
const AVISO_DIAS = 30;             // com aviso por email, este tempo antes

/* =========================================================================
   Respostas
   ========================================================================= */

function origensPermitidas(env) {
  return String(env.ORIGENS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function cabecalhosCORS(pedido, env) {
  const origem = pedido.headers.get('origin') || '';
  const lista = origensPermitidas(env);
  /* Sem lista configurada aceita-se tudo — é o que serve para desenvolver.
     Em produção põe-se ORIGENS=https://carimbodigital.pt e fecha-se a porta. */
  const permitida = lista.length === 0 || lista.includes(origem);
  return {
    'access-control-allow-origin': permitida ? (origem || '*') : lista[0],
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(dados, { estado = 200, pedido, env } = {}) {
  return new Response(JSON.stringify(dados), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(pedido ? cabecalhosCORS(pedido, env) : {}),
    },
  });
}

class Falha extends Error {
  constructor(mensagem, { estado = 400, codigo = null, extra = {} } = {}) {
    super(mensagem);
    this.estado = estado;
    this.codigo = codigo;
    this.extra = extra;
  }
}

/* =========================================================================
   Miudezas
   ========================================================================= */

const agora = () => new Date().toISOString();

function bytesParaHex(b) {
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64url(texto) {
  const s = texto.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function id() {
  return bytesParaHex(crypto.getRandomValues(new Uint8Array(16)));
}

/* Alfabeto sem 0/O, 1/I/L, 5/S, 8/B: ao balcão estes números são ditos em voz
   alta e escritos à mão, e cada confusão dessas é um cliente irritado. */
const ALFABETO = '234679ACDEFGHJKLMNPQRTUVWXYZ';
function publicoNovo(n = 6) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
}

/* Seis dígitos, sorteados sem viés (rejeita os valores que não cabem num
   múltiplo de um milhão — o resto de 2^32 % 1e6 tornaria os primeiros
   códigos ligeiramente mais prováveis). */
function codigoEntrada() {
  const b = new Uint32Array(1);
  const limite = Math.floor(0xffffffff / 1000000) * 1000000;
  do { crypto.getRandomValues(b); } while (b[0] >= limite);
  return String(b[0] % 1000000).padStart(6, '0');
}

async function resumo(texto) {
  return bytesParaHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

async function hmac(chaveBytes, mensagem) {
  const chave = await crypto.subtle.importKey(
    'raw', chaveBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(mensagem));
}

/**
 * O segredo de um dispositivo não se guarda: deriva-se.
 *
 * segredo = HMAC(CHAVE_MESTRA, "c1:<cliente_id>")
 *
 * A app guarda-o; o servidor volta a calculá-lo sempre que precisa. A tabela
 * `clientes` fica sem nada que sirva para forjar um código, e não há nenhuma
 * coluna de segredos para alguém deixar escapar num backup.
 */
async function derivarSegredo(env, clienteId) {
  const mestra = deBase64url(env.CHAVE_MESTRA);
  return base64url(await hmac(mestra, `c1:${clienteId}`));
}

/* Comparação em tempo constante — a diferença é irrelevante para um HMAC de
   16 dígitos, mas é o hábito certo e não custa nada. */
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* =========================================================================
   Sessões
   ========================================================================= */

async function criarSessao(env, sujeito) {
  const testemunho = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expira = new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em) VALUES (?, ?, ?, ?)'
  ).bind(await resumo(testemunho), sujeito, agora(), expira).run();
  return testemunho;
}

async function lerSessao(env, pedido) {
  const cabecalho = pedido.headers.get('authorization') || '';
  const testemunho = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!testemunho) return null;
  const linha = await env.DB.prepare(
    'SELECT sujeito, expira_em FROM sessoes WHERE resumo = ?'
  ).bind(await resumo(testemunho)).first();
  if (!linha) return null;
  if (new Date(linha.expira_em) < new Date()) return null;
  const [tipo, valor] = linha.sujeito.split(':');
  return { tipo, id: valor };
}

async function exigirCliente(env, pedido) {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'cliente') throw new Falha('Sessão inválida', { estado: 401 });
  await marcarVisto(env, s.id);
  return s.id;
}

/**
 * Guarda que a conta deu sinal de vida.
 *
 * Existia uma coluna `visto_em` desde o primeiro dia e nada lhe tocava depois
 * do registo — ficava presa à data em que a conta nasceu. Quem quisesse apagar
 * contas paradas por essa coluna apagava toda a gente ao fim de dois anos,
 * incluindo quem usasse a app todas as semanas.
 *
 * Escreve-se no máximo uma vez por dia. Sem essa condição, abrir a app passava
 * a custar uma escrita por pedido, e o plano gratuito do D1 dá 100 000 por dia
 * — que é o mesmo tecto do Workers, mas gasto muito mais depressa. Com ela, a
 * linha só é escrita quando o dia mudou; nos outros casos o UPDATE não
 * encontra nada e não escreve.
 */
async function marcarVisto(env, clienteId) {
  const ontem = new Date(Date.now() - 86400000).toISOString();
  /* O `avisada_em` cai aqui de propósito: quem voltou deixou de estar parado,
     e se um dia voltar a parar tem direito a um aviso novo em vez de ser
     apagado em silêncio por causa de um aviso de há dois anos. */
  await env.DB.prepare(
    'UPDATE clientes SET visto_em = ?, avisada_em = NULL WHERE id = ? AND (visto_em IS NULL OR visto_em < ?)'
  ).bind(agora(), clienteId, ontem).run();
}

async function exigirOperador(env, pedido) {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'operador') throw new Falha('Sessão inválida', { estado: 401 });
  const op = await env.DB.prepare(
    'SELECT * FROM operadores WHERE id = ? AND ativo = 1'
  ).bind(s.id).first();
  if (!op) throw new Falha('Operador desativado', { estado: 403 });
  return op;
}

/* =========================================================================
   Leitura de programas e cartões
   ========================================================================= */

async function programaCompleto(env, programaId) {
  const p = await env.DB.prepare(
    `SELECT p.*, n.nome AS negocio_nome, n.slug AS negocio_slug, n.cor AS negocio_cor,
            n.categoria AS negocio_categoria, n.localidade AS negocio_localidade,
            n.morada AS negocio_morada, n.telefone AS negocio_telefone,
            (n.logotipo IS NOT NULL) AS negocio_tem_logotipo
       FROM programas p JOIN negocios n ON n.id = p.negocio_id
      WHERE p.id = ?`
  ).bind(programaId).first();
  if (!p) return null;
  const marcos = p.tipo === 'pontos'
    ? (await env.DB.prepare(
        'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
      ).bind(programaId).all()).results
    : null;
  return { ...p, marcos };
}

function moldarPrograma(p) {
  return {
    id: p.id, nome: p.nome, tipo: p.tipo, selo: p.selo,
    objetivo: p.objetivo, premio: p.premio, regras: p.regras,
    arrefecimento: p.arrefecimento, marcos: p.marcos || null,
  };
}

function moldarNegocio(p) {
  return {
    id: p.negocio_id, nome: p.negocio_nome, slug: p.negocio_slug,
    cor: p.negocio_cor, categoria: p.negocio_categoria,
    localidade: p.negocio_localidade, morada: p.negocio_morada,
    telefone: p.negocio_telefone,
  };
}

async function moldarCartao(env, cartao) {
  const p = await programaCompleto(env, cartao.programa_id);
  if (!p) return null;
  const premios = (await env.DB.prepare(
    'SELECT id, descricao, ganho_em FROM premios WHERE cartao_id = ? AND resgatado_em IS NULL ORDER BY ganho_em'
  ).bind(cartao.id).all()).results;
  return moldeDeCartao(env, cartao, p, premios);
}

/**
 * A FORMA de um cartão, sem ir à base buscar nada.
 *
 * Existe para haver UM sítio que a define. O `moldarCartao` lê o que precisa e
 * chama isto; o `moldarCartoes` lê tudo de uma vez, para muitos cartões, e
 * chama isto também. Duas cópias desta forma divergiam ao primeiro campo novo
 * — e a app que está nos telemóveis lê-a por nome.
 */
function moldeDeCartao(env, cartao, p, premios) {
  return {
    id: cartao.id,
    clienteId: cartao.cliente_id,
    programaId: cartao.programa_id,
    carimbos: cartao.carimbos,
    pontos: cartao.pontos,
    totalCarimbos: cartao.total_carimbos,
    premiosGanhos: cartao.premios_ganhos,
    aderiuEm: cartao.aderiu_em,
    ultimoEm: cartao.ultimo_em,
    negocio: moldarNegocio(p),
    programa: moldarPrograma(p),
    porResgatar: premios.length,
    premios: premios.map((x) => ({ id: x.id, descricao: x.descricao, ganhoEm: x.ganho_em })),
    /* Que botões de carteira vale a pena mostrar neste cartão. Nenhuma das
       condições é adivinhável do lado do telemóvel: é preciso o Worker ter
       conta na Google ou certificado da Apple, e o negócio ter logótipo — sem
       ele as duas recusam o passe. Vai aqui em vez de a app tentar e apanhar
       o erro, porque um botão que só falha ao ser tocado é pior do que um
       botão que não está lá. A coluna do logótipo NÃO viaja: o que viaja é a
       resposta a «existe?».

       São duas e não uma: a Google já está no ar e a Apple espera pelo
       certificado, e o telemóvel de quem usa a app não tem de saber disso —
       vê os botões que servem. */
    carteiras: {
      google: Boolean(walletLigada(env) && p.negocio_tem_logotipo),
      apple: Boolean(applePronta(env) && p.negocio_tem_logotipo),
    },
    /* O NOME ANTIGO FICA. Isto chamava-se `wallet` e era um booleano, e mudar
       o nome apagou o botão da Wallet da aplicação que estava no ar — o
       Worker publica-se num minuto e o site demora dez, e nesse intervalo a
       app pedia um campo que já não vinha.

       E o intervalo é o menor dos problemas: isto é uma app instalada no ecrã
       inicial de gente, com o JavaScript em cache de um service worker. A
       cópia que uma pessoa tem pode ser de há semanas. Uma API que muda nomes
       parte essas cópias em silêncio — ninguém vê um erro, só um botão que
       deixou de lá estar.

       A regra, daqui em diante: esta API ACRESCENTA. Não renomeia nem tira. */
    wallet: Boolean(walletLigada(env) && p.negocio_tem_logotipo),
  };
}

/**
 * Vários cartões de uma vez, com um número FIXO de consultas.
 *
 * O `moldarCartao` custa duas a três consultas por cartão, e uma invocação de
 * Worker tem tecto de cinquenta subpedidos. Chamado em ciclo — o que a
 * carteira e a exportação de dados faziam — bastavam uns dez cartões para a
 * resposta rebentar com «Too many subrequests» e sair um 500.
 *
 * Aqui são quatro consultas, quantos cartões forem: os programas, os marcos,
 * os prémios por resgatar, e nada mais. A lista de `IN (...)` é montada com
 * tantos `?` quantos os valores — nunca com os valores lá dentro.
 */
async function moldarCartoes(env, cartoes) {
  if (!cartoes.length) return [];

  /* O D1 ACEITA CEM PARÂMETROS POR CONSULTA, e nem um a mais. Um `IN (?, ?,
     …)` com a lista toda resolvia o N+1 e punha o mesmo problema cem cartões
     mais à frente — que é o género de tecto que ninguém encontra a testar e
     alguém encontra a usar. Parte-se em lotes de noventa, que deixa folga
     para os parâmetros que a consulta já leva. */
  const POR_LOTE = 90;
  const emLotes = async (valores, consulta) => {
    const saida = [];
    for (let i = 0; i < valores.length; i += POR_LOTE) {
      const lote = valores.slice(i, i + POR_LOTE);
      const marcas = lote.map(() => '?').join(',');
      saida.push(...(await env.DB.prepare(consulta(marcas)).bind(...lote).all()).results);
    }
    return saida;
  };

  const idsProgramas = [...new Set(cartoes.map((c) => c.programa_id))];
  const programas = await emLotes(idsProgramas, (marcas) =>
    `SELECT p.*, n.nome AS negocio_nome, n.slug AS negocio_slug, n.cor AS negocio_cor,
            n.categoria AS negocio_categoria, n.localidade AS negocio_localidade,
            n.morada AS negocio_morada, n.telefone AS negocio_telefone,
            (n.logotipo IS NOT NULL) AS negocio_tem_logotipo
       FROM programas p JOIN negocios n ON n.id = p.negocio_id
      WHERE p.id IN (${marcas})`);
  const porPrograma = new Map(programas.map((p) => [p.id, p]));

  /* Os marcos só existem nos programas de pontos. Se não houver nenhum, não
     se gasta a consulta. */
  const dePontos = programas.filter((p) => p.tipo === 'pontos').map((p) => p.id);
  if (dePontos.length) {
    const marcos = await emLotes(dePontos, (marcas) =>
      `SELECT programa_id, pontos, premio FROM marcos
        WHERE programa_id IN (${marcas}) ORDER BY pontos`);
    for (const p of programas) if (p.tipo === 'pontos') p.marcos = [];
    for (const m of marcos) {
      const p = porPrograma.get(m.programa_id);
      if (p) p.marcos.push({ pontos: m.pontos, premio: m.premio });
    }
  }

  const idsCartoes = cartoes.map((c) => c.id);
  const premios = await emLotes(idsCartoes, (marcas) =>
    `SELECT id, cartao_id, descricao, ganho_em FROM premios
      WHERE cartao_id IN (${marcas}) AND resgatado_em IS NULL
      ORDER BY ganho_em`);
  const porCartao = new Map();
  for (const pr of premios) {
    const lista = porCartao.get(pr.cartao_id) || [];
    lista.push(pr);
    porCartao.set(pr.cartao_id, lista);
  }

  return cartoes.map((cartao) => {
    const p = porPrograma.get(cartao.programa_id);
    if (!p) return null;
    const meus = porCartao.get(cartao.id) || [];
    return moldeDeCartao(env, cartao, p, meus);
  });
}

/* =========================================================================
   O carimbo — o coração de tudo
   ========================================================================= */

async function carimbar(env, pedido, operador) {
  const corpo = await corpoJSON(pedido);
  const { codigo, programaId } = corpo;
  /* Arredondado, e não só limitado: sem o `Math.round` um pedido com
     `quantidade: 3.7` gravava 3,7 pontos no cartão, e a partir daí todos os
     totais daquele cliente ficavam com casas decimais. Um carimbo é uma
     coisa inteira. */
  let quantidade = Math.max(1, Math.min(500, Math.round(Number(corpo.quantidade)) || 1));
  let manual = Boolean(corpo.manual);

  /* Sem isto, um pedido sem `programaId` chegava ao D1 com um valor por
     ligar, e o D1 atira — o que saía era um 500 «Erro interno» em vez de
     dizer o que falta. Quem está do outro lado é um balcão a tentar
     perceber porque é que não carimba. */
  exigirTexto(programaId, 'programaId');
  const p = await programaCompleto(env, programaId);
  if (!p) throw new Falha('Programa não encontrado', { estado: 404 });
  if (p.negocio_id !== operador.negocio_id) {
    throw new Falha('Este programa não é deste negócio', { estado: 403 });
  }
  if (p.tipo !== 'pontos') quantidade = 1;

  /* --- quem é o cliente --- */
  const partes = String(codigo || '').split('.');
  let publico, janela = null;
  let porPasse = null;
  if (partes[0] === 'M1' && partes.length === 2) {
    publico = partes[1].toUpperCase();
    manual = true;
  } else if (partes[0] === 'C1' && partes.length === 4) {
    publico = partes[1];
    janela = Number(partes[2]);
  } else if (partes[0] === 'W1' && partes.length === 2) {
    /* O CÓDIGO DO PASSE NA CARTEIRA DO TELEMÓVEL, e isto faltava por inteiro.
       O `wallet.js` e o `pkpass.js` escrevem `W1.<codigo>` no código de
       barras do passe desde sempre, com um comentário a dizer que «é por ele
       que o balcão sabe que está a ler um passe» — e ninguém do lado de cá o
       sabia. O prefixo caía neste `else` e o que saía era «Este código não é
       de um cartão Carimbo Digital». Provado contra a produção: um passe
       criado pela app, lido pelo balcão, recusado.

       O `wallet_codigo` era escrito e nunca lido: as únicas ocorrências dele
       em todo o Worker eram dois UPDATE. O índice único que o acompanha
       existia para uma pesquisa que nunca foi escrita. É esta.

       Não é `manual`: quem lê isto é a câmara, não um dedo a escrever seis
       letras. E é um token PRÓPRIO do passe, e não o número do cliente — é
       isso que permite revogar um passe fotografado sem mexer no cartão da
       pessoa. */
    porPasse = partes[1].toUpperCase();
  } else {
    throw new Falha('Este código não é de um cartão Carimbo Digital.', { codigo: 'formato' });
  }

  const cliente = porPasse
    ? await env.DB.prepare(
        `SELECT cl.id, cl.publico FROM cartoes c
           JOIN clientes cl ON cl.id = c.cliente_id
          WHERE c.wallet_codigo = ?`
      ).bind(porPasse).first()
    : await env.DB.prepare(
        'SELECT id, publico FROM clientes WHERE publico = ?'
      ).bind(publico).first();
  if (!cliente) {
    throw new Falha(porPasse
      ? 'Este passe já não vale. O cliente pode mostrar o código na app.'
      : 'Cartão desconhecido.',
    { estado: 404, codigo: porPasse ? 'sem-passe' : 'sem-cliente' });
  }

  /* --- o código é válido? --- */
  let chaveUso = null;
  if (janela !== null) {
    const atual = Math.floor(Date.now() / 1000 / JANELA);
    if (!Number.isFinite(janela) || Math.abs(atual - janela) > TOLERANCIA) {
      throw new Falha('Código expirado. Peça para atualizar o ecrã.', { codigo: 'expirado' });
    }
    const segredo = await derivarSegredo(env, cliente.id);
    const esperado = bytesParaHex(await hmac(deBase64url(segredo), `${publico}.${janela}`)).slice(0, 16);
    if (!iguais(esperado, partes[3])) {
      throw new Falha('Código inválido.', { estado: 403, codigo: 'assinatura' });
    }
    chaveUso = `${publico}:${janela}`;
  }

  /* --- o cartão --- */
  let cartao = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
  ).bind(cliente.id, programaId).first();

  const novo = !cartao;
  const instrucoes = [];
  if (!cartao) {
    const cartaoId = id();
    await env.DB.prepare(
      `INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, aderiu_em)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(cartaoId, cliente.id, programaId, p.negocio_id, agora()).run();
    await env.DB.prepare(
      'INSERT INTO movimentos (id, cartao_id, tipo, em) VALUES (?, ?, ?, ?)'
    ).bind(id(), cartaoId, 'adesao', agora()).run();
    cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  }

  /* --- arrefecimento --- */
  if (cartao.ultimo_em && p.arrefecimento > 0) {
    const passou = (Date.now() - new Date(cartao.ultimo_em).getTime()) / 1000;
    if (passou < p.arrefecimento) {
      const faltam = Math.ceil((p.arrefecimento - passou) / 60);
      throw new Falha(
        `Já foi carimbado há pouco. Volte a tentar daqui a ${faltam} min.`,
        { estado: 429, codigo: 'arrefecimento', extra: { faltam } });
    }
  }

  /* --- tecto diário --- */
  const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
  const hoje = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM movimentos
      WHERE cartao_id = ? AND tipo IN ('carimbo','pontos') AND em >= ?`
  ).bind(cartao.id, inicioDia.toISOString()).first();
  if (p.maximo_diario > 0 && hoje.n >= p.maximo_diario) {
    throw new Falha('Este cartão já chegou ao máximo de hoje.',
      { estado: 429, codigo: 'maximo-diario' });
  }

  /* --- só agora se queima o código ---
     Queimá-lo antes das regras gastava-o à toa: quem chegasse dentro do
     arrefecimento ficava sem carimbo E sem código, e tinha de esperar pelos
     quinze segundos seguintes sem perceber porquê. A chave primária é que
     garante a unicidade — não um SELECT antes do INSERT, que numa fila com
     dois telemóveis a ler ao mesmo tempo deixava passar os dois. */
  if (chaveUso) {
    try {
      await env.DB.prepare(
        'INSERT INTO codigos_usados (chave, usado_em) VALUES (?, ?)'
      ).bind(chaveUso, agora()).run();
    } catch {
      throw new Falha('Este código já foi usado.', { estado: 409, codigo: 'repetido' });
    }
  }

  /* --- somar --- */
  const ganhos = [];
  let carimbos = cartao.carimbos;
  let pontos = cartao.pontos;
  let totalCarimbos = cartao.total_carimbos;
  let premiosGanhos = cartao.premios_ganhos;

  if (p.tipo === 'pontos') {
    const antes = pontos;
    pontos += quantidade;
    for (const m of (p.marcos || [])) {
      if (antes < m.pontos && pontos >= m.pontos) {
        ganhos.push({ id: id(), descricao: m.premio });
        premiosGanhos++;
      }
    }
  } else {
    carimbos += quantidade;
    totalCarimbos += quantidade;
    while (carimbos >= p.objetivo) {
      carimbos -= p.objetivo;
      ganhos.push({ id: id(), descricao: p.premio });
      premiosGanhos++;
    }
  }

  const quando = agora();
  const movimentoId = id();

  /* O UPDATE traz a condição de que `ultimo_em` não mudou entretanto. Se dois
     telemóveis lerem códigos diferentes do mesmo cliente no mesmo instante,
     ambos passam pela verificação do arrefecimento — mas só um consegue
     escrever, e o outro fica a saber que chegou tarde. Sem isto era possível
     carimbar duas vezes com dois telemóveis ao balcão. */
  const escrita = await env.DB.prepare(
    `UPDATE cartoes SET carimbos = ?, pontos = ?, total_carimbos = ?,
            premios_ganhos = ?, ultimo_em = ?
      WHERE id = ? AND (ultimo_em IS ? OR ultimo_em = ?)`
  ).bind(carimbos, pontos, totalCarimbos, premiosGanhos, quando,
         cartao.id, cartao.ultimo_em, cartao.ultimo_em).run();
  if (escrita.meta && escrita.meta.changes === 0) {
    throw new Falha('Este cartão acabou de ser carimbado noutro aparelho.',
      { estado: 409, codigo: 'concorrencia' });
  }

  instrucoes.push(
    env.DB.prepare(
      `INSERT INTO movimentos (id, cartao_id, tipo, quantidade, operador, manual, em)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(movimentoId, cartao.id, p.tipo === 'pontos' ? 'pontos' : 'carimbo',
           quantidade, operador.nome, manual ? 1 : 0, quando),
  );
  for (const g of ganhos) {
    instrucoes.push(
      env.DB.prepare(
        'INSERT INTO premios (id, cartao_id, descricao, ganho_em) VALUES (?, ?, ?, ?)'
      ).bind(g.id, cartao.id, g.descricao, quando),
      env.DB.prepare(
        'INSERT INTO movimentos (id, cartao_id, tipo, nota, em) VALUES (?, ?, ?, ?, ?)'
      ).bind(id(), cartao.id, 'premio', g.descricao, quando),
    );
  }
  await env.DB.batch(instrucoes);

  const atualizado = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartao.id).first();
  return {
    cartao: await moldarCartao(env, atualizado),
    cliente: { publico: cliente.publico },
    ganhos: ganhos.map((g) => ({ id: g.id, descricao: g.descricao })),
    novo, quantidade, manual, movimentoId,
  };
}

/* =========================================================================
   Email (opcional)
   ========================================================================= */

/**
 * Manda o email pela API de correio da Hostinger.
 *
 * Era a Resend. Trocou-se por três razões, e a primeira é a que pesa:
 *
 * · NÃO SAI DA UNIÃO EUROPEIA. A caixa está na Hostinger, em servidores
 *   europeus, e o correio é enviado de lá. Com a Resend a morada, a data e o
 *   estado de entrega ficavam guardados nos Estados Unidos — uma
 *   transferência que a política de privacidade tinha de declarar, e um
 *   subcontratante a mais para um serviço que manda seis algarismos.
 * · JÁ ESTÁ PAGO, e a API vem incluída em todos os planos de email.
 * · O TECTO É OUTRO: mil a três mil por dia contra três mil por MÊS.
 *
 * O que se perdeu, e convém saber: a Resend tinha chave de idempotência —
 * um pedido repetido não mandava um segundo email. Aqui não há. Quem segura
 * isso agora é o `podeEnviar()`, que recusa dois pedidos para a mesma morada
 * a menos de 45 segundos um do outro.
 *
 * E uma nota de segurança que não se deve esquecer: este token abre a caixa
 * toda — lê, procura, apaga. Não há âmbito só-de-envio nesta API. É por isso
 * que ele vive num segredo do Worker e nunca no repositório.
 */
async function enviarEmail(env, { para, assunto, texto, html }) {
  if (!env.MAIL_TOKEN || !env.MAIL_CAIXA) return { enviado: false, motivo: 'sem-chave' };
  try {
    const r = await fetch(
      `https://api.mail.hostinger.com/api/v1/mailboxes/${env.MAIL_CAIXA}/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.MAIL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [para],
          /* Não há campo `from`: quem envia é a própria caixa. O que se
             escolhe é o nome que aparece ao lado da morada. */
          displayName: env.EMAIL_NOME || 'Carimbo Digital',
          subject: assunto,
          /* As duas versões, sempre. A de texto não é um resto do passado: há
             clientes que só mostram texto, os leitores de ecrã dão-se melhor
             com ela, e um email só-HTML pontua pior nos filtros de spam. */
          text: texto,
          ...(html ? { html } : {}),
        }),
      });
    /* 204 e não 200: a API responde sem corpo nenhum quando o email sai. */
    if (r.status === 204 || r.ok) return { enviado: true };

    /* Um envio recusado tem quase sempre uma razão concreta. Registá-la é o
       que evita meia hora à procura: vê-se com `npx wrangler tail`. O motivo
       NÃO volta ao cliente: diria a um estranho como está montada a casa.

       Os três estados que esta API usa querem dizer coisas diferentes, e a
       diferença é a diferença entre ir ao sítio certo e andar às voltas:
       401 é a credencial (e o engano do costume é ter-se criado o token da
       API de alojamento em vez do de Agentic mail); 403 é um token bom para
       outra caixa; 422 é o corpo do pedido, ou seja, culpa nossa. */
    const porque = {
      401: 'credencial recusada — o MAIL_TOKEN é da API de correio '
         + '(hPanel › Emails › o domínio › Agentic mail › API) e não da de alojamento?',
      403: 'o token não manda nesta caixa — o MAIL_CAIXA é de outra, '
         + 'ou o token foi criado só para algumas',
      422: 'o pedido não passou na validação — isto é defeito nosso, não da conta',
      429: 'depressa de mais para o que a Hostinger aceita',
    }[r.status];
    const detalhe = await r.text().catch(() => '');
    console.error('Hostinger recusou', r.status, porque || '', detalhe.slice(0, 400));
    return { enviado: false, motivo: 'recusado', estado: r.status };
  } catch (e) {
    console.error('Correio inacessível:', e.message);
    return { enviado: false, motivo: 'rede' };
  }
}

/**
 * Valida um código de entrada e gasta-o.
 *
 * O código é curto de propósito — tem de ser escrito à mão — por isso a
 * segurança vem do prazo (15 min), do uso único e do contador de tentativas.
 * Cinco enganos e o código morre; sem isso, um milhão de hipóteses tentava-se
 * em minutos.
 */
/**
 * A forma canónica de uma morada de email.
 *
 * Isto é uma função e não um `.toLowerCase()` espalhado pelo código porque
 * já custou um defeito: a morada era guardada como a pessoa a escreveu e
 * procurada em minúsculas. Quem escrevesse `Renato@Exemplo.pt` recebia o
 * código e nunca conseguia entrar — o resumo nunca batia certo.
 */
/**
 * O corpo do pedido, em JSON, sem rebentar.
 *
 * `pedido.json()` atira quando o corpo está vazio ou não é JSON, e essa
 * excepção sai pelo apanhador geral como 500 «Erro interno» — o que diz a
 * quem chamou que o servidor se avariou, quando quem se enganou foi ele.
 * Um corpo em branco é um objecto vazio; um corpo estragado é um 400.
 */
/**
 * Um identificador que tem mesmo de vir no pedido.
 *
 * Sem isto, um campo em falta chegava ao `.bind(undefined)` do D1, que atira
 * — e a excepção saía pelo apanhador geral como 500 «Erro interno». Dizia a
 * quem chamou que o servidor se avariou quando quem se enganou foi ele, e
 * enchia os registos de erros que não eram erros nossos.
 */
function exigirTexto(valor, nome) {
  if (typeof valor !== 'string' || !valor.trim()) {
    throw new Falha(`Falta ${nome}.`, { estado: 400, codigo: 'em-falta' });
  }
  return valor;
}

/* Um corpo de pedido tinha tamanho livre. Trinta e dois kilobytes chegam e
   sobram para tudo o que estas rotas recebem — o maior é o formulário de
   fundar, com seis campos curtos. O logótipo, que é o único que precisa de
   mais, entra por rota própria e tem o tecto dele. */
const CORPO_MAX = 32 * 1024;
const LOGOTIPO_MAX = 256 * 1024;   // o PNG já reduzido no browser, em base64

async function corpoJSON(pedido, tecto = CORPO_MAX) {
  const texto = await pedido.text();
  if (texto.length > tecto) {
    throw new Falha('O pedido é demasiado grande.', { estado: 413, codigo: 'grande' });
  }
  if (!texto.trim()) return {};
  try {
    const d = JSON.parse(texto);
    return d && typeof d === 'object' ? d : {};
  } catch {
    throw new Falha('O corpo do pedido não é JSON válido.', { estado: 400, codigo: 'json' });
  }
}

function normalizarEmail(valor) {
  return String(valor || '').trim().toLowerCase();
}

const EMAIL_VALIDO = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i;

/**
 * Quantos códigos podem sair para a mesma morada.
 *
 * Devolve `null` se pode sair, ou uma mensagem se não pode. Duas travas: um
 * intervalo mínimo entre pedidos, para o dedo nervoso não gastar a quota, e
 * um tecto por hora, para ninguém usar isto como relé de email.
 */
async function podeEnviar(env, email) {
  const agoraMs = Date.now();
  const ultimo = await env.DB.prepare(
    'SELECT em FROM envios WHERE email = ? ORDER BY em DESC LIMIT 1'
  ).bind(email).first();
  if (ultimo && agoraMs - new Date(ultimo.em).getTime() < ENVIOS_INTERVALO * 1000) {
    return 'Já enviámos um código há pouco. Espera um minuto.';
  }
  const desde = new Date(agoraMs - 3600000).toISOString();
  const { n } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM envios WHERE email = ? AND em >= ?'
  ).bind(email, desde).first();
  if (n >= ENVIOS_HORA) {
    return 'Demasiados pedidos para esta morada. Tenta daqui a uma hora.';
  }
  return null;
}

/** Emite um código, guarda-o, e conta o envio para efeitos de tecto. */
async function emitirCodigo(env, { email, alvo }) {
  await env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(alvo).run();
  const codigo = codigoEntrada();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em) VALUES (?, ?, ?, ?, ?)'
    ).bind(await resumo(`${email}|${codigo}`), alvo, email, agora(),
           new Date(Date.now() + ENTRADA_MINUTOS * 60000).toISOString()),
    env.DB.prepare('INSERT INTO envios (id, email, em) VALUES (?, ?, ?)')
      .bind(id(), email, agora()),
  ]);
  return codigo;
}

async function consumirEntrada(env, email, codigo) {
  const limpo = String(codigo || '').replace(/\D/g, '');
  if (limpo.length !== 6) throw new Falha('O código tem seis algarismos.', { estado: 400 });
  const correio = normalizarEmail(email);

  const linha = await env.DB.prepare(
    'SELECT * FROM entradas WHERE resumo = ?'
  ).bind(await resumo(`${correio}|${limpo}`)).first();

  if (!linha || linha.usada_em || new Date(linha.expira_em) < new Date()) {
    /* Conta-se a tentativa falhada contra o código que existe para este
       email, não contra o resumo que falhou — senão bastava mudar o palpite
       para nunca gastar tentativas. */
    await env.DB.prepare(
      `UPDATE entradas SET tentativas = tentativas + 1
        WHERE email = ? AND usada_em IS NULL`
    ).bind(correio).run();
    await env.DB.prepare(
      'DELETE FROM entradas WHERE email = ? AND tentativas >= ?'
    ).bind(correio, ENTRADA_TENTATIVAS).run();
    throw new Falha('Código errado ou expirado.', { estado: 401, codigo: 'codigo-invalido' });
  }

  await env.DB.prepare('UPDATE entradas SET usada_em = ? WHERE resumo = ?')
    .bind(agora(), linha.resumo).run();
  return linha;
}

/* =========================================================================
   Rotas
   ========================================================================= */

const rotas = [];
const rota = (metodo, padrao, mao) => rotas.push({ metodo, padrao, mao });

/* --- cliente ------------------------------------------------------------ */

rota('POST', '/v1/cliente/registar', async (env, pedido) => {
  /* Sem nome, sem email, sem nada. A conta nasce anónima e só ganha um email
     se a pessoa quiser poder recuperá-la noutro telemóvel. */
  const clienteId = id();
  let publico, tentativas = 0;
  for (;;) {
    publico = publicoNovo();
    const existe = await env.DB.prepare('SELECT 1 FROM clientes WHERE publico = ?').bind(publico).first();
    if (!existe) break;
    if (++tentativas > 12) throw new Falha('Não foi possível criar o cartão', { estado: 503 });
  }
  await env.DB.prepare(
    'INSERT INTO clientes (id, publico, criado_em, visto_em) VALUES (?, ?, ?, ?)'
  ).bind(clienteId, publico, agora(), agora()).run();

  return {
    cliente: { id: clienteId, publico, criadoEm: agora(), email: null },
    segredo: await derivarSegredo(env, clienteId),
    sessao: await criarSessao(env, `cliente:${clienteId}`),
    horaDoServidor: agora(),
  };
});

rota('GET', '/v1/cliente/cartoes', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const linhas = (await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ?'
  ).bind(clienteId).all()).results;
  const cartoes = (await moldarCartoes(env, linhas)).filter(Boolean);
  cartoes.sort((a, b) => (b.porResgatar - a.porResgatar)
    || (new Date(b.ultimoEm || b.aderiuEm) - new Date(a.ultimoEm || a.aderiuEm)));
  return cartoes;
});

rota('GET', /^\/v1\/cliente\/cartoes\/([\w-]+)$/, async (env, pedido, [cartaoId]) => {
  const clienteId = await exigirCliente(env, pedido);
  const c = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!c) throw new Falha('Cartão não encontrado', { estado: 404 });
  const movimentos = (await env.DB.prepare(
    'SELECT id, tipo, quantidade, nota, em FROM movimentos WHERE cartao_id = ? ORDER BY em DESC LIMIT 60'
  ).bind(cartaoId).all()).results;
  return { ...(await moldarCartao(env, c)), movimentos };
});

rota('POST', '/v1/cliente/aderir', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { programaId } = await corpoJSON(pedido);
  exigirTexto(programaId, 'programaId');
  const p = await programaCompleto(env, programaId);
  if (!p || !p.ativo) throw new Falha('Programa não encontrado', { estado: 404 });

  const ja = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
  ).bind(clienteId, programaId).first();
  if (ja) return moldarCartao(env, ja);

  const cartaoId = id();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, aderiu_em) VALUES (?, ?, ?, ?, ?)'
    ).bind(cartaoId, clienteId, programaId, p.negocio_id, agora()),
    env.DB.prepare(
      'INSERT INTO movimentos (id, cartao_id, tipo, em) VALUES (?, ?, ?, ?)'
    ).bind(id(), cartaoId, 'adesao', agora()),
  ]);
  const c = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  return moldarCartao(env, c);
});

rota('GET', '/v1/descobrir', async (env) => {
  /* Com tecto. Isto é uma consulta por negócio e outra por programa, e corre a
     cada abertura da app — sem `LIMIT`, o custo da lista pública cresce com o
     que os negócios lá puserem, e as «linhas lidas» do D1 gratuito acabam aos
     cinco milhões por dia. Quando houver mais de duzentos negócios, isto passa
     a ser procura e mapa, não uma lista; o tecto é o aviso de que chegou essa
     hora. */
  /* Os de DEMONSTRAÇÃO ficam de fora. Existe um café em produção que não
     existe na rua — é o banco de provas, e provar um cartão de fidelidade a
     sério exige uma loja com clientes, carimbos e prémios. Só que ele estava
     aqui, ao lado de uma barbearia que existe, e alguém podia juntar o cartão
     de uma porta que não abre. O endereço próprio (`/v1/p/<slug>`) continua a
     responder: o que se tira é a publicidade a quem não foi convidado. */
  /* As colunas UMA A UMA, e não `SELECT *`. O `logotipo` é um PNG em base64 —
     dezenas de kilobytes por negócio — e esta consulta só precisa de saber se
     ele EXISTE. Com `*`, cada abertura da app puxava os logótipos todos da
     base para os deitar fora à linha seguinte. */
  const negocios = (await env.DB.prepare(
    `SELECT id, slug, nome, cor, categoria, localidade, morada, telefone,
            logotipo_em, (logotipo IS NOT NULL) AS tem_logotipo
       FROM negocios
      WHERE estado = 'ativo' AND demonstracao = 0
      ORDER BY nome LIMIT ?`
  ).bind(DESCOBRIR_MAX).all()).results;
  const saida = [];
  for (const n of negocios) {
    const programas = (await env.DB.prepare(
      'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
    ).bind(n.id).all()).results;
    if (!programas.length) continue;
    const comMarcos = [];
    for (const p of programas) {
      const marcos = p.tipo === 'pontos'
        ? (await env.DB.prepare(
            'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
          ).bind(p.id).all()).results
        : null;
      comMarcos.push(moldarPrograma({ ...p, marcos }));
    }
    saida.push({
      id: n.id, slug: n.slug, nome: n.nome, cor: n.cor, categoria: n.categoria,
      localidade: n.localidade, morada: n.morada, telefone: n.telefone,
      /* Só se HÁ, e a data — nunca a imagem. Esta lista é pedida a cada
         abertura da app por toda a gente, e mandar os logótipos todos lá
         dentro seria mandar megabytes para desenhar uns quadrados. */
      logotipo: Boolean(n.tem_logotipo), logotipoEm: n.logotipo_em || null,
      programas: comMarcos,
    });
  }
  return saida;
});

/**
 * Pedir um código por email.
 *
 * Faz duas coisas que parecem uma só, e é aqui que estava o defeito mais
 * caro do produto: guardar a conta e recuperá-la noutro telemóvel.
 *
 * Antes, o código era emitido sempre contra o cliente da sessão em curso.
 * Num telemóvel novo a app já tinha registado uma conta vazia, por isso o
 * código apontava para essa — e a pessoa confirmava, ouvia «os cartões já
 * não se perdem», e ficava com a carteira vazia. Estava prometido no ecrã
 * de boas-vindas, no perfil e no próprio email; não funcionava em lado
 * nenhum.
 *
 * Agora decide-se pelo que já existe: se a morada pertence a uma conta
 * confirmada que não é esta, o código aponta para ESSA. É uma recuperação.
 * Se não pertence a ninguém, aponta para a conta actual e é uma adesão.
 *
 * O email só passa a constar da conta depois de confirmado. Guardá-lo antes
 * punha na base de dados uma morada que ninguém provou ser sua — e a
 * exportação de dados chamava-lhe «o teu email».
 */
rota('POST', '/v1/cliente/email', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { email } = await corpoJSON(pedido);
  const correio = normalizarEmail(email);
  if (!EMAIL_VALIDO.test(correio)) throw new Falha('Email inválido');

  const trava = await podeEnviar(env, correio);
  if (trava) throw new Falha(trava, { estado: 429, codigo: 'demasiados' });

  const dono = await env.DB.prepare(
    'SELECT id FROM clientes WHERE email = ? AND email_verificado = 1 LIMIT 1'
  ).bind(correio).first();
  const recuperar = Boolean(dono) && dono.id !== clienteId;
  const alvo = `cliente:${recuperar ? dono.id : clienteId}`;

  const codigo = await emitirCodigo(env, { email: correio, alvo });
  const r = await enviarEmail(env, {
    para: correio,
    ...emailCodigoCliente({ codigo, minutos: ENTRADA_MINUTOS }),
  });
  /* Devolve-se a verdade: é o email do próprio, e mandá-lo esperar por um
     código que nunca vai chegar é a pior coisa que se lhe pode fazer.
     `recuperar` deixa a app avisar que os cartões vêm de outro aparelho. */
  return { enviado: r.enviado, motivo: r.enviado ? null : r.motivo, recuperar };
});

rota('POST', '/v1/cliente/entrar', async (env, pedido) => {
  const { email, codigo } = await corpoJSON(pedido);
  const linha = await consumirEntrada(env, email, codigo);
  const [tipo, valor] = linha.alvo.split(':');
  if (tipo !== 'cliente') throw new Falha('Código inválido', { estado: 400 });
  /* QUEM É O DONO DESTA MORADA, AGORA — e não quando o código foi pedido.
     Entre pedir e escrever passam até quinze minutos, e nesses minutos a
     morada pode ter ganho dono noutro aparelho. Resolver isto só à emissão
     deixava ficar DUAS contas com a mesma morada verificada, e a recuperação
     faz `LIMIT 1`: escolhia uma ao calhas e os cartões da outra deixavam de
     ter por onde ser alcançados. Não é roubo — as duas pessoas provaram a
     mesma caixa — é perda de dados em silêncio.

     O caminho real: pôr o email no telemóvel e não escrever o código; pôr o
     mesmo noutro aparelho e concluir; voltar ao primeiro e usar o código
     antigo, que ainda vale. Está provado na bateria.

     A regra passa a ser uma só, e vale para os dois casos: quem prova a caixa
     de correio entra na conta que já é dela; se não houver nenhuma, a conta
     que pediu fica com ela. */
  const dono = await env.DB.prepare(
    'SELECT id FROM clientes WHERE email = ? AND email_verificado = 1 LIMIT 1'
  ).bind(linha.email).first();
  const alvoFinal = dono ? dono.id : valor;

  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(alvoFinal).first();
  if (!cliente) throw new Falha('Conta não encontrada', { estado: 404 });

  /* É aqui que a morada passa a ser da conta, e não no pedido do código:
     agora está provado que quem a escreveu a lê. O índice único parcial
     (`migracoes/003`) é a rede por baixo disto — se duas verificações se
     cruzarem no mesmo instante, a segunda falha em vez de duplicar. */
  if (!dono) {
    await env.DB.prepare('UPDATE clientes SET email = ?, email_verificado = 1 WHERE id = ?')
      .bind(linha.email, alvoFinal).run();
  }

  return {
    cliente: { id: cliente.id, publico: cliente.publico, email: linha.email, criadoEm: cliente.criado_em },
    segredo: await derivarSegredo(env, cliente.id),
    sessao: await criarSessao(env, `cliente:${cliente.id}`),
    horaDoServidor: agora(),
    /* Diz-se a verdade: os cartões que vai ver podem não ser os que tinha
       neste aparelho. A app já sabe avisar. */
    recuperada: Boolean(dono) && dono.id !== valor,
  };
});

rota('GET', '/v1/cliente/dados', async (env, pedido) => {
  /* CINCO CONSULTAS, e não cinco POR CARTÃO.

     Isto fazia um `moldarCartao` (duas a três consultas), um SELECT de
     movimentos e um de prémios por cada cartão. Uma invocação de Worker tem
     tecto de CINQUENTA subpedidos: a partir de uns dez cartões, o «Descarregar
     os meus dados» — que é o direito de portabilidade do artigo 20.º do RGPD —
     rebentava com «Too many subrequests» e a pessoa via «Erro interno». O
     direito de levar os dados consigo não pode depender de se ter poucos
     cartões. */
  const clienteId = await exigirCliente(env, pedido);
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(clienteId).first();
  const cartoes = (await env.DB.prepare('SELECT * FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;

  const movimentos = cartoes.length ? (await env.DB.prepare(
    `SELECT m.* FROM movimentos m
       JOIN cartoes c ON c.id = m.cartao_id
      WHERE c.cliente_id = ? ORDER BY m.em DESC`
  ).bind(clienteId).all()).results : [];
  const premios = cartoes.length ? (await env.DB.prepare(
    `SELECT pr.* FROM premios pr
       JOIN cartoes c ON c.id = pr.cartao_id
      WHERE c.cliente_id = ? ORDER BY pr.ganho_em`
  ).bind(clienteId).all()).results : [];

  const detalhados = await moldarCartoes(env, cartoes);
  return { geradoEm: agora(), cliente, cartoes: detalhados, movimentos, premios };
});

/**
 * Apaga uma conta e tudo o que pende dela.
 *
 * Tem dois chamadores — o botão «Apagar a conta» no perfil e a limpeza das
 * contas paradas — e é de propósito que é um só sítio: duas listas de tabelas
 * escritas à mão divergem à primeira tabela nova, e o que fica para trás numa
 * delas são dados pessoais de alguém que pediu para desaparecer.
 *
 * As chaves estrangeiras estão em CASCADE, mas o D1 só as aplica com
 * PRAGMA foreign_keys ligado — que nem sempre está. Apaga-se à mão, pela
 * ordem certa, para não ficarem órfãos na base de dados.
 */
async function apagarCliente(env, clienteId) {
  const cartoes = (await env.DB.prepare('SELECT id FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;

  /* OS PASSES MORREM ANTES DOS CARTÕES, e a ordem não é indiferente: depois de
     a linha desaparecer já não há por onde saber que o passe existia, e ele
     ficava na carteira da pessoa para sempre, com um saldo velho, sem nada
     que o tirasse de lá. Isso não é um pormenor — é o direito ao apagamento.

     Falhar aqui não impede o apagamento. Entre deixar um cartão na base de
     dados de quem pediu para desaparecer e deixar um rectângulo morto numa
     carteira, a escolha é fácil. */
  if (walletLigada(env)) {
    /* Só os que TÊM passe. A primeira versão percorria todos os cartões e
       chamava a Google para cada um — incluindo os de quem nunca tocou na
       Wallet. Gastava subpedidos e um testemunho de acesso por cada conta
       apagada, para não fazer nada. */
    const comPasse = (await env.DB.prepare(
      'SELECT id FROM cartoes WHERE cliente_id = ? AND wallet_em IS NOT NULL'
    ).bind(clienteId).all()).results;
    for (const c of comPasse) {
      try {
        await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${c.id}`, {
          metodo: 'PATCH', corpo: { state: 'EXPIRED' },
        });
      } catch (erro) {
        console.error('wallet: não deu para expirar o passe', c.id, String(erro));
      }
    }
  }
  const instrucoes = [];
  for (const c of cartoes) {
    instrucoes.push(env.DB.prepare('DELETE FROM movimentos WHERE cartao_id = ?').bind(c.id));
    instrucoes.push(env.DB.prepare('DELETE FROM premios WHERE cartao_id = ?').bind(c.id));
  }
  instrucoes.push(
    env.DB.prepare('DELETE FROM cartoes WHERE cliente_id = ?').bind(clienteId),
    env.DB.prepare('DELETE FROM sessoes WHERE sujeito = ?').bind(`cliente:${clienteId}`),
    env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`cliente:${clienteId}`),
    env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(clienteId),
  );
  await env.DB.batch(instrucoes);
}

rota('DELETE', '/v1/cliente', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  await apagarCliente(env, clienteId);
  return { apagado: true };
});

/* --- balcão ------------------------------------------------------------- */

/**
 * Fundar um negócio com um código de convite.
 *
 * O problema do primeiro operador: para entrar no balcão é preciso uma
 * sessão, para ter sessão é preciso um código por email, e para receber o
 * código é preciso já existir um operador. Alguém tem de criar o primeiro.
 *
 * Quem o cria é este endereço, aberto por um convite — uma linha da tabela
 * `convites`, com usos, validade e revogação próprios. Era um segredo do
 * Worker igual para toda a gente, com usos infinitos e sem forma de anular um
 * sem partir os outros; e que nem o dono do produto conseguia ler de volta,
 * porque o Cloudflare não devolve segredos.
 *
 * Os convites geram-se com `node scripts/convite.mjs criar --para "..."`.
 * Quando a inscrição passar a ser livre, troca-se o convite por uma
 * confirmação de email e o resto fica igual.
 */
/**
 * Normaliza um código de convite escrito por uma pessoa.
 *
 * Ele lê-o de um papel ou ouve-o em voz alta e escreve-o como lhe sai:
 * minúsculas, com ou sem o hífen, às vezes com um espaço no meio. Nada disso
 * pode ser motivo para recusar — o que conta são os caracteres do alfabeto.
 */
const normalizarConvite = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Reivindica um convite, ou explica porque não deu.
 *
 * O gesto todo é UM `UPDATE` condicional, e isso não é preciosismo: ler o
 * convite, decidir em JavaScript e escrever a seguir deixa cinquenta pedidos
 * em paralelo passarem todos pela mesma porta antes de qualquer um deles a
 * fechar. O `meta.changes` diz quantas linhas mudaram de facto — uma, ou
 * nenhuma. É a base de dados a arbitrar, e não nós.
 *
 * O `SELECT` só corre DEPOIS, e só quando já se sabe que falhou: serve para
 * dizer à pessoa se o código não existe, se caducou, se já foi gasto ou se foi
 * revogado — quatro paredes diferentes, e mandá-la embora com «convite
 * inválido» nas quatro é fazê-la tentar outra vez o que nunca vai funcionar.
 */
async function reivindicarConvite(env, codigo, email) {
  const limpo = normalizarConvite(codigo);
  if (limpo.length < 4) throw new Falha('Falta o código do convite.', { codigo: 'convite' });
  const r = await resumo(limpo);
  const agoraISO = agora();

  const feito = await env.DB.prepare(
    `UPDATE convites SET usos = usos + 1, usado_em = ?1
      WHERE resumo = ?2
        AND revogado_em IS NULL
        AND (expira_em IS NULL OR expira_em > ?1)
        AND usos < usos_max
        AND (email IS NULL OR email = ?3)`
  ).bind(agoraISO, r, email).run();

  if (feito.meta && feito.meta.changes === 1) return r;

  const c = await env.DB.prepare('SELECT * FROM convites WHERE resumo = ?').bind(r).first();
  if (!c) throw new Falha('Esse código não existe. Confere as letras.', { estado: 403, codigo: 'convite' });
  if (c.revogado_em) throw new Falha('Esse código foi anulado. Pede outro.', { estado: 403, codigo: 'convite-revogado' });
  if (c.expira_em && c.expira_em <= agoraISO) throw new Falha('Esse código caducou. Pede outro.', { estado: 403, codigo: 'convite-expirado' });
  if (c.usos >= c.usos_max) throw new Falha('Esse código já foi usado.', { estado: 403, codigo: 'convite-gasto' });
  if (c.email && c.email !== email) {
    throw new Falha('Esse código está reservado a outra morada de email.', { estado: 403, codigo: 'convite-email' });
  }
  throw new Falha('Esse código não serve.', { estado: 403, codigo: 'convite' });
}

/** Devolve um uso ao convite, quando a fundação falha depois de reivindicado. */
async function devolverConvite(env, r) {
  await env.DB.prepare(
    'UPDATE convites SET usos = MAX(0, usos - 1) WHERE resumo = ?'
  ).bind(r).run();
}

rota('POST', '/v1/balcao/fundar', async (env, pedido) => {
  const d = await corpoJSON(pedido);

  const nome = String(d.nome || '').trim().slice(0, 60);
  const email = normalizarEmail(d.email);
  if (nome.length < 2) throw new Falha('Falta o nome do negócio.');
  if (!EMAIL_VALIDO.test(email)) throw new Falha('Email inválido.');

  /* Entrar no balcão faz-se pelo email, e a procura devolve o primeiro
     operador que casar. Fundar um segundo negócio com o mesmo email criava
     uma conta em que nunca mais se conseguia entrar — o código chegava
     sempre ao primeiro. Vale mais recusar aqui do que deixar um negócio
     órfão na base de dados. */
  const jaHa = await env.DB.prepare(
    'SELECT 1 FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(email).first();
  if (jaHa) {
    throw new Falha('Já há um balcão com este email. Entra por «Entrar com o email».',
      { estado: 409, codigo: 'email-usado' });
  }

  /* O convite gasta-se aqui, depois de tudo o que se pode recusar sem lhe
     tocar. Recusar o nome ou o email DEPOIS de o gastar queimava um convite
     por causa de um engano de escrita. */
  const convite = await reivindicarConvite(env, d.codigo, email);

  /* O slug sai do nome: sem acentos, sem pontuação, sem espaços. Se já
     existir, junta-se um sufixo curto em vez de recusar. */
  let slug = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'negocio';
  for (let i = 0; i < 12; i++) {
    const existe = await env.DB.prepare('SELECT 1 FROM negocios WHERE slug = ?').bind(slug).first();
    if (!existe) break;
    slug = `${slug.replace(/-[a-z0-9]{4}$/, '')}-${publicoNovo(4).toLowerCase()}`;
  }

  const negocioId = id();
  const programaId = id();
  const operadorId = id();
  /* A cor vai para um atributo de estilo no cartão de toda a gente, e aqui
     entrava como viesse — o `PUT /v1/balcao/negocio` já a testava, esta porta
     não. A categoria e a localidade também são pintadas na lista pública. */
  const cor = /^#[0-9a-fA-F]{6}$/.test(String(d.cor || '')) ? d.cor : '#17161C';
  const corte = (v, n) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null; };
  try {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO negocios (id, slug, nome, categoria, cor, localidade, criado_em, convite)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(negocioId, slug, nome, corte(d.categoria, 40), cor,
           corte(d.localidade, 60), agora(), convite),
    env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras,
                              arrefecimento, criado_em)
       VALUES (?, ?, ?, 'carimbos', ?, ?, ?, ?, ?, ?)`
    /* Pela MESMA limpeza da outra porta. Este ramo escrevia
       `d.programa || 'Cartão de cliente'` em cru — os tectos que a rota dos
       programas passou a ter não valiam nada se se pudesse entrar por aqui.
       O nome do campo é `programa` e não `nome`, que já é o do negócio. */
    ).bind(programaId, negocioId,
           ...(() => {
             const c = camposDoPrograma({
               nome: d.programa || 'Cartão de cliente', selo: d.selo,
               objetivo: d.objetivo, premio: d.premio || 'Um brinde por conta da casa',
               regras: d.regras || 'Um carimbo por visita.',
             });
             return [c.nome, c.selo, c.objetivo, c.premio, c.regras];
           })(), 3600, agora()),
    env.DB.prepare(
      `INSERT INTO operadores (id, negocio_id, nome, email, papel, criado_em)
       VALUES (?, ?, ?, ?, 'dono', ?)`
    ).bind(operadorId, negocioId, corte(d.operador, 40) || 'Balcão', email, agora()),
  ]);
  } catch (erro) {
    /* A fundação falhou depois de o convite estar gasto. Devolve-se o uso: um
       convite queimado por um erro da base obrigava a gerar outro, e quem
       está à espera é o dono do café com o telemóvel na mão. */
    await devolverConvite(env, convite);
    throw erro;
  }

  return {
    negocio: { id: negocioId, slug, nome },
    sessao: await criarSessao(env, `operador:${operadorId}`),
  };
});

rota('POST', '/v1/balcao/entrar', async (env, pedido) => {
  const { email } = await corpoJSON(pedido);
  const correio = normalizarEmail(email);
  if (!EMAIL_VALIDO.test(correio)) throw new Falha('Email inválido');

  const trava = await podeEnviar(env, correio);
  if (trava) throw new Falha(trava, { estado: 429, codigo: 'demasiados' });

  const op = await env.DB.prepare(
    'SELECT id, negocio_id FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(correio).first();

  /* Responde-se sempre o mesmo, exista ou não a conta: senão este endereço
     torna-se uma forma de descobrir que emails estão registados.

     O que mudou: antes respondia-se `enviado: true` mesmo quando nenhum
     email tinha saído — incluindo quando o envio falhava a sério. Quem
     ficasse à espera não tinha como saber que não vinha nada. Agora o
     campo diz a verdade do envio; o que continua a não distinguir é a
     existência da conta, que é o que se quer esconder. */
  let saiu = true;
  if (op) {
    const codigo = await emitirCodigo(env, { email: correio, alvo: `operador:${op.id}` });
    const negocio = await env.DB.prepare(
      'SELECT nome FROM negocios WHERE id = ?'
    ).bind(op.negocio_id).first();
    const r = await enviarEmail(env, {
      para: correio,
      ...emailCodigoBalcao({
        codigo, minutos: ENTRADA_MINUTOS, negocio: negocio && negocio.nome,
      }),
    });
    saiu = r.enviado;
  }
  return { enviado: saiu };
});

rota('POST', '/v1/balcao/sessao', async (env, pedido) => {
  const { email, codigo } = await corpoJSON(pedido);
  const linha = await consumirEntrada(env, email, codigo);
  const [tipo, valor] = linha.alvo.split(':');
  if (tipo !== 'operador') throw new Falha('Código inválido', { estado: 400 });
  return { sessao: await criarSessao(env, `operador:${valor}`) };
});

rota('GET', '/v1/balcao/negocio', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(op.negocio_id).first();
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(op.negocio_id).all()).results;
  const comMarcos = [];
  for (const p of programas) {
    const marcos = p.tipo === 'pontos'
      ? (await env.DB.prepare('SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos').bind(p.id).all()).results
      : null;
    comMarcos.push(moldarPrograma({ ...p, marcos }));
  }
  /* O `logotipo` NÃO vai aqui dentro. É um PNG em base64 — umas dezenas de
     kilobytes — e esta rota é chamada a cada abertura do balcão e a seguir a
     cada gravação. Quem precisa da imagem pede-a ao endereço próprio, que tem
     cache de um ano; aqui vai só a resposta a «há logótipo?» e a data, que é
     o que serve para não mostrar a imagem velha depois de uma troca. */
  const { logotipo, ...semImagem } = negocio;
  return {
    operador: { id: op.id, nome: op.nome, papel: op.papel },
    /* O `demonstracao` vai a booleano para o balcão poder dizer ao dono porque
       é que ele não aparece na lista pública. Um negócio fora da lista sem
       explicação nenhuma é um bilhete de suporte à espera de acontecer. */
    negocio: {
      ...semImagem, logotipo: Boolean(logotipo),
      demonstracao: Boolean(negocio.demonstracao), programas: comMarcos,
    },
  };
});

rota('PUT', '/v1/balcao/negocio', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido);

  /* `fundar` corta o nome aos 60 e valida o email; isto não validava nada.
     Um nome de cinco mil caracteres entrava tal e qual e ia parar ao cartão
     de todos os clientes do negócio. E a cor, que é escrita directamente
     numa custom property do CSS, aceitava qualquer texto. */
  const corta = (v, n) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
  const cor = d.cor === undefined || d.cor === null ? null : String(d.cor).trim();
  if (cor !== null && !/^#[0-9a-fA-F]{6}$/.test(cor)) {
    throw new Falha('A cor tem de ser um hexadecimal de seis dígitos, como #5A31E8.',
      { estado: 400, codigo: 'cor' });
  }
  const nome = corta(d.nome, 60);
  if (d.nome !== undefined && d.nome !== null && (!nome || nome.length < 2)) {
    throw new Falha('O nome do negócio tem de ter pelo menos dois caracteres.');
  }

  await env.DB.prepare(
    `UPDATE negocios SET nome = COALESCE(?, nome), cor = COALESCE(?, cor),
            morada = COALESCE(?, morada), localidade = COALESCE(?, localidade),
            telefone = COALESCE(?, telefone) WHERE id = ?`
  ).bind(nome, cor, corta(d.morada, 120), corta(d.localidade, 60),
         corta(d.telefone, 30), op.negocio_id).run();
  /* O nome e a cor vivem também na classe da Wallet. Sem isto, quem já tem o
     passe guardado fica a ver o nome antigo para sempre — e não volta a abrir
     a app para descobrir que mudou. */
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  return env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(op.negocio_id).first();
});

/** Segundos entre dois carimbos no mesmo cartão. Zero é válido: quer dizer
    «sem arrefecimento». Lixo não é, e o tecto é um dia. */
function arrefecimentoValido(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return 3600;
  return Math.min(86400, Math.round(n));
}

/**
 * Os campos de um programa, limpos.
 *
 * Existe porque os dois ramos da rota — criar e actualizar — tinham cada um a
 * sua versão disto, e afastaram-se: o de actualização cortava o nome a 60 e o
 * prémio a 120, e o de criação escrevia `d.nome || 'Cartão'` em cru. As regras
 * não eram cortadas em nenhum dos dois. Duas cópias da mesma limpeza divergem
 * sempre; a defesa é não haver duas.
 *
 * O `tipo` é o que mais importa validar, e não é óbvio porquê: é ele que
 * decide, lá no carimbar, se a quantidade é forçada a 1. Um valor que não seja
 * «carimbos» nem «pontos» deixava a porta aberta a carimbos de quantidade
 * arbitrária.
 */
function camposDoPrograma(d, antigo = null) {
  const texto = (v, cai, max) => {
    const t = String(v ?? '').trim();
    return (t || String(cai ?? '')).slice(0, max);
  };
  const tipo = TIPOS.includes(d.tipo) ? d.tipo : (antigo ? antigo.tipo : 'carimbos');
  /* O selo é o nome de um ícone. Um nome que a app não conheça desenha nada —
     o que é feio mas inofensivo; o que não pode é ser um texto qualquer a
     caminho do HTML, nem ter tamanho livre. */
  const selo = /^[a-z][a-z0-9-]{0,19}$/.test(String(d.selo || ''))
    ? d.selo : (antigo ? antigo.selo : 'carimbo');
  return {
    nome: texto(d.nome, antigo ? antigo.nome : 'Cartão', 60),
    premio: texto(d.premio, antigo ? antigo.premio : 'Prémio', 120),
    /* As regras podem ficar vazias de propósito — mas não podem ser um
       romance: também vão para o cartão de toda a gente. */
    regras: (() => {
      const t = String(d.regras ?? (antigo ? antigo.regras : '') ?? '').trim();
      return t ? t.slice(0, 240) : null;
    })(),
    tipo,
    selo,
    objetivo: Math.max(2, Math.min(30, Math.round(Number(d.objetivo)) || (antigo ? antigo.objetivo : 10))),
    arrefecimento: arrefecimentoValido(d.arrefecimento ?? (antigo ? antigo.arrefecimento : null)),
  };
}

/* =========================================================================
   A Wallet do telemóvel

   Aqui vive o que FALA com a Google. O que constrói e assina vive em
   `wallet.js`, que não conhece rede nenhuma — é essa separação que deixa a
   parte difícil ser provada sem conta, sem chave e sem Internet.

   A REGRA QUE MANDA EM TUDO ISTO: a Google é um ESPELHO, nunca a fonte da
   verdade. O carimbo grava-se no D1 aconteça o que acontecer; o passe é
   actualizado a seguir, fora do caminho da resposta, e se falhar fica para o
   reconciliador da madrugada. Um balcão com uma fila à frente não pode ficar
   à espera de um servidor em Mountain View, e um cliente não pode deixar de
   levar o carimbo porque a Google teve um mau dia.

   TUDO ISTO DORME ENQUANTO NÃO HOUVER CHAVES. Sem `GOOGLE_EMISSOR` e
   `GOOGLE_CHAVE`, as rotas respondem 404 e o botão não aparece na app. É o
   que permite ter isto publicado e em CI verde antes de existir uma conta.
   ========================================================================= */

const walletLigada = (env) => Boolean(env.GOOGLE_EMISSOR && env.GOOGLE_CHAVE && env.GOOGLE_EMAIL);

/* O endereço da API. Uma variável e não uma constante para os testes poderem
   apontá-lo a um servidor de mentira — é o que torna todo este caminho
   provável sem tocar na Google a sério. */
const googleBase = (env) => env.GOOGLE_API_BASE || 'https://walletobjects.googleapis.com';
const googleOAuth = (env) => env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';

/**
 * O testemunho de acesso, em cache.
 *
 * Não é optimização: o plano gratuito dá 50 SUBPEDIDOS por invocação, e sem
 * cache cada carimbo gastava dois — um para ir buscar o testemunho e outro
 * para o trabalho. Guarda-se em variável de módulo com a hora a que morre, e
 * reutiliza-se enquanto faltarem mais de cinco minutos.
 */
let tokenEmCache = null;

async function tokenGoogle(env) {
  const agoraS = Math.floor(Date.now() / 1000);
  if (tokenEmCache && tokenEmCache.expira - 300 > agoraS) return tokenEmCache.token;

  const jwt = await assinarRS256(env.GOOGLE_CHAVE, {
    iss: env.GOOGLE_EMAIL,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: `${googleOAuth(env)}/token`,
    iat: agoraS,
    exp: agoraS + 3600,
  });
  const r = await fetch(`${googleOAuth(env)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!r.ok) throw new Error(`a Google recusou a chave (${r.status})`);
  const d = await r.json();
  tokenEmCache = { token: d.access_token, expira: agoraS + (Number(d.expires_in) || 3600) };
  return tokenEmCache.token;
}

async function googlePedir(env, caminho, { metodo = 'GET', corpo } = {}) {
  const token = await tokenGoogle(env);
  const r = await fetch(`${googleBase(env)}/walletobjects/v1${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${token}`,
      ...(corpo ? { 'content-type': 'application/json' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  /* 409 é «já existe», e para uma classe isso é sucesso e não erro: duas
     pessoas a pedir o passe do mesmo café ao mesmo tempo criam-na as duas. */
  if (r.status === 409) return { jaExistia: true };
  if (!r.ok) {
    const texto = await r.text();
    throw new Error(`Google ${metodo} ${caminho}: ${r.status} ${texto.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * SÃO DOIS DOMÍNIOS, e confundi-los custou um 400 da Google.
 *
 * O `DOMINIO` é onde vive o SITE — `carimbodigital.pt`, servido pelo GitHub
 * Pages. É esse que vai no `origins` do endereço de gravação, porque é de lá
 * que a pessoa carrega no botão.
 *
 * Mas o logótipo é servido pelo WORKER, que atende noutro endereço. Pôr o
 * domínio do site no `programLogo` dava «Image cannot be loaded. Invalid
 * image URL» — a Google ia buscar a imagem ao GitHub Pages, que não tem
 * rota `/v1/` nenhuma.
 *
 * Tira-se do próprio pedido em vez de se pôr numa variável: assim está sempre
 * certo, atenda o Worker onde atender, e não há um segundo sítio para
 * desactualizar no dia em que a API mudar de casa.
 */
const origemDaAPI = (pedido) => new URL(pedido.url).origin;

/**
 * O endereço do logótipo, com a versão colada.
 *
 * O `?v=` não é enfeite: é o que faz a Google ver uma imagem nova. Ela guarda
 * o `programLogo` numa cache própria, à chave do ENDEREÇO — e este endereço
 * responde `immutable` por um ano, que é literalmente dizer-lhe «não voltes a
 * perguntar». Trocar o logótipo no D1 e recriar a classe não mexia nisso: a
 * Google continuava a servir os bytes do primeiro dia, e o cartão ficava com
 * o logótipo antigo para sempre, sem erro nenhum a dizer porquê.
 *
 * Medido: o logótipo do Titi mudou para branco-sobre-laranja no D1, a classe
 * foi recriada, e a cópia em `lh3.googleusercontent.com` continuava
 * transparente. Só um endereço diferente a obriga a ir buscar outra vez.
 *
 * A versão vem do `logotipo_em`, que já existia para isto e muda a cada
 * gravação. Os traços e os dois-pontos saem porque não acrescentam nada.
 */
function enderecoDoLogotipo(negocio, origemAPI) {
  if (!negocio || !negocio.logotipo) return null;
  const base = `${origemAPI}/v1/negocio/${negocio.slug}/logotipo`;
  const versao = String(negocio.logotipo_em || '').replace(/\D/g, '');
  return versao ? `${base}?v=${versao}` : base;
}

/** Garante que a classe do programa existe lá fora. Uma vez por programa. */
async function garantirClasse(env, programa, negocio, origemAPI) {
  if (programa.wallet_classe) return;
  const logotipo = enderecoDoLogotipo(negocio, origemAPI);
  const classe = classeDePrograma(programa, negocio, {
    emissor: env.GOOGLE_EMISSOR, logotipo,
  });
  const r = await googlePedir(env, '/loyaltyClass', { metodo: 'POST', corpo: classe });
  /* Se já existia lá fora, actualiza-se em vez de se dar por feito. O 409
     acontece de duas maneiras: duas pessoas a pedir o passe do mesmo café ao
     mesmo tempo, e — a que interessa — uma classe criada numa vida anterior,
     com dados que entretanto mudaram. Tratar o 409 como sucesso deixava a
     classe congelada no que tinha no dia em que nasceu, e sem forma de a
     corrigir a não ser à mão. */
  if (r && r.jaExistia) {
    /* O PATCH é o melhor esforço, e não uma condição. A classe EXISTE — é isso
       que o 409 diz — e é isso que faz falta para haver passe. Se a
       actualização falhar (a Google a não conseguir ir buscar o logótipo, um
       503 do lado dela), deixar a excepção subir cancelava o passe da pessoa
       que está a tocar no botão E impedia o `wallet_classe` de ser gravado —
       o que punha a tentativa seguinte a repetir tudo, para sempre. O que
       ficar por actualizar é apanhado pelo `espelharClasse`, que corre a cada
       mudança de nome, de cor ou de logótipo. */
    try {
      await googlePedir(env, `/loyaltyClass/${env.GOOGLE_EMISSOR}.${programa.id}`, {
        metodo: 'PATCH', corpo: actualizacaoDeClasse(programa, negocio, { logotipo }),
      });
    } catch (erro) {
      console.error('wallet: a classe existe mas não deu para actualizar',
        programa.id, String(erro));
    }
  }
  await env.DB.prepare('UPDATE programas SET wallet_classe = ? WHERE id = ?')
    .bind(agora(), programa.id).run();
}

/**
 * O passe de um cartão: cria-o lá fora e devolve o endereço que o guarda.
 *
 * O objecto é criado por REST ANTES de se assinar o endereço, e não vai dentro
 * dele. É isso que mantém o endereço nos setecentos caracteres em vez de
 * passar do tecto dos mil e oitocentos — e acima desse tecto o browser
 * corta-o, e a gravação não acontece sem dar erro nenhum.
 */
rota('POST', /^\/v1\/cliente\/cartoes\/([\w-]+)\/wallet$/, async (env, pedido, [cartaoId]) => {
  if (!walletLigada(env)) throw new Falha('Não existe', { estado: 404 });
  const clienteId = await exigirCliente(env, pedido);

  const cartao = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });

  const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
    .bind(cartao.programa_id).first();
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?')
    .bind(cartao.negocio_id).first();
  if (!negocio || !negocio.logotipo) {
    throw new Falha('Este negócio ainda não tem logótipo, e a Wallet exige um.',
      { estado: 409, codigo: 'sem-logotipo' });
  }

  await garantirClasse(env, programa, negocio, origemDaAPI(pedido));

  /* O código do passe nasce uma vez e fica. É ele que vai no código de barras
     e é por ele que o balcão reconhece o passe — se mudasse, os passes já
     guardados deixavam de servir. */
  const codigo = cartao.wallet_codigo || publicoNovo(16);
  const objeto = objetoDeCartao(cartao, programa, { emissor: env.GOOGLE_EMISSOR, codigo });
  await googlePedir(env, '/loyaltyObject', { metodo: 'POST', corpo: objeto });

  await env.DB.prepare(
    'UPDATE cartoes SET wallet_codigo = ?, wallet_em = ?, wallet_sincronizado = ? WHERE id = ?'
  ).bind(codigo, cartao.wallet_em || agora(), agora(), cartao.id).run();

  const { ligacao } = await ligacaoDeGravacao(env.GOOGLE_CHAVE, {
    emissorEmail: env.GOOGLE_EMAIL,
    objeto,
    origem: `https://${env.DOMINIO || 'carimbodigital.pt'}`,
  });
  return { ligacao };
});

/**
 * Manda para a Google o que mudou na CLASSE — nome, cor, prémio, logótipo.
 *
 * Sem isto, a classe era escrita uma vez e nunca mais: o dono mudava o nome do
 * cartão no balcão e quem tivesse o passe guardado continuava a ver o antigo,
 * para sempre. Quem tem o passe não volta a abrir a app — o que ele vê é o que
 * a Google tem.
 *
 * Como o espelho do saldo, corre fora do caminho da resposta e engole o erro:
 * gravar o nome novo no D1 não pode falhar porque a Google não respondeu.
 */
/** Todas as classes de um negócio — o nome, a cor e o logótipo são dele. */
async function espelharClassesDoNegocio(env, negocioId, pedido, ctx) {
  if (!walletLigada(env) || !ctx) return;
  const ps = (await env.DB.prepare(
    'SELECT id FROM programas WHERE negocio_id = ? AND wallet_classe IS NOT NULL'
  ).bind(negocioId).all()).results;
  const origem = origemDaAPI(pedido);
  /* UMA tarefa, em fila, e não N ao mesmo tempo. Cada `espelharClasse` pede um
     testemunho de acesso à Google, e a cache dele só protege ENTRE invocações:
     doze tarefas a arrancar juntas vêem-na fria as doze e fazem doze pedidos
     de OAuth em paralelo — que a Google estrangula, e que gastam doze dos
     cinquenta subpedidos que o plano gratuito dá por invocação. Em fila, a
     primeira aquece a cache e as outras aproveitam-na. */
  ctx.waitUntil((async () => {
    for (const p of ps) await espelharClasse(env, p.id, origem);
  })());
}

async function espelharClasse(env, programaId, origemAPI) {
  if (!walletLigada(env)) return;
  try {
    const p = await env.DB.prepare('SELECT * FROM programas WHERE id = ?').bind(programaId).first();
    if (!p || !p.wallet_classe) return;
    const n = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(p.negocio_id).first();
    await googlePedir(env, `/loyaltyClass/${env.GOOGLE_EMISSOR}.${p.id}`, {
      metodo: 'PATCH',
      corpo: actualizacaoDeClasse(p, n, { logotipo: enderecoDoLogotipo(n, origemAPI) }),
    });
  } catch (erro) {
    console.error('wallet: não deu para actualizar a classe', programaId, String(erro));
  }
}

/**
 * Manda o saldo novo para a Google, sem fazer ninguém esperar.
 *
 * Chamado com `ctx.waitUntil()` a partir de carimbar, resgatar e anular. O
 * erro é engolido de propósito e registado: o carimbo já está gravado no D1, e
 * o que falhar aqui é apanhado pelo reconciliador da madrugada. Fazer o
 * carimbo falhar porque a Google não respondeu seria deixar o cliente sem o
 * seu café por causa de uma coisa que ele nem sabe que existe.
 */
async function espelharNaWallet(env, cartaoId, { notificar = false } = {}) {
  if (!walletLigada(env)) return;
  try {
    const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
    if (!cartao || !cartao.wallet_em || !cartao.wallet_codigo) return;
    const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
      .bind(cartao.programa_id).first();
    await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${cartao.id}`, {
      metodo: 'PATCH',
      corpo: actualizacaoDeSaldo(cartao, programa, { notificar }),
    });
    await env.DB.prepare('UPDATE cartoes SET wallet_sincronizado = ? WHERE id = ?')
      .bind(agora(), cartao.id).run();
  } catch (erro) {
    console.error('wallet: não deu para actualizar', cartaoId, String(erro));
  }
}

/* =========================================================================
   O logótipo do negócio

   A coluna existia desde o primeiro dia e nunca ninguém lhe tocou. Passou a
   ser precisa porque a classe de fidelização da Google exige um `programLogo`,
   e esse campo quer um ENDEREÇO público — não um ficheiro nem um data URI.
   Daí haver aqui duas rotas: uma para o dono o gravar, e outra, aberta, que o
   serve como imagem.

   Guarda-se em base64 no D1 e não noutro lado nenhum. É o que evita mais um
   serviço, mais uma chave e mais um terceiro na página de privacidade — e
   estamos a falar de uma imagem quadrada de 512 px por negócio, que são umas
   dezenas de kilobytes. A redução acontece no browser antes de subir: mandar
   para aqui a fotografia de quatro megapixéis que o telemóvel tirou seria
   gastar o tecto do pedido e a paciência de quem está a usar dados móveis.
   ========================================================================= */

/* Os bytes iniciais que um PNG e um JPEG têm sempre. Não se confia na
   extensão nem no que o browser diz que é: confia-se nos bytes, como o
   `enviar-fotos` de outro projecto aprendeu a fazer. */
function tipoDaImagem(base64) {
  const cabeca = atob(base64.slice(0, 32));
  const b = Array.from(cabeca, (c) => c.charCodeAt(0));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  return null;
}

rota('PUT', '/v1/balcao/logotipo', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido, LOGOTIPO_MAX);

  /* Apagar é pôr a null, e não uma rota à parte: é o mesmo gesto do lado de
     quem usa — «tirar a imagem». */
  if (d.logotipo === null || d.logotipo === '') {
    /* NÃO SE APAGA UM LOGÓTIPO QUE JÁ ESTÁ EM CARTEIRAS ALHEIAS.

       Apagar punha a coluna a NULL e mandava o espelho para a Google — só
       que o corpo do PATCH só inclui o `programLogo` se houver um, e um
       PATCH que OMITE um campo deixa lá o valor antigo. O resultado era o
       pior dos dois: o endereço público passava a dar 404, a app deixava de
       mostrar o botão, e o logótipo apagado continuava no cartão de toda a
       gente que já o tinha guardado — sem gesto nenhum na interface que o
       tirasse de lá. E a Google nem sequer o releria: guarda a imagem numa
       cache própria.

       Também não se pode simplesmente mandar vazio: a classe de fidelização
       EXIGE um logótipo, e uma classe sem ele é recusada. O que resta é a
       verdade — trocar, não apagar. */
    const publicada = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM programas WHERE negocio_id = ? AND wallet_classe IS NOT NULL'
    ).bind(op.negocio_id).first();
    if (publicada && publicada.n > 0) {
      throw new Falha(
        'Este logótipo já está em cartões guardados na carteira de clientes, '
        + 'e essas carteiras não o largam. Troca a imagem por outra em vez de a tirar.',
        { estado: 409, codigo: 'logotipo-publicado' });
    }
    await env.DB.prepare(
      'UPDATE negocios SET logotipo = NULL, logotipo_em = NULL, logotipo_fundo = NULL WHERE id = ?'
    ).bind(op.negocio_id).run();
    await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
    return { logotipo: null };
  }

  const bruto = String(d.logotipo || '');
  /* Aceita-se com ou sem o prefixo `data:`, porque o `canvas.toDataURL()` do
     browser dá-o com prefixo e é de lá que isto vem. */
  const base64 = bruto.includes(',') ? bruto.slice(bruto.indexOf(',') + 1) : bruto;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length < 64) {
    throw new Falha('Isso não é uma imagem.', { estado: 400, codigo: 'imagem' });
  }
  if (base64.length > LOGOTIPO_MAX) {
    throw new Falha('A imagem é demasiado grande. Escolhe uma mais pequena.',
      { estado: 413, codigo: 'grande' });
  }
  const tipo = tipoDaImagem(base64);
  if (!tipo) throw new Falha('Só se aceita PNG ou JPEG.', { estado: 400, codigo: 'imagem' });

  /* A cor cozida vem do balcão, que é quem a pintou. Sem ela não há como
     saber, mais tarde, que a imagem deixou de condizer com o cartão. */
  const fundo = /^#[0-9a-fA-F]{6}$/.test(String(d.fundo || '')) ? d.fundo : null;
  await env.DB.prepare(
    'UPDATE negocios SET logotipo = ?, logotipo_em = ?, logotipo_fundo = ? WHERE id = ?'
  ).bind(`${tipo};${base64}`, agora(), fundo, op.negocio_id).run();
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  return { logotipo: true, tipo, fundo };
});

/* Aberta, de propósito: é este endereço que vai dentro do passe da Wallet, e
   quem o abre é a Google e o telemóvel de quem tiver o cartão. Não há aqui
   nada de privado — é a marca de um estabelecimento, que está na montra. */
rota('GET', /^\/v1\/negocio\/([a-z0-9-]{1,40})\/logotipo$/, async (env, pedido, [slug]) => {
  const n = await env.DB.prepare(
    "SELECT logotipo FROM negocios WHERE slug = ? AND estado = 'ativo'"
  ).bind(slug).first();
  if (!n || !n.logotipo) throw new Falha('Sem logótipo', { estado: 404 });
  const [tipo, base64] = [n.logotipo.slice(0, n.logotipo.indexOf(';')),
                          n.logotipo.slice(n.logotipo.indexOf(';') + 1)];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': tipo,
      /* Um ano, e `immutable` a sério: quem escreve o endereço cola-lhe o
         `?v=` do `logotipo_em` (ver `enderecoDoLogotipo`), por isso a imagem
         por detrás de um endereço destes nunca muda. Já foi ao contrário —
         endereço estável e conteúdo a mudar — e custou um logótipo velho
         preso na cache da Google, que honra o `immutable` à letra. */
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

/* =========================================================================
   O cartão na Apple Wallet

   O MESMO PORTÃO DA GOOGLE: enquanto os segredos não existirem, estas rotas
   respondem 404 e o botão não aparece na app. É o que permite ter isto
   publicado e provado antes de haver certificado.

   O CAMINHO É EM DOIS TEMPOS, e não por gosto. Um `.pkpass` só chega à
   carteira se o telemóvel NAVEGAR para ele — é o Safari que reconhece o tipo
   do ficheiro e abre o «Adicionar à Wallet». Uma navegação não leva cabeçalho
   `authorization` nenhum, por isso a rota que serve os bytes tem de ser
   aberta. Se fosse aberta e o endereço fosse o do cartão, qualquer pessoa
   descarregava o passe de qualquer pessoa.

   Daí o bilhete: o primeiro pedido é autenticado e devolve um endereço com um
   bilhete assinado lá dentro; o segundo abre-o. O bilhete vale minutos, diz
   de que cartão é, e é assinado com a CHAVE_MESTRA — não se guarda em lado
   nenhum, o que também evita mais uma tabela a limpar de madrugada.
   ========================================================================= */

const applePronta = (env) => Boolean(
  env.APPLE_CERTIFICADO && env.APPLE_CHAVE && env.APPLE_PASS_TIPO && env.APPLE_EQUIPA);

/* Minutos. Chega para tocar no botão e o telemóvel ir buscar o ficheiro; e é
   pouco para um endereço que apareça num registo ou numa captura de ecrã. */
const BILHETE_MINUTOS = 10;

async function bilheteDoPasse(env, cartaoId) {
  const expira = Date.now() + BILHETE_MINUTOS * 60000;
  const corpo = `${cartaoId}.${expira}`;
  const mestra = deBase64url(env.CHAVE_MESTRA);
  return `${base64url(new TextEncoder().encode(corpo))}.${base64url(await hmac(mestra, corpo))}`;
}

async function lerBilhete(env, bilhete) {
  const [parte, selo] = String(bilhete || '').split('.');
  if (!parte || !selo) return null;
  /* O `deBase64url` ATIRA com entrada que não seja base64 — e um bilhete
     truncado (um endereço partido a meio por um cliente de email, por
     exemplo) é exactamente isso. Sem este try, o que saía era um 500 «Erro
     interno» em vez do 403 com a frase que foi escrita para este caso. */
  let corpo;
  try { corpo = new TextDecoder().decode(deBase64url(parte)); }
  catch { return null; }
  const esperado = base64url(await hmac(deBase64url(env.CHAVE_MESTRA), corpo));
  /* Comparação de tempo constante. Um `!==` sobre textos devolve mais depressa
     quanto mais cedo diferirem, e isso chega para adivinhar um selo byte a
     byte se houver paciência. */
  if (selo.length !== esperado.length) return null;
  let diferenca = 0;
  for (let i = 0; i < selo.length; i += 1) diferenca |= selo.charCodeAt(i) ^ esperado.charCodeAt(i);
  if (diferenca !== 0) return null;
  const corte = corpo.lastIndexOf('.');
  const expira = Number(corpo.slice(corte + 1));
  if (!Number.isFinite(expira) || expira < Date.now()) return null;
  return corpo.slice(0, corte);
}

/**
 * Os segredos da Apple servem mesmo para assinar?
 *
 * O `applePronta` responde a «estão preenchidos?», que é outra pergunta. Isto
 * responde à de verdade, e responde barato: lê o certificado e importa a
 * chave, sem assinar nada. Serve para o erro sair no POST — onde a app o
 * apanha e o mostra — em vez de sair no GET, que é uma navegação do Safari e
 * onde um erro é um ecrã com JSON em cima.
 */
async function verificarSegredosApple(env) {
  try {
    const certs = certificadosDoPEM(env.APPLE_CERTIFICADO, 'APPLE_CERTIFICADO');
    if (!certs.length) throw new Error('não há certificado nenhum em APPLE_CERTIFICADO');
    emissorESerie(certs[0]);
    if (env.APPLE_CADEIA) certificadosDoPEM(env.APPLE_CADEIA, 'APPLE_CADEIA');
    await crypto.subtle.importKey('pkcs8', doPEM(env.APPLE_CHAVE),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (erro) {
    /* A mensagem vai inteira de propósito: quem a lê é quem pôs os segredos,
       e «Erro interno» não ajuda ninguém a perceber que a chave está no
       formato errado. Não leva segredo nenhum lá dentro — só o diagnóstico. */
    throw new Falha(`Os segredos da Apple não servem para assinar: ${erro.message}`,
      { estado: 500, codigo: 'apple-mal-configurada' });
  }
}

/**
 * As peças de um passe, e as razões por que ele pode não existir.
 *
 * Separado do `passeDoCartao` porque o POST só precisa de SABER se o passe é
 * possível — construí-lo para o deitar fora custa o dobro. A assinatura é RSA
 * de 2048 bits e o logótipo são dezenas de kilobytes a passar de base64 para
 * bytes; o tecto de CPU de uma invocação no plano gratuito são dez
 * milissegundos, e o «adicionar à carteira» fazia essa conta DUAS vezes: uma
 * no POST, que deitava fora, e outra no GET, que serve.
 */
async function pecasDoPasse(env, cartaoId) {
  const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });
  const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
    .bind(cartao.programa_id).first();
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?')
    .bind(cartao.negocio_id).first();
  if (!negocio || !negocio.logotipo) {
    throw new Falha('Este negócio ainda não tem logótipo, e a Wallet exige um.',
      { estado: 409, codigo: 'sem-logotipo' });
  }
  /* A APPLE SÓ ACEITA PNG nas imagens de um passe. A coluna pode ter JPEG — o
     `PUT /v1/balcao/logotipo` aceita-o de propósito, e para a Google serve —
     mas metê-lo no arquivo com o nome `icon.png` dá um passe que o iPhone
     recusa sem dizer porquê. Mais vale a recusa sair daqui, com uma frase. */
  if (!String(negocio.logotipo).startsWith('image/png;')) {
    throw new Falha(
      'A Apple só aceita logótipos em PNG. Volta a carregar a imagem no balcão, '
      + 'que a converte.',
      { estado: 409, codigo: 'logotipo-nao-png' });
  }
  return { cartao, programa, negocio };
}

/** O passe de um cartão, já assinado. */
async function passeDoCartao(env, cartaoId) {
  const { cartao, programa, negocio } = await pecasDoPasse(env, cartaoId);

  /* O `wallet_em` NÃO se toca aqui, e a diferença não é de nomes.

     Ele quer dizer «tem um loyaltyObject na Google» — é por ele que o espelho
     do saldo decide se manda o PATCH, e é por ele que o reconciliador da
     madrugada escolhe os atrasados. Um cartão só-Apple marcado assim fazia o
     Worker bater todas as noites num objecto que nunca existiu: o PATCH dava
     404, o `wallet_sincronizado` nunca era gravado, e a linha voltava a ser
     escolhida. Com `LIMIT 40` e sem ordenação, quarenta cartões destes
     bastavam para nenhum cartão da Google voltar a ser reconciliado.

     O `wallet_codigo` é que é partilhado, e de propósito: é o mesmo código de
     barras nas duas carteiras. */
  const codigo = cartao.wallet_codigo || publicoNovo(16);
  if (!cartao.wallet_codigo || !cartao.apple_em) {
    await env.DB.prepare(
      'UPDATE cartoes SET wallet_codigo = ?, apple_em = ? WHERE id = ?'
    ).bind(codigo, cartao.apple_em || agora(), cartao.id).run();
  }

  const passe = passeDeCartao(cartao, moldarPrograma(programa), negocio, {
    passTipo: env.APPLE_PASS_TIPO, equipa: env.APPLE_EQUIPA,
    codigo, dominio: env.DOMINIO,
  });

  /* A MESMA IMAGEM nos dois sítios, e de propósito. O que está guardado é um
     quadrado de 512, que é o que a Google quer; a Apple quer 38 pt de ícone e
     50 de altura de logótipo, e reduz o que lhe derem. Guardar mais tamanhos
     obrigava a mais colunas e a mais um gesto no balcão, para poupar umas
     dezenas de kilobytes num ficheiro que se descarrega uma vez. */
  const imagem = imagemDoNegocio(negocio);
  return construirPasse({
    passe,
    imagens: { 'icon.png': imagem, 'logo.png': imagem },
    certificado: env.APPLE_CERTIFICADO,
    chave: env.APPLE_CHAVE,
    cadeia: env.APPLE_CADEIA ? [env.APPLE_CADEIA] : [],
  });
}

/** Os bytes do logótipo guardado, sem o prefixo do tipo. */
function imagemDoNegocio(negocio) {
  const guardado = String(negocio.logotipo || '');
  const base64 = guardado.slice(guardado.indexOf(';') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

rota('POST', /^\/v1\/cliente\/cartoes\/([\w-]+)\/pkpass$/, async (env, pedido, [cartaoId]) => {
  if (!applePronta(env)) throw new Falha('Não existe', { estado: 404 });
  const clienteId = await exigirCliente(env, pedido);
  const cartao = await env.DB.prepare(
    'SELECT id FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });
  /* VERIFICA-SE antes de dar o endereço, mas não se CONSTRÓI. Construir o
     passe inteiro só para o deitar fora era pagar a assinatura RSA e a
     descodificação do logótipo duas vezes por cada «adicionar à carteira»,
     num Worker com dez milissegundos de tecto.

     Mas verificar é mesmo verificar: os SEGREDOS também. O `applePronta` só
     diz que as quatro variáveis não estão vazias, não que sirvam — e uma
     chave em PKCS#1 em vez de PKCS#8 (que é o que o `openssl genrsa` dá) só
     rebentava lá à frente, no GET, que é uma navegação do Safari. O que a
     pessoa via era um JSON de erro no ecrã em vez do passe. Ler o certificado
     e importar a chave custa microssegundos; assinar é que não. */
  await pecasDoPasse(env, cartaoId);
  await verificarSegredosApple(env);
  return { ligacao: `${origemDaAPI(pedido)}/v1/passe/${await bilheteDoPasse(env, cartaoId)}` };
});

rota('GET', /^\/v1\/passe\/([\w.-]+)$/, async (env, pedido, [bilhete]) => {
  if (!applePronta(env)) throw new Falha('Não existe', { estado: 404 });
  const cartaoId = await lerBilhete(env, bilhete);
  if (!cartaoId) throw new Falha('Esta ligação já não serve. Pede outra na app.', { estado: 403 });
  const bytes = await passeDoCartao(env, cartaoId);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/vnd.apple.pkpass',
      'content-disposition': 'attachment; filename="cartao.pkpass"',
      /* Nada de cache: o passe leva o saldo lá dentro, e um passe guardado é
         um passe com o número de carimbos errado. */
      'cache-control': 'no-store',
    },
  });
});

rota('POST', '/v1/balcao/programas', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido);
  const existente = d.id
    ? await env.DB.prepare('SELECT * FROM programas WHERE id = ? AND negocio_id = ?')
        .bind(d.id, op.negocio_id).first()
    : null;
  const c = camposDoPrograma(d, existente);

  if (existente) {
    await env.DB.prepare(
      `UPDATE programas SET nome = ?, premio = ?, objetivo = ?, selo = ?, regras = ?,
              arrefecimento = ? WHERE id = ?`
    ).bind(c.nome, c.premio, c.objetivo, c.selo, c.regras, c.arrefecimento, existente.id).run();
  } else {
    /* Um tecto ao número de cartões. Cada POST sem `id` criava mais um, sem
       fim — e cada um deles é um cartão pintado na lista pública de toda a
       gente, mais uma volta no `descobrir`, que já é uma consulta por
       programa. Não é preciso má intenção: um botão «Guardar» que responda
       devagar e leve dois toques chega. */
    const { n } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM programas WHERE negocio_id = ?'
    ).bind(op.negocio_id).first();
    if (n >= PROGRAMAS_MAX) {
      throw new Falha(`Já tens ${PROGRAMAS_MAX} cartões neste negócio. Apaga um antes de criar outro.`,
        { estado: 409, codigo: 'demasiados-programas' });
    }
    await env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras, arrefecimento, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id(), op.negocio_id, c.nome, c.tipo, c.selo,
           c.objetivo, c.premio, c.regras, c.arrefecimento, agora()).run();
  }
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(op.negocio_id).all()).results;
  /* O nome do cartão, o prémio e as regras vivem também na classe da Wallet.
     Mudá-los aqui sem os mandar para lá deixava o passe a dizer o que já não
     é verdade. */
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  return programas.map(moldarPrograma);
});

rota('POST', '/v1/balcao/carimbar', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const r = await carimbar(env, pedido, op);
  /* O espelho na Wallet vai depois da resposta, com `waitUntil`. O carimbo já
     está gravado; o que acontecer à Google não pode fazer o balcão esperar
     nem falhar.

     E a notificação só sai no carimbo que FECHA o cartão. O tecto é de três
     por passe em 24 horas: gastá-lo nos carimbos do meio deixava em silêncio
     o único que a pessoa quer sentir no bolso. */
  if (r && r.cartao && ctx) {
    /* `r.premio` NUNCA EXISTIU. O `carimbar()` devolve `ganhos`, que é uma
       lista — `Boolean(r.premio)` era `false` sempre, e o único toque no
       bolso que esta aplicação dá nunca saiu de casa. O tecto da Google são
       três notificações por dia; gasta-se no carimbo que fecha o cartão, que
       é o único que a pessoa quer sentir. */
    ctx.waitUntil(espelharNaWallet(env, r.cartao.id,
      { notificar: Boolean(r.ganhos && r.ganhos.length) }));
  }
  return r;
});

rota('POST', '/v1/balcao/resgatar', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const { premioId } = await corpoJSON(pedido);
  exigirTexto(premioId, 'premioId');
  const premio = await env.DB.prepare(
    `SELECT p.*, c.negocio_id FROM premios p JOIN cartoes c ON c.id = p.cartao_id WHERE p.id = ?`
  ).bind(premioId).first();
  if (!premio) throw new Falha('Prémio não encontrado', { estado: 404 });
  if (premio.negocio_id !== op.negocio_id) throw new Falha('Prémio de outro negócio', { estado: 403 });
  if (premio.resgatado_em) throw new Falha('Este prémio já foi entregue.', { estado: 409, codigo: 'ja-resgatado' });

  /* A leitura acima já viu que o prémio estava por entregar, mas entre a
     leitura e a escrita cabe outro pedido — e dois toques no mesmo botão,
     ou dois telemóveis ao balcão, entregavam o mesmo prémio duas vezes e
     deixavam dois resgates no histórico. A condição vai na própria escrita:
     quem chegar em segundo não muda nada e fica a saber. */
  const escrita = await env.DB.prepare(
    `UPDATE premios SET resgatado_em = ?, resgatado_por = ?
      WHERE id = ? AND resgatado_em IS NULL`
  ).bind(agora(), op.nome, premioId).run();
  if (escrita.meta && escrita.meta.changes === 0) {
    throw new Falha('Este prémio já foi entregue.', { estado: 409, codigo: 'ja-resgatado' });
  }
  await env.DB.prepare(
    'INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id(), premio.cartao_id, 'resgate', premio.descricao, op.nome, agora()).run();
  const c = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(premio.cartao_id).first();
  /* Sem notificar: o cliente está ali à frente a receber o prémio, não
     precisa de um toque no bolso a dizer-lho. */
  if (ctx) ctx.waitUntil(espelharNaWallet(env, premio.cartao_id));
  return { premio: { id: premioId, resgatadoEm: agora() }, cartao: await moldarCartao(env, c) };
});

rota('POST', '/v1/balcao/anular', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const { movimentoId } = await corpoJSON(pedido);
  exigirTexto(movimentoId, 'movimentoId');
  const m = await env.DB.prepare(
    `SELECT m.*, c.negocio_id, c.programa_id FROM movimentos m
       JOIN cartoes c ON c.id = m.cartao_id WHERE m.id = ?`
  ).bind(movimentoId).first();
  if (!m) throw new Falha('Movimento não encontrado', { estado: 404 });
  if (m.negocio_id !== op.negocio_id) throw new Falha('Movimento de outro negócio', { estado: 403 });
  /* Anular é para carimbos e pontos. Sem esta guarda, o movimento era
     apagado fosse ele qual fosse — dava para apagar a adesão de um cliente
     ou o registo de um prémio entregue, e nenhum dos dois ramos abaixo
     repunha o que quer que fosse. Ficava um buraco no histórico. */
  if (m.tipo !== 'carimbo' && m.tipo !== 'pontos') {
    throw new Falha('Só se anulam carimbos e pontos.', { estado: 400, codigo: 'tipo' });
  }
  /* Dois minutos. Passado isso o cliente já foi embora e anular passa a ser
     uma forma de tirar carimbos a quem não está a ver. */
  if (Date.now() - new Date(m.em).getTime() > 120000) {
    throw new Falha('Já passaram mais de 2 minutos — não dá para anular.',
      { estado: 409, codigo: 'tarde' });
  }
  const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(m.cartao_id).first();
  const p = await programaCompleto(env, m.programa_id);

  /* Se este carimbo completou o cartão e o prémio JÁ foi entregue, anular
     devolvia os carimbos e deixava o café a perder duas vezes: o brinde
     saiu e o cartão volta a estar quase cheio. O prémio ainda por entregar
     desfaz-se com o carimbo; o que já saiu pela porta não se desfaz. */
  const completou = m.tipo === 'carimbo' && cartao.carimbos - m.quantidade < 0;
  if (completou) {
    const entregue = await env.DB.prepare(
      `SELECT id FROM premios WHERE cartao_id = ? AND resgatado_em IS NOT NULL
        ORDER BY ganho_em DESC LIMIT 1`
    ).bind(cartao.id).first();
    if (entregue) {
      throw new Falha('Este carimbo deu um prémio que já foi entregue — não dá para anular.',
        { estado: 409, codigo: 'premio-entregue' });
    }
  }

  let carimbos = cartao.carimbos, pontos = cartao.pontos;
  let total = cartao.total_carimbos, ganhos = cartao.premios_ganhos;
  const instrucoes = [];
  if (m.tipo === 'pontos') {
    pontos = Math.max(0, pontos - m.quantidade);
  } else if (m.tipo === 'carimbo') {
    carimbos -= m.quantidade;
    total = Math.max(0, total - m.quantidade);
    if (carimbos < 0) {
      /* Anulou-se o carimbo que completou o cartão: o prémio tem de voltar
         atrás com ele, senão fica um prémio ganho sem nada que o justifique. */
      const premio = await env.DB.prepare(
        'SELECT id FROM premios WHERE cartao_id = ? AND resgatado_em IS NULL ORDER BY ganho_em DESC LIMIT 1'
      ).bind(cartao.id).first();
      if (premio) {
        instrucoes.push(env.DB.prepare('DELETE FROM premios WHERE id = ?').bind(premio.id));
        ganhos = Math.max(0, ganhos - 1);
      }
      carimbos += p.objetivo;
    }
  }
  /* Repor o relógio do arrefecimento no movimento anterior. Sem isto, quem
     se enganasse no cliente anulava — e a seguir não conseguia carimbar o
     cliente certo durante uma hora, porque o cartão ainda tinha a marca de
     um carimbo que já não existe. */
  const anterior = await env.DB.prepare(
    `SELECT em FROM movimentos
      WHERE cartao_id = ? AND id != ? AND tipo IN ('carimbo','pontos')
      ORDER BY em DESC LIMIT 1`
  ).bind(cartao.id, movimentoId).first();

  instrucoes.push(
    env.DB.prepare(
      `UPDATE cartoes SET carimbos = ?, pontos = ?, total_carimbos = ?,
              premios_ganhos = ?, ultimo_em = ? WHERE id = ?`)
      .bind(carimbos, pontos, total, ganhos, anterior ? anterior.em : null, cartao.id),
    env.DB.prepare('DELETE FROM movimentos WHERE id = ?').bind(movimentoId),
    env.DB.prepare('INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), cartao.id, 'anulado', 'Movimento anulado', op.nome, agora()),
  );
  await env.DB.batch(instrucoes);
  const atualizado = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartao.id).first();
  /* Anular também muda o saldo, e o passe tem de o acompanhar — senão a
     carteira fica a dizer um número que já não é verdade, e é a carteira que
     a pessoa vê. */
  if (ctx) ctx.waitUntil(espelharNaWallet(env, atualizado.id));
  return { cartao: await moldarCartao(env, atualizado) };
});

rota('GET', '/v1/balcao/clientes', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const linhas = (await env.DB.prepare(
    `SELECT c.*, cl.publico, p.objetivo, p.tipo
       FROM cartoes c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN programas p ON p.id = c.programa_id
      WHERE c.negocio_id = ?
      ORDER BY COALESCE(c.ultimo_em, c.aderiu_em) DESC
      LIMIT 300`
  ).bind(op.negocio_id).all()).results;

  /* OS PRÉMIOS POR ENTREGAR VÃO INTEIROS, e não só contados.

     Era uma contagem, e com uma contagem não se entrega nada: a lista dizia
     «prémio» ao lado do número do cartão e não havia como o dar. O único
     caminho para o painel de entrega era CARIMBAR — e quem já tinha carimbado
     há menos de uma hora esbarrava no arrefecimento. Um cliente que fechasse
     o cartão e dissesse «levo noutro dia» ficava sem café até voltar noutro
     dia E ganhar um carimbo que não pediu.

     Uma consulta para a lista toda, e não uma por cartão: a subconsulta
     correlacionada que aqui estava corria trezentas vezes. */
  const pendentes = (await env.DB.prepare(
    `SELECT pr.id, pr.cartao_id, pr.descricao, pr.ganho_em
       FROM premios pr
       JOIN cartoes c ON c.id = pr.cartao_id
      WHERE c.negocio_id = ? AND pr.resgatado_em IS NULL
      ORDER BY pr.ganho_em`
  ).bind(op.negocio_id).all()).results;
  const porCartao = new Map();
  for (const pr of pendentes) {
    const lista = porCartao.get(pr.cartao_id) || [];
    lista.push({ id: pr.id, descricao: pr.descricao, ganhoEm: pr.ganho_em });
    porCartao.set(pr.cartao_id, lista);
  }

  return linhas.map((c) => {
    const premios = porCartao.get(c.id) || [];
    return {
      publico: c.publico, carimbos: c.carimbos, pontos: c.pontos,
      objetivo: c.objetivo, tipo: c.tipo,
      ultimoEm: c.ultimo_em, aderiuEm: c.aderiu_em,
      /* A contagem FICA: é o que a versão da app que está nos telemóveis lê,
         e esta API acrescenta em vez de renomear. */
      porResgatar: premios.length,
      premios,
    };
  });
});

rota('GET', '/v1/balcao/resumo', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const n = op.negocio_id;
  const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
  const ha30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const ha60 = new Date(Date.now() - 60 * 86400000).toISOString();

  const uma = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()).n;

  return {
    clientes: await uma('SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ?', n),
    novos30: await uma('SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ? AND aderiu_em >= ?', n, ha30),
    carimbosHoje: await uma(
      `SELECT COUNT(*) AS n FROM movimentos m JOIN cartoes c ON c.id = m.cartao_id
        WHERE c.negocio_id = ? AND m.tipo IN ('carimbo','pontos') AND m.em >= ?`, n, inicioDia.toISOString()),
    carimbos30: await uma(
      `SELECT COUNT(*) AS n FROM movimentos m JOIN cartoes c ON c.id = m.cartao_id
        WHERE c.negocio_id = ? AND m.tipo IN ('carimbo','pontos') AND m.em >= ?`, n, ha30),
    premiosGanhos: await uma(
      'SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id WHERE c.negocio_id = ?', n),
    premiosResgatados: await uma(
      `SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id
        WHERE c.negocio_id = ? AND p.resgatado_em IS NOT NULL`, n),
    porResgatar: await uma(
      `SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id
        WHERE c.negocio_id = ? AND p.resgatado_em IS NULL`, n),
    quaseLa: await uma(
      `SELECT COUNT(*) AS n FROM cartoes c JOIN programas p ON p.id = c.programa_id
        WHERE c.negocio_id = ? AND p.tipo = 'carimbos'
          AND (p.objetivo - c.carimbos) BETWEEN 1 AND 2`, n),
    aFugir: await uma(
      'SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ? AND ultimo_em IS NOT NULL AND ultimo_em < ?', n, ha60),
  };
});

/* --- público ------------------------------------------------------------ */

rota('GET', /^\/v1\/p\/([\w-]+)$/, async (env, pedido, [slug]) => {
  const n = await env.DB.prepare(
    "SELECT * FROM negocios WHERE slug = ? AND estado = 'ativo'"
  ).bind(slug).first();
  if (!n) throw new Falha('Não encontrado', { estado: 404 });
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(n.id).all()).results;
  return {
    id: n.id, slug: n.slug, nome: n.nome, cor: n.cor, categoria: n.categoria,
    localidade: n.localidade, morada: n.morada, telefone: n.telefone,
    programas: programas.map(moldarPrograma),
  };
});

rota('GET', '/v1/saude', async (env) => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM negocios').first();
  return { bem: true, negocios: r.n, em: agora() };
});

/* =========================================================================
   Entrada
   ========================================================================= */

export default {
  /* O `ctx` é o terceiro parâmetro e faltava. É dele que depende a promessa de
     que uma falha da Google nunca faz falhar um carimbo: o `ctx.waitUntil()`
     deixa o Worker responder já e continuar o trabalho depois. Sem ele, ou se
     esperava pela Google — e o balcão ficava à espera com uma fila à frente —
     ou se atirava o pedido ao ar sem garantia de que chegava a sair. */
  async fetch(pedido, env, ctx) {
    if (pedido.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cabecalhosCORS(pedido, env) });
    }
    const url = new URL(pedido.url);
    const caminho = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (!env.CHAVE_MESTRA) {
        throw new Falha('O Worker não está configurado: falta a CHAVE_MESTRA.', { estado: 500 });
      }
      for (const r of rotas) {
        if (r.metodo !== pedido.method) continue;
        let resposta;
        if (typeof r.padrao === 'string') {
          if (r.padrao !== caminho) continue;
          resposta = await r.mao(env, pedido, [], ctx);
        } else {
          const m = caminho.match(r.padrao);
          if (!m) continue;
          resposta = await r.mao(env, pedido, m.slice(1), ctx);
        }
        /* Quase tudo aqui devolve dados e sai como JSON. Mas o logótipo sai
           como imagem, com o seu tipo e a sua cache — e uma rota que já
           construiu a resposta passa à frente inteira. Sem isto, a imagem ia
           embrulhada em JSON e o browser desenhava um quadrado partido. */
        if (resposta instanceof Response) {
          for (const [k, v] of Object.entries(cabecalhosCORS(pedido, env))) {
            if (!resposta.headers.has(k)) resposta.headers.set(k, v);
          }
          return resposta;
        }
        return json(resposta, { pedido, env });
      }
      return json({ erro: 'Não existe' }, { estado: 404, pedido, env });
    } catch (e) {
      if (e instanceof Falha) {
        return json({ erro: e.message, codigo: e.codigo, ...e.extra },
          { estado: e.estado, pedido, env });
      }
      console.error(e);
      return json({ erro: 'Erro interno' }, { estado: 500, pedido, env });
    }
  },

  /* Limpeza. Corre uma vez por dia (ver o cron no wrangler.toml). Sem isto,
     `codigos_usados` cresce para sempre: são quatro linhas por minuto por
     cliente activo, e o plano gratuito do D1 tem 5 GB. */
  async scheduled(evento, env) {
    const ontem = new Date(Date.now() - USADOS_HORAS * 3600000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM codigos_usados WHERE usado_em < ?').bind(ontem),
      env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()),
      env.DB.prepare('DELETE FROM entradas WHERE expira_em < ?').bind(agora()),
      env.DB.prepare('DELETE FROM envios WHERE em < ?')
        .bind(new Date(Date.now() - 86400000).toISOString()),
    ]);
    await limparContasParadas(env);
    await reconciliarWallet(env);
  },
};

/* =========================================================================
   O reconciliador da Wallet

   O que falhou durante o dia acerta-se de madrugada. É esta função que torna
   verdadeira a promessa do `espelharNaWallet`: falhar não custa nada, porque
   de manhã está certo.

   AOS BOCADOS, e não todos de uma vez. O plano gratuito dá 50 SUBPEDIDOS por
   invocação — e isto corre dentro de uma invocação só. Cinco carimbos por
   segundo num café não enchem isto nunca; uma noite em que a Google esteve em
   baixo durante horas, enche. Leva-se um punhado por noite e o resto fica
   para a seguinte, que é melhor do que rebentar a meio e não gravar nenhum.
   ========================================================================= */

const RECONCILIAR_MAX = 40;

async function reconciliarWallet(env) {
  if (!walletLigada(env)) return { feitos: 0 };
  /* Por sincronizar = nunca foi, ou foi antes do último carimbo. */
  const atrasados = (await env.DB.prepare(
    `SELECT id FROM cartoes
      WHERE wallet_em IS NOT NULL
        AND (wallet_sincronizado IS NULL
             OR (ultimo_em IS NOT NULL AND wallet_sincronizado < ultimo_em))
      LIMIT ?`
  ).bind(RECONCILIAR_MAX).all()).results;
  for (const c of atrasados) await espelharNaWallet(env, c.id);
  return { feitos: atrasados.length };
}

/* =========================================================================
   Contas paradas

   O RGPD não deixa guardar dados pessoais mais tempo do que o preciso, e uma
   conta que ninguém abre há dois anos é isso mesmo. Há duas passagens, e
   correm por esta ordem: primeiro avisa-se quem deixou email, `AVISO_DIAS`
   antes; depois apaga-se quem já passou dos `INACTIVA_MESES`.

   O QUE CONTA COMO SINAL DE VIDA, e é aqui que está a parte que se esquece:
   não é só abrir a app. Quem passa no café e leva um carimbo nunca toca na
   app — quem carimba é o balcão, com a sessão do balcão, e o `visto_em` do
   cliente não mexe. Por isso a pergunta olha para as duas coisas: a conta e
   os cartões dela. Apagar por uma só apagava clientes fiéis que não gostam
   de mexer no telemóvel.
   ========================================================================= */

/** Quantos meses para trás, em ISO. Os meses do JavaScript tratam do resto. */
function mesesAtras(meses) {
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  return d.toISOString();
}

/** As contas sem sinal de vida desde `limite`. */
async function contasParadas(env, limite, extra = '') {
  return (await env.DB.prepare(
    `SELECT c.id, c.email, c.email_verificado, c.avisada_em
       FROM clientes c
      WHERE COALESCE(c.visto_em, c.criado_em) < ?1
        AND NOT EXISTS (
          SELECT 1 FROM cartoes k
           WHERE k.cliente_id = c.id
             AND COALESCE(k.ultimo_em, k.aderiu_em) >= ?1
        )
        ${extra}`
  ).bind(limite).all()).results;
}

async function limparContasParadas(env) {
  const limiteApagar = mesesAtras(INACTIVA_MESES);
  const limiteAvisar = new Date(
    new Date(mesesAtras(INACTIVA_MESES)).getTime() + AVISO_DIAS * 86400000
  ).toISOString();

  /* 1. Avisar. Só quem deixou email — a quem não deixou não há por onde falar,
        e é o preço de uma conta sem morada nenhuma. O `avisada_em` impede que
        o aviso saia outra vez todos os dias durante um mês. */
  const aAvisar = await contasParadas(env, limiteAvisar,
    'AND c.email IS NOT NULL AND c.email_verificado = 1 AND c.avisada_em IS NULL');
  for (const conta of aAvisar) {
    const r = await enviarEmail(env, {
      para: conta.email,
      ...emailContaAApagar({ dias: AVISO_DIAS, meses: INACTIVA_MESES }),
    });
    /* Só se marca como avisada se o email saiu mesmo. Se a marca fosse posta
       à frente do envio, uma falha de correio calava o aviso para sempre e a
       conta era apagada sem ninguém ter sido avisado de nada. */
    if (r.enviado) {
      await env.DB.prepare('UPDATE clientes SET avisada_em = ? WHERE id = ?')
        .bind(agora(), conta.id).run();
    }
  }

  /* 2. Apagar. Uma a uma, e não num DELETE só: cada conta arrasta cartões,
        movimentos, prémios, sessões e entradas, e quem sabe essa lista é o
        `apagarCliente` — o mesmo que corre quando alguém carrega no botão. */
  const aApagar = await contasParadas(env, limiteApagar);
  for (const conta of aApagar) await apagarCliente(env, conta.id);

  return { avisadas: aAvisar.length, apagadas: aApagar.length };
}
