#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — bateria do Worker

   Corre contra um `wrangler dev --local` já a andar. Não testa só o caminho
   feliz: a maior parte destes casos é gente a tentar carimbar-se a si
   própria. Um cartão de fidelidade sem estas regras é um cartão que se
   fotografa e se manda aos amigos.

   Uso:  node worker/testes.mjs [http://localhost:8787]
   ========================================================================= */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://localhost:8787';

let passou = 0, falhou = 0;
const falhas = [];

function certo(condicao, descricao, detalhe = '') {
  if (condicao) { passou++; console.log(`  ✓ ${descricao}`); }
  else { falhou++; falhas.push(descricao); console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function grupo(nome) { console.log(`\n${nome}`); }

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Um pedido à API, com uma segunda tentativa quando a ligação cai.
 *
 * Não é indulgência com defeitos: é que `wrangler d1 execute --local` — que
 * é como estes testes preparam o estado — faz o `wrangler dev` reiniciar, e
 * o pedido que apanhar essa janela leva com um ECONNRESET que não tem nada a
 * ver com o código que se está a provar. Uma segunda tentativa distingue as
 * duas coisas: um defeito a sério falha as duas vezes.
 */
async function pedir(caminho, opcoes = {}) {
  try {
    return await pedirUmaVez(caminho, opcoes);
  } catch (erro) {
    if (!/fetch failed|ECONNRESET|ECONNREFUSED/.test(String(erro))) throw erro;
    await dormir(1500);
    return pedirUmaVez(caminho, opcoes);
  }
}

async function pedirUmaVez(caminho, { metodo = 'GET', corpo, sessao } = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(sessao ? { authorization: `Bearer ${sessao}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let dados = null;
  const texto = await r.text();
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { cru: texto }; }
  return { estado: r.status, dados };
}

function sql(instrucao) {
  return execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
    '--local', '--command', instrucao], { cwd: AQUI, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const JANELA = 15;
function codigoPara(publico, segredo, deslocamento = 0) {
  const janela = Math.floor(Date.now() / 1000 / JANELA) + deslocamento;
  const mac = createHmac('sha256', deB64url(segredo)).update(`${publico}.${janela}`).digest('hex').slice(0, 16);
  return `C1.${publico}.${janela}.${mac}`;
}

/* --------------------------------------------------------------------- */

grupo('Saúde');
{
  const r = await pedir('/v1/saude');
  certo(r.estado === 200 && r.dados.bem, 'o Worker responde', JSON.stringify(r.dados));
}

grupo('Registo do cliente');
let cliente, segredo, sessaoCliente;
{
  const r = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  cliente = r.dados.cliente; segredo = r.dados.segredo; sessaoCliente = r.dados.sessao;
  certo(r.estado === 200, 'regista sem pedir nada');
  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(cliente.publico),
    'o número do cartão não tem letras que se confundam', cliente.publico);
  certo(!!segredo && segredo.length > 20, 'devolve o segredo do dispositivo');
  certo(cliente.email === null, 'não guarda email nenhum à partida');

  const outro = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  certo(outro.dados.cliente.publico !== cliente.publico, 'dois clientes têm números diferentes');
  certo(outro.dados.segredo !== segredo, 'e segredos diferentes');
}

grupo('Sessão do balcão');
let sessaoBalcao;
{
  /* Simula-se o que o email faria: mete-se o código na base de dados e
     troca-se por uma sessão. */
  const correio = 'teste@exemplo.pt';
  const codigo = '314159';
  const resumo = createHash('sha256').update(`${correio}|${codigo}`).digest('hex');
  const expira = new Date(Date.now() + 600000).toISOString();
  sql(`DELETE FROM entradas`);
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${resumo}', 'operador:o1', '${correio}', datetime('now'), '${expira}')`);

  const r = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo } });
  sessaoBalcao = r.dados.sessao;
  certo(r.estado === 200 && !!sessaoBalcao, 'troca o código por uma sessão',
    JSON.stringify(r.dados).slice(0, 120));

  const outra = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo } });
  certo(outra.estado === 401, 'o mesmo código não serve duas vezes', String(outra.estado));

  /* Cinco enganos e o código morre — é isto que impede que se tentem um
     milhão de hipóteses num código de seis algarismos. */
  const resumo2 = createHash('sha256').update(`bruta@exemplo.pt|424242`).digest('hex');
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${resumo2}', 'operador:o1', 'bruta@exemplo.pt', datetime('now'), '${expira}')`);
  for (let i = 0; i < 5; i++) {
    await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: 'bruta@exemplo.pt', codigo: '000000' } });
  }
  const morto = await pedir('/v1/balcao/sessao', {
    metodo: 'POST', corpo: { email: 'bruta@exemplo.pt', codigo: '424242' } });
  certo(morto.estado === 401, 'ao fim de cinco enganos o código certo já não vale',
    String(morto.estado));

  const curto = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo: '12' } });
  certo(curto.estado === 400, 'um código com menos de seis algarismos é recusado logo');

  const semSessao = await pedir('/v1/balcao/resumo');
  certo(semSessao.estado === 401, 'sem sessão não se vê nada');

  const comSessaoDeCliente = await pedir('/v1/balcao/resumo', { sessao: sessaoCliente });
  certo(comSessaoDeCliente.estado === 401, 'a sessão de um cliente não abre o balcão');
}

