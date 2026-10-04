# protanki-spawns

Captura headless, mapa a mapa, de dois dados que o `map.xml` do ProTanki não tem e que só
existem no servidor:

- **spawn de players** — onde os tanques nascem, por modo e por time;
- **spawn de suprimentos** — onde as caixas (medkit, nitro, armorup, damageup, crystal) caem,
  e as zonas fixas de gold box.

Um bot (`lib/BotClient.js`) fala o protocolo do jogo direto com o servidor, sem o client Flash:
cria uma batalha **privada** por mapa, entra, escuta o que precisa e sai. Ele nunca manda
pacote de movimento nem de tiro.

## Como rodar

```bash
npm install
cp accounts.example.json accounts.json      # contas; conta COM PASSE para batalha privada
```

Copie o `node.exe` para a raiz do repositório com o nome **`ProTanki.exe`** e rode os scripts
por ele. O NoPing faz o túnel pelo nome do executável: com `node` puro o servidor aceita o TCP
e fecha a conexão sem mandar as chaves (`timeout no handshake de chaves`).

```bash
./ProTanki.exe scripts/bonus-sweep.js --dry-run            # fila e quem alcança cada mapa
./ProTanki.exe scripts/bonus-sweep.js                      # captura de suprimentos
./ProTanki.exe scripts/spawn-sweep.js --modes DM           # spawn de players
node scripts/status.js                                     # estado do acervo
node scripts/viewer.js                                     # http://localhost:8777
```

Todas as contas do `accounts.json` rodam em paralelo puxando da mesma fila. Cada uma só pega
mapa dentro do seu rank (a batalha herda a faixa de rank do mapa). `--accounts c2,c3` limita por
label.

## Suprimentos (`scripts/bonus-sweep.js`)

Uma sessão por mapa, só DM. A batalha é privada, 1 vaga, pró, com todos os bônus ligados e
**Caixa de bônus em cronômetro preciso** (`esportDropTiming`): a caixa cai a cada ~7 s. O bot
entra sem spawnar e escuta por 4 min 50 s (o servidor expulsa quem não spawnou em 5 min).

A posição da queda é aleatória dentro de uma região desenhada no editor de mapa, então o que se
guarda é o **tipo**, a **bbox** por tipo, as **zonas** (bbox agrupadas por proximidade) e uma
amostra das posições. Zonas de gold (`SpawnBonusRegion`) são fixas e vêm inteiras.

Conta sem passe é descartada: sem passe a batalha sai pública e outro jogador poderia pegar
caixa no meio da coleta.

## Spawn de players (`scripts/spawn-sweep.js`)

Entra e sai da mesma batalha até o critério de parada fechar (janela dinâmica sem ponto novo,
mínimo de capturas por ponto, teto proporcional ao tamanho do mapa). Lê o ponto no
`PrepareToSpawn`, que chega ~5 s antes do `Spawn` com a mesma posição. Em modos por time grava
no time que o servidor atribuiu, não no pedido. Também captura bandeiras (CTF) e pontos de
controle (CP) na entrada.

## Saída

Um arquivo por mapa em `spawns/<map_id>.json` (versionado):

```jsonc
{
  "mapId": "map_sandbox",
  "modes": { "DM": { "NONE": [ { "x", "y", "z", "yaw", "count" } ] } },
  "bonus": {
    "capture": { "account", "battleId", "startedAt", "listenMs", "drops", "finishedAt" },
    "types": { "nitro": 12, "medkit": 9 },
    "region": { "nitro": { "minX", "maxX", "minY", "maxY", "minZ", "maxZ" } },
    "zones": { "nitro": [ { "minX", "maxX", "minY", "maxY", "minZ", "maxZ", "cx", "cy", "cz", "samples" } ] },
    "drops": { "nitro": [ { "x", "y", "z", "count" } ] },
    "goldRegions": [ { "x", "y", "z", "yaw", "bonusType", "count" } ]
  },
  "ctf": { "variants": [ { "red", "blue", "count" } ] },
  "cp": { "keypointTriggerRadius", "keypointVisorHeight", "minesRestrictionRadius", "points": [] }
}
```

Progresso retomável em `state/` (fora do git). Coordenadas em unidades do jogo; `yaw` em
radianos normalizado para (-π, π].

## Decisões que valem registro

- `CreateBattleResponse` é broadcast do lobby (um para cada batalha que qualquer jogador
  cria). A nossa é identificada pelo **nome único** mandado no pedido, nunca pelo primeiro
  `SelectPacket` — logo após o login o lobby auto-seleciona uma batalha da lista.
- Depois de entrar, o `InitBattlefieldModel` confere `map_id`; mapa diferente aborta a sessão.
- Nada de rajada: cada `EnterBattle` só sai depois que o servidor confirmou a volta ao lobby.
  Rajada derruba o socket sem aviso.
- Criar batalha tem limite de 3 a cada 5 min por conta; entrar e sair não tem.
