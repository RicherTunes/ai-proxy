---
name: ha-validate
description: Use when validating YAML packages before deployment, checking for syntax errors, duplicate keys, or broken entity references. Triggers on "validate", "check yaml", "pre-deploy check", "syntax check".
---

# HA Validate

Pre-deployment YAML validation to catch errors before they reach HA.

## Commands

| Command | Scope |
|---------|-------|
| `py tools/pre_deploy_check.py` | Full validation (recommended) |
| `py tools/pre_deploy_check.py --verbose` | Detailed output |
| `py tools/pre_deploy_check.py --packages-only` | Only packages/ |
| `py tools/validate_syntax.py` | Syntax-only (no cross-refs) |

## What pre_deploy_check.py Catches

- YAML syntax errors (bad indentation, unclosed quotes)
- Duplicate top-level keys in a package (silent data loss!)
- Duplicate automation IDs across files
- Orphaned entity references (entity_id not defined anywhere)
- Missing required helpers (home_mode, notification toggles)
- Deprecated automation patterns

## Critical Rule: No Duplicate Top-Level Keys

Each YAML key must appear **exactly once** per package file.

```yaml
# BAD - second input_datetime silently overwrites first!
input_datetime:
  entity_one:
    name: "First"
automation:
  - id: auto_one
input_datetime:        # DUPLICATE - breaks package!
  entity_two:
    name: "Second"

# GOOD - all entities under single key
input_datetime:
  entity_one:
    name: "First"
  entity_two:
    name: "Second"
automation:
  - id: auto_one
```

## Quick Duplicate Check

```bash
grep -n "^[a-z_]*:" packages/your_package.yaml
# Each key should appear only once
```

## Common Jinja2 Errors

| Error | Fix |
|-------|-----|
| `select('in', name)` | Use `for` loop with `if x in name` |
| `select('has_value')` | Use `if states(x) not in ['unknown', 'unavailable']` |
| `select('is_state', 'off')` | Use `for` loop with `if states(x) == 'off'` |
| Missing `\| default([])` | Always default `state_attr()` calls |
| `as_timestamp()` without fallback | Use `as_timestamp(x, 0)` |

## Validation Workflow

1. Edit package YAML
2. Run `py tools/pre_deploy_check.py --verbose`
3. Fix any errors (exit code 1 = errors found)
4. Re-run until exit code 0
5. Then deploy with `deploy.ps1`