grupo('Carimbar');
{
  const r = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo), programaId: 'p1' },
  });
  certo(r.estado === 200, 'carimba', JSON.stringify(r.dados).slice(0, 120));
  certo(r.dados.cartao?.carimbos === 1, 'fica com 1 carimbo');
  certo(r.dados.novo === true, 'cria o cartão à primeira, sem adesão nenhuma');
  certo(r.dados.cartao?.programa?.objetivo === 10, 'traz o programa junto');
}

grupo('Defesas');
{
  /* Arrefecimento a zero para este grupo: senão o que recusa o segundo
     carimbo é a espera obrigatória e não a repetição, e o teste passava
     sem provar nada. */
  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
  const codigo = codigoPara(cliente.publico, segredo, -2);
  await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo, programaId: 'p1' } });
  const repetido = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo, programaId: 'p1' } });
  certo(repetido.estado === 409 && repetido.dados.codigo === 'repetido',
    'o mesmo código não passa duas vezes', `${repetido.estado} ${repetido.dados.codigo}`);

  const velho = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, -10), programaId: 'p1' } });
  certo(velho.dados.codigo === 'expirado', 'um código de há dois minutos já não vale',
    JSON.stringify(velho.dados));

  const futuro = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, +10), programaId: 'p1' } });
  certo(futuro.dados.codigo === 'expirado', 'nem um código do futuro');

  const forjado = codigoPara(cliente.publico, b64url(randomBytes(32)));
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: forjado, programaId: 'p1' } });
  certo(r.estado === 403 && r.dados.codigo === 'assinatura',
    'um código assinado com outro segredo é recusado', JSON.stringify(r.dados));

  /* Troca-se o último dígito por outro qualquer, mas garantidamente
     diferente: substituir sempre por 'f' não mudava nada nas vezes em que o
     dígito já era 'f', e o teste passava a falhar de vez em quando sem razão
     aparente. */
  const original = codigoPara(cliente.publico, segredo);
  const ultimo = original.slice(-1);
  const trocado = original.slice(0, -1) + (ultimo === 'f' ? '0' : 'f');
  const r2 = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: trocado, programaId: 'p1' } });
  certo(r2.estado === 403 || r2.dados.codigo === 'assinatura',
    'mudar um dígito da assinatura chega para o código não valer');

  const lixo = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: 'https://exemplo.pt', programaId: 'p1' } });
  certo(lixo.dados.codigo === 'formato', 'um QR de outra coisa qualquer é recusado com jeito');

  const inexistente = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: 'M1.ZZZZZZ', programaId: 'p1' } });
  certo(inexistente.dados.codigo === 'sem-cliente', 'um número que não existe dá erro claro');
}

grupo('Arrefecimento');
{
  sql(`UPDATE programas SET arrefecimento = 3600 WHERE id = 'p1'`);
  /* Janela -1: ainda dentro da tolerância, mas é um código que nunca foi
     usado — senão o que dispara primeiro é a repetição e não se testa nada. */
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, -1), programaId: 'p1' } });
  certo(r.estado === 429 && r.dados.codigo === 'arrefecimento',
    'não deixa carimbar duas vezes seguidas', JSON.stringify(r.dados));
  certo(typeof r.dados.faltam === 'number', 'e diz quanto falta esperar');
}

