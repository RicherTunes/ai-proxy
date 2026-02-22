---
layout: default
title: Z.ai GLM Coding Plan - Complete Reference
---

# Z.ai GLM Coding Plan - Complete Reference

> **Last Updated:** February 21, 2026
> **Provider:** Zhipu AI (Z.ai / BigModel.cn)
> **Documentation Sources:** [z.ai](https://z.ai) | [docs.z.ai](https://docs.z.ai) | [open.bigmodel.cn](https://open.bigmodel.cn)

> **Looking for more details?** See the [Z.ai Knowledge Base](./zai-knowledge-base/) for comprehensive documentation including model specs, integrations, known issues, and historical changes.

---

## Quick Summary

Z.ai's GLM Coding Plan is a subscription-based AI coding service marketed as **"1/7 the cost of Claude, 3x the usage"**. It uses Zhipu AI's GLM models (GLM-4.7, GLM-5) and is compatible with major coding tools like Claude Code, Cursor, Cline, and Roo Code.

| Feature | Value |
|---------|-------|
| **Models** | GLM-4.7 (358B params), GLM-5 (754B params) |
| **Context Window** | 128K - 200K tokens |
| **Pricing Range** | $10 - $80/month (International) |
| **Quota System** | 5-hour rolling window (prompts) |
| **API Compatibility** | OpenAI + Anthropic compatible |

---

## Table of Contents

1. [Subscription Tiers & Pricing](#subscription-tiers--pricing)
2. [Usage Limits & Quotas](#usage-limits--quotas)
3. [Model Access by Tier](#model-access-by-tier)
4. [API Endpoints & Authentication](#api-endpoints--authentication)
5. [Concurrency & Rate Limits](#concurrency--rate-limits)
6. [MCP Tool Limits](#mcp-tool-limits)
7. [Integration with Coding Tools](#integration-with-coding-tools)
8. [Recent Changes (2026)](#recent-changes-2026)
9. [Comparison with Competitors](#comparison-with-competitors)
10. [Troubleshooting & Known Issues](#troubleshooting--known-issues)

---

## Subscription Tiers & Pricing

### International Pricing (USD) - Post February 12, 2026

| Plan | Monthly | Quarterly | Yearly |
|------|---------|-----------|--------|
| **Lite** | $10/month | $27/quarter | $84/year |
| **Pro** | $30/month | $81/quarter | $252/year |
| **Max** | $80/month | $216/quarter | $672/year |

### China Pricing (CNY) - Post February 12, 2026

| Plan | Monthly | Quarterly | Yearly |
|------|---------|-----------|--------|
| **Lite** | ¥49/month | ¥132/quarter | ¥411/year |
| **Pro** | ¥149/month | ¥402/quarter | ¥1,251/year |
| **Max** | ¥469/month | ¥1,266/quarter | ¥3,939/year |

### Price Increase Notice

> **Effective February 12, 2026:** Z.ai increased prices by **30%+** and cancelled first-purchase discounts. Existing subscribers maintain their original pricing (grandfathered in).

---

## Usage Limits & Quotas

### 5-Hour Rolling Window Limits

The core quota system is based on a **5-hour rolling window**, not fixed reset times. Quota dynamically recovers as requests age out of the 5-hour window.

| Plan | Prompts per 5 Hours | Weekly (Estimated) | Monthly (Estimated) |
|------|---------------------|-------------------|---------------------|
| **Lite** | ~120 prompts | ~9,000 prompts | ~18,000 prompts |
| **Pro** | ~600 prompts | ~45,000 prompts | ~90,000 prompts |
| **Max** | ~2,400 prompts | ~180,000 prompts | ~360,000 prompts |

### Important Notes

- **One prompt ≠ One API call**: Each user prompt triggers approximately **15-20 model calls** in the backend for complex coding tasks
- **Rolling window**: Quota used 5+ hours ago automatically releases
- **No hard weekly/monthly caps**: Unlike some competitors, Z.ai focuses on the 5-hour window without additional hard caps
- **GLM-5 consumes more**: Using GLM-5 uses significantly more quota than GLM-4.7

### MCP Tool Quotas (Monthly)

| Plan | MCP Tool Allowance |
|------|-------------------|
| **Lite** | 100 calls/month |
| **Pro** | 1,000 calls/month |
| **Max** | 4,000 calls/month |

---

## Model Access by Tier

### Model Specifications

| Model | Parameters | Context | SWE Score | Availability |
|-------|-----------|---------|-----------|--------------|
| **GLM-4.7** | 358B | 128K - 200K | 0.68 | All tiers |
| **GLM-4.6** | ~300B | 128K - 200K | 0.68 | All tiers |
| **GLM-4.5** | ~250B | 128K | 0.65 | All tiers |
| **GLM-4.5-Air** | ~200B | 128K | 0.62 | All tiers |
| **GLM-5** | 754B | TBD | ~0.75+ | Pro, Max only |
| **GLM-5-Code** | 754B | TBD | ~0.78 | Pro, Max only |

### Tier Model Access

| Feature | Lite | Pro | Max |
|---------|------|-----|-----|
| **GLM-4.7** | ✓ | ✓ | ✓ |
| **GLM-4.6** | ✓ | ✓ | ✓ |
| **GLM-4.5** | ✓ | ✓ | ✓ |
| **GLM-4.5-Air** | ✓ | ✓ | ✓ |
| **GLM-5** | ✗ (planned) | ✓ | ✓ |
| **GLM-5-Code** | ✗ | ✓ | ✓ |
| **Early Access** | ✗ | ✗ | ✓ |

### GLM-5 Details

- **Parameters**: 754B (more than 2x GLM-4.7)
- **Performance**: Approaching Claude Opus 4.5 level
- **Token Consumption**: Significantly higher than GLM-4.7
- **Launch Timeline**: Pro/Max get immediate access; Lite support "coming later"

---

## API Endpoints & Authentication

### Base URLs

| Platform | Base URL |
|----------|----------|
| **Z.ai International** | `https://api.z.ai/api/paas/v4/` |
| **BigModel China** | `https://open.bigmodel.cn/api/paas/v4/` |
| **Anthropic Compatible** | `https://open.bigmodel.cn/api/anthropic` |

### Coding Plan Specific Endpoint

Coding Plan subscribers must use a different endpoint than standard API users:

```
/api/coding/paas/v4
```

### Authentication Methods

#### Bearer Token (Direct API Key)

```bash
curl -X POST "https://api.z.ai/api/paas/v4/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4.7-flash",
    "messages": [
      {"role": "user", "content": "Write a Python function to parse CSV files"}
    ],
    "max_tokens": 4096
  }'
```

#### Environment Variables for Claude Code

**macOS/Linux:**

```bash
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="YOUR_ZAI_API_KEY"
```

**Windows PowerShell:**

```powershell
$env:ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic"
$env:ANTHROPIC_API_KEY = "YOUR_ZAI_API_KEY"
```

**Windows CMD:**

```cmd
set ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
set ANTHROPIC_API_KEY=YOUR_ZAI_API_KEY
```

### Python SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-zai-api-key",
    base_url="https://api.z.ai/api/paas/v4/",
)

completion = client.chat.completions.create(
    model="glm-4.7-flash",
    messages=[{"role": "user", "content": "Hello, write code"}],
)
```

### Key Management

- **International API Keys**: [z.ai/manage-apikey/apikey-list](https://z.ai/manage-apikey/apikey-list)
- **Subscription Management**: [z.ai/manage-apikey/subscription](https://z.ai/manage-apikey/subscription)
- **China Platform**: [open.bigmodel.cn](https://open.bigmodel.cn)

---

## Concurrency & Rate Limits

### Official Documentation Status

> **Important:** Zhipu AI does **NOT** publicly document specific TPM (Tokens Per Minute) or RPM (Requests Per Minute) rate limits for GLM Coding Plan subscriptions. Their documentation focuses on "prompts per 5 hours" rather than per-minute limits.

### Known Concurrency Limits

| Source | Limit | Notes |
|--------|-------|-------|
| **GLM-4.7-Flash Free** | 1 concurrent request | Free tier limitation |
| **Standard API** | ~10 QPS | For GLM-4.7 on direct API |
| **Coding Plan** | Undocumented | Varies by tier, not publicly specified |

### Peak Hour Restrictions

**Known Issues (as of January 2026):**

- **Peak Hours**: Weekdays 15:00-18:00 (3-6 PM)
- **Symptoms**: Concurrent rate limiting errors, slower response times
- **Root Cause**: "Computing resource phase tension" due to high demand

### Official Capacity Measures

Since January 23, 2026:

- Daily sales limited to **20% of capacity**
- Daily quota refreshes at **10:00**
- Auto-renewal subscribers unaffected
- Active crackdown on malicious traffic and violations

### Tier Concurrency Differences

| Tier | Concurrency |
|------|-------------|
| **Lite** | Standard (may lag during peak) |
| **Pro** | Enhanced (40-60% faster generation) |
| **Max** | Ultra-high, no lag guaranteed |

### Recommended Usage Strategy

1. **Avoid peak hours** when possible (15:00-18:00 weekdays)
2. **Use Max tier** for production/high-concurrency needs
3. **Enable auto-renewal** for more stable resource allocation
4. **Monitor usage** with quota tracking tools like [opencode-glm-quota](https://github.com/guyinwonder168/opencode-glm-quota)

---

## MCP Tool Limits

### MCP Tools Available

- **Image Analysis** (`vision`)
- **Web Search** (`web_search`)
- **Web Reader** (`web_reader`)
- **Open Source Repository MCP**

### Monthly MCP Quotas

| Plan | Monthly MCP Calls |
|------|-------------------|
| **Lite** | 100 calls/month |
| **Pro** | 1,000 calls/month |
| **Max** | 4,000 calls/month |

### MCP Usage Tracking

The 24-hour rolling window tracks:

- Model usage (prompts)
- MCP tool usage (web_search, web_reader, vision)

Use the [opencode-glm-quota](https://github.com/guyinwonder168/opencode-glm-quota) tool for real-time monitoring.

---

## Integration with Coding Tools

### Supported Tools

Z.ai GLM Coding Plan is compatible with **10+ mainstream coding tools**:

| Tool | Integration Method |
|------|-------------------|
| **Claude Code** | Anthropic-compatible API |
| **Cursor** | OpenAI-compatible API |
| **Cline** | OpenAI-compatible API |
| **Roo Code** | OpenAI-compatible API |
| **OpenCode** | Native support |
| **Codex CLI** | Custom integration |
| **Kilo Code** | Custom integration |

### Claude Code Integration

**Step 1: Set Environment Variables**

```bash
# For Anthropic-compatible endpoint
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="your-zai-coding-plan-api-key"
```

**Step 2: Configure Model**

In Claude Code settings or `.claude/settings.json`:

```json
{
  "provider": "anthropic",
  "model": "glm-4.7"
}
```

### Cursor Integration

**Settings → API Providers → Custom:**

```json
{
  "baseURL": "https://api.z.ai/api/paas/v4/",
  "apiKey": "your-api-key",
  "model": "glm-4.7"
}
```

### Cline (VS Code Extension)

**Settings JSON:**

```json
{
  "cline.apiUrl": "https://api.z.ai/api/paas/v4/",
  "cline.apiKey": "your-api-key",
  "cline.model": "glm-4.7"
}
```

---

## Recent Changes (2026)

### February 12, 2026 - Price Increase

| Change | Detail |
|--------|--------|
| **Price Increase** | 30%+ across all tiers |
| **First-Purchase Discount** | Cancelled |
| **Quarterly/Annual Discounts** | Retained |
| **Existing Subscribers** | Grandfathered at original pricing |

### GLM-5 Launch

| Feature | Availability |
|---------|--------------|
| **Pro/Max Tiers** | Immediate access |
| **Lite Tier** | "Coming later" (no date specified) |
| **Parameters** | 754B (vs GLM-4.7's 358B) |
| **Performance** | Approaches Claude Opus 4.5 |
| **Token Cost** | Significantly higher consumption |

### Capacity Constraints

Since January 2026:

- **2.7 million paid users** (as of December 2025)
- Daily sales limited to 20% of capacity
- Peak hour rate limiting (15:00-18:00 weekdays)
- Aggressive expansion of computing infrastructure underway

---

## Comparison with Competitors

### Value Proposition

| Metric | Z.ai GLM Pro | Claude Pro | Ratio |
|--------|-------------|------------|-------|
| **Price** | $30/month | $20/month | 1.5x |
| **5-Hour Quota** | ~600 prompts | ~40 prompts | 15x |
| **Value** | $0.05/prompt | $0.50/prompt | **10x better** |

### Market Positioning

Z.ai claims **"21x better value than Claude"**:

- 1/7 of Claude's price (at equivalent usage)
- 3x the usage quota
- Comparable model performance (GLM-4.7 ≈ Claude Sonnet 4)

### Chinese Market Alternatives

| Provider | Lite | Pro | Max |
|----------|------|-----|-----|
| **Zhipu GLM** | ¥49/m | ¥149/m | ¥469/m |
| **Alibaba Qwen** | ¥40/m | ¥200/m | N/A |
| **Moore Threads** | ¥120/q | ¥600/q | ¥1200/q |
| **Volcano Ark** | ¥9.9/m* | ¥49.9/m* | N/A |

*First-month promotional pricing

---

## Troubleshooting & Known Issues

### Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| **并发限流** | Too many concurrent requests | Reduce concurrency, wait for off-peak |
| **Quota exceeded** | 5-hour window limit reached | Wait for quota to recover (5-hour rolling) |
| **API key invalid** | Wrong endpoint or key | Verify key matches platform (z.ai vs bigmodel.cn) |

### Known Issues

#### 1. Undocumented Concurrency Limit (GitHub Issue)

- **Issue**: GLM 4.7 appears to only allow **1 concurrent in-flight request**, even on paid tiers
- **Status**: Unconfirmed officially, reported by users
- **Workaround**: Implement queue-based request handling

#### 2. Peak Hour Slowdowns

- **Issue**: 15:00-18:00 weekdays experience significant slowdowns
- **Status**: Officially acknowledged
- **Workaround**: Schedule heavy work for off-peak hours or upgrade to Max tier

#### 3. GLM-5 High Token Consumption

- **Issue**: GLM-5 uses significantly more quota per prompt than GLM-4.7
- **Status**: By design (larger model)
- **Workaround**: Use GLM-4.7 for routine tasks, GLM-5 for complex reasoning

### Getting Help

- **China Documentation**: [docs.bigmodel.cn/cn/coding-plan/overview](https://docs.bigmodel.cn/cn/coding-plan/overview)
- **International Docs**: [docs.z.ai/devpack/overview](https://docs.z.ai/devpack/overview)
- **Quick Start**: [docs.z.ai/devpack/quick-start](https://docs.z.ai/devpack/quick-start)
- **GitHub Community**: Search for `zai-coding` or `glm-coding-plan`

---

## SDKs & Libraries

### Official SDKs

| Language | Package/Link |
|----------|--------------|
| **Python** | `pip install zhipuai` |
| **Java** | [github.com/zai-org/z-ai-sdk-java](https://github.com/zai-org/z-ai-sdk-java) |
| **MCP Server** | `npm package @z_ai/mcp-server` |
| **OpenAI Compatible** | Use standard OpenAI SDK with custom base_url |

### Monitoring Tools

- **[opencode-glm-quota](https://github.com/guyinwonder168/opencode-glm-quota)** - Real-time quota monitoring for GLM Coding Plan
  - 5-hour token cycle tracking
  - Monthly MCP usage statistics
  - 24-hour rolling window for model and MCP tools

---

## Quick Start Checklist

- [ ] Create account at [z.ai](https://z.ai) (international) or [open.bigmodel.cn](https://open.bigmodel.cn) (China)
- [ ] Generate API key from API management console
- [ ] Subscribe to GLM Coding Plan tier (Lite/Pro/Max)
- [ ] Configure environment variables for your coding tool
- [ ] Test API connection with a simple curl request
- [ ] Monitor usage with quota tracking tool
- [ ] Adjust usage patterns based on 5-hour rolling window

---

## Cross-References

### Internal Documentation

- **[Model Mapping](../features/model-mapping/)** - How Z.ai models map to internal model IDs
- **[Model Routing](../features/model-routing/)** - Request routing logic
- **[Model Concurrency Findings](../model-concurrency-findings/)** - Concurrency testing results

### External Documentation

- **[Z.ai Official Docs](https://docs.z.ai)**
- **[BigModel China Docs](https://docs.bigmodel.cn)**
- **[Claude Code Setup](../developer-guide/claude-code-setup/)**

---

*This document is maintained as a living reference. Last comprehensive search: February 21, 2026.*
