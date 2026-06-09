# Changelog

All notable changes to `@vworlds/vecs-phaser` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added wire-serializable Phaser render components for transforms, styling, shapes, and text: `Position`, `Rotation`, `Scale`, `Alpha`, `Depth`, `FillStyle`, `StrokeStyle`, `Arc`, `Ellipse`, `Rectangle`, `Polygon`, `Line`, `Triangle`, `Star`, `Text`, and `TextAlign`.
- Added `phaserNetworkComponents` and `phaserRenderableComponents` protocol arrays to keep render component serialization and renderable exclusivity order stable.
