# Troubleshooting

## Common Issues

### "All keys are unhealthy"

The circuit breaker has opened due to repeated failures.

**Solutions:**

1. Check if API keys are valid
2. Verify target API is reachable (`api.z.ai`)
3. Wait for cooldown period (default 60s)
4. Use `POST /reload` to reload keys after fixing

### "Rate limit exceeded"

The proxy is hitting per-key rate limits.

**Solutions:**

1. Add more API keys to `api-keys.json`
2. Increase `rateLimitPerMinute` in config
3. Check if account-level limit is hit (not per-key)

### Dashboard not loading

The dashboard HTML/CSS/JS fails to generate.

**Solutions:**

1. Check browser console for errors
2. Verify port 18765 is accessible
3. Try `http://127.0.0.1:18765/dashboard` (not localhost on some systems)
4. Check logLevel: DEBUG for generation errors

### Diagnostics tab shows all zeros

The Diagnostics tab displays zeros for all metrics (memory, process health, scheduler).

**Cause:** The `/health/deep` endpoint requires admin authentication but the dashboard doesn't send auth tokens.

**Solutions:**

1. Log in to the admin panel first (if admin auth is enabled)
2. Check browser console for 401 errors from `/health/deep`
3. Verify `/stats/scheduler` endpoint is accessible
4. If you don't need auth, remove `/health/deep` from `debugEndpoints` in config

**Quick fix:** Set `adminAuth.enabled: false` in config or add `/health/deep` to allowed unauthenticated routes.

### Model routing not working

Requests not being routed to expected models.

**Solutions:**

1. Check `modelRouting.enabled: true` in config
2. Verify rules match your model patterns
3. Check `/model-routing` endpoint for current state
4. Review decision logs with `logDecisions: true`

### High memory usage

Memory grows over time.

**Solutions:**

1. Check statsSaveInterval (default 60s)
2. Verify histogram.maxDataPoints (default 10000)
3. Reduce maxTotalConcurrency if needed
4. Check for memory leaks with `npm run test:stress`

### 429 errors from upstream

Getting 429s despite having multiple keys.

**Solutions:**

1. Check if it's account-level (not per-key) with `accountLevelDetection.enabled`
2. Enable `adaptiveConcurrency` in `enforce` mode
3. Reduce concurrency per model
4. Check `poolCooldown` settings

## Getting Logs

Enable debug logging:

```bash
LOG_LEVEL=DEBUG npm start
```

Check specific log files:

- Application logs: stdout/stderr
- PM2 logs: `pm2 logs glm-proxy`
- Journalctl (systemd): `journalctl -u ai-proxy`

## Still Having Issues?

1. Check `/health` endpoint for system status
2. Check `/stats` for key health and metrics
3. Enable `LOG_LEVEL=DEBUG` and reproduce
4. Open a GitHub issue with logs and details