grupo('Prémio');
let premioId, cartaoId;
{
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  /* Para encher o cartão usa-se a entrada manual: um código assinado só vale
     dentro de duas janelas de 15 s, e inventar janelas futuras é exactamente
     o que o servidor recusa (e bem).
     Carimba-se até completar em vez de contar à mão — assim o teste não se
     parte de cada vez que se mexe no número de carimbos do programa. */
  let ultimo, voltas = 0;
  do {
    ultimo = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
    voltas++;
  } while (ultimo.estado === 200 && !ultimo.dados.ganhos?.length && voltas < 20);
  certo(ultimo.estado === 200, 'chega aos dez carimbos', JSON.stringify(ultimo.dados).slice(0, 140));
  certo(ultimo.dados.ganhos?.length === 1, 'e ganha um prémio');
  certo(ultimo.dados.cartao?.carimbos === 0, 'o cartão recomeça a zero');
  certo(ultimo.dados.cartao?.porResgatar === 1, 'com o prémio à espera');
  premioId = ultimo.dados.ganhos?.[0]?.id;
  cartaoId = ultimo.dados.cartao?.id;
}

grupo('Anular');
{
  const antes = await pedir(`/v1/cliente/cartoes/${cartaoId}`, { sessao: sessaoCliente });
  const movimento = antes.dados.movimentos.find((m) => m.tipo === 'carimbo');
  const r = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento.id } });
  certo(r.estado === 200, 'anula o carimbo que se acabou de dar');
  certo(r.dados.cartao.carimbos === 9, 'o cartão volta a nove de dez',
    String(r.dados.cartao.carimbos));
  certo(r.dados.cartao.porResgatar === 0, 'e o prémio desaparece com ele');

  const outraVez = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento.id } });
  certo(outraVez.estado === 404, 'não se anula duas vezes o mesmo movimento');
}

grupo('Resgatar');
{
  let r, voltas = 0;
  do {
    r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
    voltas++;
  } while (r.estado === 200 && !r.dados.ganhos?.length && voltas < 20);
  const premio = r.dados.ganhos?.[0];
  certo(!!premio, 'volta a completar o cartão', JSON.stringify(r.dados).slice(0, 120));
  if (!premio) { console.log('\n(sem prémio — o resto do grupo não corre)'); }
  else {

  const entrega = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio.id } });
  certo(entrega.estado === 200, 'entrega o prémio');
  certo(entrega.dados.cartao.porResgatar === 0, 'e deixa de estar à espera');

  const outra = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio.id } });
  certo(outra.estado === 409, 'o mesmo prémio não se entrega duas vezes');
  }
}

grupo('Entrada manual');
{
  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
  certo(r.estado === 200, 'aceita o número escrito à mão');
  certo(r.dados.manual === true, 'e marca-o como manual, para ficar no histórico');
}

grupo('Tecto diário');
{
  sql(`UPDATE programas SET maximo_diario = 1 WHERE id = 'p1'`);
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
  certo(r.estado === 429 && r.dados.codigo === 'maximo-diario',
    'o tecto diário trava', JSON.stringify(r.dados));
  sql(`UPDATE programas SET maximo_diario = 0 WHERE id = 'p1'`);
}

grupo('O que o cliente vê');
{
  const r = await pedir('/v1/cliente/cartoes', { sessao: sessaoCliente });
  certo(r.estado === 200 && r.dados.length === 1, 'vê o seu cartão');
  certo(r.dados[0].negocio.nome === 'O Meu Café', 'com o nome do negócio');
  certo(r.dados[0].programa.selo === 'chavena', 'e o desenho do carimbo');

  const alheio = await pedir(`/v1/cliente/cartoes/${cartaoId}`);
  certo(alheio.estado === 401, 'sem sessão não vê cartão nenhum');
}

grupo('Descobrir');
{
  const r = await pedir('/v1/descobrir');
  certo(r.estado === 200 && r.dados.length >= 1, 'lista os negócios');
  certo(!!r.dados[0].programas?.length, 'com os programas de cada um');
  const p = await pedir('/v1/p/o-meu-cafe');
  certo(p.estado === 200 && p.dados.nome === 'O Meu Café', 'a página pública do negócio existe');
}

