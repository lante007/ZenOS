// PM2 process definitions for the EvidenceOS EC2 instance.
//
// The API and the Watchtower Observation Worker are SEPARATE processes. A
// failure, slowdown or restart of watchtower-worker cannot affect
// evidenceos-api (different OS process, its own pm2 supervision).
//
// Deploy the worker without disturbing the API:
//   pm2 start ecosystem.config.js --only watchtower-worker
//   pm2 save
// Full (re)deploy of both:
//   pm2 startOrReload ecosystem.config.js && pm2 save

module.exports = {
  apps: [
    {
      name: 'evidenceos-api',
      script: 'server.js',
      cwd: '/home/ec2-user/ZenOS',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'watchtower-worker',
      script: 'api/watchtower/worker.js',
      cwd: '/home/ec2-user/ZenOS',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Back off on crash-loop rather than hammer a failing dependency.
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '200M',
      kill_timeout: 35000, // allow the graceful shutdown drain (WATCHTOWER_SHUTDOWN_GRACE_MS)
      env: { NODE_ENV: 'production' },
    },
  ],
};
