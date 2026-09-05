# A bateria de browser

`node scripts/bateria.mjs` abre um Chrome sem interface, sobe um servidor
próprio numa porta sorteada, e corre cada módulo desta pasta num separador
novo, com o armazenamento limpo.

```bash
node scripts/gerar.mjs              # primeiro, senão não há _site
node scripts/bateria.mjs            # tudo
node scripts/bateria.mjs 04         # só os módulos cujo nome contenha «04»
BATERIA_CAPTURAS=1 node scripts/bateria.mjs 04   # e guarda as fotografias
```

## Escrever um módulo

Um ficheiro `NN-nome.mjs` nesta pasta:

```js
export const nome = '04 · Descobrir e aderir';
export const ecra = { largura: 390, altura: 844 };  // opcional, isto é a omissão
export const desculpar = [/favicon/];               // erros de consola a perdoar
export const comServiceWorker = false;              // true só para testar o SW

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  certo(await palco.ver('#barra'), 'a barra aparece');
}
```

`certo(condicao, descricao, detalhe)` — a afirmação. O `detalhe` só aparece
quando falha, e é onde se põe o valor que se viu.

No fim de cada módulo o corredor verifica sozinho que **nada rebentou por
baixo**: qualquer excepção por apanhar ou `console.error` reprova. É a rede
que apanha a promessa que morre dentro de um clique.

## O palco

### Navegar
| | |
|---|---|
| `ir(caminho, {esperarPor, tecto})` | vai para `/app/?demo=1` (o prefixo entra sozinho) |
| `recarregar()` | |
| `voltarAtras()` | `history.back()` |
| `pronta(tecto)` | espera `readyState === 'complete'` |

### Ler
| | |
|---|---|
| `ver(sel)` | existe no DOM |
| `visivel(sel)` | **está mesmo à vista** — usa isto, não `ver`, para painéis |
| `contar(sel)` | quantos |
| `texto(sel)` / `textos(sel)` | texto aparado / array |
| `textoTodo()` | `innerText` do body, para procurar uma frase |
| `atributo(sel, nome)` / `valor(sel)` / `estilo(sel, prop)` | |
| `medir(sel)` | `{x, y, largura, altura, centroX, centroY}` ou `null` |
| `focado()` | quem tem o foco: `{etiqueta, classe, texto, rotulo}` |
| `armazenamento()` | despejo do `localStorage` |
| `js(expressao)` | corre na página; escreve `return ...`; aceita `await` |

### Esperar
`esperar(sel, tecto)` · `sumir(sel, tecto)` · `esperarTexto(pedaco, tecto)`
— todos **atiram** se o tecto passar, o que reprova o módulo com a razão.

### Conduzir
| | |
|---|---|
| `clicar(sel)` | com o rato, a sério — recusa se estiver tapado ou sem tamanho |
| `escrever(sel, texto)` | tecla a tecla |
| `preencher(sel, texto)` | de uma vez, com os eventos `input` e `change` |
| `tecla('Enter'\|'Escape'\|'Tab'\|…, {seletor})` | |
| `rolar(quanto)` | |

### Ambiente
`tamanho(l, a)` · `tema('dark'\|'light')` · `movimento('reduce'\|'no-preference')`
· `semRede(true)` · `limparArmazenamento()` · `captura(nome)`

## Regras

1. **Não contornes defeitos.** Se um botão não funciona, o teste tem de
   reprovar — não se escreve `if (existe)` à volta para o módulo passar.
2. **Modo de demonstração** (`?demo=1`) para tudo o que não precise do
   Worker: são as mesmas regras, no `localStorage`. Na demonstração o código
   de entrada por email é sempre `000000`.
3. **Um módulo, um assunto.** É a única forma de a falha dizer onde dói.
4. **`visivel`, não `ver`**, sempre que a pergunta é «a pessoa vê isto?».
   O `#boas-vindas` continua no DOM depois de fechado.
5. Os separadores da barra não têm `id`: são `.barra-item`, pela ordem
   Carteira, Descobrir, Código, Prémios, Perfil.
