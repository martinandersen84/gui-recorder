# GUI Recorder

A Home Assistant sidebar panel to manage your `recorder` configuration and database maintenance from a UI — no `configuration.yaml` editing required.

## What it does

- Enable or disable recording per device and per entity with a toggle.
- Database statistics: total / current / obsolete records, matched exclusions, database size and location.
- Maintenance actions: purge the database, purge excluded entities (full history), repack, restart HA.
- Detects orphan exclusions (entries that no longer match any entity) and removes them in bulk.
- Guided migration from a legacy `recorder:` block in `configuration.yaml`.

## Requirements

- Home Assistant 2024.1.0+
- Recorder database on **SQLite**, **MariaDB/MySQL** or **PostgreSQL**.

## Setup

After installing, add the integration from **Settings → Devices & services → Add integration → GUI Recorder**. The panel appears in the sidebar.
