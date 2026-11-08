from __future__ import annotations

import asyncio
import fnmatch
import logging
import re

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN, INTEGRATION_VERSION
from .db_stats import async_analyze_db
from .migration import async_detect_sync_status, async_disable_legacy, async_ensure_gui_enabled, async_import_legacy
from .storage import async_reload_data, async_save_data
from .throttle import (
    DEFAULT_PRECISION,
    MAX_WINDOW_SECONDS,
    MIN_WINDOW_SECONDS,
    async_build_filter_links,
    async_create_throttled_sensor,
    async_filter_flow_supported,
    is_numeric_state,
    yaml_snippet,
)
from .yaml_writer import async_write_yaml, parse_manual_exclusions

_LOGGER = logging.getLogger(__name__)
_BLOCK_API_WARNED = False


def _normalize_entity_id(value: str) -> str:
    return str(value).strip()


async def _wait_recorder_idle(hass: HomeAssistant) -> None:
    """Wait until the recorder has finished processing queued tasks (e.g. purges).

    The recorder.purge service returns as soon as the task is enqueued, not when
    the actual DELETE has been committed. We wait for the recorder queue to drain,
    plus a small safety delay so the SQLite WAL checkpoint catches up before any
    read-only analysis runs.
    """
    global _BLOCK_API_WARNED
    try:
        from homeassistant.components.recorder import get_instance
        instance = get_instance(hass)
        block_fn = getattr(instance, "async_block_till_done", None)
        if block_fn is not None:
            await block_fn()
        elif not _BLOCK_API_WARNED:
            _LOGGER.warning(
                "Recorder.async_block_till_done() not available on this HA version; "
                "auto-update after purge may show stale data until the next manual refresh."
            )
            _BLOCK_API_WARNED = True
    except Exception as err:  # noqa: BLE001
        if not _BLOCK_API_WARNED:
            _LOGGER.warning("Could not wait for recorder to be idle: %s", err)
            _BLOCK_API_WARNED = True
    # Small safety margin for SQLite WAL checkpoint visibility on a fresh read-only connection.
    await asyncio.sleep(0.3)


def _normalize_excluded(values) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        entity_id = _normalize_entity_id(value)
        if not entity_id or entity_id in seen:
            continue
        seen.add(entity_id)
        normalized.append(entity_id)
    return sorted(normalized)


def _manual_exclude_filters(data: dict) -> tuple[set[str], re.Pattern[str] | None]:
    """Domains and globs from the manual field that hide entities from the recorder.

    The glob pattern is built exactly the way homeassistant.helpers.entityfilter
    builds it (fnmatch.translate joined with "|", matched with .match), so what we
    consider hidden is what the recorder actually skips.
    """
    try:
        manual = parse_manual_exclusions(data.get("manual_exclusions_yaml", ""))
    except ValueError:
        return set(), None

    exclude = manual.get("exclude", {})
    domains = set(exclude.get("domains") or [])
    globs = exclude.get("entity_globs") or []
    pattern = re.compile("(?:" + "|".join(fnmatch.translate(glob) for glob in set(globs)) + ")") if globs else None
    return domains, pattern


def _is_glob_hidden(entity_id: str, domains: set[str], pattern: re.Pattern[str] | None) -> bool:
    """True if one of the user's own manual exclude domains/globs matches this entity."""
    if entity_id.split(".", 1)[0] in domains:
        return True
    return bool(pattern and pattern.match(entity_id))


def _entity_recorded(entity_id: str, excluded: set[str], rescued: set[str], hidden: bool) -> bool:
    """Whether the recorder will actually record this entity.

    A hidden entity is only recorded when it is on the rescue list: with exclude
    domains/globs present, include.entities is the only rule that outranks them
    (entityfilter case 4b), and it also outranks exclude.entities.
    """
    if hidden:
        return entity_id in rescued
    return entity_id not in excluded


