---
name: ha-deploy
description: Use when deploying Home Assistant packages, restarting HA, or running the deployment pipeline. Triggers on "deploy", "push to HA", "restart HA", "ship it", "send to HA".
---

# HA Deploy

Deploy YAML packages from `D:\Alex\hass` to HA server via SMB.

## Quick Reference

| Command | What it does |
|---------|-------------|
| `powershell -File deploy.ps1` | Full pipeline: pre-check + SMB copy + config validate + smoke test |
| `powershell -File deploy.ps1 -Restart` | Deploy + restart HA (prompts for confirmation) |
| `powershell -File deploy.ps1 -Restart -Force` | Deploy + restart (no prompt) |
| `powershell -File deploy.ps1 -SkipPreCheck` | Skip pre-deploy YAML validation |
| `powershell -File deploy.ps1 -SkipSmokeTest` | Skip post-deploy health check |

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Done (may have warnings) |
| 1 | Pre-deploy validation failed | Fix YAML errors first |
| 2 | SMB copy failed | Check `.env` credentials, network |
| 3 | HA restart timed out | Check HA logs, may need manual restart |
| 4 | Smoke test failures | Check `tools/e2e_smoke_test.ps1` output |

## Workflow

1. **Always validate first**: `py tools/pre_deploy_check.py --verbose`
2. **Deploy**: `powershell -File deploy.ps1`
3. **If changes need restart**: `powershell -File deploy.ps1 -Restart -Force`
4. **Verify**: Smoke test runs automatically; check output for FAIL items

## When Restart is Required

- New entities (input_boolean, counter, timer, etc.)
- New automations
- Changed template sensors
- Modified `configuration.yaml` includes

**No restart needed for:** Automation condition/action changes only (use reload).

## Reload Without Restart

```powershell
powershell -File tools/reload_automations.ps1
```

## Common Failures

| Symptom | Fix |
|---------|-----|
| "SMB connection failed" | Check `.env` has correct HOMEASSISTANT_SMB_PASSWORD |
| "Pre-check found errors" | Run `py tools/pre_deploy_check.py --verbose` and fix |
| "Config check failed" | Duplicate YAML keys or bad Jinja2 — check output |
| "Smoke test: restored automations" | Package has duplicate keys — entities silently dropped |
