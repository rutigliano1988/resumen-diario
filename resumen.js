// Resumen diario: lee Proyectos y Tareas en Notion y lo manda por Telegram.
// Variables de entorno necesarias (se configuran en Vercel, nunca en el código):
//   NOTION_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET
// Opcionales: PROYECTOS_DB_ID, TAREAS_DB_ID

const NOTION_VERSION = '2022-06-28';
const PROYECTOS_DB = process.env.PROYECTOS_DB_ID || 'b4458b10545544e2ad70d4a959bc8722';
const TAREAS_DB = process.env.TAREAS_DB_ID || '5531c7e9476b40889d85983e5932b2c7';
const TZ = 'Europe/Madrid';
const HORA_ENVIO = 8; // hora de Madrid a la que debe salir el resumen
const MAX_ITEMS = 8;
const DIAS_SIN_TOCAR = 14;
const DIAS_FECHAS_CLAVE = 60;
const PRIORIDAD = { Alta: 0, Media: 1, Baja: 2 };

// ---------- utilidades de lectura de propiedades de Notion ----------
const plain = (arr) => (arr || []).map((t) => t.plain_text).join('').trim();
const getText = (p) => (p ? plain(p.title || p.rich_text) : '');
const getSelect = (p) => (p && p.select ? p.select.name : '');
const getCheck = (p) => Boolean(p && p.checkbox);
const getDate = (p) => (p && p.date && p.date.start ? p.date.start.slice(0, 10) : '');

// ---------- utilidades de fechas ----------
const toDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const diffDays = (a, b) => Math.round(toDay(a) - toDay(b));
const fmtShort = (iso) =>
  new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const dias = (n) => `${n} ${n === 1 ? 'día' : 'días'}`;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

function madridNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { now, date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24 };
}

