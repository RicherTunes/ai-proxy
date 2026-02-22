---
layout: default
title: Model Mapping Backend Implementation
---

# Model Mapping Backend Implementation

> **Related:**
> - [Model Routing](./model-routing.md) - Tier-based model selection and fallback logic
> - [Configuration Guide](../user-guide/configuration.md) - Full configuration options
> - [Z.ai Knowledge Base](../reference/zai-knowledge-base.md#model-catalog) - Available GLM models

## Dashboard Visualization

The Model Routing page displays model mappings and configurations:

![Model Routing Page](../screenshots/routing.png)

**Model List** - View available models with their tier classifications:

![Model List](../screenshots/components/model-list.png)

## Summary

Successfully implemented the backend for live model management in the GLM Proxy. This includes:

1. **ModelMappingManager class** - Manages model mappings with per-key overrides
2. **API endpoints** - RESTful endpoints for live model mapping management
3. **Request handler integration** - Updated to use the model mapping manager

## Changes Made

### 1. lib/config.js

#### Added ModelMappingManager Class (lines 409-536)

**Constructor:**

- Takes model mapping config object
- Initializes with enabled flag, models map, default model, and logging preference
- Creates empty Map for per-key overrides

**Methods:**

- `getMappedModel(claudeModel, keyIndex)` - Returns mapped model name
  - Checks per-key overrides first (highest priority)
  - Falls back to global mapping
  - Uses default model if set
  - Passes through unchanged if no mapping found
  - Respects enabled flag

- `setKeyOverride(keyIndex, claudeModel, glmModel)` - Sets per-key override
  - Creates override map for key if doesn't exist
  - Maps specific Claude model to GLM model for that key only

- `clearKeyOverride(keyIndex, claudeModel)` - Clears per-key override
  - Clears specific model override if claudeModel provided
  - Clears all overrides for key if claudeModel omitted
  - Removes empty key entries

- `updateGlobalMapping(mapping)` - Updates global configuration
  - Merges new mapping configuration
  - Can update enabled, models, defaultModel, logTransformations

- `resetToDefaults(defaults)` - Resets to default configuration
  - Restores default settings
  - Clears all per-key overrides

- `toConfig()` - Exports current configuration
  - Returns plain object with current settings

- `getKeyOverrides()` - Gets all per-key overrides
  - Returns Map as plain object

- `getKeyOverride(keyIndex)` - Gets overrides for specific key
  - Returns override map or null

#### Updated Config Class

**Constructor (line 198):**

- Added call to `_initializeModelMappingManager()`

**New Method (lines 342-352):**

- `_initializeModelMappingManager()` - Creates ModelMappingManager instance from config

**New Getter (lines 354-357):**

- `modelMappingManager` - Returns the manager instance

#### Updated Module Exports (line 556)

- Added `ModelMappingManager` to exports

### 2. lib/proxy-server.js

#### Added Route Handlers (lines 349-350, 368-369)

**New Routes:**

- `/model-mapping` - GET/PUT for global mapping config
- `/model-mapping/reset` - POST to reset to defaults
- `/model-mapping/keys/:keyIndex` - GET/PUT/DELETE for per-key overrides

#### Added Handler Methods (lines 950-1073)

**_handleModelMapping(req, res)**

- GET: Returns current config and all key overrides
- PUT: Updates global mapping configuration
- Returns JSON with success/error status

**_handleModelMappingReset(req, res)**

- POST: Resets to default configuration
- Returns updated config

**_handleModelMappingKey(req, res, pathname)**

- GET: Returns overrides for specific key
- PUT: Sets override for specific key (requires claudeModel and glmModel)
- DELETE: Clears override(s) for specific key
- Validates keyIndex from URL path
- Returns JSON with success/error status

### 3. lib/request-handler.js

#### Updated _transformRequestBody Method (lines 248-292)

**Changes:**

- Added `keyIndex` parameter (default null)
- Uses `config.modelMappingManager` instead of direct config access
- Calls `manager.getMappedModel(originalModel, keyIndex)` for mapping
- Passes `keyIndex` to log message when transformation occurs
- Handles null manager gracefully

#### Updated Method Call (line 774)

**Changes:**

- Passes `keyInfo.index` as third parameter to `_transformRequestBody`
- Enables per-key model mapping based on which key is being used

## API Endpoints

### GET /model-mapping

Get current model mapping configuration and all key overrides.

**Response:**

```json
{
  "config": {
    "enabled": true,
    "models": {
      "claude-opus-4-5-20251101": "glm-4.7",
      ...
    },
    "defaultModel": null,
    "logTransformations": true
  },
  "keyOverrides": {
    "0": {
      "claude-opus-4-5-20251101": "glm-4.7-turbo"
    }
  }
}
```

### PUT /model-mapping

Update global model mapping configuration.

**Request Body:**

```json
{
  "enabled": true,
  "models": {
    "claude-opus-4-5-20251101": "glm-4.7-turbo"
  },
  "defaultModel": "glm-4.7-default",
  "logTransformations": false
}
```

**Response:**

```json
{
  "success": true,
  "config": { ... }
}
```

### POST /model-mapping/reset

Reset model mapping to default configuration.

**Response:**

```json
{
  "success": true,
  "config": { ... }
}
```

### GET /model-mapping/keys/:keyIndex

Get per-key overrides for a specific key.

**Response:**

```json
{
  "keyIndex": 0,
  "overrides": {
    "claude-opus-4-5-20251101": "glm-4.7-turbo"
  }
}
```

### PUT /model-mapping/keys/:keyIndex

Set per-key override for a specific key.

**Request Body:**

```json
{
  "claudeModel": "claude-opus-4-5-20251101",
  "glmModel": "glm-4.7-turbo"
}
```

**Response:**

```json
{
  "success": true,
  "keyIndex": 0,
  "overrides": { ... }
}
```

### DELETE /model-mapping/keys/:keyIndex

Clear per-key override(s) for a specific key.

**Request Body (optional):**

```json
{
  "claudeModel": "claude-opus-4-5-20251101"
}
```

If `claudeModel` is provided, clears only that model's override.
If omitted, clears all overrides for the key.

**Response:**

```json
{
  "success": true,
  "keyIndex": 0,
  "overrides": {}
}
```

## Priority Order

Model mapping follows this priority order:

1. **Per-key override** (highest) - If key has specific override for the model
2. **Global mapping** - If model exists in global models map
3. **Default model** - If defaultModel is set
4. **Pass through** (lowest) - Return original model name unchanged

## Usage Examples

### Get mapped model

```javascript
const mappedModel = config.modelMappingManager.getMappedModel(
    'claude-opus-4-5-20251101',
    0  // keyIndex
);
// Returns 'glm-4.7-turbo' if key 0 has override, else 'glm-4.7'
```

### Set per-key override

```javascript
config.modelMappingManager.setKeyOverride(
    0,  // keyIndex
    'claude-opus-4-5-20251101',
    'glm-4.7-turbo'
);
```

### Clear per-key override

```javascript
// Clear specific model override
config.modelMappingManager.clearKeyOverride(0, 'claude-opus-4-5-20251101');

// Clear all overrides for key
config.modelMappingManager.clearKeyOverride(0);
```

### Update global mapping

```javascript
config.modelMappingManager.updateGlobalMapping({
    enabled: true,
    defaultModel: 'glm-4.7-default'
});
```

### Reset to defaults

```javascript
config.modelMappingManager.resetToDefaults(DEFAULT_CONFIG.modelMapping);
```

## Testing

The implementation has been tested with:

1. **Basic model mapping** - Verified global mappings work correctly
2. **Per-key overrides** - Verified key-specific overrides take precedence
3. **Unknown models** - Verified pass-through behavior
4. **Disabled manager** - Verified bypass when disabled
5. **Clear overrides** - Verified clearing single and all overrides
6. **Update global** - Verified global configuration updates
7. **Reset to defaults** - Verified reset functionality
8. **Export configuration** - Verified config export
9. **Get key overrides** - Verified retrieval of overrides

All tests passed successfully.

## Edge Cases Handled

- **Null/undefined models** - Passed through unchanged
- **Disabled mapping** - Manager returns original model when disabled
- **Empty overrides** - Methods handle missing overrides gracefully
- **Invalid keyIndex** - Returns original model (no override found)
- **Unknown models** - Passed through unchanged unless defaultModel set
- **Non-JSON bodies** - Skipped during transformation
- **Parse errors** - Caught and logged, body passed through unchanged

## Backward Compatibility

- Existing model mapping configuration in DEFAULT_CONFIG is preserved
- Existing functionality continues to work without changes
- New manager is initialized automatically in Config constructor
- API endpoints are additions, don't break existing routes
- Request handler changes are backward compatible (keyIndex defaults to null)

## Files Modified

1. `lib/config.js` - Added ModelMappingManager class and integrated with Config
2. `lib/proxy-server.js` - Added API endpoints for model mapping management
3. `lib/request-handler.js` - Updated to use model mapping manager

## Next Steps

The backend implementation is complete. Next steps would be:

> **See Also:**
> - [Testing Guide](../developer-guide/testing.md) - Test strategy and coverage
> - [Security Configuration](../operations/security.md) - Admin authentication for endpoints
> - [Metrics Reference](../reference/metrics.md) - Available monitoring metrics

1. **Frontend integration** - Add UI components to dashboard for live management
2. **Persistence** - Add ability to save/load model mapping configuration
3. **Validation** - Add input validation for model names
4. **Testing** - Add comprehensive unit tests
5. **Documentation** - Update user documentation with API usage
