from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .migration import async_detect_sync_status
from .panel import async_setup_panel
from .storage import async_load_data, async_save_data
from .websocket_api import async_setup_websocket_api
from .yaml_writer import async_write_yaml

_LOGGER = logging.getLogger(__name__)


async def _async_initialize(hass: HomeAssistant) -> None:
    hass.data.setdefault(DOMAIN, {})

    data = await async_load_data(hass)
    dirty = False
    if data.get("pending_restart"):
        data["pending_restart"] = False
        dirty = True
    if data.get("repack_in_progress"):
        data["repack_in_progress"] = False
        dirty = True
    if dirty:
        await async_save_data(hass, data)

    await async_write_yaml(hass)
    hass.data[DOMAIN]["migration"] = await async_detect_sync_status(hass)

    if not hass.data[DOMAIN].get("websocket_registered"):
        await async_setup_websocket_api(hass)
        hass.data[DOMAIN]["websocket_registered"] = True

    if not hass.data[DOMAIN].get("panel_registered"):
        try:
            await async_setup_panel(hass)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Failed to register GUI Recorder panel")


async def async_setup(hass: HomeAssistant, _config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, _entry: ConfigEntry) -> bool:
    await _async_initialize(hass)
    _LOGGER.info("GUI Recorder initialized")
    return True


async def async_unload_entry(hass: HomeAssistant, _entry: ConfigEntry) -> bool:
    return True
