/* =========================================================================
   Bateria · 20 — Quem carimba

   Um café com três turnos tem três pessoas a atender, e o histórico de cada
   cartão já guardava o nome de quem carimbou desde o primeiro dia — só que o
   nome era sempre o mesmo, porque só podia haver um operador.

   O que este módulo persegue não é «a lista aparece». É o que esta secção tem
   de caro, que sai todo da mesma decisão — **o histórico guarda o NOME**:

   · DOIS NOMES IGUAIS MATAM O HISTÓRICO. Com dois «Marta» activos, o dono
     abre o histórico de um cartão e não fica a saber nada — que é exactamente
     a pergunta que ter vários operadores existe para responder. Recusa-se, e
     diz-se PORQUÊ: uma recusa sem razão manda a pessoa adivinhar.

   · A SECÇÃO NÃO SEGURA O ECRÃ. É a última de um ecrã que é das definições do
     cartão. Fazer o ecrã esperar por um pedido que nada tem que ver com o
     cartão seria um ecrã branco por causa do que está no fim.

   · O QUE NÃO SE PODE FAZER NÃO SE OFERECE. O dono não se tira a si próprio —
     e o botão não está lá para ele. A regra vive no servidor na mesma; o que
     se prova aqui é que ninguém lhe chega a tocar.

   · TIRAR ALGUÉM DIZ O QUE ACONTECE AOS CARIMBOS DELE. Ficam, com o nome. Um
     painel destrutivo que não diz o que fica é um painel em que ninguém
     carrega.

   Corre em modo de demonstração, onde as mesmas regras estão escritas do lado
   do browser. As recusas do servidor provam-se no `worker/testes.mjs`.
   ========================================================================= */

export const nome = '20 · Quem carimba';
export const desculpar = [/favicon/];

const PROGRAMA = '#barra .barra-item[data-ecra="programa"]';
const SECCAO = '#lista-operadores';
const JUNTAR = '#juntar-operador';

const dormir = (palco, ms) =>
  palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);

const limparAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.remove(); return true");

/** As linhas da secção, já lidas. */
const linhas = (palco) => palco.js(`
  return [...document.querySelectorAll('#lista-operadores .linha')].map((n) => ({
    nome: n.querySelector('b')?.textContent.trim() ?? null,
    detalhe: n.querySelector('.linha-texto span')?.textContent.trim() ?? null,
    mudar: Boolean(n.querySelector('.linha-fim .btn')),
  }))`);

/** Marca o «Mudar» de uma pessoa para lhe podermos tocar. */
const marcarMudar = (palco, quem) => palco.js(`
  const linha = [...document.querySelectorAll('#lista-operadores .linha')]
    .find((n) => (n.querySelector('b')?.textContent || '').includes(${JSON.stringify(quem)}));
  const b = linha && linha.querySelector('.linha-fim .btn');
  if (!b) return null;
  b.setAttribute('data-prova', 'mudar');
  return true`);

async function irAoCartao(palco) {
  await palco.clicar(PROGRAMA);
  await palco.esperar('#previa', 8000);
  await palco.esperar(SECCAO, 8000);
}

