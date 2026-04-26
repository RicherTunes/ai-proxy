---
name: ha-entity-audit
description: Use when auditing entities, finding orphaned references, checking for duplicates, cleaning up unused entities, or verifying entity health. Triggers on "audit entities", "find orphans", "unused entities", "entity cleanup", "check duplicates".
---

# HA Entity Audit

Find orphaned, duplicate, or unhealthy entities across packages.

## Audit Commands

| Check | Command |
|-------|---------|
| Cross-reference audit | `py tools/audit_entity_references.py` |
| Duplicate entity IDs | `py tools/check_duplicates.py` |
| Full inventory | `py tools/ha_inventory.py --out-md archive/ha_inventory.md` |
| Unavailable entities | `powershell -File tools/list_unknown_unavailable.ps1` |
| Restored automations | `powershell -File tools/check_restored_automations.ps1` |
| Orphaned helpers | `powershell -File tools/cleanup_orphans.ps1` |
| Unassigned devices | `py tools/check_unassigned.py` |
| Label audit | `py tools/check_labels.py` |

## Common Audit Workflow

```bash
# 1. Check for duplicates
py tools/check_duplicates.py

# 2. Cross-reference entities (are references valid?)
py tools/audit_entity_references.py --include packages

# 3. Find unavailable/unknown entities
powershell -File tools/list_unknown_unavailable.ps1

# 4. Check for restored automations (indicates package load failure)
powershell -File tools/check_restored_automations.ps1

# 5. Full inventory export
py tools/ha_inventory.py --no-ws --battery-threshold 20
```

## What to Look For

| Finding | Severity | Action |
|---------|----------|--------|
| Duplicate automation IDs | High | Remove one copy |
| Duplicate top-level YAML keys | Critical | Merge under single key |
| Entity referenced but not defined | Medium | Add to helpers.yaml or remove reference |
| Entity defined but never referenced | Low | Consider removing (check dashboards first) |
| Restored automations | High | Fix package YAML, redeploy |
| Unavailable entities | Varies | Physical = check device; package = check YAML |

## Cleanup Commands

```powershell
# Delete orphaned entities via API (careful!)
powershell -File tools/delete_orphaned_entities.ps1

# Archive disabled automations
py tools/_archive_automations.py

# Remove automations by YAML ID
py tools/prune_package_automations.py --ids list.txt --dry-run
```

## Entity Naming Check

Verify entities follow conventions:

| Type | Pattern |
|------|---------|
| `input_boolean` | `input_boolean.<feature>` |
| `input_number` | `input_number.<setting>` |
| `counter` | `counter.<what>_<period>` |
| `timer` | `timer.<purpose>` |
| `binary_sensor` | `binary_sensor.<thing>_<state>` |
| `sensor` | `sensor.<descriptive_name>` |
