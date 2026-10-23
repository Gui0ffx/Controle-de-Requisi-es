'use strict';
/**
 * Log técnico local (JSON Lines) com rotação. Não registra conteúdo das RCs:
 * somente evento, nível e metadados curtos (contagens, códigos de erro).
 * Caminhos do usuário são abreviados (~) para não expor nomes de pastas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const GERACOES = 3;

function limpar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  const home = os.homedir();
  if (home) s = s.split(home).join('~');
  return s;
}

function criarLogger(obterDir) {
  return function log(nivel, evento, extra) {
    try {
      const dir = obterDir();
      fs.mkdirSync(dir, { recursive: true });
      const arq = path.join(dir, 'app.log');
      try {
        if (fs.statSync(arq).size > MAX_BYTES) {
          for (let i = GERACOES - 1; i >= 1; i--) {
            const de = arq + '.' + i;
            if (fs.existsSync(de)) fs.renameSync(de, arq + '.' + (i + 1));
          }
          fs.renameSync(arq, arq + '.1');
          const velho = arq + '.' + (GERACOES + 1);
          if (fs.existsSync(velho)) fs.unlinkSync(velho);
        }
      } catch (_) { /* arquivo ainda não existe */ }
      const linha = { t: new Date().toISOString(), nivel, evento };
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) {
          const l = limpar(v);
          if (l !== undefined) linha[k] = l;
        }
      }
      fs.appendFileSync(arq, JSON.stringify(linha) + '\n', 'utf8');
    } catch (_) { /* log nunca pode derrubar o aplicativo */ }
  };
}

module.exports = { criarLogger };
