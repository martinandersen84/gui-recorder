from __future__ import annotations

from pathlib import Path
import re

import yaml

from homeassistant.core import HomeAssistant

from .const import DOMAIN

_ALLOWED_EXCLUDE_KEYS = ("domains", "entity_globs", "event_types")
_ALLOWED_INCLUDE_KEYS = ("domains", "entity_globs")
_ALLOWED_TOP_KEYS = {"exclude": _ALLOWED_EXCLUDE_KEYS, "include": _ALLOWED_INCLUDE_KEYS}
# A YAML tag plus its arguments, e.g. "!secret recorder_db_url" or "!env_var DB_URL default".
_YAML_TAG_REFERENCE = re.compile(r"^![a-z_]+(?: [^\s#'\"]+)+$")


def parse_manual_exclusions(text: str) -> dict[str, dict[str, list[str]]]:
    """Parse and validate the user-provided manual exclusions YAML block.

    Only exclude.{domains,entity_globs,event_types} and include.{domains,entity_globs}
    are accepted here - individual entities stay exclusively managed by the entity
    toggles, so the two systems never fight over the same list. Raises ValueError
    with a user-facing message on anything else.
    """
    text = (text or "").strip()
    if not text:
        return {}

    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as err:
        raise ValueError(f"Invalid YAML: {err}") from err

    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ValueError("The manual exclusions block must be a YAML mapping (e.g. 'exclude:' / 'include:').")

    result: dict[str, dict[str, list[str]]] = {}
    for top_key, value in loaded.items():
        if top_key not in _ALLOWED_TOP_KEYS:
            raise ValueError(f"Unsupported key '{top_key}'. Only 'exclude' and 'include' are allowed here.")
        if not isinstance(value, dict):
            raise ValueError(f"'{top_key}' must be a mapping.")

        section: dict[str, list[str]] = {}
        for sub_key, items in value.items():
            if sub_key not in _ALLOWED_TOP_KEYS[top_key]:
                if sub_key == "entities":
                    raise ValueError(
                        f"'{top_key}.entities' is not allowed here - use the entity toggles in the panel "
                        "for individual entities instead."
                    )
                raise ValueError(
                    f"Unsupported key '{top_key}.{sub_key}'. Allowed: {', '.join(_ALLOWED_TOP_KEYS[top_key])}."
                )
            if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
                raise ValueError(f"'{top_key}.{sub_key}' must be a list of strings.")
            cleaned = sorted({item.strip() for item in items if item.strip()})
            if cleaned:
                section[sub_key] = cleaned

        if section:
            result[top_key] = section

    return result


async def async_write_yaml(hass: HomeAssistant) -> str:
    data = hass.data[DOMAIN]["data"]
    generated_path = data.get("generated_path", "gui_recorder.yaml")
    excluded_entities = sorted(set(data.get("excluded_entities", [])))
    rescued_entities = sorted(set(data.get("rescued_entities", [])))
    purge_keep_days = int(data.get("purge_keep_days", 10))
    auto_purge = bool(data.get("auto_purge", True))
    auto_repack = bool(data.get("auto_repack", True))
    commit_interval = int(data.get("commit_interval", 5))
    db_url = data.get("db_url")

    path = Path(hass.config.path(generated_path))

    try:
        manual = parse_manual_exclusions(data.get("manual_exclusions_yaml", ""))
    except ValueError:
        # Already validated when saved; if storage somehow holds something invalid
        # (e.g. edited externally), skip it rather than write a broken recorder config.
        manual = {}

    # Build ordered dicts (Python 3.7+ preserves insertion order) so safe_dump
    # emits them in our preferred order: entities first under exclude, then the
    # rest. safe_dump handles quoting for values with YAML-significant chars
    # (e.g. globs starting with '*' which YAML would otherwise parse as alias
    # references and reject — see https://github.com/martinandersen84/gui-recorder).
    manual_exclude = manual.get("exclude", {})
    exclude_block: dict[str, list[str]] = {}
    if excluded_entities:
        exclude_block["entities"] = excluded_entities
    for key in _ALLOWED_EXCLUDE_KEYS:
        if manual_exclude.get(key):
            exclude_block[key] = manual_exclude[key]

    manual_include = manual.get("include", {})
    include_block: dict[str, list[str]] = {}

    # Entities rescued from the user's own exclude domains/globs. include.entities is
    # the only rule that outranks those, but it is only safe while such a filter is
    # still configured: that keeps the recorder in entityfilter case 4a/4b, where
    # everything unmatched keeps recording. With no domain or glob filter left, the
    # same key would turn the whole config into an allowlist (case 6) - and nothing
    # would be hidden in the first place, so there is nothing to rescue either.
    has_domain_or_glob = any(
        section.get(key)
        for section, keys in ((manual_exclude, ("domains", "entity_globs")), (manual_include, ("domains", "entity_globs")))
        for key in keys
    )
    if rescued_entities and has_domain_or_glob:
        include_block["entities"] = rescued_entities

    for key in _ALLOWED_INCLUDE_KEYS:
        if manual_include.get(key):
            include_block[key] = manual_include[key]

    parts: list[str] = []
    parts.append("# This file is managed by the GUI Recorder integration.")
    parts.append("# Manual edits will be overwritten.")
    parts.append("")
    parts.append(f"auto_purge: {'true' if auto_purge else 'false'}")
    parts.append(f"auto_repack: {'true' if auto_repack else 'false'}")
    parts.append(f"purge_keep_days: {purge_keep_days}")
    parts.append(f"commit_interval: {commit_interval}")
    if isinstance(db_url, str) and db_url.strip():
        db_url = db_url.strip()
        if _YAML_TAG_REFERENCE.match(db_url):
            # Imported as a tag reference ('!secret recorder_db_url'): write it back
            # verbatim so HA resolves it, rather than a quoted string or the password.
            parts.append(f"db_url: {db_url}")
        else:
            # safe_dump quotes the value if the URL needs it (it usually doesn't,
            # but the ':' and '///' are safest left to the emitter).
            parts.append(yaml.safe_dump({"db_url": db_url}, default_flow_style=False).rstrip())
    parts.append("")

    if exclude_block:
        parts.append(yaml.safe_dump({"exclude": exclude_block}, sort_keys=False, default_flow_style=False).rstrip())
    else:
        parts.append("exclude: {}")

    if include_block:
        parts.append("")
        parts.append(yaml.safe_dump({"include": include_block}, sort_keys=False, default_flow_style=False).rstrip())

    content = "\n".join(parts) + "\n"
    await hass.async_add_executor_job(path.write_text, content, "utf-8")
    return str(path)
