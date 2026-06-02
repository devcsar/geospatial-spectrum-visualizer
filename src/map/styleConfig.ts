// Builds a MapLibre StyleSpecification at runtime so we can toggle sources based on
// whether VITE_PROTOMAPS_KEY is present.

import type { StyleSpecification } from 'maplibre-gl';

const TERRAIN_TILES = ['https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.png'];

export interface StyleOptions {
  protomapsKey?: string | undefined;
  showLabels?: boolean;
}

export function buildDarkStyle(opts: StyleOptions = {}): StyleSpecification {
  const hasProtomaps = Boolean(opts.protomapsKey);

  const sources: StyleSpecification['sources'] = {
    'terrain-dem': {
      type: 'raster-dem',
      tiles: TERRAIN_TILES,
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 12,
      attribution:
        '<a href="https://github.com/maplibre/demotiles" target="_blank">MapLibre demotiles</a>'
    },
    'hillshade-dem': {
      type: 'raster-dem',
      tiles: TERRAIN_TILES,
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 12
    }
  };

  if (hasProtomaps) {
    sources['protomaps'] = {
      type: 'vector',
      url: `https://api.protomaps.com/tiles/v3.json?key=${encodeURIComponent(opts.protomapsKey!)}`,
      attribution:
        '<a href="https://protomaps.com" target="_blank">Protomaps</a> · <a href="https://openstreetmap.org" target="_blank">OSM</a>'
    };
  }

  const layers: StyleSpecification['layers'] = [
    {
      id: 'bg',
      type: 'background',
      paint: {
        'background-color': '#000000'
      }
    },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'hillshade-dem',
      paint: {
        'hillshade-exaggeration': 0.45,
        'hillshade-shadow-color': '#000000',
        'hillshade-highlight-color': '#1c1c1c',
        'hillshade-accent-color': '#0a0a0a',
        'hillshade-illumination-direction': 315,
        'hillshade-illumination-anchor': 'viewport'
      }
    }
  ];

  if (hasProtomaps) {
    // Water — near-black so it doesn't add tint to the base.
    layers.push({
      id: 'water',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'water',
      paint: {
        'fill-color': '#050505',
        'fill-opacity': 0.9
      }
    });
    // Coastline — neutral dim gray; the Three.js layers carry the audio color.
    layers.push({
      id: 'coastline',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'water',
      filter: ['==', '$type', 'LineString'],
      paint: {
        'line-color': '#2a2a2a',
        'line-width': 0.8,
        'line-opacity': 0.35
      }
    });
    // Roads base — very dim neutral underlay. The bright reactive lines come from StreetsLayer.
    layers.push({
      id: 'roads-base',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'roads',
      paint: {
        'line-color': '#1a1a1a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 16, 1.0],
        'line-opacity': 0.5
      }
    });

    if (opts.showLabels) {
      layers.push({
        id: 'place-labels',
        type: 'symbol',
        source: 'protomaps',
        'source-layer': 'places',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-letter-spacing': 0.12
        },
        paint: {
          'text-color': '#f7e9ff',
          'text-halo-color': '#000',
          'text-halo-width': 1.2
        }
      });
    }
  }

  return {
    version: 8,
    name: 'rohan-spectral-dark',
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources,
    layers,
    terrain: {
      source: 'terrain-dem',
      exaggeration: 2.5
    },
    sky: {
      'sky-color': '#000000',
      'horizon-color': '#000000',
      'fog-color': '#000000',
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.2
    }
  };
}
