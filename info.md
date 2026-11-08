# GUI Recorder

A Home Assistant sidebar panel to manage your `recorder` configuration and database maintenance (SQLite) from a UI — no `configuration.yaml` editing required.

## What it does

- Enable or disable recording per device and per entity with a toggle.
- Database statistics: total / current / obsolete records, matched exclusions, disk size, SQLite path.
- Maintenance actions: purge the database, purge excluded entities (full history), repack, restart HA.
- Throttle noisy sensors: create a Filter `time_throttle` helper and stop recording the raw sensor in one click.
- Detects orphan exclusions (entries that no longer match any entity) and removes them in bulk.
- Guided migration from a legacy `recorder:` block in `configuration.yaml`.

## Requirements

- Home Assistant 2024.1.0+
- Recorder database on **SQLite** (MariaDB and PostgreSQL are not supported).

## Setup

After installing, add the integration from **Settings → Devices & services → Add integration → GUI Recorder**. The panel appears in the sidebar.
