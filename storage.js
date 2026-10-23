'use strict';
/**
 * Armazenamento local em JSON do Controle de RCs  (schemaVersion 1).
 *
 * <raiz>/data/rcs.json              { schemaVersion, records: [ RC com itens ] }
 * <raiz>/data/transferencias.json   { schemaVersion, records: [ movimentações ] }
 * <raiz>/config/estado.json         { schemaVersion, populado }   (configuração não sensível)
 * <raiz>/backups/diario/AAAA-MM-DD/ cópia diária (14 dias)
 * <raiz>/backups/eventos/<data>_<motivo>/  cópia ANTES de operações destrutivas (30 últimas)
 * <raiz>/logs/app.log               log técnico sem conteúdo das RCs
 *
 * Regras de integridade
 *  - O NÚMERO DA RC NÃO É ÚNICO. A identidade é o `id` (UUID); cada item tem `id` próprio,
 *    único em todo o arquivo. Nada é descartado por repetir número.
 *  - Escrita atômica: arquivo temporário -> fsync -> releitura/validação -> cópia .bak da
 *    versão anterior -> rename. A operação só é confirmada depois disso.
 *  - Todo dado recebido (interface ou JSON importado) é normalizado por lista de campos
 *    permitidos: tipos, tamanhos, datas e ids. Campos desconhecidos são descartados.
 *  - Arquivo ilegível nunca é sobrescrito por um vazio: é preservado como
 *    *.corrompido-<timestamp> e recuperado do .bak ou dos backups.
 *  - (1.1.0) Campos de texto livre são gravados em MAIÚSCULAS (acentos preservados). Número da RC,
 *    datas, quantidades, ids e "tipo" não mudam. Ao abrir um arquivo antigo com minúsculas, ele é
 *    padronizado UMA vez, depois de copiar o original para backups/eventos/<data>_padronizacao/.
 *  - (1.1.0) Edição de material/unidade/quantidade solicitada de um item registra a alteração em
 *    `hist` (na própria RC, até 200 entradas). Campo opcional: o schemaVersion continua 1 e a
 *    versão 1.0.0 ainda abre o arquivo (ela apenas descarta `hist`).
 */
const fs = require('fs');
const path = require('path');
const { criarLogger } = require('./logger');

const SCHEMA_VERSION = 1;
const ARQ = { rcs: 'rcs.json', tr: 'transferencias.json' };
const ESTADO = 'estado.json';
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_ITENS_RC = 500;
const MAX_REGISTROS = 20000;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_PROFUNDIDADE = 8;
const DIARIOS_MANTIDOS = 14;
const EVENTOS_MANTIDOS = 30;
const MAX_HIST_RC = 200;
const CAMPOS_EDITAVEIS = ['desc', 'un', 'qs'];
const TIPOS_MOV = ['Transferência', 'Devolução', 'Manutenção'];

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const agora = () => new Date().toISOString();

