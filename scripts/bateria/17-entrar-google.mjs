/* =========================================================================
   Bateria · 17 — Entrar com a Google

   A porta nova. O que aqui se persegue não é «o botão aparece»: é o que esta
   funcionalidade tem de caro, que são três coisas.

   · A JANELA ERRADA. A volta da Google traz um código na barra de endereço, e
     se a app o aceitasse de qualquer janela bastava mandar a alguém o endereço
     da IDA para lhe levar a conta — o `state`, o PKCE e o `nonce` não defendem
     disso, porque são todos do lado de quem começa. O que defende é o BILHETE,
     que vive no armazenamento local de quem pediu. Prova-se aqui: com bilhete
     entra, sem bilhete não entra e diz porquê.

   · O PERFIL A MENTIR. A app decidia tudo por `cliente.email`, e quem entra
     pela Google não tem email nenhum guardado — de propósito, porque a morada
     que a Google mostra é pista e não pode decidir de quem é a conta. Com a
     pergunta errada, o perfil dizia «Guardar a conta» a quem tinha acabado de
     a guardar, e escondia o botão de segurança a quem tinha por onde voltar.

   · RETIRAR TEM DE SER TÃO FÁCIL COMO DAR (art. 7.º/3 do RGPD). Ligar é um
     toque; desligar tem de ser um toque.

   Corre em modo de demonstração, onde não há Google nenhuma do outro lado: a
   demonstração finge o caminho todo sem sair do site, e diz que o está a
   fingir. O que ela NÃO prova é a troca com a Google a sério — isso prova-se
   no `worker/testes.mjs`, contra a Google de mentira.
   ========================================================================= */

import { passarBoasVindas } from './01-arranque.mjs';

export const nome = '17 · Entrar com a Google';

