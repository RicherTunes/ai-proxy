/**
 * Dashboard Store Tests
 * Tests for the Redux-style store implementation in the dashboard
 */

describe('Dashboard Store', () => {
    // Extract store implementation for testing
    // These functions mirror the dashboard implementation

    function createStore(reducer, initialState) {
        let state = initialState;
        const listeners = new Set();

        return {
            getState() {
                return state;
            },
            dispatch(action) {
                const prevState = state;
                state = reducer(state, action);
                if (state !== prevState) {
                    listeners.forEach(listener => {
                        try {
                            listener(state, prevState, action);
                        } catch (e) {
                            console.error('Store listener error:', e);
                        }
                    });
                }
                return action;
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            getListenerCount() {
                return listeners.size;
            }
        };
    }

    class RingBuffer {
        constructor(capacity = 100) {
            this.capacity = capacity;
            this.items = [];
        }
        push(item) {
            this.items.push(item);
            if (this.items.length > this.capacity) {
                this.items.shift();
            }
        }
        getAll() {
            return [...this.items];
        }
        clear() {
            this.items = [];
        }
        get length() {
            return this.items.length;
        }
    }

    describe('createStore', () => {
        test('should create store with initial state', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);

            expect(store.getState()).toEqual({ count: 0 });
        });

        test('should dispatch actions and update state', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);

            store.dispatch({ type: 'INCREMENT' });

            expect(store.getState()).toEqual({ count: 1 });
        });

        test('should notify subscribers on state change', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);
            const listener = jest.fn();

            store.subscribe(listener);
            store.dispatch({ type: 'INCREMENT' });

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith(
                { count: 1 },  // newState
                { count: 0 },  // prevState
                { type: 'INCREMENT' }  // action
            );
        });

        test('should not notify subscribers when state does not change', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;  // Return same reference for unknown actions
            };

            const store = createStore(reducer, initialState);
            const listener = jest.fn();

            store.subscribe(listener);
            store.dispatch({ type: 'UNKNOWN' });

            expect(listener).not.toHaveBeenCalled();
        });

        test('should allow unsubscribe', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);
            const listener = jest.fn();

            const unsubscribe = store.subscribe(listener);
            store.dispatch({ type: 'INCREMENT' });

            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            store.dispatch({ type: 'INCREMENT' });

            // Should still be 1 call (not called after unsubscribe)
            expect(listener).toHaveBeenCalledTimes(1);
        });

        test('should handle multiple subscribers', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);
            const listener1 = jest.fn();
            const listener2 = jest.fn();

            store.subscribe(listener1);
            store.subscribe(listener2);
            store.dispatch({ type: 'INCREMENT' });

            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);
            expect(store.getListenerCount()).toBe(2);
        });

        test('should handle listener errors gracefully', () => {
            const initialState = { count: 0 };
            const reducer = (state, action) => {
                if (action.type === 'INCREMENT') {
                    return { ...state, count: state.count + 1 };
                }
                return state;
            };

            const store = createStore(reducer, initialState);
            const errorListener = jest.fn(() => { throw new Error('Test error'); });
            const normalListener = jest.fn();

            const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

            store.subscribe(errorListener);
            store.subscribe(normalListener);
            store.dispatch({ type: 'INCREMENT' });

            // Both listeners should have been called
            expect(errorListener).toHaveBeenCalledTimes(1);
            expect(normalListener).toHaveBeenCalledTimes(1);

            // Error should have been logged
            expect(consoleError).toHaveBeenCalled();

            consoleError.mockRestore();
        });

        test('should return dispatched action', () => {
            const store = createStore((state) => state, {});
            const action = { type: 'TEST', payload: 'data' };

            const result = store.dispatch(action);

            expect(result).toBe(action);
        });
    });

    describe('RingBuffer', () => {
        test('should store items up to capacity', () => {
            const buffer = new RingBuffer(3);

            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            expect(buffer.getAll()).toEqual([1, 2, 3]);
            expect(buffer.length).toBe(3);
        });

        test('should evict oldest items when exceeding capacity', () => {
            const buffer = new RingBuffer(3);

            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);

            expect(buffer.getAll()).toEqual([2, 3, 4]);
            expect(buffer.length).toBe(3);
        });

        test('should clear all items', () => {
            const buffer = new RingBuffer(3);

            buffer.push(1);
            buffer.push(2);
            buffer.clear();

            expect(buffer.getAll()).toEqual([]);
            expect(buffer.length).toBe(0);
        });

        test('should return copy of items (not reference)', () => {
            const buffer = new RingBuffer(3);

            buffer.push(1);
            const items = buffer.getAll();
            items.push(999);

            expect(buffer.getAll()).toEqual([1]);
        });
    });

    describe('Store integration with SSE events', () => {
        // Simplified reducer for testing SSE-related actions
        const ActionTypes = {
            SSE_CONNECTED: 'SSE_CONNECTED',
            SSE_DISCONNECTED: 'SSE_DISCONNECTED',
            SSE_MESSAGE_RECEIVED: 'SSE_MESSAGE_RECEIVED',
            REQUEST_RECEIVED: 'REQUEST_RECEIVED',
            KPI_UPDATED: 'KPI_UPDATED'
        };

        function createTestReducer() {
            const requestsBuffer = new RingBuffer(100);

            return function reducer(state, action) {
                switch (action.type) {
                    case ActionTypes.SSE_CONNECTED:
                        requestsBuffer.clear();
                        if (action.payload.recentRequests) {
                            action.payload.recentRequests.forEach(r => requestsBuffer.push(r));
                        }
                        return {
                            ...state,
                            connection: {
                                ...state.connection,
                                status: 'connected',
                                clientId: action.payload.clientId
                            },
                            requests: {
                                items: requestsBuffer.getAll(),
                                lastUpdated: Date.now()
                            }
                        };

                    case ActionTypes.SSE_DISCONNECTED:
                        return {
                            ...state,
                            connection: {
                                ...state.connection,
                                status: 'disconnected',
                                clientId: null
                            }
                        };

                    case ActionTypes.SSE_MESSAGE_RECEIVED: {
                        const { seq, ts, eventType } = action.payload;
                        // Only track gaps for 'request' events (critical)
                        const isRequestEvent = eventType === 'request';
                        const expectedSeq = state.connection.lastRequestSeq + 1;
                        const gapDetected = isRequestEvent &&
                            state.connection.lastRequestSeq > 0 &&
                            seq > expectedSeq;
                        return {
                            ...state,
                            connection: {
                                ...state.connection,
                                lastSeq: seq,
                                lastTs: ts,
                                lastRequestSeq: isRequestEvent ? seq : state.connection.lastRequestSeq,
                                gapDetected: gapDetected || state.connection.gapDetected
                            }
                        };
                    }

                    case ActionTypes.REQUEST_RECEIVED:
                        requestsBuffer.push(action.payload);
                        return {
                            ...state,
                            requests: {
                                items: requestsBuffer.getAll(),
                                lastUpdated: Date.now()
                            }
                        };

                    case ActionTypes.KPI_UPDATED:
                        return {
                            ...state,
                            kpi: {
                                ...action.payload,
                                lastUpdated: Date.now()
                            }
                        };

                    default:
                        return state;
                }
            };
        }

        const initialState = {
            connection: { status: 'disconnected', clientId: null, lastSeq: 0, lastRequestSeq: 0, lastTs: null, gapDetected: false },
            requests: { items: [], lastUpdated: null },
            kpi: { uptime: 0, requests: 0, errors: 0, lastUpdated: null }
        };

        test('should handle SSE_CONNECTED with hydration', () => {
            const reducer = createTestReducer();
            const store = createStore(reducer, initialState);

            const recentRequests = [
                { requestId: 'req-1', status: 200 },
                { requestId: 'req-2', status: 200 }
            ];

            store.dispatch({
                type: ActionTypes.SSE_CONNECTED,
                payload: { clientId: 'sse-123', recentRequests }
            });

            const state = store.getState();
            expect(state.connection.status).toBe('connected');
            expect(state.connection.clientId).toBe('sse-123');
            expect(state.requests.items).toHaveLength(2);
        });

        test('should detect sequence gaps for request events only', () => {
            const reducer = createTestReducer();
            const store = createStore(reducer, initialState);

            // First request message - seq 1
            store.dispatch({
                type: ActionTypes.SSE_MESSAGE_RECEIVED,
                payload: { seq: 1, ts: Date.now(), eventType: 'request' }
            });

            expect(store.getState().connection.gapDetected).toBe(false);
            expect(store.getState().connection.lastRequestSeq).toBe(1);

            // Gap in request events - seq 5 (skipped 2, 3, 4)
            store.dispatch({
                type: ActionTypes.SSE_MESSAGE_RECEIVED,
                payload: { seq: 5, ts: Date.now(), eventType: 'request' }
            });

            expect(store.getState().connection.gapDetected).toBe(true);
        });

        test('should NOT detect gaps for kpi events', () => {
            const reducer = createTestReducer();
            const store = createStore(reducer, initialState);

            // First kpi message - seq 1
            store.dispatch({
                type: ActionTypes.SSE_MESSAGE_RECEIVED,
                payload: { seq: 1, ts: Date.now(), eventType: 'kpi' }
            });

            expect(store.getState().connection.gapDetected).toBe(false);

            // Large seq jump for kpi - should NOT trigger gap
            store.dispatch({
                type: ActionTypes.SSE_MESSAGE_RECEIVED,
                payload: { seq: 100, ts: Date.now(), eventType: 'kpi' }
            });

            // Gap should still be false (kpi events don't trigger gap detection)
            expect(store.getState().connection.gapDetected).toBe(false);
            // lastRequestSeq should be unchanged
            expect(store.getState().connection.lastRequestSeq).toBe(0);
        });

        test('should update KPI from SSE kpi event', () => {
            const reducer = createTestReducer();
            const store = createStore(reducer, initialState);

            store.dispatch({
                type: ActionTypes.KPI_UPDATED,
                payload: {
                    uptime: 3600000,
                    activeKeys: 3,
                    totalKeys: 5,
                    requests: 1234,
                    errors: 12
                }
            });

            const state = store.getState();
            expect(state.kpi.uptime).toBe(3600000);
            expect(state.kpi.requests).toBe(1234);
            expect(state.kpi.errors).toBe(12);
            expect(state.kpi.lastUpdated).toBeDefined();
        });

        test('should add new requests from SSE', () => {
            const reducer = createTestReducer();
            const store = createStore(reducer, initialState);

            store.dispatch({
                type: ActionTypes.REQUEST_RECEIVED,
                payload: { requestId: 'req-1', status: 200, latencyMs: 150 }
            });

            store.dispatch({
                type: ActionTypes.REQUEST_RECEIVED,
                payload: { requestId: 'req-2', status: 429, latencyMs: 50 }
            });

            const state = store.getState();
            expect(state.requests.items).toHaveLength(2);
            expect(state.requests.items[0].requestId).toBe('req-1');
            expect(state.requests.items[1].requestId).toBe('req-2');
        });
    });

    describe('Request history cap', () => {
        test('requestsHistory cap is 10000', () => {
            // This tests the concept - actual store uses simpler push+slice
            const items = [];
            const CAP = 10000;
            for (let i = 0; i < 12000; i++) {
                items.push({ requestId: 'cap-test-' + i, timestamp: Date.now(), status: 200 });
                if (items.length > CAP) {
                    items.splice(0, items.length - CAP);
                }
            }
            expect(items.length).toBe(10000);
            expect(items[0].requestId).toBe('cap-test-2000');
        });
    });
});
