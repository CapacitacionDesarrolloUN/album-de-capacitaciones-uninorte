#!/usr/bin/env python3
"""Genera los datos cifrados del álbum.

Uso:
  ALBUM_PASSWORD='...' python3 tools/build.py --fotos CARPETA [--plan PLAN.xlsx] [--repo .]

- CARPETA: fotos sueltas o una subcarpeta por capacitación. El nombre del archivo
  (o de la subcarpeta) es el nombre de la capacitación. Un número al final
  ("Excel avanzado 2.jpg", "Excel avanzado (3).jpg") se ignora para agrupar.
- PLAN: Excel del Plan de Formación. La fecha y el programa se buscan por el
  nombre de la actividad (coincidencia exacta o la más parecida).
- La contraseña nunca se guarda en el repositorio: se pasa por la variable
  ALBUM_PASSWORD. Cada foto y el índice se cifran con AES-256-GCM y una clave
  derivada con PBKDF2-SHA256, así que sin la contraseña los archivos no se pueden ver.

Las fotos ya publicadas se conservan: el script agrega lo nuevo al índice
existente y no borra nada. Para quitar una foto, edítala en data/correcciones.json.
"""
import argparse, base64, datetime as dt, difflib, hashlib, io, json, os, re, secrets, sys, unicodedata
from pathlib import Path

from PIL import Image, ImageOps
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 310000
EXT = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp'}
THUMB = 720
FULL = 2400


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def clean_title(stem):
    t = re.sub(r'[_]+', ' ', stem)
    t = re.sub(r'\s*[\(\[]\s*\d+\s*[\)\]]\s*$', '', t)      # "(2)"
    t = re.sub(r'\s*[-#]?\s*\d{1,3}\s*$', '', t)             # " 2", "-03"
    t = re.sub(r'\s*(copia|copy)\s*$', '', t, flags=re.I)
    return re.sub(r'\s+', ' ', t).strip(' -_.')


def key_from(password, salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER)
    return kdf.derive(password.encode('utf-8'))


def enc(aes, data):
    iv = secrets.token_bytes(12)
    return iv + aes.encrypt(iv, data, None)


def dec(aes, blob):
    return aes.decrypt(blob[:12], blob[12:], None)


def to_date(v):
    if v is None or v == '':
        return None
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)) and 20000 < v < 80000:  # serial de Excel
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    s = str(v).strip()
    for f in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%y', '%Y/%m/%d'):
        try:
            return dt.datetime.strptime(s[:10], f).date().isoformat()
        except ValueError:
            pass
    return None


def read_plan(path, cols):
    """Devuelve una lista de filas {nombre, fecha, programa, ...} del Plan de Formación."""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    rows = []
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        header, hi = None, 0
        for i, r in enumerate(it):
            cells = [norm(c) if c is not None else '' for c in r]
            if any(cols['nombre'] in c for c in cells):
                header, hi = cells, i
                break
            if i > 30:
                break
        if not header:
            continue

        def find(key):
            for j, c in enumerate(header):
                if c and key in c:
                    return j
            return None
        ix = {k: find(v) for k, v in cols.items() if v}
        if ix.get('nombre') is None:
            continue
        for r in it:
            nombre = r[ix['nombre']] if ix['nombre'] < len(r) else None
            if not nombre or not str(nombre).strip():
                continue
            row = {'nombre': str(nombre).strip(), 'hoja': ws.title}
            for k in ('fecha', 'fecha_fin', 'programa', 'modalidad', 'facilitador', 'lugar'):
                j = ix.get(k)
                if j is not None and j < len(r):
                    row[k] = r[j]
            row['fecha'] = to_date(row.get('fecha'))
            row['fecha_fin'] = to_date(row.get('fecha_fin'))
            for k in ('programa', 'modalidad', 'facilitador', 'lugar'):
                if row.get(k) is not None:
                    row[k] = str(row[k]).strip()
            rows.append(row)
    return rows


