# Relatório técnico – Controle de RCs (versão desktop)

> **Versão atual: 1.1.1** (correção da janela vazia, §H). As seções A–F descrevem a versão 1.0.0 (números de testes da época). As mudanças da 1.1.0
> e os testes executados nela estão em **§G**, no fim deste documento.

**Leia primeiro – o que foi e o que NÃO foi feito.** Este relatório separa evidência real de pendência. O ambiente de
desenvolvimento era Linux, sem internet, sem Windows e sem Electron instalado. Portanto:

| Item exigido | Situação |
|---|---|
| Código-fonte completo (Electron, armazenamento JSON, interface) | **Entregue** |
| Testes automatizados (dados, interface, configuração de segurança) | **Executados: 34 aprovados, 0 reprovados** (`npm test`) |
| Gerar o `.exe` / instalador | **NÃO executado** (precisa de Windows + internet; ver `LEIA-ME.md`) |
| Testar o `.exe` no Windows, reinicialização do PC, resoluções de tela | **NÃO executado** |
| `npm audit`, SBOM, lockfile | **NÃO executado** (sem acesso ao registro npm) – script pronto em `ferramentas/auditoria.ps1` |
| Semgrep, Gitleaks, antivírus, monitoramento de rede em execução | **NÃO executado** (ferramentas indisponíveis) – substituídos por testes estáticos próprios, que **não** equivalem a essas ferramentas |
| Assinatura digital, hash SHA-256 do `.exe` | **NÃO aplicável ainda** (não há `.exe`) |
| Não há como afirmar que o aplicativo é “seguro”: apenas que os controles abaixo existem e foram testados. | |

## A. Diagnóstico inicial e arquitetura

**HTML original** (`index.html`, SHA-256 `eb21256c…260f`, mantido intacto em `/uploads`): painel com totais mensais,
lista de RCs com itens (entregue, cancelado, observações, situação), filtros, transferências/devoluções, exportação CSV,
apagar tudo. Dependia de um servidor local (`/api/*`), carregava **fonte do Google** (recurso externo), usava
**handlers inline** (`onclick=`), IDs gerados com `Math.random`, tratava o **número da RC como único**, e continha
dados de demonstração mortos no código. Dados reais: planilha `Controle_de_Requisicoes…xlsx`
(SHA-256 `a1879426…ab22`), 609 linhas de itens.

**Decisão: Electron** (em vez de Tauri). Motivos: a interface já é HTML/JS puro (reaproveitada quase inteira);
o processo principal em Node faz gravação atômica de arquivos sem exigir Rust/MSVC para manter o projeto;
`electron-builder` gera instalador sem privilégio de administrador. Custo aceito: pacote maior (~80–100 MB) e a
obrigação de acompanhar as atualizações de segurança do Electron. Tauri seria menor, mas exigiria reescrever a camada
nativa em Rust e instalar a cadeia Rust+WebView2 para quem for compilar.

**Arquitetura:** `main.js` (processo principal: janela, rede bloqueada, IPC validado, diálogos nativos) →
`storage.js` (única camada que toca em arquivos; valida tudo) ← `preload.js` (expõe só `rcApi.request`) ←
`src/` (interface, sem scripts inline). `contextIsolation`, `sandbox`, sem `nodeIntegration`, CSP restritiva,
DevTools só em desenvolvimento, navegação/novas janelas/webview bloqueados, permissões do navegador negadas,
instância única, sem `child_process`, sem atualização automática, sem telemetria.

## B. Bugs e falhas corrigidos

