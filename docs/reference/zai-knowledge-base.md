# Z.ai (Zhipu AI) - Complete Knowledge Base

> **Last Updated:** February 21, 2026
> **Provider:** Zhipu AI (Z.ai / BigModel.cn)
> **Purpose:** Comprehensive brain dump of all Z.ai knowledge for integration and reference

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Company Overview](#company-overview)
3. [Product Ecosystem](#product-ecosystem)
4. [Subscription Tiers Deep Dive](#subscription-tiers-deep-dive)
5. [Model Specifications](#model-specifications)
6. [API Reference](#api-reference)
7. [Rate Limits & Quotas](#rate-limits--quotas)
8. [Integrations](#integrations)
9. [Competitive Analysis](#competitive-analysis)
10. [Known Issues & Workarounds](#known-issues--workarounds)
11. [Historical Changes](#historical-changes)
12. [Community Tools](#community-tools)
13. [Cross-References](#cross-references)

---

## Executive Summary

### What is Z.ai?

Z.ai (Zhipu AI / 智谱AI) is a Chinese AI company offering GLM (General Language Model) series models through a subscription-based coding plan. Their value proposition is **"1/7 the cost of Claude, 3x the usage"**.

### Key Metrics

| Metric | Value |
|--------|-------|
| **Founded** | 2019 |
| **Paid Users (Dec 2025)** | 2.7 million |
| **Models** | GLM-4.x series, GLM-5 (754B params) |
| **Context Window** | Up to 200K tokens |
| **Price Range** | $10-$80/month international |
| **SWE Score** | 0.68 (GLM-4.7) |

### Why Z.ai Matters

- **Cost Effective**: Significantly cheaper than Anthropic Claude for coding tasks
- **High Quota**: 5-hour rolling window with generous prompt allowances
- **Compatible**: Works with Claude Code, Cursor, Cline, Roo Code, and more
- **OpenAI/Anthropic Compatible**: Easy drop-in replacement
- **Growing Rapidly**: 2.7M paid users as of December 2025

---

## Company Overview

### Zhipu AI (智谱AI)

| Attribute | Detail |
|-----------|--------|
| **Chinese Name** | 北京智谱华章科技有限公司 |
| **Founded** | 2019 |
| **Origin** | Tsinghua University research spinoff |
| **Headquarters** | Beijing, China |
| **Platforms** | z.ai (International), open.bigmodel.cn (China) |
| **Developer Community** | GitHub: zai-org |

### Platform URLs

| Purpose | URL |
|---------|-----|
| **International Dashboard** | https://z.ai |
| **China Dashboard** | https://open.bigmodel.cn |
| **API Keys (Intl)** | https://z.ai/manage-apikey/apikey-list |
| **Subscriptions (Intl)** | https://z.ai/manage-apikey/subscription |
| **International Docs** | https://docs.z.ai/devpack/overview |
| **China Docs** | https://docs.bigmodel.cn/cn/coding-plan/overview |
| **Quick Start** | https://docs.z.ai/devpack/quick-start |

---

## Product Ecosystem

### 1. GLM Coding Plan (Subscription)

**Target:** Individual developers using AI coding assistants

**Features:**
- Subscription-based pricing (not token-based)
- 5-hour rolling window quotas
- Compatible with 10+ coding tools
- MCP tools integration (vision, web search, web reader)
- Special API endpoints (`/api/coding/paas/v4`)

**Tiers:** Lite, Pro, Max

### 2. Standard API (Pay-as-you-go)

**Target:** Developers building applications

**Features:**
- Token-based pricing
- Standard OpenAI-compatible endpoints
- Flexible usage without quotas
- Higher per-token cost than coding plan

**Pricing Example:**
- GLM-4.7: $0.60/1M tokens (input), $2.20/1M tokens (output)
- GLM-4.7-Flash: Free tier available (1 concurrent request limit)

### 3. Enterprise Solutions

**Launched:** October 2025

**Features:**
- Custom deployments
- Dedicated support
- SLA guarantees
- Volume pricing

### 4. Z Code IDE

**Description:** Lightweight AI IDE by Zhipu AI

**Features:**
- Multi-agent unified scheduling (Claude Code, Codex, Gemini)
- Dynamic thinking mechanism
- Security control system
- Version management
- Integrated toolchain

### 5. GLM-4.7-Flash (Free Tier)

**Limits:**
- 1 concurrent request
- Free for development/testing
- Production use requires paid tier

---

## Subscription Tiers Deep Dive

### Complete Pricing Table (Post February 12, 2026)

#### International Market (USD)

| Plan | Monthly | Quarterly | Yearly | 5-Hr Quota | MCP/Month |
|------|---------|-----------|--------|------------|-----------|
| **Lite** | $10 | $27 | $84 | ~120 prompts | 100 |
| **Pro** | $30 | $81 | $252 | ~600 prompts | 1,000 |
| **Max** | $80 | $216 | $672 | ~2,400 prompts | 4,000 |

#### China Market (CNY)

| Plan | Monthly | Quarterly | Yearly | 5-Hr Quota | MCP/Month |
|------|---------|-----------|--------|------------|-----------|
| **Lite** | ¥49 | ¥132 | ¥411 | ~120 prompts | 100 |
| **Pro** | ¥149 | ¥402 | ¥1,251 | ~600 prompts | 1,000 |
| **Max** | ¥469 | ¥1,266 | ¥3,939 | ~2,400 prompts | 4,000 |

### Tier Feature Comparison

| Feature | Lite | Pro | Max |
|---------|------|-----|-----|
| **GLM-4.7 Access** | ✓ | ✓ | ✓ |
| **GLM-4.6 Access** | ✓ | ✓ | ✓ |
| **GLM-4.5 Access** | ✓ | ✓ | ✓ |
| **GLM-4.5-Air Access** | ✓ | ✓ | ✓ |
| **GLM-5 Access** | ✗ (planned) | ✓ | ✓ |
| **GLM-5-Code Access** | ✗ | ✓ | ✓ |
| **Early Access** | ✗ | ✗ | ✓ |
| **Generation Speed** | Base | 40-60% faster | 40-60% faster |
| **Concurrency** | Standard | Enhanced | Ultra-high, no lag |
| **Peak Priority** | No | No | Yes |
| **Weekly Limits** | ~9,000 | ~45,000 | ~180,000 |
| **Monthly Limits** | ~18,000 | ~90,000 | ~360,000 |

### Value Proposition Analysis

#### Compared to Claude Pro ($20/month)

| Metric | Claude Pro | GLM Pro ($30) | Ratio |
|--------|-----------|---------------|-------|
| **5-Hour Quota** | ~40 prompts | ~600 prompts | 15x |
| **Price** | $20 | $30 | 1.5x |
| **Value** | $0.50/prompt | $0.05/prompt | **10x better** |

#### Compared to Claude Max (estimated)

| Metric | Claude Max | GLM Max ($80) | Ratio |
|--------|-----------|---------------|-------|
| **5-Hour Quota** | ~200 prompts | ~2,400 prompts | 12x |
| **Price** | ~$40-60 | $80 | ~1.5-2x |
| **Value** | ~$0.25/prompt | $0.033/prompt | **7.5x better** |

---

## Model Specifications

### GLM Model Family

| Model | Parameters | Context | SWE Score | Input Cost | Output Cost | Release |
|-------|-----------|---------|-----------|------------|-------------|---------|
| **GLM-5** | 754B | TBD | ~0.75+ | ¥18/1M | ¥28/1M | 2026 |
| **GLM-5-Code** | 754B | TBD | ~0.78 | - | - | 2026 |
| **GLM-4.7** | 358B | 128K-200K | 0.68 | $0.60/1M | $2.20/1M | 2025 |
| **GLM-4.6** | ~300B | 128K-200K | 0.68 | $0.60/1M | $2.20/1M | 2025 |
| **GLM-4.5** | ~250B | 128K | 0.65 | $0.60/1M | $2.20/1M | 2024 |
| **GLM-4.5-Air** | ~200B | 128K | 0.62 | $0.20/1M | $1.10/1M | 2024 |
| **GLM-4.7-Flash** | 30B | - | - | Free | Free | 2025 |
| **GLM-4.6V** | - | 128K | - | ¥1/1M | ¥3/1M | - |

### Model Capabilities

#### GLM-4.7 (Current Flagship)

**Strengths:**
- SOTA open-source coding model
- 128K-200K context window
- Native 55+ tokens/second generation speed
- Function calling support
- JSON output mode
- Thinking mode for complex reasoning

**Best For:**
- Large codebase analysis
- Complex refactoring tasks
- Multi-file code generation
- Architecture-level decisions

#### GLM-5 (New Release)

**Improvements over GLM-4.7:**
- 754B parameters (2x+ GLM-4.7)
- Approaches Claude Opus 4.5 performance
- Better reasoning capabilities
- Improved code understanding

**Trade-offs:**
- Significantly higher token consumption
- Pro/Max only (Lite not supported yet)
- Higher latency than GLM-4.7

#### GLM-4.5-Air (Cost Optimized)

**Strengths:**
- Lowest token cost
- Fast response times
- Good for simple tasks

**Best For:**
- Simple code completion
- Bug fixes in small files
- Quick queries
- High-volume, low-complexity tasks

### Context Window Evolution

| Version | Context | Notes |
|---------|---------|-------|
| GLM-4.5 | 128K | Baseline |
| GLM-4.6 | 200K | Upgraded from 128K |
| GLM-4.7 | 200K | Maintained from 4.6 |
| GLM-5 | TBD | Expected 200K+ |

**Context Equivalents:**
- 128K ≈ 150 pages of complex documents
- 128K ≈ 200 pages of PPT
- 128K ≈ 1 hour of video
- 200K ≈ 300+ pages of code

---

## API Reference

### Base URLs

| Platform | Base URL | Use Case |
|----------|----------|----------|
| **Z.ai International (Standard)** | `https://api.z.ai/api/paas/v4/` | OpenAI-compatible API |
| **Z.ai International (Anthropic)** | `https://api.z.ai/api/anthropic` | Anthropic-compatible |
| **BigModel China (Standard)** | `https://open.bigmodel.cn/api/paas/v4/` | OpenAI-compatible API |
| **BigModel China (Anthropic)** | `https://open.bigmodel.cn/api/anthropic` | Anthropic-compatible |
| **Coding Plan** | `/api/coding/paas/v4` | Subscription-specific endpoint |

### Authentication

#### Bearer Token (API Key)

```bash
curl -X POST "https://api.z.ai/api/paas/v4/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4.7-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 4096
  }'
```

#### Anthropic-Compatible Format

```bash
curl -X POST "https://open.bigmodel.cn/api/anthropic/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "glm-4.7",
    "max_tokens": 4096,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### OpenAI SDK Example

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-zai-api-key",
    base_url="https://api.z.ai/api/paas/v4/",
)

response = client.chat.completions.create(
    model="glm-4.7-flash",
    messages=[
        {"role": "user", "content": "Write a Python function to parse CSV"}
    ],
    max_tokens=4096,
)

print(response.choices[0].message.content)
```

### Anthropic SDK Example

```python
import anthropic

client = anthropic.Anthropic(
    api_key="your-zai-api-key",
    base_url="https://open.bigmodel.cn/api/anthropic"
)

message = client.messages.create(
    model="glm-4.7",
    max_tokens=4096,
    messages=[
        {"role": "user", "content": "Write a Python function"}
    ]
)

print(message.content[0].text)
```

### Environment Variables

#### For Claude Code

**macOS/Linux:**
```bash
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="your-zai-api-key"
```

**Windows PowerShell:**
```powershell
$env:ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic"
$env:ANTHROPIC_API_KEY = "your-zai-api-key"
```

**Windows CMD:**
```cmd
set ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
set ANTHROPIC_API_KEY=your-zai-api-key
```

#### For OpenAI-compatible tools

```bash
export OPENAI_BASE_URL="https://api.z.ai/api/paas/v4/"
export OPENAI_API_KEY="your-zai-api-key"
```

### Available Models (for API calls)

| Model ID | Tier | Description |
|----------|------|-------------|
| `glm-5` | Pro/Max | Latest flagship model |
| `glm-5-code` | Pro/Max | Coding-optimized GLM-5 |
| `glm-4.7` | All | Current stable flagship |
| `glm-4.6` | All | Previous flagship |
| `glm-4.5` | All | Mature model |
| `glm-4.5-air` | All | Cost-optimized |
| `glm-4.7-flash` | Free tier | Fast, limited context |
| `glm-4.5-flash` | Free tier | Even faster, more limited |

---

## Rate Limits & Quotas

### Understanding the 5-Hour Rolling Window

**How it works:**
1. The system tracks all prompt usage within a sliding 5-hour window
2. Quota used 5+ hours ago automatically releases
3. No fixed reset times (unlike "daily" or "monthly" quotas)
4. Dynamic recovery based on consumption patterns

**Example:**
- At 10:00: Use 50 prompts (70 remaining)
- At 12:00: Use 30 prompts (40 remaining)
- At 14:00: The 50 prompts from 10:00 "expire" from the window (90 available)
- At 15:00: The 30 prompts from 12:00 "expire" (120 available, full refresh)

### Quota Tables

#### 5-Hour Window Limits

| Plan | Prompts per 5 Hours |
|------|---------------------|
| **Lite** | ~120 prompts |
| **Pro** | ~600 prompts |
| **Max** | ~2,400 prompts |

#### Estimated Monthly Limits

| Plan | Monthly (Estimated) | Notes |
|------|---------------------|-------|
| **Lite** | ~18,000 prompts | 120 × 6 windows/day × 25 days |
| **Pro** | ~90,000 prompts | 600 × 6 windows/day × 25 days |
| **Max** | ~360,000 prompts | 2,400 × 6 windows/day × 25 days |

**Note:** These are estimates based on continuous usage. Actual limits depend on usage patterns.

#### MCP Tool Limits (Monthly)

| Plan | MCP Calls/Month | Tools Included |
|------|-----------------|----------------|
| **Lite** | 100 | Vision, Web Search, Web Reader |
| **Pro** | 1,000 | All MCP tools |
| **Max** | 4,000 | All MCP tools + priority |

### Undocumented/Unknown Limits

The following information is **NOT publicly documented**:

| Metric | Status | Notes |
|--------|--------|-------|
| **RPM (Requests Per Minute)** | Undocumented | No official numbers |
| **TPM (Tokens Per Minute)** | Undocumented | No official numbers |
| **Concurrent Requests** | Partially documented | Flash: 1, others: unclear |
| **Daily Hard Caps** | Appears to be none | Only 5-hour window matters |

### Peak Hour Issues (Known)

| Issue | Details | Mitigation |
|-------|---------|------------|
| **Slowdowns** | Weekdays 15:00-18:00 | Use off-peak hours |
| **Rate Limiting** | "并发限流" errors | Upgrade to Max tier |
| **Resource tension** | "算力资源阶段性紧张" | Enable auto-renewal |

### Capacity Measures (Since January 23, 2026)

- Daily sales limited to **20% of capacity**
- Daily quota refreshes at **10:00**
- Auto-renewal subscribers **unaffected** by limits
- Active crackdown on **malicious traffic and violations**

---

## Integrations

### Supported Tools

Z.ai GLM Coding Plan is compatible with **10+ mainstream coding tools**:

| Tool | Integration Method | Difficulty |
|------|-------------------|------------|
| **Claude Code** | Anthropic-compatible API | Easy |
| **Cursor** | OpenAI-compatible API | Easy |
| **Cline** | OpenAI-compatible API | Easy |
| **Roo Code** | OpenAI-compatible API | Easy |
| **OpenCode** | Native support | Easy |
| **Codex CLI** | Custom integration | Medium |
| **Kilo Code** | Custom integration | Medium |
| **Continue** | OpenAI-compatible API | Easy |

### Claude Code Integration

**Step 1: Set Environment Variables**

```bash
# Mac/Linux
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="your-zai-coding-plan-api-key"

# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic"
$env:ANTHROPIC_API_KEY = "your-zai-coding-plan-api-key"
```

**Step 2: Configure Model**

In `.claude/settings.json`:

```json
{
  "provider": "anthropic",
  "model": "glm-4.7"
}
```

**Available Models for Claude Code:**
- `glm-4.7` (recommended)
- `glm-4.6`
- `glm-4.5`
- `glm-4.5-air`
- `glm-5` (Pro/Max only)

### Cursor Integration

**Settings → API Providers → Custom**

```json
{
  "baseUrl": "https://api.z.ai/api/paas/v4/",
  "apiKey": "your-api-key",
  "model": "glm-4.7"
}
```

### Cline Integration (VS Code)

**Settings JSON:**

```json
{
  "cline.apiUrl": "https://api.z.ai/api/paas/v4/",
  "cline.apiKey": "your-api-key",
  "cline.model": "glm-4.7"
}
```

### Roo Code Integration

**Configuration:**

```json
{
  "provider": "custom",
  "baseUrl": "https://api.z.ai/api/paas/v4/",
  "apiKey": "your-api-key",
  "model": "glm-4.7"
}
```

---

## Competitive Analysis

### Chinese Market Comparison

| Provider | Lite | Pro | Max | Notes |
|----------|------|-----|-----|-------|
| **Zhipu GLM** | ¥49/m | ¥149/m | ¥469/m | 2.7M paid users |
| **Alibaba Qwen** | ¥40/m* | ¥200/m | N/A | qwen3-coder-plus |
| **Moore Threads** | ¥120/q | ¥600/q | ¥1200/q | Full-stack domestic |
| **Volcano Ark** | ¥9.9/m* | ¥49.9/m* | N/A | ByteDance, 50% off 3-month |

*First-month promotional pricing

### International vs US Providers

| Provider | Plan | Price | 5-Hr Quota | Value |
|----------|------|-------|------------|-------|
| **Z.ai GLM Pro** | Pro | $30/m | ~600 | $0.05/prompt |
| **Claude Pro** | Pro | $20/m | ~40 | $0.50/prompt |
| **Claude Max** | Max | ~$40-60/m | ~200 | ~$0.25/prompt |
| **OpenAI GPT-4** | Plus | $20/m | Token-based | Varies |

### Performance Comparison (SWE Benchmark)

| Model | SWE Score | Context | Notes |
|-------|-----------|---------|-------|
| **Claude Opus 4.5** | 0.809 | 200K | Best in class |
| **Claude Sonnet 4.5** | 0.772 | 200K | Excellent balance |
| **GPT-5.2** | 0.80 | - | OpenAI flagship |
| **GLM-5** | ~0.75+ | TBD | Zhipu latest |
| **GLM-4.7** | 0.68 | 200K | Zhipu stable |
| **Gemini 2.5 Pro** | 0.638 | - | Google |

---

## Known Issues & Workarounds

### Issue #1: Undocumented Concurrency Limit

**Description:**
- GLM 4.7 appears to only allow **1 concurrent in-flight request**, even on paid tiers
- This limit is not documented officially

**Reported In:**
- GitHub issue: [anomalyco/opencode#8618](https://github.com/anomalyco/opencode/issues/8618)

**Workaround:**
```javascript
// Implement queue-based request handling
class GLMRequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(request) {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const { request, resolve, reject } = this.queue.shift();

    try {
      const result = await fetch(request);
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.processing = false;
      this.process(); // Process next
    }
  }
}
```

### Issue #2: Peak Hour Slowdowns

**Description:**
- Weekdays 15:00-18:00 (3-6 PM) experience significant slowdowns
- Concurrent rate limiting errors
- Slower model responses

**Workarounds:**
1. **Schedule heavy work for off-peak hours** (before 15:00, after 18:00)
2. **Upgrade to Max tier** - guaranteed "no lag" during peak
3. **Enable auto-renewal** - more stable resource allocation
4. **Use retry logic with exponential backoff**

```javascript
async function callGLMWithRetry(request, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(request);
    } catch (error) {
      if (error.status === 429 && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
}
```

### Issue #3: GLM-5 High Token Consumption

**Description:**
- GLM-5 uses significantly more quota per prompt than GLM-4.7
- Exact multiplier not documented
- Can exhaust quota faster than expected

**Workaround:**
- Use GLM-4.7 for routine tasks
- Reserve GLM-5 for complex reasoning only
- Monitor quota usage in real-time

```javascript
const TASK_COMPLEXITY = {
  simple: { model: 'glm-4.5-air', threshold: 0.3 },
  medium: { model: 'glm-4.7', threshold: 0.7 },
  complex: { model: 'glm-5', threshold: 1.0 }
};

function selectModelForTask(complexity) {
  if (complexity < 0.3) return 'glm-4.5-air';
  if (complexity < 0.7) return 'glm-4.7';
  return 'glm-5';
}
```

### Issue #4: Daily Purchase Limits

**Description:**
- Since January 23, 2026, daily sales limited to 20% of capacity
- New subscriptions may not be available every day

**Workarounds:**
1. **Try early in the day** - quota refreshes at 10:00
2. **Enable auto-renewal** - unaffected by daily limits
3. **Purchase quarterly/yearly** - lock in longer term

### Common Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| **并发限流** | Concurrent request limit hit | Reduce concurrency, wait |
| **Quota exceeded** | 5-hour window limit reached | Wait for quota recovery |
| **API key invalid** | Wrong key or endpoint | Verify key matches platform |
| **Model not available** | Model not in your tier | Upgrade or use different model |
| **429 Too Many Requests** | Rate limit hit | Implement backoff retry |

---

## Historical Changes

### February 12, 2026 - Price Increase

| Change | Before | After |
|--------|--------|-------|
| **Lite (Intl)** | Lower | $10/month |
| **Pro (Intl)** | Lower | $30/month |
| **Max (Intl)** | Lower | $80/month |
| **First-purchase discount** | Available | Cancelled |
| **Existing subscribers** | - | Grandfathered |

**Impact:** 30%+ price increase across all tiers

### January 23, 2026 - Capacity Constraints

| Change | Detail |
|--------|--------|
| **Daily sales limit** | Reduced to 20% of capacity |
| **Daily refresh** | 10:00 AM |
| **Auto-renewal exemption** | Unaffected by limits |
| **Enforcement** | Crackdown on malicious traffic |

### December 2025 - User Milestone

- **2.7 million paid users** reached
- Enterprise version launched (October 2025)
- GLM-5 announced

### October 2025 - Enterprise Launch

- Dedicated deployments
- Custom SLAs
- Volume pricing
- Priority support

---

## Community Tools

### OpenCode GLM Quota Monitor

**Repository:** [github.com/guyinwonder168/opencode-glm-quota](https://github.com/guyinwonder168/opencode-glm-quota)

**Features:**
- Real-time quota monitoring
- 5-hour token cycle tracking
- Monthly MCP usage statistics
- 24-hour rolling window tracking
- Model and MCP tool usage (web_search, web_reader)

### Official SDKs

| Language | Package/Link |
|----------|--------------|
| **Python** | `pip install zhipuai` |
| **Java** | [github.com/zai-org/z-ai-sdk-java](https://github.com/zai-org/z-ai-sdk-java) |
| **MCP Server** | `npm package @z_ai/mcp-server` |
| **OpenAI Compatible** | Use standard OpenAI SDK with custom base_url |

### Third-Party Providers

| Provider | GLM Models | Notes |
|----------|------------|-------|
| **SophNet** | GLM-4.7 | Best throughput (175.93 tok/s) |
| **UCloud** | GLM-4.7 | Good latency |
| **七牛云 (Qiniu)** | GLM-4.7 | 99.75 tokens/s |
| **PPIO** | GLM-4.7 | 100% reliability, 50.47 tok/s |

---

## Cross-References

### Internal Project Documentation

| Document | Description | Location |
|----------|-------------|----------|
| **Z.ai Coding Subscription** | Quick reference for tiers, limits, API | `docs/reference/zai-coding-subscription.md` |
| **Model Mapping** | Internal model mapping configuration | `docs/features/model-mapping.md` |
| **Model Routing** | Complexity-aware routing to GLM models | `docs/features/model-routing.md` |
| **Getting Started** | Setup guide for Z.ai integration | `docs/user-guide/getting-started.md` |
| **Configuration** | Environment variables and api-keys.json | `docs/user-guide/configuration.md` |

### Configuration Files

| File | Purpose |
|------|---------|
| `config/pricing.json` | Token pricing for all GLM models |
| `model-routing.json` | Model routing tiers and fallbacks |
| `api-keys.json` | API keys and baseUrl configuration |

### External Documentation

| Resource | URL |
|----------|-----|
| **Z.ai International Docs** | https://docs.z.ai/devpack/overview |
| **Z.ai Quick Start** | https://docs.z.ai/devpack/quick-start |
| **BigModel China Docs** | https://docs.bigmodel.cn/cn/coding-plan/overview |
| **Z Code User Guide** | https://zhipu-ai.feishu.cn/wiki/VpgrwtBcyiU59zk9fMEcm2sFnee |
| **Z Code Tutorial** | https://blog.csdn.net/YellowSun24/article/details/156856512 |

### Key Management URLs

| Purpose | URL |
|---------|-----|
| **API Keys (International)** | https://z.ai/manage-apikey/apikey-list |
| **Subscriptions (International)** | https://z.ai/manage-apikey/subscription |
| **API Keys (China)** | https://open.bigmodel.cn/apikey |
| **Dashboard (International)** | https://z.ai/dashboard |
| **Dashboard (China)** | https://open.bigmodel.cn |

---

## Quick Reference Card

### Environment Variables

```bash
# Anthropic-compatible (recommended for Claude Code)
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="your-key-here"

# OpenAI-compatible
export OPENAI_BASE_URL="https://api.z.ai/api/paas/v4/"
export OPENAI_API_KEY="your-key-here"
```

### Model Selection Guide

| Task Complexity | Recommended Model | Tier Required |
|----------------|-------------------|---------------|
| Simple completion | `glm-4.5-air` | All |
| Standard coding | `glm-4.7` | All |
| Complex reasoning | `glm-4.7` | All |
| Very complex | `glm-5` | Pro/Max |
| Code specialist | `glm-5-code` | Pro/Max |

### Tier Selection Guide

| Use Case | Recommended Tier |
|----------|------------------|
| Personal projects | Lite |
| Professional dev | Pro |
| Team/enterprise | Max |
| High concurrency | Max |
| Peak hour usage | Max |

---

*This knowledge base is maintained as a living document. Last comprehensive research: February 21, 2026.*

---

## Sources Used

This document aggregates information from:

- Official Z.ai documentation (docs.z.ai)
- Official BigModel documentation (docs.bigmodel.cn)
- GitHub issue reports
- CSDN technical blogs
- Chinese tech news sources (Sohu, QQ News, 51CTO, Sina)
- Third-party provider documentation (SophNet, UCloud, Qiniu, PPIO)
- Community tools and repositories
- User reports and testimonials

For the most current information, always check official sources at z.ai or open.bigmodel.cn.
