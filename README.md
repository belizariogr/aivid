# Takes

Estúdio local para criar **cenas longas e contínuas** com o [LTX Desktop](https://github.com/Lightricks/LTX-Desktop) instalado no Mac.

O LTX gera no máximo 20 segundos por clipe. O Takes divide cada cena em **blocos** de até 20 s e os encadeia para a cena não ter limite de duração. Cada bloco vira um MP4 separado na pasta de saída, pronto para edição.

## Requisitos

- macOS com o **LTX Desktop** aberto e inicializado, com um modelo local instalado (testado com LTX 2.5 distilled).
- Para prévias e fotos geradas por IA: **Z-Image Turbo** instalado no LTX Desktop.
- **FFmpeg** (`brew install ffmpeg`) para recortar, extrair quadros e unir blocos.
- **Node.js 20.10+**. O projeto não tem dependências npm.

## Executar

```sh
npm start          # abre http://127.0.0.1:4477 no navegador
npm run dev        # reinicia ao editar o servidor, sem abrir o navegador
npm test
```

Variáveis opcionais: `PORT` (padrão 4477) e `TAKES_HOME` (pasta da biblioteca; padrão `~/Library/Application Support/Takes`).

### App do Mac

```sh
npm run app           # gera dist/Takes.app
npm run app:install   # gera e instala em /Applications/Takes.app
```

O app é uma janela nativa (Swift + WebKit) que inicia o servidor do Takes sozinho, numa porta livre a partir de 4477, e o encerra ao sair. Diálogos, seleção de arquivos, downloads e área de transferência são nativos.

### Fechar no meio de uma geração

A fila fica salva em `~/Library/Application Support/Takes/jobs.json`, com o que está sendo gerado (bloco, id da geração no LTX e como salvar o resultado). Ao sair com tarefas em andamento, o app pergunta:

- **Sair e deixar o LTX terminar**: o LTX conclui a geração atual. Ao abrir o Takes de novo, ele reconhece essa geração, mostra o progresso, salva o bloco e continua a fila.
- **Sair e cancelar**: cancela no LTX o que está gerando e na fila.

Se o app fechar sozinho ou for encerrado à força, vale a primeira opção. Se a geração se perder enquanto o Takes está fechado (o LTX foi fechado ou começou outra coisa), a tarefa aparece como **Interrompida**, e **Retomar** gera o que faltou. No terminal, `Ctrl+C` cancela as gerações; `SIGTERM` deixa o LTX terminar.

- Precisa do Node.js instalado (Homebrew, `/usr/local` ou o `PATH` do shell de login). O app não embute o Node.
- O registro do servidor fica em `~/Library/Logs/Takes/servidor.log` (menu Takes → Mostrar registro do servidor).
- O build exige as ferramentas de linha de comando do Xcode. A assinatura é ad-hoc, para uso local.
- Depois de mudar o código, rode `npm run app:install` de novo: o app leva uma cópia do servidor e da interface.
- Não rode `npm start` com o app aberto: os dois usariam a mesma biblioteca de projetos.

## Como funciona

### Configurações
O botão **⚙ Configurações**, no topo, reúne o que vale para todos os projetos:

- **Chaves de API**: Claude (Anthropic) e/ou OpenAI (ChatGPT/Codex).
- **Modelos de IA**: o do **roteiro** e o da **revisão e do juiz** (pode ser o mesmo ou um mais barato), cada um com seu **esforço** (baixo, médio, alto, muito alto, máximo). Nos modelos Claude, um esforço que o modelo não aceita cai no mais próximo abaixo. Na OpenAI, o esforço é o padrão do modelo.
- **Padrões de um projeto novo**: resolução, proporção, FPS, contexto da continuação, retakes, áudio, revisão e juiz.

Tudo fica em `~/Library/Application Support/Takes/ai.json`, com permissão só do seu usuário. A interface nunca recebe a chave, só os últimos caracteres.

### Projeto
O cabeçalho do projeto tem as duas ações principais: **✦ Gerar cenas com IA** (veja "Roteiro com IA") e **▶ Gerar filme**. A aba Projeto mostra:

- **Andamento**: blocos prontos, **Gerar pendentes**, **Gerar tudo de novo**, o último filme gerado e **Precisa de você**, agrupado por cena.
- **Pré-prompt**: instruções gerais (estilo, época, lente, luz, regras) que entram antes de todo prompt de vídeo e imagem.
- **Prompt negativo**, resolução, proporção, FPS, seed, áudio, **contexto da continuação** (segundos do bloco anterior enviados ao LTX), **revisão de continuidade com IA**, **juiz com IA** e **retakes** (veja abaixo).
- **Pasta de saída**: escolhida pelo seletor do macOS ou digitada.
- **Novas tentativas**: se um bloco falhar (erro do LTX, conexão que caiu, FFmpeg), ele é gerado de novo até mais duas vezes, com pausas de 5 s e 15 s. Só depois da terceira falha a tarefa para com erro e **Retomar** continua do bloco que falhou. Erros que só você resolve (pasta de saída ausente, bloco anterior sem vídeo) param na hora.
- **Clonar projeto**: cria uma cópia com pré-prompt, configurações, personagens (com fotos), fundos e cenas. A cópia começa sem vídeos, sem prévias e sem pasta de saída.
- **Limpar todas as cenas**: apaga as cenas e mantém personagens, fundos e configurações. Os vídeos continuam na pasta de saída, e uma cena nova com o mesmo nome continua a numeração (`_take-2`…) em vez de sobrescrever.

### Personagens
Foto (envio, enquadramento, zoom, rotação, espelhamento, brilho, contraste e saturação), geração de foto por IA a partir do perfil (opcionalmente partindo da foto atual) e perfil: nome, papel, aparência, figurino, personalidade, voz e notas. **Aparência e figurino entram no prompt** dos blocos em que o personagem aparece. Personalidade e voz servem para você e para a LLM.

### Fundos
Envie imagens de referência do ambiente e descreva cada uma. A descrição entra no prompt das cenas que usam o fundo. A imagem serve de base para prévias e pode ser o quadro inicial da cena.

### Cenas e continuidade
Uma cena é uma lista de blocos (2–20 s cada) com prompt, duração e elenco opcional por bloco. O primeiro bloco abre a cena só pelo texto ou a partir de uma imagem inicial (um fundo ou uma prévia). Cada bloco seguinte escolhe como se liga ao anterior:

| Modo | O que o Takes faz | Quando usar |
|---|---|---|
| **Continuar o movimento** (padrão) | Recorta os últimos segundos do bloco anterior (com quadros múltiplos de 8 + 1), envia para o `/api/extend` do LTX e salva **só o trecho novo**. | Mesmo plano, a câmera continua rodando. Melhor continuidade de movimento. |
| **Partir do último quadro** | Extrai o último quadro do bloco anterior e o usa como imagem inicial (image-to-video). | Mudança calma de ação no mesmo plano. Mais rápido. |
| **Corte** | Gera do zero, a partir da **imagem inicial do corte** (abaixo). | Novo plano, ângulo ou lugar. |

#### Imagem inicial do corte

O LTX não tem memória entre blocos: ele só sabe o que recebe naquele bloco (o texto e uma imagem inicial). Se um corte parte da imagem da cena, o lugar volta ao estado original do fundo: um portão aberto no bloco anterior aparece fechado de novo. Por isso cada corte escolhe de onde sai a sua imagem:

| Opção | Quando usar |
|---|---|
| **Imagem inicial da cena** (padrão) | Nada visível mudou desde o começo da cena. |
| **Gerar imagem de abertura** | Um ângulo ou enquadramento novo que precisa mostrar o estado atual. Antes do vídeo, o Z-Image gera o quadro de abertura a partir da descrição do quadro (**Quadro de abertura**, em inglês) e de uma referência: o último quadro de um bloco, um fundo, uma prévia, a imagem da cena ou nada. O prompt leva o cenário, o elenco e o estado atual. A imagem fica nas prévias e é reaproveitada nas próximas gerações do bloco até você clicar em **Gerar outra** ou mudar a referência ou a descrição. Sem o Z-Image instalado, o bloco usa a própria referência e a Fila mostra um aviso. |
| **Último quadro do bloco N** | Voltar a um enquadramento que um bloco anterior deixou, já com o estado atual (portão aberto, fita faltando). |
| **Fundo** | Uma variação do lugar que já mostra a mudança (por exemplo, "Praça com o portão aberto"). A descrição desse fundo passa a entrar no prompt dali em diante, no lugar da descrição do fundo da cena. |
| **Prévia ou quadro salvo** | Qualquer imagem da aba Prévias, inclusive quadros salvos de um take. |
| **Só o texto** | Nenhuma imagem combina com o novo plano. O prompt precisa descrever o lugar e o estado atual. |

**Salvar quadro**, embaixo do vídeo do bloco, salva o quadro em que o player está parado como prévia (`previas/<cena>-bloco-NN-…png`). Serve para os casos em que nenhum fim de bloco serve. Por exemplo: o bloco 4 termina com zoom no rosto e o 5 volta ao plano aberto. Pare o vídeo do bloco 4 num momento ainda aberto, salve o quadro e escolha-o como imagem inicial do corte do bloco 5. O quadro também pode virar fundo (**Salvar como fundo**) ou base de uma prévia img2img.

Cada bloco também tem:

- **Estado atual** (em inglês): o que mudou no lugar e nos objetos em relação ao fundo, como "The gate stands wide open.". Entra no prompt do vídeo e no da imagem de abertura como `Current state: …`.
- **Nota de continuidade** (não entra no prompt): para você e para a LLM registrarem o que precisa se manter e o que conferir.

#### Continuidade entre cenas

A imagem inicial do 1º bloco de uma cena pode ser:

- **Último quadro da cena anterior**: para quando a cena retoma exatamente onde a anterior terminou. Se o último bloco da cena anterior for refeito, o 1º bloco desta fica **Desatualizado**.
- **Gerar imagem de abertura**: gerada a partir da descrição do quadro de abertura do 1º bloco e de uma referência (um fundo, o último quadro da cena anterior ou nada).

#### Juiz com IA e retakes

Opcional, em **Projeto → IA durante a geração → Juiz depois de cada bloco**, com o modelo da revisão e do juiz das **Configurações**. Depois de cada bloco, a LLM recebe:

- o primeiro, o do meio e o último quadro do take;
- o último quadro do bloco anterior;
- a imagem de abertura usada;
- a foto e a ficha de corpo inteiro de cada personagem do bloco.

Ela reprova o take quando o problema seria percebido por quem assiste:

- a ação não aconteceu;
- um personagem está diferente da referência;
- o estado não se manteve;
- há defeito grave;
- a emenda com o bloco anterior não funciona.

Quando reprova, o Takes gera outro take até o limite de **Retakes se reprovar** (0 a 3; padrão 2). A seed fixa muda a cada retake. Se nenhum take passar, fica o de maior nota e o bloco entra em **Precisa de você**. O seletor de takes mostra a nota de cada um. Com o juiz ligado, as imagens de abertura geradas também são conferidas, e uma imagem recusada é gerada de novo uma vez.

#### Fichas de referência dos personagens

No personagem, **Gerar fichas** cria a partir da foto três imagens com o mesmo rosto e figurino: frente, perfil e corpo inteiro. O juiz e a conferência das aberturas usam essas fichas.

#### Do roteiro ao filme

- **▶ Gerar filme**, no cabeçalho do projeto, põe na fila os blocos pendentes de todas as cenas. No fim, une tudo em `<pasta de saída>/<projeto>-filme.mp4` e escreve `<projeto>-relatorio.md` com o que precisa de você.
- No assistente de roteiro, **Depois de importar, gerar o filme** faz o mesmo logo depois de importar as cenas.
- A aba Projeto mostra **Precisa de você**: blocos sem vídeo, desatualizados, sem arquivo ou reprovados pelo juiz, com link para cada um.

Com a revisão antes, o juiz depois, as aberturas geradas e as fichas dos personagens, o caminho sem interação é: colar o roteiro, marcar **Depois de importar, gerar o filme**, clicar em **Gerar e importar cenas** e, no fim, olhar só o que está em **Precisa de você**.

#### Revisão de continuidade com IA

Opcional, em **Projeto → IA durante a geração → Revisar a continuidade antes de cada bloco**. Usa o modelo da revisão e do juiz das **Configurações**. Antes de gerar cada bloco a partir do 2º, o Takes manda à LLM:

- o plano da cena;
- o último quadro que o LTX **realmente** gerou em cada bloco anterior (até 8);
- a imagem inicial planejada para o bloco;
- as imagens dos fundos.

A LLM confere se o plano ainda funciona com o que saiu de verdade (a ação aconteceu? a câmera terminou mais perto que o previsto? o portão está aberto?). Ela pode trocar o modo de continuidade, a imagem inicial do corte, o prompt e a nota, sem mudar a ação, a duração nem o elenco.

- O bloco mostra o que a IA mudou e por quê, com **Desfazer** para voltar ao plano anterior.
- Se a revisão falhar (sem modelo, sem rede, resposta inválida depois de uma correção), o bloco segue o plano e a tarefa mostra um aviso na Fila.
- Cada bloco revisado é uma chamada de API com imagens, cobrada na sua conta do provedor.

Quando um bloco é gerado de novo, os blocos que continuavam dele ficam **Desatualizados**. Use **Daqui em diante** para refazer a sequência a partir desse ponto. Cada nova geração vira um take (`bloco-03_take-2.mp4`) e você escolhe qual take usar.

Durações que o LTX não aceita diretamente (por exemplo 7 s) são geradas na duração seguinte e recortadas no quadro exato. A continuação via extend aceita qualquer duração de 2 a 20 s.

### Prévias
Gere imagens estáticas para ver como o ambiente vai ficar antes de gerar o vídeo. A prévia pode usar uma imagem de referência (img2img), incluir ou não o elenco e é salva em `pasta de saída/previas/` com um JSON do pedido. Depois você pode usá-la como imagem inicial de uma cena ou salvá-la como fundo.

### Fila
A aba Fila tem três partes, separadas:

- **Gerando agora**: o que o LTX está gerando.
- **Na fila**: o que vem depois, numerado na ordem em que vai rodar, de cima para baixo.
- **Concluídas**: o histórico (concluídas, com erro, canceladas ou interrompidas), da mais recente para a mais antiga. **Retomar** e **Limpar concluídas** ficam aqui.

### Assistir
**Assistir cena** toca todos os blocos em sequência, sem pausa entre eles, com uma linha do tempo por bloco. O modo **Só as transições** toca apenas o fim de cada bloco e o começo do seguinte (±1,5 s, 2 s ou 3 s) para conferir as emendas. **Exportar unida** gera `cena-NN-…-completa.mp4` para conferência. Os blocos continuam separados.

### Roteiro com IA
1. Em **⚙ Configurações**, cadastre a chave e escolha o modelo do roteiro.
2. No projeto, clique em **✦ Gerar cenas com IA** e cole o **roteiro completo** (cenas, ações, falas). Se quiser, informe a duração total.
3. Escolha se as cenas geradas entram **depois das cenas atuais** ou **substituem todas** e, se quiser, marque **Depois de importar, gerar o filme**.
4. Clique em **Gerar e importar cenas**. A LLM divide o roteiro em cenas e cada cena em blocos de até 20 s, usando os personagens e fundos do projeto. Quando a resposta passa na validação, o Takes **importa as cenas sozinho**.

As instruções explicam à LLM como os blocos se encadeiam:

- o LTX não lembra do que mudou;
- o enquadramento do fim de um bloco passa para o próximo;
- o fundo mostra o lugar no estado original;
- o estado continua valendo nas cenas seguintes.

A LLM escolhe a abertura de cada corte (`start`, de preferência `keyframe` para ângulos novos) e a de cada cena (`previous` quando ela retoma a anterior). Também preenche o `state` de cada bloco em que algo mudou. Títulos, sinopses e notas saem no idioma do roteiro; prompts e estados, em inglês.

A resposta é validada, e o que falhar volta para a LLM corrigir (até duas vezes):

- corte sem `start`;
- `block:N` que não é um bloco anterior;
- fundo inexistente;
- `keyframe` sem `opening`;
- bloco com menos de 3 s;
- fala que não cabe no bloco (com áudio ligado, mais de 3 palavras por segundo).

Outros detalhes:

- A geração roda no servidor e continua se você fechar o assistente. Enquanto o modelo pensa, o assistente mostra a etapa (recebido, planejando, escrevendo) e um trecho do raciocínio.
- Se a resposta ainda falhar depois das correções, o assistente mostra os problemas e a resposta da IA, e nada é importado.
- Substituir as cenas fica bloqueado enquanto houver cenas do projeto na fila.
- Claude: streaming com pensamento adaptativo resumido e o esforço das Configurações. Nos modelos com classificadores de segurança (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1/5.2), o pedido vai com `fallbacks: "default"`, e a Anthropic refaz a resposta em outro modelo se houver recusa.
- OpenAI: Responses API com streaming e `store: false`.
- Cada geração é cobrada na sua conta do provedor.
- `POST /api/projects/<id>/import-script` reimporta uma resposta salva (o JSON abaixo).

Formato do roteiro:

```json
{
  "format": "takes.scene-script",
  "version": 1,
  "scene": {
    "title": "Chegada",
    "synopsis": "Ana chega ao café e procura Bruno.",
    "backgroundId": "<id ou nome do fundo>",
    "start": "background",
    "characterIds": ["<id ou nome>"],
    "blocks": [
      { "duration": 8, "continuity": "cut", "prompt": "English paragraph…" },
      { "duration": 6, "continuity": "continue", "characterIds": ["<id>"], "prompt": "…", "note": "Termina em close." },
      { "duration": 5, "continuity": "cut", "start": "block:1", "state": "The gate stands wide open.", "prompt": "…", "note": "Volta ao plano aberto do fim do bloco 1." },
      { "duration": 7, "continuity": "cut", "start": "keyframe", "reference": "block:1", "opening": "Low angle from inside the square…", "state": "The gate stands wide open.", "prompt": "…" }
    ]
  }
}
```

- `start` da cena: `"background"` (abre da imagem do fundo), `"previous"` (último quadro da cena anterior), `"keyframe"` (gerada a partir do `opening` do bloco 1 e de `"reference"`: `"background"`, `"previous"`, `"background:<id>"` ou `"none"`) ou `"none"` (só o texto).
- `start` de um corte: `"keyframe"` (com `opening` e `reference` opcional), `"block:N"` (bloco anterior da mesma cena), `"scene"`, `"background:<id ou nome>"` ou `"none"`. É obrigatório; sem ele a resposta volta para a LLM corrigir.
- `state`: o estado atual em inglês, quando difere do fundo.

## Saída

```text
<pasta de saída>/
  previas/
    cena-x-20261123-101500.png
    cena-x-20261123-101500.json
  cena-01-chegada/
    bloco-01.mp4
    bloco-01.json          # prompt e parâmetros enviados ao LTX
    bloco-02.mp4
    bloco-02_take-2.mp4
    cena-01-chegada-completa.mp4
  <projeto>-filme.mp4      # Gerar o filme completo
  <projeto>-relatorio.md   # o que precisa de você
```

Renomear ou reordenar cenas depois de gerar muda o nome das próximas pastas. Os takes antigos continuam onde foram salvos.

## Integração com o LTX

O Takes fala com o backend local do LTX Desktop em `127.0.0.1`. Ele encontra o processo `ltx2_server.py`, lê o token de sessão das variáveis de ambiente do processo e a porta com `lsof`. O token só fica em memória. Endpoints usados: `/api/generate`, `/api/extend`, `/api/generate-image`, `/api/generation/progress`, `/api/generate/cancel`, `/api/generate/models-specs`, `/api/models/ltx-versions` e `/api/settings`.

- Os prompts vão como `promptProvenance: "enhanced"`, para o LTX não reescrevê-los.
- Se o LTX estiver configurado para gerar na nuvem, o Takes desliga essa preferência antes de gerar.
- O LTX gera uma coisa por vez. O Takes recusa começar se o LTX já estiver ocupado e processa a fila em ordem.
- A API é interna do LTX Desktop e pode mudar entre versões.

O servidor escuta só em `127.0.0.1`, recusa outros hosts e exige um cabeçalho próprio em toda escrita. Ele só serve arquivos da biblioteca e das pastas de saída dos projetos.

## Estrutura

```text
server/index.js    HTTP, rotas, eventos (SSE) e mídia com Range
server/ltx.js      cliente do LTX Desktop
server/jobs.js     fila e geração dos blocos com continuidade
server/media.js    FFmpeg/FFprobe
server/store.js    projetos em JSON
server/prompts.js  montagem dos prompts
server/llm.js      arquivo para LLM e importação do roteiro
server/ai.js       chaves de API, modelos e roteiro automático (Claude e OpenAI)
server/review.js   revisão antes do bloco, juiz depois e conferência das aberturas (visão)
public/            interface (JS puro, sem build)
mac/               app nativo (Swift), ícone e build
```

## Licença

MIT. O LTX Desktop e os modelos têm licenças próprias.
