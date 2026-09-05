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
     RESEND_API_KEY      — opcional; sem ela não se enviam emails e a app
                           continua a funcionar sem recuperação por email.
   ========================================================================= */

const JANELA = 15;                 // segundos de vida de um código
const TOLERANCIA = 2;              // janelas de folga para relógios desencontrados
const SESSAO_DIAS = 180;
const ENTRADA_MINUTOS = 15;
const ENTRADA_TENTATIVAS = 5;

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
  return s.id;
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
            n.morada AS negocio_morada, n.telefone AS negocio_telefone
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
  };
}

/* =========================================================================
   O carimbo — o coração de tudo
   ========================================================================= */

async function carimbar(env, pedido, operador) {
  const corpo = await pedido.json();
  const { codigo, programaId } = corpo;
  let quantidade = Math.max(1, Math.min(500, Number(corpo.quantidade) || 1));
  let manual = Boolean(corpo.manual);

  const p = await programaCompleto(env, programaId);
  if (!p) throw new Falha('Programa não encontrado', { estado: 404 });
  if (p.negocio_id !== operador.negocio_id) {
    throw new Falha('Este programa não é deste negócio', { estado: 403 });
  }
  if (p.tipo !== 'pontos') quantidade = 1;

  /* --- quem é o cliente --- */
  const partes = String(codigo || '').split('.');
  let publico, janela = null;
  if (partes[0] === 'M1' && partes.length === 2) {
    publico = partes[1].toUpperCase();
    manual = true;
  } else if (partes[0] === 'C1' && partes.length === 4) {
    publico = partes[1];
    janela = Number(partes[2]);
  } else {
    throw new Falha('Este código não é de um cartão Carimbo Digital.', { codigo: 'formato' });
  }

  const cliente = await env.DB.prepare(
    'SELECT id, publico FROM clientes WHERE publico = ?'
  ).bind(publico).first();
  if (!cliente) throw new Falha('Cartão desconhecido.', { estado: 404, codigo: 'sem-cliente' });

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

async function enviarEmail(env, { para, assunto, texto }) {
  if (!env.RESEND_API_KEY) return { enviado: false, motivo: 'sem-chave' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_REMETENTE || 'Carimbo Digital <ola@carimbodigital.pt>',
        to: [para], subject: assunto, text: texto,
      }),
    });
    if (r.ok) return { enviado: true };

    /* Um envio recusado tem quase sempre uma razão concreta — chave errada,
       domínio por verificar, destinatário fora do permitido. Registá-la é o
       que evita meia hora à procura: vê-se com `npx wrangler tail`.
       O motivo NÃO volta ao cliente: diria a um estranho como está montada
       a casa. */
    const detalhe = await r.text().catch(() => '');
    console.error('Resend recusou', r.status, detalhe.slice(0, 400));
    return { enviado: false, motivo: 'recusado', estado: r.status };
  } catch (e) {
    console.error('Resend inacessível:', e.message);
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
async function consumirEntrada(env, email, codigo) {
  const limpo = String(codigo || '').replace(/\D/g, '');
  if (limpo.length !== 6) throw new Falha('O código tem seis algarismos.', { estado: 400 });
  const correio = String(email || '').trim().toLowerCase();

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
  const cartoes = (await Promise.all(linhas.map((c) => moldarCartao(env, c)))).filter(Boolean);
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
  const { programaId } = await pedido.json();
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
  const negocios = (await env.DB.prepare(
    "SELECT * FROM negocios WHERE estado = 'ativo' ORDER BY nome"
  ).all()).results;
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
      programas: comMarcos,
    });
  }
  return saida;
});

