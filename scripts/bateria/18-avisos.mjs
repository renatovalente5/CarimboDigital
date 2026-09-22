/* =========================================================================
   Bateria · 18 — Avisar quando o cartão fica cheio

   O interruptor das notificações, e sobretudo o que ele NÃO faz.

   · NÃO APARECE ONDE NÃO PODE FUNCIONAR. São três condições — o servidor ter
     chave, o browser saber de notificações, e (num iPhone) a app estar no ecrã
     principal. Falhando uma, a linha SOME-SE em vez de ficar lá a explicar-se.
     Um interruptor que não liga nada é pior do que interruptor nenhum.

   · NÃO LIGA POR BAIXO. A folha de permissão é desenhada pelo sistema e só
     aparece a partir de um toque; nada disto pode acontecer num arranque.

   · NÃO PROMETE PUBLICIDADE. O painel diz, por escrito, que é um aviso só.

   Corre em modo de demonstração, onde não há serviço de push nenhum do outro
   lado — e o painel di-lo em vez de fingir. A cifra e o envio provam-se no
   `worker/testes.mjs`, contra um serviço de push de mentira e decifrando o que
   lá chega.
   ========================================================================= */

import { entrarNaApp } from './01-arranque.mjs';

export const nome = '18 · Avisar quando o cartão fica cheio';

const PERFIL = '.barra-item[data-ecra="perfil"]';
const LINHA_AVISOS = '#linha-avisos';

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await entrarNaApp(palco);
  await palco.esperar('#barra .barra-item');
  await palco.clicar(PERFIL);
  await palco.esperar('#principal .linha-perigo');

  /* --- 1. A LINHA EXISTE, E DIZ O ESTADO ------------------------------- */
  await palco.esperar(LINHA_AVISOS);
  /* ROLA-SE ATÉ LÁ ANTES DE PERGUNTAR SE SE VÊ. O perfil cresceu — a conta
     passou a dizer por onde se entrou — e esta linha desceu para baixo do
     bordo. «Não está no ecrã agora» não é «não está no perfil», e a pergunta
     que importa é a segunda. */
  await palco.js(`
    document.querySelector('${LINHA_AVISOS}')
      .scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;`);
  certo(await palco.visivel(LINHA_AVISOS),
    'a linha dos avisos está no perfil');
  const texto = await palco.texto(LINHA_AVISOS);
  certo(texto.includes('prémio'),
    'e diz para que serve — «quando ganhar um prémio», e não «notificações»', texto);
  certo(!texto.includes('A ver…'),
    'e já não está a dizer «A ver…»: o estado assenta depois de as perguntas terem resposta',
    texto);
  certo(/Desligadas|Ligadas|Bloqueadas/.test(texto),
    'e diz se estão ligadas neste telemóvel', texto);

  /* --- 2. O PAINEL PROMETE UMA COISA SÓ -------------------------------- */
  await palco.clicar(LINHA_AVISOS);
  await palco.esperar('#painel .btn-cheio, #painel .btn-perigo');
  const noPainel = await palco.textoTodo();
  certo(noPainel.includes('Não enviamos publicidade'),
    'o painel promete, por escrito, que não há publicidade');
  certo(noPainel.includes('cifrado'),
    'e diz que a mensagem vai cifrada — quem a transporta não a lê');
  certo(noPainel.includes('balcão'),
    'e explica porque é que o aviso faz falta: o carimbo é dado no aparelho do balcão');

  /* --- 3. NADA É PEDIDO SEM UM TOQUE ----------------------------------- */
  /* A permissão de notificações só pode ser pedida a partir de um gesto. Se
     alguma coisa a pedisse no arranque, o browser recusava-a de vez — e a
     partir daí a app ficava sem forma de voltar a perguntar, para sempre. */
  const pedidos = await palco.js(`
    return window.__pedidosDePermissao || 0`);
  certo(pedidos === 0 || pedidos === undefined,
    'nada pediu permissão antes de alguém carregar', String(pedidos));

  /* --- 4. NA DEMONSTRAÇÃO, DIZ QUE É UMA DEMONSTRAÇÃO ------------------ */
  await palco.clicar('#painel .btn-cheio, #painel .btn-perigo');
  await palco.esperarTexto('demonstração não sai aviso nenhum');
  certo((await palco.textoTodo()).includes('no telemóvel, avisamos-te'),
    'e diz o que aconteceria num telemóvel a sério, em vez de fingir que aconteceu');

  /* --- 5. E SOME-SE ONDE NÃO PODE FUNCIONAR ---------------------------- */
  /* Tira-se o `PushManager` de baixo dos pés — que é o que um iPhone faz no
     Safari normal, fora da app instalada — e recarrega-se. */
  await palco.js(`
    localStorage.setItem('carimbo-demo:sem-push-de-proposito', '1');
    return true`);
  /* APAGA-SE A PROPRIEDADE, e não se põe `undefined`: a pergunta que a app faz
     é `'PushManager' in window`, e uma propriedade que existe a valer
     `undefined` continua a responder que sim. Foi assim que este teste passou
     a primeira vez sem provar nada. */
  await palco.js(`delete window.PushManager; return 'PushManager' in window`);
  await palco.clicar('.barra-item[data-ecra="carteira"]');
  await palco.esperar('#principal');
  await palco.clicar(PERFIL);
  await palco.esperar('#principal .linha-perigo');
  await palco.js('await new Promise((r) => setTimeout(r, 400)); return true');
  certo(!(await palco.ver(LINHA_AVISOS)),
    'sem `PushManager` a linha desaparece — é o que um iPhone dá fora da app instalada');
  certo(!(await palco.textoTodo()).includes('Avisar-me quando'),
    'e não fica lá uma explicação a ocupar o ecrã');
}
