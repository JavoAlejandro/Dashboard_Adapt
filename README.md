# Dashboard de Impactos — Corriente vs Alternativa

Visualización interactiva de rutas GPS y análisis socioeconómico para Antofagasta.

## Estructura del proyecto

```
dashboard_impactos/
├── index.html          ← Punto de entrada — HTML puro, sin lógica inline
├── css/
│   └── styles.css      ← Todos los estilos (variables, componentes, responsive)
├── js/
│   ├── impactos.js     ← Tab "Impactos H3": carga CSV, mapas H3, gráficos comparativos
│   ├── gps.js          ← Tab "GPS": carga GeoJSON, rutas, búsqueda, comparación, vías, stays
│   ├── animation.js    ← Motor de animación de recorridos (rAF, progreso, velocidad)
│   └── init.js         ← Bootstrap: inicializa charts al cargar la página
└── README.md
```

## Módulos JavaScript

| Archivo | Responsabilidad |
|---|---|
| `impactos.js` | Constantes globales (LABELS, COL_KEYS, PALETTES), carga de CSV H3, inicialización de mapas Leaflet duales sincronizados, renderizado de hexágonos, gráficos Chart.js (barras + radar), cambio de tab |
| `gps.js` | Carga de GeoJSON, renderizado en lotes (batches de 200), estadísticas por bus/grupo, búsqueda por bus+día+mes, filtro por vía, modo comparación, selector de coordenadas, stays markers, chips de buses |
| `animation.js` | Animación frame-by-frame de rutas (requestAnimationFrame), control de velocidad, barra de progreso, marcadores de inicio/fin |
| `init.js` | Llamada inicial a `buildCharts()` al cargar el DOM |

## Dependencias externas (CDN)

| Librería | Versión | Uso |
|---|---|---|
| Leaflet | 1.9.4 | Mapas interactivos (GPS + H3) |
| Chart.js | 4.4.0 | Gráficos de barras y radar |
| PapaParse | 5.4.1 | Parseo de CSV |
| h3-js | 4.1.0 | Conversión de índices H3 a polígonos |

## Cómo usar en local

Dado que el proyecto carga archivos JS externos con `<script src="...">`, necesitas servir
el proyecto desde un servidor HTTP local (los navegadores bloquean `file://` para módulos):

```bash
# Opción 1 — Python (recomendado)
cd dashboard_impactos
python3 -m http.server 8000
# Abre http://localhost:8000

# Opción 2 — Node (si tienes npx)
npx serve .

# Opción 3 — VS Code
# Instala la extensión "Live Server" y haz clic en "Go Live"
```

## Formato de datos esperados

### Tab GPS — GeoJSON
Generado por `procesar_gps.py`. Cada Feature debe tener:
```json
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] },
  "properties": {
    "owner_id": 902,
    "account_id": "empresa_A",
    "dia": 3,
    "mes": 7,
    "hora_salida": 7.5,
    "hora_inicio": 7.5,
    "hora_fin": 9.25,
    "n_pings_original": 1200,

    "vias_recorridas": ["Ruta 68", "Undécimo", "Av. Argentina"],

    "vias_con_indices": [
      { "nombre": "Ruta 68",      "desde": 0,   "hasta": 34  },
      { "nombre": "Undécimo",     "desde": 35,  "hasta": 71  },
      { "nombre": "Av. Argentina","desde": 72,  "hasta": 109 }
    ],

    "stays": [{ "lat": -23.6, "lon": -70.4, "duration_minutes": 5.2, "start_time": "..." }]
  }
}
```

> **Nota sobre `vias_con_indices`:** los índices `desde` y `hasta` corresponden a la posición
> de cada coordenada en el array `geometry.coordinates` (base 0). Si un ping con índice `i`
> cumple `desde <= i <= hasta`, pertenece a esa vía. El dashboard usa este campo de forma
> preferente; si no existe, cae al fallback aproximado con `vias_recorridas` (marcado con `~`
> en la interfaz).
>
> **Para generarlo en `procesar_gps.py`**, al iterar los pings y detectar cambio de calle,
> registra el índice del primer ping de cada segmento:
>
> ```python
> vias_con_indices = []
> via_actual = None
> idx_inicio = 0
>
> for i, ping in enumerate(pings_filtrados):
>     via = obtener_via(ping)  # tu función de reverse geocoding / map matching
>     if via != via_actual:
>         if via_actual is not None:
>             vias_con_indices.append({
>                 "nombre": via_actual,
>                 "desde":  idx_inicio,
>                 "hasta":  i - 1
>             })
>         via_actual  = via
>         idx_inicio  = i
>
> # Cerrar el último segmento
> if via_actual is not None:
>     vias_con_indices.append({
>         "nombre": via_actual,
>         "desde":  idx_inicio,
>         "hasta":  len(pings_filtrados) - 1
>     })
> ```

### Tab GPS — CSV estadísticas (opcional)
```csv
owner_id,dia,mes,gse_ab_personas,gse_c1a_personas,...,edad_mayor_65_personas
902,3,7,12.5,8.3,...,4.1
```

### Tab Impactos H3 — CSV
```csv
h3_9,tipo,gse_ab_personas,gse_c1a_personas,...,edad_mayor_65_personas
8928b1234567fff,corriente,15.2,8.4,...,3.1
8928b1234567fff,alternativa,12.1,7.0,...,2.8
```
