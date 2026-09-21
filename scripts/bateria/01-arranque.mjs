/* =========================================================================
   Bateria · 01 — arranque das duas apps

   O teste mais aborrecido e o mais importante: a app abre? Se este falhar,
   nenhum dos outros quer dizer nada.

   Corre em modo de demonstração (`?demo=1`), que não é uma maqueta: é a
   mesma interface com as mesmas regras, guardadas no localStorage em vez de
   irem ao Worker. Serve para provar a interface sem depender da rede.
   ========================================================================= */

export const nome = '01 · Arranque das duas apps';

/** Passa as boas-vindas. Devolve quantos passos foram precisos. */
export async function passarBoasVindas(palco) {
  if (!(await palco.ver('#boas-vindas'))) return 0;
  for (let i = 0; i < 8; i++) {
    /* O painel some sozinho no último passo; enquanto lá estiver, avança. */
    if (!(await palco.visivel('#boas-vindas'))) return i;
    await palco.clicar('#bv-seguinte');
  }
  return 8;
}

export async function correr(palco, certo) {
  /* --- app do cliente --------------------------------------------------- */
  await palco.ir('/app/?demo=1');

  certo(await palco.ver('#aplicacao'), 'app do cliente: o esqueleto existe');
  certo(await palco.ver('#boas-vindas'), 'app do cliente: as boas-vindas aparecem à primeira');

  /* A BARRA DA DEMONSTRAÇÃO TEM DE SE VER AQUI, no primeiro ecrã de todos.

     Nasceu com `z-index: 60`, o mesmo do ecrã de boas-vindas — e como o ecrã
     de boas-vindas vem depois no documento, ganhava o empate. O aviso de que
     aquilo é uma demonstração estava lá, com 60 px de altura, completamente
     tapado, precisamente no ecrã de quem acabou de entrar. Não se via no
     código: viu-se a olhar para o site publicado.

     Não chega perguntar se a barra existe nem se está «visível» — os dois
     diziam que sim. A pergunta é quem é que o browser encontra no ponto onde
     ela está. */
  const noTopo = await palco.js(`
    const b = document.querySelector('#barra-demo');
    if (!b) return { erro: 'não há barra' };
    const c = b.getBoundingClientRect();
    if (c.height < 10) return { erro: 'a barra não tem altura', altura: c.height };
    const emCima = document.elementFromPoint(Math.round(c.width / 2), Math.round(c.height / 2));
    return {
      altura: Math.round(c.height),
      daBarra: !!(emCima && emCima.closest('#barra-demo')),
      quemTapa: emCima ? (emCima.id || emCima.className || emCima.tagName) : 'ninguém',
    };
  `);
  certo(noTopo && noTopo.daBarra,
    'a barra da demonstração está à frente das boas-vindas, e não atrás delas',
    `no ponto dela está «${noTopo?.quemTapa ?? noTopo?.erro}»`);

  const passos = await passarBoasVindas(palco);
  certo(passos > 0 && passos < 8,
    `app do cliente: as boas-vindas acabam (${passos} passos)`, `passos=${passos}`);

  await palco.esperar('#barra .barra-item');
  const separadores = await palco.textos('.barra-item');
  certo(separadores.length === 3,
    `app do cliente: a barra tem 3 separadores`, `tem ${separadores.length}: ${separadores}`);
  certo(separadores.join('|') === 'Carteira|Código|Perfil',
    'app do cliente: os separadores são os esperados', separadores.join('|'));

  /* Um título vazio é o sinal mais barato de que a pintura não aconteceu. */
  const titulo = await palco.texto('#topo-titulo');
  certo(!!titulo, 'app do cliente: o topo tem título', String(titulo));

  const corpo = await palco.texto('#principal');
  certo(corpo && corpo.length > 10,
    'app do cliente: o conteúdo principal não está vazio',
    `tem ${corpo ? corpo.length : 0} caracteres`);

  await palco.captura('01-app-carteira');

  /* --- balcão ----------------------------------------------------------- */
  await palco.ir('/balcao/?demo=1');
  certo(await palco.ver('#entrada') || await palco.ver('#barra'),
    'balcão: abre na entrada ou já dentro');

  const textoBalcao = await palco.textoTodo();
  certo(textoBalcao.length > 20, 'balcão: tem conteúdo', `${textoBalcao.length} caracteres`);
  certo(!/undefined|NaN|\[object Object\]/.test(textoBalcao),
    'balcão: nada de «undefined», «NaN» ou «[object Object]» no ecrã');

  await palco.captura('01-balcao-entrada');

  /* --- o site ----------------------------------------------------------- */
  await palco.ir('/');
  certo(await palco.ver('h1'), 'site: a página inicial tem um h1');
  const textoSite = await palco.textoTodo();
  certo(!/\{\{|POR PREENCHER/.test(textoSite),
    'site: nenhum marcador por resolver à vista');
}
