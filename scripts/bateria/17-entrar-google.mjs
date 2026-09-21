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

const PERFIL = '.barra-item[data-ecra="perfil"]';
const LINHA_CONTA = '#principal section:first-of-type .lista .linha:first-child';
const BOTAO_GOOGLE = '#painel .btn-google';
const BOTAO_APPLE = '#painel .btn-apple';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Marca o botão de uma porta para lhe podermos tocar.
 *
 * CHAMA-SE DE CADA VEZ, e não uma só: o painel da conta é repintado a cada
 * volta — depois de desligar, depois de cancelar — e um atributo posto no nó
 * antigo desaparece com ele. Marcar uma vez e clicar duas é esperar por um
 * elemento que já não existe.
 */
async function marcarPorta(palco, verbo, porta = null) {
  /* O `porta` faz falta desde que há três: «Desligar» aparece ao lado da
     Google E da Apple, e um `find` só pelo verbo apanha sempre a primeira. */
  return palco.js(`
    const linhas = [...document.querySelectorAll('#painel .linha-porta')];
    const so = ${JSON.stringify(porta)};
    const b = linhas
      .filter((l) => !so || l.textContent.includes(so))
      .flatMap((l) => [...l.querySelectorAll('.btn')])
      .find((n) => n.textContent.includes(${JSON.stringify(verbo)}));
    if (!b) return null;
    b.setAttribute('data-prova', 'porta');
    return true`);
}

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

  /* E a Apple, que chegou a seguir. As duas portas de provedor ficam juntas,
     por cima do «ou» — senão lê-se como se fossem três caminhos soltos. */
  const APPLE = '#painel .btn-apple';
  certo(await palco.visivel(APPLE), 'o botão «Continuar com a Apple» está à vista');
  const yApple = (await palco.medir(APPLE)).y;
  certo(yGoogle < yApple && yApple < yEmail,
    'e fica entre a Google e o email', `${yGoogle} < ${yApple} < ${yEmail}`);
  certo(Boolean(ou) && ou.y > yApple,
    'o «ou» fica por baixo das duas, e não entre elas');
  certo(await palco.contar(`${APPLE} svg`) === 1,
    'com a maçã da Apple, desenhada aqui e não carregada de lá');
  certo(Boolean(ou) && ou.y > yGoogle && ou.y < yEmail,
    'e há um «ou» entre as duas, a dizer que chega uma');
  certo(/pedimos o teu nome/.test(await palco.textoTodo()),
    'o painel diz o que o provedor fica a saber, ao lado dos botões');

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

  /* --- 3. «COM QUE CONTA É QUE EU ENTREI?» ----------------------------- */
  /* É a primeira pergunta que alguém faz depois de entrar, e não tinha
     resposta em lado nenhum: o perfil dizia que a conta estava guardada e
     ficava-se por aí. Agora o painel mostra a porta e a morada por onde ela
     entra. */
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#painel .linha-porta');
  certo((await palco.texto('#painel h2')) === 'Como entras nesta conta',
    'com uma porta ligada, o painel deixa de se chamar «Guardar a conta»',
    await palco.texto('#painel h2'));
  const portaGoogle = await palco.texto('#painel .linha-porta');
  certo(portaGoogle.includes('Google') && portaGoogle.includes('@'),
    'e mostra a conta Google com a morada por onde se entrou', portaGoogle);
  certo(await palco.contar('#painel .linha-porta') === 1,
    'só uma porta, que é só uma que está ligada',
    String(await palco.contar('#painel .linha-porta')));
  /* O `.seccao-titulo` é maiúsculas por CSS, e o `innerText` devolve o texto
     JÁ TRANSFORMADO — comparar com o que está escrito na fonte falha sem que
     nada esteja errado no ecrã. */
  certo((await palco.textoTodo()).toLowerCase().includes('juntar outra forma de entrar'),
    'e o que falta é oferecido por baixo, como o que falta e não como alternativa');
  /* O «ou» separa as portas de provedor do email. Com a Google já ligada,
     sobra a Apple — e o «ou» continua a fazer sentido, por baixo dela. Quando
     NÃO sobrar nenhuma, ele tem de desaparecer; isso prova-se na secção das
     duas portas, mais abaixo. */
  const ouAqui = await palco.medir('#painel .ou');
  const yApple2 = await palco.medir('#painel .btn-apple');
  certo(Boolean(ouAqui) && Boolean(yApple2) && ouAqui.y > yApple2.y,
    'e o «ou» fica por baixo da porta que falta, a separá-la do email');

  /* --- 4. RETIRAR É TÃO FÁCIL COMO DAR (art. 7.º/3 do RGPD) ------------ */
  /* O botão vive AO LADO da porta que desliga, e não numa linha solta do
     perfil: quem quer desligar uma conta vai ver qual é primeiro. */
  certo(await marcarPorta(palco, 'Desligar') === true,
    'a porta da Google tem um «Desligar» ao lado');
  await palco.clicar('[data-prova="porta"]');
  await palco.esperar('#painel .btn-perigo');
  certo((await palco.textoTodo()).includes('Os cartões e os carimbos ficam todos'),
    'o painel diz o que se perde ANTES — e o que se perde é só a forma de entrar');
  await palco.clicar('#painel .btn-perigo');

  /* E VOLTA-SE PARA ONDE SE VEIO. Mandar a pessoa para o perfil a meio de um
     gesto que ela começou no painel é fazê-la perder o lugar.

     O TÍTULO MUDA, e muda bem: esta era a ÚNICA porta, por isso o painel deixa
     de poder chamar-se «como entras» — já não se entra por lado nenhum — e
     volta a ser o de guardar a conta. Afirma-se o que interessa, que é o painel
     estar lá e oferecer outra vez o que se acabou de desligar. */
  await palco.esperar(BOTAO_GOOGLE);
  certo(await palco.visivel('#painel'), 'o painel da conta volta, em vez de nos largar no perfil');
  certo((await palco.texto('#painel h2')) === 'Guardar a conta',
    'e sem portas nenhumas volta a chamar-se «Guardar a conta»',
    await palco.texto('#painel h2'));
  certo(await palco.contar('#painel .linha-porta') === 0,
    'desligada a Google, a porta desaparece da lista',
    String(await palco.contar('#painel .linha-porta')));
  certo(await palco.visivel(BOTAO_GOOGLE),
    'e o painel volta a oferecê-la, no mesmo sítio onde ela estava');
  certo(!(await palco.textoTodo()).includes('null'),
    'e nada escreve «null» no ecrã — o `append` do browser não ignora filhos nulos '
    + 'como o `el()` desta casa ignora');

  await palco.tecla('Escape');
  await palco.sumir('#painel');
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('Guardar a conta'),
    'e o perfil por baixo repintou-se — não ficou com o texto velho',
    await palco.texto(LINHA_CONTA));

  /* --- 5. A VOLTA QUE ATERRA NA JANELA ERRADA -------------------------- */
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

  /* --- 6. A VOLTA NA JANELA CERTA -------------------------------------- */
  /* A chave deixou de ter o nome de uma porta quando ficaram três. */
  await palco.js(`localStorage.setItem('carimbo-demo:entrada',
    JSON.stringify({ bilhete: 'bilhete-de-demonstracao', provedor: 'google', em: Date.now() }))`);
  await palco.ir('/app/?code=um-codigo-qualquer&state=um-estado-qualquer');
  await palco.esperar('#barra .barra-item');
  certo(!(await palco.textoTodo()).includes('A entrada não ficou feita'),
    'com o bilhete no sítio, a volta conclui-se');
  certo(await guardado(palco, 'entrada') === null,
    'e o bilhete é gasto: não fica lá para servir outra vez');

  await palco.clicar(PERFIL);
  await palco.esperar(LINHA_CONTA);
  certo((await palco.texto(LINHA_CONTA)).includes('A conta está guardada'),
    'e a conta ficou guardada pela Google', await palco.texto(LINHA_CONTA));

  /* --- 7. O QUE FICA PARA TRÁS DEPOIS DE APAGAR ------------------------ */
  const chaves = await palco.js(`return Object.keys(localStorage)`);
  certo(!chaves.some((k) => k.endsWith(':entrada')),
    'não sobra bilhete nenhum no armazenamento depois de a entrada estar feita',
    JSON.stringify(chaves));

  /* --- 8. A OUTRA PORTA, E O «TIRAR» ----------------------------------- */
  /* O `Desligar` da Google está provado acima; o `Tirar` do email não tinha
     uma única afirmação — é o mesmo caminho por outra porta, e «o mesmo
     caminho» é precisamente o que se diz antes de uma das duas partir. */
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#campo-email');
  await palco.preencher('#campo-email', 'porta@exemplo.pt');
  await palco.clicar('#botao-enviar');
  await palco.esperar('#campo-codigo');
  await palco.escrever('#campo-codigo', '000000');
  await palco.sumir('#painel', 4000);

  await palco.esperar(LINHA_CONTA);
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#painel .linha-porta');
  certo(await palco.contar('#painel .linha-porta') === 2,
    'com as duas portas ligadas, aparecem as duas',
    String(await palco.contar('#painel .linha-porta')));
  const texto = await palco.textoTodo();
  certo(texto.includes('porta@exemplo.pt'),
    'e a do email mostra a morada que se escreveu');
  certo(!(await palco.ver('#painel #campo-email')),
    'quem já tem email não o volta a escrever — o campo deixa de ser oferecido');
  certo(!(await palco.ver(BOTAO_GOOGLE)),
    'e o botão da Google também não, que já está ligada');
  certo(!(await palco.visivel('#painel .ou')),
    'e sem nada para oferecer não há «ou» — ele separa alternativas, e aqui não sobra nenhuma');
  /* Com TRÊS portas, ter duas não é ter tudo — e o painel não pode dizer que
     sim. Afirma-se o contrário do que estava aqui escrito: que a que falta
     continua a ser oferecida, com o nome dela. */
  certo(texto.includes('Continuar com a Apple'),
    'e a porta que falta continua oferecida, em vez de o painel dar a conta por fechada');
  certo(!texto.includes('Tens tudo o que há'),
    'e não diz «tens tudo» com uma porta ainda por ligar');

  /* --- 8b. E COM AS TRÊS, AÍ SIM ---------------------------------------- */
  /* O fim da linha: ligada a terceira, não há nada para oferecer e o painel
     tem de o dizer, em vez de acabar num cabeçalho com nada por baixo. */
  /* Ligar uma porta FECHA o painel e leva ao perfil — é o mesmo fim de todos
     os caminhos de entrada, e a demonstração faz-lhe o percurso todo. Por
     isso reabre-se, em vez de esperar que o painel se repinte por baixo. */
  await palco.clicar(BOTAO_APPLE);
  await palco.sumir('#painel', 6000);
  await palco.esperarTexto('demonstração não há Apple a sério');
  await palco.esperar(LINHA_CONTA);
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#painel .linha-porta');
  certo(await palco.contar('#painel .linha-porta') === 3,
    'ligada a Apple, ficam as três portas na lista',
    String(await palco.contar('#painel .linha-porta')));
  const comTodas = await palco.texto('#painel');
  certo(comTodas.includes('Tens tudo o que há'),
    'e aí sim o painel diz que não falta nada', comTodas.slice(-200));
  certo(!(await palco.ver(BOTAO_APPLE)) && !(await palco.ver(BOTAO_GOOGLE))
    && !(await palco.ver('#painel #campo-email')),
    'e não sobra oferta nenhuma — nem botão, nem campo');

  /* E desliga-se outra vez, que o resto da secção conta com as duas. */
  certo(await marcarPorta(palco, 'Desligar', 'Apple') === true,
    'a porta da Apple tem um «Desligar» ao lado');
  await palco.clicar('[data-prova="porta"]');
  await palco.esperar('#painel .btn-perigo');
  await palco.clicar('#painel .btn-perigo');
  await palco.esperar('#painel .btn-apple');
  certo(await palco.contar('#painel .linha-porta') === 2,
    'desligada, voltam a ser duas', String(await palco.contar('#painel .linha-porta')));

  /* A morada que o painel mostra e a que o perfil mostra são lidas por duas
     funções diferentes — `moradaDaPorta` e `moradaDaConta`. Nada as obriga a
     concordar, por isso afirma-se que concordam. */
  certo((await palco.texto(LINHA_CONTA)).includes('porta@exemplo.pt'),
    'e é a MESMA morada que o perfil mostra por baixo',
    await palco.texto(LINHA_CONTA));

  /* O Cancelar volta ao painel da conta com a porta ainda lá. É uma linha
     diferente da do confirmar, e só a do confirmar tinha prova. */
  certo(await marcarPorta(palco, 'Tirar') === true,
    'a porta do email tem um «Tirar» ao lado');
  await palco.clicar('[data-prova="porta"]');
  await palco.esperar('#painel .btn-perigo');
  await palco.clicar('#painel .btn-fantasma.btn-bloco');
  await palco.esperar('#painel .linha-porta');
  certo(await palco.contar('#painel .linha-porta') === 2,
    'o Cancelar volta ao painel da conta, com as duas portas ainda lá',
    String(await palco.contar('#painel .linha-porta')));

  /* E o confirmar tira mesmo. O botão é marcado OUTRA VEZ: o painel que
     voltou é outro, e o atributo ficou no que saiu. */
  certo(await marcarPorta(palco, 'Tirar') === true, 'e o «Tirar» continua lá depois de voltar');
  await palco.clicar('[data-prova="porta"]');
  await palco.esperar('#painel .btn-perigo');
  await palco.clicar('#painel .btn-perigo');
  await palco.esperar('#painel #campo-email');
  certo(await palco.contar('#painel .linha-porta') === 1,
    'tirado o email, fica só a porta da Google',
    String(await palco.contar('#painel .linha-porta')));
  certo(await palco.visivel('#painel #campo-email'),
    'e o campo do email volta a ser oferecido, onde ele estava');

  /* --- 9. UM NOME QUE SE OUÇA ------------------------------------------ */
  /* Escrito, «Tirar» ao lado de «Email» chega. Num leitor de ecrã não há
     «ao lado»: o rotor de botões dá os verbos sozinhos. */
  const nomes = await palco.js(`
    return [...document.querySelectorAll('#painel .linha-porta .btn')]
      .map((b) => b.getAttribute('aria-label') || b.textContent.trim())`);
  certo(nomes.length === 1 && /Google/.test(nomes[0]) && /@/.test(nomes[0]),
    'o botão de uma porta diz O QUÊ, e não só o verbo', JSON.stringify(nomes));

  /* --- 10. NUM ECRÃ ESTREITO ------------------------------------------- */
  /* Aqui a Google JÁ está ligada, por isso o que se mede é a linha da porta —
     que tem uma morada de email inteira lá dentro, e é ela que estica.

     FECHA-SE O PAINEL E ESPERA-SE PELO AVISO. O «Email retirado» pousa no topo
     do ecrã e tapa a linha do perfil: o clique seguinte não lhe chega, e o que
     a bateria diz é «está tapado por span» — que é exactamente a classe de
     defeito que o módulo 06 persegue, só que aqui é o teste a tropeçar nela. */
  await palco.tecla('Escape');
  await palco.sumir('#painel', 4000);
  try { await palco.sumir('.aviso', 6000); } catch { /* já tinha ido */ }
  await palco.tamanho(320, 640);
  await palco.clicar(LINHA_CONTA);
  await palco.esperar('#painel .linha-porta');
  const porta = await palco.medir('#painel .linha-porta');
  certo(porta.largura <= 320, 'a 320 px a linha da porta não passa do ecrã',
    JSON.stringify(porta));
  const botaoDesligar = await palco.medir('#painel .linha-porta .btn');
  certo(botaoDesligar.altura >= 40 && botaoDesligar.largura >= 44,
    'e o «Desligar» continua com tamanho para ser tocado', JSON.stringify(botaoDesligar));
  certo(botaoDesligar.x + botaoDesligar.largura <= 321,
    'e não sai pela direita — a morada é que encolhe, não o botão',
    JSON.stringify(botaoDesligar));
  certo(!(await palco.js(`
    return document.documentElement.scrollWidth > document.documentElement.clientWidth`)),
    'e a 320 px a página não ganha barra de rolar para o lado');

  /* E a porta que falta continua a ser oferecida, inteira. */
  await palco.esperar('#painel .campo input');
  const campo = await palco.medir('#painel .campo input');
  certo(campo.largura > 180, 'o campo do email que falta também cabe',
    JSON.stringify(campo));
  await dormir(50);
}