// ---------- validação / normalização ----------
// Conta quantos campos precisaram ser convertidos para maiúsculas na última leitura (padronização).
let convertidos = 0;
function str(v, max, nome, obrigatorio, maiusculas) {
  if (v == null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(nome + ' inválido');
  let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (maiusculas) {
    const m = s.toUpperCase();            // Unicode: á→Á, ç→Ç, õ→Õ; números e símbolos não mudam
    if (m !== s) { convertidos++; s = m; }
  }
  if (s.length > max) throw bad(nome + ' muito longo');
  if (obrigatorio && !s) throw bad(nome + ' obrigatório');
  return s;
}
function inteiro(v, nome, max = 1e9) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > max) throw bad(nome + ' inválido');
  return n;
}
function data(v, nome, obrigatoria) {
  const s = str(v, 10, nome, obrigatoria);
  if (!s) return '';
  if (!RE_DATA.test(s)) throw bad(nome + ' inválida');
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(nome + ' inválida');
  return s;
}
function iso(v, padrao) {
  if (v == null || v === '') return padrao;
  if (typeof v !== 'string' || !RE_ISO.test(v) || Number.isNaN(Date.parse(v))) throw bad('data/hora inválida');
  return v;
}
/** Quantidade digitada pelo usuário: inteiro estrito >= 1 (recusa "abc", "2,5", "-1", "1e3"). */
function qtdPositiva(v, nome) {
  if (typeof v === 'string' ? !/^\s*\d{1,10}\s*$/.test(v) : typeof v !== 'number') throw bad(nome + ': informe um número inteiro');
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1e9) throw bad(nome + ': informe um número inteiro maior que zero');
  return n;
}
const semAcento = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Tipo da movimentação: os conhecidos são normalizados (ex.: "MANUTENCAO" → "Manutenção"); outros são mantidos. */
function tipoMov(v) {
  const s = str(v, 40, 'tipo', true);
  return TIPOS_MOV.find((t) => semAcento(t) === semAcento(s)) || s;
}
function idv(v, nome = 'id') {
  if (typeof v !== 'string' || !RE_ID.test(v)) throw bad(nome + ' inválido');
  return v;
}
function objeto(v, nome) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad(nome + ' inválido');
  return v;
}
function item(i) {
  objeto(i, 'item');
  return {
    id: idv(i.id, 'id do item'),
    desc: str(i.desc, 300, 'material', true, true),
    un: str(i.un, 20, 'unidade', false, true),
    qs: inteiro(i.qs, 'quantidade solicitada'),
    qe: inteiro(i.qe, 'quantidade entregue'),
    canc: i.canc === true || i.canc === 1,
    obs: str(i.obs, 1000, 'observações', false, true),
  };
}
/** Entrada do histórico de edições (valores gravados como estavam, sem conversão). */
function entradaHist(h) {
  objeto(h, 'histórico');
  if (!CAMPOS_EDITAVEIS.includes(h.campo)) throw bad('histórico inválido');
  if (!h.em) throw bad('histórico inválido');
  const val = (v) => (h.campo === 'qs' ? inteiro(v, 'histórico') : str(v, 300, 'histórico'));
  return { em: iso(h.em), item: idv(h.item, 'histórico'), campo: h.campo, de: val(h.de), para: val(h.para) };
}
function historico(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr) || arr.length > MAX_HIST_RC) throw bad('histórico inválido');
  return arr.map(entradaHist);
}
function itens(arr) {
  if (!Array.isArray(arr) || arr.length > MAX_ITENS_RC) throw bad('itens inválidos');
  const lista = arr.map(item);
  if (new Set(lista.map((i) => i.id)).size !== lista.length) throw bad('ids de item repetidos');
  return lista;
}
function registro(r) {
  objeto(r, 'RC');
  const t = agora();
  const out = {
    id: idv(r.id, 'id da RC'),
    num: str(r.num, 40, 'número da RC', true),
    dsol: data(r.dsol, 'data da solicitação', true),
    dent: data(r.dent, 'data de entrega', false),
    sol: str(r.sol, 100, 'solicitante', false, true),
    items: itens(r.items == null ? [] : r.items),
    createdAt: iso(r.createdAt, t),
    updatedAt: iso(r.updatedAt, t),
  };
  const hist = historico(r.hist);
  if (hist.length) out.hist = hist;       // só aparece no arquivo quando houver edições
  return out;
}
function movimentacao(m) {
  objeto(m, 'movimentação');
  const t = agora();
  return {
    id: idv(m.id, 'id da movimentação'),
    date: data(m.date, 'data', true),
    tipo: tipoMov(m.tipo),
    desc: str(m.desc, 300, 'material', true, true),
    un: str(m.un, 20, 'unidade', false, true),
    qty: inteiro(m.qty, 'quantidade'),
    port: str(m.port, 100, 'responsável', false, true),
    orig: str(m.orig, 150, 'origem', false, true),
    dest: str(m.dest, 150, 'destino', false, true),
    createdAt: iso(m.createdAt, t),
    updatedAt: iso(m.updatedAt, t),
  };
}
function profundidade(v, atual = 0) {
  if (atual > MAX_PROFUNDIDADE) return atual;
  if (v === null || typeof v !== 'object') return atual;
  let max = atual;
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    max = Math.max(max, profundidade(x, atual + 1));
    if (max > MAX_PROFUNDIDADE) break;
  }
  return max;
}