| # | Problema (causa raiz) | Correção | Teste de regressão |
|---|---|---|---|
| 1 | **XSS armazenado**: `chip()` inseria texto sem escapar; o campo “tipo” da movimentação vem dos dados (ex.: JSON importado) e executaria HTML. | `chip()` escapa texto e classe. | `renderer.test` “XSS” (falhou antes da correção, passa agora) |
| 2 | **Número da RC tratado como único**: bloqueava RCs legítimas repetidas e, na minha conversão anterior, a RC 139429 (duas RCs, datas e solicitantes diferentes) tinha sido **fundida em uma**. | Identidade por `id`; planilha reimportada separando por (número + data); duplicidade só gera aviso. | `storage` #2, #3; `renderer` “mesmo número” |
| 3 | IDs com `Math.random` (7 caracteres): risco de colisão e de sobrescrever registro. | `crypto.randomUUID()` + rejeição de id repetido em todo o arquivo. | `storage` #3 |
| 4 | Dependência externa (Google Fonts) quebra o modo offline e vaza acesso. | Removida; pilha de fontes do sistema (Segoe UI). | `seguranca` “sem recursos remotos” |
| 5 | Handlers inline impediam CSP estrita. | Delegação de eventos com `data-*` e lista fechada de ações. | `seguranca` CSP; `renderer` “nenhum handler inline” |
| 6 | Exportação CSV vulnerável a **injeção de fórmula** (`=`, `+`, `-`, `@`). | Neutralização no processo principal. | `storage` #16 |
| 7 | Dados de demonstração mortos (`seed()`), polling a cada 4 s sem necessidade, código de migração do `localStorage` do navegador. | Removidos. | revisão + suíte |
| 8 | Gravação sem garantia de atomicidade/recuperação. | Arquivo temporário → fsync → releitura → `.bak` → rename; recuperação e recusa de abrir arquivo ilegível. | `storage` #8–#11 |

Observação de regra de negócio **não alterada** (decisão sua): a interface aceita quantidade entregue maior que a
solicitada (a pendência vira 0). A planilha original não tem esse caso (testado), mas o app não o impede.

## C. Auditoria de segurança

**Executado de fato:** `node --check` em todos os arquivos; 7 testes estáticos (`test/seguranca.test.js`) – CSP sem
`unsafe-inline`/`unsafe-eval` em scripts, ausência de `eval`/`Function`/`document.write`/`javascript:`, ausência de URL
remota e de módulos de rede/processo, flags do Electron, superfície do preload, `package.json` sem dependências de
execução nem scripts de instalação, ausência de segredos por regex; testes dinâmicos de entrada maliciosa
(`__proto__`, traversal em id e caminho, HTML/script em todos os campos, JSON profundo/gigante/inválido).

**Riscos residuais / pendências:**
1. Sem `npm audit`/SBOM/lockfile: **a versão `^33` do Electron é um ponto de partida** (pode estar fora de suporte); atualizar e auditar antes de distribuir.
2. `style-src-attr 'unsafe-inline'` é mantido porque a interface usa `style="…"` (larguras de barras). Não permite scripts; risco baixo, mas é uma concessão.
3. JSON em texto puro: legível por qualquer processo do mesmo usuário Windows. Mitigação recomendada: BitLocker + conta com senha. Criptografia própria foi deliberadamente **não** implementada; se necessária, usar `safeStorage` do Electron (DPAPI) em evolução futura.
4. `seed.json` (dados reais) vai dentro do instalador. Pode ser removido após a primeira instalação em todos os PCs.
5. Não verificado: tráfego de rede e acessos a arquivos do app em execução, reputação/antivírus, instalador e desinstalador, assinatura.
6. Falha de disco no meio de uma operação que grava dois arquivos (apagar tudo/importar) pode deixar só um deles atualizado; há cópia anterior em `backups\eventos`.

## D. Armazenamento local

Ver `LEIA-ME.md` §3–§4. Esquema `schemaVersion: 1`; RC = `{id, num, dsol, dent, sol, items[], createdAt, updatedAt}`;
item = `{id, desc, un, qs, qe, canc, obs}`; movimentação = `{id, date, tipo, desc, un, qty, port, orig, dest, createdAt, updatedAt}`.
Migração: `_migrar()` em `storage.js` (versão futura é recusada; formato antigo é convertido com cópia prévia).
Limites: 20.000 registros, 500 itens por RC, JSON de importação até 20 MB e profundidade 8.

## E. Testes executados (`npm test` → 34 aprovados, 0 reprovados)