def _apply_toggle(data: dict, entity_ids: set[str], recorded: bool, rescue: bool = False) -> bool:
    """Move entity_ids to the wanted state across both lists. True if anything changed.

    rescue=True only for the single-entity toggle. Bulk actions (Select all, a whole
    device) leave entities hidden by the user's own globs alone: rescuing in bulk
    would silently write one include.entities entry per hidden entity and override
    the user's globs wholesale. Rescuing stays an explicit, per-entity decision.
    """
    excluded = set(_normalize_excluded(data.get("excluded_entities", [])))
    rescued = set(_normalize_excluded(data.get("rescued_entities", [])))
    before = (set(excluded), set(rescued))
    domains, pattern = _manual_exclude_filters(data)

    for entity_id in entity_ids:
        if recorded:
            excluded.discard(entity_id)
            # Removing it from exclude.entities is not enough when one of the user's
            # own globs hides it - that needs include.entities, which is what the
            # rescue list becomes.
            if rescue and _is_glob_hidden(entity_id, domains, pattern):
                rescued.add(entity_id)
        else:
            rescued.discard(entity_id)
            excluded.add(entity_id)

    if (excluded, rescued) == before:
        return False

    data["excluded_entities"] = _normalize_excluded(excluded)
    data["rescued_entities"] = _normalize_excluded(rescued)
    return True

async def _save_and_reload(hass: HomeAssistant, data: dict) -> dict:
    await async_save_data(hass, data)
    await async_write_yaml(hass)
    reloaded = await async_reload_data(hass)
    return reloaded


async def _set_entity_recorded_state(hass: HomeAssistant, entity_id: str, recorded: bool) -> tuple[dict, bool]:
    data = await async_reload_data(hass)
    entity_id = _normalize_entity_id(entity_id)

    changed = _apply_toggle(data, {entity_id}, recorded, rescue=True)
    if not changed:
        return data, False

    data["pending_restart"] = True
    reloaded = await _save_and_reload(hass, data)
    return reloaded, True


def _build_stats_payload(hass: HomeAssistant) -> dict:
    data = hass.data[DOMAIN]["data"]
    stats = data.get("stats", {})
    entity_counts = stats.get("entity_counts", {}) or {}
    total_rows = stats.get("total_rows")
    if total_rows is None:
        total_rows = sum(entity_counts.values())
    return {
        "entity_counts": entity_counts,
        "generated_at": stats.get("generated_at"),
        "db_path": stats.get("db_path", "home-assistant_v2.db"),
        "total_rows": total_rows,
        "db_size_bytes": int(stats.get("db_size_bytes", 0) or 0),
        "error": stats.get("error"),
    }


