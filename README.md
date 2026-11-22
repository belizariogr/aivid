# Aivid

Um app de macOS para organizar personagens e gerar **clipes por cena** com o LTX Desktop no próprio computador.

## O que faz

- Salva projetos com cenário, continuidade, configurações e biblioteca de personagens.
- Cada cena tem título, prompt, personagens, duração e imagem inicial próprios.
- Gera uma cena ou coloca todas na fila, uma por vez.
- Salva MP4s separados e os prompts usados na pasta escolhida.
- Permite assistir à sequência em um player com capítulos à esquerda, avanço automático e busca no vídeo.
- Usa a versão mais recente gerada de cada cena no player.
- Opcionalmente usa o último quadro de um clipe como referência da próxima cena.
- Impede o repouso enquanto a fila roda; mantém a tela livre para apagar.

O Aivid não é um editor de vídeo. Ele mantém os clipes separados para você editar no seu programa preferido. Os vídeos desta versão são gerados **sem áudio**.

## Requisitos

- macOS em Apple Silicon.
- [LTX Desktop](https://github.com/Lightricks/LTX-Desktop) instalado em `/Applications/LTX Desktop.app`, aberto e inicializado.
- Um modelo Fast e o **encoder de texto local** instalados no LTX Desktop. A integração foi validada com LTX Desktop 1.3.2 e LTX 2.3 Fast.
- Node.js 22.12+ para desenvolver a partir do código. O `.app` empacotado não precisa de Node instalado.
- FFmpeg (`brew install ffmpeg`) para recortar vídeos, encadear cenas ou salvar quadros dos clipes.

O Aivid utiliza a API local interna do LTX Desktop, que pode mudar entre versões. Ele não inclui os modelos nem baixa pesos automaticamente.

## Executar

```sh
npm ci
npm start
```

Para gerar um aplicativo independente para Mac com Apple Silicon:

```sh
npm run package
open dist/Aivid-darwin-arm64/Aivid.app
```

O empacotamento usa Node 24 via `npx`, sem trocar o Node global da máquina. O app local não é assinado nem notarizado para distribuição pública.

## Fluxo recomendado

1. Crie um projeto. Use **Pré-prompt do projeto** para definir estilo, câmera, iluminação e outras instruções recorrentes. O Aivid inclui esse texto nas prévias, nos ambientes e nos vídeos. Nos cartões das cenas, escreva apenas o que muda ou acontece.
2. Adicione uma imagem de cada personagem. Clique nela para editar os dados ou salvar uma cópia da imagem no disco. Use **Abrir pasta de arquivos** para acessar as imagens armazenadas no projeto.
3. Adicione cenas, escreva o prompt de cada uma e marque os personagens presentes.
4. No cartão da cena, use **Gerar ambiente** para criar um quadro inicial pelo texto, com uma referência opcional. Ajuste o prompt e gere novas prévias até aprovar uma. O quadro aprovado entra na biblioteca do projeto e pode ser escolhido em outras cenas. Também é possível importar um quadro pronto.
5. Escolha resolução, duração e pasta de saída.
6. Use **Gerar clipe contínuo** para animar as ações em uma só geração. Para obter um arquivo por cena, use **Gerar cenas separadas** ou **Gerar só esta cena**.
7. Use as setas ↑ e ↓ nos cartões para ordenar as cenas.
8. Use **Ver sequência** para assistir à ordem das cenas. Clique em um capítulo para pular para ele.

**Gerar prévia da cena** cria uma imagem estática a partir do prompt da cena, das descrições do elenco selecionado e da referência visual escolhida. Revise a prévia antes de renderizar. Se aprovar, ela será salva como imagem inicial da cena e ficará disponível na biblioteca.

### Clipe contínuo e fundo

**Gerar clipe contínuo** usa o quadro inicial da primeira cena e reúne as ações na ordem do projeto, com os tempos de cada cena no prompt. O LTX aceita até 20 segundos por clipe. O resultado fica em **Fila e vídeos** e é salvo como `sequencia.mp4`. A imagem inicial e as instruções de estilo ajudam a manter a aparência ao longo do clipe.

Em **Gerar ambiente**, marque **Gerar só o fundo, sem personagens** para preparar um cenário reutilizável. Selecione uma imagem de referência para orientar a composição, a paleta e a iluminação. Para começar o vídeo com o elenco já em quadro, use uma imagem inicial que inclua os personagens.

Em **Fila e vídeos → Salvar quadro**, escolha um clipe, o início ou o fim e um nome para a referência. O Aivid salva uma cópia na biblioteca do projeto. Selecione-a depois em **Imagem inicial** ou como referência em **Gerar ambiente**.

### Várias imagens de personagens

A biblioteca guarda todos os personagens individualmente. Na geração comum do LTX, porém, há **uma imagem inicial por cena**. Selecionar personagens inclui suas descrições no prompt; isso não faz o modelo consumir todas as imagens como referências visuais simultâneas.

Para uma cena com dois personagens, prefira uma imagem inicial já composta com os dois. É possível escolher só a imagem de um personagem como referência, mas ela pode não conter o cenário nem os outros personagens. O Z-Image Turbo do LTX gera ou transforma um quadro por vez. Envie uma composição visual quando quiser representar vários personagens pelas imagens em vez das descrições.

### Duração e continuidade

A duração manual aceita qualquer número inteiro de 2 a 20 segundos. Quando o LTX exige uma duração maior, o Aivid gera o próximo tempo compatível e recorta o arquivo ao tempo escolhido. Por exemplo, para 15 segundos, o LTX gera 20 e o Aivid salva um clipe de 15 segundos.

Cenas novas usam **Duração automática**. O Aivid estima o tempo a partir das ações e pausas descritas no prompt e mostra a estimativa enquanto você escreve. O valor usa os tempos disponíveis no LTX e tem limite de 20 segundos por clipe. Se precisar de um tempo específico, escolha os segundos no cartão da cena. Cenas já salvas com duração fixa mantêm esse valor até você escolher **Automática**.

No painel do projeto, adicione uma **imagem do ambiente**. Cenas com **Padrão do projeto** usam essa imagem quando geradas isoladamente. Em uma sequência com continuidade ativada, você pode escolher **Ambiente do projeto** em uma cena para voltar à imagem da locação. Use uma imagem própria para mudar de locação, enquadramento ou posição dos personagens.

A opção de continuidade está desligada por padrão. Quando ligada, usa o último quadro da cena anterior apenas se a próxima não tiver uma referência explícita. Ela não é necessária para clipes independentes e não garante identidade perfeita. Referências próprias por cena dão mais controle e evitam acumular alterações visuais.

### Saída

Cada execução cria uma subpasta exclusiva dentro da pasta escolhida:

```text
aivid-<data>-<id>/
  cena-01.mp4
  cena-01.json
  cena-02.mp4
  cena-02.json
```

Os JSONs registram o prompt e os parâmetros daquela geração. Gerar novamente preserva as versões anteriores. Cenas excluídas deixam de aparecer na sequência, mas os vídeos já exportados continuam na pasta de saída.

## Dados e privacidade

Projetos e cópias das imagens ficam em `~/Library/Application Support/Aivid/library/`. Os vídeos ficam na pasta de saída selecionada. Esses arquivos não fazem parte do repositório.

O Aivid se conecta somente ao backend do LTX em `127.0.0.1`. Descobre a porta nos logs do LTX e usa, em memória, a credencial de sessão do processo local. Não salva essa credencial em projetos, logs nem arquivos exportados. Não usa chave de API da nuvem. Antes de gerar, seleciona encoder local e desativa geração e aprimoramento de prompt por API no LTX; essas preferências ficam salvas no LTX.

Use um Aivid por vez e evite iniciar gerações simultaneamente pela interface do LTX. O LTX não oferece um bloqueio de fila exclusivo para aplicativos externos.

Se fechar o Aivid ou o LTX durante uma geração, ela pode ser interrompida. Na próxima abertura, trabalhos incompletos ficam marcados como interrompidos, sem reiniciar automaticamente. Deixe o Mac na tomada, com a tampa aberta e ventilação livre para trabalho noturno.

## Desenvolvimento e validação

```sh
npm run check
npm test
```

Arquitetura: Electron com renderer isolado, bridge de IPC com operações restritas, biblioteca JSON local, adaptador LTX no processo principal e protocolo de mídia com suporte a HTTP Range para o player. Não há servidor web público.

Os testes cobrem persistência das referências, validação de parâmetros, seleção de personagens no prompt, recuperação de jobs interrompidos, ordem e versões da playlist e leitura parcial de vídeo. Testes unitários não geram vídeos nem usam GPU. A geração real exige o LTX configurado.

## Licença

MIT para o código do Aivid. O LTX Desktop, os pesos e as imagens possuem suas próprias licenças.
