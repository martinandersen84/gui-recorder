"""Throttled companion sensors (issue #23).

A noisy sensor (power meter, fast system sensor, ...) can be replaced in the
recorder by a Filter helper using ``time_throttle``: the helper only updates
once per window, so it is what gets recorded while the raw sensor is excluded.

The helper is created through Home Assistant's own Filter config flow, exactly as
if the user had added it from Settings -> Devices & services -> Helpers. GUI
Recorder therefore writes no YAML for it and keeps no state of its own about it:
the links between a source sensor and its filters are always read back from the
Filter config entries, so helpers created, edited or deleted from the HA UI are
reflected automatically.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er
from homeassistant.loader import async_get_integration

_LOGGER = logging.getLogger(__name__)

FILTER_DOMAIN = "filter"
FILTER_TIME_THROTTLE = "time_throttle"
DEFAULT_PRECISION = 2
MIN_WINDOW_SECONDS = 1
MAX_WINDOW_SECONDS = 24 * 3600 - 1  # the Filter flow's duration selector has no "days"

_NON_NUMERIC_STATES = {"unknown", "unavailable", "", None}


async def async_filter_flow_supported(hass: HomeAssistant) -> bool:
    """True if this HA version can create Filter helpers from the UI."""
    try:
        integration = await async_get_integration(hass, FILTER_DOMAIN)
    except Exception:  # noqa: BLE001 - IntegrationNotFound or loader errors
        return False
    return bool(getattr(integration, "config_flow", False))


def window_to_duration(seconds: int) -> dict[str, int]:
    seconds = int(seconds)
    return {"hours": seconds // 3600, "minutes": (seconds % 3600) // 60, "seconds": seconds % 60}


def duration_to_seconds(value: Any) -> int | None:
    if isinstance(value, dict):
        return (
            int(value.get("days", 0) or 0) * 86400
            + int(value.get("hours", 0) or 0) * 3600
            + int(value.get("minutes", 0) or 0) * 60
            + int(float(value.get("seconds", 0) or 0))
        )
    if isinstance(value, (int, float)):
        return int(value)
    return None


def yaml_snippet(source_entity_id: str, name: str, window_seconds: int) -> str:
    """Manual fallback for HA versions whose Filter integration has no config flow."""
    d = window_to_duration(window_seconds)
    window = f"{d['hours']:02d}:{d['minutes']:02d}:{d['seconds']:02d}"
    safe_name = name.replace('"', "'")
    return (
        "sensor:\n"
        "  - platform: filter\n"
        f'    name: "{safe_name}"\n'
        f"    entity_id: {source_entity_id}\n"
        "    filters:\n"
        "      - filter: time_throttle\n"
        f'        window_size: "{window}"\n'
    )


def is_numeric_state(hass: HomeAssistant, entity_id: str) -> bool | None:
    """True/False if the current state is (not) numeric, None if it cannot be told yet."""
    state = hass.states.get(entity_id)
    if state is None or state.state in _NON_NUMERIC_STATES:
        return None
    try:
        float(state.state)
    except (TypeError, ValueError):
        return False
    return True


@callback
def async_build_filter_links(hass: HomeAssistant) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    """Read every Filter helper and map it to its source sensor.

    Returns (by_source, by_filtered):
      by_source[source_entity_id]   -> list of filters built on that sensor
      by_filtered[filter_entity_id] -> the filter itself (incl. its source)
    """
    entity_registry = er.async_get(hass)
    by_source: dict[str, list[dict]] = {}
    by_filtered: dict[str, dict] = {}

    for entry in hass.config_entries.async_entries(FILTER_DOMAIN):
        options = entry.options or {}
        source = options.get("entity_id")
        if not isinstance(source, str) or not source:
            continue
        filtered_ids = [e.entity_id for e in er.async_entries_for_config_entry(entity_registry, entry.entry_id)]
        link = {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "filter": options.get("filter"),
            "window_seconds": duration_to_seconds(options.get("window_size")),
            "source_entity_id": source,
            "entity_id": filtered_ids[0] if filtered_ids else None,
            "disabled": entry.disabled_by is not None,
        }
        by_source.setdefault(source, []).append(link)
        for filtered_id in filtered_ids:
            by_filtered[filtered_id] = link

    return by_source, by_filtered


async def _async_wait_for_entity(hass: HomeAssistant, entry_id: str, timeout: float = 5.0) -> str | None:
    """The entity is registered when the new entry finishes setting up - shortly after the flow."""
    entity_registry = er.async_get(hass)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        entries = er.async_entries_for_config_entry(entity_registry, entry_id)
        if entries:
            return entries[0].entity_id
        if loop.time() >= deadline:
            return None
        await asyncio.sleep(0.2)


async def async_create_throttled_sensor(
    hass: HomeAssistant,
    source_entity_id: str,
    name: str,
    window_seconds: int,
    precision: int = DEFAULT_PRECISION,
) -> dict:
    """Create a Filter/time_throttle helper for source_entity_id.

    Returns {"ok": True, "entry_id", "entity_id"} or {"ok": False, "error"}.
    """
    flow = hass.config_entries.flow
    result = await flow.async_init(FILTER_DOMAIN, context={"source": "user"})
    flow_id = result.get("flow_id")
    try:
        if result.get("type") != FlowResultType.FORM or result.get("step_id") != "user":
            return {"ok": False, "error": f"Unexpected Filter setup step: {result.get('step_id') or result.get('type')}"}

        result = await flow.async_configure(
            flow_id, {"name": name, "entity_id": source_entity_id, "filter": FILTER_TIME_THROTTLE}
        )
        if result.get("type") != FlowResultType.FORM or result.get("step_id") != FILTER_TIME_THROTTLE:
            return {"ok": False, "error": f"Unexpected Filter setup step: {result.get('step_id') or result.get('type')}"}

        result = await flow.async_configure(
            flow_id, {"window_size": window_to_duration(window_seconds), "precision": int(precision)}
        )
    except Exception as err:  # noqa: BLE001 - schema errors, aborts raised as exceptions
        _LOGGER.warning("Creating Filter helper for %s failed: %s", source_entity_id, err)
        _async_abort_quietly(hass, flow_id)
        return {"ok": False, "error": str(err) or type(err).__name__}

    result_type = result.get("type")
    if result_type == FlowResultType.ABORT:
        reason = result.get("reason")
        if reason == "already_configured":
            return {"ok": False, "error": "An identical Filter helper already exists for this sensor."}
        return {"ok": False, "error": f"Filter setup aborted: {reason}"}
    if result_type != FlowResultType.CREATE_ENTRY:
        _async_abort_quietly(hass, flow_id)
        errors = result.get("errors") or {}
        return {"ok": False, "error": f"Filter setup did not complete: {errors or result_type}"}

    entry = result.get("result")
    entry_id = getattr(entry, "entry_id", None)
    entity_id = await _async_wait_for_entity(hass, entry_id) if entry_id else None
    return {"ok": True, "entry_id": entry_id, "entity_id": entity_id}


@callback
def _async_abort_quietly(hass: HomeAssistant, flow_id: str | None) -> None:
    if not flow_id:
        return
    try:
        hass.config_entries.flow.async_abort(flow_id)
    except Exception:  # noqa: BLE001 - already finished / unknown flow
        pass