@callback
def _build_rows(hass: HomeAssistant) -> dict:
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    data = hass.data[DOMAIN]["data"]
    excluded = set(data.get("excluded_entities", []))
    rescued = set(data.get("rescued_entities", []))
    manual_domains, manual_pattern = _manual_exclude_filters(data)

    def _row_flags(entity_id: str) -> tuple[bool, bool]:
        hidden = _is_glob_hidden(entity_id, manual_domains, manual_pattern)
        return _entity_recorded(entity_id, excluded, rescued, hidden), hidden

    stats_payload = _build_stats_payload(hass)
    entity_counts = stats_payload.get("entity_counts", {})
    filters_by_source, filters_by_filtered = async_build_filter_links(hass)

    def _add_filter_links(row: dict) -> dict:
        row["filters"] = filters_by_source.get(row["entity_id"], [])
        link = filters_by_filtered.get(row["entity_id"])
        row["filter_of"] = link["source_entity_id"] if link else None
        return row

    devices: dict[str, dict] = {}
    orphan_entities: list[dict] = []
    obsolete_entities: list[dict] = []
    current_entity_ids: set[str] = set()

    def row_sort_key(entity: dict) -> tuple:
        return (-int(entity.get("record_count", 0)), entity["entity_id"])

    for entity_entry in entity_registry.entities.values():
        current_entity_ids.add(entity_entry.entity_id)
        row_recorded, row_hidden = _row_flags(entity_entry.entity_id)
        row = {
            "entity_id": entity_entry.entity_id,
            "name": entity_entry.original_name or entity_entry.name or entity_entry.entity_id,
            "disabled_by": str(entity_entry.disabled_by) if entity_entry.disabled_by else None,
            "hidden_by": str(entity_entry.hidden_by) if entity_entry.hidden_by else None,
            "platform": entity_entry.platform,
            "domain": entity_entry.domain,
            "device_id": entity_entry.device_id,
            "recorded": row_recorded,
            "glob_hidden": row_hidden,
            "record_count": int(entity_counts.get(entity_entry.entity_id, 0)),
        }
        _add_filter_links(row)

        if entity_entry.device_id:
            device = device_registry.async_get(entity_entry.device_id)
            if device:
                dev = devices.setdefault(
                    device.id,
                    {
                        "device_id": device.id,
                        "name": device.name_by_user or device.name or "Unnamed device",
                        "manufacturer": device.manufacturer,
                        "model": device.model,
                        "entities": [],
                        "record_count": 0,
                    },
                )
                dev["entities"].append(row)
                dev["record_count"] += row["record_count"]
                continue

        orphan_entities.append(row)

    live_entity_ids = set(hass.states.async_entity_ids())

    for entity_id, count in entity_counts.items():
        if entity_id in current_entity_ids:
            continue
        domain = entity_id.split(".", 1)[0] if "." in entity_id else "unknown"
        if entity_id in live_entity_ids:
            # Has a live state but no entity_registry entry (e.g. legacy YAML
            # platforms like snmp/template/command_line without unique_id).
            # It's not obsolete, just unregistered - list it as an orphan.
            state_obj = hass.states.get(entity_id)
            friendly_name = state_obj.attributes.get("friendly_name") if state_obj else None
            current_entity_ids.add(entity_id)
            orphan_entities.append(
                _add_filter_links({
                    "entity_id": entity_id,
                    "name": friendly_name or entity_id,
                    "disabled_by": None,
                    "hidden_by": None,
                    "platform": domain,
                    "domain": domain,
                    "device_id": None,
                    "recorded": _row_flags(entity_id)[0],
                    "glob_hidden": _row_flags(entity_id)[1],
                    "record_count": int(count),
                })
            )
            continue
        obsolete_entities.append(
            {
                "entity_id": entity_id,
                "name": entity_id,
                "platform": domain,
                "domain": domain,
                "device_id": None,
                "recorded": _row_flags(entity_id)[0],
                "glob_hidden": _row_flags(entity_id)[1],
                "record_count": int(count),
                "obsolete": True,
            }
        )

    device_rows = sorted(devices.values(), key=lambda d: (-int(d.get("record_count", 0)), d["name"].lower()))
    for dev in device_rows:
        dev["entities"] = sorted(dev["entities"], key=row_sort_key)

    orphan_entities = sorted(orphan_entities, key=row_sort_key)
    obsolete_entities = sorted(obsolete_entities, key=row_sort_key)

    # An entity that exists right now but has no rows in the database (because it
    # is excluded and its history was already purged) is still a valid exclusion.
    # Registry-less entities (sun.sun, YAML platforms without unique_id) only reach
    # current_entity_ids through the entity_counts loop above, so they would drop
    # out of it as soon as their records are gone and be reported as unmatched.
    known_entity_ids = current_entity_ids | live_entity_ids

    matched_exclusions = sorted(entity_id for entity_id in excluded if entity_id in known_entity_ids)
    unmatched_exclusions = sorted(entity_id for entity_id in excluded if entity_id not in known_entity_ids)

    current_rows = sum(int(entity_counts.get(entity_id, 0)) for entity_id in current_entity_ids)
    obsolete_rows = sum(int(item["record_count"]) for item in obsolete_entities)
    stats_payload["current_rows"] = current_rows
    stats_payload["obsolete_rows"] = obsolete_rows
    stats_payload["obsolete_entity_count"] = len(obsolete_entities)
    stats_payload["configured_exclusions"] = len(excluded)
    stats_payload["matched_exclusions"] = len(matched_exclusions)
    stats_payload["unmatched_exclusions"] = len(unmatched_exclusions)

    return {
        "devices": device_rows,
        "orphans": orphan_entities,
        "obsolete": obsolete_entities,
        "rescued_entities": sorted(rescued),
        "pending_restart": bool(data.get("pending_restart", False)),
        "purge_keep_days": int(data.get("purge_keep_days", 10)),
        "auto_purge": bool(data.get("auto_purge", True)),
        "auto_repack": bool(data.get("auto_repack", True)),
        "commit_interval": int(data.get("commit_interval", 5)),
        "auto_update_data": bool(data.get("auto_update_data", True)),
        "repack_after_manual_purge": bool(data.get("repack_after_manual_purge", False)),
        "repack_in_progress": bool(data.get("repack_in_progress", False)),
        "stats": stats_payload,
        "migration": hass.data[DOMAIN].get("migration", {}),
        "matched_exclusions": matched_exclusions,
        "unmatched_exclusions": unmatched_exclusions,
        "manual_exclusions_yaml": data.get("manual_exclusions_yaml", ""),
        "filter_flow_supported": bool(hass.data[DOMAIN].get("filter_flow_supported", False)),
        "version": INTEGRATION_VERSION,
    }


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/get_tree"})
@callback
def ws_get_tree(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    connection.send_result(msg["id"], _build_rows(hass))


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_entity",
        vol.Required("entity_id"): str,
        vol.Required("recorded"): bool,
    }
)
async def ws_set_entity(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    _, changed = await _set_entity_recorded_state(hass, msg["entity_id"], msg["recorded"])
    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "changed": changed,
            "restart_required": changed,
            "removed": changed if msg["recorded"] else False,
        },
    )


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_device",
        vol.Required("device_id"): str,
        vol.Required("recorded"): bool,
    }
)
async def ws_set_device(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    entity_registry = er.async_get(hass)
    data = await async_reload_data(hass)
    device_entity_ids = {
        entry.entity_id
        for entry in entity_registry.entities.values()
        if entry.device_id == msg["device_id"]
    }

    changed = _apply_toggle(data, device_entity_ids, msg["recorded"])
    generated_file = None
    if changed:
        data["pending_restart"] = True
        await async_save_data(hass, data)
        generated_file = await async_write_yaml(hass)

    connection.send_result(msg["id"], {"ok": True, "generated_file": generated_file, "restart_required": changed, "changed": changed})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_entities_bulk",
        vol.Required("entity_ids"): [str],
        vol.Required("recorded"): bool,
    }
)
async def ws_set_entities_bulk(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = await async_reload_data(hass)
    entity_ids = {_normalize_entity_id(entity_id) for entity_id in msg["entity_ids"]}

    changed = _apply_toggle(data, entity_ids, msg["recorded"])
    generated_file = None
    if changed:
        data["pending_restart"] = True
        await async_save_data(hass, data)
        generated_file = await async_write_yaml(hass)

    connection.send_result(
        msg["id"],
        {"ok": True, "generated_file": generated_file, "restart_required": changed, "changed": changed, "count": len(entity_ids)},
    )


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_manual_exclusions",
        vol.Required("yaml_text"): str,
    }
)
async def ws_set_manual_exclusions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    yaml_text = msg["yaml_text"]
    try:
        parse_manual_exclusions(yaml_text)
    except ValueError as err:
        connection.send_result(msg["id"], {"ok": False, "error": str(err)})
        return

    data = await async_reload_data(hass)
    changed = data.get("manual_exclusions_yaml", "") != yaml_text
    generated_file = None
    if changed:
        data["manual_exclusions_yaml"] = yaml_text
        data["pending_restart"] = True
        await async_save_data(hass, data)
        generated_file = await async_write_yaml(hass)

    connection.send_result(
        msg["id"],
        {"ok": True, "generated_file": generated_file, "restart_required": changed, "changed": changed},
    )


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/remove_exclusion",
        vol.Required("entity_id"): str,
    }
)
async def ws_remove_exclusion(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    _, changed = await _set_entity_recorded_state(hass, msg["entity_id"], True)
    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "removed": changed,
            "restart_required": changed,
        },
    )


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/remove_unmatched_exclusions"})
async def ws_remove_unmatched_exclusions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    entity_registry = er.async_get(hass)
    # Same rule as _build_rows: an entity with a live state but no registry entry
    # still exists, so its exclusion is not unmatched and must not be removed here.
    known_entity_ids = {entry.entity_id for entry in entity_registry.entities.values()}
    known_entity_ids |= set(hass.states.async_entity_ids())
    data = await async_reload_data(hass)
    excluded = _normalize_excluded(data.get("excluded_entities", []))
    removed = sorted(entity_id for entity_id in excluded if entity_id not in known_entity_ids)

    if removed:
        remaining = [eid for eid in excluded if eid not in set(removed)]
        data["excluded_entities"] = _normalize_excluded(remaining)
        data["pending_restart"] = True
        await _save_and_reload(hass, data)

    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "removed": removed,
            "restart_required": bool(removed),
        },
    )