// ---------- Notion ----------
async function queryAll(dbId) {
  const results = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!r.ok) throw new Error(`Notion respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function parseProyecto(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    nombre: getText(p['Proyecto']),
    estado: getSelect(p['Estado']),
    prioridad: getSelect(p['Prioridad']),
    atencion: getCheck(p['Necesita mi atención']),
    siguiente: getText(p['Siguiente paso']),
    esperandoA: getText(p['Esperando a']),
    esperandoDesde: getDate(p['Esperando desde']),
    fechaClave: getDate(p['Fecha clave']),
    editado: (page.last_edited_time || '').slice(0, 10),
  };
}

function parseTarea(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    nombre: getText(p['Tarea']),
    estado: getSelect(p['Estado']),
    fecha: getDate(p['Fecha límite']),
    para: getText(p['Para']),
    contexto: getText(p['Contexto']),
    proyectoIds: ((p['Proyecto'] && p['Proyecto'].relation) || []).map((r) => r.id),
  };
}

// ---------- construcción del mensaje ----------
function section(title, items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_ITEMS);
  const extra = items.length - shown.length;
  return [`${title} (${items.length})`, ...shown.map((i) => `• ${i}`), extra > 0 ? `… y ${extra} más` : '']
    .filter(Boolean)
    .join('\n');
}

function buildMessage({ proyectos, tareas, today, now }) {
  const activos = proyectos.filter((p) => p.estado !== 'Cerrado' && p.nombre);
  const abiertas = tareas.filter((t) => t.estado !== 'Done' && t.nombre);
  const byPrioridad = (a, b) => (PRIORIDAD[a.prioridad] ?? 3) - (PRIORIDAD[b.prioridad] ?? 3);

  const tareasHoy = abiertas
    .filter((t) => t.fecha && t.fecha <= today)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((t) => {
      const d = diffDays(today, t.fecha);
      return `${t.nombre}${t.para ? ` (${t.para})` : ''}: ${d === 0 ? 'vence hoy' : `atrasada ${dias(d)}`}`;
    });

  const atencion = activos
    .filter((p) => p.atencion)
    .sort(byPrioridad)
    .map((p) => `${p.nombre}${p.siguiente ? ` → ${cut(p.siguiente, 140)}` : ''}`);

  const conEspera = activos.filter((p) => p.esperandoA);
  const idsConEspera = new Set(conEspera.map((p) => p.id));
  const esperando = [
    ...conEspera.map((p) => {
      const desde = p.esperandoDesde
        ? ` (desde el ${fmtShort(p.esperandoDesde)}, ${dias(diffDays(today, p.esperandoDesde))})`
        : '';
      return `${p.nombre}: ${cut(p.esperandoA, 100)}${desde}`;
    }),
    // Tareas en espera que no estén ya cubiertas por un proyecto con "Esperando a"
    ...abiertas
      .filter((t) => t.estado === 'Waiting On' && !t.proyectoIds.some((id) => idsConEspera.has(id)))
      .map((t) => `${t.nombre}${t.contexto ? `: ${cut(t.contexto, 100)}` : ''}`),
  ];

  const fechas = activos
    .filter((p) => p.fechaClave && diffDays(p.fechaClave, today) >= 0 && diffDays(p.fechaClave, today) <= DIAS_FECHAS_CLAVE)
    .sort((a, b) => a.fechaClave.localeCompare(b.fechaClave))
    .map((p) => {
      const d = diffDays(p.fechaClave, today);
      return `${p.nombre}: ${fmtShort(p.fechaClave)} (${d === 0 ? 'hoy' : `en ${dias(d)}`})`;
    });

  const sinTocar = activos
    .filter((p) => ['Activo', 'En espera'].includes(p.estado) && p.editado && diffDays(today, p.editado) > DIAS_SIN_TOCAR)
    .sort((a, b) => a.editado.localeCompare(b.editado))
    .map((p) => `${p.nombre} (hace ${dias(diffDays(today, p.editado))})`);

  const fechaLarga = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  }).format(now);
  const cabecera = `Buenos días, Francesco\n${fechaLarga.charAt(0).toUpperCase()}${fechaLarga.slice(1)}`;

  const bloques = [
    section('🔥 Tareas para hoy o atrasadas', tareasHoy),
    section('👀 Necesita tu atención', atencion),
    section('⏳ Esperando a algo o alguien', esperando),
    section(`📅 Fechas clave en los próximos ${DIAS_FECHAS_CLAVE} días`, fechas),
    section(`😴 Sin tocar hace más de ${DIAS_SIN_TOCAR} días`, sinTocar),
  ].filter(Boolean);

  const cuerpo = bloques.length ? bloques.join('\n\n') : 'Hoy no tienes nada urgente. Buen día.';
  const texto = `${cabecera}\n\n${cuerpo}`;
  return texto.length > 4000 ? `${texto.slice(0, 3990)}\n…` : texto;
}

// ---------- Telegram ----------
async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(`Telegram respondió ${r.status}: ${data.description || 'error desconocido'}`);
}

// Evita que un token se cuele en un mensaje de error
function scrub(msg) {
  let out = String(msg);
  for (const k of ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'CRON_SECRET']) {
    const v = process.env[k];
    if (v) out = out.split(v).join('***');
  }
  return out;
}

// ---------- handler ----------
async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const query = req.query || {};
  const autorizado =
    Boolean(secret) && (req.headers.authorization === `Bearer ${secret}` || query.key === secret);
  if (!autorizado) return res.status(401).json({ ok: false, error: 'no autorizado' });

  const faltan = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter((k) => !process.env[k]);
  if (faltan.length) return res.status(500).json({ ok: false, error: `faltan variables: ${faltan.join(', ')}` });

  const { now, date, hour } = madridNow();
  const force = query.force === '1';
  const dry = query.dry === '1';

  // Vercel programa en UTC: hay dos disparos al día y solo uno coincide con las 8:xx de Madrid.
  if (!force && hour !== HORA_ENVIO) {
    return res.status(200).json({ ok: true, skipped: true, horaMadrid: hour });
  }

  try {
    const [pp, tt] = await Promise.all([queryAll(PROYECTOS_DB), queryAll(TAREAS_DB)]);
    const texto = buildMessage({
      proyectos: pp.map(parseProyecto),
      tareas: tt.map(parseTarea),
      today: date,
      now,
    });

    if (dry) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(texto);
    }
    await sendTelegram(texto);
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    const msg = scrub(e.message);
    try {
      await sendTelegram(`⚠️ El resumen diario falló: ${msg}`);
    } catch (_) {
      /* si Telegram también falla, solo queda el log de Vercel */
    }
    return res.status(500).json({ ok: false, error: msg });
  }
}

module.exports = handler;
module.exports.buildMessage = buildMessage;
