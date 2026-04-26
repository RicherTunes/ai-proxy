---
name: ha-diagnose
description: Use when troubleshooting Home Assistant issues - entities unavailable, automations not firing, notifications not sending, MQTT problems, camera offline, integration errors. Triggers on "why isn't", "not working", "broken", "debug HA", "troubleshoot".
---

# HA Diagnose

Systematic troubleshooting for this Home Assistant + Blue Iris system.

## Diagnostic Tools

| Issue Area | Tool |
|-----------|------|
| General health | `powershell -File tools/e2e_smoke_test.ps1` |
| Error logs | `powershell -File tools/get_error_log.ps1` |
| MQTT | `powershell -File tools/bi_mqtt_full_diagnostic.ps1` |
| Notifications | `powershell -File tools/diagnose_notifications.ps1` |
| Integrations | `powershell -File tools/check_integrations.ps1` |
| Crash analysis | `powershell -File tools/analyze_crash.ps1` |
| Performance | `powershell -File tools/detailed_perf_check.ps1` |
| Entity audit | `py tools/audit_entity_references.py` |

## Decision Tree

### Entity shows "unavailable"

1. **Is it a package entity?** Check if defined in `packages/*.yaml`
   - Yes: Check for duplicate top-level keys → `grep -n "^[a-z_]*:" packages/THE_FILE.yaml`
   - No: Check integration status → `check_integrations.ps1`
2. **Does it have `restored: true`?** Package failed to load
   - Fix: Check for YAML errors, redeploy, restart HA
3. **Is it a physical device?** Check network/battery

### Notifications not sending

Check `sensor.notification_status_explanation` first - it tells you why.

| Suppression Source | Entity to Check |
|-------------------|-----------------|
| Global toggle off | `input_boolean.camera_notifications` |
| Snoozed | `input_boolean.snooze_all_cameras` |
| BI restarting | `input_boolean.blueiris_restarting` |
| MQTT reconnecting | `input_boolean.mqtt_reconnecting` |
| Privacy mode | `input_boolean.privacy_mode` |
| Rate limited | `binary_sensor.camera_alerts_rate_limited` |
| DND mode | `input_select.home_mode` = "Do Not Disturb" |
| Circuit breaker | `input_boolean.notifications_circuit_breaker` |

### MQTT sensors unavailable

**Root cause is usually Blue Iris MQTT configuration.**

1. Check BI MQTT config: `tools/bi_mqtt_full_diagnostic.ps1`
2. HA expects topic: `BlueIris/CameraName/alert`
3. BI may be publishing to: `blue_iris/binary_sensor/*/state` (wrong)
4. Fix requires Blue Iris UI changes - see `docs/BLUEIRIS_MQTT_FIX.md`

### Automation not firing

1. **Is it enabled?** Check `states.automation.THE_AUTOMATION` - state should be "on"
2. **Startup gate?** Many automations wait 2-10 minutes after HA start
3. **Conditions blocking?** Test template in Developer Tools > Template
4. **Trigger not matching?** Check entity state changes in logbook
5. **Cooldown active?** Check relevant `input_datetime.last_*` or `timer.*`

### Integration in error/retry

```powershell
powershell -File tools/check_integrations.ps1
# Shows setup_error and setup_retry integrations
# Consider: powershell -File tools/disable_failing_integrations.ps1 -WhatIf
```

## Log Analysis

```powershell
# Recent errors
powershell -File tools/get_error_log.ps1

# Crash patterns
powershell -File tools/analyze_crash.ps1

# Root cause
powershell -File tools/root_cause_analysis.ps1
```
