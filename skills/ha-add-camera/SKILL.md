---
name: ha-add-camera
description: Use when adding a new camera to Blue Iris integration, modifying camera registry, or updating camera configuration. Triggers on "add camera", "new camera", "camera registry", "camera config".
---

# HA Add Camera

Add or modify cameras in the Blue Iris camera registry system.

## Camera Registry Architecture

Single source of truth: `packages/blueiris_registry.yaml` → `sensor.blue_iris_camera_registry`

All automations reference the registry dynamically - adding a camera here propagates everywhere.

## Steps to Add a Camera

### 1. Edit Registry (`packages/blueiris_registry.yaml`)

Add to `input_select.blueiris_cameras` options:
```yaml
input_select:
  blueiris_cameras:
    options:
      - FrontDoor
      - DoorBell
      - NewCamera    # Add here
```

Add camera config to `sensor.blue_iris_camera_registry` attributes:
```yaml
attributes:
  cameras: >
    {{
      [
        ... existing cameras ...,
        {
          "name": "NewCamera",
          "friendly_name": "New Camera",
          "location": "outdoor",
          "priority": "medium",
          "cooldown_seconds": 120,
          "icon": "mdi:cctv",
          "tts_enabled": false,
          "privacy_pausable": false,
          "ha_camera_entity": "camera.camserver_newcamera"
        }
      ]
    }}
```

Add to appropriate derived lists:
```yaml
outdoor_cameras: >    # or indoor_cameras
  {{ ['FrontDoor', ..., 'NewCamera'] }}
```

### 2. Add Per-Camera Helpers (`packages/helpers.yaml`)

```yaml
input_datetime:
  last_notify_newcamera:
    name: "Last Notification - New Camera"
    has_date: true
    has_time: true
  snooze_until_newcamera:
    name: "Snooze Until - New Camera"
    has_date: true
    has_time: true

counter:
  newcamera_detections:
    name: "New Camera Detections"
    initial: 0
    step: 1

timer:
  snooze_until_newcamera:
    name: "Snooze - New Camera"
    duration: "02:00:00"
    restore: true
```

### 3. Add MQTT Sensor (`mqtt_sensors.yaml`)

```yaml
- name: "Blue Iris NewCamera Alert Info"
  unique_id: blue_iris_newcamera_alert_info
  state_topic: "BlueIris/NewCamera/alert"
  value_template: "{{ value_json.object | default('unknown') }}"
  json_attributes_topic: "BlueIris/NewCamera/alert"
  expire_after: 300
```

### 4. Add to Monitoring Group (`packages/system_monitoring.yaml`)

```yaml
group:
  monitored_cameras_connectivity:
    entities:
      - binary_sensor.camserver_newcamera   # Add
  monitored_mqtt_event_sensors:
    entities:
      - sensor.blue_iris_newcamera_alert_info  # Add
```

### 5. Configure Blue Iris (UI)

In Blue Iris UI for the new camera:
- Camera Properties > Alerts > "Post to a web address or MQTT server"
- Topic: `BlueIris/NewCamera/alert`
- Payload: `{"id":"&ALERT","object":"&MEMO","camera":"&CAM"}`

### 6. Validate & Deploy

```powershell
py tools/pre_deploy_check.py --verbose
powershell -File deploy.ps1 -Restart -Force
```

## Camera Config Fields

| Field | Values | Required |
|-------|--------|----------|
| `name` | Short name (no spaces) | Yes |
| `friendly_name` | Display name | Yes |
| `location` | `outdoor` or `indoor` | Yes |
| `priority` | `high`, `medium`, `low` | Yes |
| `cooldown_seconds` | 60-300 | Yes |
| `icon` | `mdi:*` icon | Yes |
| `tts_enabled` | true/false | Yes |
| `privacy_pausable` | true/false (indoor only) | Yes |
| `ha_camera_entity` | `camera.camserver_*` | Yes |

## Existing Cameras

FrontDoor, DoorBell, FrontHouse, OutdoorSide, BackShed, OutBack, Kitchen, LivingRoom, AdamsRoom, FRB
