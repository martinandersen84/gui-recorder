from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re
from typing import Any

import yaml

from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .db_stats import display_db_url


@dataclass
class BlockInfo:
    start: int
    end: int
    key: str
    line: str
    lines: list[str]

    @property
    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


def _config_path(hass: HomeAssistant) -> Path:
    return Path(hass.config.path("configuration.yaml"))


def _make_backup(path: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.with_name(f"{path.name}.gui_recorder_backup_{stamp}")
    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    return str(backup)


def _read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def _find_top_level_block(lines: list[str], key: str) -> BlockInfo | None:
    start = None
    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if line.startswith((" ", "\t")):
            continue
        if stripped.startswith("#"):
            continue
        if re.match(rf"^{re.escape(key)}\s*:", stripped):
            start = idx
            break

    if start is None:
        return None

    end = len(lines)
    for idx in range(start + 1, len(lines)):
        line = lines[idx]
        stripped = line.strip()
        if not stripped:
            continue
        if line.startswith((" ", "\t")):
            continue
        if line.lstrip().startswith("#"):
            continue
        end = idx
        break

    return BlockInfo(start=start, end=end, key=key, line=lines[start], lines=lines[start:end])


def _normalize_include_target(value: str | None) -> str:
    if value is None:
        return ""
    target = str(value).strip().strip('"\'')
    target = target.replace("\\", "/")
    while target.startswith("./"):
        target = target[2:]
    return target.strip()


def _extract_include_target(line: str) -> str | None:
    match = re.match(r"^recorder\s*:\s*!include\s+(.+?)\s*$", line.strip())
    if not match:
        return None
    return _normalize_include_target(match.group(1))


def _is_gui_recorder_include_target(value: str | None) -> bool:
    return _normalize_include_target(value) == "gui_recorder.yaml"


def _detect_active_gui_recorder_include(lines: list[str]) -> bool:
    for line in lines:
        if line.startswith((" ", "\t")):
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if _is_gui_recorder_include_target(_extract_include_target(stripped)):
            return True
    return False


class _TagPreservingLoader(yaml.SafeLoader):
    """SafeLoader that keeps HA's YAML tags instead of failing on them.

    yaml.safe_load rejects '!secret', '!env_var', '!include' and friends, which made
    the whole recorder block unreadable as soon as one value used them - typically
    'db_url: !secret recorder_db_url' on MariaDB/PostgreSQL. A tagged scalar is kept
    as the literal text ('!secret recorder_db_url') so it can be written back as-is.
    """


def _construct_tagged(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node) -> str | None:
    if isinstance(node, yaml.ScalarNode):
        return f"!{tag_suffix} {loader.construct_scalar(node)}".rstrip()
    # A tag on a list/mapping can't be represented; callers treat it as absent.
    return None


_TagPreservingLoader.add_multi_constructor("!", _construct_tagged)


def _parse_yaml_text(text: str) -> dict[str, Any] | None:
    try:
        loaded = yaml.load(text, Loader=_TagPreservingLoader)  # noqa: S506 - SafeLoader subclass
        if isinstance(loaded, dict):
            return loaded
    except Exception:
        return None
    return None


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    # A tagged value (e.g. 'entities: !include excluded.yaml') parses to a string;
    # iterating that would yield single characters, so treat it as absent.
    return list(value) if isinstance(value, list) else []


def _extract_summary_from_recorder_config(recorder_cfg: dict[str, Any] | None) -> dict[str, Any]:
    recorder_cfg = _as_dict(recorder_cfg)
    exclude = _as_dict(recorder_cfg.get("exclude"))
    include = _as_dict(recorder_cfg.get("include"))
    return {
        "auto_purge": recorder_cfg.get("auto_purge"),
        "auto_repack": recorder_cfg.get("auto_repack"),
        "purge_keep_days": recorder_cfg.get("purge_keep_days"),
        "commit_interval": recorder_cfg.get("commit_interval"),
        "db_url": display_db_url(recorder_cfg.get("db_url")),
        "exclude_entities_count": len(_as_list(exclude.get("entities"))),
        "exclude_domains_count": len(_as_list(exclude.get("domains"))),
        "exclude_globs_count": len(_as_list(exclude.get("entity_globs"))),
        "exclude_event_types_count": len(_as_list(exclude.get("event_types"))),
        "include_entities_count": len(_as_list(include.get("entities"))),
        "include_domains_count": len(_as_list(include.get("domains"))),
        "include_globs_count": len(_as_list(include.get("entity_globs"))),
        "supported_import": {
            "auto_purge": recorder_cfg.get("auto_purge"),
            "auto_repack": recorder_cfg.get("auto_repack"),
            "purge_keep_days": recorder_cfg.get("purge_keep_days"),
            "commit_interval": recorder_cfg.get("commit_interval"),
            "db_url": recorder_cfg.get("db_url"),
            "excluded_entities": _as_list(exclude.get("entities")),
        },
        # Filters GUI Recorder doesn't manage per-entity but can still carry over
        # verbatim into the manual exclusions block (exclude/include entities are
        # explicitly excluded - those stay exclusive to the entity toggles).
        "unsupported_filters": {
            "exclude": {
                key: _as_list(exclude.get(key))
                for key in ("domains", "entity_globs", "event_types")
                if _as_list(exclude.get(key))
            },
            "include": {
                key: _as_list(include.get(key))
                for key in ("domains", "entity_globs")
                if _as_list(include.get(key))
            },
        },
    }


def _detect_sync_status(hass: HomeAssistant) -> dict[str, Any]:
    config_path = _config_path(hass)
    lines = _read_lines(config_path)
    recorder_block = _find_top_level_block(lines, "recorder")

    gui_include_active = _detect_active_gui_recorder_include(lines)

    legacy_source_path: str | None = None
    legacy_source_type: str | None = None
    legacy_config: dict[str, Any] | None = None
    legacy_active = False
    legacy_message = None

    if recorder_block:
        stripped = recorder_block.line.strip()
        include_target = _extract_include_target(stripped)
        if include_target is not None:
            if not _is_gui_recorder_include_target(include_target):
                legacy_active = True
                legacy_source_type = "include"
                legacy_source_path = include_target
                included_path = Path(hass.config.path(include_target))
                if included_path.exists():
                    legacy_config = _parse_yaml_text(included_path.read_text(encoding="utf-8"))
                else:
                    legacy_message = f"Included file does not exist: {include_target}"
        else:
            legacy_active = True
            legacy_source_type = "inline"
            legacy_source_path = str(config_path)
            loaded = _parse_yaml_text(recorder_block.text)
            if loaded and "recorder" in loaded:
                legacy_config = loaded.get("recorder")
            elif isinstance(loaded, dict):
                legacy_config = loaded

    recorder_yaml_path = Path(hass.config.path("recorder.yaml"))
    recorder_yaml_exists = recorder_yaml_path.exists()
    if recorder_yaml_exists and not legacy_source_type and not gui_include_active:
        legacy_source_type = "recorder_yaml"
        legacy_source_path = str(recorder_yaml_path)
        legacy_config = _parse_yaml_text(recorder_yaml_path.read_text(encoding="utf-8"))

    summary = _extract_summary_from_recorder_config(legacy_config)

    return {
        "config_path": str(config_path),
        "gui_include_active": gui_include_active,
        "gui_ready": gui_include_active and not legacy_active,
        "legacy_active": legacy_active,
        "legacy_detected": bool(legacy_source_type),
        "legacy_source_type": legacy_source_type,
        "legacy_source_path": legacy_source_path,
        "legacy_summary": summary,
        "legacy_message": legacy_message,
        "legacy_block_present": recorder_block is not None,
        "recorder_yaml_exists": recorder_yaml_exists,
    }


async def async_detect_sync_status(hass: HomeAssistant) -> dict[str, Any]:
    status = await hass.async_add_executor_job(_detect_sync_status, hass)
    # This status goes to the browser; the import reads the raw db_url server-side.
    supported = status["legacy_summary"]["supported_import"]
    supported["db_url"] = display_db_url(supported.get("db_url"))
    data = hass.data.get(DOMAIN, {}).get("data", {})
    status["legacy_imported_at"] = data.get("legacy_imported_at")
    return status


def _comment_block(lines: list[str], block: BlockInfo) -> list[str]:
    new_lines = list(lines)
    for idx in range(block.start, block.end):
        line = new_lines[idx]
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        new_lines[idx] = (" " * indent) + "# " + line[indent:]
    return new_lines


def _disable_legacy_sync(hass: HomeAssistant) -> dict[str, Any]:
    config_path = _config_path(hass)
    lines = _read_lines(config_path)
    recorder_block = _find_top_level_block(lines, "recorder")
    if not recorder_block:
        return {"ok": False, "error": "No active recorder: block was found in configuration.yaml."}

    stripped = recorder_block.line.strip()
    include_target = _extract_include_target(stripped)
    if _is_gui_recorder_include_target(include_target):
        return {"ok": False, "error": "The active recorder config already points to gui_recorder.yaml."}

    backup = _make_backup(config_path)
    updated = _comment_block(lines, recorder_block)
    config_path.write_text("\n".join(updated) + "\n", encoding="utf-8")

    renamed_include: str | None = None
    if include_target:
        included_path = Path(hass.config.path(include_target))
        if included_path.exists():
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            disabled_path = included_path.with_name(
                f"{included_path.name}.gui_recorder_disabled_{stamp}"
            )
            included_path.rename(disabled_path)
            renamed_include = str(disabled_path)

    return {
        "ok": True,
        "backup_path": backup,
        "changed_file": str(config_path),
        "renamed_include": renamed_include,
    }


async def async_disable_legacy(hass: HomeAssistant) -> dict[str, Any]:
    return await hass.async_add_executor_job(_disable_legacy_sync, hass)


def _ensure_gui_sync(hass: HomeAssistant) -> dict[str, Any]:
    config_path = _config_path(hass)
    lines = _read_lines(config_path)
    recorder_block = _find_top_level_block(lines, "recorder")

    if recorder_block:
        stripped = recorder_block.line.strip()
        include_target = _extract_include_target(stripped)
        if not _is_gui_recorder_include_target(include_target):
            return {
                "ok": False,
                "error": "Another active recorder configuration is still enabled. Disable it before enabling gui_recorder.yaml.",
            }

    gui_include_active = _detect_active_gui_recorder_include(lines)
    backup = _make_backup(config_path)

    updated = list(lines)
    if not gui_include_active:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append("recorder: !include gui_recorder.yaml")

    config_path.write_text("\n".join(updated) + "\n", encoding="utf-8")
    return {"ok": True, "backup_path": backup, "changed_file": str(config_path)}


async def async_ensure_gui_enabled(hass: HomeAssistant) -> dict[str, Any]:
    return await hass.async_add_executor_job(_ensure_gui_sync, hass)


def _import_legacy_sync(hass: HomeAssistant) -> dict[str, Any]:
    status = _detect_sync_status(hass)
    if not status.get("legacy_detected"):
        return {"ok": False, "error": "No legacy recorder configuration was detected to import."}

    summary = status.get("legacy_summary") or {}
    supported = summary.get("supported_import") or {}
    unsupported_filters = summary.get("unsupported_filters") or {}

    updates: dict[str, Any] = {
        "excluded_entities": sorted(set(supported.get("excluded_entities") or [])),
        "legacy_imported_at": datetime.now().isoformat(timespec="seconds"),
    }
    for key in ("purge_keep_days", "commit_interval"):
        value = supported.get(key)
        if value is not None:
            try:
                updates[key] = int(value)
            except (TypeError, ValueError):
                pass
    for key in ("auto_purge", "auto_repack"):
        value = supported.get(key)
        if value is not None:
            updates[key] = bool(value)

    # Preserve a custom db_url (a SQLite database moved to /share, or a
    # MariaDB/PostgreSQL server). The recorder only reads db_url from its own
    # config, so dropping it on migration made HA silently start a fresh empty
    # SQLite DB at the default path. A '!secret ...' reference is kept as-is.
    db_url = supported.get("db_url")
    if isinstance(db_url, str) and db_url.strip():
        updates["db_url"] = db_url.strip()

    # Domain/glob/event_type filters can't be managed per-entity, but unlike
    # entities they can be carried over verbatim as YAML into the manual
    # exclusions block instead of being silently dropped on migration.
    manual_block = {section: keys for section, keys in unsupported_filters.items() if keys}
    manual_yaml = ""
    if manual_block:
        manual_yaml = (
            "# Imported automatically from the legacy recorder configuration.\n"
            "# Review before relying on this - confirm it still matches your setup.\n"
            + yaml.safe_dump(manual_block, sort_keys=True, default_flow_style=False)
        )
    updates["manual_exclusions_yaml"] = manual_yaml

    unsupported = {
        "exclude_domains_count": summary.get("exclude_domains_count", 0),
        "exclude_globs_count": summary.get("exclude_globs_count", 0),
        "exclude_event_types_count": summary.get("exclude_event_types_count", 0),
        "include_entities_count": summary.get("include_entities_count", 0),
        "include_domains_count": summary.get("include_domains_count", 0),
        "include_globs_count": summary.get("include_globs_count", 0),
    }

    return {
        "ok": True,
        "storage_updates": updates,
        "imported": {
            "excluded_entities": len(updates["excluded_entities"]),
            "purge_keep_days": updates.get("purge_keep_days"),
            "auto_purge": updates.get("auto_purge"),
            "auto_repack": updates.get("auto_repack"),
            "commit_interval": updates.get("commit_interval"),
            "manual_exclusions": bool(manual_block),
            "db_url": display_db_url(updates.get("db_url")),
        },
        "unsupported": unsupported,
        "source": status.get("legacy_source_path"),
    }


async def async_import_legacy(hass: HomeAssistant) -> dict[str, Any]:
    result = await hass.async_add_executor_job(_import_legacy_sync, hass)
    if result.get("ok"):
        updates = result.pop("storage_updates", {})
        hass.data[DOMAIN]["data"].update(updates)
    return result
