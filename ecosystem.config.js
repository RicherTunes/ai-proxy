/**
 * PM2 Ecosystem Configuration
 * Deploy with: pm2 start ecosystem.config.js
 * Save for reboot persistence: pm2 save
 */
module.exports = {
    apps: [{
        name: 'glm-proxy',
        script: 'proxy.js',
        instances: 1,              // Single instance (proxy handles its own clustering)
        exec_mode: 'fork',
        autorestart: true,
        max_restarts: 10,          // Max 10 restarts before PM2 stops trying
        min_uptime: 5000,          // Must run 5s to count as "started"
        restart_delay: 3000,       // 3s between restarts (avoid tight crash loops)
        max_memory_restart: '512M', // Restart if memory exceeds 512MB

        // Logging
        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

        // Graceful shutdown
        kill_timeout: 35000,       // 35s to shutdown (matches proxy's 30s + buffer)
        listen_timeout: 10000,     // 10s to start listening
        shutdown_with_message: true,

        // Environment
        env: {
            NODE_ENV: 'production',
            NO_CLUSTER: '1'        // Let PM2 manage process lifecycle
        },

        // Watch for config changes (optional - disable in production)
        watch: false,
        ignore_watch: ['node_modules', 'logs', 'coverage', 'test', 'test-results']
    }]
};