def match(title, plan, cutoff):
    if not plan:
        return None, 0
    t = norm(title)
    names = [norm(r['nombre']) for r in plan]
    exact = [r for r, n in zip(plan, names) if n == t]
    cands = exact
    score = 1.0
    if not exact:
        best = difflib.get_close_matches(t, list(set(names)), n=1, cutoff=cutoff)
        if not best:
            # nombre de la foto contenido en el del plan, o al revés
            sub = [r for r, n in zip(plan, names) if t and (t in n or n in t)]
            if not sub:
                return None, 0
            cands, score = sub, 0.8
        else:
            cands = [r for r, n in zip(plan, names) if n == best[0]]
            score = difflib.SequenceMatcher(None, t, best[0]).ratio()
    # si la actividad aparece varias veces, la más antigua con fecha
    cands = sorted(cands, key=lambda r: r.get('fecha') or '9999')
    return cands[0], score


def load_img(p):
    if p.suffix.lower() in ('.heic', '.heif'):
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            sys.exit('Para fotos HEIC instala pillow-heif: pip install pillow-heif')
    im = Image.open(p)
    im = ImageOps.exif_transpose(im)
    taken = None
    try:
        ex = im.getexif()
        raw = ex.get_ifd(0x8769).get(36867) or ex.get(306)
        if raw:
            taken = dt.datetime.strptime(str(raw)[:10], '%Y:%m:%d').date().isoformat()
    except Exception:
        pass
    return im.convert('RGB'), taken


