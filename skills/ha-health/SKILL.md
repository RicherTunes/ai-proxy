---
name: ha-health
description: Use when checking Home Assistant system health, monitoring status, verifying system is working, or after a restart. Triggers on "health check", "is HA working", "system status", "check HA", "smoke test".
---

# HA Health Check

Verify Home Assistant system health via API and deployed packages.

## Quick Commands

| Check | Command |
|-------|---------|
| Full smoke test | `powershell -File tools/e2e_smoke_test.ps1` |
| Config validation | `powershell -File check_config.ps1` |
| System health overview | `powershell -File tools/health_check.ps1` |
| HA reachability | `powershell -File tools/check_ha_status.ps1` |
| Integration status | `powershell -File tools/check_integrations.ps1` |
| Battery levels | `powershell -File tools/check_battery_sensors.ps1` |

## Key Sensors to Monitor

| Sensor | Healthy | Problem |
|--------|---------|---------|
| `sensor.system_stability_score` | 80-100% | <60% = investigate |
| `sensor.ha_uptime_friendly` | Hours/days | Minutes = restart loop |
| `sensor.automation_health` | All "on" | Many "off" = check |
| `sensor.stuck_timers_count` | 0 | >0 = stuck timers |
| `sensor.ha_disk_status` | "normal" | "warning"/"critical" |
| `sensor.notification_system_health` | 80-100% | <60% = notification issue |
| `binary_sensor.coalesce_buffer_valid` | on | off = JSON corruption |
| `counter.camera_alerts_this_hour` | <5 | >=5 = rate limited |

## API Health Check (Manual)

```powershell
. "D:\Alex\hass\lib\Load-Credentials.ps1"
Get-HACredential
$headers = @{ Authorization = "Bearer $global:HA_TOKEN"; "Content-Type" = "application/json" }

# Check API
Invoke-RestMethod -Uri "$global:HA_URL/api/" -Headers $headers

# Check config
Invoke-RestMethod -Uri "$global:HA_URL/api/config/core/check_config" -Method POST -Headers $headers

# Get entity state
Invoke-RestMethod -Uri "$global:HA_URL/api/states/sensor.system_stability_score" -Headers $headers
```

## Triage Order

1. **HA reachable?** `check_ha_status.ps1` - if no, check server
2. **Config valid?** `check_config.ps1` - if no, fix YAML
3. **Integrations healthy?** `check_integrations.ps1` - disable failing ones
4. **Automations loaded?** Look for "restored" state automations
5. **Notifications working?** Check `sensor.notification_status_explanation`
6. **MQTT connected?** Check `binary_sensor.mqtt_transport_connected`