// ---------- caminhos ----------
function validarRaiz(p, env = process.env, P = path) {
  if (typeof p !== 'string' || !p || p.length > 240 || p.includes('\0')) throw bad('caminho inválido');
  if (!P.isAbsolute(p)) throw bad('o caminho deve ser absoluto');
  if (/^[\\/]{2}/.test(p)) throw bad('pastas de rede (\\\\servidor\\pasta) não são permitidas');
  const r = P.resolve(p);
  if (P.parse(r).root === r) throw bad('escolha uma pasta, não a raiz do disco');
  const proibidas = [env.windir, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]
    .filter(Boolean).map((x) => P.resolve(x).toLowerCase());
  const rl = r.toLowerCase();
  if (proibidas.some((b) => rl === b || rl.startsWith(b + P.sep))) throw bad('pasta do sistema não permitida');
  return r;
}

// ---------- arquivos ----------
function gravarAtomico(arquivo, obj) {
  const texto = JSON.stringify(obj, null, 2);
  const tmp = arquivo + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, texto, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.readFileSync(tmp, 'utf8') !== texto) throw new Error('verificação da gravação falhou');
  if (fs.existsSync(arquivo)) {
    try { fs.copyFileSync(arquivo, arquivo + '.bak'); } catch (_) { /* melhor esforço */ }
  }
  fs.renameSync(tmp, arquivo);
}
const p2 = (n) => String(n).padStart(2, '0');
const diaLocal = (d = new Date()) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const carimbo = (d = new Date()) => diaLocal(d) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
const fmtData = (s) => (s ? s.split('-').reverse().join('/') : '');

