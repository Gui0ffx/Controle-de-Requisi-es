'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store, HttpError, MAX_JSON_BYTES, validarRaiz } = require('./storage');

const DEV = !app.isPackaged;
const INDEX_URL = pathToFileURL(path.join(__dirname, 'src', 'index.html')).href;
const METODOS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

let store = null;
let win = null;

// 1.1.1: desenha a tela sem usar a placa de vídeo. Evita a janela vazia (só a cor de fundo) em PCs com driver
// de vídeo antigo/bloqueado, máquina virtual ou acesso remoto. O app é simples; não há perda perceptível.
app.disableHardwareAcceleration();

// ---------- pasta de dados ----------
const ponteiro = () => path.join(app.getPath('userData'), 'ponteiro.json');
const raizPadrao = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ControleRC');
function raizEscolhida() {
  try {
    const salvo = JSON.parse(fs.readFileSync(ponteiro(), 'utf8')).raiz;
    return validarRaiz(salvo);
  } catch (_) { return raizPadrao(); }
}
function lembrarRaiz(raiz) {
  fs.mkdirSync(path.dirname(ponteiro()), { recursive: true });
  fs.writeFileSync(ponteiro(), JSON.stringify({ raiz }), 'utf8');
}

// ---------- endurecimento global ----------
function endurecerSessao() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // O aplicativo é 100% offline: qualquer requisição de rede é cancelada.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (d, cb) => {
    if (store) store.log('aviso', 'rede_bloqueada', { esquema: d.url.split(':')[0] });
    cb({ cancel: true });
  });
}
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (url.split('#')[0] !== INDEX_URL) e.preventDefault(); });
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------- IPC ----------
const remetenteValido = (e) => {
  try { return e.sender === win.webContents && e.senderFrame.url.split('#')[0] === INDEX_URL; } catch (_) { return false; }
};
const dataHoje = () => new Date().toISOString().slice(0, 10);

function gravarArquivoUsuario(arquivo, texto) {
  fs.writeFileSync(arquivo, texto, 'utf8');
  if (fs.statSync(arquivo).size !== Buffer.byteLength(texto, 'utf8')) throw new Error('verificação da gravação falhou');
}

