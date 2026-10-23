# Controle de RCs – aplicativo Windows (offline)

Controle de Requisições de Compra, entregas, cancelamentos, transferências e devoluções.
Funciona sem internet. Os dados ficam em arquivos JSON no seu computador.

> **Estado desta entrega (versão 1.1.0):** o código-fonte está completo; os **50 testes automatizados** (`npm test`) e os
> **15 cenários da interface real num navegador Chromium** (`ferramentas/teste-interface.js`) passam – ver
> `RELATORIO_TECNICO.md` §G. **O `.exe` ainda não foi compilado nem testado no Windows** – isso exige um PC Windows com
> internet (passos abaixo). O ambiente onde a atualização foi feita não tinha acesso para baixar o Electron.

## Correção 1.1.1 – janela vazia (só cor de fundo)

Em alguns PCs a janela da 1.1.0 abria sem conteúdo. A 1.1.1 desenha a tela sem a aceleração da placa de vídeo
(causa mais comum: driver de vídeo, máquina virtual, acesso remoto), mantém o idioma de reserva `en-US` do Chromium e,
se a tela ainda assim não carregar, mostra uma mensagem com o motivo e grava o detalhe em
`%LOCALAPPDATA%\ControleRC\logs\app.log`. Dados e funções iguais à 1.1.0. O arquivo gerado passa a se chamar
`ControleRC-Portatil-1.1.1.exe`.

## Novidades da versão 1.1.0

- **Ordenação por número da RC:** a lista abre em ordem numérica crescente (RC 1 → 2 → 3 → 10 → 11 → 20).
  O seletor ao lado dos filtros oferece crescente, decrescente e “mais recentes primeiro”; a escolha é lembrada.
  Os números das RCs não são alterados.
- **Maiúsculas automáticas:** material, unidade, observações, solicitante, responsável, origem e destino viram
  MAIÚSCULAS ao digitar ou colar (acentos preservados: `óleo hidráulico 68` → `ÓLEO HIDRÁULICO 68`).
  Não mudam: número da RC, busca, datas, quantidades. Na primeira abertura da 1.1.0 os registros antigos são
  padronizados, **com cópia do arquivo original** em `backups\eventos\<data>_padronizacao\`.
- **Manutenção** em Transferências: novo tipo no campo “Tipo” (Transferência, Devolução, Manutenção), com etiqueta
  azul, filtro por tipo acima da tabela e total no rodapé. Fica gravado no registro (`"tipo": "Manutenção"`), aparece
  na exportação CSV e continua lá ao fechar e reabrir. Os registros antigos não mudam.
- **Editar item de uma RC:** botão **Editar** em cada item → corrigir material, unidade e quantidade solicitada →
  **Revisar alteração** (mostra antes → depois) → **Confirmar alteração**. O número, as datas e os outros itens da RC
  não mudam; nenhuma RC nova é criada. Cada alteração fica no histórico da RC (data, valor anterior e novo) e as
  últimas aparecem no próprio diálogo de edição. Quantidade aceita só número inteiro maior que zero; material é
  obrigatório. Se o item mudou depois que a edição foi aberta, nada é sobrescrito e o app pede para reabrir.

**Atualizar da 1.0.0:** feche o app, **copie a pasta `%LOCALAPPDATA%\ControleRC` para um pendrive ou outra pasta**
(cópia de segurança manual) e rode o novo `.exe`. Os dados são mantidos. Guarde também o `.exe` antigo.
Para voltar à 1.0.0, basta rodar o `.exe` antigo: ele abre os arquivos da 1.1.0, mas descarta o histórico de edições
na primeira gravação.

## 0. O PC da empresa não tem internet? Faça assim

O PC da empresa **não precisa de internet nem de instalação**. Só é preciso gerar o `.exe` uma vez em **outro** PC:

**Opção A – outro PC Windows com internet (pode ser o seu, em casa):**
1. Instale o Node.js LTS (https://nodejs.org).
2. Copie esta pasta para lá e dê dois cliques em **`construir.bat`** (baixa, testa e compila; leva alguns minutos).
3. Pegue em `ENTREGA\` o arquivo **`ControleRC-Portatil-1.1.1.exe`** e o `SHA256.txt`.
4. Leve o `.exe` por pendrive ao PC da empresa e dê duplo clique: **não instala, não pede administrador**,
   e funciona sem internet. Os dados ficam em `%LOCALAPPDATA%\ControleRC` nesse PC.

**Opção B – sem nenhum PC com internet:** suba esta pasta num repositório **privado** do GitHub e rode o fluxo
`.github/workflows/gerar-exe-windows.yml` (Actions → *Gerar executável Windows* → Run workflow); baixe o resultado
em *Artifacts*. Atenção: o projeto contém `seed.json` (dados reais das RCs) – envie só se a política da empresa permitir.
(Este fluxo não foi executado por mim; ajustes podem ser necessários.)

**Se a empresa bloquear o `.exe`** (antivírus, SmartScreen, AppLocker): como ele não é assinado, o TI pode precisar
liberá-lo (use o hash SHA-256 de `ENTREGA\SHA256.txt` para identificá-lo). Sem esse recurso, o servidor Python
anterior (pasta `controle-rc`) continua funcionando, se o PC tiver Python.

## 1. Gerar o `.exe` (uma vez, num PC Windows com internet)

1. Instale o **Node.js LTS** (https://nodejs.org).
2. Abra o PowerShell na pasta do projeto e rode:
   ```powershell
   npm install          # baixa Electron e electron-builder e gera package-lock.json (guarde este arquivo)
   npm test             # deve mostrar: pass 51 / fail 0
   npm run dist         # gera em dist\ o instalador (NSIS) e a versão portátil (.exe)
   ```
3. **Antes de distribuir:** atualize `electron` no `package.json` para a versão estável suportada mais recente
   (a `^33` é só a base de partida), rode `npm install` e `npm test` de novo, e execute
   `ferramentas\auditoria.ps1` (npm audit, SBOM, Semgrep, Gitleaks, hash SHA-256).
4. Sem certificado de assinatura o Windows SmartScreen mostra “editor desconhecido”. Para assinar, configure
   `CSC_LINK`/`CSC_KEY_PASSWORD` (certificado de assinatura de código) antes de `npm run dist`.
5. O instalador **contém as RCs da planilha** (`seed.json`). Não o publique fora da empresa.

Para testar sem compilar: `npm start`.
Teste da interface num navegador (opcional, exige `npm install playwright`): usa a interface real e o armazenamento real
numa pasta temporária (não toca nos seus dados) e simula digitação, colagem, edição, MANUTENÇÃO e reabertura:
`node ferramentas\teste-interface.js "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`.
Ele não substitui abrir o `.exe` e conferir (veja a lista em `RELATORIO_TECNICO.md` §G.5).