@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_global_options",
        vol.Required("purge_keep_days"): vol.All(vol.Coerce(int), vol.Range(min=1, max=3650)),
        vol.Required("auto_purge"): bool,
        vol.Required("auto_repack"): bool,
        vol.Required("commit_interval"): vol.All(vol.Coerce(int), vol.Range(min=0, max=86400)),
    }
)
async def ws_set_global_options(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = await async_reload_data(hass)
    data["purge_keep_days"] = int(msg["purge_keep_days"])
    data["auto_purge"] = bool(msg["auto_purge"])
    data["auto_repack"] = bool(msg["auto_repack"]) if bool(msg["auto_purge"]) else False
    data["commit_interval"] = int(msg["commit_interval"])
    data["pending_restart"] = True
    await async_save_data(hass, data)
    generated_file = await async_write_yaml(hass)
    await async_reload_data(hass)

    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "generated_file": generated_file,
            "restart_required": True,
            "global_options": {
                "purge_keep_days": data["purge_keep_days"],
                "auto_purge": data["auto_purge"],
                "auto_repack": data["auto_repack"],
                "commit_interval": data["commit_interval"],
            },
        },
    )


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_auto_update_data",
        vol.Required("auto_update_data"): bool,
    }
)
async def ws_set_auto_update_data(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]["data"]
    data["auto_update_data"] = bool(msg["auto_update_data"])
    await async_save_data(hass, data)
    connection.send_result(msg["id"], {"ok": True, "auto_update_data": data["auto_update_data"]})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/set_repack_after_manual_purge",
        vol.Required("repack_after_manual_purge"): bool,
    }
)
async def ws_set_repack_after_manual_purge(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]["data"]
    data["repack_after_manual_purge"] = bool(msg["repack_after_manual_purge"])
    await async_save_data(hass, data)
    connection.send_result(msg["id"], {"ok": True, "repack_after_manual_purge": data["repack_after_manual_purge"]})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/regenerate_yaml"})