export async function correr(palco, certo) {
  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 10000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);

  /* --- 1. A SECÇÃO EXISTE, E NÃO SEGUROU O ECRÃ ------------------------ */
  await palco.clicar(PROGRAMA);
  /* A pré-visualização do cartão é o que este ecrã existe para mostrar. Se
     ela aparecer, o ecrã pintou-se — mesmo que a lista ainda venha a caminho. */
  await palco.esperar('#previa', 8000);
  certo(await palco.ver('#previa'),
    'o ecrã do cartão pinta-se sem esperar por quem carimba — a secção é a última');

  await palco.esperar(SECCAO, 8000);
  await dormir(palco, 500);
  const inicio = await linhas(palco);
  certo(inicio.length === 1 && inicio[0].nome.includes('Balcão'),
    'e a lista chega depois, com quem fundou o balcão lá dentro',
    JSON.stringify(inicio));
  certo(!inicio[0].mudar,
    'o dono não tem «Mudar» ao pé de si — não se pode tirar a si próprio, '
    + 'e o que não se pode fazer não se oferece');
  certo((inicio[0].detalhe || '').includes('Dono'),
    'e diz-se que ele é o dono', String(inicio[0].detalhe));
  certo(!(await palco.textoTodo()).includes('A ver…'),
    'e o «A ver…» sai do ecrã quando a resposta chega');

  /* --- 2. JUNTAR ALGUÉM ------------------------------------------------ */
  /* ESTÁ ABAIXO DA DOBRA, e tem de estar: é a última secção de um ecrã que é
     das definições do cartão. O que se prova é que se CHEGA lá com um deslize,
     e não que esteja à vista sem se mexer no ecrã. */
  certo(await palco.ver(JUNTAR), 'o dono tem por onde juntar quem carimba');
  /* ESPERA-SE QUE A PÁGINA ASSENTE, e não trezentos milissegundos.
     O `html` desta casa tem `scroll-behavior: smooth`, por isso um
     `scrollIntoView` é uma animação e não um salto — e a distância cresce
     sempre que este ecrã ganha uma secção nova. Medir a meio da animação
     acusava o botão de estar fora do ecrã quando quem estava a meio do
     caminho era a página. */
  await palco.js(`document.querySelector('#juntar-operador')
    .scrollIntoView({ block: 'center' });
    let anterior = null;
    for (let i = 0; i < 25; i++) {
      const agora = Math.round(window.scrollY);
      if (agora === anterior) break;
      anterior = agora;
      await new Promise((r) => setTimeout(r, 80));
    }
    return true`);
  certo(await palco.visivel(JUNTAR),
    'e chega-se-lhe com um deslize — não está preso fora do ecrã');
  await palco.clicar(JUNTAR);
  await palco.esperar('#op-nome');
  certo(await palco.ver('#op-email'),
    'e o painel pede o email — é por ele que a pessoa entra');
  certo((await palco.texto('#painel')).includes('não há palavra-passe'),
    'e diz que não há palavra-passe nenhuma a combinar — nem PIN');
  certo((await palco.texto('#painel')).includes('Não vai lá código nenhum'),
    'e que o convite não leva código: um código numa caixa de correio fica lá à espera');

  await palco.preencher('#op-nome', 'Marta');
  await palco.preencher('#op-email', 'marta@exemplo.pt');
  await palco.clicar('#painel .btn-cheio');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  const duas = await linhas(palco);
  certo(duas.length === 2,
    'juntando um colega, ficam dois no balcão', JSON.stringify(duas));
  const marta = duas.find((l) => l.nome.includes('Marta'));
  certo(Boolean(marta) && (marta.detalhe || '').includes('Balcão'),
    'e ele entra como balcão, não como dono', JSON.stringify(marta));
  certo(Boolean(marta) && (marta.detalhe || '').includes('ainda não entrou'),
    'e diz que ainda não entrou — é diferente de andar cá todos os dias',
    JSON.stringify(marta));
  certo((await palco.textoTodo()).includes('email não saiu'),
    'e na demonstração diz que o email não saiu, em vez de fingir que foi');
  await limparAvisos(palco);

  /* --- 3. O NOME REPETIDO, QUE É O QUE ISTO EXISTE PARA IMPEDIR -------- */
  await palco.clicar(JUNTAR);
  await palco.esperar('#op-nome');
  await palco.preencher('#op-nome', '  marta ');
  await palco.preencher('#op-email', 'outra@exemplo.pt');
  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('#painel .aviso-mau');
  const recusa = await palco.texto('#painel .aviso-mau');
  certo(recusa.includes('Marta') || recusa.includes('marta'),
    'dois nomes iguais são recusados — sem maiúsculas e sem espaços, que é como se lê',
    recusa);
  certo(recusa.includes('histórico'),
    'e a recusa diz PORQUÊ, em vez de mandar a pessoa adivinhar', recusa);
  certo(await palco.visivel('#painel'),
    'e o painel fica aberto com o que já lá estava escrito — não se perde o que se escreveu');

  await palco.preencher('#op-email', 'marta@exemplo.pt');
  await palco.preencher('#op-nome', 'Alguém');
  await palco.clicar('#painel .btn-cheio');
  await palco.esperar('#painel .aviso-mau');
  certo((await palco.texto('#painel .aviso-mau')).includes('morada'),
    'e a mesma morada duas vezes também é recusada — entrar é pela morada');

  await palco.tecla('Escape');
  await palco.sumir('#painel');
  await dormir(palco, 300);
  certo((await linhas(palco)).length === 2,
    'e nenhuma das recusas deixou alguém para trás na lista',
    JSON.stringify(await linhas(palco)));

  /* --- 4. MUDAR O NOME, QUE É O QUE RESOLVE OS DOIS «MARTA» ------------ */
  certo(await marcarMudar(palco, 'Marta') === true,
    'quem não é o dono tem um «Mudar» ao lado');
  await palco.clicar('[data-prova="mudar"]');
  await palco.esperar('#op-nome');
  certo(!(await palco.ver('#op-email')),
    'a mexer em quem já cá está não se volta a pedir o email — não é isso que se muda');
  await palco.preencher('#op-nome', 'Marta da tarde');
  await palco.clicar('#painel .btn-cheio');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  certo((await linhas(palco)).some((l) => l.nome.includes('Marta da tarde')),
    'o nome muda, e é assim que dois «Marta» passam a distinguir-se',
    JSON.stringify(await linhas(palco)));
  await limparAvisos(palco);

  /* --- 5. TIRAR DIZ O QUE ACONTECE AOS CARIMBOS ------------------------ */
  certo(await marcarMudar(palco, 'Marta da tarde') === true, 'o «Mudar» continua lá');
  await palco.clicar('[data-prova="mudar"]');
  await palco.esperar('#painel .btn-perigo');
  await palco.clicar('#painel .btn-perigo');
  await palco.esperar('#painel .btn-perigo.btn-grande');
  const perigo = await palco.texto('#painel');
  certo(perigo.includes('sessão dele fecha-se já'),
    'o painel de tirar diz que a sessão fecha já — mesmo com o telemóvel aberto',
    perigo.slice(0, 200));
  certo(perigo.includes('ficam no histórico'),
    'e diz o que acontece aos carimbos que ele deu: ficam, com o nome dele',
    perigo.slice(0, 260));

  await palco.clicar('#painel .btn-perigo.btn-grande');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  const sozinho = await linhas(palco);
  certo(sozinho.length === 1 && sozinho[0].nome.includes('Balcão'),
    'tirado, fica só quem fundou o balcão', JSON.stringify(sozinho));
  await limparAvisos(palco);

  /* --- 6. E O NOME FICA LIVRE OUTRA VEZ -------------------------------- */
  await palco.clicar(JUNTAR);
  await palco.esperar('#op-nome');
  await palco.preencher('#op-nome', 'Marta da tarde');
  await palco.preencher('#op-email', 'marta3@exemplo.pt');
  await palco.clicar('#painel .btn-cheio');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  certo((await linhas(palco)).length === 2,
    'quem sai liberta o nome — senão um café perdia nomes para sempre',
    JSON.stringify(await linhas(palco)));
  await limparAvisos(palco);

  /* --- 7. A SECÇÃO SOBREVIVE A SAIR E VOLTAR --------------------------- */
  /* Repintar a secção deita fora o botão e o texto de baixo e volta a pô-los.
     Feito à mão, é o sítio óbvio para ficarem dois botões de «Juntar». */
  await palco.clicar('#barra .barra-item[data-ecra="hoje"]');
  await palco.esperar('#principal .numeros', 8000);
  await irAoCartao(palco);
  await dormir(palco, 500);
  certo(await palco.contar('#principal .btn-suave') === 2,
    'voltando ao ecrã, há um «Juntar» e um «Imprimir o cartaz» — e não dois de cada',
    String(await palco.contar('#principal .btn-suave')));
  certo((await linhas(palco)).length === 2,
    'e a lista volta com as duas pessoas que lá estavam',
    JSON.stringify(await linhas(palco)));
}