## 2. Primeiro uso

Ao abrir pela primeira vez, o aplicativo cria a pasta de dados e importa as **281 RCs / 609 itens** da planilha
(uma única vez). Depois disso, tudo o que você lançar é salvo na hora.

Atalhos: **Ctrl+N** nova RC · **Ctrl+F** buscar · **Ctrl+1/2/3** trocar de aba.

## 3. Onde ficam os dados

Pasta padrão: `%LOCALAPPDATA%\ControleRC` (menu **Arquivo → Abrir pasta de dados**).

```
data\rcs.json               RCs e itens         { "schemaVersion": 1, "records": [ ... ] }
data\transferencias.json    transferências/devoluções
config\estado.json          configuração não sensível
backups\diario\AAAA-MM-DD\  cópia diária (últimos 14 dias)
backups\eventos\...         cópia automática ANTES de excluir RC, apagar tudo, importar ou migrar (últimas 30)
logs\app.log                log técnico (sem o conteúdo das RCs)
```

- Edições de material/unidade/quantidade ficam em `hist` dentro da própria RC no `rcs.json` (até 200 por RC). O campo
  só aparece em RCs editadas; o `schemaVersion` continua `1`.
- **O número da RC não é único.** Cada RC e cada item têm um `id` próprio (UUID). Duas RCs com o mesmo número
  coexistem (o app avisa ao cadastrar, e você confirma). Ex.: a planilha tem duas RCs 139429 em datas diferentes.
- Para trocar a pasta: botão **Alterar pasta dos dados** (rodapé). Os dados são copiados; se a pasta nova já tiver
  dados do app, ela passa a ser usada. A pasta antiga não é apagada. Pastas de rede (`\\servidor\...`), a raiz do
  disco e pastas do sistema são recusadas.
- Atualizar o app **não apaga os dados**: eles ficam fora da pasta de instalação.

## 4. Backup, exportação e restauração

- **Backup automático:** ao abrir, ao fechar e a cada hora (um por dia, sobrescrito) + cópias antes de operações destrutivas.
- **Backup manual:** feche o app e copie a pasta `ControleRC` inteira (ou **Exportar dados (JSON)** no rodapé).
- **Restaurar:** feche o app, copie de `backups\diario\<data>\` (ou `backups\eventos\...`) os arquivos `rcs.json` e
  `transferencias.json` para `data\`, e `estado.json` para `config\`. Se um arquivo ficar ilegível, o app tenta
  recuperar sozinho do `.bak` e dos backups e avisa; o arquivo ruim é preservado como `*.corrompido-<hora>`.
  Se não houver nenhuma cópia válida, o app **não inicia** (para nunca sobrescrever dados com um arquivo vazio).
- **Importar JSON:** botão **Importar dados (JSON)**. O arquivo é validado por inteiro antes de gravar; se qualquer
  registro for inválido nada é importado. Registros cujo `id` já existe são ignorados (importar duas vezes não duplica).

## 5. Migrar do servidor antigo (Python/SQLite)

```powershell
python ferramentas\migrar_sqlite_para_json.py "C:\...\controle.db" "$env:LOCALAPPDATA\ControleRC"
```
Feche o app antes. O banco original não é alterado.

## 6. Limitações de segurança (leia)

- Os arquivos JSON ficam **sem criptografia**: qualquer programa executado com o seu usuário do Windows pode lê-los.
  Se isso for um risco, use o BitLocker no disco e uma conta de usuário protegida por senha.
- O app é offline: nenhuma requisição de rede é permitida (bloqueada no processo principal e pela CSP).
- Duas instâncias não abrem ao mesmo tempo. Não coloque a pasta de dados em nuvem sincronizada (OneDrive/Drive)
  nem a compartilhe entre computadores: gravações simultâneas podem corromper os arquivos.