rota('POST', '/v1/cliente/email', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { email } = await pedido.json();
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(String(email || ''))) {
    throw new Falha('Email inválido');
  }
  await env.DB.prepare('UPDATE clientes SET email = ? WHERE id = ?').bind(email, clienteId).run();

  /* Um email de cada vez: apaga-se qualquer código anterior para o mesmo
     destino, senão ficavam vários válidos ao mesmo tempo. */
  await env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`cliente:${clienteId}`).run();

  const codigo = codigoEntrada();
  await env.DB.prepare(
    'INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em) VALUES (?, ?, ?, ?, ?)'
  ).bind(await resumo(`${email}|${codigo}`), `cliente:${clienteId}`, email, agora(),
         new Date(Date.now() + ENTRADA_MINUTOS * 60000).toISOString()).run();

  const r = await enviarEmail(env, {
    para: email,
    assunto: `${codigo} — o teu código Carimbo Digital`,
    texto: `Olá!\n\nO teu código é:\n\n    ${codigo}\n\n`
      + `Escreve-o na app para guardares os teus cartões.\n`
      + `Vale ${ENTRADA_MINUTOS} minutos e só serve uma vez.\n\n`
      + `Se não foste tu, ignora este email — não acontece nada.\n\nCarimbo Digital`,
  });
  /* Devolve-se a verdade: é o email do próprio, e mandá-lo esperar por um
     código que nunca vai chegar é a pior coisa que se lhe pode fazer. */
  return { enviado: r.enviado, motivo: r.enviado ? null : r.motivo };
});

rota('POST', '/v1/cliente/entrar', async (env, pedido) => {
  const { email, codigo } = await pedido.json();
  const linha = await consumirEntrada(env, email, codigo);
  const [tipo, valor] = linha.alvo.split(':');
  if (tipo !== 'cliente') throw new Falha('Código inválido', { estado: 400 });
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(valor).first();
  if (!cliente) throw new Falha('Conta não encontrada', { estado: 404 });
  await env.DB.prepare('UPDATE clientes SET email_verificado = 1 WHERE id = ?').bind(valor).run();

  return {
    cliente: { id: cliente.id, publico: cliente.publico, email: cliente.email, criadoEm: cliente.criado_em },
    segredo: await derivarSegredo(env, cliente.id),
    sessao: await criarSessao(env, `cliente:${cliente.id}`),
    horaDoServidor: agora(),
  };
});