Armazenamento (19): primeiro início com a planilha (281 RCs, 609 itens, totais 141.179/120.748 idênticos ao Excel);
RC repetida; ids duplicados; cadastrar/editar/excluir; reabrir; acentos/emoji; validação de campos; arquivo corrompido
com e sem backup; backup diário e snapshot antes de apagar; falha de gravação (EIO); disco cheio (ENOSPC) e sem
permissão (EACCES) *simulados*; caminhos proibidos (Windows simulado com `path.win32`); exportar/importar JSON;
JSON inválido/malicioso; migração; CSV; troca de pasta; log sem conteúdo sensível; volume (3.000 RCs/15.000 itens:
importar ~0,2 s, alterar 1 item ~40 ms, abrir ~80 ms).
Interface (8): totais, filtros mês/solicitante/busca, XSS, ausência de handlers inline, delegação de eventos, atalhos.
Segurança estática (7): ver §C.

**Não executados:** instalação limpa e primeiro início no Windows; reinicialização do PC; `.exe` compilado;
atualização com persistência real; tráfego de rede; resoluções/redimensionamento de janela; falta de permissão real
(simulada, pois o ambiente roda como administrador); antivírus.

## F. Entrega

- Projeto: `controle-rc-desktop/` (e `controle-rc-desktop.zip`). Lista de hashes SHA-256 dos arquivos-fonte: `SHA256SUMS.txt`.
- `.exe` / instalador: **não gerados** – seguir `LEIA-ME.md` §1. Hash e assinatura: gerados por `ferramentas/auditoria.ps1` após a compilação.
- Backup/restauração e atualização sem perda: `LEIA-ME.md` §4 (os dados ficam fora da pasta de instalação).

**Critérios de aceitação ainda abertos:** compilar o `.exe`, testá-lo no Windows, executar `npm audit`/SBOM/Semgrep/Gitleaks
e verificar a ausência de tráfego de rede no app em execução.

## G. Atualização 1.1.0 (ordenação, maiúsculas, MANUTENÇÃO, edição de item)

Feita sobre o código existente: mesma arquitetura (Electron → `storage.js` → JSON), mesmo visual, mesmas rotas.
Nada foi removido. Ponto de partida encontrado: a ordenação por número já existia parcialmente no `app.js`
(padrão era “mais recentes”); MANUTENÇÃO, maiúsculas e edição de item **não existiam**, embora o LEIA-ME 1.1.0 anterior
os descrevesse – este relatório substitui as afirmações daquele texto que não tinham código correspondente.

### G.1 O que mudou

| Requisito | Implementação | Arquivos |
|---|---|---|
| 2.1 Ordenação | Padrão passou a ser **número crescente**; opções crescente/decrescente/mais recentes; comparação `localeCompare(..., {numeric:true})` (2 < 10 < 100, números de tamanhos diferentes, RCs com o mesmo número ficam juntas). Reaplicada a cada renderização (abrir, cadastrar, editar). Filtros e busca inalterados. | `src/app.js` |
| 2.2 Maiúsculas | Interface: campos com `data-up` convertem no evento `input` (digitação e colagem), recalculando cursor/seleção; ignora composição IME. Dados: `storage.js` grava texto livre em maiúsculas em toda entrada (tela, importação JSON, planilha). Arquivo antigo com minúsculas é padronizado uma vez, **depois** de copiar o original para `backups/eventos/<data>_padronizacao/`. Número da RC, datas, quantidades, ids e tipo não mudam. | `src/app.js`, `src/index.html`, `storage.js` |
| 2.3 MANUTENÇÃO | Nova opção no campo Tipo; gravada como `"tipo": "Manutenção"`; etiqueta própria (azul, claro/escuro); filtro por tipo; total no rodapé; CSV. Variações de escrita importadas (“MANUTENCAO”) são normalizadas; tipos desconhecidos antigos são mantidos como estão. | `src/app.js`, `src/style.css`, `storage.js` |
| 2.4 Editar item | Botão **Editar** por item → diálogo com material, unidade, quantidade solicitada → **Revisar** (tabela antes → depois, aviso se a quantidade entregue ficar maior) → **Confirmar**. `PATCH /api/item/:id` altera só aquele item (id, número, datas, outros itens intactos; nenhuma RC criada). Validação dupla (tela e armazenamento): material obrigatório ≤ 300, unidade ≤ 20, quantidade inteiro 1…10⁹ (recusa “abc”, “2,5”, “-1”, “0”, “1e3”). Proteção contra alteração concorrente (valores esperados → 409). Histórico `hist` na RC (data, campo, de, para; até 200). Botão desabilitado durante a gravação (sem duplo envio). Erro de gravação: mensagem no diálogo, dados anteriores mantidos. | `src/app.js`, `src/index.html`, `src/style.css`, `storage.js` |