grupo('RGPD');
{
  const dados = await pedir('/v1/cliente/dados', { sessao: sessaoCliente });
  certo(dados.estado === 200 && !!dados.dados.cliente, 'exporta tudo o que temos');
  certo(Array.isArray(dados.dados.movimentos) && dados.dados.movimentos.length > 0,
    'incluindo o histórico');

  const apagar = await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoCliente });
  certo(apagar.estado === 200 && apagar.dados.apagado, 'apaga a conta');

  const depois = await pedir('/v1/cliente/cartoes', { sessao: sessaoCliente });
  certo(depois.estado === 401, 'e a sessão morre com ela');

  const orfaos = sql(`SELECT COUNT(*) AS n FROM cartoes WHERE cliente_id = '${cliente.id}'`);
  certo(/"n":\s*0/.test(orfaos), 'não ficam cartões órfãos na base de dados');
}

grupo('Entregar e anular: o que o café não pode perder duas vezes');
{
  /* Um cliente próprio, para não estragar o estado dos grupos acima. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: 'p1' } });

  const carimbar = () => pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${c.dados.cliente.publico}`, programaId: 'p1' } });

  let r, voltas = 0;
  do { r = await carimbar(); voltas++; } while (r.estado === 200 && !r.dados.ganhos?.length && voltas < 25);
  certo(r.dados?.ganhos?.length === 1, 'enche-se o cartão e sai um prémio',
    JSON.stringify(r.dados?.ganhos?.length));
  const premio = r.dados.ganhos[0].id;
  const movimento = r.dados.movimentoId;

  /* --- entregar duas vezes ---------------------------------------------- */
  const uma = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio, operador: 'Balcão' } });
  certo(uma.estado === 200, 'o prémio entrega-se', String(uma.estado));
  const outra = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio, operador: 'Balcão' } });
  certo(outra.estado === 409, 'e não se entrega uma segunda vez', String(outra.estado));

  const historico = sql(`SELECT COUNT(*) AS n FROM movimentos
                          WHERE tipo = 'resgate' AND cartao_id = '${r.dados.cartao.id}'`);
  certo(/"n":\s*1/.test(historico), 'e fica um resgate no histórico, não dois', historico.slice(0, 90));

  /* --- anular por cima de um prémio já entregue -------------------------- */
  const tarde = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento } });
  certo(tarde.estado === 409,
    'não se anula o carimbo que deu um prémio que já saiu pela porta', String(tarde.estado));
  certo(/premio-entregue/.test(JSON.stringify(tarde.dados)),
    'e diz-se porquê', JSON.stringify(tarde.dados));

  /* --- anular o que não é carimbo --------------------------------------- */
  const adesao = sql(`SELECT id FROM movimentos WHERE cartao_id = '${r.dados.cartao.id}'
                       AND tipo = 'adesao' LIMIT 1`);
  const idAdesao = (adesao.match(/"id":\s*"([^"]+)"/) || [])[1];
  if (idAdesao) {
    const nao = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { movimentoId: idAdesao } });
    certo(nao.estado === 400, 'nem a adesão de um cliente se anula', String(nao.estado));
    const aindaLa = sql(`SELECT COUNT(*) AS n FROM movimentos WHERE id = '${idAdesao}'`);
    certo(/"n":\s*1/.test(aindaLa), 'e ela continua no histórico', aindaLa.slice(0, 80));
  }

  /* --- um id em falta é um pedido mal feito, não uma avaria ------------- */
  for (const [rota, corpo] of [
    ['/v1/balcao/anular', {}],
    ['/v1/balcao/resgatar', {}],
  ]) {
    const mau = await pedir(rota, { metodo: 'POST', sessao: sessaoBalcao, corpo });
    certo(mau.estado === 400, `${rota} sem id dá 400, não 500`, String(mau.estado));
  }

  /* --- anular repõe o relógio do arrefecimento --------------------------- */
  /* O cenário verdadeiro: o balcão carimba o cliente errado e anula logo a
     seguir. Precisa de um cartão limpo, porque num cartão com carimbos de há
     dez segundos o arrefecimento continua a bloquear — e bem: repor o relógio
     é pô-lo no carimbo ANTERIOR, não deitá-lo fora.

     O que estava partido era isso mesmo: o `ultimo_em` ficava com a marca do
     carimbo anulado, que já não existe em lado nenhum. Um cartão acabado de
     estrear ficava uma hora fechado por causa de um engano de dois segundos. */
  sql(`UPDATE programas SET arrefecimento = 3600 WHERE id = 'p1'`);
  const enganado = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: enganado.dados.sessao,
    corpo: { programaId: 'p1' } });
  const carimbarEnganado = () => pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${enganado.dados.cliente.publico}`, programaId: 'p1' } });

  const engano = await carimbarEnganado();
  certo(engano.estado === 200, 'carimba-se o cliente errado', String(engano.estado));
  const travado = await carimbarEnganado();
  certo(travado.estado === 429, 'e o arrefecimento tranca o cartão', String(travado.estado));

  const desfeito = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: engano.dados.movimentoId } });
  certo(desfeito.estado === 200, 'anula-se', JSON.stringify(desfeito.dados).slice(0, 100));

  const outraVez = await carimbarEnganado();
  certo(outraVez.estado === 200,
    'e o cartão volta a aceitar carimbo — não fica uma hora fechado por um engano',
    JSON.stringify(outraVez.dados).slice(0, 140));

  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
}

grupo('Rotas do balcão que nunca tinham sido tocadas');
{
  /* Sete das vinte e duas rotas não tinham teste nenhum. Estas são as que
     um dono de café usa no primeiro dia: fundar, ver o negócio, mudar o
     cartão, e ver quem lá anda. */
  const correio = `dono-${Date.now()}@exemplo.pt`;
  const f = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Padaria da Sonda', email: correio, objetivo: 8 } });
  certo(f.estado === 200 && !!f.dados.sessao, 'fundar devolve sessão logo',
    JSON.stringify(f.dados).slice(0, 120));
  /* Sem sessão não há nada a fazer aqui — e continuar rebentava com um
     TypeError que levava a bateria inteira à frente, escondendo os grupos
     que vêm a seguir. Uma falha de configuração tem de reprovar um grupo,
     não matar a corrida. */
  const S = f.dados && f.dados.sessao;
  if (!S) {
    certo(false, 'sem sessão de fundador, o resto deste grupo não pode correr',
      'falta CODIGO_FUNDADOR em worker/.dev.vars?');
  } else {

  /* Sem isto, fundar duas vezes com o mesmo email deixava o segundo negócio
     sem forma de entrar: a procura do operador devolve sempre o primeiro. */
  const outra = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Outra Padaria', email: correio } });
  certo(outra.estado === 409, 'o mesmo email não funda um segundo negócio', String(outra.estado));

  const convite = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'errado', nome: 'X', email: 'x@exemplo.pt' } });
  certo(convite.estado === 403, 'sem o convite certo não se funda nada', String(convite.estado));

  const neg = await pedir('/v1/balcao/negocio', { sessao: S });
  certo(neg.estado === 200 && neg.dados.negocio.nome === 'Padaria da Sonda',
    'o balcão lê o seu negócio', JSON.stringify(neg.dados?.negocio?.nome));
  certo(neg.dados.negocio.programas[0].objetivo === 8,
    'com o objectivo que foi pedido', String(neg.dados?.negocio?.programas?.[0]?.objetivo));

  /* --- o que entra no negócio ------------------------------------------- */
  const longo = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { nome: 'A'.repeat(5000) } });
  certo(longo.estado === 200 && longo.dados.nome.length <= 60,
    'um nome de cinco mil caracteres é cortado, não guardado',
    `ficou com ${longo.dados?.nome?.length}`);

  const corMa = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { cor: 'javascript:alert(1)' } });
  certo(corMa.estado === 400, 'uma cor que não é hexadecimal é recusada', String(corMa.estado));

  const corBoa = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { cor: '#3B2417', nome: 'Padaria da Sonda' } });
  certo(corBoa.estado === 200 && corBoa.dados.cor === '#3B2417',
    'uma cor válida entra', JSON.stringify(corBoa.dados?.cor));

  /* --- o que entra no programa ------------------------------------------ */
  const PROG = neg.dados.negocio.programas[0].id;
  const lixo = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
    corpo: { id: PROG, arrefecimento: 'abc' } });
  certo(Number.isFinite(lixo.dados?.[0]?.arrefecimento),
    'arrefecimento com lixo não vira NaN na base de dados',
    JSON.stringify(lixo.dados?.[0]?.arrefecimento));

  const alto = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
    corpo: { id: PROG, objetivo: 999 } });
  certo(alto.dados?.[0]?.objetivo === 30, 'o objectivo é limitado a 30',
    String(alto.dados?.[0]?.objetivo));
  /* Zero não vira 2, vira 10: o `Number(x) || 10` do Worker lê o zero como
     «não veio nada» e usa o valor por omissão. Não é bonito, mas o que
     importa aqui é o que chega à base de dados, e nenhum destes valores
     absurdos lá entra. Que o formulário do balcão devia recusar isto antes
     de enviar é outro assunto, e está tratado no lado do cliente. */
  for (const mau of [0, -5, 999, 'abc', null, 3.7, '7', Infinity]) {
    const r = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
      corpo: { id: PROG, objetivo: mau } });
    const o = r.dados?.[0]?.objetivo;
    certo(Number.isInteger(o) && o >= 2 && o <= 30,
      `objectivo ${JSON.stringify(mau)} acaba dentro de 2..30`, String(o));
  }

  /* --- cada balcão vê só o que é seu ------------------------------------ */
  const f2 = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Barbearia da Sonda', email: `outro-${Date.now()}@exemplo.pt` } });
  const meus = await pedir('/v1/balcao/clientes', { sessao: S });
  const alheios = await pedir('/v1/balcao/clientes', { sessao: f2.dados.sessao });
  certo(meus.estado === 200 && Array.isArray(meus.dados), 'a lista de clientes responde');
  certo(alheios.dados.length === 0,
    'um negócio acabado de fundar não vê clientes de outro',
    `viu ${alheios.dados?.length}`);

  const alheio = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: f2.dados.sessao,
    corpo: { nome: 'Roubado' } });
  const conferir = await pedir('/v1/balcao/negocio', { sessao: S });
  certo(conferir.dados.negocio.nome === 'Padaria da Sonda',
    'e não lhe consegue mudar o nome', JSON.stringify(conferir.dados?.negocio?.nome));

  /* --- uma sessão de cliente não serve no balcão ------------------------- */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  for (const rota of ['/v1/balcao/clientes', '/v1/balcao/negocio', '/v1/balcao/resumo']) {
    const r = await pedir(rota, { sessao: c.dados.sessao });
    certo(r.estado === 401 || r.estado === 403,
      `${rota} recusa uma sessão de cliente`, String(r.estado));
  }
  }
}

grupo('Aderir duas vezes ao mesmo programa');
{
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const prog = (await pedir('/v1/descobrir')).dados[0].programas[0].id;
  const um = await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: prog } });
  const dois = await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: prog } });
  certo(um.estado === 200 && dois.estado === 200, 'as duas adesões respondem bem');
  certo(um.dados.id === dois.dados.id, 'e devolvem o mesmo cartão, não dois');
  const cartoes = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(cartoes.dados.filter((x) => x.programa.id === prog).length === 1,
    'a carteira fica com um cartão só',
    String(cartoes.dados?.filter((x) => x.programa.id === prog).length));

  const inventado = await pedir('/v1/cliente/aderir', { metodo: 'POST',
    sessao: c.dados.sessao, corpo: { programaId: 'nao-existe' } });
  certo(inventado.estado === 404, 'um programa que não existe dá 404', String(inventado.estado));
}

grupo('Recuperar a conta noutro telemóvel');
{
  /* O defeito que isto tranca: a app prometia em três sítios que os cartões
     iam com a pessoa para o telemóvel novo, e não iam. O código era emitido
     sempre contra o cliente da sessão em curso — e no telemóvel novo esse é
     uma conta vazia acabada de criar. A pessoa confirmava, ouvia «os cartões
     já não se perdem», e ficava a olhar para uma carteira sem nada. */
  const correio = 'recupera@exemplo.pt';
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  sql(`UPDATE clientes SET email = NULL, email_verificado = 0 WHERE email = '${correio}'`);

  /* Telemóvel A: conta com um cartão, e a morada confirmada. */
  const a = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const sessaoA = a.dados.sessao;
  const prog = (await pedir('/v1/descobrir')).dados[0].programas[0].id;
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoA, corpo: { programaId: prog } });

  const pedirCodigo = async (sessao) => {
    sql(`DELETE FROM envios`);            /* o tecto por hora não é o que se testa aqui */
    const r = await pedir('/v1/cliente/email', { metodo: 'POST', sessao, corpo: { email: correio } });
    const linha = sql(`SELECT alvo FROM entradas WHERE email = '${correio}' AND usada_em IS NULL`);
    return { resposta: r, alvo: (linha.match(/"alvo":\s*"([^"]+)"/) || [])[1] };
  };

  const p1 = await pedirCodigo(sessaoA);
  certo(p1.resposta.estado === 200, 'A pede o código', JSON.stringify(p1.resposta.dados));
  certo(p1.resposta.dados.recuperar === false,
    'a primeira vez não é uma recuperação, é uma adesão', String(p1.resposta.dados.recuperar));
  certo(p1.alvo === `cliente:${a.dados.cliente.id}`,
    'o código aponta para a conta de A', String(p1.alvo));

  /* Confirma-se com um código forjado, que é o que o email faria chegar. */
  const forjar = (alvo, codigo) => {
    const r = createHash('sha256').update(`${correio}|${codigo}`).digest('hex');
    sql(`DELETE FROM entradas WHERE alvo = '${alvo}'`);
    sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
         VALUES ('${r}', '${alvo}', '${correio}', datetime('now'),
                 '${new Date(Date.now() + 600000).toISOString()}')`);
  };
  forjar(`cliente:${a.dados.cliente.id}`, '111111');
  const conf = await pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: correio, codigo: '111111' } });
  certo(conf.estado === 200 && conf.dados.cliente.id === a.dados.cliente.id,
    'A confirma a morada e continua a ser A', JSON.stringify(conf.dados?.cliente));
  certo(!!conf.dados.segredo && !!conf.dados.sessao,
    'a resposta traz o segredo e a sessão — é com isto que o telemóvel novo se levanta');

  /* Telemóvel B: conta nova e vazia, como a app faz ao arrancar. */
  const b = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  certo(b.dados.cliente.id !== a.dados.cliente.id, 'B é mesmo outra conta');

  const p2 = await pedirCodigo(b.dados.sessao);
  certo(p2.resposta.dados.recuperar === true,
    'B pede a mesma morada e o servidor reconhece uma recuperação',
    String(p2.resposta.dados.recuperar));
  certo(p2.alvo === `cliente:${a.dados.cliente.id}`,
    'e o código aponta para a conta ANTIGA, não para a vazia', String(p2.alvo));

  forjar(`cliente:${a.dados.cliente.id}`, '222222');
  const volta = await pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: correio, codigo: '222222' } });
  certo(volta.estado === 200 && volta.dados.cliente.id === a.dados.cliente.id,
    'B entra e recebe a conta de A', JSON.stringify(volta.dados?.cliente?.id));

  const cartoes = await pedir('/v1/cliente/cartoes', { sessao: volta.dados.sessao });
  certo(cartoes.estado === 200 && cartoes.dados.length >= 1,
    'e com ela os cartões', `${cartoes.dados?.length} cartões`);
  certo(volta.dados.segredo === conf.dados.segredo,
    'o segredo do aparelho é o mesmo — o QR de B vale tanto como o de A');
}

