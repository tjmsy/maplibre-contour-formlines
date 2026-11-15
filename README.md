# maplibre-contour-formlines

Generate contour lines and Karttapullautin-inspired form lines from raster DEM tiles in [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js). This project builds on [onthegomap/maplibre-contour](https://github.com/onthegomap/maplibre-contour).

## Demo

Try the [live demo on GitHub Pages](https://tjmsy.github.io/maplibre-contour-formlines/). It shows contours and form lines together, and lets you toggle terrain shading and export the visible contour, index-contour, and form-line features as GeoJSON. It uses OpenFreeMap for the basemap and Mapterhorn Terrarium tiles for elevation data.

## Use form lines

Build the library with `npm run build`. The browser bundle is generated at `dist/index.min.js`; load it after MapLibre GL JS. The bundle exposes `mlcontour`.

Create a `DemSource` for your raster DEM tiles and register its protocol with MapLibre:

```js
const demSource = new mlcontour.DemSource({
  url: "https://example.com/dem/{z}/{x}/{y}.png",
  encoding: "terrarium", // or "mapbox" or "gsi"
  maxzoom: 13,
});
demSource.setupMaplibre(maplibregl);
```

Add a vector source. Form lines are enabled by default and are returned in a separate `formlines` source layer:

```js
map.addSource("contours", {
  type: "vector",
  tiles: [
    demSource.contourProtocolUrl({
      thresholds: {
        // zoom: [minor contour interval, index contour interval]
        11: [100, 500],
        12: [50, 200],
        13: [10, 50],
        14: [5, 25],
      },
      formlines: true,
      formlineSteepness: 0.16,
      formlineAddition: 17,
      formlineMinimumGap: 30,
    }),
  ],
  maxzoom: 15,
});
```

The form-line options are optional. Their defaults are `formlineSteepness: 0.16`, `formlineAddition: 17`, and `formlineMinimumGap: 30`. Set `formlines: false` to disable form-line generation.

Render the `formlines` source layer independently from the ordinary `contours` layer. For example:

```js
map.addLayer({
  id: "form-lines",
  type: "line",
  source: "contours",
  "source-layer": "formlines",
  layout: {
    "line-cap": "butt",
  },
  paint: {
    "line-color": "#BE7A54",
    "line-width": 0.7,
    "line-dasharray": [10, 2],
  },
});
```

See [`index.html`](./index.html) for a complete working example, including contour styling and MapLibre setup.

`encoding: "gsi"` decodes signed 24-bit numerical PNG elevation tiles with a 0.01 m scale. Transparent pixels and the `(128, 0, 0)` no-data value become `NaN` for contour generation. The shared DEM protocol returns the original tile bytes unchanged; MapLibre's `raster-dem` source cannot decode this encoding directly, so use it for contours only unless the tile service provides Terrarium or Mapbox encoded tiles.

## Credits and license

This project is based on [onthegomap/maplibre-contour](https://github.com/onthegomap/maplibre-contour). Its original copyright and license notices are retained in [LICENSE](LICENSE).

Form-line terrain classification is adapted from terrain metrics in [Karttapullautin](https://github.com/karttapullautin/karttapullautin)'s `src/render.rs`. This implementation samples raster DEM data in physical space; it does not reproduce Karttapullautin's point-cloud processing or guarantee identical output.

This project is distributed under the [GNU General Public License v3.0](LICENSE). Copyright and license notices for the upstream maplibre-contour project and third-party code are retained in [LICENSE](LICENSE), including [d3-contour](https://github.com/d3/d3-contour) (ISC) and [vt-pbf](https://github.com/mapbox/vt-pbf) (MIT).
