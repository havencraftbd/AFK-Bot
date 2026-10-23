module.exports = {
  apps: [
    {
      name: "haven-ticket-bot",
      script: "./bot.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "450M",
      restart_delay: 2000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