grupo('A morada não é sensível a maiúsculas');
{
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const r = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao,
    corpo: { email: '  Maiusculas@Exemplo.PT ' } });
  certo(r.estado === 200, 'aceita a morada com maiúsculas e espaços', JSON.stringify(r.dados));
  const guardado = sql(`SELECT email FROM entradas WHERE usada_em IS NULL`);
  certo(guardado.includes('maiusculas@exemplo.pt'),
    'guarda-a em minúsculas, que é como vai ser procurada', guardado.slice(0, 120));
}

grupo('Tecto de envios');
{
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const correio = 'tecto@exemplo.pt';
  const um = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(um.estado === 200, 'o primeiro pedido passa');

  const dois = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(dois.estado === 429, 'o segundo, logo a seguir, é recusado', String(dois.estado));

  /* Passado o intervalo mínimo, o tecto por hora continua a contar.

     A data escreve-se em ISO e não com o `datetime()` do SQLite: o código
     compara strings, e `2026-09-05 18:00` fica ANTES de `2026-09-05T17:00`
     porque o espaço vale menos do que o «T». Com o formato errado o teste
     passava a dizer que não havia tecto nenhum. */
  const hAtras = (m) => new Date(Date.now() - m * 60000).toISOString();
  sql(`UPDATE envios SET em = '${hAtras(10)}' WHERE email = '${correio}'`);
  for (let i = 0; i < 4; i++) {
    await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
    sql(`UPDATE envios SET em = '${hAtras(10)}' WHERE email = '${correio}'`);
  }
  const sexto = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(sexto.estado === 429, 'ao sexto na mesma hora, chega', String(sexto.estado));
  sql(`DELETE FROM envios`);
}

