# Changelog

All notable changes to `@vworlds/vecs-phaser-client` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `CoordSpace` for meter-to-pixel conversion with center-origin, +Y-up world coordinates at the Phaser boundary.
- Added `PhaserRenderModule` and local `VGameObject` components for mapping networked vecs entities to Phaser `GameObject`s, lifecycle cleanup, and reset rebuilds.
- Added per-shape renderers for arcs, rectangles, polygons, lines, text, ellipses, triangles, and stars, including shared transform and style sync.
- Added `phaserInterpolators` and `rotationInterpolator` for shortest-arc rotation interpolation.
