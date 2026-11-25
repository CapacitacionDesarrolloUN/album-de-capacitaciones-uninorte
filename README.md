# Álbum de capacitaciones

Página del equipo de Capacitación y Desarrollo (Dirección de Gestión Humana, Universidad del Norte) con las fotos de las capacitaciones del Plan de Formación, ordenadas por fecha.

La página pide una contraseña. Las fotos y el índice se guardan cifrados (AES-256-GCM, clave derivada de la contraseña con PBKDF2-SHA256), así que quien abra los archivos del repositorio sin la contraseña solo ve datos ilegibles. La contraseña no está guardada en ningún archivo.

## Agregar fotos

Desde la página: botón "Añadir fotos". Se eligen las fotos, la capacitación (existente o nueva) y se suben. La página las reduce, las cifra y las guarda en el repositorio en un solo cambio. La primera vez pide un token de GitHub con permiso Contents: Read and write sobre este repositorio.

Por lotes, con el script:


1. Nombre cada foto con el nombre de la capacitación, tal como aparece en el Plan de Formación o parecido. Si una capacitación tiene varias fotos: `Excel avanzado 1.jpg`, `Excel avanzado 2.jpg`, o una carpeta `Excel avanzado/` con las fotos dentro.
2. Ejecute, desde la carpeta del repositorio:

   ```
   pip install pillow cryptography openpyxl
   ALBUM_PASSWORD='<contraseña>' python3 tools/build.py --fotos CARPETA_DE_FOTOS --plan "Plan de Formación.xlsx"
   ```

   El script reduce cada foto (máximo 2400 px), la cifra, busca la fecha y el programa en el Plan por el nombre de la actividad y agrega todo al índice. Las fotos que ya estaban se conservan y las repetidas se omiten. Deja un `reporte-cruce.csv` (no se sube) con el nombre de cada foto, la actividad que encontró y qué tan parecida es.
3. Suba los cambios de `data/` al repositorio. GitHub Pages publica en uno o dos minutos.

## Corregir una fecha, un nombre o quitar una foto

Edite `data/correcciones.json` y vuelva a ejecutar el paso 2 (sin fotos nuevas basta con una carpeta vacía):

```json
{
  "Taller sin plan": { "fecha": "2026-04-18", "programa": "SST" },
  "Excel avanzado": { "titulo": "Excel avanzado para analistas", "quitar_fotos": ["Excel avanzado 3.jpg"] }
}
```

Las fotos quitadas desaparecen de la página; sus archivos cifrados quedan en `data/p/`.

## Archivos

- `index.html`, `assets/`: la página.
- `data/config.json`: sal y número de iteraciones del cifrado (no son secretos).
- `data/indice.bin`: índice cifrado (capacitaciones, fechas, programa, lista de fotos).
- `data/p/*.t` y `*.f`: miniatura y foto grande de cada imagen, cifradas.
- `tools/build.py`: script que genera `data/`.