Também: `package.json` (versão 1.1.0), `LEIA-ME.md`, este relatório, `SHA256SUMS.txt`, testes novos e
`ferramentas/teste-interface.js`, `ferramentas/compat/storage-1.0.0.js` (cópia da 1.0.0 usada só no teste de compatibilidade).
**Não alterados:** `main.js`, `preload.js`, `logger.js`, `seed.json`, ícones, `construir.bat`, fluxo do GitHub Actions.

### G.2 Dados e JSON

- `schemaVersion` continua **1**; estrutura dos arquivos igual. Único campo novo: `hist` (opcional, só em RCs editadas).
- Compatibilidade testada nos dois sentidos: a 1.1.0 abre arquivos da 1.0.0; o `storage.js` da 1.0.0 abre arquivos da
  1.1.0 (descarta `hist` na próxima gravação dele).
- Toda gravação continua atômica (temporário → fsync → releitura → `.bak` → rename) e só é confirmada depois do disco;
  falha de gravação recarrega o estado do disco. `hist` malformado no arquivo é tratado como arquivo ilegível
  (recuperação pelo `.bak`/backups, como os demais campos).
- Ids e números das RCs nunca são reescritos; a padronização altera apenas o texto livre (e guarda o original).

### G.3 Testes executados de verdade (23/10/2026, Linux, Node 22.22)

**`npm test` → 50 aprovados, 0 reprovados** (34 anteriores + 16 novos). Testes anteriores que verificavam texto em
minúsculas (`'ok'`, `'Persistente'`, CSV etc.) foram ajustados para o comportamento novo (maiúsculas), mantendo o que
cada um verificava.

Novos – dados (`test/v110-storage.test.js`, 10): maiúsculas com acentos e campos que não mudam; padronização de arquivo
antigo com cópia idêntica do original, uma única vez, ids preservados; planilha (281/609) intacta; importação JSON;
MANUTENÇÃO (gravar, reabrir, CSV, variação de escrita, tipos antigos); editar material/unidade/quantidade só no item
escolhido, histórico, persistência; 15 quantidades e 5 materiais inválidos recusados sem tocar no disco; alteração
concorrente (409); falha de disco (EIO) sem alterar memória nem arquivo; limite de 200 no histórico e recuperação com
`hist` corrompido; compatibilidade com o `storage.js` 1.0.0.

Novos – interface com DOM simulado (`test/renderer.test.js`, 6): ordem padrão crescente; conversão com cursor/seleção
(incluindo `ß → SS`); quais campos têm `data-up`; MANUTENÇÃO (opção, etiqueta, filtro, totais); registrar pela tela;
fluxo completo de edição com inválidos.

**Interface real em navegador (`node ferramentas/teste-interface.js`) → 15 aprovados, 0 reprovados**, Chromium 153
sem interface, `index.html` com a CSP original, ligado ao `storage.js` real numa pasta temporária. Cobre a lista
obrigatória do pedido: ordem ao abrir e após cadastrar (2, 10, 1000000); digitação em minúsculas (inclusive no meio do
texto e sobre seleção); **colagem real com Ctrl+V** de texto acentuado; MANUTENÇÃO cadastrada, filtrada e presente após
fechar e reabrir; editar nome; editar quantidade e reabrir; RC com vários itens; campos vazios e quantidades inválidas;
número original preservado; registros antigos acessíveis (281); erro de gravação simulado com dados preservados e nova
tentativa; alteração concorrente; regressão (entregue, observação, busca, excluir, painel); conteúdo malicioso exibido
como texto; nenhum erro de JavaScript nem violação de CSP.

