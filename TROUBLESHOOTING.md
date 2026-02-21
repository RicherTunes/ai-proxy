# Troubleshooting Guide

Having problems? This guide covers the most common issues and how to fix them.

## Quick Diagnostics

Before diving into specific problems, run these quick checks:

1. **Is the AI Proxy running?** Look for output in your terminal
2. **Can you access the dashboard?** Go to http://127.0.0.1:18765/dashboard
3. **Are your keys valid?** Check the Keys tab in the dashboard

## Installation Problems

### "npm install" fails

**Symptoms:** Error messages during installation, missing modules

**Solutions:**
1. Make sure Node.js 18+ is installed: `node --version`
2. Clear npm cache: `npm cache clean --force`
3. Delete `node_modules` folder and try again:
   ```bash
   # Mac/Linux
   rm -rf node_modules
   npm install
   ```
4. Check your internet connection

### "Cannot find module" error

**Symptoms:** Error when running `npm start`

**Solutions:**
1. You skipped installation. Run: `npm install`
2. Installation was incomplete. Delete `node_modules` and reinstall

### JSON parse errors

**Symptoms:** "Unexpected token" or "JSON parse error" when starting

**Solutions:**
1. Check `api-keys.json` for syntax errors
2. Make sure you're using double quotes `"` not single quotes `'`
3. Ensure no trailing commas (comma after the last item)
4. Use a JSON validator like [jsonlint.com](https://jsonlint.com/)

**Common JSON mistakes:**
```json
// ❌ WRONG - trailing comma
{
  "keys": [
    "key1.secret1",
  ]
}

// ✅ CORRECT
{
  "keys": [
    "key1.secret1"
  ]
}
```

## Startup Problems

### Proxy won't start

**Symptoms:** Nothing happens or immediate crash

**Check these:**
1. Is port 18765 already in use?
   ```bash
   # Mac/Linux
   lsof -i :18765
   ```

   ```bash
   # Windows
   netstat -ano | findstr :18765
   ```
2. Does `api-keys.json` exist in the project folder?
3. Does the JSON file have at least one key?

### "EADDRINUSE" error

**Symptoms:** "address already in use" error

**Meaning:** Something else is using port 18765

**Solutions:**
1. Stop the other program using that port
2. Or use a different port:
   ```bash
   # Mac/Linux
   GLM_PORT=8080 npm start
   ```

   ```powershell
   # Windows PowerShell
   $env:GLM_PORT="8080"; npm start
   ```

   ```cmd
   # Windows Command Prompt
   set GLM_PORT=8080 && npm start
   ```

## API Key Problems

### "All keys are unhealthy"

**Symptoms:** Dashboard shows all keys as unhealthy, requests fail

**Description:** The AI Proxy tried your keys multiple times and they all failed

**Solutions:**
1. **Check if keys are valid** — Log into Z.AI and verify keys exist
2. **Check if keys are expired** — Some keys have expiration dates
3. **Check your account status** — Make sure your account is active
4. **Wait and retry** — Keys might be temporarily rate-limited (wait 60 seconds)
5. **Reload keys** after fixing:
   ```bash
   # Mac/Linux
   curl -X POST http://127.0.0.1:18765/reload
   ```

   ```powershell
   # Windows PowerShell
   Invoke-WebRequest -Uri http://127.0.0.1:18765/reload -Method POST
   ```

### Keys show as "OPEN" in dashboard

**Symptoms:** Circuit breaker state shows "OPEN"

**Description:** That specific key failed too many times and was disabled temporarily

**Solutions:**
1. Wait 60 seconds for the cooldown period
2. The key will automatically try again (state changes to "HALF_OPEN")
3. If it works, state returns to "CLOSED"
4. If it fails again, state goes back to "OPEN"

### Invalid API key error

**Symptoms:** "Invalid API key" or authentication errors

**Solutions:**
1. Double-check the key format — should be `keyId.secret`
2. Make sure there are no extra spaces or line breaks
3. Verify the key works directly (without the proxy)

## Request Problems

### "Rate limit exceeded"

**Symptoms:** Getting 429 errors

**Description:** You're sending requests faster than your API keys allow

**Solutions:**
1. **Add more API keys** — More keys = higher total rate limit
2. **Slow down your requests** — Reduce how often you call the API
3. **Check if it's account-level** — Sometimes the limit is on your whole account, not per key

### Requests timing out

**Symptoms:** "Timeout" or "ETIMEDOUT" errors

**Solutions:**
1. Check your internet connection
2. The upstream API might be slow — wait and retry
3. Increase timeout (advanced):
   ```bash
   # Mac/Linux
   GLM_REQUEST_TIMEOUT=600000 npm start
   ```

   ```powershell
   # Windows PowerShell
   $env:GLM_REQUEST_TIMEOUT="600000"; npm start
   ```

   ```cmd
   # Windows Command Prompt
   set GLM_REQUEST_TIMEOUT=600000 && npm start
   ```

### "Connection refused"

**Symptoms:** Can't connect to the proxy

**Solutions:**
1. Make sure the proxy is running
2. Check you're using the correct URL: `http://127.0.0.1:18765`
3. Try `localhost` instead of `127.0.0.1` (or vice versa)

## Dashboard Problems

### Dashboard not loading

**Symptoms:** Blank page or "can't connect"

**Solutions:**
1. Make sure the proxy is running (check terminal output)
2. Go to: http://127.0.0.1:18765/dashboard
3. Try a different browser
4. Check if browser is blocking the connection

### Dashboard shows zeros everywhere

**Symptoms:** All metrics show "0"

**This is normal if:**
- You just started (no requests yet)
- No requests have been sent through the proxy

**If you've sent requests:**
- Check the Keys tab — are your keys healthy?
- Check the terminal for error messages

### Diagnostics tab shows "Auth Required"

**Symptoms:** Diagnostics tab shows authentication message

**Description:** You have admin authentication enabled but aren't logged in

**Solutions:**
1. Log in to the admin panel (if you set up admin auth)
2. Or disable admin auth if you don't need it (local network only)

## Getting More Help

### Enable Debug Logging

See exactly what's happening:

```bash
# Mac/Linux
GLM_LOG_LEVEL=DEBUG npm start

# Windows PowerShell
$env:GLM_LOG_LEVEL="DEBUG"; npm start

# Windows Command Prompt
set GLM_LOG_LEVEL=DEBUG && npm start
```

This shows detailed logs that help identify problems.

### Check the Health Endpoint

```bash
curl http://127.0.0.1:18765/health
```

This tells you:
- If the AI Proxy is running
- How many keys are healthy
- Overall system status

### Still Stuck?

1. **Search existing issues:** [GitHub Issues](https://github.com/RicherTunes/ai-proxy/issues)
2. **Open a new issue** with:
   - What you were trying to do
   - What happened (error messages)
   - Your setup (Node.js version, OS)
   - Relevant log output (use `GLM_LOG_LEVEL=DEBUG`)