const PERFIL = '.barra-item:nth-child(5)';
const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';
const BOTAO_GOOGLE = '#painel .btn-google';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** O que está no armazenamento da demonstração, já lido de volta. */
async function guardado(palco, chave) {
  return palco.js(`
    const v = localStorage.getItem('carimbo-demo:${chave}');
    return v === null ? null : JSON.parse(v)`);
}

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item');

  /* --- 1. A PORTA APARECE ONDE FOI PROMETIDA --------------------------- */
  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('Guardar a conta'),
    'antes de entrar, o perfil diz «Guardar a conta»', await palco.texto(LINHA_CONTA));

  await palco.clicar(LINHA_CONTA);
  await palco.esperar(BOTAO_GOOGLE);
  certo(await palco.visivel(BOTAO_GOOGLE),
    'o botão «Continuar com a Google» está à vista no painel de guardar a conta');
  certo((await palco.texto(BOTAO_GOOGLE)).includes('Google'),
    'e diz o que faz', await palco.texto(BOTAO_GOOGLE));
  certo(await palco.contar(`${BOTAO_GOOGLE} svg`) === 1,
    'com a marca da Google, que é a condição de uso do botão — e desenhada aqui, '
    + 'não carregada de lá');

  /* A ordem importa: a Google por cima, o email por baixo, e um «ou» a
     separar. Sem o separador, as duas formas leem-se como uma só em dois
     passos. */
  const yGoogle = (await palco.medir(BOTAO_GOOGLE)).y;
  const yEmail = (await palco.medir('#campo-email')).y;
  const ou = await palco.medir('#painel .ou');
  certo(yGoogle < yEmail, 'a Google vem por cima do email', `${yGoogle} vs ${yEmail}`);
  certo(Boolean(ou) && ou.y > yGoogle && ou.y < yEmail,
    'e há um «ou» entre as duas, a dizer que chega uma');
  certo((await palco.textoTodo()).includes('Não lhe pedimos o teu nome'),
    'o painel diz o que a Google fica a saber, ao lado do botão');

  /* O botão do email continua a ser o que o campo do código submete. Se o da
     Google entrasse como `.btn-cheio` acima dele, o preenchimento automático
     dos seis algarismos passava a carregar na Google. */
  certo(!(await palco.js(`
    const b = document.querySelector('#painel .btn-google');
    return b ? b.classList.contains('btn-cheio') : false`)),
    'e o botão da Google NÃO é `.btn-cheio` — esse seletor é o do email, e é por '
    + 'posição que o código de seis algarismos se confirma sozinho');

  /* --- 2. ENTRAR ------------------------------------------------------- */
  await palco.clicar(BOTAO_GOOGLE);
  await palco.esperarTexto('demonstração não há Google a sério');
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('A conta está guardada'),
    'depois de entrar, o perfil deixa de pedir para guardar a conta',
    await palco.texto(LINHA_CONTA));
  certo((await palco.textoTodo()).includes('Terminar sessão nos outros aparelhos'),
    'e o botão de segurança aparece a quem tem por onde voltar a entrar — '
    + 'estava fechado atrás de «tens email?»');

  /* --- 3. RETIRAR É TÃO FÁCIL COMO DAR --------------------------------- */
  certo((await palco.textoTodo()).includes('Desligar a conta Google'),
    'há por onde desligar a conta Google (art. 7.º/3 do RGPD)');

  const linhaDesligar = await palco.js(`
    const l = [...document.querySelectorAll('#principal .linha')]
      .find((n) => n.textContent.includes('Desligar a conta Google'));
    if (!l) return null;
    l.setAttribute('data-prova', 'desligar');
    return true`);
  certo(linhaDesligar === true, 'e essa linha existe mesmo, para lhe podermos tocar');
  await palco.clicar('[data-prova="desligar"]');
  await palco.esperar('#painel .btn-perigo');
  certo((await palco.textoTodo()).includes('Os cartões e os carimbos ficam todos'),
    'o painel diz o que se perde ANTES — e o que se perde é só a forma de entrar');
  await palco.clicar('#painel .btn-perigo');
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('Guardar a conta'),
    'desligada a Google, o perfil volta a oferecer guardar a conta',
    await palco.texto(LINHA_CONTA));
  certo(!(await palco.textoTodo()).includes('Desligar a conta Google'),
    'e a linha de desligar desaparece, que já não tem o que desligar');

  /* --- 4. A VOLTA QUE ATERRA NA JANELA ERRADA -------------------------- */
  /* É o caminho do ataque, e o que o fecha é o bilhete. Chega-se aqui com um
     código na barra de endereço e sem bilhete guardado: pode ser um iPhone
     antigo a abrir a ligação no Safari em vez de dentro da app, ou pode ser
     alguém a mandar-nos este endereço. Nos dois casos, não se conclui nada. */
  await palco.ir('/app/?code=um-codigo-qualquer&state=um-estado-qualquer');
  await palco.esperarTexto('A entrada não ficou feita');
  certo((await palco.textoTodo()).includes('não é a mesma onde começaste'),
    'sem bilhete, a app NÃO conclui a entrada — e explica porquê');
  certo((await palco.textoTodo()).includes('Voltar à app'),
    'e dá caminho para a frente, em vez de um beco');
  certo(!(await palco.js('return location.search.includes("code=")')),
    'e o código sai da barra de endereço logo — não fica no histórico do telemóvel');

  /* --- 5. A VOLTA NA JANELA CERTA -------------------------------------- */
  await palco.js(`localStorage.setItem('carimbo-demo:entrada-google',
    JSON.stringify({ bilhete: 'bilhete-de-demonstracao', em: Date.now() }))`);
  await palco.ir('/app/?code=um-codigo-qualquer&state=um-estado-qualquer');
  await palco.esperar('#barra .barra-item');
  certo(!(await palco.textoTodo()).includes('A entrada não ficou feita'),
    'com o bilhete no sítio, a volta conclui-se');
  certo(await guardado(palco, 'entrada-google') === null,
    'e o bilhete é gasto: não fica lá para servir outra vez');

  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('A conta está guardada'),
    'e a conta ficou guardada pela Google', await palco.texto(LINHA_CONTA));

  /* --- 6. O QUE FICA PARA TRÁS DEPOIS DE APAGAR ------------------------ */
  const chaves = await palco.js(`return Object.keys(localStorage)`);
  certo(!chaves.some((k) => k.includes('entrada-google')),
    'não sobra bilhete nenhum no armazenamento depois de a entrada estar feita',
    JSON.stringify(chaves));

  /* --- 7. NUM ECRÃ ESTREITO ------------------------------------------- */
  await palco.tamanho(320, 640);
  await palco.clicar(LINHA_CONTA);
  await palco.esperar(BOTAO_GOOGLE);
  const caixa = await palco.medir(BOTAO_GOOGLE);
  certo(caixa.largura > 200 && caixa.altura >= 44,
    'a 320 px o botão continua inteiro e tocável', JSON.stringify(caixa));
  certo(await palco.visivel(BOTAO_GOOGLE), 'e continua à vista, sem nada por cima');
  await dormir(50);
}
