---
name: ha-package
description: Use when creating new HA packages, adding entities to packages, writing automations, or modifying YAML package structure. Triggers on "new package", "add automation", "add entity", "write yaml", "create package".
---

# HA Package Authoring

Write correct YAML packages for this Home Assistant system.

## Package Location

All packages: `D:\Alex\hass\packages/` → deployed to `\\192.168.2.100\config\packages\`

## Critical Rules

1. **Each top-level key appears ONCE per file** (duplicates silently drop entities)
2. **All helpers go in `helpers.yaml`** (input_boolean, input_number, input_select, input_text, input_datetime, input_button, counter, timer)
3. **Validate before deploy**: `py tools/pre_deploy_check.py`

## Package Template

```yaml
# packages/my_feature.yaml
# Dependencies: helpers.yaml (for input_boolean.my_feature_enabled)

automation:
  - id: my_feature_trigger
    alias: "My Feature - Trigger"
    description: "What this does"
    mode: single
    max_exceeded: silent
    trigger:
      - platform: state
        entity_id: input_boolean.my_feature_enabled
        to: "on"
    condition:
      - condition: template
        value_template: >
          {% set start = states('input_datetime.ha_last_start') %}
          {{ start not in ['unknown', 'unavailable'] and
             (as_timestamp(now()) - as_timestamp(start, 0)) > 120 }}
    action:
      - action: persistent_notification.create
        data:
          title: "My Feature"
          message: "Activated"

template:
  - sensor:
      - name: "My Feature Status"
        unique_id: my_feature_status
        state: >
          {{ 'active' if is_state('input_boolean.my_feature_enabled', 'on') else 'inactive' }}
        availability: >
          {{ states('input_boolean.my_feature_enabled') not in ['unknown', 'unavailable'] }}
```

## Safe Jinja2 Patterns

```yaml
# Safe state access (always provide defaults)
{{ states('sensor.x') | int(0) }}
{{ states('sensor.x') | float(0.0) }}
{{ state_attr('sensor.x', 'items') | default([]) }}

# Safe timestamp
{{ as_timestamp(now()) - as_timestamp(states('input_datetime.x'), 0) }}

# Check if entity is usable
{{ states('sensor.x') not in ['unknown', 'unavailable'] }}

# Iterate group members
{% set entities = state_attr('group.my_group', 'entity_id') | default([]) %}
{% for e in entities %}
  {% if states(e) == 'on' %}...{% endif %}
{% endfor %}

# Registry lookup
{% set cams = state_attr('sensor.blue_iris_camera_registry', 'cameras') | default([]) %}
{% set cam = cams | selectattr('name', 'eq', camera_name) | list %}
{% set config = cam[0] if cam | length > 0 else {} %}
```

## Broken Patterns (DO NOT USE)

```yaml
# THESE DO NOT WORK IN HOME ASSISTANT:
{{ items | select('in', name) }}           # BROKEN
{{ cameras | select('has_value') }}        # BROKEN  
{{ cameras | select('is_state', 'off') }}  # BROKEN
```

## Automation Modes

| Mode | Use When |
|------|----------|
| `single` | Most automations (default safety) |
| `restart` | Mode changes, profile switches |
| `queued` | Sequential processing needed |
| `parallel` | Independent per-trigger (rare) |

Always add `max_exceeded: silent` to avoid log spam.

## Startup Gate

Add to any automation that checks entity states at boot:

```yaml
condition:
  - condition: template
    value_template: >
      {% set start = states('input_datetime.ha_last_start') %}
      {{ start not in ['unknown', 'unavailable'] and
         (as_timestamp(now()) - as_timestamp(start, 0)) > 120 }}
```

## Adding Helpers

Always add to `packages/helpers.yaml` under the correct (single) top-level key:

```yaml
# Find the existing section and ADD to it:
input_boolean:
  existing_toggle: ...
  my_new_toggle:           # Add here, under existing key
    name: "My New Toggle"
    icon: mdi:toggle-switch

# NEVER create a second input_boolean: section!
```

## After Creating/Modifying a Package

1. `py tools/pre_deploy_check.py --verbose` (must exit 0)
2. `powershell -File deploy.ps1 -Restart -Force`
3. Verify entities exist in HA