// ---------- CSV ----------
// Neutraliza "injeção de fórmula" no Excel: texto iniciado por = + - @ vira texto literal.
function celula(v) {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const pend = (i) => (i.canc ? 0 : Math.max(0, i.qs - i.qe));
const situacao = (i) => (i.canc ? 'Cancelado' : pend(i) === 0 ? 'Entregue' : i.qe > 0 ? 'Parcial' : 'Pendente');

class Store {
  constructor(raiz, opcoes = {}) {
    this.raiz = raiz;
    this.seedPath = opcoes.seedPath || null;
    this.log = opcoes.log || criarLogger(() => path.join(this.raiz, 'logs'));
    this.avisos = [];
    this.ver = Math.floor(Date.now() / 1000);
    this.carregar();
    this.semearSePrimeiraVez();
  }
  get dirData() { return path.join(this.raiz, 'data'); }
  get dirConfig() { return path.join(this.raiz, 'config'); }
  get dirBackups() { return path.join(this.raiz, 'backups'); }

  // ----- migração de formato -----
  _migrar(doc) {
    if (doc === null || typeof doc !== 'object') throw new Error('formato');
    if (doc.schemaVersion === undefined && doc.schema === 1) { // formato de desenvolvimento anterior
      const lista = doc.rcs || doc.tr;
      return { doc: { schemaVersion: SCHEMA_VERSION, records: lista, populado: doc.populado }, migrado: true };
    }
    if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) throw new Error('schemaVersion inválido');
    if (doc.schemaVersion > SCHEMA_VERSION) throw new Error('arquivo criado por uma versão mais nova do aplicativo');
    return { doc, migrado: false };
  }

  // ----- leitura / recuperação -----
  _candidatos(pastaRel, nome) {
    const f = path.join(this.raiz, pastaRel, nome);
    const lista = [f, f + '.bak'];
    for (const tipo of ['diario', 'eventos']) {
      const base = path.join(this.dirBackups, tipo);
      let nomes = [];
      try { nomes = fs.readdirSync(base).sort().reverse(); } catch (_) { /* sem backups */ }
      for (const n of nomes) lista.push(path.join(base, n, nome));
    }
    return lista;
  }
  _ler(pastaRel, nome, interpretar, vazio) {
    const f = path.join(this.raiz, pastaRel, nome);
    let existiu = false;
    for (const c of this._candidatos(pastaRel, nome)) {
      if (!fs.existsSync(c)) continue;
      existiu = true;
      let doc, migrado, padronizar;
      try {
        const m = this._migrar(JSON.parse(fs.readFileSync(c, 'utf8')));
        migrado = m.migrado;
        convertidos = 0;
        doc = interpretar(m.doc);
        padronizar = convertidos > 0;
      } catch (e) {
        this.log('aviso', 'arquivo_ilegivel', { arquivo: nome, motivo: e.message });
        continue;
      }
      if (c !== f) {
        if (fs.existsSync(f)) fs.renameSync(f, f + '.corrompido-' + Date.now());
        gravarAtomico(f, doc);
        this.avisos.push('O arquivo ' + nome + ' estava ilegível e foi recuperado de uma cópia de segurança.');
        this.log('aviso', 'arquivo_recuperado', { arquivo: nome });
      } else if (migrado || padronizar) {
        // cópia do arquivo original ANTES de regravá-lo no formato/padrão novo
        this._copiarArquivo(f, migrado ? 'migracao' : 'padronizacao');
        gravarAtomico(f, doc);
        this.log('info', migrado ? 'arquivo_migrado' : 'arquivo_padronizado', { arquivo: nome });
      }
      return doc;
    }
    if (existiu) throw new Error('O arquivo ' + nome + ' está corrompido e não há cópia válida.');
    return vazio;
  }
  _copiarArquivo(origem, motivo) {
    const dest = path.join(this.dirBackups, 'eventos', carimbo() + '_' + motivo);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(origem, path.join(dest, path.basename(origem)));
  }
  carregar() {
    for (const d of [this.dirData, this.dirConfig, this.dirBackups, path.join(this.raiz, 'logs')]) fs.mkdirSync(d, { recursive: true });
    this.avisos = [];
    const lista = (chave, conv, max) => (d) => {
      if (!Array.isArray(d.records) || d.records.length > max) throw new Error('formato');
      const docOut = { schemaVersion: SCHEMA_VERSION, records: d.records.map(conv) };
      if (chave === 'rcs') this._validarIdsUnicos(docOut.records);
      return docOut;
    };
    this.rcs = this._ler('data', ARQ.rcs, lista('rcs', registro, MAX_REGISTROS), { schemaVersion: SCHEMA_VERSION, records: [] }).records;
    this.tr = this._ler('data', ARQ.tr, lista('tr', movimentacao, MAX_REGISTROS), { schemaVersion: SCHEMA_VERSION, records: [] }).records;
    this.estado = this._ler('config', ESTADO, (d) => ({ schemaVersion: SCHEMA_VERSION, populado: d.populado === true }),
      { schemaVersion: SCHEMA_VERSION, populado: false });
  }
  _validarIdsUnicos(registros) {
    const ids = new Set();
    for (const r of registros) {
      for (const id of [r.id, ...r.items.map((i) => i.id)]) {
        if (ids.has(id)) throw new Error('ids repetidos');
        ids.add(id);
      }
    }
  }
  _idsEmUso() {
    const s = new Set();
    for (const r of this.rcs) { s.add(r.id); r.items.forEach((i) => s.add(i.id)); }
    return s;
  }

  // ----- gravação -----
  _persistir(quais) {
    if (quais.rcs) gravarAtomico(path.join(this.dirData, ARQ.rcs), { schemaVersion: SCHEMA_VERSION, records: this.rcs });
    if (quais.tr) gravarAtomico(path.join(this.dirData, ARQ.tr), { schemaVersion: SCHEMA_VERSION, records: this.tr });
    if (!this.estado.populado) {
      this.estado.populado = true;
      gravarAtomico(path.join(this.dirConfig, ESTADO), this.estado);
    }
  }
  /** Valida tudo ANTES de alterar a memória; só confirma após gravar em disco. */
  _mutar(quais, fn) {
    try {
      const r = fn();
      this._persistir(quais);
      this.ver += 1;
      return r;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      this.log('erro', 'falha_gravacao', { codigo: e.code || 'desconhecido', msg: e.message });
      try { this.carregar(); } catch (e2) { this.log('erro', 'falha_recarga', { msg: e2.message }); }
      throw new HttpError(500, 'Não foi possível gravar os dados no disco. A alteração não foi aplicada.');
    }
  }

  // ----- backups -----
  _copiarDados(destino) {
    fs.mkdirSync(destino, { recursive: true });
    for (const [pasta, nome] of [['data', ARQ.rcs], ['data', ARQ.tr], ['config', ESTADO]]) {
      const origem = path.join(this.raiz, pasta, nome);
      if (!fs.existsSync(origem)) continue;
      const tmp = path.join(destino, nome + '.tmp');
      fs.copyFileSync(origem, tmp);
      fs.renameSync(tmp, path.join(destino, nome));
    }
  }
  _podar(tipo, manter) {
    const base = path.join(this.dirBackups, tipo);
    let nomes = [];
    try { nomes = fs.readdirSync(base).sort(); } catch (_) { return; }
    for (const velho of nomes.slice(0, Math.max(0, nomes.length - manter))) {
      fs.rmSync(path.join(base, velho), { recursive: true, force: true });
    }
  }
  backupDiario() {
    this._copiarDados(path.join(this.dirBackups, 'diario', diaLocal()));
    this._podar('diario', DIARIOS_MANTIDOS);
  }
  /** Cópia anterior a operações destrutivas. */
  snapshot(motivo) {
    this._copiarDados(path.join(this.dirBackups, 'eventos', carimbo() + '_' + motivo));
    this._podar('eventos', EVENTOS_MANTIDOS);
    this.log('info', 'snapshot', { motivo });
  }

  // ----- planilha original (primeira execução) -----
  _lerSeed() {
    if (!this.seedPath || !fs.existsSync(this.seedPath)) throw new HttpError(404, 'arquivo da planilha não encontrado');
    const bruto = JSON.parse(fs.readFileSync(this.seedPath, 'utf8'));
    if (!Array.isArray(bruto) || bruto.length > MAX_REGISTROS) throw bad('planilha inválida');
    return bruto.map(registro);
  }
  _incorporar(lista) {
    const usados = this._idsEmUso();
    let novas = 0; let ignoradas = 0;
    for (const r of lista) {
      const ids = [r.id, ...r.items.map((i) => i.id)];
      if (ids.some((id) => usados.has(id))) { ignoradas++; continue; }
      ids.forEach((id) => usados.add(id));
      this.rcs.push(r);
      novas++;
    }
    return { novas, ignoradas };
  }
  semearSePrimeiraVez() {
    if (this.estado.populado || this.rcs.length || this.tr.length || !this.seedPath) return;
    try {
      const r = this._mutar({ rcs: true, tr: true }, () => this._incorporar(this._lerSeed()));
      this.log('info', 'planilha_importada', { registros: r.novas });
    } catch (e) {
      this.avisos.push('Não foi possível importar a planilha inicial: ' + e.message);
    }
  }

  // ----- importação / exportação JSON -----
  exportarJson() {
    return JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt: agora(), records: this.rcs, transfers: this.tr }, null, 2);
  }
  importarJson(texto) {
    if (typeof texto !== 'string' || texto.length > MAX_JSON_BYTES) throw bad('arquivo JSON muito grande');
    let doc;
    try { doc = JSON.parse(texto); } catch (_) { throw bad('o arquivo não é um JSON válido'); }
    if (profundidade(doc) > MAX_PROFUNDIDADE) throw bad('estrutura JSON profunda demais');
    objeto(doc, 'arquivo');
    if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) throw bad('schemaVersion ausente ou inválido');
    if (doc.schemaVersion > SCHEMA_VERSION) throw bad('arquivo criado por uma versão mais nova do aplicativo');
    if (!Array.isArray(doc.records) || doc.records.length > MAX_REGISTROS) throw bad('lista de RCs inválida');
    const transfers = doc.transfers == null ? [] : doc.transfers;
    if (!Array.isArray(transfers) || transfers.length > MAX_REGISTROS) throw bad('lista de movimentações inválida');
    const regs = doc.records.map(registro);          // valida TUDO antes de gravar qualquer coisa
    const movs = transfers.map(movimentacao);
    this.snapshot('antes-importacao');
    const r = this._mutar({ rcs: true, tr: true }, () => {
      const res = this._incorporar(regs);
      const idsTr = new Set(this.tr.map((t) => t.id));
      let trNovas = 0;
      for (const m of movs) if (!idsTr.has(m.id)) { this.tr.push(m); idsTr.add(m.id); trNovas++; }
      return { registros: res.novas, ignorados: res.ignoradas, movimentacoes: trNovas };
    });
    this.log('info', 'importacao_json', r);
    return { ok: true, ...r };
  }

  // ----- troca da pasta de dados -----
  trocarRaiz(novo) {
    const destino = validarRaiz(novo);
    if (destino.toLowerCase() === path.resolve(this.raiz).toLowerCase()) return { ok: true, pasta: this.raiz, acao: 'igual' };
    try {
      fs.mkdirSync(destino, { recursive: true });
      const teste = path.join(destino, '.teste_escrita');
      fs.writeFileSync(teste, 'ok'); fs.unlinkSync(teste);
    } catch (e) {
      throw bad('não foi possível gravar nessa pasta (' + (e.code || 'erro') + ')');
    }
    const jaTem = fs.existsSync(path.join(destino, 'data', ARQ.rcs)) || fs.existsSync(path.join(destino, 'data', ARQ.tr));
    const antiga = this.raiz;
    this.raiz = destino;
    try {
      if (jaTem) { this.carregar(); this.ver += 1; } else {
        for (const d of [this.dirData, this.dirConfig, this.dirBackups, path.join(this.raiz, 'logs')]) fs.mkdirSync(d, { recursive: true });
        this.estado.populado = false;
        this._persistir({ rcs: true, tr: true });
        this.ver += 1;
      }
      this.backupDiario();
    } catch (e) {
      this.raiz = antiga;
      this.carregar();
      this.log('erro', 'troca_pasta_falhou', { codigo: e.code || 'desconhecido' });
      throw new HttpError(500, 'Não foi possível usar a nova pasta. Os dados continuam na pasta anterior.');
    }
    this.log('info', 'pasta_trocada', { acao: jaTem ? 'existente' : 'copiado' });
    return { ok: true, pasta: this.raiz, acao: jaTem ? 'existente' : 'copiado' };
  }

  // ----- CSV -----
  csv(tipo) {
    let linhas;
    if (tipo === 'rc') {
      linhas = [['Nº RC', 'Solicitante', 'Data Solicitação', 'Data Entrega', 'Item', 'Material', 'Un.', 'Qtd. Solicitada', 'Qtd. Entregue', 'Cancelado', 'Qtd. Pendente', 'Situação', 'Observações']];
      for (const r of this.rcs) {
        r.items.forEach((i, n) => linhas.push([r.num, r.sol, fmtData(r.dsol), fmtData(r.dent), n + 1, i.desc, i.un, i.qs, i.qe, i.canc ? 'Sim' : 'Não', pend(i), situacao(i), i.obs]));
      }
    } else if (tipo === 'tr') {
      linhas = [['Data', 'Tipo', 'Material', 'Un.', 'Quantidade', 'Responsável', 'Origem', 'Destino']];
      for (const x of this.tr) linhas.push([fmtData(x.date), x.tipo, x.desc, x.un, x.qty, x.port, x.orig, x.dest]);
    } else throw bad('tipo de exportação inválido');
    return '\ufeff' + linhas.map((l) => l.map(celula).join(';')).join('\r\n');
  }

  // ----- API interna (mesmas rotas que a interface usa) -----
  tratar(metodo, url, corpo) {
    const u = new URL(String(url), 'http://local');
    const p = u.pathname;
    if (metodo === 'GET' && p === '/api/state') {
      if (Number(u.searchParams.get('v')) === this.ver) return { same: true };
      return { v: this.ver, rcs: this.rcs, tr: this.tr };
    }
    if (metodo === 'GET' && p === '/api/pasta') return { pasta: this.raiz, local: true };
    if (metodo === 'POST' && p === '/api/exportar') {
      const tipo = objeto(corpo, 'corpo').k;
      return { csv: this.csv(tipo), nome: tipo === 'rc' ? 'requisicoes.csv' : 'movimentacoes.csv' };
    }
    if (metodo === 'POST' && p === '/api/importar-planilha') {
      this.snapshot('antes-planilha');
      return this._mutar({ rcs: true }, () => ({ ok: true, ...this._incorporar(this._lerSeed()) }));
    }
    if (metodo === 'POST' && p === '/api/reset') {
      this.snapshot('antes-apagar-tudo');
      return this._mutar({ rcs: true, tr: true }, () => { this.rcs = []; this.tr = []; return { ok: true }; });
    }
    const m = /^\/api\/(rc|item|tr)(?:\/([^/]+))?(\/items)?$/.exec(p);
    if (!m) throw new HttpError(404, 'rota desconhecida');
    const [, tipo, idBruto, sub] = m;
    const id = idBruto === undefined ? undefined : idv(idBruto);

    if (metodo === 'POST' && tipo === 'rc' && !id) {
      const nova = registro(corpo);
      delete nova.hist;                   // RC nova não tem histórico de edição
      const usados = this._idsEmUso();
      if ([nova.id, ...nova.items.map((i) => i.id)].some((x) => usados.has(x))) throw new HttpError(409, 'identificador já existe');
      return this._mutar({ rcs: true }, () => { this.rcs.push(nova); return { ok: true }; });
    }
    if (metodo === 'POST' && tipo === 'rc' && id && sub) {
      const alvo = this.rcs.find((r) => r.id === id);
      if (!alvo) throw new HttpError(404, 'RC não encontrada');
      const novos = itens(objeto(corpo, 'corpo').items);
      if (alvo.items.length + novos.length > MAX_ITENS_RC) throw bad('itens demais na RC');
      const usados = this._idsEmUso();
      if (novos.some((i) => usados.has(i.id))) throw new HttpError(409, 'identificador de item já existe');
      return this._mutar({ rcs: true }, () => { alvo.items.push(...novos); alvo.updatedAt = agora(); return { ok: true }; });
    }
    if (metodo === 'PATCH' && tipo === 'rc' && id) {
      const alvo = this.rcs.find((r) => r.id === id);
      if (!alvo) throw new HttpError(404, 'RC não encontrada');
      const c = objeto(corpo, 'corpo');
      const novo = {};
      if ('dent' in c) novo.dent = data(c.dent, 'data de entrega', false);
      if ('sol' in c) novo.sol = str(c.sol, 100, 'solicitante', false, true);
      return this._mutar({ rcs: true }, () => { Object.assign(alvo, novo, { updatedAt: agora() }); return { ok: true }; });
    }
    if (metodo === 'DELETE' && tipo === 'rc' && id) {
      if (!this.rcs.some((r) => r.id === id)) throw new HttpError(404, 'RC não encontrada');
      this.snapshot('antes-excluir-rc');
      return this._mutar({ rcs: true }, () => { this.rcs = this.rcs.filter((r) => r.id !== id); return { ok: true }; });
    }
    if (metodo === 'PATCH' && tipo === 'item' && id) {
      let dona = null; let alvo = null;
      for (const r of this.rcs) { alvo = r.items.find((i) => i.id === id); if (alvo) { dona = r; break; } }
      if (!alvo) throw new HttpError(404, 'item não encontrado');
      const c = objeto(corpo, 'corpo');
      const novo = {};
      if ('qe' in c) novo.qe = inteiro(c.qe, 'quantidade entregue');
      if ('canc' in c) novo.canc = c.canc === true || c.canc === 1;
      if ('obs' in c) novo.obs = str(c.obs, 1000, 'observações', false, true);
      // Edição do item (1.1.0): material, unidade e quantidade solicitada, com histórico.
      if ('desc' in c) novo.desc = str(c.desc, 300, 'material', true, true);
      if ('un' in c) novo.un = str(c.un, 20, 'unidade', false, true);
      if ('qs' in c) novo.qs = qtdPositiva(c.qs, 'quantidade solicitada');
      if ('esperado' in c) {             // proteção contra editar um valor que já mudou
        const e = objeto(c.esperado, 'valores anteriores');
        for (const k of CAMPOS_EDITAVEIS) {
          if (k in e && String(e[k]) !== String(alvo[k])) throw new HttpError(409, 'Este item foi alterado depois que a edição foi aberta. Feche e abra a edição novamente.');
        }
      }
      const t = agora();
      const mud = CAMPOS_EDITAVEIS.filter((k) => k in novo && novo[k] !== alvo[k])
        .map((k) => ({ em: t, item: alvo.id, campo: k, de: alvo[k], para: novo[k] }));
      return this._mutar({ rcs: true }, () => {
        Object.assign(alvo, novo);
        if (mud.length) dona.hist = [...(dona.hist || []), ...mud].slice(-MAX_HIST_RC);
        dona.updatedAt = t;
        return { ok: true, alterados: mud.map((m) => m.campo) };
      });
    }
    if (metodo === 'DELETE' && tipo === 'item' && id) {
      const dona = this.rcs.find((r) => r.items.some((i) => i.id === id));
      if (!dona) throw new HttpError(404, 'item não encontrado');
      return this._mutar({ rcs: true }, () => {
        dona.items = dona.items.filter((i) => i.id !== id);
        dona.updatedAt = agora();
        if (!dona.items.length) this.rcs = this.rcs.filter((r) => r !== dona);
        return { ok: true };
      });
    }
    if (metodo === 'POST' && tipo === 'tr' && !id) {
      const nova = movimentacao(corpo);
      if (this.tr.some((t) => t.id === nova.id)) throw new HttpError(409, 'identificador já existe');
      return this._mutar({ tr: true }, () => { this.tr.push(nova); return { ok: true }; });
    }
    if (metodo === 'DELETE' && tipo === 'tr' && id) {
      if (!this.tr.some((t) => t.id === id)) throw new HttpError(404, 'movimentação não encontrada');
      return this._mutar({ tr: true }, () => { this.tr = this.tr.filter((t) => t.id !== id); return { ok: true }; });
    }
    throw new HttpError(404, 'rota desconhecida');
  }
}

module.exports = { Store, HttpError, SCHEMA_VERSION, MAX_JSON_BYTES, MAX_HIST_RC, TIPOS_MOV, validarRaiz, gravarAtomico };
