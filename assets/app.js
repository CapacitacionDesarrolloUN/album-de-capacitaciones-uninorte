(() => {
  'use strict';

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const CLAVE_SESION = 'album-cyd-clave';
  const $ = (id) => document.getElementById(id);

  let clave = null;          // CryptoKey AES-GCM
  let datos = null;          // índice descifrado
  const cacheMini = new Map();
  const cacheGrande = new Map();

  // ---------- cifrado ----------
  const b64 = {
    a: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
    de: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  };

  async function derivar(contrasena, config) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(contrasena), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64.de(config.salt), iterations: config.iterations },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  async function descifrar(buf) {
    const u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, clave, u.slice(12));
  }

  async function traer(ruta) {
    const r = await fetch(ruta, { cache: 'no-cache' });
    if (!r.ok) throw new Error('No se pudo cargar ' + ruta + ' (' + r.status + ')');
    return r;
  }

  async function urlFoto(id, tipo) {
    const cache = tipo === 't' ? cacheMini : cacheGrande;
    if (cache.has(id)) return cache.get(id);
    const p = (async () => {
      const buf = await (await traer('data/p/' + id + '.' + tipo)).arrayBuffer();
      const plano = await descifrar(buf);
      return URL.createObjectURL(new Blob([plano], { type: 'image/jpeg' }));
    })();
    cache.set(id, p);
    p.catch(() => cache.delete(id));
    return p;
  }

  // ---------- acceso ----------
  async function entrar(contrasena, guardada) {
    const config = await (await traer('data/config.json')).json();
    let k;
    if (guardada) {
      k = await crypto.subtle.importKey('raw', b64.de(guardada), 'AES-GCM', true, ['decrypt']);
    } else {
      k = await derivar(contrasena, config);
    }
    clave = k;
    const indice = await (await traer('data/indice.bin')).arrayBuffer();
    let plano;
    try {
      plano = await descifrar(indice);
    } catch (e) {
      clave = null;
      throw new Error('clave');
    }
    datos = JSON.parse(new TextDecoder().decode(plano));
    try { sessionStorage.setItem(CLAVE_SESION, b64.a(await crypto.subtle.exportKey('raw', k))); } catch (e) { /* sin almacenamiento */ }
  }

  function mostrarAlbum() {
    $('acceso').hidden = true;
    $('album').hidden = false;
    prepararFiltros();
    pintar();
    medirCabecera();
    $('lista').focus({ preventScroll: true });
  }

  $('ver-clave').addEventListener('click', (e) => {
    const inp = $('clave');
    const ver = inp.type === 'password';
    inp.type = ver ? 'text' : 'password';
    e.currentTarget.textContent = ver ? 'Ocultar' : 'Mostrar';
    e.currentTarget.setAttribute('aria-pressed', String(ver));
  });

  $('form-acceso').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('error-acceso');
    const btn = $('entrar');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Abriendo el álbum';
    try {
      await entrar($('clave').value);
      mostrarAlbum();
    } catch (ex) {
      err.textContent = ex.message === 'clave'
        ? 'La contraseña no es correcta. Revise mayúsculas y minúsculas.'
        : 'No se pudo abrir el álbum: ' + ex.message + '. Revise la conexión e intente de nuevo.';
      err.hidden = false;
      $('clave').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  $('salir').addEventListener('click', () => {
    try { sessionStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
    location.reload();
  });

  // ---------- utilidades ----------
  const sinTildes = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const partes = (iso) => { const [a, m, d] = iso.split('-').map(Number); return { a, m, d }; };
  const plural = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);

  function fechaLarga(c) {
    if (!c.fecha) return 'Sin fecha registrada';
    const i = partes(c.fecha);
    let s = i.d + ' de ' + MESES[i.m - 1] + ' de ' + i.a;
    if (c.fecha_fin && c.fecha_fin !== c.fecha) {
      const f = partes(c.fecha_fin);
      s = f.m === i.m && f.a === i.a
        ? 'Del ' + i.d + ' al ' + f.d + ' de ' + MESES[i.m - 1] + ' de ' + i.a
        : 'Del ' + i.d + ' de ' + MESES[i.m - 1] + ' al ' + f.d + ' de ' + MESES[f.m - 1] + ' de ' + f.a;
    }
    return s;
  }

  function meta(c) {
    const p = [];
    if (c.facilitador) p.push('Facilitador: ' + c.facilitador);
    if (c.lugar) p.push(c.lugar);
    if (c.modalidad) p.push(c.modalidad);
    return p;
  }

  function el(tag, attrs, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const h of hijos.flat()) if (h != null && h !== false) n.append(h.nodeType ? h : document.createTextNode(h));
    return n;
  }

  // ---------- filtros ----------
  function prepararFiltros() {
    const caps = datos.capacitaciones;
    const anios = [...new Set(caps.filter((c) => c.fecha).map((c) => c.fecha.slice(0, 4)))].sort().reverse();
    const sel = $('f-anio');
    anios.forEach((a) => sel.append(el('option', { value: a }, a)));
    if (caps.some((c) => !c.fecha)) sel.append(el('option', { value: 'sin' }, 'Sin fecha'));

    const progs = [...new Set(caps.map((c) => c.programa).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    if (progs.length > 1) {
      $('filtro-programa').hidden = false;
      progs.forEach((p) => $('f-programa').append(el('option', { value: p }, p)));
    }

    const fotos = caps.reduce((n, c) => n + c.fotos.length, 0);
    let res = plural(caps.length, 'capacitación', 'capacitaciones') + ', ' + plural(fotos, 'foto', 'fotos');
    if (datos.actualizado) { const u = partes(datos.actualizado); res += '. Actualizado el ' + u.d + ' de ' + MESES[u.m - 1] + ' de ' + u.a; }
    $('resumen').textContent = res;

    let t;
    $('buscar').addEventListener('input', () => { clearTimeout(t); t = setTimeout(pintar, 120); });
    ['f-anio', 'f-programa', 'f-orden'].forEach((id) => $(id).addEventListener('change', pintar));
  }

  function filtradas() {
    const q = sinTildes($('buscar').value.trim());
    const anio = $('f-anio').value;
    const prog = $('f-programa').value;
    const orden = $('f-orden').value;
    let lista = datos.capacitaciones.filter((c) => {
      if (anio === 'sin' && c.fecha) return false;
      if (anio && anio !== 'sin' && (!c.fecha || c.fecha.slice(0, 4) !== anio)) return false;
      if (prog && c.programa !== prog) return false;
      if (q) {
        const texto = sinTildes([c.titulo, c.titulo_foto, c.facilitador, c.lugar, c.programa, c.modalidad].join(' '));
        if (!q.split(/\s+/).every((w) => texto.includes(w))) return false;
      }
      return true;
    });
    if (orden === 'az') lista.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
    else {
      const s = orden === 'asc' ? 1 : -1;
      lista.sort((a, b) => {
        if (!a.fecha !== !b.fecha) return a.fecha ? -1 : 1;
        return s * ((a.fecha || '').localeCompare(b.fecha || '')) || a.titulo.localeCompare(b.titulo, 'es');
      });
    }
    return { lista, orden };
  }

  // ---------- pintar ----------
  let observadorFotos, observadorMeses;

  function pintar() {
    const { lista, orden } = filtradas();
    const cont = $('lista');
    const nav = $('meses');
    cont.replaceChildren();
    nav.replaceChildren();
    if (observadorFotos) observadorFotos.disconnect();
    if (observadorMeses) observadorMeses.disconnect();

    if (!lista.length) {
      cont.append(el('div', { class: 'vacio' },
        el('h2', {}, 'No hay capacitaciones con esos filtros'),
        el('p', {}, 'Pruebe con otra palabra o elija "Todos" en año y programa.')));
      return;
    }

    observadorFotos = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        observadorFotos.unobserve(en.target);
        const img = en.target;
        urlFoto(img.dataset.id, 't').then((u) => { img.src = u; img.onload = () => img.classList.add('lista-img'); })
          .catch(() => { img.alt = 'No se pudo cargar la foto'; });
      });
    }, { rootMargin: '600px 0px' });

    if (orden === 'az') {
      const sec = el('section', { class: 'anio' });
      sec.append(el('p', { class: 'anio__cuenta' }, plural(lista.length, 'capacitación', 'capacitaciones') + ' en orden alfabético'));
      lista.forEach((c) => sec.append(tarjeta(c)));
      cont.append(sec);
      return;
    }

    // agrupar por año y mes
    const grupos = new Map();
    lista.forEach((c) => {
      const a = c.fecha ? c.fecha.slice(0, 4) : 'sin';
      const m = c.fecha ? c.fecha.slice(0, 7) : 'sin';
      if (!grupos.has(a)) grupos.set(a, new Map());
      const g = grupos.get(a);
      if (!g.has(m)) g.set(m, []);
      g.get(m).push(c);
    });

    const enlaces = [];
    for (const [a, meses] of grupos) {
      const total = [...meses.values()].reduce((n, l) => n + l.length, 0);
      const sec = el('section', { class: 'anio', 'aria-labelledby': 'a-' + a });
      sec.append(el('h2', { class: 'anio__numero' + (a === 'sin' ? ' anio__numero--sin' : ''), id: 'a-' + a }, a === 'sin' ? 'Sin fecha' : a));
      sec.append(el('p', { class: 'anio__cuenta' }, a === 'sin'
        ? plural(total, 'capacitación', 'capacitaciones') + ' que no se encontraron en el Plan de Formación'
        : plural(total, 'capacitación', 'capacitaciones')));
      nav.append(el('h2', {}, a === 'sin' ? 'Sin fecha' : a));

      for (const [m, caps] of meses) {
        const idMes = 'm-' + m;
        if (m !== 'sin') {
          const nombre = MESES[Number(m.slice(5)) - 1];
          sec.append(el('h3', { class: 'mes', id: idMes }, nombre.charAt(0).toUpperCase() + nombre.slice(1)));
          const enlace = el('a', { href: '#' + idMes, onclick: (e) => { e.preventDefault(); $(idMes).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } },
            nombre.charAt(0).toUpperCase() + nombre.slice(1), el('span', {}, String(caps.length)));
          enlaces.push([idMes, enlace]);
          nav.append(enlace);
        } else {
          const enlace = el('a', { href: '#a-sin', onclick: (e) => { e.preventDefault(); $('a-sin').scrollIntoView(); } }, 'Ver', el('span', {}, String(caps.length)));
          nav.append(enlace);
        }
        caps.forEach((c) => sec.append(tarjeta(c)));
      }
      cont.append(sec);
    }

    observadorMeses = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        enlaces.forEach(([id, a]) => a.classList.toggle('activo', id === en.target.id));
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    enlaces.forEach(([id]) => observadorMeses.observe($(id)));
  }

  function bloqueFecha(c) {
    if (!c.fecha) return el('div', { class: 'cap__fecha' }, el('span', { class: 'cap__sinfecha' }, 'Sin fecha'));
    const i = partes(c.fecha);
    let dia = String(i.d);
    let rango = false;
    if (c.fecha_fin && c.fecha_fin !== c.fecha) {
      const f = partes(c.fecha_fin);
      if (f.m === i.m && f.a === i.a) { dia = i.d + '-' + f.d; rango = true; }
    }
    return el('div', { class: 'cap__fecha', 'aria-hidden': 'true' },
      el('span', { class: 'cap__dia' + (rango ? ' cap__dia--rango' : '') }, dia),
      el('span', { class: 'cap__mes' }, MESES[i.m - 1].slice(0, 3) + '. ' + i.a));
  }

  function tarjeta(c) {
    const MAX = 5;
    const n = c.fotos.length;
    const clase = n === 1 ? 'mosaico--1' : n === 2 ? 'mosaico--2' : n === 3 ? 'mosaico--3' : 'mosaico--n';
    const mosaico = el('div', { class: 'mosaico ' + clase });
    c.fotos.slice(0, MAX).forEach((f, i) => {
      const img = el('img', { alt: '', 'data-id': f.id, width: f.w, height: f.h, decoding: 'async' });
      const resto = n - MAX;
      const btn = el('button', { type: 'button', class: 'foto', 'aria-label': 'Ver foto ' + (i + 1) + ' de ' + n + ' de ' + c.titulo, onclick: () => abrirVisor(c, i) },
        img, i === MAX - 1 && resto > 0 ? el('span', { class: 'foto__mas' }, '+' + resto + ' fotos') : null);
      mosaico.append(btn);
      observadorFotos.observe(img);
    });

    const m = meta(c);
    const info = el('div', { class: 'cap__info' },
      el('h3', {}, c.titulo),
      el('p', { class: 'cap__meta' },
        fechaLarga(c),
        c.programa ? ['. ', el('span', { class: 'cap__programa' }, c.programa)] : null,
        m.length ? '. ' + m.join('. ') : null),
      c.origen_fecha === 'foto' ? el('p', { class: 'cap__aviso' }, 'Fecha tomada de la foto; no aparece en el Plan de Formación.') : null,
      mosaico);
    return el('article', { class: 'cap', id: 'c-' + c.id }, bloqueFecha(c), info);
  }

  // ---------- visor ----------
  let actual = null, indice = 0, foco = null;

  function abrirVisor(c, i) {
    actual = c; foco = document.activeElement;
    $('visor-titulo').textContent = c.titulo;
    $('visor-meta').textContent = [fechaLarga(c), c.programa].filter(Boolean).join('. ');
    const tira = $('visor-tira');
    tira.replaceChildren();
    c.fotos.forEach((f, j) => {
      const img = el('img', { alt: '' });
      urlFoto(f.id, 't').then((u) => { img.src = u; }).catch(() => {});
      tira.append(el('button', { type: 'button', 'aria-label': 'Foto ' + (j + 1), onclick: () => ir(j) }, img));
    });
    tira.hidden = c.fotos.length < 2;
    $('visor-ant').hidden = $('visor-sig').hidden = c.fotos.length < 2;
    $('visor-descargar-todas').hidden = c.fotos.length < 2;
    $('visor').hidden = false;
    document.body.style.overflow = 'hidden';
    ir(i);
    $('visor-cerrar').focus();
  }

  async function ir(j) {
    const n = actual.fotos.length;
    indice = (j + n) % n;
    const f = actual.fotos[indice];
    $('visor-contador').textContent = (indice + 1) + ' de ' + n;
    [...$('visor-tira').children].forEach((b, k) => b.setAttribute('aria-current', String(k === indice)));
    const t = $('visor-tira').children[indice];
    if (t) t.scrollIntoView({ block: 'nearest', inline: 'center' });
    const img = $('visor-img');
    img.alt = 'Foto ' + (indice + 1) + ' de ' + actual.titulo;
    try { img.src = await urlFoto(f.id, 't'); } catch (e) { /* sigue */ }
    const pedido = indice;
    try {
      const u = await urlFoto(f.id, 'f');
      if (pedido === indice && actual) img.src = u;
    } catch (e) { /* queda la miniatura */ }
    // precargar la siguiente
    if (n > 1) urlFoto(actual.fotos[(indice + 1) % n].id, 'f').catch(() => {});
  }

  function cerrarVisor() {
    $('visor').hidden = true;
    document.body.style.overflow = '';
    actual = null;
    $('visor-img').removeAttribute('src');
    if (foco) foco.focus();
  }

  const nombreArchivo = (c, k) => (c.titulo.replace(/[\\/:*?"<>|]+/g, ' ').trim() + (c.fotos.length > 1 ? ' ' + (k + 1) : '') + '.jpg');

  function bajar(url, nombre) {
    const a = el('a', { href: url, download: nombre });
    document.body.append(a); a.click(); a.remove();
  }

  $('visor-descargar').addEventListener('click', async () => {
    const c = actual, k = indice;
    bajar(await urlFoto(c.fotos[k].id, 'f'), nombreArchivo(c, k));
  });

  $('visor-descargar-todas').addEventListener('click', async (e) => {
    const btn = e.currentTarget, c = actual;
    btn.disabled = true;
    const archivos = [];
    for (let k = 0; k < c.fotos.length; k++) {
      btn.textContent = 'Preparando ' + (k + 1) + ' de ' + c.fotos.length;
      const u = await urlFoto(c.fotos[k].id, 'f');
      archivos.push({ nombre: nombreArchivo(c, k), datos: new Uint8Array(await (await fetch(u)).arrayBuffer()) });
    }
    const zip = crearZip(archivos);
    const u = URL.createObjectURL(zip);
    bajar(u, c.titulo.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.zip');
    setTimeout(() => URL.revokeObjectURL(u), 10000);
    btn.disabled = false;
    btn.textContent = 'Descargar todas';
  });

  $('visor-cerrar').addEventListener('click', cerrarVisor);
  $('visor-ant').addEventListener('click', () => ir(indice - 1));
  $('visor-sig').addEventListener('click', () => ir(indice + 1));
  document.addEventListener('keydown', (e) => {
    if ($('visor').hidden) return;
    if (e.key === 'Escape') cerrarVisor();
    else if (e.key === 'ArrowLeft') ir(indice - 1);
    else if (e.key === 'ArrowRight') ir(indice + 1);
    else if (e.key === 'Tab') {
      const f = [...$('visor').querySelectorAll('button:not([hidden]):not([disabled])')].filter((b) => b.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  let x0 = null;
  $('visor-img').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $('visor-img').addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50 && actual && actual.fotos.length > 1) ir(indice + (dx < 0 ? 1 : -1));
  });

  // ---------- zip sin compresión ----------
  const TABLA = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = TABLA[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function crearZip(archivos) {
    const enc = new TextEncoder();
    const partesZip = [], central = [];
    let off = 0;
    for (const f of archivos) {
      const nom = enc.encode(f.nombre), crc = crc32(f.datos), tam = f.datos.length;
      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
      loc.setUint32(14, crc, true); loc.setUint32(18, tam, true); loc.setUint32(22, tam, true); loc.setUint16(26, nom.length, true);
      partesZip.push(loc.buffer, nom, f.datos);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, tam, true); cen.setUint32(24, tam, true); cen.setUint16(28, nom.length, true);
      cen.setUint32(42, off, true);
      central.push(cen.buffer, nom);
      off += 30 + nom.length + tam;
    }
    const tamCentral = central.reduce((n, b) => n + b.byteLength, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tamCentral, true); fin.setUint32(16, off, true);
    return new Blob([...partesZip, ...central, fin.buffer], { type: 'application/zip' });
  }

  // ---------- cabecera fija ----------
  function medirCabecera() {
    const h = document.querySelector('.cabecera').offsetHeight;
    document.documentElement.style.setProperty('--alto-cabecera', h + 'px');
  }
  addEventListener('resize', () => { if (!$('album').hidden) medirCabecera(); });

  // ---------- inicio ----------
  (async () => {
    if (!window.crypto || !crypto.subtle) {
      $('error-acceso').textContent = 'Este navegador no puede abrir el álbum. Use una versión reciente de Edge, Chrome, Safari o Firefox.';
      $('error-acceso').hidden = false;
      return;
    }
    let guardada = null;
    try { guardada = sessionStorage.getItem(CLAVE_SESION); } catch (e) { /* nada */ }
    if (guardada) {
      try { await entrar(null, guardada); mostrarAlbum(); return; } catch (e) { try { sessionStorage.removeItem(CLAVE_SESION); } catch (x) { /* nada */ } }
    }
    $('clave').focus();
  })();
})();