rota('GET', '/v1/cliente/dados', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(clienteId).first();
  const cartoes = (await env.DB.prepare('SELECT * FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;
  const detalhados = [];
  const movimentos = [];
  const premios = [];
  for (const c of cartoes) {
    detalhados.push(await moldarCartao(env, c));
    movimentos.push(...(await env.DB.prepare('SELECT * FROM movimentos WHERE cartao_id = ?').bind(c.id).all()).results);
    premios.push(...(await env.DB.prepare('SELECT * FROM premios WHERE cartao_id = ?').bind(c.id).all()).results);
  }
  return { geradoEm: agora(), cliente, cartoes: detalhados, movimentos, premios };
});

rota('DELETE', '/v1/cliente', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  /* As chaves estrangeiras estão em CASCADE, mas o D1 só as aplica com
     PRAGMA foreign_keys ligado — que nem sempre está. Apaga-se à mão, pela
     ordem certa, para não ficarem órfãos na base de dados. */
  const cartoes = (await env.DB.prepare('SELECT id FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;
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
 * Enquanto o serviço for por convite, quem o cria é este endereço, fechado
 * por um segredo (`CODIGO_FUNDADOR`). Quando a inscrição passar a ser livre,
 * troca-se o convite por uma confirmação de email e o resto fica igual.
 */
rota('POST', '/v1/balcao/fundar', async (env, pedido) => {
  if (!env.CODIGO_FUNDADOR) {
    throw new Falha('As inscrições estão fechadas.', { estado: 403, codigo: 'fechado' });
  }
  const d = await pedido.json();
  if (!iguais(await resumo(String(d.codigo || '')), await resumo(env.CODIGO_FUNDADOR))) {
    throw new Falha('Convite inválido.', { estado: 403, codigo: 'convite' });
  }

  const nome = String(d.nome || '').trim().slice(0, 60);
  const email = String(d.email || '').trim().toLowerCase();
  if (nome.length < 2) throw new Falha('Falta o nome do negócio.');
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(email)) {
    throw new Falha('Email inválido.');
  }

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
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO negocios (id, slug, nome, categoria, cor, localidade, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(negocioId, slug, nome, d.categoria || null, d.cor || '#17161C',
           d.localidade || null, agora()),
    env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras,
                              arrefecimento, criado_em)
       VALUES (?, ?, ?, 'carimbos', ?, ?, ?, ?, ?, ?)`
    ).bind(programaId, negocioId, d.programa || 'Cartão de cliente', d.selo || 'carimbo',
           Math.max(2, Math.min(30, Number(d.objetivo) || 10)),
           d.premio || 'Um brinde por conta da casa',
           d.regras || 'Um carimbo por visita.', 3600, agora()),
    env.DB.prepare(
      `INSERT INTO operadores (id, negocio_id, nome, email, papel, criado_em)
       VALUES (?, ?, ?, ?, 'dono', ?)`
    ).bind(operadorId, negocioId, d.operador || 'Balcão', email, agora()),
  ]);

  return {
    negocio: { id: negocioId, slug, nome },
    sessao: await criarSessao(env, `operador:${operadorId}`),
  };
});

rota('POST', '/v1/balcao/entrar', async (env, pedido) => {
  const { email } = await pedido.json();
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(String(email || ''))) {
    throw new Falha('Email inválido');
  }
  const op = await env.DB.prepare(
    'SELECT id FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(email).first();

  /* Responde-se sempre o mesmo, exista ou não a conta: senão este endpoint
     torna-se uma forma de descobrir que emails estão registados. */
  if (op) {
    await env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`operador:${op.id}`).run();
    const codigo = codigoEntrada();
    await env.DB.prepare(
      'INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em) VALUES (?, ?, ?, ?, ?)'
    ).bind(await resumo(`${email}|${codigo}`), `operador:${op.id}`, email, agora(),
           new Date(Date.now() + ENTRADA_MINUTOS * 60000).toISOString()).run();
    await enviarEmail(env, {
      para: email,
      assunto: `${codigo} — entrar no Carimbo Digital Balcão`,
      texto: `O teu código é:\n\n    ${codigo}\n\n`
        + `Escreve-o no telemóvel do balcão. Vale ${ENTRADA_MINUTOS} minutos `
        + `e só serve uma vez.\n\nCarimbo Digital`,
    });
  }
  return { enviado: true };
});

rota('POST', '/v1/balcao/sessao', async (env, pedido) => {
  const { email, codigo } = await pedido.json();
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
  return {
    operador: { id: op.id, nome: op.nome, papel: op.papel },
    negocio: { ...negocio, programas: comMarcos },
  };
});

rota('PUT', '/v1/balcao/negocio', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await pedido.json();
  await env.DB.prepare(
    `UPDATE negocios SET nome = COALESCE(?, nome), cor = COALESCE(?, cor),
            morada = COALESCE(?, morada), localidade = COALESCE(?, localidade),
            telefone = COALESCE(?, telefone) WHERE id = ?`
  ).bind(d.nome ?? null, d.cor ?? null, d.morada ?? null, d.localidade ?? null,
         d.telefone ?? null, op.negocio_id).run();
  return env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(op.negocio_id).first();
});

rota('POST', '/v1/balcao/programas', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await pedido.json();
  const objetivo = Math.max(2, Math.min(30, Number(d.objetivo) || 10));
  const existente = d.id
    ? await env.DB.prepare('SELECT * FROM programas WHERE id = ? AND negocio_id = ?')
        .bind(d.id, op.negocio_id).first()
    : null;

  if (existente) {
    await env.DB.prepare(
      `UPDATE programas SET nome = ?, premio = ?, objetivo = ?, selo = ?, regras = ?,
              arrefecimento = ? WHERE id = ?`
    ).bind(d.nome || existente.nome, d.premio || existente.premio, objetivo,
           d.selo || existente.selo, d.regras ?? existente.regras,
           Number(d.arrefecimento ?? existente.arrefecimento), existente.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras, arrefecimento, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id(), op.negocio_id, d.nome || 'Cartão', d.tipo || 'carimbos', d.selo || 'carimbo',
           objetivo, d.premio || 'Prémio', d.regras || null, Number(d.arrefecimento) || 3600, agora()).run();
  }
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(op.negocio_id).all()).results;
  return programas.map(moldarPrograma);
});

rota('POST', '/v1/balcao/carimbar', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  return carimbar(env, pedido, op);
});

rota('POST', '/v1/balcao/resgatar', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const { premioId } = await pedido.json();
  const premio = await env.DB.prepare(
    `SELECT p.*, c.negocio_id FROM premios p JOIN cartoes c ON c.id = p.cartao_id WHERE p.id = ?`
  ).bind(premioId).first();
  if (!premio) throw new Falha('Prémio não encontrado', { estado: 404 });
  if (premio.negocio_id !== op.negocio_id) throw new Falha('Prémio de outro negócio', { estado: 403 });
  if (premio.resgatado_em) throw new Falha('Este prémio já foi entregue.', { estado: 409, codigo: 'ja-resgatado' });

  await env.DB.batch([
    env.DB.prepare('UPDATE premios SET resgatado_em = ?, resgatado_por = ? WHERE id = ?')
      .bind(agora(), op.nome, premioId),
    env.DB.prepare('INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), premio.cartao_id, 'resgate', premio.descricao, op.nome, agora()),
  ]);
  const c = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(premio.cartao_id).first();
  return { premio: { id: premioId, resgatadoEm: agora() }, cartao: await moldarCartao(env, c) };
});

rota('POST', '/v1/balcao/anular', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const { movimentoId } = await pedido.json();
  const m = await env.DB.prepare(
    `SELECT m.*, c.negocio_id, c.programa_id FROM movimentos m
       JOIN cartoes c ON c.id = m.cartao_id WHERE m.id = ?`
  ).bind(movimentoId).first();
  if (!m) throw new Falha('Movimento não encontrado', { estado: 404 });
  if (m.negocio_id !== op.negocio_id) throw new Falha('Movimento de outro negócio', { estado: 403 });
  /* Dois minutos. Passado isso o cliente já foi embora e anular passa a ser
     uma forma de tirar carimbos a quem não está a ver. */
  if (Date.now() - new Date(m.em).getTime() > 120000) {
    throw new Falha('Já passaram mais de 2 minutos — não dá para anular.',
      { estado: 409, codigo: 'tarde' });
  }
  const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(m.cartao_id).first();
  const p = await programaCompleto(env, m.programa_id);

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
  instrucoes.push(
    env.DB.prepare('UPDATE cartoes SET carimbos = ?, pontos = ?, total_carimbos = ?, premios_ganhos = ? WHERE id = ?')
      .bind(carimbos, pontos, total, ganhos, cartao.id),
    env.DB.prepare('DELETE FROM movimentos WHERE id = ?').bind(movimentoId),
    env.DB.prepare('INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), cartao.id, 'anulado', 'Movimento anulado', op.nome, agora()),
  );
  await env.DB.batch(instrucoes);
  const atualizado = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartao.id).first();
  return { cartao: await moldarCartao(env, atualizado) };
});

rota('GET', '/v1/balcao/clientes', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const linhas = (await env.DB.prepare(
    `SELECT c.*, cl.publico, p.objetivo, p.tipo,
            (SELECT COUNT(*) FROM premios pr WHERE pr.cartao_id = c.id AND pr.resgatado_em IS NULL) AS por_resgatar
       FROM cartoes c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN programas p ON p.id = c.programa_id
      WHERE c.negocio_id = ?
      ORDER BY COALESCE(c.ultimo_em, c.aderiu_em) DESC
      LIMIT 300`
  ).bind(op.negocio_id).all()).results;
  return linhas.map((c) => ({
    publico: c.publico, carimbos: c.carimbos, pontos: c.pontos,
    objetivo: c.objetivo, tipo: c.tipo,
    ultimoEm: c.ultimo_em, aderiuEm: c.aderiu_em, porResgatar: c.por_resgatar,
  }));
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
  async fetch(pedido, env) {
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
        if (typeof r.padrao === 'string') {
          if (r.padrao !== caminho) continue;
          return json(await r.mao(env, pedido, []), { pedido, env });
        }
        const m = caminho.match(r.padrao);
        if (!m) continue;
        return json(await r.mao(env, pedido, m.slice(1)), { pedido, env });
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
    const ontem = new Date(Date.now() - 86400000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM codigos_usados WHERE usado_em < ?').bind(ontem),
      env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()),
      env.DB.prepare('DELETE FROM entradas WHERE expira_em < ?').bind(agora()),
    ]);
  },
};
