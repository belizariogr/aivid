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

## Como funciona

### Projeto
- **Pré-prompt**: instruções gerais (estilo, época, lente, luz, regras) que entram antes de todo prompt de vídeo e imagem.
- **Prompt negativo**, resolução, proporção, FPS, seed, áudio e **contexto da continuação** (segundos do bloco anterior enviados ao LTX).
- **Pasta de saída**: escolhida pelo seletor do macOS ou digitada.

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
| **Corte** | Gera do zero, a partir da imagem inicial da cena ou só do texto. | Novo plano, ângulo ou lugar. |

Quando um bloco é gerado de novo, os blocos que continuavam dele ficam **Desatualizados**. Use **Daqui em diante** para refazer a sequência a partir desse ponto. Cada nova geração vira um take (`bloco-03_take-2.mp4`) e você escolhe qual take usar.

Durações que o LTX não aceita diretamente (por exemplo 7 s) são geradas na duração seguinte e recortadas no quadro exato. A continuação via extend aceita qualquer duração de 2 a 20 s.

### Prévias
Gere imagens estáticas para ver como o ambiente vai ficar antes de gerar o vídeo. A prévia pode usar uma imagem de referência (img2img), incluir ou não o elenco e é salva em `pasta de saída/previas/` com um JSON do pedido. Depois você pode usá-la como imagem inicial de uma cena ou salvá-la como fundo.

### Assistir
**Assistir cena** toca todos os blocos em sequência, sem pausa entre eles, com uma linha do tempo por bloco. O modo **Só as transições** toca apenas o fim de cada bloco e o começo do seguinte (±1,5 s, 2 s ou 3 s) para conferir as emendas. **Exportar unida** gera `cena-NN-…-completa.mp4` para conferência. Os blocos continuam separados.

### Roteiro com LLM
1. **Baixe o arquivo do projeto** (`<projeto>.takes-llm.json`). Ele traz o pré-prompt, os personagens e fundos com ids, as cenas existentes, as regras do LTX e o formato de resposta.
2. Descreva a cena e a duração desejada e **copie as instruções**. Cole na LLM junto com o arquivo. Se a LLM não aceita anexos, marque "Incluir o arquivo no texto".
3. **Cole a resposta** ou abra o `.json`, valide e importe como nova cena ou substituindo uma existente. A importação aceita JSON puro ou dentro de bloco de código, resolve personagens e fundos por id ou nome e recusa blocos acima de 20 s com a lista dos problemas.

Formato do roteiro:

```json
{
  "format": "takes.scene-script",
  "version": 1,
  "scene": {
    "title": "Chegada",
    "synopsis": "Ana chega ao café e procura Bruno.",
    "backgroundId": "<id ou nome do fundo>",
    "characterIds": ["<id ou nome>"],
    "blocks": [
      { "duration": 8, "continuity": "cut", "prompt": "English paragraph…" },
      { "duration": 6, "continuity": "continue", "characterIds": ["<id>"], "prompt": "…" }
    ]
  }
}
```

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
public/            interface (JS puro, sem build)
```

## Licença

MIT. O LTX Desktop e os modelos têm licenças próprias.
