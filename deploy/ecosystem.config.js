// pm2 config (works on Linux and Windows)
// Start:  pm2 start deploy/ecosystem.config.js   then   pm2 save
module.exports = {
  apps: [
    {
      name: 'autoline-sync',
      script: 'src/server.js',
      cwd: __dirname + '/..',
      instances: 1, // must be 1: the app uses a lock and state.json
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
