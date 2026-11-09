module.exports = {
  apps: [
    {
      name: "tati-backend",
      script: ".venv/bin/uvicorn",
      args: "main:app --host 127.0.0.1 --port 8000",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "tati-localtunnel",
      script: "npx",
      args: "localtunnel --port 8000 --subdomain tati-voice-ai-backend",
      autorestart: true,
      restart_delay: 5000,
    }
  ]
};