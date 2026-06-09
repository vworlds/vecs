# Changelog

All notable changes to `@vworlds/vecs-phaser-server` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `registerRenderExclusivity` to enforce one active Phaser renderable component per entity.
- Added shape builder helpers for creating networked render entities with transform and style components.
- Added `syncPhysicsPose` for copying vecs-physics `Position` and `Rotation` into Phaser render pose components.