grupo('Corpo do pedido estragado');
{
  const casos = [
    ['/v1/cliente/registar', 'POST', 'isto não é json'],
    ['/v1/cliente/aderir', 'POST', '{"programaId":'],
    ['/v1/balcao/entrar', 'POST', '<html>'],
  ];
  for (const [caminho, metodo, corpo] of casos) {
    const r = await fetch(BASE + caminho, {
      method: metodo, headers: { 'content-type': 'application/json' }, body: corpo,
    });
    certo(r.status !== 500, `${caminho}: lixo no corpo não dá 500`, String(r.status));
  }
  /* Um corpo vazio é um objecto vazio, não um erro: /v1/cliente/registar não
     precisa de corpo nenhum e era chamado sem ele. */
  const vazio = await fetch(BASE + '/v1/cliente/registar', { method: 'POST' });
  certo(vazio.status === 200, 'um corpo vazio continua a servir para registar', String(vazio.status));
}

grupo('Emails');
{
  const { emailCodigoCliente, emailCodigoBalcao } = await import('./src/emails.js');

  const a = emailCodigoCliente({ codigo: '318204', minutos: 15 });
  certo(a.assunto.includes('318204'), 'o código vai no assunto');
  certo(a.html.includes('318&#160;204'), 'e no HTML, em dois grupos de três');
  certo(a.texto.includes('318204'), 'e na versão em texto');
  certo(a.html.includes('aria-label="3 1 8 2 0 4"'),
    'soletrado para quem ouve o email em vez de o ler');

  /* Estas três são cicatrizes. As duas primeiras deram email partido no
     Outlook — que desenha com o motor do Word e não sabe o que é rgba()
     nem letter-spacing em em. A terceira é o número de contribuinte de um
     particular, que não tem que andar a espalhar-se por caixas de correio
     alheias só porque coube no rodapé. */
  certo(!/rgba\(/.test(a.html), 'nenhum rgba() — o motor do Word desenha-o a preto');
  certo(!/letter-spacing:\s*[-.\d]+em/.test(a.html), 'espaçamento em px, que o Word lê');
  certo(!/\b273363620\b/.test(a.html + a.texto), 'o NIF não vai no email');

  /* A largura foi a segunda cicatriz: width="560" ganha ao max-width e o
     email transbordava do ecrã do telemóvel. */
  certo(a.html.includes('max-width:560px') && a.html.includes('[if mso]'),
    'largura fluida com tabela-fantasma para o Outlook');

  const b = emailCodigoBalcao({ codigo: '705193', negocio: '<script>x</script>' });
  certo(!b.html.includes('<script>'), 'o nome do negócio é escapado');
  certo(b.html.includes('&lt;script&gt;'), 'e chega escapado ao HTML');

  /* Um código com menos de seis algarismos não parte o agrupamento. */
  const c = emailCodigoCliente({ codigo: '1234' });
  certo(c.html.includes('>1234</div>'), 'um código curto sai inteiro, sem espaço a meio');

  for (const [nome, m] of [['cliente', a], ['balcão', b]]) {
    certo(m.texto.length > 100 && m.html.length > 1000,
      `${nome}: tem as duas versões, HTML e texto`);
  }
}

/* --------------------------------------------------------------------- */

console.log(`\n${passou} passaram, ${falhou} falharam.`);
if (falhou) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