def jpeg(im, maxw, q):
    im = im.copy()
    im.thumbnail((maxw, maxw), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=q, optimize=True, progressive=True)
    return b.getvalue(), im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fotos', required=True)
    ap.add_argument('--plan')
    ap.add_argument('--repo', default='.')
    ap.add_argument('--cutoff', type=float, default=0.72)
    ap.add_argument('--col-nombre', default='nombre de la actividad')
    ap.add_argument('--col-fecha', default='fecha')
    ap.add_argument('--col-fecha-fin', default='')
    ap.add_argument('--col-programa', default='programa')
    ap.add_argument('--col-modalidad', default='modalidad')
    ap.add_argument('--col-facilitador', default='facilitador')
    ap.add_argument('--col-lugar', default='lugar')
    ap.add_argument('--reporte', default='reporte-cruce.csv')
    a = ap.parse_args()

    pw = os.environ.get('ALBUM_PASSWORD')
    if not pw:
        sys.exit('Falta la variable ALBUM_PASSWORD')

    repo = Path(a.repo)
    data = repo / 'data'
    (data / 'p').mkdir(parents=True, exist_ok=True)
    cfgp = data / 'config.json'
    if cfgp.exists():
        cfg = json.loads(cfgp.read_text())
        salt = base64.b64decode(cfg['salt'])
    else:
        salt = secrets.token_bytes(16)
        cfg = {'salt': base64.b64encode(salt).decode(), 'iterations': ITER, 'v': 1}
    aes = AESGCM(key_from(pw, salt))

    manp = data / 'indice.bin'
    if manp.exists():
        try:
            man = json.loads(dec(aes, manp.read_bytes()))
        except Exception:
            sys.exit('La contraseña no coincide con la del índice existente.')
    else:
        man = {'capacitaciones': []}
    by_key = {norm(c['titulo']): c for c in man['capacitaciones']}
    seen = {ph['hash'] for c in man['capacitaciones'] for ph in c['fotos']}

    cols = {'nombre': norm(a.col_nombre), 'fecha': norm(a.col_fecha), 'fecha_fin': norm(a.col_fecha_fin),
            'programa': norm(a.col_programa), 'modalidad': norm(a.col_modalidad),
            'facilitador': norm(a.col_facilitador), 'lugar': norm(a.col_lugar)}
    plan = read_plan(a.plan, cols) if a.plan else []
    if a.plan:
        print(f'Plan de Formación: {len(plan)} actividades leídas')

    root = Path(a.fotos)
    files = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in EXT
                   and not p.name.startswith('.') and '__MACOSX' not in p.parts)
    # Un número final ("Excel 2") solo se quita si hay otras fotos con el mismo nombre base.
    from collections import Counter
    bases = Counter(clean_title(f.stem) for f in files if len(f.relative_to(root).parts) == 1)
    report = []
    added = 0
    for f in files:
        rel = f.relative_to(root)
        if len(rel.parts) > 1:
            title = clean_title(rel.parts[0])
        else:
            base = clean_title(f.stem)
            paren = re.search(r'[\(\[]\s*\d+\s*[\)\]]\s*$', f.stem)
            title = base if (bases[base] > 1 or paren) else re.sub(r'[_]+', ' ', f.stem).strip()
        raw = f.read_bytes()
        h = hashlib.sha256(raw).hexdigest()[:20]
        if h in seen:
            continue
        seen.add(h)
        im, taken = load_img(f)
        k = norm(title)
        c = by_key.get(k) or next((x for x in man['capacitaciones'] if norm(x.get('titulo_foto', '')) == k), None)
        if not c:
            row, score = match(title, plan, a.cutoff)
            c = {'id': secrets.token_hex(6), 'titulo': title, 'fecha': None, 'fotos': []}
            if row:
                c['titulo_foto'] = title
                c['titulo'] = row['nombre']
                c['fecha'] = row.get('fecha')
                for kk in ('fecha_fin', 'programa', 'modalidad', 'facilitador', 'lugar'):
                    if row.get(kk):
                        c[kk] = row[kk]
                c['origen_fecha'] = 'plan'
            report.append([title, row['nombre'] if row else '', f'{score:.2f}', (row or {}).get('fecha') or ''])
            by_key[k] = c
            man['capacitaciones'].append(c)
        if not c.get('fecha') and taken:
            c['fecha'] = taken
            c['origen_fecha'] = 'foto'
        pid = secrets.token_hex(8)
        tb, tsize = jpeg(im, THUMB, 78)
        fb, fsize = jpeg(im, FULL, 86)
        (data / 'p' / f'{pid}.t').write_bytes(enc(aes, tb))
        (data / 'p' / f'{pid}.f').write_bytes(enc(aes, fb))
        c['fotos'].append({'id': pid, 'w': fsize[0], 'h': fsize[1], 'hash': h, 'archivo': f.name})
        added += 1
        print(f'  + {title}  ({f.name})')

    # correcciones manuales: {"Nombre de la capacitación": {"fecha": "2026-03-14", "programa": "SST", "titulo": "..."}}
    corp = data / 'correcciones.json'
    if corp.exists():
        cor = {norm(k): v for k, v in json.loads(corp.read_text()).items()}
        for c in man['capacitaciones']:
            fix = cor.get(norm(c['titulo']))
            if fix:
                for kk, vv in fix.items():
                    if kk == 'titulo':
                        c['titulo'] = vv
                    elif kk == 'quitar_fotos':
                        c['fotos'] = [p for p in c['fotos'] if p['archivo'] not in vv]
                    else:
                        c[kk] = vv
                c['origen_fecha'] = 'correccion' if 'fecha' in fix else c.get('origen_fecha')

    man['actualizado'] = dt.date.today().isoformat()
    man['capacitaciones'].sort(key=lambda c: (c.get('fecha') or '0000', c['titulo']), reverse=True)
    manp.write_bytes(enc(aes, json.dumps(man, ensure_ascii=False).encode()))
    cfgp.write_text(json.dumps(cfg))

    if report:
        import csv
        with open(a.reporte, 'w', newline='', encoding='utf-8-sig') as fh:
            w = csv.writer(fh)
            w.writerow(['Nombre en la foto', 'Actividad en el Plan', 'Parecido', 'Fecha'])
            w.writerows(report)
    sin = [c['titulo'] for c in man['capacitaciones'] if not c.get('fecha')]
    print(f'\n{added} fotos nuevas. {len(man["capacitaciones"])} capacitaciones en el álbum.')
    if sin:
        print(f'{len(sin)} sin fecha: ' + '; '.join(sin))


if __name__ == '__main__':
    main()
