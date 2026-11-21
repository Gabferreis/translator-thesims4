const STBL_TYPE = 0x220557DA;
const LANGS = [[0, 'Inglês'], [1, 'Chinês (simplificado)'], [2, 'Chinês (tradicional)'], [3, 'Tcheco'], [4, 'Dinamarquês'], [5, 'Holandês'], [6, 'Finlandês'], [7, 'Francês'], [8, 'Alemão'], [11, 'Italiano'], [12, 'Japonês'], [13, 'Coreano'], [14, 'Norueguês'], [15, 'Polonês'], [16, 'Português europeu (o jogo não usa)'], [17, 'Português (Brasil)'], [18, 'Russo'], [19, 'Espanhol'], [21, 'Sueco']];
const langName = c => (LANGS.find(l => l[0] === c) || [c, 'Idioma 0x' + c.toString(16)])[1];
const TOKEN_RE = /\{[^{}]*\}|<[^<>]*>|\\n|%[sd]/g;
const PAGE = 25;
const $ = s => document.querySelector(s);
const dec = new TextDecoder(), enc = new TextEncoder();

function el(tag, props, ...kids) { const e = document.createElement(tag); for (const k in (props || {})) { if (k === 'class') e.className = props[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]); else e.setAttribute(k, props[k]); } for (const c of kids.flat()) if (c != null) e.append(c); return e }
const tokens = t => t.match(TOKEN_RE) || [];
const translatable = t => /\p{L}/u.test(t.replace(TOKEN_RE, ''));
function diffTokens(a, b) { const cnt = {}; tokens(a).forEach(t => cnt[t] = (cnt[t] || 0) + 1); const extra = []; tokens(b).forEach(t => { if (cnt[t]) cnt[t]--; else extra.push(t) }); const missing = []; for (const t in cnt) for (let i = 0; i < cnt[t]; i++)missing.push(t); return { missing, extra } }
function chips(text, target) { let last = 0; text.replace(TOKEN_RE, (m, i) => { if (i > last) target.append(text.slice(last, i)); target.append(el('span', { class: 'tok' }, m)); last = i + m.length; return m }); if (last < text.length) target.append(text.slice(last)); return target }
const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/* ---------- DBPF ---------- */
function parsePackage(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0x46504244) throw new Error('Este arquivo não é um .package válido (cabeçalho DBPF ausente).');
    const count = dv.getUint32(0x24, true);
    let pos = Number(dv.getBigUint64(0x40, true)) || dv.getUint32(0x28, true);
    const flags = dv.getUint32(pos, true); pos += 4;
    const c = [null, null, null];
    for (let i = 0; i < 3; i++)if (flags >> i & 1) { c[i] = dv.getUint32(pos, true); pos += 4 }
    const entries = [];
    for (let i = 0; i < count; i++) {
        const e = {};
        for (const [k, idx] of [['type', 0], ['group', 1], ['instHi', 2]]) { if (c[idx] === null) { e[k] = dv.getUint32(pos, true); pos += 4 } else e[k] = c[idx] }
        e.instLo = dv.getUint32(pos, true); pos += 4;
        e.offset = dv.getUint32(pos, true); e.size = dv.getUint32(pos + 4, true) & 0x7fffffff; e.mem = dv.getUint32(pos + 8, true);
        e.comp = dv.getUint16(pos + 12, true); e.committed = dv.getUint16(pos + 14, true); pos += 16;
        e.raw = u8.subarray(e.offset, e.offset + e.size);
        entries.push(e);
    }
    return { header: u8.slice(0, 96), entries };
}
async function inflate(u8) { const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(u8).catch(() => { }); w.close().catch(() => { }); return new Uint8Array(await new Response(ds.readable).arrayBuffer()) }
async function entryData(e) { if (e.comp === 0) return e.raw; if (e.comp === 0x5A42) return inflate(e.raw); throw new Error('Compressão ' + hex(e.comp) + ' não suportada nesta tabela.') }
function parseStbl(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0x4C425453) throw new Error('Recurso STBL inválido.');
    const version = dv.getUint16(4, true), n = Number(dv.getBigUint64(7, true));
    let p = 21; const items = [];
    for (let i = 0; i < n; i++) { const key = dv.getUint32(p, true), fl = dv.getUint8(p + 4), len = dv.getUint16(p + 5, true); p += 7; items.push({ key, flags: fl, text: dec.decode(u8.subarray(p, p + len)) }); p += len }
    return { version, items };
}
function buildStbl(version, items) {
    const bs = items.map(i => enc.encode(i.text)); const total = bs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(21 + items.length * 7 + total), dv = new DataView(out.buffer);
    out.set([0x53, 0x54, 0x42, 0x4C]); dv.setUint16(4, version, true); dv.setBigUint64(7, BigInt(items.length), true); dv.setUint32(17, total + items.length, true);
    let p = 21; items.forEach((it, i) => { dv.setUint32(p, it.key, true); dv.setUint8(p + 4, it.flags); dv.setUint16(p + 5, bs[i].length, true); out.set(bs[i], p + 7); p += 7 + bs[i].length });
    return out;
}
function buildPackage(pkg, replacements) { // replacements: [{match:entry|null, entry:{type,group,instHi,instLo}, data:Uint8Array}]
    const res = pkg.entries.map(e => ({ type: e.type, group: e.group, instHi: e.instHi, instLo: e.instLo, comp: e.comp, committed: e.committed, mem: e.mem, data: e.raw, orig: e }));
    for (const r of replacements) {
        const hit = res.find(x => x.type === r.entry.type && x.instHi === r.entry.instHi && x.instLo === r.entry.instLo);
        const rec = { ...r.entry, comp: 0, committed: 1, mem: r.data.length, data: r.data };
        if (hit) Object.assign(hit, rec, { orig: null }); else res.push(rec);
    }
    let pos = 96; res.forEach(r => { r.offset = pos; pos += r.data.length });
    const idxPos = pos, idxSize = 4 + res.length * 32;
    const out = new Uint8Array(pos + idxSize), dv = new DataView(out.buffer);
    out.set(pkg.header, 0); res.forEach(r => out.set(r.data, r.offset));
    dv.setUint32(0x24, res.length, true); dv.setUint32(0x28, 0, true); dv.setUint32(0x2C, idxSize, true); dv.setUint32(0x3C, 3, true); dv.setBigUint64(0x40, BigInt(idxPos), true);
    let p = idxPos; dv.setUint32(p, 0, true); p += 4;
    for (const r of res) { dv.setUint32(p, r.type, true); dv.setUint32(p + 4, r.group, true); dv.setUint32(p + 8, r.instHi, true); dv.setUint32(p + 12, r.instLo, true); dv.setUint32(p + 16, r.offset, true); dv.setUint32(p + 20, (r.data.length | 0x80000000) >>> 0, true); dv.setUint32(p + 24, r.mem, true); dv.setUint16(p + 28, r.comp, true); dv.setUint16(p + 30, r.committed, true); p += 32 }
    return out;
}
/* zip (sem compressão) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++)c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++)c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 };
function zipOne(name, data) {
    const nb = enc.encode(name), crc = crc32(data), n = nb.length, d = data.length;
    const out = new Uint8Array(30 + n + d + 46 + n + 22), dv = new DataView(out.buffer);
    const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true); dv.setUint16(10, time, true); dv.setUint16(12, date, true); dv.setUint32(14, crc, true); dv.setUint32(18, d, true); dv.setUint32(22, d, true); dv.setUint16(26, n, true); dv.setUint16(28, 0, true);
    out.set(nb, 30); out.set(data, 30 + n);
    let c = 30 + n + d;
    dv.setUint32(c, 0x02014b50, true); dv.setUint16(c + 4, 20, true); dv.setUint16(c + 6, 20, true); dv.setUint16(c + 8, 0x0800, true); dv.setUint16(c + 10, 0, true); dv.setUint16(c + 12, time, true); dv.setUint16(c + 14, date, true); dv.setUint32(c + 16, crc, true); dv.setUint32(c + 20, d, true); dv.setUint32(c + 24, d, true); dv.setUint16(c + 28, n, true); dv.setUint32(c + 42, 0, true);
    out.set(nb, c + 46);
    const e = c + 46 + n; dv.setUint32(e, 0x06054b50, true); dv.setUint16(e + 8, 1, true); dv.setUint16(e + 10, 1, true); dv.setUint32(e + 12, 46 + n, true); dv.setUint32(e + 16, c, true);
    return out;
}

/* ---------- estado ---------- */
const S = { name: '', pkg: null, tables: [], srcLang: 0, tblFilter: 'all', multi: false, tgt: 17, rows: [], filter: 'all', q: '', page: 0, busy: false, abort: null, sample: null, downloads: null, example: false };
const rowViews = new Map();