async function rotear(metodo, url, corpo) {
  const p = new URL(url, 'http://local').pathname;
  if (metodo === 'POST' && p === '/api/pasta') {
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha a pasta onde salvar os dados do Controle de RCs',
      defaultPath: store.raiz, properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { cancelado: true, pasta: store.raiz };
    const res = store.trocarRaiz(r.filePaths[0]);
    lembrarRaiz(store.raiz);
    return res;
  }
  if (metodo === 'POST' && p === '/api/abrir-pasta') {
    await shell.openPath(store.raiz);
    return { ok: true };
  }
  if (metodo === 'POST' && (p === '/api/exportar' || p === '/api/exportar-json')) {
    const csv = p === '/api/exportar';
    const dados = csv ? store.tratar('POST', url, corpo) : { csv: store.exportarJson(), nome: 'controle-rc-' + dataHoje() + '.json' };
    const r = await dialog.showSaveDialog(win, {
      title: 'Salvar arquivo', defaultPath: path.join(app.getPath('documents'), dados.nome),
      filters: [csv ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { cancelado: true };
    gravarArquivoUsuario(r.filePath, dados.csv);
    store.log('info', csv ? 'exportacao_csv' : 'exportacao_json');
    return { ok: true, arquivo: path.basename(r.filePath) };
  }
  if (metodo === 'POST' && p === '/api/importar-json') {
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha o arquivo JSON para importar', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { cancelado: true };
    const arq = r.filePaths[0];
    if (fs.statSync(arq).size > MAX_JSON_BYTES) throw new HttpError(400, 'arquivo JSON muito grande');
    return store.importarJson(fs.readFileSync(arq, 'utf8'));
  }
  return store.tratar(metodo, url, corpo);
}

ipcMain.handle('rc:request', async (e, metodo, url, corpo) => {
  if (!remetenteValido(e)) return { __erro: true, status: 403, erro: 'origem não autorizada' };
  if (typeof metodo !== 'string' || !METODOS.has(metodo) || typeof url !== 'string' || url.length > 300 || !url.startsWith('/api/')) {
    return { __erro: true, status: 400, erro: 'requisição inválida' };
  }
  try {
    return await rotear(metodo, url, corpo);
  } catch (err) {
    if (err instanceof HttpError) return { __erro: true, status: err.status, erro: err.message };
    store.log('erro', 'falha_operacao', { codigo: err.code || 'desconhecido' });
    return { __erro: true, status: 500, erro: 'Não foi possível concluir a operação.' };
  }
});

// ---------- janela e menu ----------
// ---------- diagnóstico da tela (1.1.1) ----------
let avisouFalha = false;
function falhaTela(motivo) {
  if (avisouFalha || !win || win.isDestroyed()) return;
  avisouFalha = true;
  const log = store ? path.join(store.raiz, 'logs', 'app.log') : '';
  dialog.showMessageBox(win, {
    type: 'error', title: 'Controle de RCs', buttons: ['Tentar de novo', 'Fechar'], defaultId: 0, cancelId: 1,
    message: 'A tela do aplicativo não pôde ser exibida.',
    detail: motivo + '\n\nSeus dados não foram alterados.\nDetalhes técnicos em:\n' + log,
  }).then((r) => {
    avisouFalha = false;
    if (r.response === 0 && win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'src', 'index.html'));
    else app.quit();
  }).catch(() => app.quit());
}
function vigiarTela(wc) {
  wc.on('did-fail-load', (_e, codigo, descricao, _url, principal) => {
    if (!principal) return;
    store.log('erro', 'tela_nao_carregou', { codigo, descricao });
    falhaTela('Falha ao carregar a tela (' + descricao + ', código ' + codigo + ').');
  });
  wc.on('render-process-gone', (_e, d) => {
    store.log('erro', 'tela_encerrada', { motivo: d && d.reason, codigo: d && d.exitCode });
    falhaTela('O processo da tela foi encerrado (motivo: ' + (d && d.reason) + '). Um antivírus ou bloqueio do Windows pode ter impedido a execução.');
  });
  wc.on('preload-error', (_e, _p, err) => store.log('erro', 'preload_falhou', { msg: err && err.message }));
  wc.on('console-message', (e, nivel, msg) => {           // Electron 33: argumentos; versões novas: no evento
    const n = typeof nivel === 'number' ? nivel : e && e.level;
    if (n === 3 || n === 'error') store.log('erro', 'erro_na_tela', { msg: typeof msg === 'string' ? msg : e && e.message });
  });
  wc.on('did-finish-load', () => store.log('info', 'tela_carregada'));
}
app.on('child-process-gone', (_e, d) => {
  if (store) store.log('erro', 'processo_encerrado', { tipo: d && d.type, motivo: d && d.reason, codigo: d && d.exitCode });
});

function criarJanela() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#EDF0F3',
    title: 'Controle de RCs', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, devTools: DEV,
    },
  });
  vigiarTela(win.webContents);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (store.avisos.length) {
      dialog.showMessageBox(win, { type: 'warning', title: 'Controle de RCs', message: 'Aviso sobre os dados', detail: store.avisos.join('\n') });
    }
  });
}
function criarMenu() {
  const modelo = [
    { label: 'Arquivo', submenu: [
      { label: 'Abrir pasta de dados', click: () => shell.openPath(store.raiz) },
      { type: 'separator' }, { role: 'quit', label: 'Sair' }] },
    { label: 'Editar', submenu: [{ role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
      { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' }] },
    { label: 'Exibir', submenu: [{ role: 'zoomIn', label: 'Aumentar' }, { role: 'zoomOut', label: 'Diminuir' }, { role: 'resetZoom', label: 'Tamanho normal' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tela cheia' }] },
    { label: 'Ajuda', submenu: [{ label: 'Sobre', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Sobre', message: 'Controle de RCs ' + app.getVersion(),
      detail: 'Funciona offline. Dados salvos em:\n' + store.raiz }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(modelo));
}

function iniciar() {
  endurecerSessao();
  try {
    store = new Store(raizEscolhida(), { seedPath: path.join(__dirname, 'seed.json') });
  } catch (e) {
    dialog.showErrorBox('Controle de RCs – dados ilegíveis', e.message + '\n\nOs arquivos não foram alterados. Restaure um backup (veja LEIA-ME) ou contate o suporte.');
    app.quit();
    return;
  }
  lembrarRaiz(store.raiz);
  store.log('info', 'inicio', { versao: app.getVersion(), electron: process.versions.electron, windows: process.getSystemVersion(), idioma: app.getLocale() });
  try { store.backupDiario(); } catch (e) { store.log('erro', 'backup_falhou', { codigo: e.code || 'desconhecido' }); }
  setInterval(() => { try { store.backupDiario(); } catch (_) { /* registrado no próximo início */ } }, 60 * 60 * 1000).unref();
  criarMenu();
  criarJanela();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(iniciar);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { try { if (store) store.backupDiario(); } catch (_) { /* melhor esforço */ } });
}
