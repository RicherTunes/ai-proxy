/**
 * Model Mapping API Response Handling Tests
 *
 * TDD: Tests for normalizing the API response structure to match dashboard expectations
 * API returns: { config: { enabled: true, models: {...} }, keyOverrides: {...} }
 * Dashboard expects: { enabled: true, mappings: {...} }
 */

describe('Model Mapping API Response Handling', () => {
    describe('Normalization function behavior', () => {
        // This function will be extracted to dashboard.js
        function normalizeModelMappingResponse(data) {
            return {
                enabled: data.config?.enabled ?? true,
                mappings: data.config?.models || {},
                keyOverrides: data.keyOverrides || {}
            };
        }

        test('should normalize API response to dashboard format', () => {
            const apiResponse = {
                config: {
                    enabled: true,
                    models: {
                        'claude-opus-4-6': 'glm-4.7'
                    }
                },
                keyOverrides: {}
            };

            const normalized = normalizeModelMappingResponse(apiResponse);

            expect(normalized.enabled).toBe(true);
            expect(normalized.mappings).toEqual({ 'claude-opus-4-6': 'glm-4.7' });
            expect(normalized.keyOverrides).toEqual({});
        });

        test('should handle missing config gracefully', () => {
            const apiResponse = {};

            const normalized = normalizeModelMappingResponse(apiResponse);

            expect(normalized.enabled).toBe(true); // default
            expect(normalized.mappings).toEqual({});
            expect(normalized.keyOverrides).toEqual({});
        });

        test('should handle missing models gracefully', () => {
            const apiResponse = {
                config: { enabled: false }
            };

            const normalized = normalizeModelMappingResponse(apiResponse);

            expect(normalized.enabled).toBe(false);
            expect(normalized.mappings).toEqual({});
        });

        test('should handle missing keyOverrides gracefully', () => {
            const apiResponse = {
                config: {
                    enabled: true,
                    models: { 'claude-opus-4-6': 'glm-4.7' }
                }
            };

            const normalized = normalizeModelMappingResponse(apiResponse);

            expect(normalized.keyOverrides).toEqual({});
        });

        test('should preserve all model mappings', () => {
            const apiResponse = {
                config: {
                    enabled: true,
                    models: {
                        'claude-opus-4-6': 'glm-4.7',
                        'claude-sonnet-4-5-20250929': 'glm-4.6',
                        'claude-haiku-4-5-20251001': 'glm-4.5-air'
                    }
                }
            };

            const normalized = normalizeModelMappingResponse(apiResponse);

            expect(Object.keys(normalized.mappings)).toHaveLength(3);
            expect(normalized.mappings['claude-opus-4-6']).toBe('glm-4.7');
            expect(normalized.mappings['claude-sonnet-4-5-20250929']).toBe('glm-4.6');
            expect(normalized.mappings['claude-haiku-4-5-20251001']).toBe('glm-4.5-air');
        });

        test('should default enabled to true when config is missing', () => {
            const normalized = normalizeModelMappingResponse({});
            expect(normalized.enabled).toBe(true);
        });

        test('should default enabled to true when config.enabled is undefined', () => {
            const normalized = normalizeModelMappingResponse({ config: {} });
            expect(normalized.enabled).toBe(true);
        });
    });

    // Note: updateMapping, deleteMapping, normalizeModelMappingResponse were removed
    // from dashboard.js in Phase 06 Plan 02 (mapping JS dead code removal).
    // Dashboard JS code-presence tests removed as the functions no longer exist.
});