function notice(msg, err) { const n = $('#notice'); if (!msg) { n.hidden = true; return } n.hidden = false; n.className = 'note' + (err ? ' err' : ''); n.textContent = msg }
function status(r) { if (r.kept) return 'kept'; if (!r.tr.trim()) return 'pending'; const d = diffTokens(r.src, r.tr); if (d.missing.length || d.extra.length) return 'warn'; return r.changed ? 'changed' : 'ok' }

async function loadBytes(u8, name, isExample) {
    try {
        const pkg = parsePackage(u8);
        const tables = [];
        for (const e of pkg.entries.filter(e => e.type === STBL_TYPE)) {
            try { const st = parseStbl(await entryData(e)); tables.push({ entry: e, lang: e.instHi >>> 24, items: st.items, version: st.version, tid: ((e.instHi & 0xFFFFFF) >>> 0).toString(16) + ':' + e.instLo.toString(16) }) } catch (err) { console.warn(err) }
        }
        if (!tables.length) throw new Error('Nenhuma tabela de strings (STBL) encontrada neste pacote.');
        S.pkg = pkg; S.tables = tables; S.name = name; S.example = !!isExample;
        const cnt = new Map(); tables.forEach(t => cnt.set(t.lang, (cnt.get(t.lang) || 0) + t.items.length));
        S.srcLang = cnt.has(0) ? 0 : [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
        S.tgt = 17;
        setupConfig(); buildRows();
        $('#fileName').textContent = name;
        $('#fileInfo').textContent = pkg.entries.length + ' recursos · ' + tables.length + ' tabelas de strings em ' + cnt.size + (cnt.size === 1 ? ' idioma' : ' idiomas');
        notice(''); $('#howto').hidden = true;
    } catch (err) { notice(err.message || String(err), true) }
}
function setupConfig() {
    $('#config').hidden = false; $('#tools').hidden = false; $('#listArea').hidden = false;
    const ss = $('#srcSel');
    ss.replaceChildren(...[...new Set(S.tables.map(t => t.lang))].map(l => { const ts = S.tables.filter(t => t.lang === l); const n = ts.reduce((a, t) => a + t.items.length, 0); return el('option', { value: l }, langName(l) + ' · ' + (ts.length > 1 ? ts.length + ' tabelas · ' : '') + n + ' strings') }));
    ss.value = S.srcLang;
    const ts = $('#tgtSel'); ts.replaceChildren(...LANGS.map(l => el('option', { value: l[0] }, l[1] + (S.tables.some(t => t.lang === l[0]) ? ' (já existe)' : '')))); ts.value = S.tgt;
}
const srcTables = () => S.tables.filter(t => t.lang === S.srcLang);
function setupTblFilter() {
    const st = srcTables(), sel = $('#tblSel');
    S.multi = st.length > 1; S.tblFilter = 'all'; sel.hidden = !S.multi;
    if (!S.multi) return;
    sel.replaceChildren(el('option', { value: 'all' }, 'Todas as tabelas'), ...st.map((t, i) => el('option', { value: t.tid }, 'Tabela ' + (i + 1) + ' · ' + hex(t.entry.instLo) + ' · ' + t.items.length + ' strings')));
    sel.value = 'all';
}
function buildRows() {
    const prev = new Map();
    if (S.tgt !== S.srcLang) S.tables.filter(x => x.lang === S.tgt).forEach(x => x.items.forEach(i => prev.set(i.key, i.text)));
    S.rows = [];
    srcTables().forEach((t, ti) => t.items.forEach(it => {
        const kept = !translatable(it.text), old = prev.get(it.key);
        S.rows.push({ key: it.key, flags: it.flags, src: it.text, kept, tid: t.tid, ti: ti + 1, tr: kept ? it.text : (old !== undefined && old !== it.text ? old : '') });
    }));
    setupTblFilter(); renderList(true);
}

/* ---------- lista ---------- */
function visible() {
    const q = S.q.trim().toLowerCase();
    return S.rows.filter(r => {
        const st = status(r);
        if (S.tblFilter !== 'all' && r.tid !== S.tblFilter) return false;
        if (S.filter === 'pending' && st !== 'pending') return false;
        if (S.filter === 'done' && st !== 'ok') return false;
        if (S.filter === 'review' && st !== 'warn' && st !== 'changed') return false;
        if (q && !(r.src.toLowerCase().includes(q) || r.tr.toLowerCase().includes(q) || hex(r.key).toLowerCase().includes(q))) return false;
        return true
    });
}
function renderStats() {
    const c = { ok: 0, pending: 0, warn: 0, kept: 0, changed: 0 }; S.rows.forEach(r => c[status(r)]++);
    $('#stats').replaceChildren(el('span', { class: 'pill all' }, S.rows.length + ' strings'), el('span', { class: 'pill ok' }, c.ok + ' traduzidas'), el('span', { class: 'pill pend' }, c.pending + ' pendentes'), el('span', { class: 'pill warn' }, c.warn + ' com aviso'), ...(c.changed ? [el('span', { class: 'pill warn' }, c.changed + ' original mudou')] : []), ...(c.kept ? [el('span', { class: 'pill all' }, c.kept + ' sem texto')] : []));
    $('#btnAll').disabled = S.busy || !canAI() || !c.pending; $('#btnOne').disabled = S.busy || !canAI();
    const rev = c.warn + c.changed; $('#btnRev').disabled = S.busy || !canAI() || !rev; $('#btnRev').textContent = 'Traduzir os para revisar' + (rev ? ' (' + rev + ')' : '');
}
const CHUNK = 40; let io = null;
function renderList(reset) {
    rowViews.clear(); renderStats();
    S.list = visible();
    S.shown = reset ? CHUNK : Math.max(S.shown || CHUNK, CHUNK);
    const box = $('#rows');
    if (!S.list.length) box.replaceChildren(el('div', { class: 'empty' }, 'Nenhuma string neste filtro.'));
    else box.replaceChildren(...S.list.slice(0, S.shown).map(rowEl));
    updateMore();
}
function updateMore() {
    const m = $('#more'), total = S.list.length;
    if (io) { io.disconnect(); io = null }
    m.hidden = S.shown >= total;
    if (m.hidden) return;
    m.textContent = 'Mostrando ' + S.shown + ' de ' + total + '. Role para carregar mais.';
    io = new IntersectionObserver(es => { if (es[0].isIntersecting) loadMore() }, { rootMargin: '800px' });
    io.observe(m);
}
function loadMore() {
    const next = S.list.slice(S.shown, S.shown + CHUNK);
    if (!next.length) return;
    S.shown += next.length;
    $('#rows').append(...next.map(rowEl));
    updateMore();
}
function rowEl(r) {
    const pill = el('span', { class: 'pill' });
    const ta = el('textarea', { 'aria-label': 'Tradução da string ' + hex(r.key) });
    const msg = el('div', { class: 'msg' });
    const trBox = el('div', { class: 'tr' });
    const view = {
        r, pill, ta, msg, upd() {
            const st = status(r);
            pill.className = 'pill ' + ({ ok: 'ok', pending: 'pend', warn: 'warn', kept: 'all', changed: 'warn' }[st]);
            pill.textContent = { ok: 'traduzida', pending: 'pendente', warn: 'revisar', kept: 'sem texto', changed: 'original mudou' }[st];
            ta.setAttribute('aria-invalid', st === 'warn' ? 'true' : 'false');
            msg.replaceChildren();
            if (st === 'warn') {
                const d = diffTokens(r.src, r.tr);
                if (d.missing.length) { msg.append('Faltando:', ...d.missing.map(t => el('button', { type: 'button', class: 'tok', title: 'Inserir no fim da tradução', onclick: () => { ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + t; ta.dispatchEvent(new Event('input')) } }, t))) }
                if (d.extra.length) { msg.append('Sobrando:', ...d.extra.map(t => el('span', { class: 'tok' }, t))) }
            }
            renderStats();
        }
    };
    rowViews.set(r, view);
    if (r.kept) { trBox.append(el('div', { class: 'keep' }, 'Sem texto para traduzir. Mantida igual ao original.')) }
    else {
        ta.value = r.tr; ta.addEventListener('input', () => { r.tr = ta.value; view.upd() });
        const acts = el('div', { class: 'rowact' },
            canAI() ? el('button', { class: 'btn sm', type: 'button', onclick: () => translateRows([r]) }, 'Traduzir esta') : null,
            el('button', { class: 'btn sm', type: 'button', onclick: () => { ta.value = r.src; r.tr = r.src; view.upd() } }, 'Copiar original'),
            r.changed ? el('button', { class: 'btn sm', type: 'button', onclick: () => { r.changed = false; renderList() } }, 'Marcar como revisada') : null,
            r.tr ? el('button', { class: 'btn sm', type: 'button', onclick: () => { ta.value = ''; r.tr = ''; r.changed = false; view.upd() } }, 'Limpar') : null);
        trBox.append(ta, msg, acts);
    }
    const row = el('div', { class: 'row' }, el('div', { class: 'key' }, el('span', {}, hex(r.key)), pill, S.multi ? el('span', {}, 'tabela ' + r.ti) : null), el('div', {}, chips(r.src, el('div', { class: 'src' })), r.changed ? el('div', { class: 'oldsrc' }, 'Original anterior: ' + r.oldSrc) : null), trBox);
    view.upd(); return row;
}

/* ---------- tradução com Claude ---------- */
function promptFor(items, lang, ctx, hint) {
    return `Você traduz textos de interface do jogo The Sims 4 (de ${langName(S.srcLang)} para ${lang}).
Regras obrigatórias:
- Preserve exatamente, sem traduzir, alterar ou remover, todos os marcadores: trechos entre chaves como {0.SimFirstName} ou {1.String}, tags entre < >, sequências \\n e %s/%d. Cada marcador do original deve aparecer na tradução na mesma quantidade. Pode movê-los para onde a gramática da língua pedir.
- Traduza apenas o texto ao redor. Mantenha pontuação e tom de fala de jogo, natural e curto. "Sim" (personagem) não se traduz.
${ctx ? '- Contexto do mod: ' + ctx + '\n' : ''}${hint || ''}
Formato da resposta: texto simples, sem JSON, sem explicações e sem blocos de código. Para cada entrada escreva uma linha começando com o mesmo [id] da entrada, seguido da tradução. Exemplo: [3] Texto traduzido
Entradas:
${items.map(i => '[' + i.id + '] ' + i.text).join('\n')}`;
}
function parseReply(text, ids) {
    const t = String(text || '').replace(/^\s*```[a-z]*\s*$/gim, '').trim();
    const ms = [...t.matchAll(/^\[(0x[0-9A-Fa-f]{1,8}|\d+)\][ \t]*/gm)];
    const out = ms.map((m, i) => ({ id: /^0x/i.test(m[1]) ? m[1] : +m[1], text: t.slice(m.index + m[0].length, i + 1 < ms.length ? ms[i + 1].index : t.length).replace(/\s+$/, '') }));
    if (out.length) return out;
    try { const j = parseJsonLoose(t); if (Array.isArray(j)) return j } catch (_) { }
    if (ids && ids.length === 1) return t ? [{ id: ids[0], text: t }] : [];
    if (ids) { const ls = t.split(/\n+/).map(s => s.trim()).filter(Boolean); if (ls.length === ids.length) return ls.map((s, i) => ({ id: ids[i], text: s })) }
    return [];
}
function replyOrThrow(text, ids) {
    const o = parseReply(text, ids);
    if (!o.length) throw new Error('A IA respondeu em um formato que não consegui ler. Tente de novo ou use um modelo maior.');
    return o;
}
async function translateRows(rows) {
    if (!canAI() || S.busy) return false;
    S.busy = true; S.abort = new AbortController();
    $('#btnStop').hidden = false; $('#progress').hidden = false; $('#btnAll').disabled = true; $('#btnOne').disabled = true; $('#btnRev').disabled = true;
    const lang = langName(S.tgt), ctx = $('#ctx').value.trim();
    const todo = rows.filter(r => !r.kept); let done = 0;
    const setProg = () => { $('#progText').textContent = 'Traduzindo ' + done + ' de ' + todo.length + '…'; $('#progBar').style.width = (todo.length ? done / todo.length * 100 : 0) + '%' };
    setProg();
    try {
        const BN = S.sample ? 20 : ($('#prov').value === 'ollama' ? 8 : 20);
        for (let i = 0; i < todo.length; i += BN) {
            const batch = todo.slice(i, i + BN);
            const items = batch.map((r, j) => ({ id: j, text: r.src }));
            let out = await callAI(promptFor(items, lang, ctx), S.abort.signal, items.map(i => i.id));
            const apply = (out, list) => { const bad = []; for (const o of out || []) { const r = list[o.id]; if (!r || typeof o.text !== 'string') continue; r.tr = o.text; r.changed = false; const d = diffTokens(r.src, r.tr); if (d.missing.length || d.extra.length) bad.push({ id: o.id, r, need: tokens(r.src) }) } return bad };
            let bad = apply(out, batch);
            if (bad.length) {
                const again = bad.map(b => ({ id: b.id, text: b.r.src }));
                const hint = '- Sua resposta anterior alterou marcadores nestas entradas. Copie os marcadores literalmente do original: ' + bad.map(b => '[' + b.id + '] ' + b.need.join(' ')).join('; ') + '\n';
                try { out = await callAI(promptFor(again, lang, ctx, hint), S.abort.signal, again.map(i => i.id)); apply(out, batch) } catch (e) { if (e && e.name === 'AbortError') throw e }
            }
            done += batch.length; setProg(); renderList();
        }
        notice('Tradução concluída. Revise as linhas marcadas com aviso antes de baixar.');
        return true;
    } catch (err) {
        const c = err && err.code;
        if (/Failed to fetch|NetworkError|Load failed/i.test((err && err.message) || '')) { notice('Não consegui conectar ao serviço de IA. Verifique a internet, o endereço e a chave, e se o serviço aceita chamadas feitas pelo navegador.', true); return false }
        notice(c === 'not_granted' ? 'A permissão para usar o Claude foi negada. Você ainda pode traduzir manualmente.' : c === 'rate_limited' ? 'Limite de uso atingido. Espere um pouco e tente de novo.' : (err && err.name === 'AbortError') || c === 'aborted' ? 'Tradução cancelada.' : 'Não foi possível traduzir: ' + ((err && err.message) || err), c !== 'aborted' && !(err && err.name === 'AbortError'));
        return false;
    } finally { S.busy = false; S.abort = null; $('#btnStop').hidden = true; $('#progress').hidden = true; renderList() }
}

/* ---------- exportar ---------- */
async function exportPackage(safe) {
    const st = srcTables();
    const text = r => (!r.tr.trim() || (safe && status(r) === 'warn')) ? r.src : r.tr;
    const srcEntries = new Set(st.map(t => t.entry));
    const others = S.pkg.entries.filter(e => e.type === STBL_TYPE && !srcEntries.has(e));
    const tidOf = e => ((e.instHi & 0xFFFFFF) >>> 0).toString(16) + ':' + e.instLo.toString(16);
    const ek = e => ({ type: e.type, group: e.group, instHi: e.instHi, instLo: e.instLo });
    const reps = [], mapped = new Set(); let created = 0;
    for (const t of st) {
        const data = buildStbl(t.version || 5, S.rows.filter(r => r.tid === t.tid).map(r => ({ key: r.key, flags: r.flags, text: text(r) })));
        const mine = others.filter(e => tidOf(e) === t.tid);
        mine.forEach(e => { mapped.add(e); reps.push({ entry: ek(e), data }) });
        if (!mine.length && S.tgt !== S.srcLang) { created++; reps.push({ entry: { type: STBL_TYPE, group: t.entry.group, instHi: ((S.tgt << 24) | (t.entry.instHi & 0xFFFFFF)) >>> 0, instLo: t.entry.instLo }, data }) }
        if ($('#alsoSrc').checked) reps.push({ entry: ek(t.entry), data });
    }
    S.lastRep = reps.length; S.lastCreated = created; S.lastOrphans = others.filter(e => !mapped.has(e)).length;
    return buildPackage(S.pkg, reps);
}
async function download(safe) {
    try {
        const pkg = await exportPackage(safe);
        const base = S.name.replace(/\.package$/i, '');
        const inner = base + '_' + langName(S.tgt).normalize('NFD').replace(/[^A-Za-z0-9]+/g, '') + '.package';
        const pend = S.rows.filter(r => status(r) === 'pending').length;
        const wn = safe ? S.rows.filter(r => status(r) === 'warn').length : 0;
        const extra = ' ' + S.lastRep + (S.lastRep === 1 ? ' tabela de strings gravada.' : ' tabelas de strings substituídas.') + (S.lastCreated ? ' ' + S.lastCreated + ' criadas no idioma escolhido por não ter correspondente.' : '') + (S.lastOrphans ? ' ' + S.lastOrphans + ' de outros idiomas sem correspondente na origem foram mantidas.' : '') + (pend ? ' ' + pend + ' strings pendentes foram gravadas com o texto original.' : '') + (wn ? ' ' + wn + ' strings voltaram da IA com marcadores alterados e ficaram no texto original por segurança. Ajuste-as no filtro Revisar e baixe de novo.' : '');
        if (S.downloads) {
            await S.downloads.save({ filename: inner.replace(/\.package$/, '.zip'), data: zipOne(inner, pkg) });
            notice('Arquivo salvo como .zip. Extraia o .package para a pasta Mods.' + extra);
        } else {
            const url = URL.createObjectURL(new Blob([pkg], { type: 'application/octet-stream' }));
            const a = el('a', { href: url, download: inner }); document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            notice('Pacote gerado: ' + inner + '. Coloque na pasta Mods.' + extra);
        }
    } catch (err) { if (err && err.code === 'declined') return; notice('Não foi possível gerar o download: ' + ((err && err.message) || err), true) }
}

/* ---------- outra IA ---------- */
async function copyRequest() {
    const n = Math.max(1, Math.min(300, +$('#batchN').value || 60));
    const list = S.rows.filter(r => status(r) === 'pending').slice(0, n);
    if (!list.length) { notice('Não há strings pendentes.'); return }
    const text = promptFor(list.map(r => ({ id: hex(r.key), text: r.src })), langName(S.tgt), $('#ctx').value.trim());
    const box = $('#reqBox'); box.hidden = false; box.value = text; box.focus(); box.select();
    let ok = false; try { await navigator.clipboard.writeText(text); ok = true } catch (e) { }
    notice(ok ? 'Pedido copiado com ' + list.length + ' strings. Cole na IA e traga a resposta para o campo abaixo.' : 'Não consegui copiar sozinho. O texto está selecionado, use Ctrl+C.');
}
function parseJsonLoose(t) {
    t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t) } catch (e) { }
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch (e) { } }
    throw new Error('Não encontrei um JSON válido na resposta. Peça à IA para responder uma linha por entrada, no formato [id] tradução.');
}
function importAi() {
    try {
        const arr = parseReply($('#pasteBox').value);
        if (!arr.length) throw new Error('Não encontrei traduções. Cada linha deve começar com o id entre colchetes, como [0x797AA74F] texto.');
        const byKey = new Map(); S.rows.forEach(r => { const k = hex(r.key).toLowerCase(); (byKey.get(k) || byKey.set(k, []).get(k)).push(r) });
        let ok = 0, skip = 0, warn = 0;
        for (const o of arr) {
            const rs = (byKey.get(String(o && o.id).toLowerCase()) || []).filter(r => !r.kept);
            if (!rs.length || typeof o.text !== 'string') { skip++; continue }
            ok++;
            for (const r of rs) { r.tr = o.text; r.changed = false; const d = diffTokens(r.src, r.tr); if (d.missing.length || d.extra.length) warn++ }
        }
        $('#pasteBox').value = ''; $('#reqBox').hidden = true;
        notice(ok + ' traduções importadas' + (warn ? ', ' + warn + ' com marcadores diferentes (veja o filtro Revisar)' : '') + (skip ? '. ' + skip + ' itens ignorados por id desconhecido.' : '.'), false);
        renderList();
    } catch (e) { notice(e.message || String(e), true) }
}

/* ---------- tradução anterior ---------- */
function applyOld(map, overwrite) {
    let same = 0, chg = 0; const rowKeys = new Set(S.rows.map(r => r.key));
    for (const r of S.rows) {
        if (r.kept) continue;
        const o = map.get(r.key);
        if (!o || !o.tr || o.tr === o.src) continue;
        if (r.tr.trim() && !overwrite) continue;
        r.tr = o.tr;
        if (o.src == null || o.src === r.src) { r.changed = false; same++ } else { r.changed = true; r.oldSrc = o.src; chg++ }
    }
    const fresh = S.rows.filter(r => status(r) === 'pending').length;
    let removed = 0; for (const [k, o] of map) if (!rowKeys.has(k) && o.tr) removed++;
    notice(same + ' traduções reaproveitadas, ' + chg + ' com original alterado (filtro Revisar), ' + fresh + ' novas ou sem tradução' + (removed ? ', ' + removed + ' da versão antiga não existem mais.' : '.'), false);
    renderList();
}
async function importOldFile(f) {
    try {
        if (!/\.package$/i.test(f.name)) throw new Error('Abra um arquivo .package.');
        const map = new Map();
        const pkg = parsePackage(new Uint8Array(await f.arrayBuffer()));
        const tabs = [];
        for (const e of pkg.entries.filter(e => e.type === STBL_TYPE)) { try { tabs.push({ lang: e.instHi >>> 24, items: parseStbl(await entryData(e)).items }) } catch (_) { } }
        const tgs = tabs.filter(t => t.lang === S.tgt);
        if (!tgs.length) throw new Error('O pacote antigo não tem tabela em ' + langName(S.tgt) + '. Troque "Traduzir para" ou use outro arquivo.');
        let srs = tabs.filter(t => t.lang === S.srcLang); if (!srs.length) srs = tabs.filter(t => t.lang === 0);
        const sm = new Map(); srs.forEach(t => t.items.forEach(i => sm.set(i.key, i.text)));
        tgs.forEach(t => t.items.forEach(i => map.set(i.key, { src: sm.get(i.key), tr: i.text })));
        applyOld(map, $('#overwrite').checked);
    } catch (e) { notice(e.message || String(e), true) }
}

/* ---------- motor de IA ---------- */
const canAI = () => !!S.sample || S.custom;
const AI_DEF = { openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, ollama: { url: 'http://localhost:11434', model: 'llama3.1' }, gemini: { url: '', model: 'gemini-2.5-flash' }, anthropic: { url: '', model: 'claude-sonnet-5-5' } };
function syncProv(reset) { const p = $('#prov').value; $('#urlWrap').hidden = p !== 'openai' && p !== 'ollama'; $('#keyWrap').hidden = p === 'ollama'; $('#ollamaBox').hidden = p !== 'ollama'; if (reset) { if (AI_DEF[p].url) $('#apiUrl').value = AI_DEF[p].url; $('#apiModel').value = AI_DEF[p].model } }
function saveAI() { try { localStorage.setItem('oficina_ai', JSON.stringify({ prov: $('#prov').value, url: $('#apiUrl').value, model: $('#apiModel').value, key: $('#remember').checked ? $('#apiKey').value : '' })) } catch (e) { } }
function loadAI() { try { const o = JSON.parse(localStorage.getItem('oficina_ai') || 'null'); if (o) { $('#prov').value = o.prov || 'openai'; $('#apiUrl').value = o.url || AI_DEF.openai.url; $('#apiModel').value = o.model || AI_DEF[$('#prov').value].model; $('#apiKey').value = o.key || ''; $('#remember').checked = !!o.key } } catch (e) { } syncProv(false) }
async function callAI(prompt, signal, ids) {
    if (S.sample) { const r = await S.sample(prompt, { signal, cache: false }); return replyOrThrow(r.text, ids) }
    const prov = $('#prov').value, model = $('#apiModel').value.trim(), key = $('#apiKey').value.trim();
    if (!model) throw new Error('Informe o modelo.');
    if ((prov === 'gemini' || prov === 'anthropic') && !key) throw new Error('Informe a chave da API.');
    let url, body; const headers = { 'content-type': 'application/json' };
    if (prov === 'openai') { url = $('#apiUrl').value.trim().replace(/\/+$/, '') + '/chat/completions'; if (key) headers.authorization = 'Bearer ' + key; body = { model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] } }
    else if (prov === 'ollama') { url = $('#apiUrl').value.trim().replace(/\/+$/, '') + '/api/chat'; body = { model, stream: false, options: { temperature: 0.2 }, messages: [{ role: 'user', content: prompt }] } }
    else if (prov === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent'; headers['x-goog-api-key'] = key; body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } } }
    else { url = 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; body = { model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] } }
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }) }
    catch (e) { if (e && e.name === 'AbortError') throw e; if (prov === 'ollama') throw new Error(await diagnoseOllama($('#apiUrl').value)); throw e }
    const raw = await res.text();
    if (!res.ok) { const e = new Error(prov === 'ollama' && res.status === 403 ? 'O Ollama recusou a chamada vinda deste arquivo (403). Libere com OLLAMA_ORIGINS=* e reinicie o Ollama. As instruções estão em "Como liberar o acesso do navegador ao Ollama".' : prov === 'ollama' && res.status === 404 ? 'Modelo "' + model + '" não encontrado no Ollama. Use "Ver modelos instalados" ou rode ollama pull ' + model + '.' : res.status === 401 || res.status === 403 ? 'O serviço recusou a chave (' + res.status + ').' : res.status === 429 ? 'Limite de uso do serviço atingido (429).' : res.status + ': ' + raw.slice(0, 200)); if (res.status === 429) e.code = 'rate_limited'; throw e }
    const j = JSON.parse(raw);
    const text = prov === 'ollama' ? (j.message && j.message.content) : prov === 'openai' ? (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) : prov === 'gemini' ? ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('') : (j.content || []).map(c => c.text || '').join('');
    return replyOrThrow(text, ids);
}
async function diagnoseOllama(base) {
    base = base.trim().replace(/\/+$/, '');
    let up = false;
    try { await fetch(base + '/api/tags', { mode: 'no-cors' }); up = true } catch (e) { }
    return up
        ? 'O Ollama está rodando em ' + base + ', mas recusa chamadas vindas deste arquivo (CORS). Libere com OLLAMA_ORIGINS=* e reinicie o Ollama. As instruções estão em "Como liberar o acesso do navegador ao Ollama".'
        : 'Não encontrei o Ollama em ' + base + '. Confirme que ele está aberto e que o endereço e a porta estão certos. Tente também http://127.0.0.1:11434.';
}
async function listOllama() {
    try {
        const res = await fetch($('#apiUrl').value.trim().replace(/\/+$/, '') + '/api/tags');
        if (res.status === 403) throw new Error('forbidden');
        if (!res.ok) throw new Error('Ollama respondeu ' + res.status + '.');
        const names = ((await res.json()).models || []).map(m => m.name);
        $('#ollamaModels').replaceChildren(...names.map(n => el('option', { value: n })));
        if (names.length && !names.includes($('#apiModel').value)) { $('#apiModel').value = names[0]; saveAI() }
        notice(names.length ? names.length + ' modelos instalados: ' + names.join(', ') + '.' : 'O Ollama não tem modelos instalados. Rode ollama pull llama3.1 no terminal.', !names.length);
    } catch (e) { notice(/^Ollama respondeu/.test((e && e.message) || '') ? e.message : await diagnoseOllama($('#apiUrl').value), true) }
}
async function translateAndDownload() {
    if (S.busy) return;
    const pending = S.rows.filter(r => status(r) === 'pending');
    const ok = pending.length ? await translateRows(pending) : true;
    if (ok) await download(true);
}

/* ---------- eventos ---------- */
$('#btnOne').onclick = translateAndDownload;
$('#btnRev').onclick = () => translateRows(S.rows.filter(r => { const s = status(r); return s === 'warn' || s === 'changed' }));
$('#btnTags').onclick = listOllama;
$('#prov').onchange = () => { syncProv(true); saveAI() };
['apiUrl', 'apiModel', 'apiKey', 'remember'].forEach(id => $('#' + id).addEventListener('input', saveAI));
$('#btnCopyReq').onclick = copyRequest;
$('#btnImportAi').onclick = importAi;
$('#btnOld').onclick = () => $('#oldFile').click();
$('#oldFile').onchange = e => { const f = e.target.files[0]; if (f) importOldFile(f); e.target.value = '' };

$('#btnOpen').onclick = () => $('#file').click();
$('#file').onchange = async e => { const f = e.target.files[0]; if (f) loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, false); e.target.value = '' };
const dz = $('#drop');
dz.ondragover = e => { e.preventDefault(); dz.classList.add('over') }; dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = async e => { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, false) };
$('#srcSel').onchange = e => { S.srcLang = +e.target.value; buildRows() };
$('#tblSel').onchange = e => { S.tblFilter = e.target.value; renderList(true) };
$('#tgtSel').onchange = e => { S.tgt = +e.target.value; buildRows() };
$('#btnAll').onclick = () => translateRows(S.rows.filter(r => status(r) === 'pending'));
$('#btnStop').onclick = () => S.abort && S.abort.abort();
$('#btnDl').onclick = () => download(false);
$('#q').oninput = e => { S.q = e.target.value; renderList(true) };
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.filter = b.dataset.f; document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderList(true) });

S.custom = !(window.claude && window.claude.use);
if (S.custom) { $('#engine').hidden = false; $('#btnRev').hidden = false; $('#btnAll').hidden = false; $('#btnOne').hidden = false; loadAI() }
(async () => {
    try {
        const c = window.claude; if (!c || !c.use) return;
        S.sample = await c.use('sample'); S.downloads = await c.use('downloads');
        if (S.sample) { $('#btnRev').hidden = false; $('#btnAll').hidden = false; $('#btnOne').hidden = false }
        if (S.downloads) $('#dlNote').textContent = 'O download chega como .zip com o .package dentro, porque a página só pode oferecer alguns tipos de arquivo. Extraia e coloque na pasta Mods.';
        if (S.rows.length) renderList();
    } catch (e) { }
})();
window.__sims = { callAI, translateAndDownload, importOldFile, importAi, applyOld, status, parsePackage, parseStbl, buildStbl, buildPackage, zipOne, entryData, exportPackage, S, diffTokens, tokens, translatable };