Inspeção visual (capturas): lista, diálogo de edição e transferências em tema claro, escuro e tela estreita.

### G.4 Limitações e pendências (honestas)

1. **O `.exe` não foi gerado nem aberto.** O ambiente não tinha acesso ao registro npm nem ao GitHub (bloqueio de rede),
   então o Electron não pôde ser instalado. Os testes acima exercitam a interface e os dados, mas **não** o processo
   principal do Electron (menus, diálogos nativos, bloqueio de rede, instância única) na versão 1.1.0 – esse código não
   foi alterado. Gerar com `construir.bat` (que roda os 50 testes antes de compilar) e conferir a lista G.5.
2. **Controle de acesso:** o aplicativo não tem usuários nem permissões (é monousuário, local). O botão Editar fica
   disponível para quem usa o app, como os demais campos editáveis que já existiam. Criar login seria uma mudança de
   arquitetura que não foi pedida explicitamente; se for necessária, precisa de definição (quem pode editar o quê).
3. Transferências continuam **sem edição** (só cadastrar e excluir), como na 1.0.0; o tipo MANUTENÇÃO foi integrado a
   esse fluxo. Para corrigir uma movimentação, exclua e registre de novo.
4. A conversão para maiúsculas feita pelo programa reinicia o “Desfazer” (Ctrl+Z) do campo durante a digitação.
5. Na primeira abertura da 1.1.0 o texto livre antigo é regravado em maiúsculas (com cópia do original). Quem precisar
   do texto original encontra-o em `backups\eventos\<data>_padronizacao\`.
6. Seguem valendo os riscos residuais da §C (Electron `^33` a atualizar, JSON sem criptografia etc.).

### G.5 Conferência manual sugerida no Windows (após gerar o `.exe`)

Abrir o `.exe` → lista em ordem crescente → nova RC com “óleo hidráulico 68” (vira maiúsculas) → Transferências:
registrar MANUTENÇÃO → Editar um item (revisar/confirmar) → fechar o app → abrir de novo e conferir os três →
verificar `%LOCALAPPDATA%\ControleRC\backups\eventos\` (cópia `_padronizacao`, se havia minúsculas).

## H. Correção 1.1.1 – janela abre só com a cor de fundo

**Sintoma relatado (23/10/2026):** o `.exe` 1.1.0 gerado pelo GitHub Actions abre a janela com título e menu, mas a área
interna fica só com a cor de fundo (#EDF0F3), sem nem o cabeçalho estático do `index.html`. Isso indica que a página não
foi desenhada ou o processo da tela falhou – não é erro nos dados nem no `app.js` (o cabeçalho não depende deles).

**Causa provável (não confirmada no PC afetado):** composição pela GPU (driver, VM, acesso remoto) ou processo de tela
encerrado. Contribuição possível: o build mantinha só o idioma `pt-BR` do Chromium, sem o `en-US` de reserva.

**Mudanças (`main.js`, `package.json`):** `app.disableHardwareAcceleration()` antes de o app iniciar; `electronLanguages`
passa a incluir `en-US`; diagnóstico: `did-fail-load`, `render-process-gone`, `preload-error`, erros do console da tela e
`child-process-gone` vão para `logs/app.log` (sem conteúdo das RCs) e, se a tela falhar, o usuário vê uma mensagem com
o motivo e a opção “Tentar de novo”; registro de início com versão, Windows e idioma.

**Testes:** `npm test` → 51 aprovados (1 novo de configuração). `main.js` executado com um Electron simulado: aceleração
desligada antes da inicialização, janela criada, os cinco eventos de falha registrados no log e a mensagem exibida.
**Não testado:** o Electron real/`.exe` (mesmo bloqueio de rede da §G.4). Se a janela continuar vazia, o `app.log`
dirá qual dos eventos ocorreu.

