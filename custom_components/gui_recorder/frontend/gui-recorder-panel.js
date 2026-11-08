class GuiRecorderPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = {
      devices: [],
      orphans: [],
      obsolete: [],
      matched_exclusions: [],
      unmatched_exclusions: [],
      pending_restart: false,
      purge_keep_days: 10,
      auto_purge: true,
      auto_repack: true,
      commit_interval: 5,
      auto_update_data: true,
      stats: { entity_counts: {}, generated_at: null, db_path: "home-assistant_v2.db", total_rows: 0, error: null },
    };
    this._filter = "";
    this._filterDebounceTimer = null;
    this._message = "";
    this._refreshRecommended = false;
    this._expanded = new Set();
    this._pending = new Set();
    this._analyzing = false;
    this._purgingAll = false;
    this._purgingExcluded = false;
    this._savingGlobal = false;
    this._keepDaysValue = 10;
    this._autoPurgeValue = true;
    this._autoRepackValue = true;
    this._commitIntervalValue = 5;
    this._autoUpdateDataValue = true;
    this._togglingAutoUpdate = false;
    this._repackAfterManualPurgeValue = false;
    this._togglingRepack = false;
    this._dataMessage = "";
    this._migration = {};
    this._migrationBusy = false;
    this._manualExclusionsValue = "";
    this._manualExclusionsError = "";
    this._savingManualExclusions = false;
    this._throttleDialog = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._load();
    }
    // Do NOT re-render here: HA invokes this setter on every entity state
    // change in the whole system. The render is a pure function of our own
    // state (_data from WS, _filter, _migration, etc.) and never reads from
    // hass.states, so rebuilding the shadow DOM many times per second would
    // be wasted work AND destroys focus/selection on any input (textarea,
    // filter). _render() is invoked explicitly after our own state changes.
  }

  set narrow(narrow) {
    if (this._narrow === narrow) return;
    this._narrow = narrow;
    this._render();
  }

  set route(route) {
    this._route = route;
  }

  set panel(panel) {
    this._panel = panel;
  }

  async _load() {
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/get_tree" });
      this._data = result;
      this._migration = result?.migration || {};
      this._keepDaysValue = Number(result?.purge_keep_days || 10);
      this._autoPurgeValue = Boolean(result?.auto_purge ?? true);
      this._autoRepackValue = Boolean(result?.auto_repack ?? true);
      if (!this._autoPurgeValue) this._autoRepackValue = false;
      this._commitIntervalValue = Number(result?.commit_interval ?? 5);
      this._autoUpdateDataValue = Boolean(result?.auto_update_data ?? true);
      this._repackAfterManualPurgeValue = Boolean(result?.repack_after_manual_purge ?? false);
      this._manualExclusionsValue = result?.manual_exclusions_yaml || "";
      try {
        this._migration = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/get_migration_status" });
      } catch (_err) {}
      this._render();
      if (this._isDataStale() && !this._analyzing) {
        this._analyzeDb();
      }
    } catch (err) {
      this._message = `Error loading data: ${err?.message || err}`;
      this._render();
    }
  }

  async _refreshTreeData() {
    const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/get_tree" });
    this._data = result;
    this._migration = result?.migration || this._migration || {};
    this._keepDaysValue = Number(result?.purge_keep_days || this._keepDaysValue || 10);
    this._autoPurgeValue = Boolean(result?.auto_purge ?? this._autoPurgeValue ?? true);
    this._autoRepackValue = Boolean(result?.auto_repack ?? this._autoRepackValue ?? true);
    if (!this._autoPurgeValue) this._autoRepackValue = false;
    this._commitIntervalValue = Number(result?.commit_interval ?? this._commitIntervalValue ?? 5);
    this._autoUpdateDataValue = Boolean(result?.auto_update_data ?? this._autoUpdateDataValue ?? true);
    this._repackAfterManualPurgeValue = Boolean(result?.repack_after_manual_purge ?? this._repackAfterManualPurgeValue ?? false);
    this._manualExclusionsValue = result?.manual_exclusions_yaml ?? this._manualExclusionsValue ?? "";
  }

  _formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(Number(value || 0));
  }

  _formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const decimals = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(decimals)} ${units[unitIndex]}`;
  }

  _formatPercent(part, total) {
    if (!total) return "0%";
    return `${((part / total) * 100).toFixed(1)}%`;
  }

  _formatDate(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString("en-US");
    } catch (_err) {
      return value;
    }
  }

  _isDataStale() {
    const generatedAt = this._data?.stats?.generated_at;
    if (!generatedAt) return true;
    try {
      const ts = new Date(generatedAt).getTime();
      if (Number.isNaN(ts)) return true;
      return (Date.now() - ts) > 24 * 60 * 60 * 1000;
    } catch (_err) {
      return true;
    }
  }

  _shouldFlagUpdate() {
    if (this._analyzing) return false;
    return this._isDataStale() || this._refreshRecommended;
  }

  _isPurgeBusy() {
    if (this._purgingAll || this._purgingExcluded || this._data?.repack_in_progress) return true;
    for (const key of this._pending) {
      if (String(key).startsWith("purge:")) return true;
      if (String(key).startsWith("purge-device:")) return true;
    }
    return false;
  }

  _isMigrationPending() {
    const m = this._migration || {};
    return m.legacy_detected === true && !m.gui_include_active;
  }

  _entityMatches(entity) {
    if (!this._filter) return true;
    const text = `${entity.entity_id} ${entity.name} ${entity.platform} ${entity.domain}`.toLowerCase();
    return text.includes(this._filter.toLowerCase());
  }

  _deviceMatches(device) {
    if (!this._filter) return true;
    const own = `${device.name} ${device.manufacturer || ""} ${device.model || ""}`.toLowerCase();
    if (own.includes(this._filter.toLowerCase())) return true;
    return device.entities.some((e) => this._entityMatches(e));
  }

  _deviceVisibleEntities(device) {
    const visibleEntities = device.entities.filter((e) => this._entityMatches(e));
    return visibleEntities.length ? visibleEntities : device.entities;
  }

  _deviceState(device) {
    const visibleEntities = device.entities.filter((e) => this._entityMatches(e));
    const entities = visibleEntities.length ? visibleEntities : device.entities;
    const total = entities.length;
    const active = entities.filter((e) => e.recorded).length;
    if (active === 0) return { mode: "off", all: false, some: false, label: "OFF" };
    if (active === total) return { mode: "on", all: true, some: false, label: "ON" };
    return { mode: "mixed", all: false, some: true, label: `${active}/${total}` };
  }

  _toggleExpanded(deviceId) {
    if (this._expanded.has(deviceId)) this._expanded.delete(deviceId);
    else this._expanded.add(deviceId);
    this._render();
  }

  _setExpanded(deviceId, expanded) {
    if (expanded) this._expanded.add(deviceId);
    else this._expanded.delete(deviceId);
  }

  async _setEntity(entityId, recorded, deviceId = null) {
    this._pending.add(entityId);
    if (deviceId) this._expanded.add(deviceId);
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/set_entity", entity_id: entityId, recorded });
      this._message = "Changes saved to gui_recorder.yaml. Restart Home Assistant to apply them.";
      await this._load();
    } catch (err) {
      this._message = `Could not save ${entityId}: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(entityId);
      this._render();
    }
  }

  async _setDevice(deviceId, recorded) {
    this._pending.add(`device:${deviceId}`);
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/set_device", device_id: deviceId, recorded });
      this._message = "Changes saved to gui_recorder.yaml. Restart Home Assistant to apply them.";
      await this._load();
    } catch (err) {
      this._message = `Could not save the device: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(`device:${deviceId}`);
      this._render();
    }
  }

  async _setEntitiesBulk(entityIds, recorded, busyKey) {
    if (!entityIds.length || this._pending.has(busyKey)) return;
    const verb = recorded ? "Enabling" : "Disabling";
    if (!confirm(`${verb} recording for ${entityIds.length} entities. Continue?`)) return;
    this._pending.add(busyKey);
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/set_entities_bulk", entity_ids: entityIds, recorded });
      this._message = `${recorded ? "Enabled" : "Disabled"} recording for ${entityIds.length} entities. Restart Home Assistant to apply them.`;
      await this._load();
    } catch (err) {
      this._message = `Could not update entities: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(busyKey);
      this._render();
    }
  }

  async _analyzeDb() {
    this._analyzing = true;
    this._dataMessage = "Updating data…";
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/analyze_db" });
      if (result?.stats?.error) this._dataMessage = `Could not update data: ${result.stats.error}`;
      else this._dataMessage = "Data updated.";
      this._refreshRecommended = false;
      await this._load();
    } catch (err) {
      this._dataMessage = `Error updating data: ${err?.message || err}`;
      this._render();
    } finally {
      this._analyzing = false;
      this._render();
    }
  }

  async _setAutoUpdateData(value) {
    const newValue = Boolean(value);
    const previous = this._autoUpdateDataValue;
    this._autoUpdateDataValue = newValue;
    this._togglingAutoUpdate = true;
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/set_auto_update_data", auto_update_data: newValue });
    } catch (err) {
      this._autoUpdateDataValue = previous;
      this._message = `Error updating auto-update setting: ${err?.message || err}`;
    } finally {
      this._togglingAutoUpdate = false;
      this._render();
    }
  }

  async _setRepackAfterManualPurge(value) {
    const newValue = Boolean(value);
    const previous = this._repackAfterManualPurgeValue;
    this._repackAfterManualPurgeValue = newValue;
    this._togglingRepack = true;
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/set_repack_after_manual_purge", repack_after_manual_purge: newValue });
    } catch (err) {
      this._repackAfterManualPurgeValue = previous;
      this._message = `Error updating repack setting: ${err?.message || err}`;
    } finally {
      this._togglingRepack = false;
      this._render();
    }
  }


  async _saveGlobalOptions() {
    const keepDays = Number(this._keepDaysValue);
    const commitInterval = Number(this._commitIntervalValue);
    if (!Number.isInteger(keepDays) || keepDays < 1) {
      this._message = "Retention days must be an integer greater than or equal to 1.";
      this._render();
      return;
    }
    if (!Number.isInteger(commitInterval) || commitInterval < 0) {
      this._message = "Commit interval must be an integer greater than or equal to 0.";
      this._render();
      return;
    }
    this._savingGlobal = true;
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({
        type: "gui_recorder/set_global_options",
        purge_keep_days: keepDays,
        auto_purge: Boolean(this._autoPurgeValue),
        auto_repack: Boolean(this._autoPurgeValue) ? Boolean(this._autoRepackValue) : false,
        commit_interval: commitInterval,
      });
      this._message = "Global configuration saved to gui_recorder.yaml. Restart Home Assistant to apply it.";
      await this._load();
    } catch (err) {
      this._message = `Could not save global configuration: ${err?.message || err}`;
      this._render();
    } finally {
      this._savingGlobal = false;
      this._render();
    }
  }

  async _saveManualExclusions() {
    this._manualExclusionsError = "";
    this._savingManualExclusions = true;
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "gui_recorder/set_manual_exclusions",
        yaml_text: this._manualExclusionsValue || "",
      });
      if (result?.ok) {
        this._message = result.changed
          ? "Manual exclusions saved to gui_recorder.yaml. Restart Home Assistant to apply them."
          : "No changes to save.";
        await this._load();
      } else {
        this._manualExclusionsError = result?.error || "Could not save the manual exclusions.";
      }
    } catch (err) {
      this._manualExclusionsError = err?.message || String(err);
    } finally {
      this._savingManualExclusions = false;
      this._render();
    }
  }

  async _purgeAll() {
    if (this._isPurgeBusy()) return;
    if (!confirm(`This will purge recorder data older than the configured global retention (${this._keepDaysValue} day${Number(this._keepDaysValue) === 1 ? "" : "s"}). It will not delete recent data kept by the retention window. Continue?`)) return;
    this._purgingAll = true;
    this._message = "Purging recorder data older than the configured retention…";
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/purge_all" });
      this._refreshRecommended = true;
      this._message = "Database purge completed. Refreshing analysis…";
    } catch (err) {
      this._message = `Global purge error: ${err?.message || err}`;
      this._render();
    } finally {
      this._purgingAll = false;
      this._render();
      if (!this._analyzing && this._autoUpdateDataValue) this._analyzeDb();
    }
  }

  async _purgeExcludedEntities() {
    if (this._isPurgeBusy()) return;
    const excludedCount = Number(this._data?.stats?.configured_exclusions || 0);
    if (!excludedCount) return;
    if (!confirm(`This will permanently delete the full stored history for ${excludedCount} excluded entit${excludedCount === 1 ? "y" : "ies"}. This cannot be undone. Continue?`)) return;
    this._purgingExcluded = true;
    this._message = "Purging the full history for excluded entities…";
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/purge_excluded_entities" });
      this._refreshRecommended = true;
      this._message = "Excluded entities purged. Refreshing analysis…";
    } catch (err) {
      this._message = `Error purging excluded entities: ${err?.message || err}`;
      this._render();
    } finally {
      this._purgingExcluded = false;
      this._render();
      if (!this._analyzing && this._autoUpdateDataValue) this._analyzeDb();
    }
  }


  async _purgeEntity(entityId, deviceId = null) {
    if (this._isPurgeBusy()) return;
    if (!confirm(`This will purge the full history for ${entityId}. This cannot be undone. Continue?`)) return;
    this._pending.add(`purge:${entityId}`);
    if (deviceId) this._expanded.add(deviceId);
    this._message = `Purging history for ${entityId}…`;
    this._render();
    let statsRefreshed = false;
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/purge_entity", entity_id: entityId });
      if (result?.stats) {
        statsRefreshed = true;
        this._message = `Purge completed for ${entityId}. Data updated.`;
      } else {
        this._refreshRecommended = true;
        this._message = `Purge completed for ${entityId}. Refreshing analysis…`;
      }
    } catch (err) {
      this._message = `Error purging ${entityId}: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(`purge:${entityId}`);
      this._render();
      if (statsRefreshed) {
        this._refreshRecommended = false;
        this._dataMessage = "Data updated.";
        await this._load();
      } else if (!this._analyzing && this._autoUpdateDataValue) {
        this._analyzeDb();
      }
    }
  }

  async _purgeDevice(deviceId) {
    if (this._isPurgeBusy()) return;
    const device = (this._data.devices || []).find((d) => d.device_id === deviceId);
    const deviceName = device?.name || deviceId;
    if (!confirm(`This will purge the full history for ALL entities of "${deviceName}". This cannot be undone. Continue?`)) return;
    this._pending.add(`purge-device:${deviceId}`);
    this._message = `Purging history for ${deviceName}…`;
    this._render();
    let statsRefreshed = false;
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/purge_device", device_id: deviceId });
      if (result?.stats) {
        statsRefreshed = true;
        this._message = `Purge completed for ${deviceName} (${result?.purged_entities || 0} entities). Data updated.`;
      } else {
        this._refreshRecommended = true;
        this._message = `Purge completed for ${deviceName} (${result?.purged_entities || 0} entities). Refreshing analysis…`;
      }
    } catch (err) {
      this._message = `Error purging ${deviceName}: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(`purge-device:${deviceId}`);
      this._render();
      if (statsRefreshed) {
        this._refreshRecommended = false;
        this._dataMessage = "Data updated.";
        await this._load();
      } else if (!this._analyzing && this._autoUpdateDataValue) {
        this._analyzeDb();
      }
    }
  }


  async _restartHomeAssistant() {
    if (!confirm("Home Assistant will restart now. Continue?")) return;
    this._message = "Restart request sent to Home Assistant…";
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({ type: "gui_recorder/restart_homeassistant" });
      this._message = "Restart requested. The interface may disconnect for a moment.";
    } catch (err) {
      this._message = `Could not restart Home Assistant: ${err?.message || err}`;
    }
    this._render();
  }





  async _removeExclusion(entityId) {
    if (!confirm(`Remove ${entityId} from the configured exclusions?`)) return;
    this._pending.add(`remove:${entityId}`);
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/remove_exclusion", entity_id: entityId });
      await this._refreshTreeData();
      this._message = result?.removed
        ? `${entityId} removed from configured exclusions. Restart Home Assistant to apply the change.`
        : `Could not remove ${entityId} from configured exclusions.`;
      this._render();
    } catch (err) {
      this._message = `Could not remove ${entityId}: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete(`remove:${entityId}`);
      this._render();
    }
  }

  async _removeUnmatchedExclusions() {
    if (!confirm("Remove all unmatched exclusions from the configuration?")) return;
    this._pending.add("remove-unmatched");
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "gui_recorder/remove_unmatched_exclusions" });
      const removed = result?.removed || [];
      await this._refreshTreeData();
      this._message = removed.length
        ? `${removed.length} unmatched exclusions removed. Restart Home Assistant to apply the change.`
        : "No unmatched exclusions were found.";
      this._render();
    } catch (err) {
      this._message = `Could not remove unmatched exclusions: ${err?.message || err}`;
      this._render();
    } finally {
      this._pending.delete("remove-unmatched");
      this._render();
    }
  }

  _migrationSummaryLines() {
    const s = this._migration?.legacy_summary || {};
    const lines = [];
    if (!this._migration?.legacy_detected) return lines;
    if (s.auto_purge != null) lines.push(`auto_purge: ${s.auto_purge}`);
    if (s.auto_repack != null) lines.push(`auto_repack: ${s.auto_repack}`);
    if (s.purge_keep_days != null) lines.push(`purge_keep_days: ${s.purge_keep_days}`);
    if (s.commit_interval != null) lines.push(`commit_interval: ${s.commit_interval}`);
    if (s.db_url) lines.push(`db_url: ${s.db_url}`);
    if (s.exclude_entities_count) lines.push(`exclude.entities: ${s.exclude_entities_count}`);
    if (s.exclude_domains_count) lines.push(`exclude.domains: ${s.exclude_domains_count}`);
    if (s.exclude_globs_count) lines.push(`exclude.entity_globs: ${s.exclude_globs_count}`);
    if (s.include_entities_count) lines.push(`include.entities: ${s.include_entities_count}`);
    if (s.include_domains_count) lines.push(`include.domains: ${s.include_domains_count}`);
    if (s.include_globs_count) lines.push(`include.entity_globs: ${s.include_globs_count}`);
    return lines;
  }

  async _migrationAction(type) {
    this._migrationBusy = true;
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({ type });
      if (result?.ok) {
        if (type === "gui_recorder/import_legacy") {
          const imported = result.imported || {};
          const manualNote = imported.manual_exclusions
            ? " Unsupported filters (domains/entity_globs/event_types) were copied into the Manual exclusions field — review them there."
            : "";
          const dbNote = imported.db_url
            ? ` Custom database location preserved (${imported.db_url}).`
            : "";
          this._message = `Imported from existing configuration: ${imported.excluded_entities || 0} excluded entities and global recorder parameters.${dbNote}${manualNote}`;
        } else if (type === "gui_recorder/disable_legacy") {
          this._message = "Previous recorder configuration disabled in configuration.yaml.";
        } else if (type === "gui_recorder/enable_gui") {
          this._message = "GUI Recorder enabled in configuration.yaml.";
        }
      } else {
        this._message = result?.error || "Could not complete the migration action.";
      }
      await this._load();
    } catch (err) {
      this._message = `Migration error: ${err?.message || err}`;
      this._render();
    } finally {
      this._migrationBusy = false;
      this._render();
    }
  }

  _migrationCardMarkup() {
    const m = this._migration || {};
    const lines = this._migrationSummaryLines();
    const hasUnsupported = ((m.legacy_summary?.exclude_domains_count || 0) + (m.legacy_summary?.exclude_globs_count || 0) + (m.legacy_summary?.exclude_event_types_count || 0) + (m.legacy_summary?.include_entities_count || 0) + (m.legacy_summary?.include_domains_count || 0) + (m.legacy_summary?.include_globs_count || 0)) > 0;
    const includeEntitiesLost = (m.legacy_summary?.include_entities_count || 0) > 0;
    // Steps 2/3 must not run before the import: they would replace the user's
    // recorder config (exclusions, retention, a custom db_url) with defaults.
    const importRequired = m.legacy_detected === true && !m.legacy_imported_at;
    if (!m.legacy_detected && m.gui_ready) return '';

    return `
      <div class="card migration">
        <h2>Migration / configuration conflicts</h2>
        <div class="message warn"><strong>⚠ Back up Home Assistant before proceeding.</strong> Steps 2 and 3 modify <code>configuration.yaml</code> and require a restart. Step 1 is non-destructive.</div>
        ${m.gui_ready ? `<div class="message ok">GUI Recorder is enabled and no active configuration conflicts were detected.</div>` : ''}
        ${m.legacy_detected ? `
          <div class="message warn"><strong>Existing recorder configuration detected.</strong> ${m.legacy_source_path ? `Source: <code>${this._escapeHtml(m.legacy_source_path)}</code>.` : ''}</div>
          ${lines.length ? `<div class="row-note" style="margin:10px 0 12px;">Detected values: ${lines.map((l) => `<code>${this._escapeHtml(l)}</code>`).join(' · ')}</div>` : ''}
          ${hasUnsupported ? `<div class="message warn"><strong>Some legacy filters are not entity-level.</strong> <code>exclude.domains</code>, <code>exclude.entity_globs</code>, <code>exclude.event_types</code>, <code>include.domains</code> and <code>include.entity_globs</code> are copied automatically into the "Manual exclusions" field below when you import — review them there before completing migration.${includeEntitiesLost ? ` <code>include.entities</code> (allow-list mode) is not supported by GUI Recorder and will be lost.` : ''}</div>` : ''}
        ` : `<div class="message">No legacy recorder configuration was detected for import.</div>`}

        <div class="steps">
          <div class="step ${m.legacy_imported_at || !m.legacy_detected ? 'done' : ''}">
            <div class="step-title">Step 1: Import existing configuration${m.legacy_imported_at || !m.legacy_detected ? '<span class="step-check" aria-label="completed">✓</span>' : ''}</div>
            <div class="row-note">${m.legacy_imported_at ? `Imported on ${this._escapeHtml(m.legacy_imported_at)}.` : 'Use the legacy configuration as the starting point for GUI Recorder.'}</div>
            <button class="action-button" id="migration-import" ${!m.legacy_detected || m.legacy_imported_at || this._migrationBusy ? 'disabled' : ''}>Import detected configuration</button>
          </div>

          <div class="step ${m.legacy_active ? '' : 'done'}">
            <div class="step-title">Step 2: Disable previous recorder config${!m.legacy_active ? '<span class="step-check" aria-label="completed">✓</span>' : ''}</div>
            <div class="row-note">Comment the active <code>recorder:</code> block in <code>configuration.yaml</code> and create an automatic backup.</div>
            ${importRequired ? `<div class="row-note" style="margin-bottom:8px;"><strong>Complete Step 1 first.</strong> Disabling the legacy block before importing would replace your recorder settings with defaults.</div>` : ''}
            <button class="action-button" id="migration-disable" ${!m.legacy_active || importRequired || this._migrationBusy ? 'disabled' : ''}>Disable current recorder config</button>
          </div>

          <div class="step ${m.gui_include_active ? 'done' : ''}">
            <div class="step-title">Step 3: Enable GUI Recorder${m.gui_include_active ? '<span class="step-check" aria-label="completed">✓</span>' : ''}</div>
            <div class="row-note">Add <code>recorder: !include gui_recorder.yaml</code> if it is missing.</div>
            ${importRequired ? `<div class="row-note" style="margin-bottom:8px;"><strong>Complete Step 1 first.</strong></div>` : ''}
            <button class="action-button" id="migration-enable" ${m.gui_include_active || importRequired || this._migrationBusy ? 'disabled' : ''}>Enable gui_recorder.yaml</button>
          </div>
        </div>
      </div>
    `;
  }

  _escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  _globNote(entity) {
    if (!entity.glob_hidden) return "";
    return entity.recorded
      ? `<div class="row-note">kept by include.entities, above your exclude glob</div>`
      : `<div class="row-note">hidden by one of your manual exclude globs/domains — switch it on here to record it anyway</div>`;
  }

  _switchMarkup({ checked, mixed = false, disabled = false, entityId = "", deviceId = "", kind = "entity" }) {
    return `
      <label class="switch ${mixed ? "mixed" : ""} ${disabled ? "disabled" : ""}">
        <input
          type="checkbox"
          class="switch-input"
          ${checked ? "checked" : ""}
          ${disabled ? "disabled" : ""}
          data-kind="${kind}"
          ${entityId ? `data-entity-id="${this._escapeHtml(entityId)}"` : ""}
          ${deviceId ? `data-device-id="${this._escapeHtml(deviceId)}"` : ""}
        >
        <span class="switch-track"></span>
      </label>
    `;
  }

  _findEntity(entityId) {
    for (const device of this._data.devices || []) {
      const found = (device.entities || []).find((e) => e.entity_id === entityId);
      if (found) return found;
    }
    return (this._data.orphans || []).find((e) => e.entity_id === entityId) || null;
  }

  _formatWindow(seconds) {
    const total = Number(seconds || 0);
    if (!total) return "";
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : ""].filter(Boolean).join(" ");
  }

  _filterNote(entity) {
    const notes = [];
    for (const f of entity.filters || []) {
      const target = f.entity_id ? `<code>${this._escapeHtml(f.entity_id)}</code>` : this._escapeHtml(f.title || "filter helper");
      const what = f.filter === "time_throttle" && f.window_seconds ? `throttled every ${this._escapeHtml(this._formatWindow(f.window_seconds))}` : `filter: ${this._escapeHtml(f.filter || "?")}`;
      notes.push(`<div class="row-note filter-note">→ ${target} (${what})${f.disabled ? " · disabled" : ""}</div>`);
    }
    if (entity.filter_of) {
      notes.push(`<div class="row-note filter-note">filtered copy of <code>${this._escapeHtml(entity.filter_of)}</code></div>`);
    }
    return notes.join("");
  }

  _throttleButton(entity, disabled = false) {
    // Only raw sensors: a Filter helper on top of a Filter helper is never what you want here.
    if (entity.domain !== "sensor" || entity.filter_of) return "";
    return `<button class="mini-button" ${disabled ? "disabled" : ""} data-throttle-entity="${this._escapeHtml(entity.entity_id)}" title="Create a throttled copy that is recorded instead of this sensor">Throttle</button>`;
  }

  _openThrottleDialog(entityId) {
    const entity = this._findEntity(entityId);
    const state = this._hass?.states?.[entityId];
    const friendly = state?.attributes?.friendly_name || entity?.name || entityId;
    this._throttleDialog = {
      entityId,
      name: `${friendly} throttled`,
      minutes: 1,
      seconds: 0,
      excludeSource: true,
      hasStatistics: Boolean(state?.attributes?.state_class),
      nonNumeric: Boolean(state) && !["unknown", "unavailable"].includes(state.state) && Number.isNaN(Number(state.state)),
      existing: (entity?.filters || []).length,
      busy: false,
      error: "",
      yaml: "",
    };
    this._render();
    this.shadowRoot.getElementById("throttle-name")?.focus();
  }

  _closeThrottleDialog() {
    if (this._throttleDialog?.busy) return;
    this._throttleDialog = null;
    this._render();
  }

  async _submitThrottle() {
    const d = this._throttleDialog;
    if (!d || d.busy) return;
    const windowSeconds = Math.round(Number(d.minutes || 0) * 60 + Number(d.seconds || 0));
    if (!Number.isFinite(windowSeconds) || windowSeconds < 1 || windowSeconds > 86399) {
      d.error = "The update interval must be between 1 second and 23:59:59.";
      this._render();
      return;
    }
    d.busy = true;
    d.error = "";
    d.yaml = "";
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "gui_recorder/create_throttled_sensor",
        entity_id: d.entityId,
        name: String(d.name || "").trim(),
        window_seconds: windowSeconds,
        exclude_source: Boolean(d.excludeSource),
      });
      if (!result?.ok) {
        d.busy = false;
        d.error = result?.error || "Could not create the throttled sensor.";
        d.yaml = result?.yaml || "";
        this._render();
        return;
      }
      const created = result.entity_id ? `${result.entity_id}` : `"${result.name}"`;
      const parts = [`Created ${created}, updating at most every ${this._formatWindow(windowSeconds)}.`];
      if (result.excluded_source) parts.push(`${d.entityId} is now excluded from the recorder — restart Home Assistant to apply it.`);
      if (result.filtered_glob_hidden) parts.push(`Warning: ${created} is hidden by one of your manual exclude globs/domains — switch it on in its row so it gets recorded.`);
      this._throttleDialog = null;
      this._message = parts.join(" ");
      await this._refreshTreeData();
      this._render();
    } catch (err) {
      d.busy = false;
      d.error = `Could not create the throttled sensor: ${err?.message || err}`;
      this._render();
    }
  }

  _throttleDialogMarkup() {
    const d = this._throttleDialog;
    if (!d) return "";
    return `
      <div class="dialog-backdrop" id="throttle-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="throttle-title">
          <h2 id="throttle-title">Throttle a noisy sensor</h2>
          <div class="row-note" style="margin-bottom:12px;">Creates a <strong>Filter helper</strong> (<code>time_throttle</code>) based on <code>${this._escapeHtml(d.entityId)}</code>. It updates at most once per interval and is recorded instead of the raw sensor. You can edit or delete it later in <em>Settings → Devices &amp; services → Helpers</em>.</div>
          ${d.existing ? `<div class="message warn">This sensor already has ${d.existing} filter helper${d.existing === 1 ? "" : "s"}.</div>` : ""}
          ${d.nonNumeric ? `<div class="message warn">The current state is not numeric. The Filter integration only works with numeric sensors.</div>` : ""}
          <div class="dialog-grid">
            <label class="stat-label" for="throttle-name">Name of the new sensor</label>
            <input id="throttle-name" type="text" value="${this._escapeHtml(d.name)}" ${d.busy ? "disabled" : ""}>
            <label class="stat-label">Update at most every</label>
            <div class="dialog-inline">
              <input id="throttle-minutes" type="number" min="0" max="1439" step="1" value="${this._escapeHtml(d.minutes)}" ${d.busy ? "disabled" : ""}><span>min</span>
              <input id="throttle-seconds" type="number" min="0" max="59" step="1" value="${this._escapeHtml(d.seconds)}" ${d.busy ? "disabled" : ""}><span>s</span>
            </div>
          </div>
          <label class="dialog-check">
            <input id="throttle-exclude" type="checkbox" ${d.excludeSource ? "checked" : ""} ${d.busy ? "disabled" : ""}>
            <span>Stop recording <code>${this._escapeHtml(d.entityId)}</code> (adds it to <code>exclude.entities</code>; needs a restart)</span>
          </label>
          ${d.excludeSource && d.hasStatistics ? `<div class="message warn"><strong>This sensor has long-term statistics.</strong> Excluding it also stops its statistics. If it is used in the Energy dashboard or in statistics cards, point them to the new sensor (it keeps the same unit and state_class) — its history starts from now.</div>` : ""}
          ${d.error ? `<div class="message warn">${this._escapeHtml(d.error)}</div>` : ""}
          ${d.yaml ? `<textarea readonly rows="8" style="margin-top:8px;">${this._escapeHtml(d.yaml)}</textarea>` : ""}
          <div class="dialog-actions">
            <button class="action-button" id="throttle-cancel" ${d.busy ? "disabled" : ""}>Cancel</button>
            <button class="action-button primary" id="throttle-create" ${d.busy || d.yaml ? "disabled" : ""}>${d.busy ? "Creating…" : "Create throttled sensor"}</button>
          </div>
        </div>
      </div>
    `;
  }

  _purgeButton(entityId, deviceId = null, disabled = false) {
    return `<button class="mini-button" ${disabled ? "disabled" : ""} data-purge-entity="${this._escapeHtml(entityId)}" ${deviceId ? `data-device-id="${this._escapeHtml(deviceId)}"` : ""}>Purge</button>`;
  }

  _render() {
    const prevFilter = this.shadowRoot?.getElementById?.("filter");
    const filterWasFocused = prevFilter && this.shadowRoot.activeElement === prevFilter;
    const filterSelStart = filterWasFocused ? prevFilter.selectionStart : null;
    const filterSelEnd = filterWasFocused ? prevFilter.selectionEnd : null;

    const filteredDevices = (this._data.devices || []).filter((d) => this._deviceMatches(d));
    const filteredOrphans = (this._data.orphans || []).filter((e) => this._entityMatches(e));
    const visibleDeviceEntityIds = filteredDevices.flatMap((d) => this._deviceVisibleEntities(d).map((e) => e.entity_id));
    const visibleOrphanEntityIds = filteredOrphans.map((e) => e.entity_id);
    const filteredObsolete = (this._data.obsolete || []).filter((e) => this._entityMatches(e));
    const filteredUnmatchedExclusions = (this._data.unmatched_exclusions || []).filter((e) => !this._filter || String(e).toLowerCase().includes(this._filter.toLowerCase()));
    const stats = this._data.stats || {};
    const totalRows = Number(stats.total_rows || 0);
    const purgeActionBusy = this._isPurgeBusy();
    const migrationPending = this._isMigrationPending();

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; padding:16px; box-sizing:border-box; color:var(--primary-text-color); }
        .wrap { max-width:1500px; margin:0 auto; }
        .toolbar, .card, .notice { background:var(--card-background-color); border-radius:12px; padding:16px; box-shadow:var(--ha-card-box-shadow, none); margin-bottom:16px; border:1px solid var(--divider-color); }
        .card.migration { border-color: var(--warning-color, #ff9800); }
        .notice.pending { border-color:var(--warning-color, #ff9800); background:color-mix(in srgb, var(--card-background-color) 82%, var(--warning-color, #ff9800)); }
        .notice.pending.sticky { position:sticky; top:0; z-index:20; box-shadow:0 4px 12px rgba(0,0,0,0.2); }
        .notice.stale { border-color:var(--warning-color, #ff9800); border-left:6px solid var(--warning-color, #ff9800); background:color-mix(in srgb, var(--card-background-color) 76%, var(--warning-color, #ff9800)); color:var(--primary-text-color); }
        .toolbar-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
        .toolbar-actions { display:flex; gap:10px; flex-wrap:wrap; }
        h1, h2, h3 { margin:0 0 12px; }
        h3 { font-size:1rem; }
        input[type="search"], input[type="number"] { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--divider-color); background:var(--primary-background-color); color:var(--primary-text-color); box-sizing:border-box; }
        textarea { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--divider-color); background:var(--primary-background-color); color:var(--primary-text-color); box-sizing:border-box; font-family:var(--code-font-family, monospace); font-size:0.9rem; resize:vertical; }
        .message { margin-top:12px; color:var(--secondary-text-color); }
        .message.warn { color: var(--warning-color, #ff9800); }
        .message.ok { color: var(--success-color, #43a047); }
        .steps { display:grid; gap:12px; margin-top:12px; }
        .step { padding:12px; border-radius:10px; border:1px solid var(--divider-color); background:var(--primary-background-color); }
        .step.done { opacity:0.85; border-color: var(--success-color, #43a047); }
        .step-title { font-weight:600; margin-bottom:6px; display:flex; align-items:center; gap:8px; }
        .step-check { color: var(--success-color, #43a047); font-weight:700; font-size:1.1em; line-height:1; }
        .menu-button { background:transparent; border:none; color:var(--primary-text-color); cursor:pointer; padding:6px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; }
        .menu-button:hover { background: var(--secondary-background-color); }
        .menu-button:focus-visible { outline:2px solid var(--primary-color); outline-offset:2px; }
        .settings-grid, .stats-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
        .stat-box { padding:12px; border-radius:10px; background:var(--primary-background-color); border:1px solid var(--divider-color); }
        .setting-box { padding:12px; border-radius:10px; background:var(--primary-background-color); border:1px solid var(--divider-color); }
        .setting-actions { display:flex; gap:10px; align-items:end; flex-wrap:wrap; }
        .stat-label { color:var(--secondary-text-color); font-size:0.9rem; margin-bottom:6px; }
        .stat-value { font-size:1.15rem; font-weight:600; word-break:break-word; }
        .action-button, .mini-button { border:1px solid var(--divider-color); background:var(--primary-background-color); color:var(--primary-text-color); border-radius:10px; padding:10px 14px; cursor:pointer; font:inherit; }
        .mini-button { padding:6px 10px; font-size:0.9rem; }
        .danger { border-color: var(--error-color, #f44336); }
        .action-button[disabled], .mini-button[disabled] { opacity:0.6; cursor:default; }
        .device-block { border-top:1px solid var(--divider-color); }
        .device-block:first-of-type { border-top:none; }
        .device-head { display:grid; grid-template-columns:auto 1fr auto auto auto auto; gap:12px; align-items:center; padding:14px 6px; }
        .caret { width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; color:var(--secondary-text-color); cursor:pointer; border-radius:8px; }
        .caret:hover { background:var(--secondary-background-color); }
        .caret-icon { display:inline-block; transition:transform 0.2s ease; font-size:18px; line-height:1; }
        .caret-icon.expanded { transform:rotate(90deg); }
        .device-name { font-weight:600; }
        .device-meta { font-size:0.9rem; color:var(--secondary-text-color); margin-top:2px; }
        .state-pill { display:inline-block; padding:4px 8px; border-radius:999px; background:var(--secondary-background-color); font-size:0.8rem; color:var(--secondary-text-color); }
        .device-rows { padding:0 0 10px 40px; }
        table { width:100%; border-collapse:collapse; margin-top:2px; }
        th, td { text-align:left; padding:10px 8px; border-top:1px solid var(--divider-color); vertical-align:middle; font-size:0.95rem; }
        thead th { color:var(--secondary-text-color); font-weight:500; }
        tbody tr:nth-child(even) { background:color-mix(in srgb, var(--primary-text-color) 4%, transparent); }
        tbody tr:hover, .device-head:hover { background:color-mix(in srgb, var(--primary-color) 10%, transparent); }
        code { font-family:var(--code-font-family, monospace); font-size:0.9rem; }
        .switch { position:relative; display:inline-flex; width:38px; height:22px; vertical-align:middle; cursor:pointer; }
        .switch.disabled { cursor:default; opacity:0.6; }
        .switch-input { position:absolute; inset:0; opacity:0; margin:0; cursor:inherit; }
        .switch-track { width:100%; height:100%; background:var(--disabled-color, #7f848e); border-radius:999px; transition:background 0.18s ease; position:relative; }
        .switch-track::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:white; transition:transform 0.18s ease; box-shadow:0 1px 2px rgba(0,0,0,0.25); }
        .switch-input:checked + .switch-track { background:var(--switch-checked-color, var(--primary-color)); }
        .switch-input:checked + .switch-track::after { transform:translateX(16px); }
        .switch.mixed .switch-track { background:color-mix(in srgb, var(--switch-checked-color, var(--primary-color)) 50%, var(--disabled-color, #7f848e)); }
        .switch.mixed .switch-track::after { transform:translateX(8px); }
        .row-note { color:var(--secondary-text-color); font-size:0.85rem; }
        .orphans-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
        .subtle { color:var(--secondary-text-color); }
        .pending-dot { width:8px; height:8px; border-radius:50%; background:var(--warning-color, #ff9800); display:inline-block; margin-left:8px; }
        .action-button.stale { border-color:var(--warning-color, #ff9800); animation:gr-border-pulse 1.4s ease-in-out infinite; }
        .toolbar-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
        @keyframes gr-border-pulse {
          0%   { box-shadow:0 0 0 0 color-mix(in srgb, var(--warning-color, #ff9800) 70%, transparent); border-color:var(--warning-color, #ff9800); }
          70%  { box-shadow:0 0 0 8px color-mix(in srgb, var(--warning-color, #ff9800) 0%, transparent); border-color:color-mix(in srgb, var(--warning-color, #ff9800) 60%, transparent); }
          100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--warning-color, #ff9800) 0%, transparent); border-color:var(--warning-color, #ff9800); }
        }
        .right { text-align:right; white-space:nowrap; }
        .actions-cell { display:flex; align-items:center; gap:10px; justify-content:flex-start; flex-wrap:wrap; }
        .filter-note { margin-top:4px; }
        .dialog-backdrop { position:fixed; inset:0; z-index:100; background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; }
        .dialog { background:var(--card-background-color); color:var(--primary-text-color); border-radius:12px; border:1px solid var(--divider-color); padding:20px; width:100%; max-width:560px; max-height:calc(100vh - 32px); overflow:auto; box-shadow:0 8px 32px rgba(0,0,0,0.35); box-sizing:border-box; }
        .dialog-grid { display:grid; gap:8px; margin-top:8px; }
        .dialog-grid .stat-label { margin:6px 0 0; }
        .dialog input[type="text"] { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--divider-color); background:var(--primary-background-color); color:var(--primary-text-color); box-sizing:border-box; font:inherit; }
        .dialog-inline { display:flex; align-items:center; gap:8px; }
        .dialog-inline input[type="number"] { width:90px; }
        .dialog-check { display:flex; gap:10px; align-items:flex-start; margin-top:16px; cursor:pointer; }
        .dialog-check input { margin-top:3px; }
        .dialog-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; flex-wrap:wrap; }
        .action-button.primary { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:var(--primary-color); }
      </style>
      <div class="wrap">
        ${this._data.pending_restart ? `<div class="notice pending sticky"><strong>Pending changes.</strong> Restart Home Assistant so Recorder can apply the new configuration.</div>` : ""}

        <div class="toolbar">
          <div class="toolbar-head">
            <div>
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                ${this._narrow ? `<button class="menu-button" id="gr-menu-button" aria-label="Open sidebar"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg></button>` : ''}
                <h1 style="margin:0;">GUI Recorder</h1>
                <span class="state-pill">v${this._escapeHtml(this._data.version || "0.8.4")}</span>
              </div>
            </div>
          </div>
        </div>



        ${this._migrationCardMarkup()}

        <div class="card">
          <h2>Global recorder configuration</h2>
          <div class="settings-grid">
            <div class="setting-box">
              <div class="stat-label">Global retention days (purge_keep_days)</div>
              <input id="purge-keep-days" type="number" min="1" step="1" value="${this._escapeHtml(this._keepDaysValue)}">
            </div>
            <div class="setting-box">
              <div class="stat-label">Nightly auto purge (auto_purge)</div>
              <div>${this._switchMarkup({ checked: this._autoPurgeValue, kind: "global", entityId: "auto_purge" })}</div>
            </div>
            <div class="setting-box">
              <div class="stat-label">Automatic repack (auto_repack)</div>
              <div>${this._switchMarkup({ checked: this._autoRepackValue, kind: "global", entityId: "auto_repack", disabled: !this._autoPurgeValue })}</div>
              ${!this._autoPurgeValue ? `<div class="row-note" style="margin-top:8px;">Has no effect when auto_purge is disabled.</div>` : ""}
            </div>
            <div class="setting-box">
              <div class="stat-label">Commit interval (seconds)</div>
              <input id="commit-interval" type="number" min="0" step="1" value="${this._escapeHtml(this._commitIntervalValue)}">
            </div>
          </div>
          <div class="setting-actions" style="margin-top:12px;">
            <button class="action-button" id="save-global-options" ${this._savingGlobal ? "disabled" : ""}>${this._savingGlobal ? "Saving…" : "Save global configuration"}</button>
          </div>
          <div class="row-note" style="margin-top:8px;">This will be written to <code>gui_recorder.yaml</code> and applied after a Home Assistant restart.</div>
        </div>

        <div class="card">
          <h2>Manual exclusions (advanced)</h2>
          <div class="row-note" style="margin-bottom:10px;">
            Raw YAML merged into the generated <code>gui_recorder.yaml</code>. Only <code>exclude.domains</code>, <code>exclude.entity_globs</code>, <code>exclude.event_types</code>, <code>include.domains</code> and <code>include.entity_globs</code> are allowed here.
            Individual entities are managed exclusively through the device/entity toggles below — do not list <code>entities</code> in this block.
          </div>
          <textarea id="manual-exclusions" rows="8" spellcheck="false" placeholder="exclude:&#10;  domains:&#10;    - sensor&#10;  entity_globs:&#10;    - sensor.weather_*">${this._escapeHtml(this._manualExclusionsValue)}</textarea>
          <div class="setting-actions" style="margin-top:12px;">
            <button class="action-button" id="save-manual-exclusions" ${this._savingManualExclusions ? "disabled" : ""}>${this._savingManualExclusions ? "Saving…" : "Save manual exclusions"}</button>
          </div>
          ${this._manualExclusionsError ? `<div class="message warn">${this._escapeHtml(this._manualExclusionsError)}</div>` : ""}
        </div>

        <div class="card">
          <h2>Data</h2>
          <div class="settings-grid">
            <div class="setting-box">
              <div class="stat-label">Last update</div>
              <div class="stat-value">${this._escapeHtml(this._formatDate(stats.generated_at))}</div>
              <div class="setting-actions" style="margin-top:12px;">
                <button class="action-button ${this._shouldFlagUpdate() ? "stale" : ""}" id="analyze-db" ${this._analyzing ? "disabled" : ""} ${this._shouldFlagUpdate() ? `title="${this._refreshRecommended ? "Data changed since last update. Click to refresh." : "Data is older than 24 hours. Click to refresh."}"` : ""}>${this._analyzing ? "Updating…" : "Update data"}</button>
              </div>
            </div>
          </div>
          ${this._dataMessage ? `<div class="message">${this._escapeHtml(this._dataMessage)}</div>` : ""}
        </div>

        <div class="card">
          <h2>Database statistics</h2>
          <div class="stats-grid">
            <div class="stat-box"><div class="stat-label">Analyzed records (states)</div><div class="stat-value">${this._formatNumber(totalRows)}</div></div>
            <div class="stat-box"><div class="stat-label">Entities with records</div><div class="stat-value">${this._formatNumber(Object.keys(stats.entity_counts || {}).length)}</div></div>
            <div class="stat-box"><div class="stat-label">Current records</div><div class="stat-value">${this._formatNumber(stats.current_rows || 0)}</div></div>
            <div class="stat-box"><div class="stat-label">Obsolete / unlinked records</div><div class="stat-value">${this._formatNumber(stats.obsolete_rows || 0)}</div></div>
            <div class="stat-box"><div class="stat-label">Configured exclusions</div><div class="stat-value">${this._formatNumber(stats.configured_exclusions || 0)}</div><div class="stat-subtle">Matched ${this._formatNumber(stats.matched_exclusions || 0)} · Unmatched ${this._formatNumber(stats.unmatched_exclusions || 0)}</div></div>
            <div class="stat-box"><div class="stat-label">DB size</div><div class="stat-value">${this._escapeHtml(this._formatBytes(stats.db_size_bytes || 0))}</div></div>
            <div class="stat-box"><div class="stat-label">Database</div><div class="stat-value">${this._escapeHtml(stats.db_path || "home-assistant_v2.db")}</div></div>
          </div>
          ${stats.error ? `<div class="message">Error: ${this._escapeHtml(stats.error)}</div>` : ""}
        </div>

        ${migrationPending ? `
        <div class="card" style="border-color:var(--warning-color,#ff9800);">
          <div class="message warn" style="margin-top:0;">
            <strong>Migration required.</strong> Complete the migration above before managing entities or running maintenance actions.
            Once <code>gui_recorder.yaml</code> is the active recorder source (Step 3 done), all sections will become available.
          </div>
        </div>
        ` : `
        <div class="card">
          <h2>Maintenance actions</h2>
          ${this._data.repack_in_progress ? `<div class="notice pending"><strong>Repack in progress.</strong> The database file is being compacted; this can take a while on large databases. Other purge actions are temporarily disabled.</div>` : ""}
          <div class="settings-grid">
            <div class="setting-box">
              <div class="stat-label">Purge DB</div>
              <div class="row-note">Deletes recorder data older than the current global retention of <strong>${this._escapeHtml(this._keepDaysValue)}</strong> day${Number(this._keepDaysValue) === 1 ? "" : "s"}. Recent data inside that retention window is kept.</div>
              <div class="setting-actions" style="margin-top:12px;">
                <button class="action-button danger" id="purge-all" ${purgeActionBusy ? "disabled" : ""}>${this._purgingAll ? "Purging…" : "Purge DB"}</button>
              </div>
            </div>
            <div class="setting-box">
              <div class="stat-label">Purge excluded entities</div>
              <div class="row-note">Deletes the full stored history for all entities currently excluded by GUI Recorder. This ignores the global retention and removes all stored rows for those excluded entities.</div>
              <div class="setting-actions" style="margin-top:12px;">
                <button class="action-button danger" id="purge-excluded" ${(purgeActionBusy || !Number(this._data?.stats?.configured_exclusions || 0)) ? "disabled" : ""}>${this._purgingExcluded ? "Purging…" : "Purge excluded entities"}</button>
              </div>
            </div>
            <div class="setting-box">
              <div class="stat-label">Auto-update data after purge</div>
              <div>${this._switchMarkup({ checked: this._autoUpdateDataValue, kind: "auto-update", entityId: "auto_update_data", disabled: this._togglingAutoUpdate })}${this._togglingAutoUpdate ? `<span class="pending-dot" title="Saving"></span>` : ""}</div>
              <div class="row-note" style="margin-top:8px;">When enabled, database analysis is refreshed automatically after each purge. When disabled, refresh manually from the Data card.</div>
            </div>
            <div class="setting-box">
              <div class="stat-label">Repack after manual purge</div>
              <div>${this._switchMarkup({ checked: this._repackAfterManualPurgeValue, kind: "repack-toggle", entityId: "repack_after_manual_purge", disabled: this._togglingRepack })}${this._togglingRepack ? `<span class="pending-dot" title="Saving"></span>` : ""}</div>
              <div class="row-note" style="margin-top:8px;">When enabled, the database file is compacted (VACUUM) after <em>Purge DB</em> and <em>Purge excluded entities</em>. This reclaims disk space but can take significantly longer, especially on large databases.</div>
            </div>
            <div class="setting-box">
              <div class="stat-label">Restart Home Assistant</div>
              <div class="row-note">Restarts Home Assistant so pending recorder configuration changes can take effect. The interface may disconnect briefly during restart.</div>
              <div class="setting-actions" style="margin-top:12px;">
                <button class="action-button" id="restart-ha">Restart HA</button>
              </div>
            </div>
          </div>
          ${this._message ? `<div class="message">${this._escapeHtml(this._message)}</div>` : ""}
        </div>

        <div class="card">
          <h2>Filter</h2>
          <input id="filter" type="search" placeholder="Filter by entity_id, name, domain, or platform" value="${this._escapeHtml(this._filter)}">
        </div>

        <div class="card">
          <div class="orphans-head">
            <h2>Devices</h2>
            <div class="actions-cell">
              <button class="mini-button" id="devices-select-all" ${!visibleDeviceEntityIds.length || this._pending.has("bulk:devices:select") ? "disabled" : ""}>Select all</button>
              <button class="mini-button" id="devices-deselect-all" ${!visibleDeviceEntityIds.length || this._pending.has("bulk:devices:deselect") ? "disabled" : ""}>Deselect all</button>
            </div>
          </div>
          ${filteredDevices.length === 0 ? `<div>No devices to display.</div>` : filteredDevices.map((device) => {
            const state = this._deviceState(device);
            const expanded = this._expanded.has(device.device_id);
            const entities = this._deviceVisibleEntities(device);
            const deviceBusy = this._pending.has(`device:${device.device_id}`);
            const devicePurgeBusy = this._pending.has(`purge-device:${device.device_id}`);
            return `
              <div class="device-block" data-device-block="${this._escapeHtml(device.device_id)}">
                <div class="device-head">
                  <button class="caret" data-toggle-device="${this._escapeHtml(device.device_id)}" aria-label="Expand or collapse device"><span class="caret-icon ${expanded ? "expanded" : ""}">›</span></button>
                  <div>
                    <div class="device-name">${this._escapeHtml(device.name)}</div>
                    <div class="device-meta">${this._escapeHtml([device.manufacturer || "", device.model || ""].filter(Boolean).join(" · "))}</div>
                  </div>
                  <div class="state-pill">${this._escapeHtml(state.label)}</div>
                  <div class="right">${this._formatNumber(device.record_count || 0)}</div>
                  <div class="actions-cell"><button class="mini-button" ${purgeActionBusy || devicePurgeBusy || !device.record_count ? "disabled" : ""} data-purge-device="${this._escapeHtml(device.device_id)}">Purge</button>${devicePurgeBusy ? `<span class="pending-dot" title="Purging"></span>` : ""}</div>
                  <div>${this._switchMarkup({ checked: state.all, mixed: state.some, disabled: deviceBusy, deviceId: device.device_id, kind: "device" })}${deviceBusy ? `<span class="pending-dot" title="Saving"></span>` : ""}</div>
                </div>
                ${expanded ? `
                  <div class="device-rows">
                    <table>
                      <thead>
                        <tr>
                          <th>Entity</th>
                          <th>Name</th>
                          <th>Platform</th>
                          <th class="right">Records</th>
                          <th class="right">%</th>
                          <th>Recorder</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${entities.map((entity) => {
                          const entityBusy = this._pending.has(entity.entity_id);
                          const purgeBusy = this._pending.has(`purge:${entity.entity_id}`);
                          return `
                            <tr>
                              <td><code>${this._escapeHtml(entity.entity_id)}</code></td>
                              <td><div>${this._escapeHtml(entity.name || "")}</div>${entity.disabled_by || entity.hidden_by ? `<div class="row-note">${this._escapeHtml([entity.disabled_by ? `disabled:${entity.disabled_by}` : "", entity.hidden_by ? `hidden:${entity.hidden_by}` : ""].filter(Boolean).join(" · "))}</div>` : ""}</td>
                              <td>${this._escapeHtml(entity.platform || "")}</td>
                              <td class="right">${this._formatNumber(entity.record_count || 0)}</td>
                              <td class="right">${this._escapeHtml(this._formatPercent(entity.record_count || 0, totalRows))}</td>
                              <td>${this._switchMarkup({ checked: entity.recorded, disabled: entityBusy, entityId: entity.entity_id, deviceId: device.device_id, kind: "entity" })}${entityBusy ? `<span class="pending-dot" title="Saving"></span>` : ""}${this._globNote(entity)}${this._filterNote(entity)}</td>
                              <td><div class="actions-cell">${this._purgeButton(entity.entity_id, device.device_id, purgeActionBusy || purgeBusy || !entity.record_count)}${this._throttleButton(entity, entityBusy)}${purgeBusy ? `<span class="pending-dot" title="Purging"></span>` : ""}</div></td>
                            </tr>
                          `;
                        }).join("")}
                      </tbody>
                    </table>
                  </div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>

        <div class="card">
          <div class="orphans-head">
            <h2>Entities without a device</h2>
            <div class="actions-cell">
              <div class="subtle">${filteredOrphans.length}</div>
              <button class="mini-button" id="orphans-select-all" ${!visibleOrphanEntityIds.length || this._pending.has("bulk:orphans:select") ? "disabled" : ""}>Select all</button>
              <button class="mini-button" id="orphans-deselect-all" ${!visibleOrphanEntityIds.length || this._pending.has("bulk:orphans:deselect") ? "disabled" : ""}>Deselect all</button>
            </div>
          </div>
          ${filteredOrphans.length === 0 ? `<div>No unassigned entities.</div>` : `
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Name</th>
                  <th>Platform</th>
                  <th class="right">Records</th>
                  <th class="right">%</th>
                  <th>Recorder</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredOrphans.map((entity) => {
                  const entityBusy = this._pending.has(entity.entity_id);
                  const purgeBusy = this._pending.has(`purge:${entity.entity_id}`);
                  return `
                    <tr>
                      <td><code>${this._escapeHtml(entity.entity_id)}</code></td>
                      <td>${this._escapeHtml(entity.name || "")}</td>
                      <td>${this._escapeHtml(entity.platform || "")}</td>
                      <td class="right">${this._formatNumber(entity.record_count || 0)}</td>
                      <td class="right">${this._escapeHtml(this._formatPercent(entity.record_count || 0, totalRows))}</td>
                      <td>${this._switchMarkup({ checked: entity.recorded, disabled: entityBusy, entityId: entity.entity_id, kind: "entity" })}${entityBusy ? `<span class="pending-dot" title="Saving"></span>` : ""}${this._globNote(entity)}${this._filterNote(entity)}</td>
                      <td><div class="actions-cell">${this._purgeButton(entity.entity_id, null, purgeActionBusy || purgeBusy || !entity.record_count)}${this._throttleButton(entity, entityBusy)}${purgeBusy ? `<span class="pending-dot" title="Purging"></span>` : ""}</div></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          `}
        </div>

        <div class="card">
          <div class="orphans-head">
            <h2>Unmatched configured exclusions</h2>
            <div style="display:flex; align-items:center; gap:8px;">
              <div class="subtle">${filteredUnmatchedExclusions.length}</div>
              ${filteredUnmatchedExclusions.length ? `<button class="secondary" id="remove-unmatched-exclusions" ${this._pending.has("remove-unmatched") ? "disabled" : ""}>Remove all unmatched</button>` : ""}
            </div>
          </div>
          <div class="message">Configured exclusions stored by GUI Recorder that do not match any current entity_id in Home Assistant.</div>
          ${filteredUnmatchedExclusions.length === 0 ? `<div>No unmatched exclusions detected.</div>` : `
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredUnmatchedExclusions.map((entityId) => `
                  <tr>
                    <td><code>${this._escapeHtml(entityId)}</code></td>
                    <td>Stored in configuration only</td>
                    <td><div class="actions-cell"><button class="secondary" data-remove-exclusion="${this._escapeHtml(entityId)}" ${this._pending.has(`remove:${entityId}`) ? "disabled" : ""}>Remove</button>${this._pending.has(`remove:${entityId}`) ? `<span class="pending-dot" title="Saving"></span>` : ""}</div></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>

        <div class="card">
          <div class="orphans-head"><h2>Obsolete / unlinked records</h2><div class="subtle">${filteredObsolete.length}</div></div>
          <div class="message">Entities present in the database but not in the current Home Assistant entity registry.</div>
          ${filteredObsolete.length === 0 ? `<div>No obsolete / unlinked records detected.</div>` : `
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Platform</th>
                  <th class="right">Records</th>
                  <th class="right">%</th>
                  <th>Recorder</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredObsolete.map((entity) => {
                  const entityBusy = this._pending.has(entity.entity_id);
                  const purgeBusy = this._pending.has(`purge:${entity.entity_id}`);
                  return `
                    <tr>
                      <td><code>${this._escapeHtml(entity.entity_id)}</code></td>
                      <td>${this._escapeHtml(entity.platform || "")}</td>
                      <td class="right">${this._formatNumber(entity.record_count || 0)}</td>
                      <td class="right">${this._escapeHtml(this._formatPercent(entity.record_count || 0, totalRows))}</td>
                      <td>${this._switchMarkup({ checked: entity.recorded, disabled: entityBusy, entityId: entity.entity_id, kind: "entity" })}${entityBusy ? `<span class="pending-dot" title="Saving"></span>` : ""}${this._globNote(entity)}</td>
                      <td><div class="actions-cell">${this._purgeButton(entity.entity_id, null, purgeActionBusy || purgeBusy || !entity.record_count)}${purgeBusy ? `<span class="pending-dot" title="Purging"></span>` : ""}</div></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          `}
        </div>
        `}

      </div>
      ${this._throttleDialogMarkup()}
    `;

    if (filterWasFocused) {
      const newFilter = this.shadowRoot.getElementById("filter");
      if (newFilter) {
        newFilter.focus();
        try {
          newFilter.setSelectionRange(filterSelStart, filterSelEnd);
        } catch (_err) { /* type=search may not support setSelectionRange in all browsers */ }
      }
    }

    this.shadowRoot.getElementById("filter")?.addEventListener("input", (ev) => {
      this._filter = ev.target.value;
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => this._render(), 250);
    });

    this.shadowRoot.getElementById("analyze-db")?.addEventListener("click", () => this._analyzeDb());
    this.shadowRoot.getElementById("purge-all")?.addEventListener("click", () => this._purgeAll());
    this.shadowRoot.getElementById("purge-excluded")?.addEventListener("click", () => this._purgeExcludedEntities());
    this.shadowRoot.getElementById("restart-ha")?.addEventListener("click", () => this._restartHomeAssistant());
    this.shadowRoot.getElementById("remove-unmatched-exclusions")?.addEventListener("click", () => this._removeUnmatchedExclusions());
    this.shadowRoot.querySelectorAll("[data-remove-exclusion]").forEach((button) => button.addEventListener("click", () => this._removeExclusion(button.getAttribute("data-remove-exclusion"))));
    this.shadowRoot.getElementById("purge-keep-days")?.addEventListener("input", (ev) => { this._keepDaysValue = ev.target.value; });
    this.shadowRoot.getElementById("commit-interval")?.addEventListener("input", (ev) => { this._commitIntervalValue = ev.target.value; });
    this.shadowRoot.getElementById("save-global-options")?.addEventListener("click", () => this._saveGlobalOptions());
    this.shadowRoot.getElementById("manual-exclusions")?.addEventListener("input", (ev) => { this._manualExclusionsValue = ev.target.value; });
    this.shadowRoot.getElementById("save-manual-exclusions")?.addEventListener("click", () => this._saveManualExclusions());

    this.shadowRoot.getElementById("devices-select-all")?.addEventListener("click", () => this._setEntitiesBulk(visibleDeviceEntityIds, true, "bulk:devices:select"));
    this.shadowRoot.getElementById("devices-deselect-all")?.addEventListener("click", () => this._setEntitiesBulk(visibleDeviceEntityIds, false, "bulk:devices:deselect"));
    this.shadowRoot.getElementById("orphans-select-all")?.addEventListener("click", () => this._setEntitiesBulk(visibleOrphanEntityIds, true, "bulk:orphans:select"));
    this.shadowRoot.getElementById("orphans-deselect-all")?.addEventListener("click", () => this._setEntitiesBulk(visibleOrphanEntityIds, false, "bulk:orphans:deselect"));

    this.shadowRoot.querySelectorAll("[data-toggle-device]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        const deviceId = ev.currentTarget.getAttribute("data-toggle-device");
        this._toggleExpanded(deviceId);
      });
    });

    this.shadowRoot.querySelectorAll("input[data-kind='entity']").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("change", (ev) => {
        const entityId = ev.currentTarget.getAttribute("data-entity-id");
        const deviceId = ev.currentTarget.getAttribute("data-device-id");
        this._setEntity(entityId, ev.currentTarget.checked, deviceId || null);
      });
    });

    this.shadowRoot.querySelectorAll("input[data-kind='device']").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      if (el.closest(".switch")?.classList.contains("mixed")) el.indeterminate = true;
      el.addEventListener("change", (ev) => {
        const deviceId = ev.currentTarget.getAttribute("data-device-id");
        this._setDevice(deviceId, ev.currentTarget.checked);
      });
    });



    this.shadowRoot.querySelectorAll("input[data-kind='global']").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("change", (ev) => {
        const key = ev.currentTarget.getAttribute("data-entity-id");
        const checked = ev.currentTarget.checked;
        if (key === "auto_purge") {
          this._autoPurgeValue = checked;
          if (!checked) this._autoRepackValue = false;
        }
        if (key === "auto_repack") this._autoRepackValue = checked;
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("input[data-kind='auto-update']").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("change", (ev) => {
        this._setAutoUpdateData(ev.currentTarget.checked);
      });
    });

    this.shadowRoot.querySelectorAll("input[data-kind='repack-toggle']").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("change", (ev) => {
        this._setRepackAfterManualPurge(ev.currentTarget.checked);
      });
    });

    this.shadowRoot.getElementById("migration-import")?.addEventListener("click", () => this._migrationAction("gui_recorder/import_legacy"));
    this.shadowRoot.getElementById("migration-disable")?.addEventListener("click", () => this._migrationAction("gui_recorder/disable_legacy"));
    this.shadowRoot.getElementById("migration-enable")?.addEventListener("click", () => this._migrationAction("gui_recorder/enable_gui"));

    this.shadowRoot.getElementById("gr-menu-button")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });

    this.shadowRoot.querySelectorAll("[data-purge-entity]").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", (ev) => {
        const entityId = ev.currentTarget.getAttribute("data-purge-entity");
        const deviceId = ev.currentTarget.getAttribute("data-device-id");
        this._purgeEntity(entityId, deviceId || null);
      });
    });
    this.shadowRoot.querySelectorAll("[data-throttle-entity]").forEach((el) => {
      el.addEventListener("click", (ev) => this._openThrottleDialog(ev.currentTarget.getAttribute("data-throttle-entity")));
    });
    if (this._throttleDialog) {
      const d = this._throttleDialog;
      const root = this.shadowRoot;
      root.getElementById("throttle-name")?.addEventListener("input", (ev) => { d.name = ev.target.value; });
      root.getElementById("throttle-minutes")?.addEventListener("input", (ev) => { d.minutes = ev.target.value; });
      root.getElementById("throttle-seconds")?.addEventListener("input", (ev) => { d.seconds = ev.target.value; });
      root.getElementById("throttle-exclude")?.addEventListener("change", (ev) => { d.excludeSource = ev.target.checked; this._render(); });
      root.getElementById("throttle-cancel")?.addEventListener("click", () => this._closeThrottleDialog());
      root.getElementById("throttle-create")?.addEventListener("click", () => this._submitThrottle());
      root.getElementById("throttle-backdrop")?.addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) this._closeThrottleDialog(); });
      root.querySelector(".dialog")?.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") this._closeThrottleDialog();
        if (ev.key === "Enter" && ev.target?.tagName === "INPUT" && ev.target.type !== "checkbox") this._submitThrottle();
      });
    }
    this.shadowRoot.querySelectorAll("[data-purge-device]").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const deviceId = ev.currentTarget.getAttribute("data-purge-device");
        this._purgeDevice(deviceId);
      });
    });
  }
}

customElements.define("gui-recorder-panel", GuiRecorderPanel);