async def ws_regenerate_yaml(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    generated_file = await async_write_yaml(hass)
    connection.send_result(msg["id"], {"ok": True, "generated_file": generated_file})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/analyze_db"})
async def ws_analyze_db(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    stats = await async_analyze_db(hass)
    connection.send_result(msg["id"], {"ok": True, "stats": stats})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/purge_all"})
async def ws_purge_all(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]["data"]
    keep_days = int(data.get("purge_keep_days", 10))
    repack = bool(data.get("repack_after_manual_purge", False))
    data["repack_in_progress"] = bool(repack)
    if repack:
        await async_save_data(hass, data)
    try:
        await hass.services.async_call("recorder", "purge", {"keep_days": keep_days, "repack": repack}, blocking=True)
        await _wait_recorder_idle(hass)
    finally:
        if data.get("repack_in_progress"):
            data["repack_in_progress"] = False
            await async_save_data(hass, data)
    connection.send_result(msg["id"], {"ok": True, "refresh_required": True, "keep_days": keep_days, "repacked": repack})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/purge_excluded_entities"})
async def ws_purge_excluded_entities(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]["data"]
    entity_ids = sorted(set(data.get("excluded_entities", [])))
    repack = bool(data.get("repack_after_manual_purge", False)) and bool(entity_ids)
    data["repack_in_progress"] = bool(repack)
    if repack:
        await async_save_data(hass, data)
    try:
        if entity_ids:
            await hass.services.async_call(
                "recorder",
                "purge_entities",
                {"entity_id": entity_ids, "keep_days": 0},
                blocking=True,
            )
            await _wait_recorder_idle(hass)
        if repack:
            # purge_entities doesn't support repack; run a no-op purge with very high
            # keep_days just to trigger the VACUUM.
            await hass.services.async_call("recorder", "purge", {"keep_days": 36500, "repack": True}, blocking=True)
            await _wait_recorder_idle(hass)
    finally:
        if data.get("repack_in_progress"):
            data["repack_in_progress"] = False
            await async_save_data(hass, data)
    connection.send_result(msg["id"], {"ok": True, "refresh_required": True, "purged_entities": len(entity_ids), "repacked": repack})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/purge_entity", vol.Required("entity_id"): str})
async def ws_purge_entity(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await hass.services.async_call(
        "recorder",
        "purge_entities",
        {"entity_id": [msg["entity_id"]], "keep_days": 0},
        blocking=True,
    )
    await _wait_recorder_idle(hass)
    stats = await async_analyze_db(hass)
    connection.send_result(msg["id"], {"ok": True, "refresh_required": True, "stats": stats})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/purge_device", vol.Required("device_id"): str})
async def ws_purge_device(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    entity_registry = er.async_get(hass)
    entity_ids = sorted({entry.entity_id for entry in entity_registry.entities.values() if entry.device_id == msg["device_id"]})
    if entity_ids:
        await hass.services.async_call(
            "recorder",
            "purge_entities",
            {"entity_id": entity_ids, "keep_days": 0},
            blocking=True,
        )
        await _wait_recorder_idle(hass)
    stats = await async_analyze_db(hass)
    connection.send_result(msg["id"], {"ok": True, "refresh_required": True, "purged_entities": len(entity_ids), "stats": stats})




@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/restart_homeassistant"})
async def ws_restart_homeassistant(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await hass.services.async_call("homeassistant", "restart", {}, blocking=False)
    connection.send_result(msg["id"], {"ok": True, "restart_requested": True})


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/get_migration_status"})
async def ws_get_migration_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    status = await async_detect_sync_status(hass)
    hass.data[DOMAIN]["migration"] = status
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/import_legacy"})
async def ws_import_legacy(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    result = await async_import_legacy(hass)
    if result.get("ok"):
        data = hass.data[DOMAIN]["data"]
        await async_save_data(hass, data)
        await async_write_yaml(hass)
        hass.data[DOMAIN]["migration"] = await async_detect_sync_status(hass)
    connection.send_result(msg["id"], result)


_IMPORT_REQUIRED_ERROR = (
    "Import the detected configuration first (Step 1). Disabling the legacy recorder "
    "block without importing would replace your settings - including a custom db_url - "
    "with defaults, and Home Assistant would start a new empty database."
)


async def _async_import_pending(hass: HomeAssistant) -> bool:
    """True if a legacy recorder config exists but hasn't been imported yet.

    Running steps 2/3 in that state silently replaces the user's recorder config
    with GUI Recorder's defaults, so both are blocked until Step 1 has run.
    """
    status = await async_detect_sync_status(hass)
    return bool(status.get("legacy_detected")) and not status.get("legacy_imported_at")


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/disable_legacy"})
async def ws_disable_legacy(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if await _async_import_pending(hass):
        connection.send_result(msg["id"], {"ok": False, "error": _IMPORT_REQUIRED_ERROR})
        return
    result = await async_disable_legacy(hass)
    if result.get("ok"):
        data = await async_reload_data(hass)
        data["pending_restart"] = True
        await async_save_data(hass, data)
    hass.data[DOMAIN]["migration"] = await async_detect_sync_status(hass)
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command({vol.Required("type"): "gui_recorder/enable_gui"})
async def ws_enable_gui(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if await _async_import_pending(hass):
        connection.send_result(msg["id"], {"ok": False, "error": _IMPORT_REQUIRED_ERROR})
        return
    result = await async_ensure_gui_enabled(hass)
    if result.get("ok"):
        await async_write_yaml(hass)
        data = await async_reload_data(hass)
        data["pending_restart"] = True
        await async_save_data(hass, data)
    hass.data[DOMAIN]["migration"] = await async_detect_sync_status(hass)
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.async_response
@websocket_api.websocket_command(
    {
        vol.Required("type"): "gui_recorder/create_throttled_sensor",
        vol.Required("entity_id"): str,
        vol.Required("window_seconds"): vol.All(vol.Coerce(int), vol.Range(min=MIN_WINDOW_SECONDS, max=MAX_WINDOW_SECONDS)),
        vol.Optional("name"): str,
        vol.Optional("precision", default=DEFAULT_PRECISION): vol.All(vol.Coerce(int), vol.Range(min=0, max=10)),
        vol.Optional("exclude_source", default=True): bool,
    }
)
async def ws_create_throttled_sensor(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Issue #23: create a Filter/time_throttle helper and (optionally) stop recording the source."""
    source = _normalize_entity_id(msg["entity_id"])
    if not source.startswith("sensor."):
        connection.send_result(msg["id"], {"ok": False, "error": "Only sensor entities can be throttled."})
        return
    state = hass.states.get(source)
    if state is None:
        connection.send_result(msg["id"], {"ok": False, "error": f"{source} has no current state in Home Assistant."})
        return
    if is_numeric_state(hass, source) is False:
        connection.send_result(
            msg["id"],
            {"ok": False, "error": f"{source} does not report a numeric value; the Filter integration only works with numeric sensors."},
        )
        return

    name = (msg.get("name") or "").strip() or f"{state.attributes.get('friendly_name') or source} throttled"

    if not await async_filter_flow_supported(hass):
        # Older HA: the Filter integration is YAML-only. Hand back the snippet instead.
        connection.send_result(
            msg["id"],
            {"ok": False, "unsupported": True, "yaml": yaml_snippet(source, name, msg["window_seconds"]),
             "error": "This Home Assistant version cannot create Filter helpers from the UI. Add the YAML below to configuration.yaml instead."},
        )
        return

    created = await async_create_throttled_sensor(hass, source, name, msg["window_seconds"], msg["precision"])
    if not created.get("ok"):
        connection.send_result(msg["id"], created)
        return

    data = await async_reload_data(hass)
    excluded_source = False
    if msg["exclude_source"]:
        if _apply_toggle(data, {source}, False):
            data["pending_restart"] = True
            data = await _save_and_reload(hass, data)
        excluded_source = source in set(data.get("excluded_entities", []))

    # The new helper must itself be recorded - warn if one of the user's own
    # exclude globs/domains (e.g. "sensor.*power*") would hide it.
    filtered_id = created.get("entity_id")
    domains, pattern = _manual_exclude_filters(data)
    filtered_hidden = bool(filtered_id) and _is_glob_hidden(filtered_id, domains, pattern)

    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "entry_id": created.get("entry_id"),
            "entity_id": filtered_id,
            "name": name,
            "excluded_source": excluded_source,
            "filtered_glob_hidden": filtered_hidden,
            "restart_required": excluded_source,
        },
    )


async def async_setup_websocket_api(hass: HomeAssistant) -> None:
    hass.data.setdefault(DOMAIN, {})["filter_flow_supported"] = await async_filter_flow_supported(hass)
    websocket_api.async_register_command(hass, ws_get_tree)
    websocket_api.async_register_command(hass, ws_set_entity)
    websocket_api.async_register_command(hass, ws_set_device)
    websocket_api.async_register_command(hass, ws_set_entities_bulk)
    websocket_api.async_register_command(hass, ws_set_manual_exclusions)
    websocket_api.async_register_command(hass, ws_remove_exclusion)
    websocket_api.async_register_command(hass, ws_remove_unmatched_exclusions)
    websocket_api.async_register_command(hass, ws_set_global_options)
    websocket_api.async_register_command(hass, ws_set_auto_update_data)
    websocket_api.async_register_command(hass, ws_set_repack_after_manual_purge)
    websocket_api.async_register_command(hass, ws_regenerate_yaml)
    websocket_api.async_register_command(hass, ws_analyze_db)
    websocket_api.async_register_command(hass, ws_purge_all)
    websocket_api.async_register_command(hass, ws_purge_excluded_entities)
    websocket_api.async_register_command(hass, ws_purge_entity)
    websocket_api.async_register_command(hass, ws_purge_device)
    websocket_api.async_register_command(hass, ws_restart_homeassistant)
    websocket_api.async_register_command(hass, ws_get_migration_status)
    websocket_api.async_register_command(hass, ws_import_legacy)
    websocket_api.async_register_command(hass, ws_disable_legacy)
    websocket_api.async_register_command(hass, ws_enable_gui)
    websocket_api.async_register_command(hass, ws_create_throttled_sensor)
